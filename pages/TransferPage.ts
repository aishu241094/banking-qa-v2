import type { Locator, Page } from '@playwright/test';
import BasePage from './BasePage';

/** Transfer types offered in the transfer type dropdown. */
export const TRANSFER_TYPES = ['IMPS', 'NEFT', 'RTGS', 'SWIFT'] as const;

/** One of the supported transfer types. */
export type TransferType = (typeof TRANSFER_TYPES)[number];

/**
 * Checks whether a string is a supported transfer type.
 *
 * @param value - Value to check.
 * @returns True if value is IMPS, NEFT, RTGS or SWIFT.
 */
export function isTransferType(value: string): value is TransferType {
  return (TRANSFER_TYPES as readonly string[]).includes(value);
}

/** Page Object for the funds transfer screen. */
export class TransferPage extends BasePage {
  /** Path of the transfer page, relative to BASE_URL. */
  static readonly path = '/transfer';

  readonly amountField: Locator;
  readonly transferTypeDropdown: Locator;
  readonly recipientField: Locator;
  readonly submitButton: Locator;
  readonly confirmationMessage: Locator;
  readonly errorMessage: Locator;
  readonly amlReviewMessage: Locator;

  /**
   * @param page - The Playwright page to drive.
   */
  constructor(page: Page) {
    super(page);
    this.amountField = page.getByLabel(/amount/i);
    this.transferTypeDropdown = page.getByLabel(/transfer type/i);
    this.recipientField = page.getByLabel(/recipient|beneficiary/i);
    this.submitButton = page.getByRole('button', { name: /transfer|submit|send/i });
    this.confirmationMessage = page.getByRole('status');
    this.errorMessage = page.getByRole('alert');
    this.amlReviewMessage = page.getByText(/AML review|anti-money laundering/i);
  }

  /**
   * Opens the transfer page.
   *
   * @throws If navigation fails.
   */
  async open(): Promise<void> {
    try {
      await this.navigate(TransferPage.path);
      await this.waitForLoad();
    } catch (error) {
      throw new Error(`Failed to open transfer page: ${(error as Error).message}`);
    }
  }

  /**
   * Types an amount into the amount field. Negative values are allowed so
   * validation can be tested.
   *
   * @param amount - Amount in pounds, e.g. 4999.99.
   * @throws If the amount is not a finite number or the field cannot be filled.
   */
  async fillAmount(amount: number): Promise<void> {
    try {
      if (!Number.isFinite(amount)) throw new Error(`amount must be a finite number, got ${amount}`);
      await this.amountField.fill(amount.toString());
    } catch (error) {
      throw new Error(`Failed to fill amount: ${(error as Error).message}`);
    }
  }

  /**
   * Picks a transfer type from the dropdown.
   *
   * @param type - IMPS, NEFT, RTGS or SWIFT.
   * @throws If the type is unsupported or the option cannot be selected.
   */
  async selectTransferType(type: TransferType): Promise<void> {
    try {
      if (!isTransferType(type)) throw new Error(`unsupported transfer type "${type}"`);
      await this.transferTypeDropdown.selectOption(type);
    } catch (error) {
      throw new Error(`Failed to select transfer type: ${(error as Error).message}`);
    }
  }

  /**
   * Types the recipient into the recipient field.
   *
   * @param recipient - Recipient name or account identifier.
   * @throws If the field cannot be filled.
   */
  async fillRecipient(recipient: string): Promise<void> {
    try {
      await this.recipientField.fill(recipient);
    } catch (error) {
      throw new Error(`Failed to fill recipient: ${(error as Error).message}`);
    }
  }

  /**
   * Clicks the submit button.
   *
   * @throws If the button cannot be found or clicked.
   */
  async submitTransfer(): Promise<void> {
    try {
      await this.submitButton.click();
    } catch (error) {
      throw new Error(`Failed to submit transfer: ${(error as Error).message}`);
    }
  }

  /**
   * Reads the confirmation message once it appears.
   *
   * @returns The trimmed confirmation text.
   * @throws If no confirmation appears before the timeout.
   */
  async getConfirmation(): Promise<string> {
    try {
      await this.confirmationMessage.waitFor({ state: 'visible' });
      return (await this.confirmationMessage.innerText()).trim();
    } catch (error) {
      throw new Error(`Transfer confirmation not found: ${(error as Error).message}`);
    }
  }

  /**
   * Reads the error message once it appears.
   *
   * @returns The trimmed error text.
   * @throws If no error message appears before the timeout.
   */
  async getErrorMessage(): Promise<string> {
    try {
      await this.errorMessage.waitFor({ state: 'visible' });
      return (await this.errorMessage.innerText()).trim();
    } catch (error) {
      throw new Error(`Transfer error message not found: ${(error as Error).message}`);
    }
  }
}

export default TransferPage;
