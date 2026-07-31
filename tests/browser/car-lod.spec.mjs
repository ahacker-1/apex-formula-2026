import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_settings', JSON.stringify({ quali: false }));
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(message.text());
    }
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /QUICK RACE/ })).toBeVisible();
  return errors;
}

async function startRace(page) {
  await page.getByRole('button', { name: /QUICK RACE/ }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();
  await expect(page.locator('.track-card[data-t="melbourne"]')).toBeVisible();
  await page.locator('.track-card[data-t="melbourne"]').click();
  await page.waitForFunction(
    () => window.__game?.state === 'race' && window.__game.session,
    null,
    { timeout: 30_000, polling: 50 },
  );
}

async function nextRenderedTelemetry(page, afterCount, frames = 2) {
  await page.waitForFunction(
    ({ count, frames }) => window.__game.renderTelemetry.frame.count >= count + frames,
    { count: afterCount, frames },
  );
  return page.evaluate(() => window.__game.renderTelemetry);
}

test('live GLB race LOD saves render work, covers every camera, and restarts cleanly', async ({ page }) => {
  const errors = await boot(page);
  await startRace(page);
  await page.waitForFunction(() => window.__game.session.entries.every(entry => entry.carHandle.source === 'glb'));

  const cameraModes = await page.evaluate(async () => {
    const THREE = await import('/lib/three.module.js');
    const game = window.__game;
    if (!game.paused) game.togglePause(true);
    const session = game.session;
    const target = session.entries.find(entry => !entry.isPlayer);
    const out = [];
    for (const mode of [0, 1, 2]) {
      game.camMode = mode;
      game.snapCamera();
      const forward = game.camera.getWorldDirection(new THREE.Vector3());
      target.mesh.position.copy(game.camera.position).addScaledVector(forward, 60);
      session.setCarLodMode('automatic');
      session.updateCarLod(game.camera, 1_000 + mode * 100);
      const telemetry = session.carLodTelemetry;
      out.push({
        mode,
        target: target.lodLevel,
        player: session.player.lodLevel,
        playerPinnedFull: telemetry.playerPinnedFull,
        playerHasProxy: !!session.player.carHandle.farProxy,
      });
    }
    return out;
  });
  expect(cameraModes).toEqual([
    { mode: 0, target: 'far', player: 'full', playerPinnedFull: true, playerHasProxy: false },
    { mode: 1, target: 'far', player: 'full', playerPinnedFull: true, playerHasProxy: false },
    { mode: 2, target: 'far', player: 'full', playerPinnedFull: true, playerHasProxy: false },
  ]);

  const beforeForced = await page.evaluate(async () => {
    const THREE = await import('/lib/three.module.js');
    const game = window.__game;
    game.camMode = 0;
    game.snapCamera();
    const forward = game.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(game.camera.matrixWorld, 0);
    const ais = game.session.entries.filter(entry => !entry.isPlayer);
    ais.forEach((entry, index) => {
      entry.mesh.position.copy(game.camera.position)
        .addScaledVector(forward, 70 + (index % 3) * 5)
        .addScaledVector(right, (index % 7 - 3) * 1.7);
    });
    game.session.setCarLodMode('forced-full');
    game.session.updateCarLod(game.camera, 2_000);
    return game.renderTelemetry.frame.count;
  });
  const forced = await nextRenderedTelemetry(page, beforeForced, 3);

  const beforeAutomatic = await page.evaluate(() => {
    const game = window.__game;
    game.session.setCarLodMode('automatic');
    game.session.updateCarLod(game.camera, 2_100);
    return game.renderTelemetry.frame.count;
  });
  const automatic = await nextRenderedTelemetry(page, beforeAutomatic, 3);
  expect(forced.carLod.mode).toBe('forced-full');
  expect(forced.carLod.far).toBe(0);
  expect(automatic.carLod.mode).toBe('automatic');
  expect(automatic.carLod.far).toBe(21);
  expect(automatic.carLod.playerPinnedFull).toBe(true);
  expect(automatic.renderer.calls).toBeLessThan(forced.renderer.calls);
  expect(automatic.renderer.triangles).toBeLessThan(forced.renderer.triangles);

  const brakePixels = await page.evaluate(async () => {
    const THREE = await import('/lib/three.module.js');
    const game = window.__game;
    const session = game.session;
    const target = session.entries.find(entry => !entry.isPlayer);
    for (const entry of session.entries) entry.mesh.visible = entry === target;
    target.mesh.position.set(0, 0, 0);
    target.mesh.rotation.set(0, 0, 0);
    session._setEntryCarLod(target, 'far');
    target.carHandle.farProxy.rainLight.visible = false;
    const brake = target.carHandle.farProxy.brakeGlows[0];
    brake.material.opacity = 1;
    brake.material.color.setRGB(1, 0.08, 0.01);
    game.camera.position.set(8, 2.4, -8);
    game.camera.lookAt(0, 0.35, -0.2);
    game.camera.fov = 44;
    game.camera.updateProjectionMatrix();
    game.camera.updateMatrixWorld(true);

    const capture = (visible) => {
      brake.visible = visible;
      game.composer.render();
      const copy = document.createElement('canvas');
      copy.width = 720;
      copy.height = 450;
      const context = copy.getContext('2d', { willReadFrequently: true });
      context.drawImage(game.renderer.domElement, 0, 0, copy.width, copy.height);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const off = capture(false);
    const on = capture(true);
    let changed = 0, totalDelta = 0, maxDelta = 0;
    for (let i = 0; i < off.length; i += 4) {
      const delta = Math.abs(off[i] - on[i])
        + Math.abs(off[i + 1] - on[i + 1])
        + Math.abs(off[i + 2] - on[i + 2]);
      if (delta >= 12) changed++;
      totalDelta += delta;
      maxDelta = Math.max(maxDelta, delta);
    }
    return { changed, totalDelta, maxDelta };
  });
  expect(brakePixels.changed).toBeGreaterThan(20);
  expect(brakePixels.totalDelta).toBeGreaterThan(1_000);
  expect(brakePixels.maxDelta).toBeGreaterThan(40);
  console.log('car-lod browser metrics', JSON.stringify({
    forced: forced.renderer,
    automatic: automatic.renderer,
    brakePixels,
  }));

  const ownership = await page.evaluate(() => {
    const game = window.__game;
    const oldSession = game.session;
    const oldPlayer = oldSession.player;
    const oldAi = oldSession.entries.find(entry => !entry.isPlayer);
    const sharedGeometry = oldAi.carHandle.farProxy.body.geometry;
    const sharedMaterial = oldAi.carHandle.farProxy.body.material;
    const ownedBrake = oldAi.carHandle.farProxy.brakeGlows[0].material;
    const counts = { geometry: 0, material: 0, brake: 0 };
    sharedGeometry.addEventListener('dispose', () => { counts.geometry++; });
    sharedMaterial.addEventListener('dispose', () => { counts.material++; });
    ownedBrake.addEventListener('dispose', () => { counts.brake++; });
    window.__lodRestart = { oldSession, oldPlayer, oldAi, sharedGeometry, sharedMaterial, counts };
    game.onUI('restartRace');
    return true;
  });
  expect(ownership).toBe(true);
  await page.waitForFunction(
    () => window.__game.session && window.__game.session !== window.__lodRestart.oldSession,
    null,
    { timeout: 30_000, polling: 50 },
  );
  const restarted = await page.evaluate(() => {
    const state = window.__lodRestart;
    const nextPlayer = window.__game.session.player;
    const nextAi = window.__game.session.entries.find(entry => entry.driver.id === state.oldAi.driver.id);
    return {
      oldDisposed: state.oldPlayer.carHandle.disposed,
      oldDetached: state.oldPlayer.mesh.parent === null,
      counts: state.counts,
      playersHaveNoProxy: !state.oldPlayer.carHandle.farProxy && !nextPlayer.carHandle.farProxy,
      geometryReused: nextAi.carHandle.farProxy.body.geometry === state.sharedGeometry,
      materialReused: nextAi.carHandle.farProxy.body.material === state.sharedMaterial,
      ownedBrakeFresh: nextAi.carHandle.farProxy.brakeGlows[0].material
        !== state.oldAi.carHandle.farProxy.brakeGlows[0].material,
    };
  });
  expect(restarted).toEqual({
    oldDisposed: true,
    oldDetached: true,
    counts: { geometry: 0, material: 0, brake: 1 },
    playersHaveNoProxy: true,
    geometryReused: true,
    materialReused: true,
    ownedBrakeFresh: true,
  });
  expect(errors).toEqual([]);
});

test('primitive race upgrades late to GLB without disturbing near/far ownership or state', async ({ page }) => {
  let allowModel = false;
  await page.route('**/assets/f1car-2026.glb', route => {
    if (allowModel) route.continue();
    else route.abort('failed');
  });
  const errors = await boot(page);
  await startRace(page);
  await page.waitForFunction(() => window.__game.session.entries.every(entry => entry.carHandle.source === 'primitives'));

  const before = await page.evaluate(() => {
    const game = window.__game;
    if (!game.paused) game.togglePause(true);
    const session = game.session;
    const ais = session.entries.filter(entry => !entry.isPlayer);
    const far = ais[0], near = ais[1];
    session._setEntryCarLod(far, 'far');
    session._setEntryCarLod(near, 'full');
    far.phys.steer = 0.65;
    far.phys.roadWheelAngle = 0.13;
    far.phys.pitch = 0.11;
    far.phys.roll = -0.07;
    far.phys.rideBump = 0.035;
    far.phys.brakeTemp = 1000;
    far.phys.brake = 1;
    far.phys.throttle = 0;
    far.phys.v = 58;
    far.wheelSpin = 9.75;
    session._syncMesh(far);
    const supersededWall = far.carHandle.tyreBandMats.at(-1);
    const upgradeDisposals = { wall: 0 };
    supersededWall.addEventListener('dispose', () => { upgradeDisposals.wall++; });
    window.__lodUpgrade = {
      far, near,
      farRoot: far.mesh,
      nearRoot: near.mesh,
      farProxy: far.carHandle.farProxy.root,
      nearProxy: near.carHandle.farProxy.root,
      upgradeDisposals,
    };
    return {
      sources: [far.carHandle.source, near.carHandle.source],
      farVisibility: [far.carHandle.fullDetailRoots.every(root => root.visible), far.carHandle.farProxy.root.visible],
      nearVisibility: [near.carHandle.fullDetailRoots.every(root => root.visible), near.carHandle.farProxy.root.visible],
      tagOuter: far.tag.parent === far.mesh && near.tag.parent === near.mesh,
    };
  });
  expect(before).toEqual({
    sources: ['primitives', 'primitives'],
    farVisibility: [false, true],
    nearVisibility: [true, false],
    tagOuter: true,
  });

  allowModel = true;
  await page.evaluate(async () => {
    const car = await import('/js/car.js');
    await car.preloadCarModel();
  });
  await page.waitForFunction(() => window.__game.session.entries.every(entry => entry.carHandle.source === 'glb'));

  const after = await page.evaluate(() => {
    const refs = window.__lodUpgrade;
    const { far, near } = refs;
    const farWheels = far.carHandle.farProxy.wheels;
    return {
      rootsStable: far.mesh === refs.farRoot && near.mesh === refs.nearRoot,
      proxiesStable: far.carHandle.farProxy.root === refs.farProxy
        && near.carHandle.farProxy.root === refs.nearProxy,
      sources: [far.carHandle.source, near.carHandle.source],
      farVisibility: [far.carHandle.fullDetailRoots.every(root => root.visible), far.carHandle.farProxy.root.visible],
      nearVisibility: [near.carHandle.fullDetailRoots.every(root => root.visible), near.carHandle.farProxy.root.visible],
      directFullRoots: [far, near].every(entry =>
        entry.carHandle.fullDetailRoots.every(root => root.parent === entry.mesh)),
      nearPoseCarried: {
        spin: far.wheels.fl.rotation.x,
        steer: far.wheels.fl.rotation.y,
        pitch: far.carHandle.body.rotation.x,
        roll: far.carHandle.body.rotation.z,
        ride: far.carHandle.body.position.y,
      },
      farPoseStable: {
        spin: farWheels.fl.rotation.x,
        steer: farWheels.fl.rotation.y,
        pitch: far.carHandle.farProxy.body.rotation.x,
        roll: far.carHandle.farProxy.body.rotation.z,
        ride: far.carHandle.farProxy.body.position.y,
      },
      brakeState: [
        far.carHandle.brakeGlows.every(glow => glow.visible),
        far.carHandle.farProxy.brakeGlows.every(glow => glow.visible),
      ],
      rainStateMatches: far.carHandle.rainLight.visible === far.carHandle.farProxy.rainLight.visible,
      tagOuter: far.tag.parent === far.mesh && near.tag.parent === near.mesh,
      upgradeDisposals: refs.upgradeDisposals,
    };
  });
  expect(after.rootsStable).toBe(true);
  expect(after.proxiesStable).toBe(true);
  expect(after.sources).toEqual(['glb', 'glb']);
  expect(after.farVisibility).toEqual([false, true]);
  expect(after.nearVisibility).toEqual([true, false]);
  expect(after.directFullRoots).toBe(true);
  for (const pose of [after.nearPoseCarried, after.farPoseStable]) {
    expect(pose.spin).toBeCloseTo(9.75, 10);
    expect(pose.steer).toBeCloseTo(0.13, 10);
    expect(pose.pitch).toBeCloseTo(0.11, 10);
    expect(pose.roll).toBeCloseTo(-0.07, 10);
    expect(pose.ride).toBeCloseTo(0.035, 10);
  }
  expect(after.brakeState).toEqual([true, true]);
  expect(after.rainStateMatches).toBe(true);
  expect(after.tagOuter).toBe(true);
  expect(after.upgradeDisposals).toEqual({ wall: 1 });
  expect(errors).toEqual([]);
});
