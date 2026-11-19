import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Playwright configuration for the banking QA framework.
 * Separate projects for API and E2E layers; HTML + JSON reporters feed the
 * failure-analysis and RAGAS evaluation modules via the outputs/ directory.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'outputs/playwright-report', open: 'never' }],
    ['json', { outputFile: 'outputs/test-results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'api',
      testDir: './tests/api',
      use: {
        baseURL: process.env.API_BASE_URL ?? 'http://localhost:3000/api',
      },
    },
    {
      name: 'e2e-chromium',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
