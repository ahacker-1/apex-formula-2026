// Fast deterministic handling regressions for the production physics seams.
// Keep this fixture deliberately tiny: failures should describe contact math,
// not renderer timing, track generation, or AI behaviour.

import * as THREE from 'three';
import { CarPhysics, wallSupportDistance } from '../js/physics.js';
import { RaceSession } from '../js/race.js';
import { advanceSteeringInput, digitalSteeringLimit } from '../js/controls.js';
import { orientedCarContact, syncContactBody } from '../js/contact.js';

let failures = 0;
const ok = (condition, label, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
};

const DT = 1 / 60;
const sample = {
  p: new THREE.Vector3(0, 0, 0),
  t: new THREE.Vector3(0, 0, 1),
  n: new THREE.Vector3(1, 0, 0),
  curv: 0,
};
const circuit = {
  samples: [sample],
  N: 1,
  ds: 2.5,
  length: 1000,
  halfWidth: 6,
  wallOff: 8.2,
  nearestSample: () => 0,
  lateralAt: position => position.x,
};
const LEGACY_WALL_LIMIT = circuit.wallOff - 0.95;
const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, boost: false };

console.log('[handling] digital steering response');
function steeringTrace({ hz = 60, speed = 50, target = 1, seconds = 1, start = 0 } = {}) {
  const dt = 1 / hz;
  let steer = start;
  const samples = [];
  for (let frame = 1; frame <= Math.round(seconds * hz); frame++) {
    steer = advanceSteeringInput(steer, target, speed, dt, true);
    samples.push(steer);
  }
  return samples;
}

const leftTrace = steeringTrace();
const rightTrace = steeringTrace({ target: -1 });
ok(leftTrace.every((value, index) => value >= 0 && value <= 1 &&
    (index === 0 || value >= leftTrace[index - 1])),
  'held digital steering is monotonic and bounded');
ok(leftTrace[11] >= 0.4 && leftTrace[29] >= 0.75 && leftTrace[59] >= 0.94,
  '50m/s arrow hold reaches the response envelope at 0.2/0.5/1.0s',
  `${leftTrace[11].toFixed(3)}/${leftTrace[29].toFixed(3)}/${leftTrace[59].toFixed(3)}`);
ok(leftTrace.every((value, index) => Math.abs(value + rightTrace[index]) <= 1e-12),
  'left/right digital shaping is exactly symmetric');

let reverseSteer = leftTrace.at(-1);
let reverseZero = null;
for (let frame = 1; frame <= 60; frame++) {
  reverseSteer = advanceSteeringInput(reverseSteer, -1, 50, 1 / 60, true);
  if (reverseZero === null && reverseSteer <= 0) reverseZero = frame / 60;
}
ok(reverseZero !== null && reverseZero <= 0.3,
  'full arrow reversal crosses neutral within 0.30s',
  `cross=${reverseZero?.toFixed(3)}s`);

let releasedSteer = leftTrace.at(-1);
let releaseTime = null;
for (let frame = 1; frame <= 60; frame++) {
  releasedSteer = advanceSteeringInput(releasedSteer, 0, 50, 1 / 60, true);
  if (releaseTime === null && releasedSteer <= 0.2) releaseTime = frame / 60;
}
ok(releaseTime !== null && releaseTime <= 0.4,
  'released arrow steering recentres below 20% within 0.40s',
  `release=${releaseTime?.toFixed(3)}s`);

const paced = [30, 60, 120].map(hz => steeringTrace({ hz, seconds: 0.5 }).at(-1));
ok(Math.max(...paced) - Math.min(...paced) <= 0.02,
  'equal-time steering response is stable at 30/60/120Hz',
  paced.map(value => value.toFixed(4)).join('/'));

for (const [speed, maxSeconds] of [[20, 0.4], [50, 0.47], [80, 0.54]]) {
  const trace = steeringTrace({ speed, seconds: 1 });
  const frame = trace.findIndex(value => value >= 0.8);
  const reached = frame < 0 ? Infinity : (frame + 1) / 60;
  ok(reached <= maxSeconds,
    `${speed}m/s arrow hold reaches 80% inside its response budget`,
    `time=${reached.toFixed(3)}s ceiling=${maxSeconds.toFixed(3)}s`);
}

const analogCases = [
  { current: 0, target: -0.6, speed: 0, dt: 1 },
  { current: 0.25, target: -0.7, speed: 50, dt: 1 / 60 },
  { current: -0.4, target: 0.8, speed: 80, dt: 1 / 30 },
  { current: 0.5, target: 0, speed: -4, dt: 1 / 60 },
];
for (const c of analogCases) {
  const rate = c.target !== 0
    ? 3.4 / (1 + c.speed * 0.02)
    : 6 / (1 + c.speed * 0.01);
  const legacy = c.current + (c.target - c.current) * Math.min(1, rate * c.dt);
  const actual = advanceSteeringInput(c.current, c.target, c.speed, c.dt, false);
  ok(Math.abs(actual - legacy) <= 1e-12,
    'analog steering remains exactly legacy-equivalent',
    `speed=${c.speed} actual=${actual.toFixed(6)} legacy=${legacy.toFixed(6)}`);
}

const steeringCircuit = { ...circuit, halfWidth: 80, wallOff: 100 };
const steeringCar = new CarPhysics(steeringCircuit, { isPlayer: true, random: () => 0.5 });
steeringCar.placeAt(new THREE.Vector3(), 0, 0);
steeringCar.tyreTemp = 100;
let filtered = 0;
for (let frame = 0; frame < 30; frame++) {
  steeringCar.v = 50;
  filtered = advanceSteeringInput(filtered, 1, 50, DT, true);
  steeringCar.step(DT, { ...ZERO_INPUT, steer: filtered });
}
ok(steeringCar.heading >= 0.215,
  'real CarPhysics gains materially faster yaw in the first 0.5s',
  `yaw=${steeringCar.heading.toFixed(4)}rad`);

console.log('[handling] keyboard stability envelope');
const keyboardLimit50 = digitalSteeringLimit(50);
const keyboardLimit80 = digitalSteeringLimit(80);
ok(keyboardLimit50 >= 0.60 && keyboardLimit50 <= 0.65 &&
    keyboardLimit80 >= 0.40 && keyboardLimit80 <= 0.44,
  'high-speed arrow input retains decisive authority without requesting full rack',
  `50=${keyboardLimit50.toFixed(3)} 80=${keyboardLimit80.toFixed(3)}`);

function keyboardTap({ speed = 50, hold = 0.2, direction = 1 } = {}) {
  const car = new CarPhysics(steeringCircuit, {
    isPlayer: true, random: () => 0.5,
    assists: { tc: true, abs: true, autoGear: true },
  });
  car.placeAt(new THREE.Vector3(), 0, 0);
  car.v = speed;
  car.gear = speed >= 70 ? 7 : 5;
  car.tyreTemp = 100;
  for (const wheel of car.wheels) {
    wheel.surfaceTemp = 100;
    wheel.carcassTemp = 95;
  }
  let key = 0;
  let maxBeta = 0;
  let maxYaw = 0;
  let minLoad = Infinity;
  let headingAtRelease = 0;
  for (let frame = 0; frame < 120; frame++) {
    const target = frame / 60 < hold ? direction * digitalSteeringLimit(car.v) : 0;
    key = advanceSteeringInput(key, target, car.v, DT, true, 'balanced');
    car.step(DT, { ...ZERO_INPUT, steer: key });
    maxBeta = Math.max(maxBeta, Math.abs(car.sideslip));
    maxYaw = Math.max(maxYaw, Math.abs(car.yawRate));
    minLoad = Math.min(minLoad, ...car.wheels.map(wheel => wheel.normalLoad));
    if (frame === Math.max(0, Math.round(hold * 60) - 1)) headingAtRelease = car.heading;
  }
  return { car, maxBeta, maxYaw, minLoad, headingAtRelease };
}

for (const speed of [50, 80]) {
  const tap = keyboardTap({ speed, hold: 0.2 });
  ok(tap.maxBeta <= 0.045,
    `${speed}m/s 200ms arrow tap stays below 2.6 degrees sideslip`,
    `beta=${(tap.maxBeta * 180 / Math.PI).toFixed(2)}deg`);
  ok(tap.maxYaw <= 0.72,
    `${speed}m/s 200ms arrow tap stays inside the grip-feasible yaw envelope`,
    `yaw=${tap.maxYaw.toFixed(3)}rad/s`);
  ok(Math.abs(tap.headingAtRelease) >= 0.04,
    `${speed}m/s 200ms arrow tap produces a clearly visible turn`,
    `turn=${(Math.abs(tap.headingAtRelease) * 180 / Math.PI).toFixed(2)}deg`);
  ok(tap.minLoad >= 80,
    `${speed}m/s arrow tap keeps all four tyres in contact on flat asphalt`,
    `minLoad=${tap.minLoad.toFixed(1)}N`);
}

const longHold = keyboardTap({ speed: 50, hold: 0.5 });
ok(longHold.maxBeta <= 0.075,
  '50m/s half-second arrow hold remains planted instead of drifting',
  `beta=${(longHold.maxBeta * 180 / Math.PI).toFixed(2)}deg`);
ok(Math.abs(longHold.headingAtRelease) >= 0.18,
  '50m/s half-second arrow hold turns decisively instead of feeling numb',
  `turn=${(Math.abs(longHold.headingAtRelease) * 180 / Math.PI).toFixed(2)}deg`);

const topSpeedHold = keyboardTap({ speed: 95, hold: 0.5 });
ok(topSpeedHold.maxBeta <= 0.105,
  '95m/s half-second arrow hold stays below 6 degrees transient sideslip',
  `beta=${(topSpeedHold.maxBeta * 180 / Math.PI).toFixed(2)}deg`);
ok(Math.abs(topSpeedHold.car.sideslip) <= 0.002 && Math.abs(topSpeedHold.car.yawRate) <= 0.005,
  'top-speed steering settles instead of leaving a persistent drift after release',
  `beta=${(topSpeedHold.car.sideslip * 180 / Math.PI).toFixed(3)}deg yaw=${topSpeedHold.car.yawRate.toFixed(4)}rad/s`);

const straight = new CarPhysics(steeringCircuit, {
  isPlayer: true, random: () => 0.25,
  assists: { tc: false, abs: true, autoGear: true },
});
straight.placeAt(new THREE.Vector3(), 0, 0);
straight.v = 22;
straight.gear = 2;
straight.tyreTemp = 100;
for (let frame = 0; frame < 300; frame++) {
  straight.step(DT, { ...ZERO_INPUT, throttle: 1 });
}
ok(Math.abs(straight.heading) <= 0.002 && Math.abs(straight.pos.x) <= 0.12,
  'full-throttle zero-steer running has no seeded left/right yaw bias with TC disabled',
  `heading=${straight.heading.toFixed(5)} x=${straight.pos.x.toFixed(3)}m`);

function newCar({ x = 0, z = 0, heading = 0, speed = 0 } = {}) {
  const car = new CarPhysics(circuit, { isPlayer: true, random: () => 0.5 });
  car.placeAt(new THREE.Vector3(x, 0, z), heading, 0);
  car.v = speed;
  car.tyreTemp = 100;
  return car;
}

function contactRun({ angle, speed = 45, side = 1, seconds = 0.5, z = 1.25 }) {
  const heading = side * angle;
  const car = newCar({
    x: side * (LEGACY_WALL_LIMIT - 0.04),
    z,
    heading,
    speed,
  });
  const preTangent = Math.cos(angle) * speed;
  const events = [];
  let first = null;
  let maxPenetration = 0;
  const steps = Math.round(seconds / DT);
  for (let frame = 0; frame < steps; frame++) {
    const ev = car.step(DT, ZERO_INPUT);
    maxPenetration = Math.max(maxPenetration, Math.abs(car.lat) - car.wallLimit);
    if (ev.wallHit > 0) events.push(ev.wallHit);
    if (!first && (ev.wallHit > 0 || car.wallContact)) {
      const vx = Math.sin(car.heading) * car.v;
      const vz = Math.cos(car.heading) * car.v;
      first = {
        normalVelocity: side * vx,
        tangentVelocity: vz,
        speed: Math.abs(car.v),
        heading: car.heading,
        x: car.pos.x,
        z: car.pos.z,
        wallHit: ev.wallHit,
      };
    }
  }
  return { car, first, events, maxPenetration, preTangent };
}

console.log('[handling] wall contact response');
const grazeRight = contactRun({ angle: 12 * Math.PI / 180, side: 1, seconds: 1 });
const grazeLeft = contactRun({ angle: 12 * Math.PI / 180, side: -1, seconds: 1 });
const heavyRight = contactRun({ angle: 70 * Math.PI / 180, side: 1 });
const heavyLeft = contactRun({ angle: 70 * Math.PI / 180, side: -1 });

for (const [name, result] of Object.entries({ grazeRight, grazeLeft, heavyRight, heavyLeft })) {
  ok(result.first !== null, `${name} reaches the barrier`);
  ok(result.maxPenetration <= 1e-9,
    `${name} never leaves the barrier envelope`,
    `penetration=${result.maxPenetration.toFixed(6)}m`);
  ok(Math.abs(result.car.lat - circuit.lateralAt(result.car.pos)) <= 1e-9,
    `${name} leaves lateral state synchronized with corrected position`,
    `lat=${result.car.lat.toFixed(4)} actual=${circuit.lateralAt(result.car.pos).toFixed(4)}`);
  ok(result.first?.normalVelocity <= 0.05,
    `${name} exits with no outward-normal velocity`,
    `vn=${result.first?.normalVelocity.toFixed(3)}`);
  ok(result.events.length === 1,
    `${name} emits exactly one impact pulse per uninterrupted incident`,
    `events=${result.events.length}`);
  ok(result.car.pos.z > 1.25,
    `${name} preserves forward tangent progress instead of snapping to a sample`,
    `z=${result.car.pos.z.toFixed(3)}`);
}

for (const [name, result] of Object.entries({ grazeRight, grazeLeft })) {
  ok(result.first.tangentVelocity >= result.preTangent * 0.8,
    `${name} keeps at least 80% tangent speed`,
    `before=${result.preTangent.toFixed(2)} after=${result.first.tangentVelocity.toFixed(2)}`);
  ok(result.car.pos.z - 1.25 >= 25,
    `${name} gains at least 25m along the wall in one second`,
    `gain=${(result.car.pos.z - 1.25).toFixed(2)}m`);
  ok(Math.abs(result.car.lat) <= result.car.wallLimit - 0.05,
    `${name} releases cleanly from the wall`,
    `clearance=${(result.car.wallLimit - Math.abs(result.car.lat)).toFixed(3)}m`);
}

for (const [name, result] of Object.entries({ heavyRight, heavyLeft })) {
  ok(result.first.speed < 14,
    `${name} sheds hard-impact energy instead of railing along the wall`,
    `speed=${result.first.speed.toFixed(2)}m/s`);
  ok(result.first.wallHit >= 0.6,
    `${name} produces a strong impact intensity`,
    `wallHit=${result.first.wallHit.toFixed(3)}`);
}

ok(Math.abs(grazeRight.first.speed - grazeLeft.first.speed) <= 1e-9 &&
    Math.abs(heavyRight.first.speed - heavyLeft.first.speed) <= 1e-9,
  'left/right wall response is speed-symmetric');
ok(Math.abs(grazeRight.first.wallHit - grazeLeft.first.wallHit) <= 1e-9 &&
    Math.abs(heavyRight.first.wallHit - heavyLeft.first.wallHit) <= 1e-9,
  'left/right wall response is intensity-symmetric');
ok(heavyRight.first.wallHit >= grazeRight.first.wallHit + 0.2,
  'heavy impact is materially stronger than a graze',
  `graze=${grazeRight.first.wallHit.toFixed(3)} heavy=${heavyRight.first.wallHit.toFixed(3)}`);

for (const speed of [0.05, 0.1, 1, 20, 80]) {
  const heading = Math.PI / 2;
  const wallLimit = circuit.wallOff - wallSupportDistance(heading);
  const car = newCar({ x: wallLimit + 0.01, heading, speed });
  const energyBefore = car.v * car.v;
  const event = car.resolveWallCollision(true);
  const energyAfter = car.v * car.v;
  ok(energyAfter <= energyBefore + 1e-9,
    `wall restitution never injects energy at ${speed}m/s`,
    `before=${energyBefore.toFixed(4)} after=${energyAfter.toFixed(4)}`);
  if (speed <= 1) ok(event === 0, `crawl-speed ${speed}m/s wall touch stays below impact threshold`);
  if (speed >= 20) {
    ok(Math.abs(car.wallImpactNormalSpeed - speed) <= 1e-9,
      `wall event preserves measured normal speed at ${speed}m/s`,
      `reported=${car.wallImpactNormalSpeed.toFixed(3)}`);
    ok(car.wallImpactFront, `nose-first ${speed}m/s wall hit is classified as front contact`);
  }
}

const rearFirst = newCar({
  x: circuit.wallOff - wallSupportDistance(-Math.PI / 2) + 0.01,
  heading: -Math.PI / 2,
  speed: -20,
});
rearFirst.resolveWallCollision(true);
ok(!rearFirst.wallImpactFront, 'reverse rear-first wall impact is not classified as front-wing contact');

const surfaceSync = newCar({ x: circuit.halfWidth + 0.535, heading: 0, speed: 0 });
surfaceSync.offTrack = false;
surfaceSync.resolveWallCollision(false);
ok(surfaceSync.offTrack,
  'inside-wall projection still refreshes off-track state after a car-to-car shove',
  `lat=${surfaceSync.lat.toFixed(3)} threshold=${(circuit.halfWidth + 0.4).toFixed(3)}`);

console.log('[handling] car-to-car footprint and impulse response');
function pairEntry(id, { x = 0, z = 0, heading = 0, speed = 0, lateral = 0, player = false } = {}) {
  const phys = newCar({ x, z, heading, speed });
  phys.velocityLat = lateral;
  return {
    driver: { id },
    phys,
    isPlayer: player,
    dnf: false,
    finished: false,
    pitState: null,
    wingDamage: 0,
    _contactCool: 0,
  };
}

function pairRun(aConfig, bConfig) {
  const A = pairEntry('a', aConfig);
  const B = pairEntry('b', bConfig);
  const session = {
    entries: [A, B],
    _touchEvent: 0,
    _activeContacts: new Set(),
    _impactingContacts: new Set(),
    _maybeWingDamage() {},
  };
  const before = {
    ax: A.phys.pos.x, az: A.phys.pos.z, av: A.phys.v,
    bx: B.phys.pos.x, bz: B.phys.pos.z, bv: B.phys.v,
  };
  RaceSession.prototype._collisions.call(session);
  const distance = Math.hypot(A.phys.pos.x - B.phys.pos.x, A.phys.pos.z - B.phys.pos.z);
  const avx = Math.sin(A.phys.heading) * A.phys.v;
  const avz = Math.cos(A.phys.heading) * A.phys.v;
  const bvx = Math.sin(B.phys.heading) * B.phys.v;
  const bvz = Math.cos(B.phys.heading) * B.phys.v;
  return { A, B, session, before, distance, avx, avz, bvx, bvz };
}

// Real car footprint is approximately 5.0m long by 1.9m wide. A circular
// 3.8m collider makes clean side-by-side racing impossible and misses gentle
// nose-to-tail contact, so lock both dimensions independently.
const cleanSide = pairRun(
  { x: -1.2, z: 0, heading: 0, speed: 30, player: true },
  { x: 1.2, z: 0, heading: 0, speed: 30 },
);
ok(Math.abs(cleanSide.A.phys.pos.x - cleanSide.before.ax) <= 1e-9 &&
    Math.abs(cleanSide.B.phys.pos.x - cleanSide.before.bx) <= 1e-9,
  '2.4m side-by-side gap does not trigger phantom contact',
  `distance=${cleanSide.distance.toFixed(3)}m`);
ok(cleanSide.session._touchEvent === 0,
  'clean side-by-side running emits no impact event');

const sideRub = pairRun(
  { x: -0.8, z: 0, heading: 0, speed: 34, player: true },
  { x: 0.8, z: 0, heading: 0, speed: 34 },
);
ok(sideRub.distance >= 1.89 && sideRub.distance <= 2.05,
  'side contact separates to the 1.9m body width, not a 3.8m circle',
  `distance=${sideRub.distance.toFixed(3)}m`);
ok(Math.abs(sideRub.A.phys.v - 34) < 0.25 && Math.abs(sideRub.B.phys.v - 34) < 0.25,
  'matched-speed side rub preserves forward momentum',
  `speeds=${sideRub.A.phys.v.toFixed(2)}/${sideRub.B.phys.v.toFixed(2)}`);

const lateralImpact = pairRun(
  { x: -0.8, z: 0, heading: 0, speed: 30, lateral: 6, player: true },
  { x: 0.8, z: 0, heading: 0, speed: 30, lateral: -6 },
);
const lateralClosingAfter = lateralImpact.A.phys.velocityLat - lateralImpact.B.phys.velocityLat;
ok(Math.abs((lateralImpact.session._touchEvent?.closingSpeed || 0) - 12) <= 1e-9,
  'side impact severity includes full lateral relative velocity',
  `closing=${(lateralImpact.session._touchEvent?.closingSpeed || 0).toFixed(3)}m/s`);
ok(Math.abs((lateralImpact.session._touchEvent?.intensity || 0) - (12 - 0.5) / 18) <= 1e-9,
  'side impact feedback scales from the full closing speed',
  `intensity=${(lateralImpact.session._touchEvent?.intensity || 0).toFixed(3)}`);
ok(lateralClosingAfter <= 1,
  'side impact resolves lateral closing without double-applying sideslip',
  `closingAfter=${lateralClosingAfter.toFixed(3)}m/s`);

const rearEnd = pairRun(
  { x: 0, z: 0, heading: 0, speed: 42, player: true },
  { x: 0, z: 4.5, heading: 0, speed: 30 },
);
const closingAfter = rearEnd.avz - rearEnd.bvz;
ok(rearEnd.distance >= 4.95,
  'nose-to-tail contact uses the full 5m car length',
  `distance=${rearEnd.distance.toFixed(3)}m`);
ok(closingAfter <= 1,
  'rear impact resolves closing speed instead of leaving cars interpenetrating',
  `closingAfter=${closingAfter.toFixed(3)}m/s`);
ok(rearEnd.A.phys.v < rearEnd.before.av && rearEnd.B.phys.v > rearEnd.before.bv,
  'rear impact transfers momentum from the striking car to the car ahead',
  `before=${rearEnd.before.av.toFixed(1)}/${rearEnd.before.bv.toFixed(1)} after=${rearEnd.A.phys.v.toFixed(1)}/${rearEnd.B.phys.v.toFixed(1)}`);
const rearEndIntensity = rearEnd.session._touchEvent?.intensity || 0;
ok(rearEndIntensity >= 0.4,
  'rear impact emits severity-scaled player feedback',
  `event=${rearEndIntensity.toFixed(3)}`);

rearEnd.session._touchEvent = 0;
RaceSession.prototype._collisions.call(rearEnd.session);
ok(rearEnd.session._touchEvent === 0,
  'resolved sustained contact does not machine-gun impact events');

const delayedA = pairEntry('delayed-a', { x: -0.985, z: 0, heading: 0, speed: 20, player: true });
const delayedB = pairEntry('delayed-b', { x: 0.985, z: 0, heading: 0, speed: 20 });
const delayedSession = {
  entries: [delayedA, delayedB],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage() {},
};
RaceSession.prototype._collisions.call(delayedSession);
ok(delayedSession._touchEvent === 0,
  'harmless matched-speed overlap begins without an impact event');
delayedA.phys.heading = Math.PI / 2;
delayedA.phys.v = 6;
delayedB.phys.v = 0;
RaceSession.prototype._collisions.call(delayedSession);
ok((delayedSession._touchEvent?.intensity || 0) > 0.25,
  'a real impulse that develops during persistent contact still emits feedback',
  `event=${(delayedSession._touchEvent?.intensity || 0).toFixed(3)}`);

const strongA = pairEntry('strong-a', { x: 0, z: 0, heading: 0, speed: 30, player: true });
const strongB = pairEntry('strong-b', { x: 0, z: 4.9, heading: 0, speed: 10 });
const weakC = pairEntry('weak-c', { x: 1.97, z: 0, heading: -Math.PI / 2, speed: 2 });
const multiSession = {
  entries: [strongA, strongB, weakC],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage() {},
};
RaceSession.prototype._collisions.call(multiSession);
ok((multiSession._touchEvent?.intensity || 0) >= 0.95,
  'simultaneous contacts retain the strongest player-impact event',
  `event=${(multiSession._touchEvent?.intensity || 0).toFixed(3)}`);

function saturatedEventRun(order) {
  const configs = {
    player: { x: 0, z: 0, heading: 0, speed: 50, player: true },
    ahead: { x: 0, z: 4.9, heading: 0, speed: 30 },
    behind: { x: 0, z: -4.9, heading: 0, speed: 90 },
  };
  const entries = order.map(id => pairEntry(id, configs[id]));
  const session = {
    entries,
    _touchEvent: 0,
    _activeContacts: new Set(),
    _impactingContacts: new Set(),
    _maybeWingDamage() {},
  };
  RaceSession.prototype._collisions.call(session);
  return session._touchEvent;
}
for (const order of [['player', 'ahead', 'behind'], ['player', 'behind', 'ahead']]) {
  const event = saturatedEventRun(order);
  ok(event?.intensity === 1 && Math.abs(event.closingSpeed - 40) <= 1e-9,
    `saturated simultaneous contacts retain the highest real closing speed (${order.join('/')})`,
    `speed=${event?.closingSpeed}`);
}

const separating = pairRun(
  { x: -0.9, z: 0, heading: -Math.PI / 2, speed: 8, player: true },
  { x: 0.9, z: 0, heading: Math.PI / 2, speed: 8 },
);
ok(Math.abs(separating.A.phys.v - 8) <= 1e-9 && Math.abs(separating.B.phys.v - 8) <= 1e-9,
  'overlapping cars already moving apart receive correction without damping');
ok(separating.session._touchEvent === 0,
  'separating overlap emits no impact sound');

const wallA = pairEntry('wall-a', { x: 7.15, z: 0, heading: 0, speed: 30, player: true });
const wallB = pairEntry('wall-b', { x: 6.0, z: 0, heading: 0, speed: 30 });
const wallSession = {
  entries: [wallA, wallB],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage() {},
};
RaceSession.prototype._collisions.call(wallSession);
ok(Math.abs(wallA.phys.lat) <= wallA.phys.wallLimit + 1e-9 &&
    Math.abs(wallB.phys.lat) <= wallB.phys.wallLimit + 1e-9,
  'car separation cannot push either body through the wall');
ok(Math.abs(wallA.phys.lat - circuit.lateralAt(wallA.phys.pos)) <= 1e-9 &&
    Math.abs(wallB.phys.lat - circuit.lateralAt(wallB.phys.pos)) <= 1e-9,
  'post-contact wall projection synchronizes cached lateral state');
const wallBodyA = syncContactBody({}, wallA.phys);
const wallBodyB = syncContactBody({}, wallB.phys);
const wallResidual = orientedCarContact(wallBodyA, wallBodyB)?.penetration || 0;
ok(wallResidual <= 0.011,
  'wall-pinned pair resolves residual body penetration in the same tick',
  `penetration=${wallResidual.toFixed(6)}m`);

// Regression from the adversarial re-audit: the impulse rotates both cars and
// changes their yaw-aware wall/body support. Solving positions before that yaw
// change used to turn 9cm of overlap into more than 1.5m in one rendered tick.
const yawedWallA = pairEntry('yawed-wall-a', { x: 5.7, z: 0.7, heading: 0.77, speed: 26, player: true });
const yawedWallB = pairEntry('yawed-wall-b', { x: 3.6, z: 1.35, heading: 0.8, speed: 85 });
const yawedBefore = orientedCarContact(
  syncContactBody({}, yawedWallA.phys),
  syncContactBody({}, yawedWallB.phys),
)?.penetration || 0;
const yawedWallSession = {
  entries: [yawedWallA, yawedWallB],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage() {},
};
RaceSession.prototype._collisions.call(yawedWallSession);
const yawedAfter = orientedCarContact(
  syncContactBody({}, yawedWallA.phys),
  syncContactBody({}, yawedWallB.phys),
)?.penetration || 0;
ok(yawedBefore > 0.08 && yawedAfter <= 0.011,
  'post-impact heading changes cannot recreate overlap in an angled wall squeeze',
  `before=${yawedBefore.toFixed(6)}m after=${yawedAfter.toFixed(6)}m`);
ok(Math.abs(yawedWallA.phys.lat) <= yawedWallA.phys.wallLimit + 1e-9 &&
    Math.abs(yawedWallB.phys.lat) <= yawedWallB.phys.wallLimit + 1e-9,
  'angled wall-squeeze resolution keeps both yawed cars inside their wall envelopes');

const nearSlopA = pairEntry('near-slop-a', { x: 5.8815, z: 0.7112, heading: 0.6487, speed: 46, player: true });
const nearSlopB = pairEntry('near-slop-b', { x: 3.6911, z: 1.3506, heading: 0.7118, speed: 76.1 });
const nearSlopBefore = orientedCarContact(
  syncContactBody({}, nearSlopA.phys),
  syncContactBody({}, nearSlopB.phys),
)?.penetration || 0;
const nearSlopSession = {
  entries: [nearSlopA, nearSlopB],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage() {},
};
RaceSession.prototype._collisions.call(nearSlopSession);
const nearSlopAfter = orientedCarContact(
  syncContactBody({}, nearSlopA.phys),
  syncContactBody({}, nearSlopB.phys),
)?.penetration || 0;
ok(nearSlopBefore > 0.002 && nearSlopBefore < 0.003 && nearSlopAfter <= 0.011,
  'near-slop angled wall contact cannot oscillate into deep overlap',
  `before=${nearSlopBefore.toFixed(6)}m after=${nearSlopAfter.toFixed(6)}m`);

const pileupConfigs = {
  a: { x: 0.08, z: 0, heading: 0, speed: 40, player: true },
  b: { x: 0, z: 4.7, heading: 0, speed: 20 },
  c: { x: -0.06, z: 9.4, heading: 0, speed: 10 },
};
const permutations = [
  ['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'],
  ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a'],
];
function pileupRun(order) {
  const entries = order.map(id => pairEntry(id, pileupConfigs[id]));
  const session = {
    entries,
    _touchEvent: 0,
    _activeContacts: new Set(),
    _impactingContacts: new Set(),
    _maybeWingDamage() {},
  };
  RaceSession.prototype._collisions.call(session);
  return Object.fromEntries(entries.map(e => [e.driver.id, {
    x: e.phys.pos.x,
    z: e.phys.pos.z,
    v: e.phys.v,
    heading: e.phys.heading,
  }]));
}
const pileupBaseline = pileupRun(permutations[0]);
for (const order of permutations.slice(1)) {
  const result = pileupRun(order);
  const divergence = Math.max(...Object.keys(pileupBaseline).flatMap(id =>
    Object.keys(pileupBaseline[id]).map(field => Math.abs(result[id][field] - pileupBaseline[id][field]))));
  ok(divergence <= 1e-9,
    `three-car impulse result is stable for entry order ${order.join('')}`,
    `maxDiff=${divergence.toExponential(2)}`);
}

const damageA = pairEntry('damage-a', { x: 0, z: 0, heading: 0, speed: 42, player: true });
const damageB = pairEntry('damage-b', { x: 0, z: 4.5, heading: 0, speed: 30 });
const damageCalls = [];
const damageSession = {
  entries: [damageA, damageB],
  _touchEvent: 0,
  _activeContacts: new Set(),
  _impactingContacts: new Set(),
  _maybeWingDamage(entry, source) { damageCalls.push(`${entry.driver.id}:${source}`); },
};
RaceSession.prototype._collisions.call(damageSession);
ok(damageCalls.length === 1 && damageCalls[0] === 'damage-a:car',
  'rear impact attributes front-wing risk only to the nose-first striker',
  `calls=${damageCalls.join(',') || 'none'}`);

const wallDamageCalls = [];
const wallDamageSession = {
  mode: 'race',
  _wallEvent: 0,
  _maybeWingDamage(entry, source) { wallDamageCalls.push(`${entry.driver.id}:${source}`); },
};
const wallDamageEntry = pairEntry('wall-damage', { player: true });
wallDamageEntry.phys.wallImpactNormalSpeed = 30;
wallDamageEntry.phys.wallImpactFront = false;
RaceSession.prototype._handleWallImpact.call(wallDamageSession, wallDamageEntry, 0.9);
wallDamageEntry.phys.wallImpactFront = true;
RaceSession.prototype._handleWallImpact.call(wallDamageSession, wallDamageEntry, 0.9);
ok(wallDamageCalls.length === 1 && wallDamageCalls[0] === 'wall-damage:wall',
  'side/rear wall strikes cannot damage the front wing, while nose-first strikes can');

wallDamageSession._wallEvent = 0;
wallDamageEntry.phys.wallImpactFront = false;
wallDamageEntry.phys.wallImpactNormalSpeed = 40;
RaceSession.prototype._handleWallImpact.call(wallDamageSession, wallDamageEntry, 1);
wallDamageEntry.phys.wallImpactNormalSpeed = 80;
RaceSession.prototype._handleWallImpact.call(wallDamageSession, wallDamageEntry, 1);
ok(wallDamageSession._wallEvent?.normalSpeed === 80,
  'saturated wall events retain the highest measured normal speed',
  `speed=${wallDamageSession._wallEvent?.normalSpeed}`);

const cooldownSession = { random: () => 0, onMessage() {}, _radio() {} };
const cooldownEntry = pairEntry('cooldown', {});
cooldownEntry._carDamageCool = 1;
cooldownEntry._wallDamageCool = 0;
RaceSession.prototype._maybeWingDamage.call(cooldownSession, cooldownEntry, 'wall');
ok(cooldownEntry.wingDamage === 0.15 && cooldownEntry._wallDamageCool === 2 && cooldownEntry._carDamageCool === 1,
  'wall and car damage cooldowns are independent');

console.log(failures
  ? `[handling] FAILED (${failures} assertion${failures === 1 ? '' : 's'})`
  : '[handling] ALL ASSERTIONS PASSED');
process.exitCode = failures ? 1 : 0;
