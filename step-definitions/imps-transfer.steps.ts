import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { CustomWorld } from './world';
import LoginPage from '../pages/LoginPage';
import TransferPage, { isTransferType } from '../pages/TransferPage';

/** Largest single IMPS transfer, used to split a prior daily total into valid transfers. */
const IMPS_PER_TRANSACTION_LIMIT = 5000;

/** Recipient used for the setup transfers that build up a daily total. */
const SETUP_RECIPIENT = process.env.SETUP_RECIPIENT_ACCOUNT ?? '87654321';

/**
 * Returns a TransferPage bound to the scenario's page.
 *
 * @param world - The scenario's CustomWorld.
 * @returns A TransferPage for world.page.
 */
function transferPage(world: CustomWorld): TransferPage {
  return new TransferPage(world.page);
}

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name.
 * @returns Its value.
 * @throws If the variable is missing or empty.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

/**
 * Logs in with TEST_USERNAME / TEST_PASSWORD from .env and waits until the
 * browser has left the login page.
 */
Given('I am logged in as a valid customer', async function (this: CustomWorld): Promise<void> {
  const loginPage = new LoginPage(this.page);
  await loginPage.open();
  await loginPage.login(requireEnv('TEST_USERNAME'), requireEnv('TEST_PASSWORD'));
  await expect(this.page).not.toHaveURL(/\/login/);
});

/**
 * Opens the transfer page and waits for the amount field to be visible.
 */
Given('I am on the transfer page', async function (this: CustomWorld): Promise<void> {
  const page = transferPage(this);
  await page.open();
  await expect(page.amountField).toBeVisible();
});

/**
 * Sends successful IMPS transfers through the UI until today's total equals
 * the given amount. Totals above £5,000 are split into several transfers,
 * since one IMPS transfer cannot exceed £5,000.
 *
 * @param total - Amount already sent today, in pounds.
 */
Given(
  'I have already sent IMPS transfers totalling {float} today',
  async function (this: CustomWorld, total: number): Promise<void> {
    if (total <= 0) throw new Error(`Daily total must be positive, got ${total}`);
    const page = transferPage(this);

    let remaining = Math.round(total * 100) / 100;
    while (remaining > 0) {
      const amount = Math.min(remaining, IMPS_PER_TRANSACTION_LIMIT);
      await page.open();
      await page.fillAmount(amount);
      await page.selectTransferType('IMPS');
      await page.fillRecipient(SETUP_RECIPIENT);
      await page.submitTransfer();
      await expect(page.confirmationMessage).toBeVisible();
      remaining = Math.round((remaining - amount) * 100) / 100;
    }

    await page.open(); // leave the scenario on a fresh transfer form
  },
);

/**
 * Types an amount into the amount field. Negative values are allowed so
 * validation can be tested.
 *
 * @param amount - Amount in pounds, e.g. 2500.00.
 */
When('I enter amount {float}', async function (this: CustomWorld, amount: number): Promise<void> {
  await transferPage(this).fillAmount(amount);
});

/**
 * Picks a transfer type from the dropdown.
 *
 * @param type - IMPS, NEFT, RTGS or SWIFT.
 */
When('I select transfer type {string}', async function (this: CustomWorld, type: string): Promise<void> {
  if (!isTransferType(type)) throw new Error(`Unsupported transfer type "${type}" in feature file`);
  await transferPage(this).selectTransferType(type);
});

/**
 * Types the recipient account into the recipient field.
 *
 * @param account - Recipient account number.
 */
When(
  'I enter recipient account {string}',
  async function (this: CustomWorld, account: string): Promise<void> {
    await transferPage(this).fillRecipient(account);
  },
);

/**
 * Clicks the submit button.
 */
When('I submit the transfer', async function (this: CustomWorld): Promise<void> {
  await transferPage(this).submitTransfer();
});

/**
 * Checks that a confirmation appears and no error is shown.
 */
Then('the transfer should be successful', async function (this: CustomWorld): Promise<void> {
  const page = transferPage(this);
  await expect(page.confirmationMessage).toBeVisible();
  await expect(page.errorMessage).toBeHidden();
});

/**
 * Checks that the AML review message is shown (transfers above £5,000).
 */
Then('I should see AML review message', async function (this: CustomWorld): Promise<void> {
  await expect(transferPage(this).amlReviewMessage).toBeVisible();
});

/**
 * Checks that no AML review message is shown (transfers of £5,000 or less).
 */
Then('I should not see AML review message', async function (this: CustomWorld): Promise<void> {
  await expect(transferPage(this).amlReviewMessage).toBeHidden();
});

/**
 * Checks that the error message contains the expected text.
 *
 * @param expected - Text the error message should contain.
 */
Then('I should see error {string}', async function (this: CustomWorld, expected: string): Promise<void> {
  const page = transferPage(this);
  await expect(page.errorMessage).toBeVisible();
  expect(await page.getErrorMessage()).toContain(expected);
});

/**
 * Checks that an error is shown and no confirmation appears.
 */
Then('the transfer should be rejected', async function (this: CustomWorld): Promise<void> {
  const page = transferPage(this);
  await expect(page.errorMessage).toBeVisible();
  await expect(page.confirmationMessage).toBeHidden();
});
