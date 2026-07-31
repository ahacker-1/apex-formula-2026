import { defineConfig, devices } from '@playwright/test';

const mobileChrome = { ...devices['iPhone 13'], browserName: 'chromium' };
delete mobileChrome.defaultBrowserType;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:8341',
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' }, grepInvert: /@mobile/ },
    { name: 'mobile-chromium', use: mobileChrome, grep: /@mobile/ },
  ],
  webServer: {
    command: 'python3 tools/devserver.py 8341 dist',
    url: 'http://127.0.0.1:8341/',
    // Never trust an existing listener: a dev server from another checkout can
    // serve stale assets and create false product regressions or false passes.
    // A busy port must fail loudly so every run proves which build it exercised.
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
