import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const PILOT_SEED = 'greenwood-tacn-acceptance-2026';

async function seed(page) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_settings', JSON.stringify({ quali: false }));
  });
}

function monitorRuntime(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${String(error)}`));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function captureEvidence(page, testInfo, name) {
  const folder = testInfo.outputPath('evidence');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

async function openMenu(page) {
  await seed(page);
  await page.goto(`/?seed=${encodeURIComponent(PILOT_SEED)}`);
  await expect(page).toHaveTitle(/APEX FORMULA 2026/);
  await expect(page.getByRole('button', { name: /QUICK RACE/ })).toBeVisible();
}

async function selectPilot(page, beforeLaunch) {
  await page.getByRole('button', { name: /QUICK RACE/ }).click();
  const player = page.locator('.drv[data-d="hacker"]');
  await expect(player, "The player option must use data-d='hacker'").toBeVisible();
  await expect(player).toHaveAttribute('aria-label', /Avi Hacker/i);
  await expect(player.locator('xpath=ancestor::*[contains(@class,"select-card")][1]')).toContainText('AI Consulting Network');
  await player.click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();

  const pilot = page.locator('.track-card[data-t="spa"]');
  await expect(pilot, "The pilot venue must use data-t='spa'").toBeVisible();
  await expect(pilot).toContainText('Greenwood Forest Circuit');
  if (beforeLaunch) await beforeLaunch({ player, pilot });
  await pilot.click();
  await page.waitForFunction(
    () => window.__game?.session && window.__game.state === 'race',
    null,
    { timeout: 45_000, polling: 50 },
  );
  await expect(page.locator('#hud')).toHaveClass(/active/);
}

async function bootPilot(page, beforeLaunch) {
  await openMenu(page);
  await selectPilot(page, beforeLaunch);
}

async function debugSnapshot(page) {
  return page.evaluate(() => {
    const debug = window.__apexDebug;
    if (!debug || typeof debug.snapshot !== 'function') {
      throw new Error('window.__apexDebug.snapshot() is required by SIMULATION_ACCEPTANCE.md');
    }
    const snapshot = debug.snapshot();
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('window.__apexDebug.snapshot() must return a serializable object');
    }
    return snapshot;
  });
}

async function applyScenario(page) {
  await page.evaluate(async () => {
    const debug = window.__apexDebug;
    if (!debug || typeof debug.applyScenario !== 'function') {
      throw new Error('window.__apexDebug.applyScenario() is required for deterministic weather/race acceptance');
    }
    await debug.applyScenario({
      weather: { condition: 'rain', intensity: 0.65 },
      track: { surface: 'wet', wetness: 0.6 },
      raceControl: { state: 'vsc' },
      damage: { component: 'frontWing', severity: 0.35 },
      strategy: { recommendation: 'pit-now', compound: 'I' },
    });
  });
}

function expectFiniteTree(value, label = 'snapshot') {
  const pending = [[value, label]];
  const seen = new Set();
  while (pending.length) {
    const [entry, at] = pending.pop();
    if (typeof entry === 'number') {
      expect(Number.isFinite(entry), `${at} must be finite; received ${entry}`).toBe(true);
      continue;
    }
    if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
    seen.add(entry);
    for (const [key, child] of Object.entries(entry)) pending.push([child, `${at}.${key}`]);
  }
}

test('TACN / Greenwood pilot launches without an online dependency', async ({ page }, testInfo) => {
  const runtimeErrors = monitorRuntime(page);
  const externalRequests = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'http://127.0.0.1:8342') {
      externalRequests.push(url.href);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  await bootPilot(page, async ({ pilot }) => {
    await pilot.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, 'greenwood-track-selection');
  });
  await captureEvidence(page, testInfo, 'greenwood-race-start');

  expect(externalRequests, `Runtime requested external resources:\n${externalRequests.join('\n')}`).toEqual([]);
  expect(runtimeErrors, `Runtime emitted errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});

test('arrow controls, cockpit dash, telemetry, pause and recovery share one stable state', async ({ page }, testInfo) => {
  const runtimeErrors = monitorRuntime(page);
  await bootPilot(page);

  let snapshot = await debugSnapshot(page);
  expect(snapshot.player).toMatchObject({ driverId: 'hacker', teamId: 'tacn' });
  expect(snapshot.track).toMatchObject({ id: 'spa', name: 'Greenwood Forest Circuit' });

  const controls = [
    ['ArrowUp', 'throttle', value => value >= 0.95],
    ['ArrowDown', 'brake', value => value >= 0.95],
    ['ArrowLeft', 'steer', value => value >= 0.25],
    ['ArrowRight', 'steer', value => value <= -0.25],
  ];
  for (const [key, field, accepted] of controls) {
    await page.keyboard.down(key);
    await expect.poll(async () => accepted((await debugSnapshot(page)).controls?.[field]), {
      message: `${key} must update window.__apexDebug.snapshot().controls.${field}`,
    }).toBe(true);
    await page.keyboard.up(key);
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    snapshot = await debugSnapshot(page);
    if (snapshot.camera?.mode === 'cockpit') break;
    await page.keyboard.press('KeyC');
  }
  snapshot = await debugSnapshot(page);
  expect(snapshot.camera?.mode, "KeyC must reach the named 'cockpit' camera mode").toBe('cockpit');
  await expect(page.locator('[data-sim-panel="cockpit"]')).toBeVisible();
  await expect(page.locator('[data-sim-panel="telemetry"]')).toBeVisible();
  expect(snapshot.telemetry?.visible).toBe(true);
  expectFiniteTree(snapshot.player?.physics, 'snapshot.player.physics');
  expectFiniteTree(snapshot.telemetry, 'snapshot.telemetry');
  await captureEvidence(page, testInfo, 'cockpit-telemetry');

  await page.keyboard.down('ArrowUp');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowUp');
  await expect(page.getByRole('button', { name: 'RESUME' })).toBeVisible();
  snapshot = await debugSnapshot(page);
  expect(snapshot.paused).toBe(true);
  expect(snapshot.controls).toMatchObject({ throttle: 0, brake: 0 });
  expect(Math.abs(snapshot.controls?.steer ?? Infinity)).toBeLessThanOrEqual(1e-5);
  await captureEvidence(page, testInfo, 'pause-recovery');
  await page.getByRole('button', { name: 'RESUME' }).click();
  await expect.poll(async () => (await debugSnapshot(page)).paused).toBe(false);
  snapshot = await debugSnapshot(page);
  expectFiniteTree(snapshot.player?.physics, 'recovered.player.physics');
  expect(runtimeErrors, `Runtime emitted errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});

test('seeded wet-race, damage, strategy and race-control states are deterministic and visible', async ({ page }, testInfo) => {
  await bootPilot(page);
  await applyScenario(page);

  const first = await debugSnapshot(page);
  expect(first.weather).toMatchObject({ condition: 'rain', intensity: 0.65 });
  expect(first.track?.state).toMatchObject({ surface: 'wet', wetness: 0.6 });
  expect(first.raceControl).toMatchObject({ state: 'vsc' });
  expect(first.damage).toMatchObject({ frontWing: 0.35 });
  expect(first.strategy).toMatchObject({ recommendation: 'pit-now', compound: 'I' });
  expectFiniteTree({
    weather: first.weather,
    trackState: first.track?.state,
    raceControl: first.raceControl,
    damage: first.damage,
    strategy: first.strategy,
  }, 'scenario');

  for (const marker of ['weather', 'damage', 'strategy', 'race-control']) {
    await expect(page.locator(`[data-sim-state="${marker}"]`), `Missing visible data-sim-state="${marker}"`).toBeVisible();
  }
  await captureEvidence(page, testInfo, 'wet-vsc-damage-strategy');

  await applyScenario(page);
  const second = await debugSnapshot(page);
  expect({
    weather: second.weather,
    trackState: second.track?.state,
    raceControl: second.raceControl,
    damage: second.damage,
    strategy: second.strategy,
  }).toEqual({
    weather: first.weather,
    trackState: first.track?.state,
    raceControl: first.raceControl,
    damage: first.damage,
    strategy: first.strategy,
  });
});

test('desktop high-quality frame pacing stays inside the acceptance budget', async ({ page }) => {
  await bootPilot(page);
  const result = await page.evaluate(async () => {
    const deltas = [];
    let previous;
    await new Promise(resolve => {
      const sample = now => {
        if (previous !== undefined) deltas.push(now - previous);
        previous = now;
        if (deltas.length >= 180) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const stable = deltas.slice(10).sort((a, b) => a - b);
    const percentile = p => stable[Math.min(stable.length - 1, Math.floor(stable.length * p))];
    return {
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: stable.at(-1),
      over50Ms: stable.filter(value => value > 50).length,
      sampleCount: stable.length,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  });
  expect(result.viewport).toMatchObject({ width: 1440, height: 900 });
  expect(result.sampleCount).toBeGreaterThanOrEqual(160);
  expect(result.p95Ms, `p95 frame time ${result.p95Ms.toFixed(2)}ms exceeded 50ms`).toBeLessThanOrEqual(50);
  expect(result.p99Ms, `p99 frame time ${result.p99Ms.toFixed(2)}ms exceeded 100ms`).toBeLessThanOrEqual(100);
  expect(result.over50Ms, `${result.over50Ms} frames exceeded 50ms`).toBeLessThanOrEqual(4);
});

test('@mobile adaptive fallback remains usable without desktop overflow', async ({ page }, testInfo) => {
  await openMenu(page);
  const menuLayout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(menuLayout.scrollWidth).toBeLessThanOrEqual(menuLayout.width + 1);
  await captureEvidence(page, testInfo, 'mobile-main-menu');

  await selectPilot(page);
  await expect(page.locator('#touch-controls')).toHaveClass(/enabled/);
  await expect(page.getByRole('button', { name: 'Throttle' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Brake' })).toBeVisible();
  const snapshot = await debugSnapshot(page);
  expect(snapshot.quality?.adaptive).toBe(true);
  expect(snapshot.quality?.profile).not.toBe('desktop-high');
  const raceLayout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(raceLayout.scrollWidth).toBeLessThanOrEqual(raceLayout.width + 1);
  await captureEvidence(page, testInfo, 'mobile-adaptive-race');
});
