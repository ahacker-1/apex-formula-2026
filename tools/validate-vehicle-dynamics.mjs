// Deterministic production regressions for the four-corner vehicle model.
// Usage: node tools/validate-vehicle-dynamics.mjs

import * as THREE from 'three';
import { CarPhysics } from '../js/physics.js';
import { applyContactVelocity, syncContactBody, velocityOf } from '../js/contact.js';
import {
  combinedTyreForces,
  createVehicleState,
  readSurfaceSample,
  stepVehicleDynamics,
  tyreThermalPressureGrip,
} from '../js/vehicleDynamics.js';

let failures = 0;
const ok = (condition, label, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); }
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const DT = 1 / 60;
const ZERO = { steer: 0, throttle: 0, brake: 0, boost: false };

const sample = {
  p: new THREE.Vector3(),
  t: new THREE.Vector3(0, 0, 1),
  n: new THREE.Vector3(1, 0, 0),
  curv: 0,
};
const circuit = {
  samples: [sample], N: 1, ds: 2.5, length: 1e6,
  halfWidth: 1e4, wallOff: 2e4,
  nearestSample: () => 0,
  lateralAt: position => position.x,
};

function carAt(speed = 0, opts = {}) {
  const car = new CarPhysics(circuit, {
    isPlayer: true,
    random: () => 0.5,
    assists: { tc: true, abs: true, autoGear: true },
    ...opts,
  });
  car.placeAt(new THREE.Vector3(), 0, 0);
  car.v = speed;
  car.tyreTemp = 100;
  return car;
}

console.log('[vehicle] optional surface contract and safe defaults');
const flat = {};
readSurfaceSample(circuit, 0, new THREE.Vector3(), flat);
ok(flat.grade === 0 && flat.camber === 0 && flat.bump === 0 && flat.grip === 1 && flat.wetness === 0,
  'missing surface data resolves to flat dry asphalt');
const surfacedCircuit = {
  ...circuit,
  samples: [{ ...sample, surface: {
    grade: 0.04, camber: -0.03, bump: 0.006, grip: 0.91, wetness: 0.35,
    wheels: { FL: 0.018, RR: -0.004 },
  } }],
};
const sampled = {};
readSurfaceSample(surfacedCircuit, 0, new THREE.Vector3(), sampled);
ok(sampled.grade === 0.04 && sampled.camber === -0.03 && sampled.grip === 0.91 &&
    sampled.wetness === 0.35 && sampled.bumpFL === 0.018 && sampled.bumpRR === -0.004,
  'grade/camber/bump/grip/wetness and per-wheel bumps are consumed');
let surfaceCall = null, surfaceCalls = 0;
const trackStateCircuit = {
  ...circuit,
  lateralAt: (position, index) => position.x + index * 0.25,
  surfaceAt: (sampleIndex, lateral, out) => {
    surfaceCalls++;
    surfaceCall = { sampleIndex, lateral, out };
    Object.assign(out, {
      grade: 0.025, camber: 0.018, bump: 0.004,
      baseGrip: surfaceCalls === 1 ? 0.93 : 0.91, wetness: 0.27,
    });
    if (surfaceCalls === 1) out.multiplier = 0.84;
    return out;
  },
};
const trackStateOut = {};
readSurfaceSample(trackStateCircuit, 0, new THREE.Vector3(2.75, 0, 0), trackStateOut);
ok(surfaceCall?.sampleIndex === 0 && surfaceCall?.lateral === 2.75 && surfaceCall?.out === trackStateOut,
  'TrackState surfaceAt(sampleIndex, lateral, out) signature is called exactly');
ok(trackStateOut.grip === 0.84 && trackStateOut.grade === 0.025 && trackStateOut.wetness === 0.27,
  'TrackState multiplier output maps into the physics grip sample');
readSurfaceSample(trackStateCircuit, 0, new THREE.Vector3(2.75, 0, 0), trackStateOut);
ok(trackStateOut.grip === 0.91,
  'reused TrackState output maps fresh baseGrip without retaining stale multiplier/grip');

console.log('[vehicle] tyre saturation, load sensitivity and thermal pressure');
const pureLong = combinedTyreForces({ slipRatio: 0.2, slipAngle: 0, normalLoad: 4000, mu: 1.6 });
const combined = combinedTyreForces({ slipRatio: 0.2, slipAngle: 0.2, normalLoad: 4000, mu: 1.6 });
ok(Math.hypot(combined.fx, combined.fy) <= combined.limit + 1e-9 && combined.utilization === 1,
  'combined-slip force stays on or inside the friction circle',
  `force=${Math.hypot(combined.fx, combined.fy).toFixed(1)} limit=${combined.limit.toFixed(1)}`);
ok(Math.abs(combined.fx) < Math.abs(pureLong.fx),
  'lateral demand reduces available longitudinal force');
const lightLoad = combinedTyreForces({ slipRatio: 1, slipAngle: 0, normalLoad: 4000, mu: 1.6 });
const heavyLoad = combinedTyreForces({ slipRatio: 1, slipAngle: 0, normalLoad: 8000, mu: 1.6 });
ok(heavyLoad.limit > lightLoad.limit && heavyLoad.limit / 8000 < lightLoad.limit / 4000,
  'absolute grip rises with load while grip per unit load falls');
const optimalGrip = tyreThermalPressureGrip(101, 95, 151, 0);
const coldGrip = tyreThermalPressureGrip(55, 55, 130, 0);
const hotGrip = tyreThermalPressureGrip(145, 135, 177, 0);
ok(optimalGrip > coldGrip && optimalGrip > hotGrip,
  'surface/carcass temperature and pressure have a peaked grip window',
  `${coldGrip.toFixed(3)}/${optimalGrip.toFixed(3)}/${hotGrip.toFixed(3)}`);

const fresh = new CarPhysics(circuit, {
  isPlayer: true, random: () => 0.5,
  assists: { tc: true, abs: true, autoGear: true },
});
fresh.placeAt(new THREE.Vector3(), 0, 0);
fresh.setTyre('M');
fresh.v = 50;
fresh.step(DT, ZERO);
const freshFrontMu = (fresh.wheels[0]._forceScratch.limit / fresh.wheels[0].normalLoad +
  fresh.wheels[1]._forceScratch.limit / fresh.wheels[1].normalLoad) * 0.5;
const freshRearMu = (fresh.wheels[2]._forceScratch.limit / fresh.wheels[2].normalLoad +
  fresh.wheels[3]._forceScratch.limit / fresh.wheels[3].normalLoad) * 0.5;
ok(fresh.tyreTemp >= 74,
  'a fresh Formula tyre begins blanket-warm instead of at a severe cold-grip cliff',
  `temperature=${fresh.tyreTemp.toFixed(1)}C`);
ok(freshRearMu / freshFrontMu >= 0.96,
  'front and rear fresh-tyre pressure targets preserve balanced axle grip',
  `front=${freshFrontMu.toFixed(3)} rear=${freshRearMu.toFixed(3)}`);

const bumpCircuit = {
  ...circuit,
  samples: [{ ...sample, surface: { grade: 0, camber: 0, bump: 0.006, grip: 1, wetness: 0 } }],
};
const bumpCar = new CarPhysics(bumpCircuit, {
  isPlayer: true, random: () => 0.5,
  assists: { tc: true, abs: true, autoGear: true },
});
bumpCar.placeAt(new THREE.Vector3(), 0, 0);
bumpCar.v = 45;
bumpCar.tyreTemp = 100;
bumpCar.step(DT, ZERO);
const firstBumpLoads = bumpCar.wheels.map(wheel => wheel.normalLoad);
bumpCar.step(DT, ZERO);
const secondBumpLoads = bumpCar.wheels.map(wheel => wheel.normalLoad);
ok(Math.max(...firstBumpLoads.map((load, index) => Math.abs(load - secondBumpLoads[index]))) <= 120,
  'spawn-surface bump history does not create a one-tick suspension impulse',
  `maxDelta=${Math.max(...firstBumpLoads.map((load, index) => Math.abs(load - secondBumpLoads[index]))).toFixed(1)}N`);

console.log('[vehicle] four-wheel load transfer, suspension and aero platform');
const defaultSurface = { grade: 0, camber: 0, bump: 0, grip: 1, wetness: 0,
  bumpFL: 0, bumpFR: 0, bumpRL: 0, bumpRR: 0 };
const loadState = createVehicleState();
loadState.velocityLong = 45;
loadState.accelLong = -14;
loadState.accelLat = 12;
stepVehicleDynamics(loadState, {
  mass: 830, steerAngle: 0, driveForce: 0, brakeForce: 0, engineBrakeForce: 0,
  brakeBias: 0.56, diffLock: 0.5, downforce: 9000, aeroBalance: 0.45,
  rideHeightFront: 0.038, rideHeightRear: 0.038, externalForceLong: 0,
  mu: 1.6, surface: { ...defaultSurface, bumpFL: 0.012 },
}, DT);
ok(loadState.wheels.map(wheel => wheel.key).join('/') === 'FL/FR/RL/RR' &&
    new Set(loadState.wheels).size === 4,
  'FL/FR/RL/RR are four stable independent wheel states');
const frontLoad = loadState.wheels[0].normalLoad + loadState.wheels[1].normalLoad;
const rearLoad = loadState.wheels[2].normalLoad + loadState.wheels[3].normalLoad;
ok(frontLoad > rearLoad, 'braking transfers normal load longitudinally to the front axle');
ok(loadState.wheels[0].normalLoad > loadState.wheels[1].normalLoad &&
    loadState.wheels[2].normalLoad > loadState.wheels[3].normalLoad,
  'lateral acceleration transfers load independently across both axles');
ok(loadState.wheels[0].suspensionDeflection > loadState.wheels[1].suspensionDeflection,
  'per-wheel bump input changes suspension/contact deflection');
const badPlatform = createVehicleState();
stepVehicleDynamics(badPlatform, {
  mass: 830, steerAngle: 0, driveForce: 0, brakeForce: 0, engineBrakeForce: 0,
  brakeBias: 0.56, diffLock: 0.5, downforce: 9000, aeroBalance: 0.45,
  rideHeightFront: 0.095, rideHeightRear: 0.02, externalForceLong: 0,
  mu: 1.6, surface: defaultSurface,
}, DT);
const goodTotal = loadState.wheels.reduce((sum, wheel) => sum + wheel.normalLoad, 0);
const badTotal = badPlatform.wheels.reduce((sum, wheel) => sum + wheel.normalLoad, 0);
ok(badTotal < goodTotal, 'poor ride height/rake reduces effective aero load');

console.log('[vehicle] deterministic braking, cornering and left/right symmetry');
const coast = carAt(60), braking = carAt(60);
let peakFrontDelta = 0;
for (let i = 0; i < 90; i++) {
  coast.step(DT, ZERO);
  braking.step(DT, { ...ZERO, brake: 0.8, brakeBias: 0.6, brakeMigration: 0.03 });
  const f = braking.wheels[0].normalLoad + braking.wheels[1].normalLoad;
  const r = braking.wheels[2].normalLoad + braking.wheels[3].normalLoad;
  peakFrontDelta = Math.max(peakFrontDelta, f - r);
}
ok(braking.v < coast.v - 15 && peakFrontDelta > 500,
  'braking decelerates and produces frontward load transfer',
  `coast=${coast.v.toFixed(1)} brake=${braking.v.toFixed(1)} dFz=${peakFrontDelta.toFixed(0)}N`);
ok(braking.brakeBias === 0.6 && braking.brakeMigration === 0.03,
  'brake-bias and migration hooks update without changing the input API');

function corner(sign) {
  const car = carAt(42);
  for (let i = 0; i < 90; i++) {
    car.step(DT, { ...ZERO, steer: sign * 0.34, throttle: 0.45,
      diffLock: 0.7, engineBraking: 0.08, aeroBalance: 0.47 });
  }
  return car;
}
const right = corner(1), left = corner(-1);
ok(Math.abs(right.heading) > 0.2 && Math.abs(right.yawRate) > 0.05 &&
    Math.abs(right.velocityLat) > 0.01 && Math.abs(right.sideslip) > 0.0001,
  'cornering develops yaw inertia, lateral velocity and measurable sideslip',
  `yaw=${right.heading.toFixed(3)} r=${right.yawRate.toFixed(3)} beta=${right.sideslip.toFixed(4)}`);
ok(Math.abs(right.heading + left.heading) < 1e-7 &&
    Math.abs(right.velocityLat + left.velocityLat) < 1e-7 &&
    Math.abs(right.yawRate + left.yawRate) < 1e-7,
  'left/right cornering is mirror symmetric');
ok(right.diffLock === 0.7 && right.engineBraking === 0.08 && right.aeroBalance === 0.47,
  'differential, engine-braking and aero-balance hooks are live');

console.log('[vehicle] finite long-run state and collision sideslip stability');
const stressed = new CarPhysics(surfacedCircuit, { isPlayer: true, random: () => 0.5 });
stressed.placeAt(new THREE.Vector3(), 0, 0);
stressed.v = 35;
stressed.tyreTemp = 92;
let allFinite = true;
for (let i = 0; i < 2400; i++) {
  const phase = i % 480;
  stressed.step(DT, {
    steer: Math.sin(i * 0.019) * 0.55,
    throttle: phase < 300 ? 0.72 : 0.05,
    brake: phase >= 300 && phase < 390 ? 0.65 : 0,
    boost: false,
  });
  const values = [stressed.pos.x, stressed.pos.z, stressed.heading, stressed.v,
    stressed.velocityLat, stressed.yawRate, stressed.sideslip, stressed.tyreTemp,
    ...stressed.wheels.flatMap(w => [w.omega, w.slipRatio, w.slipAngle, w.normalLoad,
      w.fx, w.fy, w.surfaceTemp, w.carcassTemp, w.pressure])];
  if (!values.every(finite)) { allFinite = false; break; }
}
ok(allFinite, '2,400 fixed 60 Hz ticks keep every body/wheel output finite');

const impact = carAt(40);
impact.vehicle.velocityLat = 7;
impact.velocityLat = 7;
const body = syncContactBody({}, impact);
const beforeWorld = velocityOf(body, { x: 0, z: 0 });
// RaceSession supplies scalar forward velocity plus its accumulated impulse.
applyContactVelocity(impact, 3, 35);
const afterWorld = velocityOf(body, { x: 0, z: 0 });
ok(Math.abs(beforeWorld.x - 7) < 1e-9 && Math.abs(afterWorld.x - 10) < 1e-9 &&
    Math.abs(afterWorld.z - 35) < 1e-9 && Math.abs(impact.velocityLat) > 1,
  'collision impulse preserves prior sideslip instead of projecting it away',
  `before=(${beforeWorld.x.toFixed(1)},${beforeWorld.z.toFixed(1)}) after=(${afterWorld.x.toFixed(1)},${afterWorld.z.toFixed(1)})`);
let collisionFinite = true;
for (let i = 0; i < 300; i++) {
  impact.step(DT, ZERO);
  collisionFinite &&= [impact.v, impact.velocityLat, impact.yawRate, impact.heading,
    impact.pos.x, impact.pos.z].every(finite);
}
ok(collisionFinite && Math.abs(impact.velocityLat) < 15 && Math.abs(impact.yawRate) < 3.21,
  'post-impact sideslip settles without NaN, unbounded yaw or energy explosion');

if (failures) {
  console.error(`[vehicle] FAILED (${failures} assertion${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('[vehicle] ALL ASSERTIONS PASSED');
