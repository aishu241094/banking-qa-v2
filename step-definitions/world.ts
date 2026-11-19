import * as dotenv from 'dotenv';
import {
  After,
  Before,
  ITestCaseHookParameter,
  IWorldOptions,
  setDefaultTimeout,
  setWorldConstructor,
  Status,
  World,
} from '@cucumber/cucumber';
import { Browser, BrowserContext, chromium, Page } from '@playwright/test';
import { saveDomSnapshot } from '../src/heal/domSnapshot';

dotenv.config();

/** Step timeout in ms; browser actions need longer than Cucumber's 5s default. */
setDefaultTimeout(Number(process.env.STEP_TIMEOUT_MS ?? 30_000));

/**
 * Cucumber World shared by the steps of one scenario. A fresh browser,
 * context and page are created before each scenario and closed after it.
 * In step definitions, type `this` as CustomWorld: `async function (this: CustomWorld) {...}`.
 */
export class CustomWorld extends World {
  /** Playwright browser for this scenario. Set in the Before hook. */
  browser!: Browser;
  /** Isolated browser context (own cookies and storage). Set in the Before hook. */
  context!: BrowserContext;
  /** Page the steps drive. Set in the Before hook. */
  page!: Page;

  /**
   * @param options - World options passed in by Cucumber.
   */
  constructor(options: IWorldOptions) {
    super(options);
  }

  /**
   * Launches Chromium and opens a new page. Set HEADLESS=false in .env to watch.
   *
   * @throws If the browser fails to launch.
   */
  async openBrowser(): Promise<void> {
    try {
      this.browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
      this.context = await this.browser.newContext({
        baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
      });
      this.page = await this.context.newPage();
    } catch (error) {
      await this.closeBrowser();
      throw new Error(`Failed to launch browser: ${(error as Error).message}`);
    }
  }

  /**
   * Closes the context and browser. Safe to call if they were never opened.
   */
  async closeBrowser(): Promise<void> {
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch (error) {
      console.warn(`[world] Failed to close browser cleanly: ${(error as Error).message}`);
    }
  }
}

setWorldConstructor(CustomWorld);

Before(async function (this: CustomWorld) {
  await this.openBrowser();
});

After(async function (this: CustomWorld, { pickle, result }: ITestCaseHookParameter) {
  try {
    if (result?.status === Status.FAILED && this.page) {
      try {
        const screenshot = await this.page.screenshot({ fullPage: true });
        this.attach(screenshot, 'image/png');
      } catch (error) {
        console.warn(`[world] Failed to capture failure screenshot: ${(error as Error).message}`);
      }
      // DOM snapshot for the locator healer (outputs/dom_snapshots/).
      try {
        const html = await this.page.content();
        const file = await saveDomSnapshot(pickle.name, html);
        this.attach(`DOM snapshot saved to ${file}`, 'text/plain');
      } catch (error) {
        console.warn(`[world] Failed to capture DOM snapshot: ${(error as Error).message}`);
      }
    }
  } finally {
    await this.closeBrowser();
  }
});

export { setWorldConstructor };
export default CustomWorld;
