import * as readline from 'readline';
import { applySuggestion, HealSuggestionEntry, listPending, saveEntry, toReplacement } from './healQueue';

/**
 * Walks an engineer through each pending heal suggestion. Approving one
 * rewrites the broken locator in the source; rejecting one only records the
 * decision. Nothing changes in the code without an explicit "y".
 *
 * Run: npm run heal:review
 *
 * @param askFn - Optional prompt function (the interactive menu passes its own, so two readers don't share stdin).
 * @returns Counts of approved, rejected and skipped suggestions.
 */
export async function reviewHealSuggestions(
  askFn?: (question: string) => Promise<string | null>,
): Promise<{ approved: number; rejected: number; skipped: number }> {
  const pending = await listPending();
  const counts = { approved: 0, rejected: 0, skipped: 0 };
  if (!pending.length) {
    console.log('No pending heal suggestions.');
    return counts;
  }

  const rl = askFn ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<string> =>
    askFn ? ((await askFn(q)) ?? '') : new Promise((resolve) => rl?.question(q, resolve));
  try {
    for (const [i, entry] of pending.entries()) {
      printEntry(entry, i + 1, pending.length);
      const answer = (await ask('Apply this change? [y]es / [n]o (reject) / [s]kip: ')).trim().toLowerCase();

      if (answer === 'y' || answer === 'yes') {
        try {
          entry.changedFiles = await applySuggestion(entry);
          entry.status = 'approved';
          console.log(`  Applied to: ${entry.changedFiles.join(', ')}`);
          counts.approved += 1;
        } catch (error) {
          console.error(`  Could not apply: ${(error as Error).message}`);
          counts.skipped += 1;
          continue;
        }
      } else if (answer === 'n' || answer === 'no') {
        entry.status = 'rejected';
        counts.rejected += 1;
      } else {
        counts.skipped += 1;
        continue;
      }
      entry.decidedAt = new Date().toISOString();
      await saveEntry(entry);
    }
  } finally {
    rl?.close();
  }
  console.log(`\nApproved ${counts.approved}, rejected ${counts.rejected}, skipped ${counts.skipped}.`);
  return counts;
}

/** Prints one suggestion for the engineer to judge. */
function printEntry(entry: HealSuggestionEntry, n: number, total: number): void {
  console.log(`\n[${n}/${total}] ${entry.testName}`);
  console.log(`  Broken locator:    ${entry.failedLocator}`);
  console.log(`  Suggested locator: ${toReplacement(entry.suggestedLocator)}`);
  console.log(`  Confidence:        ${entry.confidence}${entry.confidence === 'low' ? '  (check the page before approving)' : ''}`);
  console.log(`  Reasoning:         ${entry.reasoning}`);
}

if (require.main === module) {
  reviewHealSuggestions().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
