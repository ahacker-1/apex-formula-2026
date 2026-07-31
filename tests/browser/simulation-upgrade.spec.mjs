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
    const debug = window.__game;
    if (!debug || typeof debug.snapshot !== 'function') {
      throw new Error('window.__game.snapshot() is required by SIMULATION_ACCEPTANCE.md');
    }
    const snapshot = debug.snapshot();
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('window.__game.snapshot() must return a serializable object');
    }
    return snapshot;
  });
}

async function applyScenario(page) {
  await page.evaluate(async () => {
    const debug = window.__game;
    if (!debug || typeof debug.applyScenario !== 'function') {
      throw new Error('window.__game.applyScenario() is required for deterministic weather/race acceptance');
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

  const weatherSeed = await page.evaluate(async (pilotSeed) => {
    const [{ deriveSeed, normalizeSeed }, { WeatherTimeline }] = await Promise.all([
      import('/js/random.js'),
      import('/js/weather.js'),
    ]);
    const sessionSeed = normalizeSeed(pilotSeed);
    const expected = new WeatherTimeline({ trackId: 'spa', seed: deriveSeed(sessionSeed, 'weather') });
    const same = new WeatherTimeline({ trackId: 'spa', seed: deriveSeed(sessionSeed, 'weather') });
    const different = new WeatherTimeline({ trackId: 'spa', seed: deriveSeed(sessionSeed + 1, 'weather') });
    const signature = timeline => timeline.keyframes.slice(0, 8).map(frame => [
      frame.rainfall, frame.cloudCover, frame.airTemperature, frame.windDirection,
    ]);
    return {
      runtime: window.__game.circuit.weather.seed,
      expected: expected.seed,
      same: signature(same),
      expectedWeather: signature(expected),
      different: signature(different),
    };
  }, PILOT_SEED);
  expect(weatherSeed.runtime).toBe(weatherSeed.expected);
  expect(weatherSeed.same).toEqual(weatherSeed.expectedWeather);
  expect(weatherSeed.different).not.toEqual(weatherSeed.expectedWeather);

  expect(externalRequests, `Runtime requested external resources:\n${externalRequests.join('\n')}`).toEqual([]);
  expect(runtimeErrors, `Runtime emitted errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});

test('TACN full weekend is reachable from the keyboard-first main menu and opens physical FP1', async ({ page }, testInfo) => {
  const runtimeErrors = monitorRuntime(page);
  await openMenu(page);
  const weekend = page.getByRole('button', { name: /TACN RACE WEEKEND · GREENWOOD FOREST/i });
  await expect(weekend).toBeVisible();
  await weekend.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__game?.session?.mode === 'practice' &&
      window.__game?.raceConfig?.fullWeekend === true &&
      window.__game?.state === 'quali',
    null,
    { timeout: 45_000, polling: 50 },
  );
  const weekendState = await page.evaluate(() => ({
    driverId: window.__game.session.player.driver.id,
    teamId: window.__game.session.player.team.id,
    trackId: window.__game.circuit.id,
    mode: window.__game.session.mode,
    stage: window.__game.session.qualifying.stage,
    cars: window.__game.session.entries.length,
    trial: window.__game.session.trial,
  }));
  expect(weekendState).toEqual({
    driverId: 'hacker',
    teamId: 'tacn',
    trackId: 'spa',
    mode: 'practice',
    stage: 'FP1',
    cars: 22,
    trial: false,
  });
  await expect(page.locator('#tw-title')).toContainText('PRACTICE · FP1');
  await expect(page.locator('#t-lap')).toContainText('FP1');
  await captureEvidence(page, testInfo, 'tacn-full-weekend-fp1');
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
      message: `${key} must update window.__game.snapshot().controls.${field}`,
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
  await expect.poll(() => page.evaluate(() => window.__game.effects?.emissionCounts?.rain || 0), {
    message: 'The wet scenario must drive the production rain particle pool, not only HUD labels',
  }).toBeGreaterThan(0);
  const visualWeather = await page.evaluate(() => {
    const game = window.__game;
    const effects = game.effects;
    const road = game.circuit.group.getObjectByName('road');
    const player = game.session.player.phys;
    const sample = game.circuit.samples[player.sampleIdx];
    const along = (player.pos.x - sample.p.x) * sample.t.x + (player.pos.z - sample.p.z) * sample.t.z;
    const roadY = game.circuit.heightAt(player.sampleIdx + along / game.circuit.ds);
    return {
      activeDrops: effects.rainData.filter(drop => drop.life > 0).length,
      emitterRoadDelta: Math.abs(effects.rainEmitterY - roadY),
      reflectionStrength: game.circuit.trackState.visualState.reflectionStrength,
      roadRoughness: road.material.roughness,
      roadEnvironment: road.material.envMapIntensity,
    };
  });
  expect(visualWeather.activeDrops).toBeGreaterThan(0);
  expect(visualWeather.emitterRoadDelta).toBeLessThan(0.01);
  expect(visualWeather.reflectionStrength).toBeGreaterThan(0.3);
  expect(visualWeather.roadRoughness).toBeLessThan(0.8);
  expect(visualWeather.roadEnvironment).toBeGreaterThan(1.3);
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

  const cleared = await page.evaluate(() => window.__game.applyScenario({
    weather: { condition: 'clear' },
    track: { surface: 'dry' },
    raceControl: { state: 'green' },
  }));
  expect(cleared.weather).toMatchObject({ condition: 'clear', intensity: 0, rainfall: 0 });
  expect(cleared.track?.state).toMatchObject({ surface: 'dry', wetness: 0 });
  expect(cleared.raceControl).toMatchObject({ state: 'green' });

  const released = await page.evaluate(() => {
    window.__game.applyScenario({
      weather: { condition: 'dynamic' },
      track: { surface: 'dynamic' },
    });
    const track = window.__game.circuit.trackState;
    return { trackOverride: track.conditionOverride, weatherOverride: track.weather.override };
  });
  expect(released).toEqual({ trackOverride: null, weatherOverride: null });
});

test('pit UI fits a real rain tyre across physics, visuals, telemetry and cockpit', async ({ page }) => {
  const runtimeErrors = monitorRuntime(page);
  await bootPilot(page);

  const choices = page.locator('#pit-overlay .tyre-btn');
  await expect(choices).toHaveCount(5);
  await page.evaluate(() => {
    const session = window.__game.session;
    session._enterPit(session.player);
  });
  await expect(page.locator('#pit-overlay')).toBeVisible();
  await page.locator('#pit-overlay .tyre-btn.I').click();

  const fitted = await page.evaluate(() => {
    const session = window.__game.session;
    const player = session.player;
    if (player.pitState?.chosen !== 'I') throw new Error('pit UI did not select Intermediate');
    player.pitState.phase = 'stopped';
    player.pitState.phaseT = 0;
    session._updatePit(player, 0);
    player.pitState.phaseT = 0;
    session._updatePit(player, 0);
    return {
      physics: player.phys.compound,
      strategy: player.strategyCompound,
      visual: player.carHandle.compound,
      bandColors: player.carHandle.tyreBandMats.map(material => material.color.getHex()),
    };
  });
  expect(fitted).toMatchObject({ physics: 'I', strategy: 'I', visual: 'I' });
  expect(fitted.bandColors.length).toBeGreaterThanOrEqual(2);
  expect(fitted.bandColors.every(color => color === 0x39b54a)).toBe(true);

  const snapshot = await debugSnapshot(page);
  expect(snapshot.player?.physics).toMatchObject({ compound: 'I' });
  expect(snapshot.telemetry).toMatchObject({ compound: 'I' });
  await page.keyboard.press('KeyC');
  await expect(page.locator('#cp-compound')).toHaveText('I');
  expect(runtimeErrors, `Runtime emitted errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});

test('desktop high-quality frame pacing stays inside the acceptance budget', async ({ page }) => {
  await bootPilot(page);
  const result = await page.evaluate(async () => {
    const session = window.__game.session;
    const originalSetTrackConditions = session.setTrackConditions;
    let conditionUpdates = 0;
    session.setTrackConditions = function countedTrackConditions(next) {
      conditionUpdates++;
      return originalSetTrackConditions.call(this, next);
    };
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
    session.setTrackConditions = originalSetTrackConditions;
    return {
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: stable.at(-1),
      over50Ms: stable.filter(value => value > 50).length,
      sampleCount: stable.length,
      conditionUpdates,
      elapsedMs: deltas.reduce((sum, value) => sum + value, 0),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  });
  expect(result.viewport).toMatchObject({ width: 1440, height: 900 });
  expect(result.sampleCount).toBeGreaterThanOrEqual(160);
  expect(result.p95Ms, `p95 frame time ${result.p95Ms.toFixed(2)}ms exceeded 50ms`).toBeLessThanOrEqual(50);
  expect(result.p99Ms, `p99 frame time ${result.p99Ms.toFixed(2)}ms exceeded 100ms`).toBeLessThanOrEqual(100);
  expect(result.over50Ms, `${result.over50Ms} frames exceeded 50ms`).toBeLessThanOrEqual(4);
  expect(result.conditionUpdates,
    `${result.conditionUpdates} condition snapshots were allocated in ${result.elapsedMs.toFixed(0)}ms`).toBeLessThanOrEqual(
    Math.ceil(result.elapsedMs / 250) + 2,
  );
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
