import { promises as fs } from 'fs';
import * as path from 'path';

/** Playwright attachment name for the snapshot; main.ts looks for it in the JSON report. */
export const DOM_SNAPSHOT_ATTACHMENT = 'dom-snapshot';

/** Folder where failure DOM snapshots are written. */
export const DOM_SNAPSHOT_DIR = path.resolve(process.cwd(), 'outputs', 'dom_snapshots');

/**
 * Saves a page's HTML, captured when a test fails, so the locator healer can
 * work from the real page instead of a placeholder.
 *
 * @param testName - Name of the failed test or scenario (used in the file name).
 * @param html - The page HTML, e.g. from page.content().
 * @returns Absolute path of the saved file.
 * @throws If the file cannot be written.
 */
export async function saveDomSnapshot(testName: string, html: string): Promise<string> {
  const slug = testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'test';
  const file = path.join(DOM_SNAPSHOT_DIR, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  await fs.mkdir(DOM_SNAPSHOT_DIR, { recursive: true });
  await fs.writeFile(file, html, 'utf-8');
  return file;
}
