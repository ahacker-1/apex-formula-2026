import { defineConfig, devices } from '@playwright/test';

const mobileChrome = { ...devices['iPhone 13'], browserName: 'chromium' };
delete mobileChrome.defaultBrowserType;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'simulation-upgrade.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/simulation-upgrade/artifacts',
  reporter: process.env.CI ? [['line'], ['html', { outputFolder: 'playwright-report/simulation-upgrade', open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:8342',
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'simulation-desktop',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
      grepInvert: /@mobile/,
    },
    {
      name: 'simulation-mobile',
      use: mobileChrome,
      grep: /@mobile/,
    },
  ],
  webServer: {
    command: 'python3 tools/devserver.py 8342 dist',
    url: 'http://127.0.0.1:8342/',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
