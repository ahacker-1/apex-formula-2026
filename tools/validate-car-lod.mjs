#!/usr/bin/env node
// Focused headless acceptance for the renderer-only AI car LOD.

const noop = () => {};
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '',
  fillRect: noop, clearRect: noop, beginPath: noop, arc: noop, fill: noop, stroke: noop,
  moveTo: noop, lineTo: noop, quadraticCurveTo: noop, closePath: noop, arcTo: noop,
  fillText: noop, strokeText: noop, createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }), measureText: () => ({ width: 10 }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  ellipse: noop, bezierCurveTo: noop, setTransform: noop, drawImage: noop,
});
globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: ctxStub }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const THREE = await import('../lib/three.module.js');
const CAR = await import('../js/car.js');
const { RaceSession, CAR_LOD_SPEC, resolveCarLod } = await import('../js/race.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { DRIVERS, TEAMS } = await import('../js/data.js');
const { createRandom } = await import('../js/random.js');

let passed = 0, failed = 0;
function check(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  [${detail}]` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
  }
}
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

function visibleMeshStats(root, includeBrake = false) {
  let draws = 0, triangles = 0, textures = 0;
  root.traverse((object) => {
    if (!object.isMesh || (!object.visible && !(includeBrake && object.name === 'distantBrakeGlow'))) return;
    draws++;
    const geometry = object.geometry;
    triangles += geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute('position').count / 3;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const key of ['map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap']) {
        if (material?.[key]) textures++;
      }
    }
  });
  return { draws, triangles, textures };
}

function colourPresent(attribute, color) {
  const target = new THREE.Color(color);
  for (let i = 0; i < attribute.count; i++) {
    if (near(attribute.getX(i), target.r, 1e-6)
        && near(attribute.getY(i), target.g, 1e-6)
        && near(attribute.getZ(i), target.b, 1e-6)) return true;
  }
  return false;
}

console.log('\n[car-lod] proxy budgets and identity');
const team = TEAMS[0];
const hero = CAR.buildPrimitiveCarMesh(team, DRIVERS.find((driver) => driver.team === team.id));
const proxy = hero.farProxy;
const steady = visibleMeshStats(proxy.root);
const braking = visibleMeshStats(proxy.root, true);
check(hero.nearGroup.visible && !proxy.root.visible && hero.lodLevel === 'full',
  'standalone/hero construction remains full fidelity until a race updater opts in');
check(steady.draws === CAR.DISTANT_CAR_BUDGET.steadyDrawCalls,
  'steady proxy hits the seven-call target', `draws=${steady.draws}`);
check(braking.draws === CAR.DISTANT_CAR_BUDGET.brakingDrawCalls,
  'braking proxy adds exactly one call', `draws=${braking.draws}`);
check(braking.triangles <= CAR.DISTANT_CAR_BUDGET.maxTriangles,
  'braking proxy stays under the triangle ceiling', `triangles=${braking.triangles}`);
check(steady.textures === 0 && braking.textures === 0 && proxy.stats.textures === 0,
  'proxy adds zero dedicated texture maps');
check(steady.triangles === proxy.stats.steadyTriangles
    && braking.triangles === proxy.stats.brakingTriangles,
  'published proxy metrics match traversed geometry',
  `steady=${steady.triangles} braking=${braking.triangles}`);
check(Object.keys(proxy.wheels).join(',') === 'fl,fr,rl,rr'
    && new Set(Object.values(proxy.wheels)).size === 4,
  'proxy exposes four independent low-poly wheel transforms');
const colours = proxy.body.geometry.getAttribute('color');
check(!!colours && colourPresent(colours, team.color)
    && colourPresent(colours, team.accent) && colourPresent(colours, 0x1c2027),
  'one vertex-coloured body draw retains body, accent, and carbon identity');
const sibling = CAR.buildPrimitiveCarMesh(team, DRIVERS.filter((driver) => driver.team === team.id)[1]);
check(proxy.body.geometry === sibling.farProxy.body.geometry
    && proxy.body.material === sibling.farProxy.body.material,
  'same-team proxy geometry and stateless material are cached/shared');
check(proxy.brakeGlows[0].material !== sibling.farProxy.brakeGlows[0].material,
  'per-car brake opacity keeps exact independent ownership');

console.log('\n[car-lod] 55m / 45m hysteresis');
check(resolveCarLod('full', 54.999) === 'full' && resolveCarLod('full', 55) === 'far',
  'full detail switches out at exactly 55m');
check(resolveCarLod('far', 45.001) === 'far' && resolveCarLod('far', 45) === 'full',
  'far detail returns at exactly 45m');
check(resolveCarLod('full', 10_000, true) === 'full'
    && resolveCarLod('far', 10_000, false, 'forced-full') === 'full',
  'player pin and forced-full override distance');
check(near(CAR_LOD_SPEC.hysteresis, 10 / 55)
    && CAR_LOD_SPEC.cadenceMs === 100 && CAR_LOD_SPEC.cadenceHz === 10,
  'spec publishes 18.18% hysteresis and 10Hz cadence',
  `hysteresis=${(CAR_LOD_SPEC.hysteresis * 100).toFixed(2)}%`);

function makeSession(random) {
  const scene = new THREE.Scene();
  const circuit = buildCircuit('monza', TRACKS.monza, scene);
  const session = new RaceSession({
    scene, circuit,
    playerDriverId: DRIVERS[0].id,
    laps: 3, difficulty: 1,
    assists: { tc: true, abs: true, autoGear: true },
    mode: 'race',
    onMessage: noop,
    random,
  });
  return { scene, circuit, session };
}

console.log('\n[car-lod] race switching, animation, lights, and telemetry');
const random = createRandom(0x1a2b3c4d);
const first = makeSession(random);
const session = first.session;
const target = session.entries.find((entry) => !entry.isPlayer);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
const randomBefore = random.state;
const physicsBefore = JSON.stringify(session.entries.map((entry) => ({
  x: entry.phys.pos.x, z: entry.phys.pos.z, heading: entry.phys.heading,
  v: entry.phys.v, sampleIdx: entry.phys.sampleIdx,
})));

camera.position.set(target.mesh.position.x + 60, target.mesh.position.y, target.mesh.position.z);
session.updateCarLod(camera, 0);
check(target.lodLevel === 'far' && target.carHandle.farProxy.root.visible
    && !target.carHandle.nearGroup.visible && !target.contactShadow.visible,
  'automatic pass shows proxy and consolidated shadow beyond 55m');
check(target.tag.parent === target.mesh,
  'nametag remains an outer root child across detail switches');
const updatesAtZero = session.carLodTelemetry.updates;
camera.position.x = target.mesh.position.x + 44;
session.updateCarLod(camera, 99);
check(target.lodLevel === 'far' && session.carLodTelemetry.updates === updatesAtZero,
  'camera movement inside the 100ms cadence window does not churn LOD');
session.updateCarLod(camera, 100);
check(target.lodLevel === 'full' && target.contactShadow.visible,
  'next 10Hz sample returns to full detail inside 45m');

camera.position.set(session.player.mesh.position.x + 500,
  session.player.mesh.position.y, session.player.mesh.position.z);
session.updateCarLod(camera, 200);
check(session.player.lodLevel === 'full' && session.carLodTelemetry.playerPinnedFull,
  'player stays full fidelity at every camera distance');
check(random.state === randomBefore && JSON.stringify(session.entries.map((entry) => ({
  x: entry.phys.pos.x, z: entry.phys.pos.z, heading: entry.phys.heading,
  v: entry.phys.v, sampleIdx: entry.phys.sampleIdx,
}))) === physicsBefore,
  'LOD pass changes neither simulation state nor RNG state');

session._setEntryCarLod(target, 'far');
target.phys.steer = 0.75;
target.phys.pitch = 0.12;
target.phys.roll = -0.08;
target.phys.rideBump = 0.04;
target.phys.brakeTemp = 1000;
target.phys.brake = 1;
target.phys.throttle = 0;
target.phys.v = 60;
target.wheelSpin = 7.25;
session._syncMesh(target);
const farWheels = target.carHandle.farProxy.wheels;
const farBody = target.carHandle.farProxy.body;
check(Object.values(farWheels).every((wheel) => near(wheel.rotation.x, 7.25))
    && near(farWheels.fl.rotation.y, 0.75 * 0.32)
    && near(farWheels.fr.rotation.y, 0.75 * 0.32)
    && near(farWheels.rl.rotation.y, 0) && near(farWheels.rr.rotation.y, 0),
  'all far wheels spin independently and only front wheels steer');
check(near(farBody.rotation.x, 0.12) && near(farBody.rotation.z, -0.08)
    && near(farBody.position.y, 0.04),
  'far body follows pitch, roll, and ride animation');
check(target.carHandle.farProxy.brakeGlows[0].visible
    && target.carHandle.farProxy.brakeGlows[0].material.opacity > 0.95,
  'far brake mesh preserves hot-disc glow semantics');
check(target.carHandle.farProxy.rainLight.visible === target.carHandle.rainLight.visible,
  'far rain light matches the live near-car blink state');

const forced = session.setCarLodMode('forced-full');
check(forced.mode === 'forced-full' && forced.far === 0 && forced.full === session.entries.length,
  'forced-full telemetry reports every entry at full fidelity');
session.setCarLodMode('automatic');
camera.position.set(target.mesh.position.x + 60, target.mesh.position.y, target.mesh.position.z);
session.updateCarLod(camera, 300);
const automatic = session.carLodTelemetry;
check(automatic.mode === 'automatic' && automatic.far > 0 && automatic.playerPinnedFull,
  'automatic telemetry reports active far cars and the player pin');

console.log('\n[car-lod] hidden disposal and restart ownership');
const oldSharedGeometry = session.player.carHandle.farProxy.body.geometry;
const oldSharedMaterial = session.player.carHandle.farProxy.body.material;
const oldOwnedBrake = session.player.carHandle.farProxy.brakeGlows[0].material;
let sharedGeometryDisposals = 0, sharedMaterialDisposals = 0, ownedBrakeDisposals = 0;
oldSharedGeometry.addEventListener('dispose', () => { sharedGeometryDisposals++; });
oldSharedMaterial.addEventListener('dispose', () => { sharedMaterialDisposals++; });
oldOwnedBrake.addEventListener('dispose', () => { ownedBrakeDisposals++; });
session.dispose();
session.dispose();
check(ownedBrakeDisposals === 1,
  'hidden proxy per-car brake material is disposed exactly once');
check(sharedGeometryDisposals === 0 && sharedMaterialDisposals === 0,
  'hidden proxy shared geometry/material remain module-owned');
check(session.entries.every((entry) => entry.carHandle.disposed && !entry.mesh.parent),
  'teardown releases upgrade registrations and detaches every car');
first.circuit.dispose();

const secondRandom = createRandom(0x1a2b3c4d);
const second = makeSession(secondRandom);
check(second.session.player.carHandle.farProxy.body.geometry === oldSharedGeometry
    && second.session.player.carHandle.farProxy.body.material === oldSharedMaterial,
  'restart reuses intact shared proxy resources');
check(second.session.player.carHandle.farProxy.brakeGlows[0].material !== oldOwnedBrake,
  'restart receives fresh per-car stateful brake ownership');
second.session.dispose();
second.circuit.dispose();

console.log(failed === 0
  ? `\nALL CAR LOD CHECKS PASSED: ${passed}/${passed + failed}`
  : `\nCAR LOD CHECKS FAILED: ${failed} of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
