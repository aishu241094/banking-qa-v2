import type { Locator, Page } from '@playwright/test';
import BasePage from './BasePage';

/** Page Object for the login screen. */
export class LoginPage extends BasePage {
  /** Path of the login page, relative to BASE_URL. */
  static readonly path = '/login';

  readonly emailField: Locator;
  readonly passwordField: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;

  /**
   * @param page - The Playwright page to drive.
   */
  constructor(page: Page) {
    super(page);
    this.emailField = page.getByLabel(/email/i);
    this.passwordField = page.getByLabel(/password/i);
    this.loginButton = page.getByRole('button', { name: /log ?in|sign ?in/i });
    this.errorMessage = page.getByRole('alert');
  }

  /**
   * Opens the login page.
   *
   * @throws If navigation fails.
   */
  async open(): Promise<void> {
    try {
      await this.navigate(LoginPage.path);
      await this.waitForLoad();
    } catch (error) {
      throw new Error(`Failed to open login page: ${(error as Error).message}`);
    }
  }

  /**
   * Types an email address into the email field.
   *
   * @param email - Email to enter.
   * @throws If the field cannot be found or filled.
   */
  async fillEmail(email: string): Promise<void> {
    try {
      await this.emailField.fill(email);
    } catch (error) {
      throw new Error(`Failed to fill email: ${(error as Error).message}`);
    }
  }

  /**
   * Types a password into the password field.
   *
   * @param password - Password to enter.
   * @throws If the field cannot be found or filled.
   */
  async fillPassword(password: string): Promise<void> {
    try {
      await this.passwordField.fill(password);
    } catch (error) {
      throw new Error(`Failed to fill password: ${(error as Error).message}`);
    }
  }

  /**
   * Clicks the login button.
   *
   * @throws If the button cannot be found or clicked.
   */
  async clickLogin(): Promise<void> {
    try {
      await this.loginButton.click();
    } catch (error) {
      throw new Error(`Failed to click login: ${(error as Error).message}`);
    }
  }

  /**
   * Fills both fields and submits the form.
   *
   * @param email - Email to enter.
   * @param password - Password to enter.
   * @throws If any step fails.
   */
  async login(email: string, password: string): Promise<void> {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.clickLogin();
  }

  /**
   * Reads the login error message once it appears.
   *
   * @returns The trimmed error text.
   * @throws If no error message appears before the timeout.
   */
  async getErrorMessage(): Promise<string> {
    try {
      await this.errorMessage.waitFor({ state: 'visible' });
      return (await this.errorMessage.innerText()).trim();
    } catch (error) {
      throw new Error(`Login error message not found: ${(error as Error).message}`);
    }
  }
}

export default LoginPage;
