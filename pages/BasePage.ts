import { promises as fs } from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

/** Folder where takeScreenshot() saves images. */
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'outputs', 'screenshots');

/** Load states accepted by waitForLoad(). */
export type LoadState = 'load' | 'domcontentloaded' | 'networkidle';

/**
 * Base class for every Page Object. Holds the Playwright Page and the actions
 * every page shares. Page objects expose locators and actions only; assertions
 * belong in step definitions.
 */
export class BasePage {
  /** The Playwright page this object drives. */
  protected readonly page: Page;

  /**
   * @param page - The Playwright page to drive.
   * @throws If no page is given.
   */
  constructor(page: Page) {
    if (!page) throw new Error(`${new.target.name} needs a Playwright Page`);
    this.page = page;
  }

  /**
   * Opens a URL. Relative paths such as "/login" are resolved against BASE_URL.
   *
   * @param url - Absolute URL or path relative to BASE_URL.
   * @throws If navigation fails or times out.
   */
  async navigate(url: string): Promise<void> {
    try {
      const target = /^https?:\/\//i.test(url)
        ? url
        : new URL(url, process.env.BASE_URL ?? 'http://localhost:3000').toString();
      await this.page.goto(target);
    } catch (error) {
      throw new Error(`Failed to navigate to "${url}": ${(error as Error).message}`);
    }
  }

  /**
   * Waits until the page reaches a load state.
   *
   * @param state - Load state to wait for (default "load").
   * @throws If the state is not reached before the timeout.
   */
  async waitForLoad(state: LoadState = 'load'): Promise<void> {
    try {
      await this.page.waitForLoadState(state);
    } catch (error) {
      throw new Error(`Page did not reach "${state}": ${(error as Error).message}`);
    }
  }

  /**
   * Saves a full-page screenshot to outputs/screenshots/.
   *
   * @param name - File name without extension; a timestamp is added.
   * @returns The screenshot image, e.g. for attaching to a Cucumber report.
   * @throws If the screenshot cannot be taken or saved.
   */
  async takeScreenshot(name: string = this.constructor.name): Promise<Buffer> {
    try {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '_');
      const filePath = path.join(SCREENSHOT_DIR, `${safeName}-${Date.now()}.png`);
      return await this.page.screenshot({ path: filePath, fullPage: true });
    } catch (error) {
      throw new Error(`Failed to take screenshot "${name}": ${(error as Error).message}`);
    }
  }
}

export default BasePage;
