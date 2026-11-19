import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { retrieve } from '../rag/embedder';
import { callClaudeJson } from '../generators/claudeClient';
import { healLocator, HealResult } from '../heal/locatorHealer';
import { queueHealSuggestion } from '../heal/healQueue';

dotenv.config();

/** Folder where failure reports are written. */
export const REPORT_DIR = path.resolve(process.cwd(), 'outputs', 'failure_reports');

/** Number of requirement chunks pulled from ChromaDB as context. */
const TOP_K = 5;

/** Where the failure originated. */
export type FailureType = 'UI' | 'API' | 'Data' | 'Environment' | 'Timing';

/** Regulations a failure can affect (matches src/compliance/). */
export type Regulation = 'AML' | 'KYC' | 'FCA' | 'GDPR' | 'PCI-DSS';

/** Regulatory risk of a failure. */
export type RiskLevel = 'High' | 'Medium' | 'Low' | 'None';

/** JIRA priority. */
export type Priority = 'Critical' | 'High' | 'Medium' | 'Low';

/** Claude's analysis of one test failure. */
export interface FailureAnalysis {
  /** Most likely root cause. */
  rootCause: string;
  /** Category of the failure. */
  failureType: FailureType;
  /** Regulations affected and how risky the failure is for compliance. */
  regulatoryImpact: {
    affected: Regulation[];
    riskLevel: RiskLevel;
  };
  /** Concrete fix to try. */
  suggestedFix: string;
  /** One-line JIRA summary. */
  jiraSummary: string;
  /** JIRA description body. */
  jiraDescription: string;
  /** JIRA priority. */
  priority: Priority;
  /** What the test expected, according to the requirements. */
  expectedResult: string;
  /** What actually happened, from the error message. */
  actualResult: string;
  /** Name of the failed test (added locally, not by Claude). */
  testName: string;
  /** ISO timestamp of the analysis (added locally, not by Claude). */
  analyzedAt: string;
  /** Suggested replacement locator, present only for locator failures (added locally). */
  healSuggestion?: HealResult;
  /** Whether the heal suggestion used the real page DOM or the placeholder (added locally). */
  healDomSource?: 'captured' | 'placeholder';
}

/** The part of FailureAnalysis that Claude produces. */
type ClaudeAnalysis = Omit<FailureAnalysis, 'testName' | 'analyzedAt' | 'healSuggestion' | 'healDomSource'>;

/** Error text that marks a failure as a broken locator. */
const LOCATOR_ERROR_PATTERN = /locator|selector|element not found/i;

/**
 * Placeholder DOM used for locator healing when no real snapshot was
 * captured (real snapshots come from tests/fixtures.ts and the Cucumber After
 * hook in step-definitions/world.ts). It mirrors the transfer page that
 * pages/TransferPage.ts targets, so suggestions made from it are a demo of
 * the flow, not evidence about the real page.
 */
export const PLACEHOLDER_DOM_SNAPSHOT = `<main>
  <h1>Transfer funds</h1>
  <form id="transfer-form" data-testid="transfer-form">
    <label for="amount">Amount (£)</label>
    <input id="amount" name="amount" type="number" data-testid="amount-input" />
    <label for="transfer-type">Transfer type</label>
    <select id="transfer-type" name="transferType" data-testid="transfer-type-select">
      <option>IMPS</option><option>NEFT</option><option>RTGS</option>
    </select>
    <label for="recipient">Recipient account</label>
    <input id="recipient" name="recipient" type="text" data-testid="recipient-input" />
    <button type="submit" class="btn btn-primary" data-testid="transfer-submit">Submit transfer</button>
  </form>
  <div role="status" data-testid="transfer-confirmation"></div>
  <div role="alert" data-testid="transfer-error"></div>
</main>`;

/**
 * Pulls the failed locator out of a Playwright error message, e.g.
 * "waiting for locator('#submit-btn')" or "waiting for getByRole('button', { name: 'Pay' })".
 *
 * @param errorMessage - The Playwright error message.
 * @returns The locator expression, or an empty string if none is found.
 */
export function extractFailedLocator(errorMessage: string): string {
  const call = errorMessage.match(/\b((?:locator|getBy[A-Za-z]+)\(.*?\))(?=\s*(?:$|\n|\.(?:first|last|nth|click|fill|filter|locator|getBy)|to\b))/m);
  if (call) return call[1];
  const selector = errorMessage.match(/selector\s+["'`](.+?)["'`]/i);
  return selector ? selector[1] : '';
}

/**
 * Asks for a locator fix when the error looks like a broken locator. Healing
 * is a best-effort extra: if it fails, the analysis continues without it.
 *
 * @param errorMessage - The failure's error message.
 * @param domSnapshot - The page HTML captured at the failure (the placeholder is used if empty).
 * @returns The suggestion, or undefined if this is not a locator failure or healing failed.
 */
async function suggestHeal(errorMessage: string, domSnapshot: string): Promise<HealResult | undefined> {
  if (!LOCATOR_ERROR_PATTERN.test(errorMessage)) return undefined;
  try {
    return await healLocator(extractFailedLocator(errorMessage), domSnapshot, errorMessage);
  } catch (error) {
    console.warn(`[failureAnalyzer] Continuing without a heal suggestion: ${(error as Error).message}`);
    return undefined;
  }
}

/** JSON schema for Claude's reply (structured outputs). */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    rootCause: { type: 'string' },
    failureType: { type: 'string', enum: ['UI', 'API', 'Data', 'Environment', 'Timing'] },
    regulatoryImpact: {
      type: 'object',
      properties: {
        affected: { type: 'array', items: { type: 'string', enum: ['AML', 'KYC', 'FCA', 'GDPR', 'PCI-DSS'] } },
        riskLevel: { type: 'string', enum: ['High', 'Medium', 'Low', 'None'] },
      },
      required: ['affected', 'riskLevel'],
      additionalProperties: false,
    },
    suggestedFix: { type: 'string' },
    jiraSummary: { type: 'string' },
    jiraDescription: { type: 'string' },
    priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
    expectedResult: { type: 'string' },
    actualResult: { type: 'string' },
  },
  required: [
    'rootCause', 'failureType', 'regulatoryImpact', 'suggestedFix', 'jiraSummary',
    'jiraDescription', 'priority', 'expectedResult', 'actualResult',
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a senior QA engineer triaging automated test failures for a UK retail bank's payments platform (Playwright + Cucumber).

Banking rules:
- IMPS: maximum £5,000 per transaction and £10,000 per day.
- NEFT: maximum £50,000 per day.
- RTGS: minimum £200,000 per transaction.
- AML: transactions ABOVE £5,000 are flagged for AML review; exactly £5,000 is not.

Classify failureType:
- UI: locator not found, element changed, wrong text on screen.
- API: unexpected status code or response body from a backend call.
- Data: test data or account state is wrong (e.g. daily limit already used, missing user).
- Environment: app or service down, network error, browser failed to launch, missing config or credentials.
- Timing: timeouts, race conditions, flaky waits, where the app itself behaves correctly.

Regulatory impact: list a regulation only if the failure means the app may be breaking it (e.g. a transfer over a limit succeeded, an AML flag is missing, card data is exposed). A test infrastructure failure has riskLevel "None" and an empty list.

Priority: Critical if a regulatory control may be broken in production; High if a core payment flow is broken; Medium for a real defect with a workaround; Low for test-only or flaky issues.

Base the analysis on the error, the stack trace and the requirements given. If the evidence is not enough to be sure of the root cause, say so in rootCause instead of guessing. Write jiraSummary under 100 characters.`;

/**
 * Turns a test name into a file-safe slug.
 *
 * @param testName - Test or scenario name.
 * @returns A slug, or "test" if nothing usable remains.
 */
function toSlug(testName: string): string {
  const slug = testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 80) || 'test';
}

/**
 * Retrieves requirements related to a failure. If ChromaDB is unavailable the
 * analysis continues without requirements rather than failing.
 *
 * @param query - Search text built from the test name and error.
 * @returns Matching requirement chunks, or an empty array on failure.
 */
async function retrieveRequirements(query: string): Promise<string[]> {
  try {
    return await retrieve(query, TOP_K);
  } catch (error) {
    console.warn(`[failureAnalyzer] Continuing without requirements: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Builds the user prompt for a failure.
 *
 * @param testName - Name of the failed test.
 * @param errorMessage - The error message.
 * @param stackTrace - The stack trace.
 * @param requirements - Related requirement chunks.
 * @returns The prompt text.
 */
function buildPrompt(testName: string, errorMessage: string, stackTrace: string, requirements: string[]): string {
  const context = requirements.length
    ? requirements.map((r, i) => `<requirement index="${i + 1}">\n${r}\n</requirement>`).join('\n')
    : '<requirement>No related requirements were found.</requirement>';

  return [
    '<failure>',
    `<test_name>${testName}</test_name>`,
    `<error_message>\n${errorMessage}\n</error_message>`,
    `<stack_trace>\n${stackTrace || '(none)'}\n</stack_trace>`,
    '</failure>',
    '',
    '<requirements>',
    context,
    '</requirements>',
    '',
    'Analyse this failure.',
  ].join('\n');
}

/**
 * Analyses a failed test with Claude, using related requirements from ChromaDB
 * as context, and saves the report to outputs/failure_reports/.
 *
 * @param testName - Name of the failed test or scenario.
 * @param errorMessage - The failure's error message.
 * @param stackTrace - The failure's stack trace (may be empty).
 * @param domSnapshot - Optional page HTML captured at the failure, used for locator healing.
 * @returns The analysis.
 * @throws If inputs are empty, Claude fails, or the report cannot be saved.
 */
export async function analyzeFailure(
  testName: string,
  errorMessage: string,
  stackTrace: string,
  domSnapshot?: string,
): Promise<FailureAnalysis> {
  try {
    if (!testName.trim()) throw new Error('testName must not be empty');
    if (!errorMessage.trim()) throw new Error('errorMessage must not be empty');

    const healDomSource = domSnapshot?.trim() ? 'captured' : 'placeholder';
    const healDom = healDomSource === 'captured' ? (domSnapshot as string) : PLACEHOLDER_DOM_SNAPSHOT;
    const requirements = await retrieveRequirements(`${testName}\n${errorMessage}`);
    const [result, healSuggestion] = await Promise.all([
      callClaudeJson<ClaudeAnalysis>({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(testName, errorMessage, stackTrace, requirements),
        schema: ANALYSIS_SCHEMA,
        maxTokens: 16000,
      }),
      suggestHeal(errorMessage, healDom),
    ]);

    // Only a suggestion built from the real page goes to the approval queue (npm run heal:review).
    if (healSuggestion && healDomSource === 'captured') {
      const queued = await queueHealSuggestion(testName, extractFailedLocator(errorMessage), healSuggestion);
      if (queued) console.log(`  [heal] suggestion queued for approval: ${queued.id} (run npm run heal:review)`);
    }

    const analyzedAt = new Date().toISOString();
    const analysis: FailureAnalysis = {
      ...result,
      testName,
      analyzedAt,
      ...(healSuggestion && { healSuggestion, healDomSource }),
    };

    await fs.mkdir(REPORT_DIR, { recursive: true });
    const fileName = `${toSlug(testName)}-${analyzedAt.replace(/[:.]/g, '-')}.json`;
    await fs.writeFile(path.join(REPORT_DIR, fileName), JSON.stringify(analysis, null, 2), 'utf-8');

    return analysis;
  } catch (error) {
    throw new Error(`analyzeFailure("${testName}") failed: ${(error as Error).message}`);
  }
}

/**
 * Formats an analysis as a JIRA ticket in JIRA wiki markup, ready to paste.
 *
 * @param analysis - The analysis from analyzeFailure().
 * @returns The ticket text.
 * @throws If the analysis is missing required fields.
 */
export function formatJiraTicket(analysis: FailureAnalysis): string {
  try {
    if (!analysis?.jiraSummary) throw new Error('analysis has no jiraSummary');

    const { affected, riskLevel } = analysis.regulatoryImpact;
    return [
      `*Summary:* ${analysis.jiraSummary}`,
      `*Priority:* ${analysis.priority}`,
      `*Failure type:* ${analysis.failureType}`,
      `*Test:* ${analysis.testName}`,
      '',
      'h3. Description',
      analysis.jiraDescription,
      '',
      'h3. Steps to Reproduce',
      '# _<Add steps>_',
      '# ',
      '# ',
      '',
      'h3. Expected Result',
      analysis.expectedResult,
      '',
      'h3. Actual Result',
      analysis.actualResult,
      '',
      'h3. Root Cause',
      analysis.rootCause,
      '',
      'h3. Suggested Fix',
      analysis.suggestedFix,
      '',
      'h3. Regulatory Impact',
      `*Risk level:* ${riskLevel}`,
      `*Affected:* ${affected.length ? affected.join(', ') : 'None'}`,
      '',
      `_Analysed ${analysis.analyzedAt} by the automated failure analyzer._`,
    ].join('\n');
  } catch (error) {
    throw new Error(`Failed to format JIRA ticket: ${(error as Error).message}`);
  }
}

// Run directly: npm run analyze:failures -- "<test name>" "<error message>" ["<stack trace>"]
if (require.main === module) {
  const [testName, errorMessage, stackTrace = ''] = process.argv.slice(2);
  if (!testName || !errorMessage) {
    console.error('Usage: npm run analyze:failures -- "<test name>" "<error message>" ["<stack trace>"]');
    process.exit(1);
  }
  analyzeFailure(testName, errorMessage, stackTrace)
    .then((analysis) => console.log(formatJiraTicket(analysis)))
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
