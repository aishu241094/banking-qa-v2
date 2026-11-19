import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { ingestRequirements } from './src/rag/ingest';
import { generateTests } from './src/generators/testGenerator';
import { analyzeFailure, formatJiraTicket } from './src/analysis/failureAnalyzer';
import {
  collectScenarioNames,
  generateComplianceReport,
  runComplianceCheck,
  saveReport,
} from './src/compliance/complianceChecker';
import { runBankingEvaluation } from './src/evaluation/ragasEval';
import { DOM_SNAPSHOT_ATTACHMENT } from './src/heal/domSnapshot';
import { reviewHealSuggestions } from './src/heal/approveHeals';

dotenv.config();

// ---------------------------------------------------------------------------
// Coloured output
// ---------------------------------------------------------------------------

/** Colours are off when NO_COLOR is set or output is not a terminal. */
const USE_COLOUR = !process.env.NO_COLOR && process.stdout.isTTY;

/**
 * Wraps text in an ANSI colour code.
 *
 * @param code - ANSI colour number.
 * @param text - Text to colour.
 * @returns The coloured text, or the plain text if colours are off.
 */
function colour(code: number, text: string): string {
  return USE_COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Console helpers: green success, red error, yellow warning, blue info. */
const log = {
  success: (msg: string): void => console.log(colour(32, `✔ ${msg}`)),
  error: (msg: string): void => console.error(colour(31, `✖ ${msg}`)),
  warn: (msg: string): void => console.warn(colour(33, `⚠ ${msg}`)),
  info: (msg: string): void => console.log(colour(34, msg)),
};

/**
 * Removes ANSI colour codes, which Playwright puts in its error messages.
 *
 * @param text - Text that may contain ANSI codes.
 * @returns The plain text.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Menu option 1 / --load: loads data/requirements/ into ChromaDB.
 *
 * @returns True if every file loaded.
 */
async function loadAction(): Promise<boolean> {
  try {
    log.info('Loading requirements into ChromaDB...');
    const results = await ingestRequirements();
    const failed = results.filter((r) => r.error);
    if (results.length === 0) {
      log.warn('No requirement files found in data/requirements/');
      return false;
    }
    if (failed.length) {
      log.error(`${failed.length} file(s) failed to load`);
      return false;
    }
    log.success('Requirements loaded');
    return true;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

/**
 * Menu option 2 / --generate: generates tests for a feature.
 *
 * @param featureName - Feature to generate tests for.
 * @returns True on success.
 */
async function generateAction(featureName: string): Promise<boolean> {
  try {
    if (!featureName.trim()) throw new Error('Feature name is required');
    log.info(`Generating tests for "${featureName}"... (this can take a minute)`);
    const paths = await generateTests(featureName);
    log.success('Generated files:');
    Object.values(paths).forEach((p) => console.log(`  ${p}`));
    return true;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

/**
 * Menu option 3 / --analyze: analyses a failure and prints a JIRA ticket.
 *
 * @param testName - Name of the failed test.
 * @param errorMessage - The error message.
 * @param stackTrace - The stack trace (may be empty).
 * @param domSnapshotPath - Optional HTML file of the page at the failure, for locator healing.
 * @returns True on success.
 */
async function analyzeAction(
  testName: string,
  errorMessage: string,
  stackTrace: string,
  domSnapshotPath?: string,
): Promise<boolean> {
  try {
    if (!testName.trim() || !errorMessage.trim()) throw new Error('Test name and error message are required');
    let domSnapshot: string | undefined;
    if (domSnapshotPath) {
      try {
        domSnapshot = await fs.readFile(domSnapshotPath, 'utf-8');
      } catch (error) {
        log.warn(`Could not read DOM snapshot ${domSnapshotPath}: ${(error as Error).message}`);
      }
    }
    log.info(`Analysing failure in "${testName}"...`);
    const analysis = await analyzeFailure(testName, errorMessage, stackTrace, domSnapshot);
    log.success(`Analysis complete: ${analysis.priority} priority, ${analysis.failureType} failure`);
    if (analysis.regulatoryImpact.riskLevel === 'High') {
      log.warn(`High regulatory risk: ${analysis.regulatoryImpact.affected.join(', ')}`);
    }
    console.log(`\n${formatJiraTicket(analysis)}\n`);

    const heal = analysis.healSuggestion;
    if (heal) {
      log.info(
        analysis.healDomSource === 'captured'
          ? 'Locator heal suggestion (based on the DOM captured at the failure):'
          : 'Locator heal suggestion (based on a placeholder DOM snapshot, no real snapshot was captured):',
      );
      console.log(`  Suggested locator: ${heal.suggestedLocator || '(none)'}`);
      console.log(`  Confidence:        ${heal.confidence}`);
      console.log(`  Reasoning:         ${heal.reasoning}\n`);
      if (heal.confidence === 'low') log.warn('Low confidence: check the page manually before changing the locator');
    }
    return true;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

/**
 * Menu option 4 / --compliance: checks every scenario in features/ against
 * the regulatory requirements and saves the report.
 *
 * @returns True if the check ran and found no high-risk gaps.
 */
async function complianceAction(): Promise<boolean> {
  try {
    const testNames = await collectScenarioNames();
    log.info(`Running compliance check on ${testNames.length} scenario(s)...`);
    const gaps = await runComplianceCheck(testNames);
    const report = generateComplianceReport(gaps);
    console.log(`\n${report}\n`);
    log.success(`Report saved to ${await saveReport(report)}`);

    const highRisk = gaps.filter((g) => !g.hasCoverage && g.riskLevel === 'High').length;
    if (highRisk) {
      log.warn(`${highRisk} high-risk compliance gap(s) found`);
      return false;
    }
    return true;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

/**
 * Menu option 5 / --evaluate: runs the RAGAS evaluation.
 *
 * @returns True if the evaluation passed.
 */
async function evaluateAction(): Promise<boolean> {
  try {
    log.info('Running RAGAS evaluation (5 queries, about 10 Gemini calls)...');
    const report = await runBankingEvaluation();
    if (report.passed) log.success('RAGAS evaluation passed');
    else log.warn('RAGAS evaluation did not pass the 0.90 threshold');
    return report.passed;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

/** Playwright JSON reporter output (only the fields used here). */
interface PlaywrightJsonReport {
  suites?: PlaywrightSuite[];
}
interface PlaywrightSuite {
  title: string;
  suites?: PlaywrightSuite[];
  specs?: {
    title: string;
    file: string;
    tests: {
      projectName?: string;
      status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
      results: {
        status: string;
        error?: { message?: string; stack?: string };
        attachments?: { name: string; path?: string; contentType: string }[];
      }[];
    }[];
  }[];
}

/** A failed Playwright test extracted from the JSON report. */
interface FailedTest {
  name: string;
  errorMessage: string;
  stackTrace: string;
  /** DOM snapshot saved by tests/fixtures.ts, if the test used it. */
  domSnapshotPath?: string;
}

/** Playwright's JSON report path, as set in playwright.config.ts. */
const PLAYWRIGHT_JSON = path.resolve(process.cwd(), 'outputs', 'test-results.json');

/** Most failures analysed automatically per run, to cap API cost. */
const MAX_AUTO_ANALYSES = Number(process.env.MAX_AUTO_ANALYSES ?? 10);

/**
 * Runs `npx playwright test`, streaming its output to the console.
 *
 * @param filter - Optional file filter passed to Playwright, e.g. "heal-demo".
 * @returns Playwright's exit code.
 * @throws If the process cannot be started.
 */
function runPlaywright(filter = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const safeFilter = filter.replace(/[^\w./-]/g, '');
    // A single command string: shell mode is needed on Windows to find npx.
    const child = spawn(`npx playwright test ${safeFilter}`.trim(), { stdio: 'inherit', shell: true });
    child.on('error', (error) => reject(new Error(`Could not start Playwright: ${error.message}`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Reads the Playwright JSON report and returns every test that failed on its
 * final attempt.
 *
 * @returns Failed tests, or an empty array if the report is missing.
 */
async function readFailedTests(): Promise<FailedTest[]> {
  try {
    const report = JSON.parse(await fs.readFile(PLAYWRIGHT_JSON, 'utf-8')) as PlaywrightJsonReport;
    const failed: FailedTest[] = [];

    const walk = (suite: PlaywrightSuite, parents: string[]): void => {
      const trail = suite.title ? [...parents, suite.title] : parents;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests) {
          if (test.status !== 'unexpected') continue;
          const last = test.results[test.results.length - 1];
          const name = [...trail, spec.title].join(' > ') + (test.projectName ? ` [${test.projectName}]` : '');
          failed.push({
            name,
            errorMessage: stripAnsi(last?.error?.message ?? `Test ended with status "${last?.status ?? 'unknown'}"`),
            stackTrace: stripAnsi(last?.error?.stack ?? ''),
            domSnapshotPath: last?.attachments?.find((a) => a.name === DOM_SNAPSHOT_ATTACHMENT)?.path,
          });
        }
      }
      (suite.suites ?? []).forEach((child) => walk(child, trail));
    };

    (report.suites ?? []).forEach((s) => walk(s, []));
    return failed;
  } catch (error) {
    log.warn(`Could not read Playwright results at ${PLAYWRIGHT_JSON}: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Menu option 6 / --test: runs all Playwright tests, then analyses each failed
 * test with analyzeFailure() (up to MAX_AUTO_ANALYSES).
 *
 * @param filter - Optional Playwright file filter.
 * @returns True if every test passed.
 */
async function testAction(filter = ''): Promise<boolean> {
  try {
    log.info(`Running Playwright tests${filter ? ` matching "${filter}"` : ''}...\n`);
    const exitCode = await runPlaywright(filter);

    if (exitCode === 0) {
      log.success('All Playwright tests passed');
      return true;
    }

    const failed = await readFailedTests();
    if (failed.length === 0) {
      log.error(`Playwright exited with code ${exitCode} but no failed tests were found in the report (no tests, or a config error)`);
      return false;
    }

    log.error(`${failed.length} test(s) failed`);
    const toAnalyse = failed.slice(0, MAX_AUTO_ANALYSES);
    if (failed.length > toAnalyse.length) {
      log.warn(`Analysing the first ${toAnalyse.length}; set MAX_AUTO_ANALYSES to change this`);
    }

    for (const [i, test] of toAnalyse.entries()) {
      log.info(`\n[${i + 1}/${toAnalyse.length}] ${test.name}`);
      await analyzeAction(test.name, test.errorMessage, test.stackTrace, test.domSnapshotPath);
    }
    log.info('Reports saved to outputs/failure_reports/');
    log.info('Review locator fixes with: npm run heal:review');
    return false;
  } catch (error) {
    log.error((error as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

const RULE = '═══════════════════════════════════════';
const MENU = [
  RULE,
  ' Banking QA Framework v2',
  RULE,
  ' 1. Load requirements into ChromaDB',
  ' 2. Generate tests for a feature',
  ' 3. Analyse a test failure',
  ' 4. Run compliance check',
  ' 5. Run RAGAS evaluation',
  ' 6. Run all Playwright tests',
  ' 7. Review locator heal suggestions',
  ' 8. Exit',
  RULE,
].join('\n');

/** Asks a question and resolves with the answer, or null once input has closed. */
type Ask = (prompt: string) => Promise<string | null>;

/**
 * Creates a line reader that queues input lines, so lines that arrive before
 * the question is asked (piped input) are not lost.
 *
 * @param rl - The readline interface.
 * @returns An ask() function.
 */
function createAsk(rl: readline.Interface): Ask {
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;

  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    waiting.splice(0).forEach((resolve) => resolve(null));
  });

  return (prompt: string) => {
    process.stdout.write(prompt);
    if (lines.length) return Promise.resolve(lines.shift() as string);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
}

/**
 * Shows the menu and runs the chosen option until the user exits or input ends.
 */
async function interactiveMenu(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const ask = createAsk(rl);
  try {
    for (;;) {
      log.info(`\n${MENU}`);
      const answer = await ask('Choose an option (1-8): ');
      if (answer === null) return; // input closed (Ctrl+D or end of piped input)
      const choice = answer.trim();

      switch (choice) {
        case '1':
          await loadAction();
          break;
        case '2':
          await generateAction((await ask('Feature name (e.g. IMPS transfer): ')) ?? '');
          break;
        case '3': {
          const testName = (await ask('Test name: ')) ?? '';
          const errorMessage = (await ask('Error message: ')) ?? '';
          const stackTrace = (await ask('Stack trace (optional, one line): ')) ?? '';
          await analyzeAction(testName, errorMessage, stackTrace);
          break;
        }
        case '4':
          await complianceAction();
          break;
        case '5':
          await evaluateAction();
          break;
        case '6':
          await testAction();
          break;
        case '7':
          await reviewHealSuggestions(ask);
          break;
        case '8':
          log.info('Goodbye.');
          return;
        default:
          log.warn(`"${choice}" is not an option. Enter a number from 1 to 8.`);
      }
    }
  } catch (error) {
    log.error(`Menu error: ${(error as Error).message}`);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  npm start                                         interactive menu
  npm start -- --load                               load requirements into ChromaDB
  npm start -- --generate "IMPS transfer"           generate tests for a feature
  npm start -- --analyze "test" "error" ["stack"] ["dom.html"]
                                                    analyse a test failure (optional DOM file for locator healing)
  npm start -- --compliance                         run compliance check
  npm start -- --evaluate                           run RAGAS evaluation
  npm start -- --test ["filter"]                    run Playwright tests and analyse failures
  npm start -- --heal-review                        approve or reject queued locator fixes`;

/**
 * Runs the action named by a CLI flag.
 *
 * @param args - Command-line arguments after the script name.
 * @returns Process exit code: 0 on success, 1 on failure, 2 on bad usage.
 */
async function runCli(args: string[]): Promise<number> {
  try {
    const [flag, ...rest] = args;
    let ok: boolean;
    switch (flag) {
      case '--load':
        ok = await loadAction();
        break;
      case '--generate':
        if (!rest[0]) { log.error('--generate needs a feature name'); console.log(USAGE); return 2; }
        ok = await generateAction(rest.join(' '));
        break;
      case '--analyze':
        if (!rest[0] || !rest[1]) { log.error('--analyze needs a test name and an error message'); console.log(USAGE); return 2; }
        ok = await analyzeAction(rest[0], rest[1], rest[2] ?? '', rest[3]);
        break;
      case '--compliance':
        ok = await complianceAction();
        break;
      case '--evaluate':
        ok = await evaluateAction();
        break;
      case '--test':
        ok = await testAction(rest[0] ?? '');
        break;
      case '--heal-review':
        await reviewHealSuggestions();
        ok = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      default:
        log.error(`Unknown option "${flag}"`);
        console.log(USAGE);
        return 2;
    }
    return ok ? 0 : 1;
  } catch (error) {
    log.error((error as Error).message);
    return 1;
  }
}

/**
 * Entry point: interactive menu with no arguments, CLI mode otherwise.
 */
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      await interactiveMenu();
      process.exit(0);
    }
    process.exit(await runCli(args));
  } catch (error) {
    log.error(`Fatal: ${(error as Error).message}`);
    process.exit(1);
  }
}

void main();
