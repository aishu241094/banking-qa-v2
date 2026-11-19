import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { retrieve } from '../rag/embedder';
import { ingestRequirements } from '../rag/ingest';
import { callClaudeJson, MODEL, QuotaExhaustedError } from '../generators/claudeClient';

dotenv.config();

/** Folder where evaluation reports are written. */
export const REPORT_DIR = path.resolve(process.cwd(), 'outputs', 'evaluation');

/** Every average must be above this for the evaluation to pass. */
export const PASS_THRESHOLD = 0.9;

/** Chunks retrieved per query. */
const TOP_K = 5;

/** How context recall was measured for a query. */
export type RecallMode = 'reference' | 'reference-free';

/** RAGAS scores for one query. */
export interface RagasResult {
  query: string;
  retrievedChunks: string[];
  generatedAnswer: string;
  /** Share of the answer's claims supported by the retrieved chunks. */
  faithfulness: number;
  /** How directly the answer addresses the question. */
  answerRelevance: number;
  /** Rank-weighted share of retrieved chunks that are relevant. */
  contextPrecision: number;
  /** Share of the needed facts that the retrieved chunks contain. */
  contextRecall: number;
  /** Average of the four metrics. */
  overallScore: number;
  /** "reference" if a ground-truth answer was used for recall, else "reference-free". */
  contextRecallMode: RecallMode;
  /** Set if this query failed; it is then left out of the averages. */
  error?: string;
}

/** Results of a full evaluation run. */
export interface EvaluationReport {
  timestamp: string;
  totalQueries: number;
  averageScores: {
    faithfulness: number;
    answerRelevance: number;
    contextPrecision: number;
    contextRecall: number;
    overall: number;
  };
  results: RagasResult[];
  /** True if every average is above PASS_THRESHOLD and no query failed. */
  passed: boolean;
}

/** Ground-truth answers keyed by query, used for reference-based context recall. */
export type GroundTruths = Record<string, string>;

/** Judge verdicts; scores are computed from these in code, not by the judge. */
interface JudgeVerdicts {
  answerClaims: { claim: string; supported: boolean }[];
  answerRelevance: 'fully' | 'mostly' | 'partially' | 'barely' | 'not';
  chunkRelevance: { index: number; relevant: boolean }[];
  recallFacts: { fact: string; inContext: boolean }[];
}

const RELEVANCE_SCORES: Record<JudgeVerdicts['answerRelevance'], number> = {
  fully: 1, mostly: 0.75, partially: 0.5, barely: 0.25, not: 0,
};

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    answerClaims: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: { type: 'string' }, supported: { type: 'boolean' } },
        required: ['claim', 'supported'],
        additionalProperties: false,
      },
    },
    answerRelevance: { type: 'string', enum: ['fully', 'mostly', 'partially', 'barely', 'not'] },
    chunkRelevance: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, relevant: { type: 'boolean' } },
        required: ['index', 'relevant'],
        additionalProperties: false,
      },
    },
    recallFacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { fact: { type: 'string' }, inContext: { type: 'boolean' } },
        required: ['fact', 'inContext'],
        additionalProperties: false,
      },
    },
  },
  required: ['answerClaims', 'answerRelevance', 'chunkRelevance', 'recallFacts'],
  additionalProperties: false,
};

const ANSWER_SYSTEM = `You answer questions about a UK bank's requirements using only the context provided. If the context does not contain the answer, say that the requirements do not cover it. Do not use outside knowledge. Answer in one to three sentences.`;

const JUDGE_SYSTEM = `You are a strict evaluator of a retrieval-augmented question answering system, following the RAGAS method. You give verdicts; you do not compute scores.

- answerClaims: split the answer into its individual factual claims. For each, supported = true only if the context states or directly implies it. A statement that the context does not cover the question is a claim; it is supported if the context indeed lacks the answer. If the answer has no claims, return an empty list.
- answerRelevance: how directly and completely the answer addresses the question asked, ignoring whether it is correct. An answer saying the information is unavailable is "barely" relevant unless the question truly cannot be answered from any banking requirements.
- chunkRelevance: for every context chunk, by its index, relevant = true if it contains information useful for answering the question.
- recallFacts: if a reference answer is given, split it into its individual facts and mark inContext = true if the context contains that fact. If no reference answer is given, list the facts a complete answer to the question would need and mark whether the context contains each.`;

/**
 * Rounds a score to three decimals.
 *
 * @param n - Score to round.
 * @returns The rounded score.
 */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * RAGAS context precision: mean of precision@k over the ranks k that hold a
 * relevant chunk. Returns 0 if no chunk is relevant.
 *
 * @param relevant - Relevance of each chunk, in retrieval order.
 * @returns Score between 0 and 1.
 */
function contextPrecision(relevant: boolean[]): number {
  let hits = 0;
  let sum = 0;
  relevant.forEach((isRelevant, i) => {
    if (isRelevant) {
      hits += 1;
      sum += hits / (i + 1);
    }
  });
  return hits ? sum / hits : 0;
}

/**
 * Share of items marked true. Returns `empty` when the list is empty.
 *
 * @param flags - Booleans to count.
 * @param empty - Value for an empty list.
 * @returns Score between 0 and 1.
 */
function share(flags: boolean[], empty: number): number {
  return flags.length ? flags.filter(Boolean).length / flags.length : empty;
}

/**
 * Formats retrieved chunks for a prompt.
 *
 * @param chunks - Chunks in retrieval order.
 * @returns Chunks wrapped in indexed tags.
 */
function formatContext(chunks: string[]): string {
  return chunks.length
    ? chunks.map((c, i) => `<chunk index="${i}">\n${c}\n</chunk>`).join('\n')
    : '(no chunks retrieved)';
}

/**
 * Generates an answer from the retrieved chunks.
 *
 * @param query - The question.
 * @param chunks - Retrieved context.
 * @returns The answer text.
 * @throws If the Claude call fails.
 */
async function generateAnswer(query: string, chunks: string[]): Promise<string> {
  try {
    const { answer } = await callClaudeJson<{ answer: string }>({
      system: ANSWER_SYSTEM,
      prompt: `<context>\n${formatContext(chunks)}\n</context>\n\n<question>${query}</question>`,
      schema: ANSWER_SCHEMA,
      maxTokens: 4000,
    });
    return answer;
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error;
    throw new Error(`Answer generation failed: ${(error as Error).message}`);
  }
}

/**
 * Asks Claude to judge an answer and its context, then computes the four
 * RAGAS metrics from the verdicts.
 *
 * @param query - The question.
 * @param chunks - Retrieved context, in retrieval order.
 * @param answer - The generated answer.
 * @param groundTruth - Optional reference answer for context recall.
 * @returns The four metric scores.
 * @throws If the Claude call fails.
 */
async function judge(
  query: string,
  chunks: string[],
  answer: string,
  groundTruth?: string,
): Promise<Pick<RagasResult, 'faithfulness' | 'answerRelevance' | 'contextPrecision' | 'contextRecall'>> {
  try {
    const reference = groundTruth
      ? `<reference_answer>${groundTruth}</reference_answer>`
      : '<reference_answer>(none given)</reference_answer>';
    const verdicts = await callClaudeJson<JudgeVerdicts>({
      system: JUDGE_SYSTEM,
      prompt: [
        `<question>${query}</question>`,
        `<context>\n${formatContext(chunks)}\n</context>`,
        `<answer>${answer}</answer>`,
        reference,
      ].join('\n\n'),
      schema: JUDGE_SCHEMA,
      maxTokens: 16000,
    });

    const relevanceByIndex = new Map(verdicts.chunkRelevance.map((c) => [c.index, c.relevant]));
    const chunkFlags = chunks.map((_, i) => relevanceByIndex.get(i) ?? false);

    return {
      faithfulness: share(verdicts.answerClaims.map((c) => c.supported), 1),
      answerRelevance: RELEVANCE_SCORES[verdicts.answerRelevance],
      contextPrecision: contextPrecision(chunkFlags),
      contextRecall: share(verdicts.recallFacts.map((f) => f.inContext), 0),
    };
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error;
    throw new Error(`Judging failed: ${(error as Error).message}`);
  }
}

/**
 * Retrieves, answers and scores a single query.
 *
 * @param query - The question.
 * @param groundTruth - Optional reference answer.
 * @returns The scored result, or a result with `error` set if any step failed.
 * @throws QuotaExhaustedError on a 429, so the run stops instead of using more quota.
 */
async function evaluateQuery(query: string, groundTruth?: string): Promise<RagasResult> {
  const contextRecallMode: RecallMode = groundTruth ? 'reference' : 'reference-free';
  let retrievedChunks: string[] = [];
  let generatedAnswer = '';
  try {
    retrievedChunks = await retrieve(query, TOP_K);
    generatedAnswer = await generateAnswer(query, retrievedChunks);
    const scores = await judge(query, retrievedChunks, generatedAnswer, groundTruth);
    const overallScore =
      (scores.faithfulness + scores.answerRelevance + scores.contextPrecision + scores.contextRecall) / 4;

    return {
      query,
      retrievedChunks,
      generatedAnswer,
      faithfulness: round(scores.faithfulness),
      answerRelevance: round(scores.answerRelevance),
      contextPrecision: round(scores.contextPrecision),
      contextRecall: round(scores.contextRecall),
      overallScore: round(overallScore),
      contextRecallMode,
    };
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error; // stop the whole run
    console.error(`  FAILED (full error):\n${(error as Error).message}`);
    return {
      query, retrievedChunks, generatedAnswer,
      faithfulness: 0, answerRelevance: 0, contextPrecision: 0, contextRecall: 0, overallScore: 0,
      contextRecallMode,
      error: (error as Error).message,
    };
  }
}

/**
 * Runs a RAGAS-style evaluation: for each query, retrieves chunks, generates
 * an answer with Claude, and scores faithfulness, answer relevance, context
 * precision and context recall with Claude as the judge.
 *
 * Context recall uses the query's ground-truth answer when one is given
 * (standard RAGAS); otherwise the judge lists the facts a complete answer
 * would need and checks the context for them (reference-free).
 *
 * Failed queries are kept in `results` with `error` set, left out of the
 * averages, and make the report fail.
 *
 * @param queries - Questions to evaluate.
 * @param groundTruths - Optional reference answers keyed by query.
 * @returns The evaluation report.
 * @throws If no queries are given.
 */
export async function evaluateRAG(queries: string[], groundTruths: GroundTruths = {}): Promise<EvaluationReport> {
  try {
    if (queries.length === 0) throw new Error('queries must not be empty');

    // The vector store is in-memory, so load the requirements in this process.
    const ingested = await ingestRequirements();
    if (!ingested.some((r) => r.chunks > 0)) {
      throw new Error('no requirement chunks were loaded from data/requirements/');
    }

    console.log(`Using model: ${MODEL}`);
    const results: RagasResult[] = [];
    for (const [i, query] of queries.entries()) {
      console.log(`[${i + 1}/${queries.length}] ${query}`);
      results.push(await evaluateQuery(query, groundTruths[query]));
    }

    const ok = results.filter((r) => !r.error);
    const avg = (key: keyof Pick<RagasResult, 'faithfulness' | 'answerRelevance' | 'contextPrecision' | 'contextRecall' | 'overallScore'>): number =>
      ok.length ? round(ok.reduce((sum, r) => sum + r[key], 0) / ok.length) : 0;

    const averageScores = {
      faithfulness: avg('faithfulness'),
      answerRelevance: avg('answerRelevance'),
      contextPrecision: avg('contextPrecision'),
      contextRecall: avg('contextRecall'),
      overall: avg('overallScore'),
    };

    return {
      timestamp: new Date().toISOString(),
      totalQueries: queries.length,
      averageScores,
      results,
      passed: ok.length === results.length && Object.values(averageScores).every((s) => s > PASS_THRESHOLD),
    };
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error;
    throw new Error(`RAG evaluation failed: ${(error as Error).message}`);
  }
}

/** The standard banking evaluation set. */
export const BANKING_QUERIES: string[] = [
  'What is the IMPS daily transfer limit?',
  'When is AML review triggered?',
  'What documents are needed for KYC?',
  'What are GDPR data retention rules?',
  'What is the minimum RTGS transfer amount?',
];

/**
 * Reference answers for the queries whose answers are fixed project rules.
 * The other queries are scored with reference-free context recall.
 */
export const BANKING_GROUND_TRUTHS: GroundTruths = {
  'What is the IMPS daily transfer limit?': 'The IMPS daily limit is £10,000, with a maximum of £5,000 per transaction.',
  'When is AML review triggered?': 'AML review is triggered for transactions above £5,000. A transaction of exactly £5,000 is not flagged.',
  'What is the minimum RTGS transfer amount?': 'The minimum RTGS transfer is £200,000.',
};

/**
 * Formats a report as a fixed-width summary table.
 *
 * @param report - The evaluation report.
 * @returns The table text.
 */
export function formatSummaryTable(report: EvaluationReport): string {
  try {
    const f = (n: number): string => n.toFixed(2).padStart(6);
    const header = `${'Query'.padEnd(44)} ${'Faith'.padStart(6)} ${'AnsRel'.padStart(6)} ${'CtxPre'.padStart(6)} ${'CtxRec'.padStart(6)} ${'Overall'.padStart(7)}`;
    const line = '-'.repeat(header.length);
    const rows = report.results.map((r) => {
      const q = (r.query.length > 43 ? `${r.query.slice(0, 40)}...` : r.query).padEnd(44);
      return r.error
        ? `${q} FAILED: ${r.error}`
        : `${q} ${f(r.faithfulness)} ${f(r.answerRelevance)} ${f(r.contextPrecision)} ${f(r.contextRecall)} ${f(r.overallScore).padStart(7)}${r.contextRecallMode === 'reference-free' ? ' *' : ''}`;
    });
    const a = report.averageScores;
    return [
      line, header, line, ...rows, line,
      `${'AVERAGE'.padEnd(44)} ${f(a.faithfulness)} ${f(a.answerRelevance)} ${f(a.contextPrecision)} ${f(a.contextRecall)} ${f(a.overall).padStart(7)}`,
      line,
      `* context recall measured without a reference answer`,
      `Result: ${report.passed ? 'PASSED' : 'FAILED'} (every average must be above ${PASS_THRESHOLD.toFixed(2)})`,
    ].join('\n');
  } catch (error) {
    throw new Error(`Failed to format summary table: ${(error as Error).message}`);
  }
}

/**
 * Runs the 5-query banking evaluation, saves the report to
 * outputs/evaluation/ragas-<timestamp>.json, and prints a summary table.
 *
 * @returns The evaluation report.
 * @throws If the evaluation or saving fails.
 */
export async function runBankingEvaluation(): Promise<EvaluationReport> {
  try {
    const report = await evaluateRAG(BANKING_QUERIES, BANKING_GROUND_TRUTHS);

    await fs.mkdir(REPORT_DIR, { recursive: true });
    const filePath = path.join(REPORT_DIR, `ragas-${report.timestamp.replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(`\n${formatSummaryTable(report)}`);
    console.log(`Saved to ${filePath}`);
    return report;
  } catch (error) {
    if (error instanceof QuotaExhaustedError) throw error;
    throw new Error(`Banking evaluation failed: ${(error as Error).message}`);
  }
}

// Run directly: npm run eval:ragas  (exits 1 if the evaluation fails, for CI)
if (require.main === module) {
  runBankingEvaluation()
    .then((report) => process.exit(report.passed ? 0 : 1))
    .catch((error: Error) => {
      if (error instanceof QuotaExhaustedError) {
        console.error(`
${error.message}`);
        console.error('Evaluation stopped early; no report was saved.');
      } else {
        console.error(error.message);
      }
      process.exit(1);
    });
}
