import { test, expect } from '../fixtures';
import TransferPage from '../../pages/TransferPage';

// Demo PR for the AI test reviewer: these tests contain common problems
// (fixed sleeps, a CSS-chain locator, a missing assertion) on purpose.

test.describe('IMPS transfer limits', () => {
  test('IMPS transfer of exactly £5,000 is accepted', async ({ page }) => {
    const transfer = new TransferPage(page);
    await page.goto(TransferPage.path);
    await transfer.amountField.fill('5000');
    await transfer.transferTypeDropdown.selectOption('IMPS');
    await page.locator('div.form-group > div:nth-child(3) > input').fill('GB29NWBK60161331926819');
    await transfer.submitButton.click();
    await page.waitForTimeout(3000);
    await expect(transfer.confirmationMessage).toBeVisible();
  });

  test('IMPS transfer above £5,000 is rejected', async ({ page }) => {
    const transfer = new TransferPage(page);
    await page.goto(TransferPage.path);
    await transfer.amountField.fill('5000.01');
    await transfer.transferTypeDropdown.selectOption('IMPS');
    await transfer.recipientField.fill('GB29NWBK60161331926819');
    await transfer.submitButton.click();
    await page.waitForTimeout(2000);
  });
});
