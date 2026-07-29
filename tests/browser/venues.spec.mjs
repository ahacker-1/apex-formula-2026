import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CAPTURE_DIR = process.env.APEX_CAPTURE_DIR
  ? path.resolve(process.env.APEX_CAPTURE_DIR)
  : null;

const VENUES = [
  { trackId: 'melbourne', environment: 'day', seed: 'venue-smoke-melbourne-2026' },
  { trackId: 'bahrain', environment: 'dusk', seed: 'venue-smoke-bahrain-2026' },
  { trackId: 'singapore', environment: 'night', seed: 'venue-smoke-singapore-2026' },
];

// Prior desktop/high measurements spanned 1,358-1,750 calls, 1.48-1.57M
// triangles, and 74-84 textures. These regression ceilings deliberately leave
// generous headroom for browser/GPU variation while still catching a major leak.
const RENDER_CEILINGS = {
  calls: 3_000,
  triangles: 2_750_000,
  textures: 160,
};

function observeErrors(page) {
  const errors = { console: [], page: [], http: [] };

  page.on('console', message => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', error => errors.page.push(String(error)));
  page.on('response', response => {
    if (response.status() >= 400) errors.http.push(`${response.status()} ${response.url()}`);
  });

  return errors;
}

async function configureFreshPage(page) {
  // Chrome probes an undeclared /favicon.ico twice and otherwise emits generic
  // 404 console errors unrelated to the simulator. Keep that browser chrome
  // request out of the app-error signal while leaving every app URL strict.
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_settings', JSON.stringify({
      graphicsQuality: 'high',
      volume: 0,
      quali: false,
    }));
  });
}

async function hdrResourcePaths(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => new URL(entry.name).pathname)
    .filter(resourcePath => /^\/textures\/hdri\/[^/]+\.hdr$/.test(resourcePath)));
}

async function chooseQuickRace(page, trackId) {
  await page.getByRole('button', { name: /QUICK RACE/ }).click();

  const avi = page.locator('.drv[data-d="hacker"]');
  await expect(avi).toHaveAttribute('aria-label', /Avi Hacker/i);
  await avi.click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();

  const track = page.locator(`.track-card[data-t="${trackId}"]`);
  await expect(track).toBeVisible();
  await track.click();

  // Poll on RAF and pause in the same browser callback that first observes the
  // live session, before the test performs any slower cross-process assertions.
  await page.waitForFunction(() => {
    const game = window.__game;
    if (!game?.session || game.state !== 'race') return false;
    if (!game.paused) game.togglePause(true);
    return game.paused;
  }, null, { timeout: 35_000, polling: 'raf' });
}

async function measureRenderer(page) {
  return page.evaluate(() => {
    const { renderer, composer } = window.__game;
    const previousAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    renderer.info.reset();

    try {
      composer.render();
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        textures: renderer.info.memory.textures,
      };
    } finally {
      renderer.info.autoReset = previousAutoReset;
      renderer.info.reset();
    }
  });
}

async function measureScreenshot(page, png) {
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();

    // This canvas is intentionally detached: the metric cannot alter the page
    // being measured or become part of the captured frame.
    const sample = document.createElement('canvas');
    sample.width = 160;
    sample.height = 90;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;

    let min = 255;
    let max = 0;
    let sum = 0;
    let sumSquares = 0;
    let opaque = 0;
    const luminanceBuckets = new Set();

    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
      sum += luminance;
      sumSquares += luminance * luminance;
      if (pixels[i + 3] >= 250) opaque++;
      luminanceBuckets.add(Math.min(15, Math.floor(luminance / 16)));
    }

    const count = pixels.length / 4;
    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    return {
      mean: Number(mean.toFixed(2)),
      standardDeviation: Number(Math.sqrt(variance).toFixed(2)),
      range: Number((max - min).toFixed(2)),
      opaqueRatio: Number((opaque / count).toFixed(4)),
      luminanceBuckets: luminanceBuckets.size,
    };
  }, dataUrl);
}

for (const venue of VENUES) {
  test(`${venue.trackId} uses one ${venue.environment} HDR and stays within the visual budget`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = observeErrors(page);
    await configureFreshPage(page);
    await page.goto(`/?seed=${encodeURIComponent(venue.seed)}`);

    await expect(page.getByRole('button', { name: /QUICK RACE/ })).toBeVisible();
    expect(await hdrResourcePaths(page), 'HDR must remain lazy at the main menu').toEqual([]);

    await chooseQuickRace(page, venue.trackId);
    const expectedHdr = `/textures/hdri/${venue.environment}.hdr`;
    await page.waitForFunction(expected => {
      const paths = performance.getEntriesByType('resource')
        .map(entry => new URL(entry.name).pathname)
        .filter(resourcePath => /^\/textures\/hdri\/[^/]+\.hdr$/.test(resourcePath));
      return window.__game?._envIsHDRI === true && paths.includes(expected);
    }, expectedHdr, { timeout: 35_000, polling: 50 });

    const hdrPaths = await hdrResourcePaths(page);
    expect(hdrPaths, 'the fresh page must fetch exactly its selected HDR').toEqual([expectedHdr]);

    const state = await page.evaluate(() => {
      const game = window.__game;
      return {
        paused: game.paused,
        state: game.state,
        sessionMode: game.session.mode,
        driverId: game.session.player.driver.id,
        trackId: game.raceConfig.race.trackId,
        querySeed: new URLSearchParams(location.search).get('seed'),
        sessionSeed: game.sessionSeed,
        graphicsQuality: game.ui.settings.graphicsQuality,
        appliedQuality: game.quality.appliedTier,
        volume: game.ui.settings.volume,
        onboardingSeen: localStorage.getItem('apexf1_onboarding_v1'),
        environmentReady: game._envIsHDRI === true && !!game.scene.environment,
        backgroundIsEnvironment: game.scene.background === game.scene.environment,
        backgroundIsNull: game.scene.background === null,
        skyVisible: game.sky?.visible === true,
        themeIsNight: game.circuit.theme.night === true,
        themeSunIntensity: game.circuit.theme.sunI,
      };
    });

    expect(state).toMatchObject({
      paused: true,
      state: 'race',
      sessionMode: 'race',
      driverId: 'hacker',
      trackId: venue.trackId,
      querySeed: venue.seed,
      graphicsQuality: 'high',
      appliedQuality: 'high',
      volume: 0,
      onboardingSeen: '1',
      environmentReady: true,
    });
    expect(Number.isInteger(state.sessionSeed)).toBe(true);

    if (venue.environment === 'night') {
      expect(state.themeIsNight).toBe(true);
      expect(state.backgroundIsEnvironment, 'night uses the photographic HDR as the visible sky').toBe(true);
      expect(state.skyVisible, 'night hides the procedural sky dome').toBe(false);
    } else {
      expect(state.themeIsNight).toBe(false);
      expect(state.backgroundIsNull, `${venue.environment} leaves the HDR lighting-only`).toBe(true);
      expect(state.skyVisible, `${venue.environment} keeps the procedural sky visible`).toBe(true);
      if (venue.environment === 'dusk') expect(state.themeSunIntensity).toBeLessThan(2.2);
      else expect(state.themeSunIntensity).toBeGreaterThanOrEqual(2.2);
    }

    // Keep the simulation paused but remove the pause dialog so the stable
    // racing frame and live HUD, rather than a translucent menu, are inspected.
    await page.evaluate(() => window.__game.ui.hidePause());
    await expect(page.locator('#app canvas')).toBeVisible();
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#hud')).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => window.__game.paused)).toBe(true);

    const renderer = await measureRenderer(page);
    expect(renderer.calls).toBeGreaterThan(0);
    expect(renderer.triangles).toBeGreaterThan(0);
    expect(renderer.textures).toBeGreaterThan(0);
    expect(renderer.calls).toBeLessThanOrEqual(RENDER_CEILINGS.calls);
    expect(renderer.triangles).toBeLessThanOrEqual(RENDER_CEILINGS.triangles);
    expect(renderer.textures).toBeLessThanOrEqual(RENDER_CEILINGS.textures);

    const screenshot = await page.screenshot({ animations: 'disabled' });
    const screenshotMetrics = await measureScreenshot(page, screenshot);
    expect(screenshotMetrics.opaqueRatio).toBeGreaterThan(0.99);
    expect(screenshotMetrics.range).toBeGreaterThan(40);
    expect(screenshotMetrics.standardDeviation).toBeGreaterThan(8);
    expect(screenshotMetrics.luminanceBuckets).toBeGreaterThan(4);

    if (CAPTURE_DIR) {
      await mkdir(CAPTURE_DIR, { recursive: true });
      await writeFile(path.join(CAPTURE_DIR, `${venue.trackId}-${venue.environment}.png`), screenshot);
    }

    const metrics = {
      venue: venue.trackId,
      environment: venue.environment,
      seed: venue.seed,
      hdr: hdrPaths,
      renderer,
      screenshot: screenshotMetrics,
    };
    console.log(`[venue-smoke] ${JSON.stringify(metrics)}`);

    expect(errors.console, 'console errors').toEqual([]);
    expect(errors.page, 'uncaught page errors').toEqual([]);
    expect(errors.http, 'HTTP error responses').toEqual([]);
  });
}
