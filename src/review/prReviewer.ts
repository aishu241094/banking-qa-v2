import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as dotenv from 'dotenv';
import { callClaudeJson, MODEL } from '../generators/claudeClient';

dotenv.config();

/** Paths whose changes are reviewed; everything else in the diff is ignored. */
const REVIEWED_PATHS = ['tests', 'features', 'step-definitions', 'pages', 'src', 'main.ts', 'playwright.config.ts'];

/** Maximum diff characters sent to the LLM. */
const MAX_DIFF_CHARS = 60_000;

/** Hidden marker that identifies this bot's comment, so reruns update it instead of adding new ones. */
const COMMENT_MARKER = '<!-- ai-test-review -->';

/** One issue the reviewer found. */
export interface ReviewFinding {
  /** File path and line or area, e.g. "pages/TransferPage.ts:41". */
  location: string;
  severity: 'high' | 'medium' | 'low';
  category: 'missing-assertion' | 'flaky-pattern' | 'locator' | 'test-design' | 'banking-rule' | 'other';
  issue: string;
  suggestion: string;
}

/** The LLM's review of a diff. */
export interface PrReview {
  /** Two or three sentences on what the change does and its overall quality. */
  summary: string;
  verdict: 'looks-good' | 'needs-changes';
  findings: ReviewFinding[];
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: ['looks-good', 'needs-changes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['missing-assertion', 'flaky-pattern', 'locator', 'test-design', 'banking-rule', 'other'],
          },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['location', 'severity', 'category', 'issue', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'verdict', 'findings'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You review pull requests for a banking QA automation framework (Playwright, Cucumber BDD, TypeScript, Page Object Model).

Review the test code in the diff for:
- missing-assertion: a test or Then step that performs actions but never asserts the outcome, or asserts too weakly (e.g. only that a page loaded).
- flaky-pattern: fixed sleeps (waitForTimeout), assertions that do not auto-wait, shared state between tests, order dependence.
- locator: fragile locators (CSS classes, nth-child, long XPath) where getByRole, getByLabel or getByTestId would work.
- test-design: missing boundary or negative cases, duplicated steps, assertions inside page objects (they belong in tests and steps), unclear names.
- banking-rule: tests that contradict these rules: IMPS max £5,000 per transaction and £10,000 per day; NEFT max £50,000 per day; RTGS min £200,000; transactions ABOVE £5,000 are flagged for AML review, exactly £5,000 is not.

Only report problems you can see in the diff, and give the file and line or area in location. Each suggestion must be concrete, ideally a corrected line of code. Do not report style nits a linter would catch. If the change is fine, return verdict "looks-good" with an empty findings list.`;

/**
 * Returns the diff to review: from a file if --diff-file is given, otherwise
 * from git (base branch from GITHUB_BASE_REF in Actions, or --base locally).
 *
 * @param args - Command-line arguments.
 * @returns The diff text (may be empty).
 * @throws If git or the file read fails.
 */
export async function readDiff(args: string[]): Promise<string> {
  const fileFlag = args.indexOf('--diff-file');
  if (fileFlag !== -1) {
    const file = args[fileFlag + 1];
    if (!file) throw new Error('--diff-file needs a path');
    return fs.readFile(file, 'utf-8');
  }
  const baseFlag = args.indexOf('--base');
  const base =
    baseFlag !== -1 ? args[baseFlag + 1] : process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  if (!base) throw new Error('--base needs a branch name');
  // execFileSync passes arguments directly to git, so the branch name is never parsed by a shell.
  return execFileSync('git', ['diff', '--unified=5', `${base}...HEAD`, '--', ...REVIEWED_PATHS], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Asks the LLM to review a diff.
 *
 * @param diff - Unified diff text.
 * @returns The review.
 * @throws If the LLM call fails.
 */
export async function reviewDiff(diff: string): Promise<PrReview> {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const body = truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]` : diff;
  return callClaudeJson<PrReview>({
    system: SYSTEM_PROMPT,
    prompt: `<diff>\n${body}\n</diff>\n\nReview the test code in this diff.`,
    schema: REVIEW_SCHEMA,
    maxTokens: 16000,
  });
}

/**
 * Formats a review as a GitHub PR comment in Markdown.
 *
 * @param review - The review.
 * @param model - Model that produced it, shown in the footer.
 * @returns The comment body, starting with the hidden marker.
 */
export function formatReviewComment(review: PrReview, model: string): string {
  const icon = { high: '🔴', medium: '🟠', low: '🟡' } as const;
  const order = { high: 0, medium: 1, low: 2 } as const;
  const findings = [...review.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = (['high', 'medium', 'low'] as const)
    .map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`)
    .join(' · ');

  const lines = [
    COMMENT_MARKER,
    '## 🤖 AI test review',
    '',
    `**Verdict:** ${review.verdict === 'looks-good' ? '✅ Looks good' : '⚠️ Needs changes'}${findings.length ? ` (${counts})` : ''}`,
    '',
    review.summary,
    '',
  ];
  if (findings.length) {
    lines.push('| | Location | Category | Issue | Suggestion |', '|---|---|---|---|---|');
    const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    for (const f of findings) {
      lines.push(`| ${icon[f.severity]} | \`${cell(f.location)}\` | ${f.category} | ${cell(f.issue)} | ${cell(f.suggestion)} |`);
    }
    lines.push('');
  }
  lines.push(`<sub>Generated by ${model}. Advisory only: a reviewer decides what to change.</sub>`);
  return lines.join('\n');
}

/**
 * Posts the comment on the PR, or updates this bot's earlier comment.
 *
 * @param body - Comment Markdown.
 * @returns True if posted; false if not running in a PR (the caller prints it instead).
 * @throws If the GitHub API rejects the request.
 */
async function postComment(body: string): Promise<boolean> {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_EVENT_PATH: eventPath } = process.env;
  if (!token || !repo || !eventPath) return false;
  const event = JSON.parse(await fs.readFile(eventPath, 'utf-8')) as { pull_request?: { number: number } };
  const pr = event.pull_request?.number;
  if (!pr) return false;

  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${url} returned ${res.status}: ${await res.text()}`);
    return res;
  };

  const comments = (await (await request(`${api}/issues/${pr}/comments?per_page=100`)).json()) as { id: number; body?: string }[];
  const existing = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));
  if (existing) {
    await request(`${api}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  } else {
    await request(`${api}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  }
  return true;
}

/**
 * Reviews the PR diff and posts the result as a PR comment (or prints it
 * when run locally). The review is advisory, so problems are reported as
 * warnings and never fail the PR check.
 *
 * @param args - Command-line arguments: [--base <branch>] [--diff-file <path>].
 */
export async function runPrReview(args: string[]): Promise<void> {
  const keyName = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyName]) {
    // Pull requests from forks get no secrets: skip instead of failing.
    console.log(`::warning::AI review skipped: ${keyName} is not set`);
    return;
  }

  const diff = await readDiff(args);
  if (!diff.trim()) {
    console.log('No changes to test code in this PR; nothing to review.');
    return;
  }

  console.log(`Reviewing ${diff.length} characters of diff with ${MODEL}...`);
  const comment = formatReviewComment(await reviewDiff(diff), MODEL);
  if (await postComment(comment)) {
    console.log('Review posted to the pull request.');
  } else {
    console.log(`\n${comment}\n`);
  }
}

// Run directly: npm run review:pr -- [--base origin/main] [--diff-file changes.diff]
if (require.main === module) {
  runPrReview(process.argv.slice(2)).catch((error: Error) => {
    console.log(`::warning::AI review failed: ${error.message}`);
  });
}
