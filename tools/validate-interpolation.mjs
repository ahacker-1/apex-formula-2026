// Pure/headless acceptance checks for RaceSession render interpolation.
//
// Usage: node tools/validate-interpolation.mjs

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

const {
  RaceSession,
  clampRenderAlpha,
  interpolateRenderSnapshot,
  shortestAngleDelta,
} = await import('../js/race.js');

let passed = 0;
let failed = 0;
const near = (a, b, tolerance = 1e-10) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
const angleNear = (a, b, tolerance = 1e-10) =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= tolerance;
function check(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  [${detail}]` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
  }
}
function checkNear(actual, expected, label, tolerance = 1e-10) {
  check(near(actual, expected, tolerance), label, `actual=${actual} expected=${expected}`);
}

const rad = degrees => degrees * Math.PI / 180;
const previous = {
  x: 0, y: 2, z: -4, heading: rad(170), v: 20,
  wheelSpin: 10, steer: -1, pitch: -0.1, roll: 0.2, rideBump: 0.05,
};
const current = {
  x: 10, y: 6, z: 4, heading: rad(-170), v: 40,
  wheelSpin: 14, steer: 1, pitch: 0.3, roll: -0.2, rideBump: 0.15,
};

console.log('\n[interpolation] pure snapshot math');
checkNear(clampRenderAlpha(-2), 0, 'negative alpha clamps to zero');
checkNear(clampRenderAlpha(2), 1, 'alpha above one clamps to one');
checkNear(clampRenderAlpha(NaN), 0, 'non-finite alpha falls back to zero');
checkNear(clampRenderAlpha(Infinity), 1, 'positive infinity clamps to one');
checkNear(clampRenderAlpha(-Infinity), 0, 'negative infinity clamps to zero');
checkNear(clampRenderAlpha(undefined), 0, 'undefined alpha falls back to zero');
checkNear(shortestAngleDelta(previous.heading, current.heading), rad(20),
  'heading delta crosses +pi by the shortest path');
checkNear(shortestAngleDelta(current.heading, previous.heading), rad(-20),
  'reverse heading delta crosses -pi by the shortest path');

const reusable = {};
const halfway = interpolateRenderSnapshot(previous, current, 0.5, reusable);
check(halfway === reusable, 'snapshot interpolation reuses the caller-provided output object');
checkNear(halfway.x, 5, 'position x interpolates linearly');
checkNear(halfway.y, 4, 'render elevation interpolates linearly');
checkNear(halfway.z, 0, 'position z interpolates linearly');
check(angleNear(halfway.heading, Math.PI), 'heading interpolates across wrap-around without a long spin',
  `heading=${halfway.heading}`);
checkNear(halfway.v, 30, 'speed interpolates linearly');
checkNear(halfway.wheelSpin, 12, 'wheel spin interpolates linearly');
checkNear(halfway.steer, 0, 'steer interpolates linearly');
checkNear(halfway.pitch, 0.1, 'pitch interpolates linearly');
checkNear(halfway.roll, 0, 'roll interpolates linearly');
checkNear(halfway.rideBump, 0.1, 'ride height interpolates linearly');
check(interpolateRenderSnapshot(previous, current, -1, {}).x === previous.x,
  'snapshot interpolation clamps below zero');
check(interpolateRenderSnapshot(previous, current, 3, {}).x === current.x,
  'snapshot interpolation clamps above one');

function xyz() {
  return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
}
function makeEntry() {
  const wheels = Object.fromEntries(['fl', 'fr', 'rl', 'rr'].map(key =>
    [key, { rotation: { x: 0, y: 0, z: 0 } }]));
  return {
    phys: {
      pos: { x: current.x, z: current.z }, sampleIdx: 0,
      heading: current.heading, v: current.v, steer: current.steer,
      pitch: current.pitch, roll: current.roll, rideBump: current.rideBump,
      brake: 0, throttle: 1,
    },
    mesh: { position: xyz(), rotation: { x: 0, y: 0, z: 0 }, userData: {} },
    wheels,
    wheelRadius: 0.34,
    wheelSpin: current.wheelSpin,
    carHandle: { body: { rotation: { x: 0, y: 0, z: 0 }, position: { y: 0 } } },
    shadowLobe: { position: xyz(), rotation: { x: 0, y: 0, z: 0 } },
    renderPrev: { ...previous }, renderCurr: { ...current }, renderPose: {},
  };
}
function fakeSession(entry) {
  const session = Object.create(RaceSession.prototype);
  session.entries = [entry];
  session.circuit = {
    ds: 1,
    samples: [{ p: { x: 0, z: 0 }, t: { x: 1, z: 0 } }],
    heightAt: () => 7,
  };
  session.scene = { remove: noop };
  session._renderDisposed = false;
  return session;
}
function renderDigest(entry) {
  const body = entry.carHandle.body;
  return JSON.stringify({
    mesh: [entry.mesh.position.x, entry.mesh.position.y, entry.mesh.position.z, entry.mesh.rotation.y],
    wheels: ['fl', 'fr', 'rl', 'rr'].map(key =>
      [entry.wheels[key].rotation.x, entry.wheels[key].rotation.y]),
    body: [body.rotation.x, body.rotation.z, body.position.y],
    shadow: [entry.shadowLobe.position.x, entry.shadowLobe.position.y,
      entry.shadowLobe.position.z, entry.shadowLobe.rotation.z],
    renderY: entry.renderY,
    pose: entry.renderPose,
  });
}

console.log('\n[interpolation] RaceSession.render() application');
{
  const entry = makeEntry();
  const session = fakeSession(entry);
  const physicsBefore = JSON.stringify(entry.phys);
  const snapshotsBefore = JSON.stringify([entry.renderPrev, entry.renderCurr]);
  const poseRef = entry.renderPose;

  session.render(0.5);
  checkNear(entry.mesh.position.x, 5, 'render() applies interpolated mesh x');
  checkNear(entry.mesh.position.y, 4, 'render() applies interpolated mesh elevation');
  checkNear(entry.renderY, 4, 'render() publishes interpolated elevation');
  checkNear(entry.mesh.position.z, 0, 'render() applies interpolated mesh z');
  check(angleNear(entry.mesh.rotation.y, Math.PI), 'render() applies shortest-path mesh heading');
  checkNear(entry.wheels.fl.rotation.x, 12, 'render() applies interpolated wheel spin');
  check(['fr', 'rl', 'rr'].every(key => near(entry.wheels[key].rotation.x, 12)),
    'render() applies interpolated spin to all four wheels');
  checkNear(entry.wheels.fl.rotation.y, 0, 'render() applies interpolated front steer');
  checkNear(entry.carHandle.body.rotation.x, 0.1, 'render() applies interpolated pitch');
  checkNear(entry.carHandle.body.rotation.z, 0, 'render() applies interpolated roll');
  checkNear(entry.carHandle.body.position.y, 0.1, 'render() applies interpolated ride height');
  checkNear(Math.hypot(entry.shadowLobe.position.x, entry.shadowLobe.position.z), 1.15,
    'render() applies the fixed-length sun shadow lobe');
  checkNear(entry.shadowLobe.position.y, 0.002, 'render() keeps the sun shadow above the road');

  session.render(0.25);
  checkNear(entry.mesh.position.z, -2, 'quarter-alpha mesh z cannot pass via its default value');
  checkNear(entry.wheels.fl.rotation.y, -0.16,
    'quarter-alpha front-left steer applies pose.steer * 0.32');
  checkNear(entry.wheels.fr.rotation.y, -0.16,
    'quarter-alpha front-right steer matches front-left');
  checkNear(entry.wheels.rl.rotation.y, 0,
    'quarter-alpha rear-left wheel remains unsteered');
  checkNear(entry.wheels.rr.rotation.y, 0,
    'quarter-alpha rear-right wheel remains unsteered');
  checkNear(entry.carHandle.body.rotation.z, 0.1,
    'quarter-alpha roll cannot pass via its default value');
  const quarterHeading = rad(175);
  const sunGroundAzi = Math.atan2(-260, -160);
  const localShadowAngle = sunGroundAzi - quarterHeading;
  checkNear(entry.shadowLobe.position.x, Math.sin(localShadowAngle) * 1.15,
    'shadow lobe local x follows interpolated heading');
  checkNear(entry.shadowLobe.position.z, Math.cos(localShadowAngle) * 1.15,
    'shadow lobe local z follows interpolated heading');
  checkNear(entry.shadowLobe.rotation.z, -localShadowAngle,
    'shadow lobe rotation exactly counter-rotates its local angle');
  const shadowWorldOffsetA = entry.shadowLobe.rotation.z - entry.mesh.rotation.y;
  const stableDigest = renderDigest(entry);
  for (let i = 0; i < 32; i++) session.render(0.25);
  check(renderDigest(entry) === stableDigest,
    'repeated zero-tick renders at one alpha are bit-for-bit idempotent');
  checkNear(entry.wheelSpin, current.wheelSpin,
    'zero-tick renders never integrate authoritative wheel spin');
  session.render(0.75);
  const shadowWorldOffsetB = entry.shadowLobe.rotation.z - entry.mesh.rotation.y;
  session.render(0.25);
  check(renderDigest(entry) === stableDigest,
    'rendering another alpha and returning does not accumulate presentation state');
  checkNear(shadowWorldOffsetA, shadowWorldOffsetB,
    'shadow lobe keeps a constant world direction while heading interpolates');
  check(entry.renderPose === poseRef, 'zero-tick renders reuse the preallocated render pose');
  check(JSON.stringify(entry.phys) === physicsBefore, 'render() never mutates authoritative physics');
  check(JSON.stringify([entry.renderPrev, entry.renderCurr]) === snapshotsBefore,
    'zero-tick renders never mutate previous/current snapshots');

  session.render(-10);
  checkNear(entry.mesh.position.x, previous.x, 'render() clamps negative alpha to previous state');
  session.render(10);
  checkNear(entry.mesh.position.x, current.x, 'render() clamps oversized alpha to current state');
}

console.log('\n[interpolation] fixed-tick snapshot lifecycle');
{
  const entry = makeEntry();
  entry.renderPrev = entry.renderCurr = entry.renderPose = null;
  const session = fakeSession(entry);
  session.resetRenderState(entry);
  const startX = entry.renderCurr.x;
  session._beginRenderTick();
  entry.phys.pos.x = 14;
  entry.phys.pos.z = 8;
  entry.phys.heading = rad(-150);
  entry.phys.steer = 0.5;
  entry.phys.pitch = 0.5;
  entry.phys.roll = -0.4;
  entry.phys.rideBump = 0.25;
  entry.phys.v = 44;
  entry.wheelSpin = 18;
  session._finishRenderTick();
  checkNear(entry.renderPrev.x, startX, 'tick begin copies current state to previous');
  checkNear(entry.renderCurr.x, 14, 'tick finish captures authoritative position');
  checkNear(entry.renderCurr.wheelSpin, 18, 'tick finish captures fixed-tick wheel spin');
  entry.phys.pos.x = 99;
  session.render(0.5);
  checkNear(entry.mesh.position.x, 12, 'render midpoint uses detached tick snapshots');
  check(angleNear(entry.mesh.rotation.y, rad(-160)),
    'tick lifecycle preserves shortest-path heading interpolation');
  checkNear(entry.wheels.fl.rotation.y, 0.24, 'tick lifecycle interpolates steer independently');
}

console.log('\n[interpolation] teleport/reset and disposal');
{
  const entry = makeEntry();
  const session = fakeSession(entry);
  entry.phys.pos.x = 900;
  entry.phys.pos.z = -300;
  entry.phys.heading = rad(-45);
  entry.phys.v = 23;
  entry.phys.steer = 0.25;
  entry.wheelSpin = 77;
  session.resetRenderState(entry);
  check(entry.renderPrev !== entry.renderCurr && entry.renderCurr !== entry.renderPose,
    'reset keeps three distinct preallocated snapshot objects');
  check(JSON.stringify(entry.renderPrev) === JSON.stringify(entry.renderCurr),
    'resetRenderState(entry) collapses teleport history');
  entry.phys.pos.x = 901;
  checkNear(entry.renderCurr.x, 900, 'reset snapshots are detached from authoritative position objects');
  entry.phys.pos.x = 900;
  session.render(0.5);
  checkNear(entry.mesh.position.x, 900, 'collapsed teleport never interpolates from the old x');
  checkNear(entry.mesh.position.z, -300, 'collapsed teleport never interpolates from the old z');
  checkNear(entry.mesh.position.y, 7, 'collapsed teleport captures the new road height');
  checkNear(entry.wheels.fl.rotation.x, 77, 'collapsed teleport captures current wheel spin');

  entry.mesh.traverse = callback => callback({ isSprite: false });
  let removed = 0;
  session.scene.remove = () => { removed++; };
  session.dispose();
  session.dispose();
  const disposedX = entry.mesh.position.x;
  entry.phys.pos.x = 100;
  let postDisposeSafe = true;
  try {
    session.update(1 / 60, { steer: 0, throttle: 0, brake: 0, boost: false });
    session.render(0.5);
    session.resetRenderState();
  } catch {
    postDisposeSafe = false;
  }
  check(removed === 1, 'dispose() is idempotent', `scene removals=${removed}`);
  check(postDisposeSafe, 'update/render/reset are safe after dispose');
  check(entry.renderPrev === null && entry.renderCurr === null && entry.renderPose === null,
    'post-dispose lifecycle calls do not recreate snapshots');
  checkNear(entry.mesh.position.x, disposedX, 'render/reset are safe no-ops after dispose');
}

console.log('\n[interpolation] real construction, compatibility sync, and pit exit');
{
  const THREE = await import('../lib/three.module.js');
  const { buildCircuit } = await import('../js/trackBuilder.js');
  const { TRACKS } = await import('../js/tracks.js');
  const { DRIVERS } = await import('../js/data.js');
  const scene = new THREE.Scene();
  const circuit = buildCircuit('monza', TRACKS.monza, scene);
  const session = new RaceSession({
    scene, circuit,
    playerDriverId: DRIVERS[0].id,
    laps: 1, difficulty: 1,
    assists: { tc: true, abs: true, autoGear: true },
    mode: 'quali',
    onMessage: noop,
    random: () => 0.5,
  });
  const entry = session.player;
  check(!!entry.renderPrev && !!entry.renderCurr && !!entry.renderPose,
    'construction initializes every render snapshot');
  check(entry.renderPrev !== entry.renderCurr && entry.renderCurr !== entry.renderPose,
    'construction preallocates distinct snapshot objects');
  check(JSON.stringify(entry.renderPrev) === JSON.stringify(entry.renderCurr),
    'construction begins with collapsed interpolation history');
  checkNear(entry.mesh.position.x, entry.phys.pos.x,
    'qualifying construction immediately places the mesh at physics x');
  checkNear(entry.mesh.position.z, entry.phys.pos.z,
    'qualifying construction immediately places the mesh at physics z');
  check(angleNear(entry.mesh.rotation.y, entry.phys.heading),
    'qualifying construction immediately applies physics heading');

  entry.phys.pos.x += 2;
  entry.phys.heading += 0.2;
  const spinBefore = entry.wheelSpin;
  const syncDt = 0.01;
  session._syncMesh(entry, syncDt);
  checkNear(entry.wheelSpin, spinBefore + entry.phys.v / entry.wheelRadius * syncDt,
    '_syncMesh compatibility advances wheel spin once');
  check(JSON.stringify(entry.renderPrev) === JSON.stringify(entry.renderCurr),
    '_syncMesh compatibility collapses interpolation history');
  checkNear(entry.mesh.position.x, entry.phys.pos.x,
    '_syncMesh compatibility applies the authoritative pose immediately');

  const prePitX = entry.phys.pos.x;
  entry.pitState = { phase: 'stopped', timer: 0, chosen: 'M', wing: false };
  entry.phys.disabled = true;
  entry.mesh.visible = false;
  session._updatePit(entry, 1 / 60);
  check(entry.pitState === null && entry.mesh.visible && !entry.phys.disabled,
    'real pit exit restores the car to the circuit');
  check(Math.abs(entry.phys.pos.x - prePitX) > 10,
    'real pit exit is a material teleport', `deltaX=${Math.abs(entry.phys.pos.x - prePitX).toFixed(1)}`);
  check(JSON.stringify(entry.renderPrev) === JSON.stringify(entry.renderCurr),
    'real pit exit collapses previous/current history');
  session.render(0);
  const pitX0 = entry.mesh.position.x;
  session.render(0.5);
  checkNear(entry.mesh.position.x, pitX0,
    'real pit exit cannot interpolate across the circuit at any alpha');
  checkNear(entry.mesh.position.x, entry.phys.pos.x,
    'real pit-exit mesh matches authoritative position');
  session.dispose();
}

console.log(`\n${failed ? 'INTERPOLATION CHECKS FAILED' : 'ALL INTERPOLATION CHECKS PASSED'}: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
