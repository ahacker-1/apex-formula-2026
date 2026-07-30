import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Opt-in only: a visual run writes reproducible review artifacts under the
// already-ignored test-results/ tree, never into the distributable build.
const CAPTURE_DIR = process.env.APEX_VISUAL_EVIDENCE_DIR || process.env.APEX_CAPTURE_DIR
  ? path.resolve(process.env.APEX_VISUAL_EVIDENCE_DIR || process.env.APEX_CAPTURE_DIR)
  : null;

const VISUAL_EVIDENCE_SCHEMA = 'apex-formula.visual-evidence/v1';
const FIXED_VIEWPORT = { width: 1600, height: 900 };
const FIXED_DPR = 1;
const evidenceRecords = [];

// Visual review must not inherit a developer's current browser size, display
// scale, colour preference, or motion preference from playwright.config.mjs.
test.use({
  viewport: FIXED_VIEWPORT,
  deviceScaleFactor: FIXED_DPR,
  colorScheme: 'dark',
  reducedMotion: 'reduce',
});

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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pngDimensions(png) {
  // PNG IHDR stores width/height as two unsigned big-endian 32-bit integers.
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

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

async function lockCaptureFrame(page) {
  return page.evaluate(() => {
    const game = window.__game;
    // The seeded session is paused before this point. Snap the standard chase
    // camera once so its smoothing state cannot depend on scheduling between
    // the session constructor and our first screenshot.
    game.camMode = 0;
    game.snapCamera();
    game.camera.lookAt(game._camLook);
    game.camera.updateProjectionMatrix();
    game.composer.render();

    const player = game.session.player.phys;
    const projected = player.pos.clone().project(game.camera);
    const canvas = game.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    return {
      camera: {
        mode: game.camMode,
        position: game.camera.position.toArray().map(value => Number(value.toFixed(4))),
        quaternion: game.camera.quaternion.toArray().map(value => Number(value.toFixed(6))),
        fov: Number(game.camera.fov.toFixed(4)),
      },
      playerFrame: {
        normalizedX: Number(((projected.x + 1) / 2).toFixed(4)),
        normalizedY: Number(((-projected.y + 1) / 2).toFixed(4)),
        clipZ: Number(projected.z.toFixed(4)),
      },
      canvas: {
        cssWidth: Number(rect.width.toFixed(2)),
        cssHeight: Number(rect.height.toFixed(2)),
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
      },
      devicePixelRatio: window.devicePixelRatio,
    };
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

async function measureScreenshotDelta(page, first, second) {
  const toDataUrl = png => `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(async ([firstSource, secondSource]) => {
    const load = async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return image;
    };
    const [first, second] = await Promise.all([load(firstSource), load(secondSource)]);
    const sample = document.createElement('canvas');
    sample.width = 160;
    sample.height = 90;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(first, 0, 0, sample.width, sample.height);
    const a = context.getImageData(0, 0, sample.width, sample.height).data;
    context.clearRect(0, 0, sample.width, sample.height);
    context.drawImage(second, 0, 0, sample.width, sample.height);
    const b = context.getImageData(0, 0, sample.width, sample.height).data;

    let total = 0;
    let max = 0;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      const difference = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      total += difference / 3;
      max = Math.max(max, difference / 3);
      if (difference / 3 > 2) changed++;
    }
    const count = a.length / 4;
    return {
      sampleSize: `${sample.width}x${sample.height}`,
      meanAbsoluteDifference: Number((total / count).toFixed(4)),
      maxChannelDifference: Number(max.toFixed(4)),
      changedPixelRatio: Number((changed / count).toFixed(5)),
    };
  }, [toDataUrl(first), toDataUrl(second)]);
}

async function persistEvidence(venue, screenshot, repeatScreenshot, record) {
  if (!CAPTURE_DIR) return;
  await mkdir(CAPTURE_DIR, { recursive: true });
  const stem = `${venue.trackId}-${venue.environment}`;
  const primary = `${stem}.png`;
  const repeat = `${stem}-repeat.png`;
  const metrics = `${stem}.metrics.json`;
  await Promise.all([
    writeFile(path.join(CAPTURE_DIR, primary), screenshot),
    writeFile(path.join(CAPTURE_DIR, repeat), repeatScreenshot),
    writeFile(path.join(CAPTURE_DIR, metrics), `${JSON.stringify(record, null, 2)}\n`),
  ]);
  evidenceRecords.push({
    venue: venue.trackId,
    environment: venue.environment,
    files: { primary, repeat, metrics },
    sha256: { primary: sha256(screenshot), repeat: sha256(repeatScreenshot) },
    metrics: record,
  });
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
        toneMappingExposure: game.renderer.toneMappingExposure,
        bloomStrength: game.bloom.strength,
        bloomRadius: game.bloom.radius,
        bloomThreshold: game.bloom.threshold,
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
      expect(state.toneMappingExposure, 'night uses a dedicated restrained exposure').toBeCloseTo(0.92, 6);
      expect(state.bloomStrength, 'night bloom strength stays restrained').toBeCloseTo(0.22, 6);
      expect(state.bloomRadius, 'night bloom stays tight around fixture cores').toBeCloseTo(0.36, 6);
      expect(state.bloomThreshold, 'night bloom excludes road paint and bodywork').toBeCloseTo(0.92, 6);
    } else {
      expect(state.themeIsNight).toBe(false);
      expect(state.backgroundIsNull, `${venue.environment} leaves the HDR lighting-only`).toBe(true);
      expect(state.skyVisible, `${venue.environment} keeps the procedural sky visible`).toBe(true);
      expect(state.toneMappingExposure, `${venue.environment} keeps the established exposure`).toBeCloseTo(1.05, 6);
      expect(state.bloomStrength, `${venue.environment} keeps the established bloom strength`).toBeCloseTo(0.18, 6);
      expect(state.bloomRadius, `${venue.environment} keeps the established bloom radius`).toBeCloseTo(0.55, 6);
      expect(state.bloomThreshold, `${venue.environment} keeps the established bloom threshold`).toBeCloseTo(0.86, 6);
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

    const frame = await lockCaptureFrame(page);
    expect(frame.devicePixelRatio).toBe(FIXED_DPR);
    expect(frame.camera.mode).toBe(0);
    expect(frame.camera.fov).toBeGreaterThan(50);
    expect(frame.camera.fov).toBeLessThan(90);
    expect(frame.playerFrame.normalizedX).toBeGreaterThan(0.15);
    expect(frame.playerFrame.normalizedX).toBeLessThan(0.85);
    expect(frame.playerFrame.normalizedY).toBeGreaterThan(0.2);
    expect(frame.playerFrame.normalizedY).toBeLessThan(0.95);
    expect(frame.playerFrame.clipZ).toBeGreaterThan(-1);
    expect(frame.playerFrame.clipZ).toBeLessThan(1);
    expect(frame.canvas.cssWidth).toBe(FIXED_VIEWPORT.width);
    expect(frame.canvas.cssHeight).toBe(FIXED_VIEWPORT.height);
    expect(frame.canvas.bufferWidth).toBe(FIXED_VIEWPORT.width * FIXED_DPR);
    expect(frame.canvas.bufferHeight).toBe(FIXED_VIEWPORT.height * FIXED_DPR);

    const renderer = await measureRenderer(page);
    expect(renderer.calls).toBeGreaterThan(0);
    expect(renderer.triangles).toBeGreaterThan(0);
    expect(renderer.textures).toBeGreaterThan(0);
    expect(renderer.calls).toBeLessThanOrEqual(RENDER_CEILINGS.calls);
    expect(renderer.triangles).toBeLessThanOrEqual(RENDER_CEILINGS.triangles);
    expect(renderer.textures).toBeLessThanOrEqual(RENDER_CEILINGS.textures);

    const screenshot = await page.screenshot({ animations: 'disabled' });
    const repeatScreenshot = await page.screenshot({ animations: 'disabled' });
    const screenshotDimensions = pngDimensions(screenshot);
    expect(screenshotDimensions).toEqual(FIXED_VIEWPORT);
    const screenshotMetrics = await measureScreenshot(page, screenshot);
    const repeatStability = await measureScreenshotDelta(page, screenshot, repeatScreenshot);
    expect(screenshotMetrics.opaqueRatio).toBeGreaterThan(0.99);
    expect(screenshotMetrics.range).toBeGreaterThan(40);
    expect(screenshotMetrics.standardDeviation).toBeGreaterThan(8);
    expect(screenshotMetrics.luminanceBuckets).toBeGreaterThan(4);
    // The same frozen frame must retain its composition. This intentionally
    // permits tiny GPU rasterisation variation rather than byte-for-byte PNG
    // equality, which would make evidence flaky across supported hardware.
    expect(repeatStability.meanAbsoluteDifference).toBeLessThanOrEqual(1.5);
    expect(repeatStability.changedPixelRatio).toBeLessThanOrEqual(0.02);

    const metrics = {
      schema: VISUAL_EVIDENCE_SCHEMA,
      venue: venue.trackId,
      environment: venue.environment,
      seed: venue.seed,
      capture: {
        viewport: FIXED_VIEWPORT,
        deviceScaleFactor: FIXED_DPR,
        graphicsQuality: state.appliedQuality,
        paused: state.paused,
        frame,
        screenshotDimensions,
      },
      hdr: hdrPaths,
      renderer,
      screenshot: screenshotMetrics,
      repeatStability,
    };
    await persistEvidence(venue, screenshot, repeatScreenshot, metrics);
    console.log(`[venue-smoke] ${JSON.stringify(metrics)}`);

    if (venue.environment === 'night') {
      const recovery = await page.evaluate(() => {
        const game = window.__game;
        game.renderer.toneMappingExposure = 0.01;
        game.renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
        const restoredExposure = game.renderer.toneMappingExposure;
        game.teardownSession();
        return {
          restoredExposure,
          teardownExposure: game.renderer.toneMappingExposure,
        };
      });
      expect(recovery.restoredExposure, 'WebGL recovery reapplies the active night exposure').toBeCloseTo(0.92, 6);
      expect(recovery.teardownExposure, 'night exposure cannot leak into the menu or next venue').toBeCloseTo(1.05, 6);
    }

    expect(errors.console, 'console errors').toEqual([]);
    expect(errors.page, 'uncaught page errors').toEqual([]);
    expect(errors.http, 'HTTP error responses').toEqual([]);
  });
}

test.afterAll(async () => {
  if (!CAPTURE_DIR || evidenceRecords.length === 0) return;
  const manifest = {
    schema: VISUAL_EVIDENCE_SCHEMA,
    generatedBy: 'tests/browser/venues.spec.mjs',
    outputDirectory: CAPTURE_DIR,
    captureContract: {
      viewport: FIXED_VIEWPORT,
      deviceScaleFactor: FIXED_DPR,
      graphicsQuality: 'high',
      state: 'seeded quick race paused on the first live session frame',
      repeatTolerance: {
        sampleSize: '160x90',
        meanAbsoluteDifferenceMax: 1.5,
        changedPixelRatioMax: 0.02,
      },
    },
    records: evidenceRecords,
  };
  await writeFile(path.join(CAPTURE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
});
