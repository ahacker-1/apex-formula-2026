import { test, expect } from '@playwright/test';

async function seed(page, values = {}) {
  await page.addInitScript((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, values);
}

async function boot(page, values = { apexf1_onboarding_v1: '1' }, path = '/') {
  await seed(page, values);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(path);
  await expect(page.getByRole('button', { name: /QUICK RACE/ })).toBeVisible();
  return errors;
}

async function chooseDriverAndTrack(page, mode = 'TIME TRIAL', beforeTrack = null) {
  await page.getByRole('button', { name: new RegExp(mode) }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();
  await expect(page.locator('.track-card[data-t="melbourne"]')).toBeVisible();
  if (beforeTrack) await beforeTrack();
  await page.locator('.track-card[data-t="melbourne"]').click();
  await page.waitForFunction(
    () => window.__game?.session && ['race', 'quali'].includes(window.__game.state),
    null,
    { timeout: 30_000, polling: 50 },
  );
}

async function captureSeededInitialSession(page, value) {
  // Stop the self-scheduling render loop before main.js loads. Session creation
  // uses timers, so this gives us the exact pre-tick state without racing a RAF.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  const errors = await boot(
    page,
    { apexf1_onboarding_v1: '1' },
    `/?seed=${encodeURIComponent(value)}`,
  );
  await chooseDriverAndTrack(page);
  const snapshot = await page.evaluate(() => {
    const game = window.__game;
    const session = game.session;
    const player = session.player;
    const phys = player.phys;
    return {
      gameSeed: game.sessionSeed,
      sessionSeed: session.seed,
      randomState: session.random.state,
      gameState: game.state,
      mode: session.mode,
      trial: session.trial,
      phase: session.phase,
      qualiState: session.qualiState,
      raceTime: session.raceTime,
      player: {
        position: phys.pos.toArray(),
        heading: phys.heading,
        speed: phys.v,
        gear: phys.gear,
        fuel: phys.fuel,
        battery: phys.battery,
        tyre: phys.compound,
        sampleIdx: phys.sampleIdx,
        lap: player.lap,
      },
      aiQualifying: session.aiQualiTimes.map(({ driverId, time }) => ({ driverId, time })),
    };
  });
  await page.evaluate(() => window.__game.teardownSession());
  return { errors, snapshot };
}

test('query seed exposes a numeric seed and reproduces the initial simulation state', async ({ page, context }) => {
  const first = await captureSeededInitialSession(page, 'browser-regression-2026');
  await page.close();

  const secondPage = await context.newPage();
  const second = await captureSeededInitialSession(secondPage, 'browser-regression-2026');

  expect(Number.isInteger(first.snapshot.sessionSeed)).toBe(true);
  expect(first.snapshot.sessionSeed).toBeGreaterThanOrEqual(0);
  expect(first.snapshot.sessionSeed).toBeLessThanOrEqual(0xFFFFFFFF);
  expect(first.snapshot.gameSeed).toBe(first.snapshot.sessionSeed);
  expect(second.snapshot).toEqual(first.snapshot);
  expect(first.errors).toEqual([]);
  expect(second.errors).toEqual([]);
  await secondPage.close();
});

test('fixed-step accumulator bounds a long frame and discards its backlog', async ({ page }) => {
  const errors = await boot(page);
  const pacing = await page.evaluate(() => {
    const game = window.__game;
    game.fixedStep.reset();
    const primed = game.fixedStep.advance(1 / 120);
    game.resetSimulationTiming();
    const afterReset = game.fixedStep.advance(1 / 120);

    game.fixedStep.reset();
    const ticks = [];
    const longFrame = game.fixedStep.advance(5, (dt) => ticks.push(dt));
    const recovery = game.fixedStep.advance(1 / 60, (dt) => ticks.push(dt));
    return { primed, afterReset, longFrame, recovery, ticks };
  });

  expect(pacing.primed.steps).toBe(0);
  expect(pacing.primed.alpha).toBeCloseTo(0.5, 12);
  expect(pacing.afterReset.steps).toBe(0);
  expect(pacing.afterReset.alpha).toBeCloseTo(0.5, 12);
  expect(pacing.longFrame.steps).toBe(3);
  expect(pacing.longFrame.simulatedDt).toBeCloseTo(0.05, 12);
  expect(pacing.longFrame.droppedDt).toBeCloseTo(4.95, 12);
  expect(pacing.longFrame.alpha).toBeCloseTo(0, 12);
  expect(pacing.recovery.steps).toBe(1);
  expect(pacing.recovery.droppedDt).toBe(0);
  expect(pacing.ticks).toHaveLength(4);
  expect(pacing.ticks.every(dt => Math.abs(dt - 1 / 60) < 1e-12)).toBe(true);

  await page.getByRole('button', { name: /SETTINGS/ }).click();
  const qualifying = page.getByRole('group', { name: 'Qualifying' });
  const qualiOn = qualifying.getByRole('button', { name: 'ON' });
  const qualiOff = qualifying.getByRole('button', { name: 'OFF' });
  await expect(qualiOn).toHaveAttribute('aria-pressed', 'true');
  await qualiOff.click();
  await expect(qualiOff).toHaveAttribute('aria-pressed', 'true');
  await expect(qualiOn).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('main menu is keyboard-accessible and Race Now restores the last event', async ({ page }) => {
  const errors = await boot(page, {
    apexf1_onboarding_v1: '1',
    apexf1_last_race: JSON.stringify({ driverId: 'hacker', trackId: 'melbourne' }),
  });
  const raceNow = page.getByRole('button', { name: /RACE NOW/ });
  await expect(raceNow).toContainText('AVI');
  await raceNow.focus();
  await expect(raceNow).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__game?.state === 'race' && window.__game.session, null, { timeout: 30_000 });
  await expect(page.locator('#hud')).toHaveClass(/active/);

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.__game.keys.ArrowUp === true);
  await page.keyboard.press('Escape');
  const resume = page.getByRole('button', { name: 'RESUME' });
  await expect(resume).toBeVisible();
  const released = await page.evaluate(() => ({
    paused: window.__game.paused,
    throttleHeld: !!window.__game.keys.ArrowUp,
    keySteer: window.__game.keySteer,
    touchHeld: Object.values(window.__game.hud.touchState).some(Boolean),
  }));
  expect(released).toEqual({ paused: true, throttleHeld: false, keySteer: 0, touchHeld: false });
  await page.keyboard.up('ArrowUp');
  await resume.click();
  await expect.poll(() => page.evaluate(() => window.__game.paused)).toBe(false);
  expect(errors).toEqual([]);
});

test('loading focus loss pauses on onboarding exit and gamepad input waits for neutral', async ({ page }) => {
  const errors = await boot(page, {});
  await page.getByRole('button', { name: /TIME TRIAL/ }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();

  let releaseRaceModule;
  const raceModuleHeld = new Promise(resolve => { releaseRaceModule = resolve; });
  let markRaceRequested;
  const raceModuleRequested = new Promise(resolve => { markRaceRequested = resolve; });
  const holdRaceModule = async (route) => {
    markRaceRequested();
    await raceModuleHeld;
    await route.continue();
  };
  await page.route('**/js/race.js', holdRaceModule);
  await page.locator('.track-card[data-t="melbourne"]').click();
  await raceModuleRequested;

  let loadingLatches;
  try {
    loadingLatches = await page.evaluate(() => {
      const game = window.__game;
      const ownHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
      window.__testOwnHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus') || null;
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      let visibilityLatched = false;
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        visibilityLatched = game._pauseOnReady;
        game._pauseOnReady = false;
      } finally {
        if (ownHidden) Object.defineProperty(document, 'hidden', ownHidden);
        else delete document.hidden;
      }
      window.dispatchEvent(new Event('blur'));
      return {
        state: game.state,
        visibilityLatched,
        blurLatched: game._pauseOnReady,
      };
    });
  } finally {
    releaseRaceModule();
  }
  await page.waitForFunction(
    () => window.__game?.session && ['race', 'quali'].includes(window.__game.state),
    null,
    { timeout: 30_000, polling: 50 },
  );
  await page.unroute('**/js/race.js', holdRaceModule);

  expect(loadingLatches).toEqual({ state: 'loading', visibilityLatched: true, blurLatched: true });
  await expect(page.locator('#onboarding')).toHaveClass(/active/);
  await page.getByRole('button', { name: /START DRIVING/ }).click();
  await expect(page.locator('#onboarding')).not.toHaveClass(/active/);
  await expect(page.locator('#screen-pause')).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: 'RESUME' })).toBeVisible();
  expect(await page.evaluate(() => window.__game.paused)).toBe(true);
  await page.evaluate(() => {
    if (window.__testOwnHasFocus) {
      Object.defineProperty(document, 'hasFocus', window.__testOwnHasFocus);
    } else {
      delete document.hasFocus;
    }
    delete window.__testOwnHasFocus;
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('button', { name: 'RESUME' }).click();
  await expect.poll(() => page.evaluate(() => window.__game.paused)).toBe(false);

  const gamepad = await page.evaluate(() => {
    const game = window.__game;
    const phys = game.session.player.phys;
    const ownGetGamepads = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    const saved = {
      autoGear: game.ui.settings.autoGear,
      assistAutoGear: phys.assists.autoGear,
      gear: phys.gear,
      speed: phys.v,
      cooldown: phys._shiftCooldown,
    };
    const buttons = Array.from({ length: 8 }, () => ({ value: 0, pressed: false }));
    const pad = { axes: [0], buttons };
    const setNeutral = () => {
      pad.axes[0] = 0;
      for (const button of buttons) { button.value = 0; button.pressed = false; }
    };
    const setHeld = () => {
      pad.axes[0] = 0.6;
      buttons[0] = { value: 1, pressed: true };
      buttons[5] = { value: 1, pressed: true };
      buttons[6] = { value: 0.7, pressed: true };
      buttons[7] = { value: 0.9, pressed: true };
    };
    const sample = input => ({
      steer: input.steer,
      throttle: input.throttle,
      brake: input.brake,
      boost: input.boost,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
    });

    let result;
    try {
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
      game.ui.settings.autoGear = false;
      phys.assists.autoGear = false;
      phys.gear = 3;
      phys.v = 0;
      phys._shiftCooldown = 0;

      setHeld();
      game.resetSimulationTiming();
      const blocked = sample(game.playerInput(1));
      const blockedNeedsNeutral = game._gamepadNeedsNeutral;
      setNeutral();
      const neutral = sample(game.playerInput(1));
      const neutralNeedsNeutral = game._gamepadNeedsNeutral;
      setHeld();
      const accepted = sample(game.playerInput(1));
      result = {
        blocked,
        blockedNeedsNeutral,
        neutral,
        neutralNeedsNeutral,
        accepted,
        remainingQueue: [...game._shiftQueue],
      };
    } finally {
      if (ownGetGamepads) Object.defineProperty(navigator, 'getGamepads', ownGetGamepads);
      else delete navigator.getGamepads;
      game.ui.settings.autoGear = saved.autoGear;
      phys.assists.autoGear = saved.assistAutoGear;
      phys.gear = saved.gear;
      phys.v = saved.speed;
      phys._shiftCooldown = saved.cooldown;
      game.releaseDrivingInputs();
    }
    return result;
  });

  expect(gamepad.blocked).toEqual({
    steer: 0, throttle: 0, brake: 0, boost: false, shiftUp: false, shiftDown: false,
  });
  expect(gamepad.blockedNeedsNeutral).toBe(true);
  expect(gamepad.neutral).toEqual({
    steer: 0, throttle: 0, brake: 0, boost: false, shiftUp: false, shiftDown: false,
  });
  expect(gamepad.neutralNeedsNeutral).toBe(false);
  expect(gamepad.accepted.steer).toBeCloseTo(-0.6, 12);
  expect(gamepad.accepted).toMatchObject({
    throttle: 0.9, brake: 0.7, boost: true, shiftUp: true, shiftDown: false,
  });
  expect(gamepad.remainingQueue).toEqual([]);
  expect(errors).toEqual([]);
});

test('refocus during loading clears the pending auto-pause', async ({ page }) => {
  const errors = await boot(page, { apexf1_onboarding_v1: '1' });
  await page.getByRole('button', { name: /TIME TRIAL/ }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();

  let releaseRaceModule;
  const raceModuleHeld = new Promise(resolve => { releaseRaceModule = resolve; });
  let markRaceRequested;
  const raceModuleRequested = new Promise(resolve => { markRaceRequested = resolve; });
  const holdRaceModule = async (route) => {
    markRaceRequested();
    await raceModuleHeld;
    await route.continue();
  };
  await page.route('**/js/race.js', holdRaceModule);
  await page.locator('.track-card[data-t="melbourne"]').click();
  await raceModuleRequested;

  let focusState;
  try {
    focusState = await page.evaluate(() => {
      const game = window.__game;
      const ownHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
      try {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
        const afterBlur = game._pauseOnReady;
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        window.dispatchEvent(new Event('focus'));
        return { state: game.state, afterBlur, afterFocus: game._pauseOnReady };
      } finally {
        if (ownHasFocus) Object.defineProperty(document, 'hasFocus', ownHasFocus);
        else delete document.hasFocus;
      }
    });
  } finally {
    releaseRaceModule();
  }
  await page.waitForFunction(
    () => window.__game?.session && ['race', 'quali'].includes(window.__game.state),
    null,
    { timeout: 30_000, polling: 50 },
  );
  await page.unroute('**/js/race.js', holdRaceModule);

  expect(focusState).toEqual({ state: 'loading', afterBlur: true, afterFocus: false });
  expect(await page.evaluate(() => ({
    state: window.__game.state,
    paused: window.__game.paused,
    pendingPause: window.__game._pauseOnReady,
  }))).toEqual({ state: 'quali', paused: false, pendingPause: false });
  await expect(page.locator('#screen-pause')).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('failed lazy gameplay module offers accessible recovery and retry succeeds', async ({ page }) => {
  const errors = await boot(page, { apexf1_onboarding_v1: '1' });
  await page.getByRole('button', { name: /TIME TRIAL/ }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();

  let failedRequests = 0;
  const failRaceModule = async (route) => {
    failedRequests++;
    await route.abort('failed');
  };
  await page.route('**/js/race.js', failRaceModule);
  await page.locator('.track-card[data-t="melbourne"]').click();
  await page.waitForFunction(() => window.__game?.state === 'loadError', null, { timeout: 15_000 });

  const alert = page.getByRole('alert');
  const retry = page.getByRole('button', { name: 'RETRY' });
  const mainMenu = page.getByRole('button', { name: 'MAIN MENU' });
  await expect(alert).toContainText('RACE LOAD INTERRUPTED');
  await expect(alert).toContainText('retry without losing your selection');
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(mainMenu).toBeVisible();
  expect(failedRequests).toBe(1);
  const failedSession = await page.evaluate(() => {
    window.__retryDocumentToken = 'failed-module-document';
    return {
    hasSession: !!window.__game.session,
    driverId: window.__game.raceConfig?.driverId,
    trackId: window.__game.raceConfig?.race?.trackId,
    trial: window.__game.raceConfig?.trial,
      seed: window.__game.raceConfig?.seed,
    };
  });
  expect(failedSession).toMatchObject({
    hasSession: false, driverId: 'hacker', trackId: 'melbourne', trial: true,
  });
  expect(Number.isInteger(failedSession.seed)).toBe(true);

  await page.unroute('**/js/race.js', failRaceModule);
  const reloaded = page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame(),
  });
  await retry.click();
  await reloaded;
  await page.waitForFunction(
    () => window.__game?.session && ['race', 'quali'].includes(window.__game.state),
    null,
    { timeout: 30_000, polling: 50 },
  );
  await expect(page.locator('#hud')).toHaveClass(/active/);
  expect(await page.evaluate(() => ({
    state: window.__game.state,
    trial: window.__game.session.trial,
    trackId: window.__game.raceConfig.race.trackId,
    seed: window.__game.raceConfig.seed,
    sessionSeed: window.__game.session.seed,
    oldDocumentToken: window.__retryDocumentToken || null,
    pendingRetry: sessionStorage.getItem('apexf1_retry_session_v1'),
    audioReady: window.__game.audio.ready,
  }))).toEqual({
    state: 'quali',
    trial: true,
    trackId: 'melbourne',
    seed: failedSession.seed,
    sessionSeed: failedSession.seed,
    oldDocumentToken: null,
    pendingRetry: null,
    audioReady: false,
  });
  await page.evaluate(() => {
    const audio = window.__game.audio;
    const startEngine = audio.startEngine.bind(audio);
    window.__retryEngineStarts = 0;
    audio.startEngine = (...args) => {
      window.__retryEngineStarts++;
      return startEngine(...args);
    };
  });
  await page.keyboard.press('KeyZ');
  await expect.poll(() => page.evaluate(() => window.__retryEngineStarts)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__game.audio.engineOut?.gain?.value || 0)).toBeGreaterThan(0);
  expect(await page.evaluate(() => ({
    ready: window.__game.audio.ready,
    contextState: window.__game.audio.ctx?.state,
  }))).toEqual({ ready: true, contextState: 'running' });
  expect(errors.some(error => error.startsWith('Race assets failed to load'))).toBe(true);
  expect(errors.filter(error => !error.startsWith('Race assets failed to load'))).toEqual([]);
});

test('manual shifts, generated-seed restart, and rendering teardown preserve lifecycle state', async ({ page }) => {
  const errors = await boot(page, {
    apexf1_onboarding_v1: '1',
    apexf1_settings: JSON.stringify({ autoGear: false }),
  });
  await chooseDriverAndTrack(page);

  const initial = await page.evaluate(() => {
    const game = window.__game;
    const phys = game.session.player.phys;
    const keyEvent = { code: 'KeyQ', key: 'q', repeat: false, preventDefault() {} };

    phys.gear = 5;
    phys.v = 0;
    phys._shiftCooldown = 0.1;
    game.onKey(keyEvent, true);
    game.onKey(keyEvent, false);
    game.onKey(keyEvent, true);
    game.onKey(keyEvent, false);
    game.paused = true;

    const inputDuringCooldown = game.playerInput(1 / 60);
    const queueDuringCooldown = [...game._shiftQueue];
    const shifts = [];
    for (let tick = 0; tick < 30 && game._shiftQueue.length; tick++) {
      const event = phys.step(1 / 60, game.playerInput(1 / 60));
      if (event.shifted) shifts.push({ direction: event.shifted, gear: phys.gear });
    }

    window.__preRestartSession = game.session;
    return {
      generatedSeed: game.raceConfig.seed,
      sessionSeed: game.session.seed,
      manualSetting: game.ui.settings.autoGear === false && phys.assists.autoGear === false,
      inputDuringCooldown: {
        shiftUp: inputDuringCooldown.shiftUp,
        shiftDown: inputDuringCooldown.shiftDown,
      },
      queueDuringCooldown,
      shifts,
      finalGear: phys.gear,
      remainingQueue: [...game._shiftQueue],
    };
  });

  expect(Number.isInteger(initial.generatedSeed)).toBe(true);
  expect(initial.sessionSeed).toBe(initial.generatedSeed);
  expect(initial.manualSetting).toBe(true);
  expect(initial.inputDuringCooldown).toEqual({ shiftUp: false, shiftDown: false });
  expect(initial.queueDuringCooldown).toEqual([-1, -1]);
  expect(initial.shifts).toEqual([
    { direction: -1, gear: 4 },
    { direction: -1, gear: 3 },
  ]);
  expect(initial.finalGear).toBe(3);
  expect(initial.remainingQueue).toEqual([]);

  await page.evaluate(() => window.__game.onUI('restartRace'));
  await page.waitForFunction(
    () => window.__game?.session && window.__game.session !== window.__preRestartSession &&
      ['race', 'quali'].includes(window.__game.state),
    null,
    { timeout: 30_000, polling: 50 },
  );
  const restarted = await page.evaluate(() => {
    const game = window.__game;
    return {
      configSeed: game.raceConfig.seed,
      sessionSeed: game.session.seed,
      qualityBound: !!game.quality.composer &&
        game.quality.composer === game.composer &&
        game.quality.gtao === game.gtao &&
        game.quality.bloom === game.bloom &&
        game.quality.sun === game.sun,
    };
  });
  expect(restarted).toEqual({
    configSeed: initial.generatedSeed,
    sessionSeed: initial.generatedSeed,
    qualityBound: true,
  });

  const afterTeardown = await page.evaluate(() => {
    const game = window.__game;
    const materialDisposals = { gtao: 0, blend: 0 };
    game.gtao.gtaoMaterial.addEventListener('dispose', () => { materialDisposals.gtao++; });
    game.gtao.blendMaterial.addEventListener('dispose', () => { materialDisposals.blend++; });
    game.teardownSession();
    return {
      quality: [game.quality.composer, game.quality.gtao, game.quality.bloom, game.quality.sun],
      game: [game.composer, game.gtao, game.bloom, game.fxaa, game.sun],
      materialDisposals,
    };
  });
  expect(afterTeardown).toEqual({
    quality: [null, null, null, null],
    game: [null, null, null, null, null],
    materialDisposals: { gtao: 1, blend: 1 },
  });
  expect(errors).toEqual([]);
});

test('adaptive renderer, smoke exclusion, and WebGL recovery work in a live session', async ({ page }) => {
  const errors = await boot(page);
  await chooseDriverAndTrack(page);
  await page.waitForFunction(() => window.__game?.renderTelemetry.frame.count > 0);
  const liveState = await page.evaluate(() => {
    const game = window.__game;
    const p = game.session.player;
    game.effects._emitSmoke(p.phys.pos.x, (p.renderY || 0) + 0.4, p.phys.pos.z);
    game.audio.passBy(-1, 0.8);
    return {
      nativeAntialias: game.renderer.getContext().getContextAttributes()?.antialias,
      excluded: game.effects.smoke.every(item => item.sprite.userData.gtaoExcluded === true),
      proceduralPassBy: game.audio.ready && game.audio._lastPass > 0,
    };
  });
  expect(liveState.nativeAntialias).toBe(false);
  expect(liveState.excluded).toBe(true);
  expect(liveState.proceduralPassBy).toBe(true);

  const nextTelemetry = async (afterCount) => {
    await page.waitForFunction(
      count => window.__game.renderTelemetry.frame.count > count,
      afterCount,
    );
    return page.evaluate(() => window.__game.renderTelemetry);
  };
  const beforeLow = await page.evaluate(() => {
    window.__game.quality.setMode('low');
    return window.__game.renderTelemetry.frame.count;
  });
  const lowTelemetry = await nextTelemetry(beforeLow);
  const beforeHigh = await page.evaluate(() => {
    window.__game.quality.setMode('high');
    return window.__game.renderTelemetry.frame.count;
  });
  const highTelemetry = await nextTelemetry(beforeHigh);
  const nextHighTelemetry = await nextTelemetry(highTelemetry.frame.count);
  const beforeAuto = await page.evaluate(() => {
    window.__game.quality.setMode('auto');
    return window.__game.renderTelemetry.frame.count;
  });
  const autoTelemetry = await nextTelemetry(beforeAuto);

  expect(lowTelemetry.quality.composerPixelRatio).toBe(lowTelemetry.quality.pixelRatio);
  expect(highTelemetry.quality.composerPixelRatio).toBe(highTelemetry.quality.pixelRatio);
  expect(lowTelemetry.quality.pixelRatio).toBeLessThanOrEqual(highTelemetry.quality.pixelRatio);
  expect(highTelemetry.frame.count).toBeGreaterThan(lowTelemetry.frame.count);
  expect(highTelemetry.frame.smoothedMs).toBeGreaterThan(0);
  expect(highTelemetry.renderer.autoReset).toBe(false);
  expect(lowTelemetry.renderer.calls).toBeGreaterThan(100);
  expect(lowTelemetry.renderer.triangles).toBeGreaterThan(100_000);
  expect(highTelemetry.renderer.calls).toBeGreaterThan(200);
  expect(highTelemetry.renderer.triangles).toBeGreaterThan(200_000);
  expect(highTelemetry.renderer.calls).toBeGreaterThan(lowTelemetry.renderer.calls * 1.5);
  expect(highTelemetry.renderer.triangles).toBeGreaterThan(lowTelemetry.renderer.triangles * 1.5);
  expect(nextHighTelemetry.renderer.calls).toBeGreaterThan(highTelemetry.renderer.calls * 0.75);
  expect(nextHighTelemetry.renderer.calls).toBeLessThan(highTelemetry.renderer.calls * 1.25);
  expect(nextHighTelemetry.renderer.triangles).toBeGreaterThan(highTelemetry.renderer.triangles * 0.75);
  expect(nextHighTelemetry.renderer.triangles).toBeLessThan(highTelemetry.renderer.triangles * 1.25);
  expect(highTelemetry.targets.composer).toEqual(highTelemetry.targets.drawingBuffer);
  expect(highTelemetry.targets.gtao.width).toBeLessThan(highTelemetry.targets.composer.width);
  expect(highTelemetry.targets.gtao.height).toBeLessThan(highTelemetry.targets.composer.height);
  expect(highTelemetry.targets.gtao.scale).toBe(0.5);
  expect(highTelemetry.passes.fxaa).toBe(true);
  expect(highTelemetry.passes.fxaaResolution.x).toBeCloseTo(
    1 / highTelemetry.targets.composer.width,
    12,
  );
  expect(highTelemetry.passes.fxaaResolution.y).toBeCloseTo(
    1 / highTelemetry.targets.composer.height,
    12,
  );
  expect(['low', 'medium', 'high']).toContain(autoTelemetry.quality.tier);
  expect(autoTelemetry.quality.mode).toBe('auto');
  expect(autoTelemetry.renderer.calls).toBeGreaterThan(100);
  expect(autoTelemetry.renderer.triangles).toBeGreaterThan(100_000);
  await expect(page.locator('#app canvas')).toBeVisible();

  const canLose = await page.evaluate(() => {
    const gl = document.querySelector('#app canvas')?.getContext('webgl2');
    window.__testLoseContext = gl?.getExtension('WEBGL_lose_context') || null;
    window.__testLoseContext?.loseContext();
    return !!window.__testLoseContext;
  });
  if (canLose) {
    await expect(page.locator('#graphics-recovery')).toContainText('GRAPHICS RESET DETECTED');
    await expect.poll(() => page.evaluate(() => ({
      lost: window.__game.renderTelemetry.context.lost,
      paused: window.__game.paused,
    }))).toEqual({ lost: true, paused: true });
    await page.evaluate(() => window.__testLoseContext.restoreContext());
    await expect(page.locator('#graphics-recovery')).toHaveCount(0);
    await expect.poll(() => page.evaluate((autoFrameCount) => {
      const game = window.__game;
      const telemetry = game.renderTelemetry;
      return telemetry.context.restores === 1 &&
        telemetry.frame.count > autoFrameCount &&
        telemetry.renderer.calls > 100 && !game.paused;
    }, autoTelemetry.frame.count)).toBe(true);
    const recovery = await page.evaluate(() => window.__game.renderTelemetry);
    expect(recovery.context).toEqual({ lost: false, losses: 1, restores: 1 });
    expect(recovery.quality.composerPixelRatio).toBe(recovery.quality.pixelRatio);
    expect(recovery.renderer.autoReset).toBe(false);
    expect(recovery.renderer.calls).toBeGreaterThan(100);
    expect(recovery.renderer.triangles).toBeGreaterThan(100_000);

    await page.evaluate(() => {
      const game = window.__game;
      game.togglePause(true);
      window.__pausedLossFrame = game.renderTelemetry.frame.count;
      window.__testLoseContext.loseContext();
    });
    await expect(page.locator('#graphics-recovery')).toContainText('GRAPHICS RESET DETECTED');
    await page.evaluate(() => window.__testLoseContext.restoreContext());
    await expect(page.locator('#graphics-recovery')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const game = window.__game;
      const telemetry = game.renderTelemetry;
      return telemetry.context.restores === 2 &&
        telemetry.frame.count > window.__pausedLossFrame &&
        telemetry.renderer.calls > 100 && game.paused;
    })).toBe(true);
    const pausedRecovery = await page.evaluate(() => ({
      paused: window.__game.paused,
      telemetry: window.__game.renderTelemetry,
    }));
    expect(pausedRecovery.paused).toBe(true);
    expect(pausedRecovery.telemetry.context).toEqual({ lost: false, losses: 2, restores: 2 });
    expect(pausedRecovery.telemetry.renderer.autoReset).toBe(false);
    expect(pausedRecovery.telemetry.renderer.calls).toBeGreaterThan(100);
    expect(pausedRecovery.telemetry.renderer.triangles).toBeGreaterThan(100_000);
  }
  expect(errors).toEqual([]);
});

test('stored personal best creates a ghost and populates the live delta HUD', async ({ page }) => {
  const errors = await boot(page);
  await chooseDriverAndTrack(page, 'TIME TRIAL', async () => {
    await page.evaluate(() => localStorage.setItem('apexf1_tt_v1:melbourne:hacker', JSON.stringify({
      version: 1, trackId: 'melbourne', driverId: 'hacker', lap: 81.234,
      sectors: [27, 27, 27.234], savedAt: new Date().toISOString(),
      frames: [[0, 0, 0, 0, 0, 0], [81.234, 0, 0, 0, 0, 5278]],
    })));
  });
  await expect(page.locator('#t-best')).toHaveText('1:21.234');
  await expect(page.locator('#tt-delta-box')).toBeVisible();
  const ghost = await page.evaluate(() => ({
    best: window.__game.timeTrial?.personalBest,
    exists: !!window.__game.scene.getObjectByName('personal-best-ghost'),
  }));
  expect(ghost).toEqual({ best: 81.234, exists: true });
  expect(errors).toEqual([]);
});

test('@mobile first-run guide, HUD, and touch controls fit the viewport and accept real touch input', async ({ page, context }) => {
  const errors = await boot(page, {});
  const bodyWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client + 1);
  await chooseDriverAndTrack(page, 'TIME TRIAL');
  await expect(page.locator('#onboarding')).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#onboarding')).toHaveClass(/active/);
  await expect(page.locator('#screen-pause')).not.toHaveClass(/active/);
  expect(await page.evaluate(() => ({
    onboarding: window.__game.onboardingActive,
    paused: window.__game.paused,
  }))).toEqual({ onboarding: true, paused: true });
  await page.getByRole('button', { name: /START DRIVING/ }).click();
  await expect(page.locator('#touch-controls')).toHaveClass(/enabled/);
  await expect(page.locator('#minimap')).toBeHidden();
  const layout = await page.evaluate(() => {
    const viewport = { w: innerWidth, h: innerHeight };
    const bounds = [...document.querySelectorAll('#touch-controls button')].map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const timing = document.querySelector('#timing').getBoundingClientRect();
    return { viewport, bounds, timing: { left: timing.left, right: timing.right } };
  });
  for (const r of layout.bounds) {
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(layout.viewport.w + 1);
    expect(r.bottom).toBeLessThanOrEqual(layout.viewport.h + 1);
  }
  expect(layout.timing.left).toBeGreaterThanOrEqual(0);
  expect(layout.timing.right).toBeLessThanOrEqual(layout.viewport.w + 1);

  const throttle = page.locator('[data-touch="throttle"]');
  const box = await throttle.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => {
    window.__throttlePointerEvents = [];
    const button = document.querySelector('[data-touch="throttle"]');
    for (const type of ['pointerdown', 'pointerup']) {
      button.addEventListener(type, event => window.__throttlePointerEvents.push({
        type: event.type,
        pointerType: event.pointerType,
        trusted: event.isTrusted,
      }));
    }
  });

  const cdp = await context.newCDPSession(page);
  const touch = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    id: 1,
    radiusX: 1,
    radiusY: 1,
    force: 1,
  };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  try {
    await page.waitForFunction(() =>
      window.__game.hud.touchState.throttle === true &&
      window.__game.session.player.phys.throttle > 0.1);
    const held = await page.evaluate(() => ({
      touch: window.__game.hud.touchState.throttle,
      pressed: document.querySelector('[data-touch="throttle"]').classList.contains('pressed'),
      sampledThrottle: window.__game.playerInput(1 / 60).throttle,
      physicalThrottle: window.__game.session.player.phys.throttle,
    }));
    expect(held.touch).toBe(true);
    expect(held.pressed).toBe(true);
    expect(held.sampledThrottle).toBe(1);
    expect(held.physicalThrottle).toBeGreaterThan(0.1);
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  await page.waitForFunction(() =>
    window.__game.hud.touchState.throttle === false &&
    window.__game.session.player.phys.throttle < 0.1);
  const released = await page.evaluate(() => ({
    touch: window.__game.hud.touchState.throttle,
    pressed: document.querySelector('[data-touch="throttle"]').classList.contains('pressed'),
    sampledThrottle: window.__game.playerInput(1 / 60).throttle,
    physicalThrottle: window.__game.session.player.phys.throttle,
    events: window.__throttlePointerEvents,
  }));
  expect(released.touch).toBe(false);
  expect(released.pressed).toBe(false);
  expect(released.sampledThrottle).toBe(0);
  expect(released.physicalThrottle).toBeLessThan(0.1);
  expect(released.events).toEqual([
    { type: 'pointerdown', pointerType: 'touch', trusted: true },
    { type: 'pointerup', pointerType: 'touch', trusted: true },
  ]);
  expect(errors).toEqual([]);
});
