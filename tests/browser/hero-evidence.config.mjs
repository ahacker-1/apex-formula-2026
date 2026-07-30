import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const requestedPort = Number.parseInt(process.env.APEX_HERO_EVIDENCE_PORT || '', 10);
const port = Number.isInteger(requestedPort) ? requestedPort : 18_460;

if (port < 1024 || port > 65_535) {
  throw new Error(`APEX_HERO_EVIDENCE_PORT must be between 1024 and 65535; received ${port}`);
}

export default defineConfig({
  testDir: './visual-evidence',
  testMatch: 'hero-capture.probe.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 12_000 },
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'hero-evidence-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
  ],
  webServer: {
    command: `python3 tools/devserver.py ${port} .`,
    cwd: repoRoot,
    env: { ...process.env, APEX_EVIDENCE_FAULT_PROBES: '1' },
    url: `http://127.0.0.1:${port}/tools/hero-capture.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
