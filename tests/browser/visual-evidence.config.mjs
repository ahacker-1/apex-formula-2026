import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { resolveEvidenceRoot } from './visual-evidence/support.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const captureRoot = resolveEvidenceRoot({
  configured: process.env.APEX_VISUAL_EVIDENCE_DIR,
  legacy: process.env.APEX_CAPTURE_DIR,
  repoRoot,
});
if (captureRoot) process.env.APEX_VISUAL_EVIDENCE_DIR = captureRoot;
// Playwright re-imports the config in replacement worker processes after a
// test failure. Resolve the derived port once in the coordinator and pass it
// through the environment so every worker targets the one dedicated server.
const requestedPort = Number.parseInt(
  process.env.APEX_VISUAL_EVIDENCE_PORT || process.env.APEX_VISUAL_EVIDENCE_RESOLVED_PORT || '',
  10,
);
const port = Number.isInteger(requestedPort) ? requestedPort : 30_000 + (process.pid % 20_000);
process.env.APEX_VISUAL_EVIDENCE_RESOLVED_PORT = String(port);

if (port < 1024 || port > 65_535) {
  throw new Error(`APEX_VISUAL_EVIDENCE_PORT must be between 1024 and 65535; received ${port}`);
}

export default defineConfig({
  testDir: '.',
  testMatch: 'venues.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
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
    { name: 'visual-evidence-chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
  ],
  webServer: {
    command: `npm run build && python3 tools/devserver.py ${port} dist`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
