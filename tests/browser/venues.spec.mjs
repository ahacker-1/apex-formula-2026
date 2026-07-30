import { test, expect } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VISUAL_EVIDENCE_SCHEMA,
  acquireRunOwnership,
  atomicWriteJson,
  ensureEvidenceRoot,
  finalizeRunOwnership,
  manifestIntegrity,
  publishLatestPointer,
  releaseRunOwnership,
  resolveEvidenceRoot,
  summarizeRgbDelta,
} from './visual-evidence/support.mjs';

// Opt-in only: a visual run writes reproducible review artifacts under the
// already-ignored test-results/ tree, never into the distributable build.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CAPTURE_ROOT = resolveEvidenceRoot({
  configured: process.env.APEX_VISUAL_EVIDENCE_DIR,
  legacy: process.env.APEX_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const EVIDENCE_RUN_ID = `run-${process.pid}-${randomUUID()}`;
const CAPTURE_DIR = CAPTURE_ROOT ? path.join(CAPTURE_ROOT, 'runs', EVIDENCE_RUN_ID) : null;

const FIXED_VIEWPORT = { width: 1600, height: 900 };
const FIXED_DPR = 1;
const PRE_FREEZE_TICKS = [0, 600, 1_800];
const FRESH_CAPTURE_RUNS = PRE_FREEZE_TICKS.length;
const SAME_PAGE_TOLERANCE = { meanAbsoluteChannelDifferenceMax: 1.5, changedPixelRatioMax: 0.02, changedPixelChannelThreshold: 2 };
// Fresh GPU contexts retain the established eight-level rasterisation budget;
// the renderer fix removes stochastic GTAO input instead of widening it.
const CROSS_RUN_TOLERANCE = { meanAbsoluteChannelDifferenceMax: 1.5, changedPixelRatioMax: 0.02, changedPixelChannelThreshold: 8 };
const evidenceRecords = [];
const testFailures = [];
let runOwner = null;

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

async function advanceCaptureHistory(page, ticks) {
  return page.evaluate(tickCount => {
    const game = window.__game;
    const session = game.session;
    const effects = game.effects;
    if (!(tickCount > 0)) return { ticks: 0, raceTime: session.raceTime, contaminated: false };

    session.phase = 'racing';
    session.phaseT = 0;
    for (let tick = 0; tick < tickCount; tick++) {
      const input = {
        steer: Math.sin(tick / 90) * 0.45,
        throttle: tick % 240 < 190 ? 1 : 0.2,
        brake: tick % 240 >= 190 ? 0.85 : 0,
        boost: tick % 360 > 280,
        shiftUp: false,
        shiftDown: false,
        ersMode: 1,
      };
      session.update(1 / 60, input);
      effects?.update(1 / 60, session.entries);
      if (tick % 10 === 0) game.hud.update(1 / 6);
    }

    const player = session.player.phys;
    effects?._emitSpark(player.pos.x, 1, player.pos.z, player.heading, 30, 0);
    effects?._emitSmoke(player.pos.x, 1, player.pos.z);
    const left = { x: Math.cos(player.heading), z: -Math.sin(player.heading) };
    effects?._skidSegment(player.pos, player.pos, left, 0);
    effects?._skidSegment({ x: player.pos.x + 1, z: player.pos.z + 1 },
      { x: player.pos.x - 1, z: player.pos.z - 1 }, left, 0);
    session.vsc = { active: true, timeLeft: 12 };
    session.fastestLap = { driverId: session.player.driver.id, time: 72.345 };
    game.hud._hideRadio();
    session.radioQueue.length = 0;
    session.radioQueue.push({ text: 'CONTAMINATION RADIO', tone: 'warning' });
    session._playerPitOpen = true;
    game.hud.message('CONTAMINATION MESSAGE', 'yellow');
    game.hud.setLights(4);
    game.hud.flash('CONTAMINATION FLASH', 60_000);
    game.hud.update(0.1);

    return {
      ticks: tickCount,
      raceTime: session.raceTime,
      playerSpeed: player.v,
      activeSparks: effects?.sparkData.filter(item => item.life > 0).length || 0,
      activeSmoke: effects?.smoke.filter(item => item.life > 0 || item.sprite.visible).length || 0,
      skidCursor: effects?._skidCursor || 0,
      transientHud: {
        vsc: document.querySelector('#vscbanner')?.className || '',
        fastest: document.querySelector('#flbanner')?.className || '',
        radio: document.querySelector('#radiocard')?.className || '',
        lights: document.querySelector('#startlights')?.className || '',
        flash: document.querySelector('#bigflash')?.style.display || '',
      },
      contaminated: true,
    };
  }, ticks);
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
    Object.assign(session, {
      phase: 'grid',
      phaseT: 0,
      raceTime: 0,
      lightsOn: 0,
      lightsHold: 0,
      lightsOut: false,
      jumpStart: false,
      fastestLap: null,
      results: null,
      vsc: { active: false, timeLeft: 0 },
      blueFlagFor: null,
      _posTimer: 0,
      _radioCool: 0,
      _vscEnding: false,
      _vscViol: 0,
      _vscPenalised: false,
      _vscWarned: false,
      _lightEvent: false,
      _wallEvent: 0,
      _touchEvent: 0,
      _shiftEvent: false,
      _playerPitOpen: false,
      _finishGrace: 4,
      _gapCheck: 0,
      _lastPlayerPos: null,
      _radioLastLap: false,
      _radioTyreStint: null,
      _radioResult: false,
      _lastAnnounced: 0,
      _onceKeys: {},
    });
    session.radioQueue.length = 0;
    game._lightsShown = 0;
    game._resultsShown = false;
    game._qualiDoneShown = false;
    game._vscAudio = false;
    game._radioLen = 0;
    game._pitAudio = false;
    game._timeTrialStatus = null;

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
        _xTimer: 0,
        _shiftCooldown: 0,
        _spinJitter: 0,
        wear: 0,
        fuel: 1,
        tyreTemp: 65,
        tyreGrip: 1,
        brakeTemp: 90,
        brakeFade: 0,
        ersMode: 1,
        ersDeploy: 0,
        lat: 0,
        offTrack: false,
        onKerb: false,
        slip: false,
        wallHit: 0,
        slipstream: 0,
        dirtyAir: 0,
        frontAeroLoss: 0,
        disabled: false,
        pitch: 0,
        roll: 0,
        rideBump: 0,
        _bumpT: 0,
        offTrackTime: 0,
        offTrackSink: 0,
        kerbScrub: 0,
      });
      entry.wheelSpin = 0;
      entry.lap = -1;
      entry.lapStart = 0;
      entry.lastLap = 0;
      entry.bestLap = 0;
      entry.lapTimes = [];
      entry.position = entry.gridPos;
      entry.gapText = '';
      entry.intervalText = '';
      entry.pitStops = 0;
      entry.pitState = null;
      entry.boxThisLap = false;
      entry.finished = false;
      entry.finishTime = 0;
      entry.dnf = false;
      entry.coolDown = null;
      entry.sectors = [null, null, null];
      entry.lastSectors = [null, null, null];
      entry.bestSectors = [null, null, null];
      entry.tyreAgeLaps = 0;
      entry.penaltySeconds = 0;
      entry.positionsGained = 0;
      entry.wingDamage = 0;
      entry.trackLimits = 0;
      entry._secStage = 0;
      entry._secSplit = [null, null];
      entry._offAcc = 0;
      entry._offLatched = false;
      entry._blueFrom = null;
      entry._blueT = 0;
      entry._contactCool = 0;
      entry._stuckT = 0;
      entry._stuckRef = null;
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

    // Scrub every pooled visual effect and skid-history buffer. The random
    // streams may have advanced, but the captured paused frame consumes none.
    const effects = game.effects;
    if (effects) {
      const sparkPositions = effects.sparks.geometry.attributes.position;
      sparkPositions.array.fill(0);
      for (let index = 1; index < sparkPositions.array.length; index += 3) sparkPositions.array[index] = -50;
      sparkPositions.needsUpdate = true;
      for (const spark of effects.sparkData) {
        spark.life = 0;
        spark.floor = 0;
        spark.vel.set(0, 0, 0);
      }
      effects._sparkCursor = 0;
      for (const smoke of effects.smoke) {
        smoke.life = 0;
        smoke.maxLife = 1;
        smoke.sprite.visible = false;
        smoke.sprite.position.set(0, -50, 0);
        smoke.sprite.scale.setScalar(1);
        smoke.sprite.material.opacity = 0;
      }
      effects._smokeCursor = 0;
      const skidPositions = effects.skidGeo.attributes.position;
      skidPositions.array.fill(0);
      for (let index = 1; index < skidPositions.array.length; index += 3) skidPositions.array[index] = -50;
      skidPositions.needsUpdate = true;
      effects._skidCursor = 0;
      effects._skidPrev = null;
    }

    // Rebuild the HUD from the frozen state and remove transient notifications.
    game.hud.hide();
    game.hud.bindSession(session, circuit);
    game.hud._uiTimer = 0;
    game.hud.show();
    game.hud.update(0);
    clearTimeout(game.hud._flashTo);
    game.hud._flashTo = null;
    game.hud._hideRadio();
    game.hud.clearTouchState();
    const clearElement = id => {
      const element = document.querySelector(`#${id}`);
      if (!element) return;
      element.className = '';
      element.replaceChildren();
      element.removeAttribute('style');
    };
    for (const id of ['race-msg', 'flbanner', 'radiocard', 'bigflash']) clearElement(id);
    const vsc = document.querySelector('#vscbanner');
    vsc?.classList.remove('on', 'green');
    const vscText = document.querySelector('#vsc-text');
    if (vscText) vscText.textContent = 'VIRTUAL SAFETY CAR';
    const vscCount = document.querySelector('#vsc-count');
    if (vscCount) vscCount.textContent = '';
    document.querySelector('#startlights')?.classList.remove('active');
    document.querySelectorAll('#startlights .lamp').forEach(lamp => lamp.classList.remove('on'));
    document.querySelector('#pit-overlay')?.classList.remove('active');
    document.querySelector('#onboarding')?.classList.remove('active');
    const vignette = document.querySelector('#boostvin');
    if (vignette) vignette.style.opacity = '0';
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
    const effectState = {
      activeSparks: effects?.sparkData.filter(item => item.life > 0).length || 0,
      activeSmoke: effects?.smoke.filter(item => item.life > 0 || item.sprite.visible).length || 0,
      sparkCursor: effects?._sparkCursor || 0,
      smokeCursor: effects?._smokeCursor || 0,
      skidCursor: effects?._skidCursor || 0,
      skidHasPrevious: !!(effects?._skidPrev),
      skidRaisedVertices: effects
        ? [...effects.skidGeo.attributes.position.array].filter((_, index) => index % 3 === 1 && effects.skidGeo.attributes.position.array[index] > -49).length
        : 0,
    };
    const hudState = {
      raceMessages: document.querySelector('#race-msg')?.childElementCount || 0,
      vscClass: document.querySelector('#vscbanner')?.className || '',
      fastestClass: document.querySelector('#flbanner')?.className || '',
      radioClass: document.querySelector('#radiocard')?.className || '',
      radioText: document.querySelector('#radiocard')?.textContent || '',
      lightsClass: document.querySelector('#startlights')?.className || '',
      litLights: document.querySelectorAll('#startlights .lamp.on').length,
      bigFlashDisplay: document.querySelector('#bigflash')?.style.display || '',
      bigFlashText: document.querySelector('#bigflash')?.textContent || '',
      pitClass: document.querySelector('#pit-overlay')?.className || '',
    };
    const canonicalState = {
      session: {
        phase: session.phase,
        phaseT: session.phaseT,
        raceTime: session.raceTime,
        lightsOn: session.lightsOn,
        fastestLap: session.fastestLap,
        results: session.results,
        vsc: session.vsc,
        radioQueueLength: session.radioQueue.length,
        blueFlagFor: session.blueFlagFor,
        playerPitOpen: session._playerPitOpen,
        timers: [session._posTimer, session._radioCool, session._vscViol, session._wallEvent,
          session._touchEvent, session._gapCheck, session._lastAnnounced],
        flags: [session._vscEnding, session._vscPenalised, session._vscWarned,
          session._lightEvent, session._shiftEvent, session._radioLastLap, session._radioResult],
      },
      entries: session.entries.map(entry => ({
        driverId: entry.driver.id,
        position: entry.position,
        lap: entry.lap,
        timing: [entry.lapStart, entry.lastLap, entry.bestLap, entry.lapTimes.length],
        pit: [entry.pitStops, entry.pitState, entry.boxThisLap],
        state: [entry.finished, entry.dnf, entry.penaltySeconds, entry.tyreAgeLaps, entry.wingDamage, entry.trackLimits],
        sectors: [entry.sectors, entry.lastSectors, entry.bestSectors],
        physics: {
          position: entry.phys.pos.toArray(),
          heading: entry.phys.heading,
          sampleIdx: entry.phys.sampleIdx,
          speed: entry.phys.v,
          controls: [entry.phys.steer, entry.phys.throttle, entry.phys.brake],
          powertrain: [entry.phys.gear, entry.phys.rpmFrac, entry.phys.battery, entry.phys.boosting,
            entry.phys.aeroX, entry.phys.fuel],
          tyre: [entry.phys.compound, entry.phys.wear, entry.phys.tyreTemp, entry.phys.tyreGrip],
          thermal: [entry.phys.brakeTemp, entry.phys.brakeFade],
          ers: [entry.phys.ersMode, entry.phys.ersDeploy],
          surface: [entry.phys.offTrack, entry.phys.onKerb, entry.phys.slip, entry.phys.offTrackTime,
            entry.phys.offTrackSink, entry.phys.kerbScrub],
          attitude: [entry.phys.pitch, entry.phys.roll, entry.phys.rideBump],
          timers: [entry.phys._xTimer, entry.phys._shiftCooldown, entry.phys._spinJitter, entry.phys._bumpT],
        },
      })),
      effects: effectState,
      hud: hudState,
    };
    return {
      contract: 'canonical-grid/chase-camera-v1',
      servedOrigin: location.origin,
      sessionSeed: game.sessionSeed,
      phase: session.phase,
      gridPose,
      canonicalState,
      gtaoNoiseBytes: [...game.gtao.pdNoiseTexture.image.data],
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
      sampleSize: `${sample.width}x${sample.height}`,
      meanSrgbLuma: mean,
      srgbLumaStandardDeviation: Math.sqrt(variance),
      srgbLumaRange: max - min,
      opaquePixelRatio: opaque / count,
      occupiedSrgbLumaBins: luminanceBuckets.size,
    };
  }, dataUrl);
}

async function measureScreenshotDelta(page, first, second, changedPixelChannelThreshold = 2) {
  const toDataUrl = png => `data:image/png;base64,${png.toString('base64')}`;
  const samples = await page.evaluate(async ([firstSource, secondSource]) => {
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
    return { first: [...a], second: [...b], sampleSize: `${sample.width}x${sample.height}` };
  }, [toDataUrl(first), toDataUrl(second)]);
  return summarizeRgbDelta(samples.first, samples.second, changedPixelChannelThreshold, samples.sampleSize);
}

async function measureAdditiveFogExtinction(page) {
  return page.evaluate(async () => {
    const THREE = await import('/lib/three.module.js');
    const game = window.__game;
    let glowMaterial = null;
    let poolMaterial = null;
    game.circuit.group.traverse(object => {
      if (!glowMaterial && object.name === 'floodlight-glow') glowMaterial = object.material;
      if (!poolMaterial && object.name === 'floodlight-pools') poolMaterial = object.material;
    });
    if (!glowMaterial || !poolMaterial) throw new Error('Night floodlight materials not found');

    const renderer = game.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClearColor = renderer.getClearColor(new THREE.Color()).getHex();
    const previousClearAlpha = renderer.getClearAlpha();
    const target = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: true });
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 150);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();

    const readEnergy = (material, kind, depth) => {
      const scene = new THREE.Scene();
      // A non-black fog colour exposes Three's stock additive-fog failure: at
      // fogFar it would still add this blue RGB with the source alpha.
      scene.fog = new THREE.Fog(0x204060, 10, 100);
      const object = kind === 'sprite'
        ? new THREE.Sprite(material)
        : new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material);
      object.position.set(0, 0, -depth);
      if (kind === 'sprite') object.scale.set(3, 3, 1);
      scene.add(object);

      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
      let maxRgb = 0;
      let rgbSum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        maxRgb = Math.max(maxRgb, pixels[i], pixels[i + 1], pixels[i + 2]);
        rgbSum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      }
      // Sprite geometry is a Three module singleton shared by the live game.
      // Only the temporary plane belongs to this probe.
      if (kind === 'mesh') object.geometry.dispose();
      return { maxRgb, rgbSum };
    };

    const inspectCompiledShader = (material) => {
      const gl = renderer.getContext();
      const program = renderer.properties.get(material).currentProgram;
      const source = program ? gl.getShaderSource(program.fragmentShader) : '';
      return {
        linked: !!program && gl.getProgramParameter(program.program, gl.LINK_STATUS),
        usesFog: source.includes('#define USE_FOG'),
        rgbExtinction: source.includes('gl_FragColor.rgb *= apexFogTransmittance;'),
        alphaExtinction: source.includes('gl_FragColor.a *= apexFogTransmittance;'),
        nativeFogMix: source.includes('mix( gl_FragColor.rgb, fogColor, fogFactor )'),
      };
    };

    try {
      const extinction = {
        glow: {
          near: readEnergy(glowMaterial, 'sprite', 20),
          beyondFogFar: readEnergy(glowMaterial, 'sprite', 110),
        },
        pool: {
          near: readEnergy(poolMaterial, 'mesh', 20),
          beyondFogFar: readEnergy(poolMaterial, 'mesh', 110),
        },
      };
      extinction.glow.shader = inspectCompiledShader(glowMaterial);
      extinction.pool.shader = inspectCompiledShader(poolMaterial);
      return extinction;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      target.dispose();
    }
  });
}

async function captureVenueRun(page, venue, runNumber, preFreezeTicks) {
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

  const preFreeze = await advanceCaptureHistory(page, preFreezeTicks);
  if (preFreezeTicks > 0) {
    expect(preFreeze).toMatchObject({ ticks: preFreezeTicks, contaminated: true });
    expect(preFreeze.raceTime).toBeGreaterThan(0);
    expect(preFreeze.activeSparks).toBeGreaterThan(0);
    expect(preFreeze.activeSmoke).toBeGreaterThan(0);
    expect(preFreeze.skidCursor).toBeGreaterThan(0);
    expect(preFreeze.transientHud).toEqual({
      vsc: 'on',
      fastest: 'on',
      radio: 'on warning',
      lights: 'active',
      flash: 'block',
    });
  }

  const frame = await lockCaptureFrame(page);
  frame.gridPoseSha256 = sha256(Buffer.from(JSON.stringify(frame.gridPose)));
  frame.canonicalStateSha256 = sha256(Buffer.from(JSON.stringify(frame.canonicalState)));
  frame.gtaoNoiseSha256 = sha256(Buffer.from(frame.gtaoNoiseBytes));
  frame.canonicalStateSummary = {
    session: frame.canonicalState.session,
    effects: frame.canonicalState.effects,
    hud: frame.canonicalState.hud,
  };
  delete frame.gridPose;
  delete frame.canonicalState;
  delete frame.gtaoNoiseBytes;
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
  expect(frame.canonicalStateSummary.effects).toEqual({
    activeSparks: 0,
    activeSmoke: 0,
    sparkCursor: 0,
    smokeCursor: 0,
    skidCursor: 0,
    skidHasPrevious: false,
    skidRaisedVertices: 0,
  });
  expect(frame.canonicalStateSummary.hud).toEqual({
    raceMessages: 0,
    vscClass: '',
    fastestClass: '',
    radioClass: '',
    radioText: '',
    lightsClass: '',
    litLights: 0,
    bigFlashDisplay: '',
    bigFlashText: '',
    pitClass: '',
  });

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
  expect(screenshotMetrics.opaquePixelRatio).toBeGreaterThan(0.99);
  expect(screenshotMetrics.srgbLumaRange).toBeGreaterThan(40);
  expect(screenshotMetrics.srgbLumaStandardDeviation).toBeGreaterThan(8);
  expect(screenshotMetrics.occupiedSrgbLumaBins).toBeGreaterThan(4);
  expect(repeatStability.meanAbsoluteChannelDifference)
    .toBeLessThanOrEqual(SAME_PAGE_TOLERANCE.meanAbsoluteChannelDifferenceMax);
  expect(repeatStability.changedPixelRatio).toBeLessThanOrEqual(SAME_PAGE_TOLERANCE.changedPixelRatioMax);

  // A run becomes evidence only after every app-error assertion has passed.
  expect(errors.console, 'console errors').toEqual([]);
  expect(errors.page, 'uncaught page errors').toEqual([]);
  expect(errors.http, 'HTTP error responses').toEqual([]);

  const metrics = {
    run: runNumber,
    preFreeze,
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
  const metricsBody = `${JSON.stringify(metrics, null, 2)}\n`;
  writes.push(writeFile(path.join(CAPTURE_DIR, metricsName), metricsBody));
  await Promise.all(writes);
  evidenceRecords.push({
    venue: venue.trackId,
    environment: venue.environment,
    seed: venue.seed,
    pass: true,
    servedOrigins: [...new Set(runs.map(capture => capture.metrics.servedOrigin))],
    metrics: path.posix.join('runs', EVIDENCE_RUN_ID, metricsName),
    metricsSha256: sha256(Buffer.from(metricsBody)),
    runs: runFiles,
  });
}

async function auditEvidenceArtifacts(records) {
  if (!CAPTURE_ROOT || !CAPTURE_DIR) return [];
  const failures = [];
  const inspect = async (relative, expected, label) => {
    const absolute = path.resolve(CAPTURE_ROOT, relative);
    const ownedRelative = path.relative(CAPTURE_DIR, absolute);
    if (ownedRelative.startsWith(`..${path.sep}`) || ownedRelative === '..' || path.isAbsolute(ownedRelative)) {
      failures.push(`${label}: path escapes ${EVIDENCE_RUN_ID}`);
      return;
    }
    try {
      const bytes = await readFile(absolute);
      if (sha256(bytes) !== expected) failures.push(`${label}: SHA-256 mismatch`);
    } catch (error) {
      failures.push(`${label}: ${error.code || error.message}`);
    }
  };
  for (const record of records) {
    await inspect(record.metrics, record.metricsSha256, `${record.venue} metrics`);
    for (const run of record.runs) {
      await inspect(run.primary, run.sha256.primary, `${record.venue} run ${run.run} primary`);
      await inspect(run.repeat, run.sha256.repeat, `${record.venue} run ${run.run} repeat`);
    }
  }
  return failures;
}

test.beforeAll(async () => {
  if (!CAPTURE_ROOT) return;
  await ensureEvidenceRoot(CAPTURE_ROOT, REPO_ROOT);
  await mkdir(path.join(CAPTURE_ROOT, 'runs'), { recursive: true });
  runOwner = await acquireRunOwnership(CAPTURE_ROOT, EVIDENCE_RUN_ID, {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    status: 'running',
    pass: false,
    complete: false,
    authoritativeManifest: path.posix.join('runs', EVIDENCE_RUN_ID, 'manifest.json'),
  });
  await mkdir(CAPTURE_DIR);
  await atomicWriteJson(path.join(CAPTURE_DIR, 'owner.json'), {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    pid: process.pid,
    status: 'running',
  }, EVIDENCE_RUN_ID);
});

test.afterEach(async ({}, testInfo) => {
  if (!CAPTURE_ROOT || testInfo.status === testInfo.expectedStatus) return;
  testFailures.push({
    title: testInfo.title,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    errors: testInfo.errors.map(error => error.message || String(error)),
  });
});

test('manifest integrity fails closed for incomplete, duplicate, unexpected, and failed records', () => {
  const complete = EXPECTED_VENUES.map(record => ({ ...record, pass: true }));
  expect(manifestIntegrity(complete, EXPECTED_VENUES)).toMatchObject({ complete: true, pass: true });
  expect(manifestIntegrity(complete.slice(0, -1), EXPECTED_VENUES))
    .toMatchObject({ complete: false, pass: false, missing: ['singapore/night'] });
  expect(manifestIntegrity([...complete, complete[0]], EXPECTED_VENUES))
    .toMatchObject({ complete: false, pass: false, duplicate: ['melbourne/day'] });
  expect(manifestIntegrity([...complete, { venue: 'monaco', environment: 'day', pass: true }], EXPECTED_VENUES))
    .toMatchObject({ complete: false, pass: false, unexpected: ['monaco/day'] });
  expect(manifestIntegrity(complete.map((record, index) => index === 1 ? { ...record, pass: false } : record),
    EXPECTED_VENUES)).toMatchObject({ complete: true, pass: false, failed: ['bahrain/dusk'] });
});

test('capture root validation rejects release, external, and conflicting output paths', () => {
  const allowed = path.join(REPO_ROOT, 'test-results', 'visual-evidence');
  expect(resolveEvidenceRoot({ configured: allowed, repoRoot: REPO_ROOT })).toBe(allowed);
  expect(resolveEvidenceRoot({ configured: path.join(allowed, 'manual-run'), repoRoot: REPO_ROOT }))
    .toBe(path.join(allowed, 'manual-run'));
  expect(() => resolveEvidenceRoot({ configured: path.join(REPO_ROOT, 'dist', 'evidence'), repoRoot: REPO_ROOT }))
    .toThrow(/must be .*test-results.*visual-evidence/);
  expect(() => resolveEvidenceRoot({ configured: path.join(tmpdir(), 'apex-external-evidence'), repoRoot: REPO_ROOT }))
    .toThrow(/must be .*test-results.*visual-evidence/);
  expect(() => resolveEvidenceRoot({
    configured: allowed,
    legacy: path.join(allowed, 'different'),
    repoRoot: REPO_ROOT,
  })).toThrow(/disagree/);
});

test('RGB delta reports unrounded mean and true maximum channel difference', () => {
  const delta = summarizeRgbDelta(
    Uint8Array.from([0, 10, 20, 255, 100, 100, 100, 255]),
    Uint8Array.from([3, 10, 20, 255, 101, 102, 100, 255]),
    2,
    '2x1',
  );
  expect(delta).toEqual({
    sampleSize: '2x1',
    changedPixelChannelThreshold: 2,
    meanAbsoluteChannelDifference: 1,
    maxAbsoluteChannelDifference: 3,
    changedPixelRatio: 0.5,
  });
});

test('root manifest ownership cannot be stolen and never exposes stale success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'apex-evidence-owner-'));
  const running = runId => ({
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId,
    status: 'running',
    pass: false,
    complete: false,
  });
  const terminal = (runId, status, pass) => ({
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId,
    status,
    pass,
    complete: pass,
    authoritativeManifest: `runs/${runId}/manifest.json`,
  });
  let firstOwner;
  let secondOwner;
  let thirdOwner;
  try {
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      schema: VISUAL_EVIDENCE_SCHEMA,
      runId: 'stale-success',
      status: 'passed',
      pass: true,
      complete: true,
    }));

    await expect(acquireRunOwnership(root, 'run-crash', running('run-crash'), {
      afterInvalidate: () => { throw new Error('simulated crash after invalidation'); },
    })).rejects.toThrow(/simulated crash/);
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-crash', status: 'running', pass: false, activeLock: '.active-run.lock' });
    await expect(access(path.join(root, '.manifest-update.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, '.active-run.lock', 'owner.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    firstOwner = await acquireRunOwnership(root, 'run-a', running('run-a'));
    expect(JSON.parse(await readFile(path.join(firstOwner.lockDirectory, 'owner.json'), 'utf8')))
      .toMatchObject({ runId: 'run-a', status: 'running' });
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-a', status: 'running', pass: false, activeLock: '.active-run.lock' });
    await expect(publishLatestPointer(firstOwner, {
      schema: VISUAL_EVIDENCE_SCHEMA,
      runId: 'not-the-owner',
      status: 'running',
      pass: false,
      activeLock: '.active-run.lock',
    })).rejects.toThrow(/does not match owner run-a/);
    await expect(publishLatestPointer(firstOwner, { ...running('run-a'), activeLock: null }))
      .rejects.toThrow(/must expose .active-run.lock/);
    await expect(acquireRunOwnership(root, 'run-b', running('run-b')))
      .rejects.toThrow(/already owned by run-a/);

    await expect(finalizeRunOwnership(firstOwner, terminal('run-a', 'passed', true), {
      afterRelease: () => { throw new Error('simulated crash after ownership release'); },
    })).rejects.toThrow(/simulated crash after ownership release/);
    firstOwner = null;
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-a', status: 'passed', pass: true, activeLock: '.active-run.lock' });
    await expect(readFile(path.join(root, '.active-run.lock', 'owner.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    secondOwner = await acquireRunOwnership(root, 'run-b', running('run-b'));
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-b', status: 'running', pass: false, activeLock: '.active-run.lock' });
    await finalizeRunOwnership(secondOwner, terminal('run-b', 'failed', false));
    secondOwner = null;
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-b', status: 'failed', pass: false, activeLock: null });

    thirdOwner = await acquireRunOwnership(root, 'run-c', running('run-c'));
    await finalizeRunOwnership(thirdOwner, terminal('run-c', 'passed', true));
    thirdOwner = null;
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-c', status: 'passed', pass: true, activeLock: null });
    await expect(readFile(path.join(root, '.active-run.lock', 'owner.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (thirdOwner) await releaseRunOwnership(thirdOwner).catch(() => {});
    if (secondOwner) await releaseRunOwnership(secondOwner).catch(() => {});
    if (firstOwner) await releaseRunOwnership(firstOwner).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a contender waits through the terminal-pointer-to-unlock boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'apex-evidence-finalize-'));
  const running = runId => ({
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId,
    status: 'running',
    pass: false,
    complete: false,
  });
  const passed = runId => ({
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId,
    status: 'passed',
    pass: true,
    complete: true,
    authoritativeManifest: `runs/${runId}/manifest.json`,
  });
  let firstOwner;
  let contenderOwner;
  let finalizing;
  let acquiring;
  let releaseFinalize = () => {};
  try {
    firstOwner = await acquireRunOwnership(root, 'run-finalizing', running('run-finalizing'));
    let reachedFinalize;
    const finalizeReached = new Promise(resolve => { reachedFinalize = resolve; });
    const finalizeHold = new Promise(resolve => { releaseFinalize = resolve; });
    finalizing = finalizeRunOwnership(firstOwner, passed('run-finalizing'), {
      afterFinalize: async () => {
        reachedFinalize();
        await finalizeHold;
      },
    });
    await finalizeReached;
    firstOwner = null; // finalizeRunOwnership has released actual ownership.
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-finalizing', status: 'passed', pass: true, activeLock: null });
    await expect(access(path.join(root, '.manifest-update.lock'))).resolves.toBeUndefined();

    let acquisitionSettled = false;
    acquiring = acquireRunOwnership(root, 'run-contender', running('run-contender'))
      .then(owner => { acquisitionSettled = true; return owner; });
    await expect.poll(async () => JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).runId)
      .toBe('run-contender');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(acquisitionSettled, 'the contender must wait for finalization mutex release').toBe(false);

    releaseFinalize();
    await finalizing;
    finalizing = null;
    contenderOwner = await acquiring;
    acquiring = null;
    expect(JSON.parse(await readFile(path.join(contenderOwner.lockDirectory, 'owner.json'), 'utf8')))
      .toMatchObject({ runId: 'run-contender', status: 'running' });
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')))
      .toMatchObject({ runId: 'run-contender', status: 'running', pass: false, activeLock: '.active-run.lock' });

    await finalizeRunOwnership(contenderOwner, {
      ...passed('run-contender'),
      status: 'failed',
      pass: false,
      complete: false,
    });
    contenderOwner = null;
  } finally {
    releaseFinalize();
    if (finalizing) await finalizing.catch(() => {});
    if (acquiring) contenderOwner = await acquiring.catch(() => null);
    if (contenderOwner) await releaseRunOwnership(contenderOwner).catch(() => {});
    if (firstOwner) await releaseRunOwnership(firstOwner).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

for (const venue of VENUES) {
  test(`${venue.trackId} uses one ${venue.environment} HDR and is stable across fresh sessions`, async ({ page, context }) => {
    test.setTimeout(180_000);
    const captures = [];
    let baseline = null;
    for (let index = 0; index < FRESH_CAPTURE_RUNS; index++) {
      const runPage = index === 0 ? page : await context.newPage();
      try {
        const capture = await captureVenueRun(runPage, venue, index + 1, PRE_FREEZE_TICKS[index]);
        const crossRun = baseline
          ? await measureScreenshotDelta(runPage, baseline.screenshot, capture.screenshot,
            CROSS_RUN_TOLERANCE.changedPixelChannelThreshold)
          : { sampleSize: '160x90', changedPixelChannelThreshold: CROSS_RUN_TOLERANCE.changedPixelChannelThreshold,
            meanAbsoluteChannelDifference: 0, maxAbsoluteChannelDifference: 0, changedPixelRatio: 0 };
        capture.metrics.crossRunFromRun1 = crossRun;
        if (baseline) {
          console.log(`[venue-evidence-delta] ${JSON.stringify({
            venue: venue.trackId,
            run: index + 1,
            preFreezeTicks: PRE_FREEZE_TICKS[index],
            crossRun,
          })}`);
          expect(capture.metrics.capture.frame.camera).toEqual(baseline.metrics.capture.frame.camera);
          expect(capture.metrics.capture.frame.gridPoseSha256).toBe(baseline.metrics.capture.frame.gridPoseSha256);
          expect(capture.metrics.capture.frame.canonicalStateSha256)
            .toBe(baseline.metrics.capture.frame.canonicalStateSha256);
          expect(capture.metrics.capture.frame.gtaoNoiseSha256).toBe(baseline.metrics.capture.frame.gtaoNoiseSha256);
          expect(capture.metrics.capture.frame.sessionSeed).toBe(baseline.metrics.capture.frame.sessionSeed);
          expect(crossRun.meanAbsoluteChannelDifference)
            .toBeLessThanOrEqual(CROSS_RUN_TOLERANCE.meanAbsoluteChannelDifferenceMax);
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
      const extinction = await measureAdditiveFogExtinction(page);
      expect(extinction.glow.near.maxRgb, 'near floodlight glow emits visible energy').toBeGreaterThan(8);
      expect(extinction.pool.near.maxRgb, 'near floodlight pool emits visible energy').toBeGreaterThan(8);
      expect(extinction.glow.beyondFogFar, 'distant glow contributes zero additive fog colour').toEqual({
        maxRgb: 0,
        rgbSum: 0,
      });
      expect(extinction.pool.beyondFogFar, 'distant pool contributes zero additive fog colour').toEqual({
        maxRgb: 0,
        rgbSum: 0,
      });
      const expectedShader = {
        linked: true,
        usesFog: true,
        rgbExtinction: true,
        alphaExtinction: true,
        nativeFogMix: false,
      };
      expect(extinction.glow.shader, 'real SpriteMaterial program uses additive extinction').toEqual(expectedShader);
      expect(extinction.pool.shader, 'real MeshBasicMaterial program uses additive extinction').toEqual(expectedShader);
      console.log(`[additive-fog-extinction] ${JSON.stringify(extinction)}`);

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

test('captured evidence contains every expected venue exactly once with intact artifacts', async () => {
  test.skip(!CAPTURE_ROOT, 'artifact completeness applies only to an evidence run');
  expect(manifestIntegrity(evidenceRecords, EXPECTED_VENUES), 'visual evidence must be complete and unique')
    .toMatchObject({ complete: true, pass: true });
  expect(await auditEvidenceArtifacts(evidenceRecords), 'every persisted artifact must exist with matching bytes')
    .toEqual([]);
});

test.afterAll(async () => {
  if (!CAPTURE_ROOT || !runOwner) return;
  const integrity = manifestIntegrity(evidenceRecords, EXPECTED_VENUES);
  const artifactFailures = await auditEvidenceArtifacts(evidenceRecords);
  const pass = integrity.pass && artifactFailures.length === 0 && testFailures.length === 0;
  const manifest = {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    generatedBy: 'tests/browser/venues.spec.mjs',
    status: pass ? 'passed' : 'failed',
    authoritative: true,
    outputDirectory: path.posix.join('runs', EVIDENCE_RUN_ID),
    pass,
    complete: integrity.complete,
    expectedVenues: EXPECTED_VENUES,
    integrity,
    artifactFailures,
    testFailures,
    servedOrigins: [...new Set(evidenceRecords.flatMap(record => record.servedOrigins))],
    captureContract: {
      viewport: FIXED_VIEWPORT,
      deviceScaleFactor: FIXED_DPR,
      graphicsQuality: 'high',
      freshRunsPerVenue: FRESH_CAPTURE_RUNS,
      preFreezeTicks: PRE_FREEZE_TICKS,
      state: 'canonical grid, physics, timing, race, effects, HUD, fixed chase camera at fov 72',
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
  await atomicWriteJson(path.join(CAPTURE_DIR, 'manifest.json'), manifest);
  await atomicWriteJson(path.join(CAPTURE_DIR, 'owner.json'), {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    pid: process.pid,
    status: manifest.status,
  }, EVIDENCE_RUN_ID);
  await finalizeRunOwnership(runOwner, {
    schema: VISUAL_EVIDENCE_SCHEMA,
    runId: EVIDENCE_RUN_ID,
    status: manifest.status,
    pass: manifest.pass,
    complete: manifest.complete,
    authoritativeManifest: path.posix.join('runs', EVIDENCE_RUN_ID, 'manifest.json'),
  });
  runOwner = null;
});
