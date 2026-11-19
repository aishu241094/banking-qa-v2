import type { Locator, Page } from '@playwright/test';
import BasePage from './BasePage';

/**
 * Page Object for the quick-pay widget. Used by tests/e2e/heal-demo.e2e.spec.ts
 * to demonstrate locator healing: the widget's markup is served by the test
 * itself, so the demo runs without the banking app.
 */
export class QuickPayPage extends BasePage {
  readonly amountField: Locator;
  readonly payButton: Locator;
  readonly confirmation: Locator;

  /**
   * @param page - The Playwright page to drive.
   */
  constructor(page: Page) {
    super(page);
    this.amountField = page.getByLabel('Amount');
    this.payButton = page.locator('#pay-now-btn');
    this.confirmation = page.getByRole('status');
  }

  /**
   * Enters an amount and submits the payment.
   *
   * @param amount - Amount in pounds.
   */
  async pay(amount: string): Promise<void> {
    await this.amountField.fill(amount);
    await this.payButton.click({ timeout: 3_000 });
  }
}

export default QuickPayPage;
