import { promises as fs } from 'fs';
import * as path from 'path';
import type { HealResult } from './locatorHealer';

/** Folder holding heal suggestions waiting for (or past) an engineer's decision. */
export const HEAL_QUEUE_DIR = path.resolve(process.cwd(), 'outputs', 'heal_suggestions');

/** Folders searched for the broken locator when a suggestion is approved. */
const SOURCE_DIRS = ['pages', 'step-definitions', 'tests'];

/** A heal suggestion and the engineer's decision on it. */
export interface HealSuggestionEntry extends HealResult {
  /** File name in HEAL_QUEUE_DIR, without extension. */
  id: string;
  testName: string;
  /** Locator expression that failed, as found in the Playwright error. */
  failedLocator: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  /** Source files rewritten when the suggestion was approved. */
  changedFiles?: string[];
}

/**
 * Adds a heal suggestion to the approval queue. Suggestions with no locator
 * or no known failed locator are not queued, as there is nothing to apply.
 *
 * @param testName - The failed test.
 * @param failedLocator - The locator that failed.
 * @param heal - The LLM's suggestion.
 * @returns The saved entry, or undefined if it was not queued.
 */
export async function queueHealSuggestion(
  testName: string,
  failedLocator: string,
  heal: HealResult,
): Promise<HealSuggestionEntry | undefined> {
  if (!failedLocator.trim() || !heal.suggestedLocator.trim()) return undefined;
  const createdAt = new Date().toISOString();
  const slug = testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'test';
  const entry: HealSuggestionEntry = {
    id: `${createdAt.replace(/[:.]/g, '-')}-${slug}`,
    testName,
    failedLocator,
    ...heal,
    status: 'pending',
    createdAt,
  };
  await fs.mkdir(HEAL_QUEUE_DIR, { recursive: true });
  await saveEntry(entry);
  return entry;
}

/** Writes an entry back to its file in the queue. */
export async function saveEntry(entry: HealSuggestionEntry): Promise<void> {
  await fs.writeFile(path.join(HEAL_QUEUE_DIR, `${entry.id}.json`), JSON.stringify(entry, null, 2), 'utf-8');
}

/**
 * Lists the suggestions still waiting for a decision, oldest first.
 *
 * @returns Pending entries, or an empty array if the queue is empty.
 */
export async function listPending(): Promise<HealSuggestionEntry[]> {
  let files: string[];
  try {
    files = (await fs.readdir(HEAL_QUEUE_DIR)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files.map(async (f) => JSON.parse(await fs.readFile(path.join(HEAL_QUEUE_DIR, f), 'utf-8')) as HealSuggestionEntry),
  );
  return entries.filter((e) => e.status === 'pending');
}

/**
 * Turns the LLM's suggestion into the text that replaces the failed locator in
 * source, e.g. "await page.getByRole('button', { name: 'Pay' });" becomes
 * "getByRole('button', { name: 'Pay' })".
 *
 * @param suggested - The suggested locator expression.
 * @returns The expression without a leading page object or trailing semicolon.
 */
export function toReplacement(suggested: string): string {
  return suggested
    .trim()
    .replace(/^await\s+/, '')
    .replace(/^(?:this\.)?page\./, '')
    .replace(/;$/, '')
    .trim();
}

/** The failed locator as written with single quotes and with double quotes. */
function locatorVariants(failed: string): string[] {
  return [...new Set([failed, failed.replace(/'/g, '"'), failed.replace(/"/g, "'")])];
}

/** Lists every .ts file under the given folder. */
async function listTsFiles(dir: string): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return listTsFiles(full);
      return Promise.resolve(e.name.endsWith('.ts') ? [full] : []);
    }),
  );
  return nested.flat();
}

/**
 * Applies an approved suggestion: replaces the failed locator with the
 * suggested one in every page object, step definition and spec that uses it.
 *
 * @param entry - The approved entry.
 * @returns Paths (relative to the project root) of the files changed.
 * @throws If the failed locator is not found in any source file.
 */
export async function applySuggestion(entry: HealSuggestionEntry): Promise<string[]> {
  const replacement = toReplacement(entry.suggestedLocator);
  const variants = locatorVariants(entry.failedLocator);
  const files = (await Promise.all(SOURCE_DIRS.map((d) => listTsFiles(path.resolve(process.cwd(), d))))).flat();
  const changed: string[] = [];

  for (const file of files) {
    const source = await fs.readFile(file, 'utf-8');
    let updated = source;
    for (const v of variants) updated = updated.split(v).join(replacement);
    if (updated !== source) {
      await fs.writeFile(file, updated, 'utf-8');
      changed.push(path.relative(process.cwd(), file));
    }
  }
  if (!changed.length) {
    throw new Error(`"${entry.failedLocator}" was not found in ${SOURCE_DIRS.join(', ')}; update the locator by hand`);
  }
  return changed;
}
