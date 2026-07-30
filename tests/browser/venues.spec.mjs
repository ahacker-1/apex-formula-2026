import { test, expect } from '@playwright/test';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// Opt-in only: a visual run writes reproducible review artifacts under the
// already-ignored test-results/ tree, never into the distributable build.
const captureRootOption = process.env.APEX_VISUAL_EVIDENCE_DIR || process.env.APEX_CAPTURE_DIR;
const CAPTURE_ROOT = captureRootOption
  ? path.resolve(captureRootOption)
  : null;
const EVIDENCE_RUN_ID = `run-${process.pid}-${randomUUID()}`;
const CAPTURE_DIR = CAPTURE_ROOT ? path.join(CAPTURE_ROOT, 'runs', EVIDENCE_RUN_ID) : null;

const VISUAL_EVIDENCE_SCHEMA = 'apex-formula.visual-evidence/v1';
const FIXED_VIEWPORT = { width: 1600, height: 900 };
const FIXED_DPR = 1;
const FRESH_CAPTURE_RUNS = 3;
const SAME_PAGE_TOLERANCE = { meanAbsoluteDifferenceMax: 1.5, changedPixelRatioMax: 0.02, changedPixelThreshold: 2 };
const CROSS_RUN_TOLERANCE = { meanAbsoluteDifferenceMax: 1.5, changedPixelRatioMax: 0.02, changedPixelThreshold: 8 };
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
const EXPECTED_VENUES = VENUES.map(({ trackId, environment }) => ({ venue: trackId, environment }));

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
    const session = game.session;
    const circuit = game.circuit;

    // Rebuild the visible grid from canonical circuit slots. The browser may
    // have simulated an arbitrary number of fixed ticks before Playwright saw
    // the new session; no captured transform or HUD field may retain that race.
    if (!game.paused) game.togglePause(true);
    game.resetSimulationTiming();
    session.phase = 'grid';
    session.phaseT = 0;
    session.raceTime = 0;
    session.lightsOn = 0;
    session.lightsHold = 0;
    session.lightsOut = false;
    session.jumpStart = false;
    session.vsc = { active: false, timeLeft: 0 };
    session.blueFlagFor = null;
    session.radioQueue.length = 0;

    const gridPose = session.entries.map((entry, index) => {
      const gridIndex = Math.max(0, (entry.gridPos || index + 1) - 1);
      const slot = circuit.gridSlots[gridIndex];
      const phys = entry.phys;
      phys.placeAt(slot.pos, slot.heading, slot.idx);
      Object.assign(phys, {
        v: 0,
        gear: 1,
        rpmFrac: 0.2,
        steer: 0,
        throttle: 0,
        brake: 0,
        battery: 1,
        boosting: false,
        aeroX: false,
        wear: 0,
        fuel: 1,
        lat: 0,
        offTrack: false,
        onKerb: false,
        slip: false,
        wallHit: 0,
        slipstream: 0,
        dirtyAir: 0,
        disabled: false,
        pitch: 0,
        roll: 0,
        rideBump: 0,
      });
      entry.wheelSpin = 0;
      entry.lap = -1;
      entry.position = entry.gridPos;
      entry.gapText = '';
      entry.intervalText = '';
      entry.pitState = null;
      entry.finished = false;
      entry.dnf = false;
      entry.mesh.visible = true;
      if (entry.tag) entry.tag.visible = false;
      return {
        driverId: entry.driver.id,
        gridIndex,
        sampleIdx: slot.idx,
        position: slot.pos.toArray().map(value => Number(value.toFixed(6))),
        heading: Number(slot.heading.toFixed(8)),
      };
    });
    session.resetRenderState();
    session.render(1);

    // Rebuild the HUD from the frozen state and remove transient notifications.
    game.hud.bindSession(session, circuit);
    game.hud.show();
    game.hud.update(0);
    document.querySelector('#race-msg')?.replaceChildren();
    document.querySelector('#startlights')?.classList.remove('active');
    game.circuit.setStartLights?.(0);
    game.ui.hidePause();

    // Explicit fixed camera contract. Game.snapCamera() writes the smoothing
    // targets, not the Three camera itself, so copy both position and look-at.
    game.camMode = 0;
    game.snapCamera();
    game.camera.position.copy(game._camPos);
    game.camera.fov = 72;
    game.camera.lookAt(game._camLook);
    game.camera.updateProjectionMatrix();

    const player = session.player.phys;
    const roadY = game._roadY(player);
    if (game.sun) {
      game.sun.position.set(player.pos.x + 260, roadY + 380, player.pos.z + 160);
      game.sun.target.position.set(player.pos.x, roadY, player.pos.z);
      game.sun.target.updateMatrixWorld(true);
    }
    game.scene.updateMatrixWorld(true);
    game.camera.updateMatrixWorld(true);
    game.composer.render(0);

    const projected = player.pos.clone().project(game.camera);
    const canvas = game.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const telemetry = game.renderTelemetry;
    return {
      contract: 'canonical-grid/chase-camera-v1',
      servedOrigin: location.origin,
      sessionSeed: game.sessionSeed,
      phase: session.phase,
      gridPose,
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
      pipeline: {
        quality: telemetry.quality,
        targets: telemetry.targets,
        passes: telemetry.passes,
      },
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

async function measureScreenshotDelta(page, first, second, changedPixelThreshold = 2) {
  const toDataUrl = png => `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(async ([firstSource, secondSource, threshold]) => {
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
      if (difference / 3 > threshold) changed++;
    }
    const count = a.length / 4;
    return {
      sampleSize: `${sample.width}x${sample.height}`,
      changedPixelThreshold: threshold,
      meanAbsoluteDifference: Number((total / count).toFixed(4)),
      maxChannelDifference: Number(max.toFixed(4)),
      changedPixelRatio: Number((changed / count).toFixed(5)),
    };
  }, [toDataUrl(first), toDataUrl(second), changedPixelThreshold]);
}

function manifestIntegrity(records) {
  const keyOf = record => `${record.venue}/${record.environment}`;
  const expected = EXPECTED_VENUES.map(keyOf);
  const expectedSet = new Set(expected);
  const counts = new Map();
  for (const record of records) counts.set(keyOf(record), (counts.get(keyOf(record)) || 0) + 1);
  const missing = expected.filter(key => !counts.has(key));
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
  const unexpected = [...counts.keys()].filter(key => !expectedSet.has(key));
  const failed = records.filter(record => record.pass !== true).map(keyOf);
  const complete = missing.length === 0 && duplicate.length === 0 && unexpected.length === 0
    && records.length === expected.length;
  return { complete, pass: complete && failed.length === 0, missing, duplicate, unexpected, failed };
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${EVIDENCE_RUN_ID}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

async function captureVenueRun(page, venue, runNumber) {
  const errors = observeErrors(page);
  await configureFreshPage(page);
  await page.goto(`/?seed=${encodeURIComponent(venue.seed)}`);
  await expect(page).toHaveTitle(/APEX FORMULA 2026/);
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

  await expect(page.locator('#app canvas')).toBeVisible();
  await expect(page.locator('#hud')).toBeVisible();
  await expect(page.locator('#hud')).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.__game.paused)).toBe(true);

  const frame = await lockCaptureFrame(page);
  frame.gridPoseSha256 = sha256(Buffer.from(JSON.stringify(frame.gridPose)));
  delete frame.gridPose;
  expect(frame.contract).toBe('canonical-grid/chase-camera-v1');
  expect(frame.phase).toBe('grid');
  expect(frame.devicePixelRatio).toBe(FIXED_DPR);
  expect(frame.camera.mode).toBe(0);
  expect(frame.camera.fov).toBe(72);
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
  expect(frame.pipeline.quality).toMatchObject({ tier: 'high', pixelRatio: 1, composerPixelRatio: 1 });
  expect(frame.pipeline.targets).toMatchObject({
    drawingBuffer: FIXED_VIEWPORT,
    composer: FIXED_VIEWPORT,
    gtao: { width: 800, height: 450, scale: 0.5 },
  });
  expect(frame.pipeline.passes).toMatchObject({ gtao: true, bloom: true, fxaa: true });
  expect(frame.pipeline.passes.fxaaResolution.x).toBeCloseTo(1 / FIXED_VIEWPORT.width, 10);
  expect(frame.pipeline.passes.fxaaResolution.y).toBeCloseTo(1 / FIXED_VIEWPORT.height, 10);

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
  expect(repeatStability.meanAbsoluteDifference).toBeLessThanOrEqual(SAME_PAGE_TOLERANCE.meanAbsoluteDifferenceMax);
  expect(repeatStability.changedPixelRatio).toBeLessThanOrEqual(SAME_PAGE_TOLERANCE.changedPixelRatioMax);

  // A run becomes evidence only after every app-error assertion has passed.
  expect(errors.console, 'console errors').toEqual([]);
  expect(errors.page, 'uncaught page errors').toEqual([]);
  expect(errors.http, 'HTTP error responses').toEqual([]);

  const metrics = {
    run: runNumber,
    servedOrigin: frame.servedOrigin,
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
  return { screenshot, repeatScreenshot, metrics };
}

async function persistVenueEvidence(venue, runs) {
  if (!CAPTURE_DIR) return;
  await mkdir(CAPTURE_DIR, { recursive: true });
  const stem = `${venue.trackId}-${venue.environment}`;
  const runFiles = [];
  const writes = [];
  for (const capture of runs) {
    const run = capture.metrics.run;
    const primary = `${stem}-run-${run}.png`;
    const repeat = `${stem}-run-${run}-repeat.png`;
    writes.push(
      writeFile(path.join(CAPTURE_DIR, primary), capture.screenshot),
      writeFile(path.join(CAPTURE_DIR, repeat), capture.repeatScreenshot),
    );
    runFiles.push({
      run,
      primary: path.posix.join('runs', EVIDENCE_RUN_ID, primary),
      repeat: path.posix.join('runs', EVIDENCE_RUN_ID, repeat),
      sha256: {
        primary: sha256(capture.screenshot),
        repeat: sha256(capture.repeatScreenshot),
      },
    });
  }
  const metricsName = `${stem}.metrics.json`;
  const metrics = {
    schema: VISUAL_EVIDENCE_SCHEMA,
    venue: venue.trackId,
    environment: venue.environment,
    seed: venue.seed,
    pass: true,
    runs: runs.map(capture => capture.metrics),
  };
  writes.push(writeFile(path.join(CAPTURE_DIR, metricsName), `${JSON.stringify(metrics, null, 2)}\n`));
  await Promise.all(writes);
  evidenceRecords.push({
    venue: venue.trackId,
    environment: venue.environment,
    seed: venue.seed,
    pass: true,
    servedOrigins: [...new Set(runs.map(capture => capture.metrics.servedOrigin))],
    metrics: path.posix.join('runs', EVIDENCE_RUN_ID, metricsName),
    runs: runFiles,
  });
}

test.beforeAll(async () => {
  if (!CAPTURE_ROOT) return;
  await mkdir(CAPTURE_ROOT, { recursive: true });
  await unlink(path.join(CAPTURE_ROOT, 'manifest.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
});

test('manifest integrity fails closed for incomplete and duplicate venue records', () => {
  const complete = EXPECTED_VENUES.map(record => ({ ...record, pass: true }));
  expect(manifestIntegrity(complete)).toMatchObject({ complete: true, pass: true });
  expect(manifestIntegrity(complete.slice(0, -1))).toMatchObject({ complete: false, pass: false });
  expect(manifestIntegrity([...complete, complete[0]])).toMatchObject({ complete: false, pass: false });
});

for (const venue of VENUES) {
  test(`${venue.trackId} uses one ${venue.environment} HDR and is stable across fresh sessions`, async ({ page, context }) => {
    test.setTimeout(180_000);
    const captures = [];
    let baseline = null;
    for (let index = 0; index < FRESH_CAPTURE_RUNS; index++) {
      const runPage = index === 0 ? page : await context.newPage();
      try {
        const capture = await captureVenueRun(runPage, venue, index + 1);
        const crossRun = baseline
          ? await measureScreenshotDelta(runPage, baseline.screenshot, capture.screenshot,
            CROSS_RUN_TOLERANCE.changedPixelThreshold)
          : { sampleSize: '160x90', changedPixelThreshold: CROSS_RUN_TOLERANCE.changedPixelThreshold,
            meanAbsoluteDifference: 0, maxChannelDifference: 0, changedPixelRatio: 0 };
        capture.metrics.crossRunFromRun1 = crossRun;
        if (baseline) {
          expect(capture.metrics.capture.frame.camera).toEqual(baseline.metrics.capture.frame.camera);
          expect(capture.metrics.capture.frame.gridPoseSha256).toBe(baseline.metrics.capture.frame.gridPoseSha256);
          expect(capture.metrics.capture.frame.sessionSeed).toBe(baseline.metrics.capture.frame.sessionSeed);
          expect(crossRun.meanAbsoluteDifference).toBeLessThanOrEqual(CROSS_RUN_TOLERANCE.meanAbsoluteDifferenceMax);
          expect(crossRun.changedPixelRatio).toBeLessThanOrEqual(CROSS_RUN_TOLERANCE.changedPixelRatioMax);
        } else {
          baseline = capture;
        }
        captures.push(capture);
      } finally {
        if (index > 0) await runPage.close();
      }
    }
    await persistVenueEvidence(venue, captures);

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

    console.log(`[venue-evidence] ${JSON.stringify({
      venue: venue.trackId,
      environment: venue.environment,
      cameras: captures.map(capture => capture.metrics.capture.frame.camera),
      crossRun: captures.map(capture => capture.metrics.crossRunFromRun1),
    })}`);
  });
}

test('captured evidence contains every expected venue exactly once', () => {
  test.skip(!CAPTURE_ROOT, 'artifact completeness applies only to an evidence run');
  expect(manifestIntegrity(evidenceRecords), 'visual evidence must be complete and unique')
    .toMatchObject({ complete: true, pass: true });
});

test.afterAll(async () => {
  if (!CAPTURE_ROOT) return;
  const integrity = manifestIntegrity(evidenceRecords);
  const manifest = {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    generatedBy: 'tests/browser/venues.spec.mjs',
    outputDirectory: CAPTURE_DIR,
    pass: integrity.pass,
    complete: integrity.complete,
    expectedVenues: EXPECTED_VENUES,
    integrity,
    servedOrigins: [...new Set(evidenceRecords.flatMap(record => record.servedOrigins))],
    captureContract: {
      viewport: FIXED_VIEWPORT,
      deviceScaleFactor: FIXED_DPR,
      graphicsQuality: 'high',
      freshRunsPerVenue: FRESH_CAPTURE_RUNS,
      state: 'canonical grid slots, reset render state, fixed chase camera at fov 72',
      server: 'dedicated per-process/env port; reuseExistingServer=false; build runs before server',
      samePageRepeatTolerance: {
        sampleSize: '160x90',
        ...SAME_PAGE_TOLERANCE,
      },
      crossRunTolerance: {
        sampleSize: '160x90',
        ...CROSS_RUN_TOLERANCE,
      },
    },
    records: evidenceRecords,
  };
  await mkdir(CAPTURE_DIR, { recursive: true });
  await atomicWriteJson(path.join(CAPTURE_DIR, 'manifest.json'), manifest);
  await atomicWriteJson(path.join(CAPTURE_ROOT, 'manifest.json'), manifest);
});
