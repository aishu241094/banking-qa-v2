import { test as base, expect } from '@playwright/test';
import { DOM_SNAPSHOT_ATTACHMENT, saveDomSnapshot } from '../src/heal/domSnapshot';

/**
 * Playwright `test` with an automatic fixture that saves the page's DOM when
 * a test fails, for the locator healer. Import `test` and `expect` from this
 * file instead of '@playwright/test' in UI specs:
 *
 *   import { test, expect } from '../fixtures';
 */
export const test = base.extend<{ domSnapshotOnFailure: void }>({
  domSnapshotOnFailure: [
    async ({ page }, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      try {
        const file = await saveDomSnapshot(testInfo.titlePath.join(' > '), await page.content());
        await testInfo.attach(DOM_SNAPSHOT_ATTACHMENT, { path: file, contentType: 'text/html' });
      } catch (error) {
        console.warn(`[fixtures] Failed to capture DOM snapshot: ${(error as Error).message}`);
      }
    },
    { auto: true },
  ],
});

export { expect };
