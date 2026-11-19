import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { retrieve } from '../rag/embedder';
import { callClaudeJson } from '../generators/claudeClient';

dotenv.config();

/** Folder where compliance reports are written. */
export const REPORT_DIR = path.resolve(process.cwd(), 'outputs', 'compliance_reports');

/** Requirement chunks retrieved per regulation query. */
const CHUNKS_PER_REGULATION = 10;

/** Regulations the checker covers. */
export type Regulation = 'FCA' | 'AML' | 'KYC' | 'GDPR' | 'PCI-DSS';

/** Severity of a requirement if it is left untested. */
export type GapRiskLevel = 'High' | 'Medium' | 'Low';

/** One regulatory requirement and whether the test suite covers it. */
export interface ComplianceGap {
  /** Regulation the requirement belongs to. */
  regulation: Regulation;
  /** The requirement, summarised in one sentence. */
  requirement: string;
  /** True if at least one test clearly exercises this requirement. */
  hasCoverage: boolean;
  /** How serious it would be if this requirement were broken and untested. */
  riskLevel: GapRiskLevel;
  /** What to test (for gaps) or how to strengthen coverage (for covered items). */
  recommendation: string;
}

/** ChromaDB search query for each regulation. */
export const REGULATION_QUERIES: Record<Regulation, string> = {
  FCA: 'FCA requirements',
  AML: 'AML rules',
  KYC: 'KYC requirements',
  GDPR: 'GDPR rules',
  'PCI-DSS': 'PCI DSS requirements',
};

const REGULATIONS = Object.keys(REGULATION_QUERIES) as Regulation[];

const RISK_ORDER: Record<GapRiskLevel, number> = { High: 0, Medium: 1, Low: 2 };

/** JSON schema for Claude's reply (structured outputs need an object at the top level). */
const GAPS_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          regulation: { type: 'string', enum: REGULATIONS },
          requirement: { type: 'string' },
          hasCoverage: { type: 'boolean' },
          riskLevel: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          recommendation: { type: 'string' },
        },
        required: ['regulation', 'requirement', 'hasCoverage', 'riskLevel', 'recommendation'],
        additionalProperties: false,
      },
    },
  },
  required: ['gaps'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a compliance QA lead at a UK retail bank. You map regulatory requirements (FCA, AML, KYC, GDPR, PCI-DSS) to an automated test suite and find coverage gaps.

Rules:
- Return one entry for every distinct, testable requirement in the requirements text. Merge duplicates that appear in several chunks.
- Only use requirements that appear in the text. Do not add requirements from your own knowledge of the regulations.
- Set regulation to the regulation the requirement belongs to, regardless of which search returned it.
- hasCoverage is true only if a test name clearly exercises the requirement. A vaguely related test is not coverage. When unsure, set false.
- riskLevel is how serious it would be for the bank if the requirement were broken in production with no test catching it: High for regulatory breach, fines or customer harm; Medium for partial control failure; Low for procedural or record-keeping items.
- recommendation: for a gap, name the test scenario to add (what to do and what to assert). For a covered requirement, name the most important missing edge case, or "Covered" if none.`;

/**
 * Retrieves requirement chunks for every regulation and removes duplicates.
 *
 * @returns Unique requirement chunks, each tagged with the regulation whose query found it.
 * @throws If ChromaDB cannot be queried, or no requirements are found at all.
 */
async function retrieveAllRequirements(): Promise<{ regulation: Regulation; text: string }[]> {
  try {
    const results = await Promise.all(
      REGULATIONS.map(async (regulation) => ({
        regulation,
        chunks: await retrieve(REGULATION_QUERIES[regulation], CHUNKS_PER_REGULATION),
      })),
    );

    const seen = new Set<string>();
    const unique: { regulation: Regulation; text: string }[] = [];
    for (const { regulation, chunks } of results) {
      for (const text of chunks) {
        if (!seen.has(text)) {
          seen.add(text);
          unique.push({ regulation, text });
        }
      }
    }

    if (unique.length === 0) {
      throw new Error('no requirements found in ChromaDB; load them with loadRequirements() first');
    }
    return unique;
  } catch (error) {
    throw new Error(`Failed to retrieve regulatory requirements: ${(error as Error).message}`);
  }
}

/**
 * Builds the user prompt from the requirements and test names.
 *
 * @param requirements - Requirement chunks tagged by the query that found them.
 * @param testNames - Names of the tests in the suite.
 * @returns The prompt text.
 */
function buildPrompt(requirements: { regulation: Regulation; text: string }[], testNames: string[]): string {
  const reqs = requirements
    .map((r, i) => `<requirement index="${i + 1}" found_by="${r.regulation}">\n${r.text}\n</requirement>`)
    .join('\n');
  const tests = testNames.length ? testNames.map((t) => `- ${t}`).join('\n') : '(no tests)';

  return `<requirements>\n${reqs}\n</requirements>\n\n<test_names>\n${tests}\n</test_names>\n\nMap each requirement to the tests and report coverage.`;
}

/**
 * Checks which regulatory requirements in ChromaDB are covered by the given
 * tests, using Claude to match requirements to test names.
 *
 * @param testNames - Names of the tests or scenarios in the suite.
 * @returns One entry per requirement, with coverage, risk and a recommendation.
 * @throws If retrieval or the Claude call fails.
 */
export async function runComplianceCheck(testNames: string[]): Promise<ComplianceGap[]> {
  try {
    const cleanNames = [...new Set(testNames.map((t) => t.trim()).filter(Boolean))];
    const requirements = await retrieveAllRequirements();

    const { gaps } = await callClaudeJson<{ gaps: ComplianceGap[] }>({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(requirements, cleanNames),
      schema: GAPS_SCHEMA,
    });
    return gaps;
  } catch (error) {
    throw new Error(`Compliance check failed: ${(error as Error).message}`);
  }
}

/**
 * Formats a percentage with a 20-character text bar.
 *
 * @param covered - Covered requirement count.
 * @param total - Total requirement count (must be > 0).
 * @returns e.g. "[########............]  40% (2/5)".
 */
function coverageBar(covered: number, total: number): string {
  const pct = Math.round((covered / total) * 100);
  const filled = Math.round(pct / 5);
  return `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}] ${String(pct).padStart(3)}% (${covered}/${total})`;
}

/**
 * Builds a plain-text compliance report: overall score, per-regulation
 * coverage, high-risk gaps, and recommendations for every gap.
 *
 * The overall score is the share of all requirements that are covered.
 * Regulations with no requirements found are shown as "no requirements found"
 * rather than counted as 0% or 100%.
 *
 * @param gaps - Results from runComplianceCheck().
 * @returns The report text.
 * @throws If the input is not an array.
 */
export function generateComplianceReport(gaps: ComplianceGap[]): string {
  try {
    if (!Array.isArray(gaps)) throw new Error('gaps must be an array');

    const lines: string[] = [];
    const rule = '='.repeat(64);
    const covered = gaps.filter((g) => g.hasCoverage).length;
    const uncovered = gaps
      .filter((g) => !g.hasCoverage)
      .sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);
    const highRisk = uncovered.filter((g) => g.riskLevel === 'High');

    lines.push(rule, 'COMPLIANCE TEST COVERAGE REPORT', `Generated: ${new Date().toISOString()}`, rule, '');

    lines.push('OVERALL COMPLIANCE SCORE');
    lines.push(gaps.length ? `  ${coverageBar(covered, gaps.length)}` : '  No requirements analysed.');
    lines.push(`  Gaps: ${uncovered.length}   High-risk gaps: ${highRisk.length}`, '');

    lines.push('PER-REGULATION BREAKDOWN');
    for (const regulation of REGULATIONS) {
      const items = gaps.filter((g) => g.regulation === regulation);
      const label = regulation.padEnd(8);
      if (items.length === 0) {
        lines.push(`  ${label} no requirements found`);
      } else {
        const ok = items.filter((g) => g.hasCoverage).length;
        const high = items.filter((g) => !g.hasCoverage && g.riskLevel === 'High').length;
        lines.push(`  ${label} ${coverageBar(ok, items.length)}${high ? `  !! ${high} high-risk gap(s)` : ''}`);
      }
    }
    lines.push('');

    lines.push('!!! HIGH-RISK GAPS !!!');
    if (highRisk.length === 0) {
      lines.push('  None.');
    } else {
      highRisk.forEach((g, i) => lines.push(`  ${i + 1}. [${g.regulation}] ${g.requirement}`));
    }
    lines.push('');

    lines.push('RECOMMENDATIONS (gaps, highest risk first)');
    if (uncovered.length === 0) {
      lines.push('  No gaps found.');
    } else {
      uncovered.forEach((g, i) => {
        lines.push(`  ${i + 1}. [${g.riskLevel.toUpperCase()}] [${g.regulation}] ${g.requirement}`);
        lines.push(`     -> ${g.recommendation}`);
      });
    }
    lines.push('', rule);

    return lines.join('\n');
  } catch (error) {
    throw new Error(`Failed to generate compliance report: ${(error as Error).message}`);
  }
}

/**
 * Saves a report to outputs/compliance_reports/compliance-<timestamp>.txt.
 *
 * @param report - Report text from generateComplianceReport().
 * @returns Path of the saved file.
 * @throws If the file cannot be written.
 */
export async function saveReport(report: string): Promise<string> {
  try {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(REPORT_DIR, `compliance-${timestamp}.txt`);
    await fs.writeFile(filePath, report, 'utf-8');
    return filePath;
  } catch (error) {
    throw new Error(`Failed to save compliance report: ${(error as Error).message}`);
  }
}

/**
 * Reads all scenario names from .feature files in a folder.
 *
 * @param dir - Folder to scan (default "features").
 * @returns Scenario and Scenario Outline names.
 * @throws If the folder cannot be read.
 */
export async function collectScenarioNames(dir: string = 'features'): Promise<string[]> {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.feature'));
    const names: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(path.join(dir, file), 'utf-8');
      for (const match of text.matchAll(/^\s*Scenario(?: Outline)?:\s*(.+)$/gm)) {
        names.push(match[1].trim());
      }
    }
    return names;
  } catch (error) {
    throw new Error(`Failed to read scenarios from "${dir}": ${(error as Error).message}`);
  }
}

// Run directly: npm run check:compliance  (checks every scenario in features/)
if (require.main === module) {
  (async () => {
    const testNames = await collectScenarioNames();
    console.log(`Checking ${testNames.length} scenario(s) against regulatory requirements...`);
    const report = generateComplianceReport(await runComplianceCheck(testNames));
    console.log(report);
    console.log(`\nSaved to ${await saveReport(report)}`);
  })().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
