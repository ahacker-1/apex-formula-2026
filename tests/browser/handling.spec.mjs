import { test, expect } from '@playwright/test';

async function bootHandling(page) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_last_race', JSON.stringify({
      driverId: 'hacker',
      trackId: 'melbourne',
    }));
    // Keep the production Game instance and input path, but make the test the
    // sole owner of simulation ticks.
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: /RACE NOW/ }).click();
  await page.waitForFunction(
    () => window.__game?.state === 'race' && window.__game.session?.player,
    null,
    { timeout: 30_000, polling: 50 },
  );
  return errors;
}

test('arrow steering responds quickly and wins over dormant controller drift', async ({ page }) => {
  const errors = await bootHandling(page);
  const dt = 1 / 60;

  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(() => window.__game.keys.ArrowLeft === true);
  const left = await page.evaluate((fixedDt) => {
    const game = window.__game;
    const phys = game.session.player.phys;
    phys.v = 50;
    game.keySteer = 0;
    const samples = [];
    for (let frame = 1; frame <= 60; frame++) {
      const steer = game.playerInput(fixedDt).steer;
      if (frame === 12 || frame === 30 || frame === 60) samples.push(steer);
    }
    return samples;
  }, dt);
  expect(left[0]).toBeGreaterThanOrEqual(0.4);
  expect(left[1]).toBeGreaterThanOrEqual(0.75);
  expect(left[2]).toBeGreaterThanOrEqual(0.94);

  await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('ArrowRight');
  const reversal = await page.evaluate((fixedDt) => {
    const game = window.__game;
    let crossed = null;
    for (let frame = 1; frame <= 60; frame++) {
      const steer = game.playerInput(fixedDt).steer;
      if (crossed === null && steer <= 0) crossed = frame * fixedDt;
    }
    return crossed;
  }, dt);
  expect(reversal).not.toBeNull();
  expect(reversal).toBeLessThanOrEqual(0.3);

  await page.keyboard.up('ArrowRight');
  const release = await page.evaluate((fixedDt) => {
    const game = window.__game;
    let below = null;
    for (let frame = 1; frame <= 60; frame++) {
      const steer = Math.abs(game.playerInput(fixedDt).steer);
      if (below === null && steer <= 0.2) below = frame * fixedDt;
    }
    return below;
  }, dt);
  expect(release).not.toBeNull();
  expect(release).toBeLessThanOrEqual(0.4);

  await page.keyboard.down('ArrowLeft');
  const driftPrecedence = await page.evaluate((fixedDt) => {
    const game = window.__game;
    const ownGetGamepads = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    const buttons = Array.from({ length: 8 }, () => ({ value: 0, pressed: false }));
    try {
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => [{ axes: [0.081], buttons }],
      });
      game._gamepadNeedsNeutral = false;
      game.keySteer = 0;
      let steer = 0;
      for (let frame = 0; frame < 30; frame++) steer = game.playerInput(fixedDt).steer;
      return steer;
    } finally {
      if (ownGetGamepads) Object.defineProperty(navigator, 'getGamepads', ownGetGamepads);
      else delete navigator.getGamepads;
    }
  }, dt);
  await page.keyboard.up('ArrowLeft');
  expect(driftPrecedence).toBeGreaterThanOrEqual(0.75);
  expect(errors).toEqual([]);
});

test('typed impact audio keeps a pooled scrape bed and clean procedural fallbacks', async ({ page }) => {
  const errors = await bootHandling(page);
  const result = await page.evaluate(async () => {
    const audio = window.__game.audio;
    audio.init();
    if (audio.ctx?.state === 'suspended') await audio.ctx.resume();
    const refs = [audio.contactScrapeBP, audio.contactScrapeGain, audio.contactScrapePan];
    const base = {
      rpmFrac: 0.6, throttle: 0.4, brake: 0, speed: 42, gear: 5,
      slip: false, kerb: false, boost: false, offtrack: false,
    };
    for (let i = 0; i < 30; i++) {
      audio.update(1 / 60, { ...base, wallScrape: 0.8, carScrape: 0, contactSide: -1 });
    }
    await new Promise(resolve => setTimeout(resolve, 80));
    const activeGain = audio.contactScrapeGain?.gain?.value ?? -1;
    const activePan = audio.contactScrapePan?.pan?.value ?? 0;
    const sameGraph = refs[0] === audio.contactScrapeBP &&
      refs[1] === audio.contactScrapeGain && refs[2] === audio.contactScrapePan;

    audio.wallImpact({ intensity: 0.9, normalSpeed: 34, side: -1 });
    audio.carImpact({ intensity: 0.55, closingSpeed: 10.4, side: 1 });
    audio.update(1 / 60, { ...base, wallScrape: 0, carScrape: 0, contactSide: 0 });
    await new Promise(resolve => setTimeout(resolve, 180));
    const releasedGain = audio.contactScrapeGain?.gain?.value ?? -1;
    return {
      ready: audio.ready,
      sameGraph,
      activeGain,
      activePan,
      releasedGain,
      wallCooldown: audio._wallImpactCooldown,
      carCooldown: audio._carImpactCooldown,
    };
  });

  expect(result.ready).toBe(true);
  expect(result.sameGraph).toBe(true);
  expect(result.activeGain).toBeGreaterThan(0.05);
  expect(result.activePan).toBeLessThan(-0.2);
  expect(result.releasedGain).toBeLessThan(result.activeGain * 0.4);
  expect(result.wallCooldown).toBeGreaterThanOrEqual(0);
  expect(result.carCooldown).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('real wall and car incidents reach the typed audio hooks through the game loop', async ({ page }) => {
  const errors = await bootHandling(page);
  const result = await page.evaluate(() => {
    const game = window.__game;
    const session = game.session;
    const player = session.player;
    const calls = { wall: [], car: [] };
    game.audio.wallImpact = event => calls.wall.push({ ...event });
    game.audio.carImpact = event => calls.car.push({ ...event });

    session.phase = 'racing';
    session.results = null;
    game.state = 'race';
    game.paused = false;
    for (const entry of session.entries) {
      entry.dnf = false;
      entry.finished = false;
      entry.pitState = null;
      entry.phys.disabled = !entry.isPlayer;
    }

    const idx = player.phys.sampleIdx;
    const sample = game.circuit.samples[idx];
    const trackHeading = Math.atan2(sample.t.x, sample.t.z);
    const wallPosition = sample.p.clone().addScaledVector(sample.n, game.circuit.wallOff - 2.48 + 0.08);
    player.phys.placeAt(wallPosition, trackHeading + Math.PI / 2, idx);
    player.phys.v = 32;
    player.phys.disabled = false;
    game.fixedStep.reset();
    game.clock.getDelta = () => 1 / 60;
    game.loop();

    const target = session.entries.find(entry => !entry.isPlayer);
    for (const entry of session.entries) entry.phys.disabled = entry !== player && entry !== target;
    player.phys.placeAt(sample.p.clone(), trackHeading, idx);
    player.phys.v = 42;
    player.phys._wallIncidentSide = 0;
    target.phys.placeAt(sample.p.clone().addScaledVector(sample.t, 4.5), trackHeading, idx);
    target.phys.v = 20;
    target.phys.disabled = false;
    session._activeContacts.clear();
    session._impactingContacts.clear();
    session._touchEvent = 0;
    game.fixedStep.reset();
    game.loop();

    return calls;
  });

  expect(result.wall).toHaveLength(1);
  expect(result.wall[0].normalSpeed).toBeGreaterThan(25);
  expect(result.wall[0].intensity).toBeGreaterThan(0.7);
  expect(result.car).toHaveLength(1);
  expect(result.car[0].closingSpeed).toBeGreaterThan(15);
  expect(result.car[0].intensity).toBeGreaterThan(0.7);
  expect(errors).toEqual([]);
});
