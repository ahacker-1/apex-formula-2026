// Allocation-free four-corner vehicle dynamics used by CarPhysics. The model
// deliberately favours bounded, deterministic behaviour over motorsport-sim
// complexity: tyre forces are load-sensitive, combined-slip limited and
// relaxed over distance, while the sprung mass retains lateral velocity and
// yaw inertia.

export const WHEEL_KEYS = Object.freeze(['FL', 'FR', 'RL', 'RR']);

export const VEHICLE_DEFAULTS = Object.freeze({
  wheelbase: 3.4,
  frontCg: 1.84,
  rearCg: 1.56,
  frontTrack: 1.72,
  rearTrack: 1.68,
  cgHeight: 0.31,
  yawInertia: 1080,
  wheelRadius: 0.33,
  wheelInertia: 1.45,
  cornerStiffness: 78000,
  longitudinalStiffness: 92000,
  tyreRelaxationLength: 0.72,
  rollFrontShare: 0.52,
  springRate: 175000,
  optimalRideHeight: 0.038,
});

const G = 9.81;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function createWheelState(key, front, left, radius = VEHICLE_DEFAULTS.wheelRadius) {
  return {
    key, front, left,
    radius,
    omega: 0,
    slipRatio: 0,
    slipAngle: 0,
    normalLoad: 0,
    fx: 0,
    fy: 0,
    forceUtilization: 0,
    surfaceTemp: 70,
    carcassTemp: 70,
    pressure: front ? 145 : 132, // kPa, hot pressure is derived from carcass T
    suspensionDeflection: 0,
    contact: true,
    _lastBump: null,
    _forceScratch: { fx: 0, fy: 0, utilization: 0, limit: 0 },
  };
}

export function createVehicleState(config = {}) {
  const cfg = { ...VEHICLE_DEFAULTS, ...config };
  return {
    config: cfg,
    velocityLong: 0,
    velocityLat: 0,
    yawRate: 0,
    accelLong: 0,
    accelLat: 0,
    sideslip: 0,
    rideHeightFront: cfg.optimalRideHeight,
    rideHeightRear: cfg.optimalRideHeight,
    aeroBalance: 0.45,
    wheels: [
      createWheelState('FL', true, true, cfg.wheelRadius),
      createWheelState('FR', true, false, cfg.wheelRadius),
      createWheelState('RL', false, true, cfg.wheelRadius),
      createWheelState('RR', false, false, cfg.wheelRadius),
    ],
    result: { forceLong: 0, forceLat: 0, yawMoment: 0, tyreUse: 0, slip: false },
  };
}

export function resetVehicleState(state, speed = 0, tyreTemp = 70) {
  state.velocityLong = finite(speed, 0);
  state.velocityLat = 0;
  state.yawRate = 0;
  state.accelLong = 0;
  state.accelLat = 0;
  state.sideslip = 0;
  for (const wheel of state.wheels) {
    wheel.omega = state.velocityLong / wheel.radius;
    wheel.slipRatio = 0;
    wheel.slipAngle = 0;
    wheel.normalLoad = 0;
    wheel.fx = 0;
    wheel.fy = 0;
    wheel.forceUtilization = 0;
    wheel.surfaceTemp = tyreTemp;
    wheel.carcassTemp = tyreTemp;
    // The first surface sample establishes the suspension datum. Treating the
    // authored road height as a step from zero injected a one-frame damper hit
    // as soon as a car spawned.
    wheel._lastBump = null;
  }
}

// Surface fields are intentionally permissive. Track builders can put them on
// the centre sample, on sample.surface, or return them from circuit.surfaceAt.
// Missing/malformed data always degrades to flat, dry, fully gripped asphalt.
export function readSurfaceSample(circuit, sampleIdx, position, out) {
  const sample = circuit?.samples?.[sampleIdx] || null;
  let source = sample?.surface || sample || null;
  let lateral = 0;
  if (typeof circuit?.surfaceAt === 'function') {
    lateral = typeof circuit?.lateralAt === 'function'
      ? finite(circuit.lateralAt(position, sampleIdx), 0)
      : 0;
    // Clear aliases this adapter wrote on the previous tick. TrackState reuses
    // `out` but only overwrites its own fields; without this, a stale derived
    // `grip` could mask a newly sampled baseGrip.
    out.grip = undefined;
    out.multiplier = undefined;
    out.baseGrip = undefined;
    out.wheelBumps = undefined;
    out.wheels = undefined;
    // TrackState's browser contract is surfaceAt(sampleIndex, lateral, out).
    // Passing our stable output object keeps this adapter allocation-free.
    const live = circuit.surfaceAt(sampleIdx, lateral, out);
    if (live && typeof live === 'object') source = live;
  }
  out.grade = clamp(finite(source?.grade, 0), -0.35, 0.35);
  out.camber = clamp(finite(source?.camber, 0), -0.35, 0.35);
  out.bump = clamp(finite(source?.bump, 0), -0.08, 0.08);
  let liveGrip = source?.grip ?? source?.multiplier ?? source?.baseGrip;
  out.gripIncludesWetness = false;
  if (typeof circuit?.gripAt === 'function') {
    const gripOut = out._gripResult || (out._gripResult = { surface: {} });
    const gripOptions = out._gripOptions || (out._gripOptions = {});
    const sampled = circuit.gripAt(sampleIdx, lateral, gripOptions, gripOut);
    liveGrip = sampled?.multiplier ?? liveGrip;
    out.gripIncludesWetness = Number.isFinite(sampled?.multiplier);
  }
  out.grip = clamp(finite(liveGrip, 1), 0.15, 1.4);
  out.wetness = clamp(finite(source?.wetness, 0), 0, 1);
  const wb = source?.wheelBumps || source?.wheels;
  out.bumpFL = clamp(finite(wb?.FL?.bump ?? wb?.FL, out.bump), -0.08, 0.08);
  out.bumpFR = clamp(finite(wb?.FR?.bump ?? wb?.FR, out.bump), -0.08, 0.08);
  out.bumpRL = clamp(finite(wb?.RL?.bump ?? wb?.RL, out.bump), -0.08, 0.08);
  out.bumpRR = clamp(finite(wb?.RR?.bump ?? wb?.RR, out.bump), -0.08, 0.08);
  return out;
}

export function tyreTargetPressure(front, wetness = 0) {
  const baseline = front ? 145 : 132;
  const targetCarcass = 95 - 8 * clamp(wetness, 0, 1);
  return baseline * (targetCarcass + 273.15) / (70 + 273.15);
}

export function tyreThermalPressureGrip(
  surfaceTemp, carcassTemp, pressure, wetness = 0, targetPressure = 151,
) {
  const targetT = 101 - 13 * clamp(wetness, 0, 1);
  const tLoss = 0.000075 * Math.pow(finite(surfaceTemp, targetT) - targetT, 2) +
    0.000025 * Math.pow(finite(carcassTemp, targetT - 6) - (targetT - 6), 2);
  const targetP = finite(targetPressure, 151);
  const pLoss = 0.00018 * Math.pow(finite(pressure, targetP) - targetP, 2);
  return clamp(1 - tLoss - pLoss, 0.68, 1.02);
}

// Pure helper used both by the four-wheel integrator and deterministic tests.
export function combinedTyreForces({
  slipRatio, slipAngle, normalLoad, mu,
  longitudinalStiffness = VEHICLE_DEFAULTS.longitudinalStiffness,
  cornerStiffness = VEHICLE_DEFAULTS.cornerStiffness,
}, out = {}) {
  const fz = Math.max(0, finite(normalLoad, 0));
  if (fz < 1) {
    out.fx = 0; out.fy = 0; out.utilization = 0; out.limit = 0;
    return out;
  }
  // A tyre gains force sub-linearly with load: doubling Fz does not double grip.
  const loadSensitivity = Math.pow(4000 / Math.max(1000, fz), 0.075);
  const limit = Math.max(1, finite(mu, 1) * loadSensitivity * fz);
  const rawFx = limit * Math.tanh(longitudinalStiffness * finite(slipRatio, 0) / limit);
  const rawFy = -limit * Math.tanh(cornerStiffness * finite(slipAngle, 0) / limit);
  const demand = Math.hypot(rawFx, rawFy);
  const scale = demand > limit ? limit / demand : 1;
  out.fx = rawFx * scale;
  out.fy = rawFy * scale;
  out.utilization = Math.min(1, demand / limit);
  out.limit = limit;
  return out;
}

function wheelBump(surface, index) {
  return index === 0 ? surface.bumpFL : index === 1 ? surface.bumpFR :
    index === 2 ? surface.bumpRL : surface.bumpRR;
}

export function stepVehicleDynamics(state, params, dt) {
  const cfg = state.config;
  const mass = Math.max(1, finite(params.mass, 830));
  const u0 = state.velocityLong;
  const v0 = state.velocityLat;
  const r0 = state.yawRate;
  const absSpeed = Math.hypot(u0, v0);
  const surface = params.surface;
  const wheels = state.wheels;
  const frontStatic = mass * G * cfg.rearCg / cfg.wheelbase;
  const rearStatic = mass * G - frontStatic;

  const aero = Math.max(0, finite(params.downforce, 0));
  const frontRide = clamp(finite(params.rideHeightFront, cfg.optimalRideHeight), 0.012, 0.12);
  const rearRide = clamp(finite(params.rideHeightRear, cfg.optimalRideHeight), 0.012, 0.12);
  state.rideHeightFront = frontRide;
  state.rideHeightRear = rearRide;
  const rideLoss = clamp(1 - 5.5 * Math.abs((frontRide + rearRide) * 0.5 - cfg.optimalRideHeight) -
    2.2 * Math.abs(frontRide - rearRide), 0.68, 1.05);
  const aeroEffective = aero * rideLoss;
  const aeroBalance = clamp(finite(params.aeroBalance, 0.45) +
    (rearRide - frontRide) * 0.8, 0.36, 0.55);
  state.aeroBalance = aeroBalance;

  // Previous-tick acceleration gives deterministic, non-iterative load transfer.
  const longTransfer = mass * state.accelLong * cfg.cgHeight / cfg.wheelbase;
  const frontTotal = Math.max(200, frontStatic - longTransfer + aeroEffective * aeroBalance);
  const rearTotal = Math.max(200, rearStatic + longTransfer + aeroEffective * (1 - aeroBalance));
  const lateral = mass * state.accelLat * cfg.cgHeight;
  const frontLatTransfer = lateral * cfg.rollFrontShare / cfg.frontTrack;
  const rearLatTransfer = lateral * (1 - cfg.rollFrontShare) / cfg.rearTrack;
  const loads = [
    frontTotal * 0.5 + frontLatTransfer,
    frontTotal * 0.5 - frontLatTransfer,
    rearTotal * 0.5 + rearLatTransfer,
    rearTotal * 0.5 - rearLatTransfer,
  ];

  const steer = finite(params.steerAngle, 0);
  const drive = Math.max(0, finite(params.driveForce, 0));
  const braking = Math.max(0, finite(params.brakeForce, 0));
  const engineBrake = Math.max(0, finite(params.engineBrakeForce, 0));
  const brakeBias = clamp(finite(params.brakeBias, 0.56), 0.45, 0.68);
  const diffLock = clamp(finite(params.diffLock, 0.45), 0, 1);
  const omegaDelta = wheels[2].omega - wheels[3].omega;
  const driveLeftShare = clamp(0.5 - omegaDelta * 0.0035 * diffLock, 0.18, 0.82);
  const driveShares = [0, 0, driveLeftShare, 1 - driveLeftShare];
  const brakeShares = [brakeBias * 0.5, brakeBias * 0.5,
    (1 - brakeBias) * 0.5, (1 - brakeBias) * 0.5];
  const bumps = [surface.bumpFL, surface.bumpFR, surface.bumpRL, surface.bumpRR];

  let forceLong = finite(params.externalForceLong, 0) - mass * G * Math.sin(surface.grade);
  let forceLat = -mass * G * Math.sin(surface.camber);
  let yawMoment = 0;
  let maxUse = 0;
  let slip = false;

  for (let i = 0; i < 4; i++) {
    const wheel = wheels[i];
    const x = (wheel.left ? -1 : 1) * (wheel.front ? cfg.frontTrack : cfg.rearTrack) * 0.5;
    const y = wheel.front ? cfg.frontCg : -cfg.rearCg;
    const delta = wheel.front ? steer : 0;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const bump = finite(bumps[i], wheelBump(surface, i));
    const bumpVelocity = Number.isFinite(wheel._lastBump)
      ? clamp((bump - wheel._lastBump) / Math.max(dt, 1e-4), -0.18, 0.18)
      : 0;
    wheel._lastBump = bump;
    const suspensionLoad = cfg.springRate * bump + 1350 * bumpVelocity;
    wheel.normalLoad = clamp(loads[i] + suspensionLoad, 0, mass * G * 0.65 + aeroEffective * 0.5);
    wheel.contact = wheel.normalLoad > 40;
    wheel.suspensionDeflection = clamp(0.022 + bump + wheel.normalLoad / cfg.springRate, 0, 0.095);

    const hubLong = u0 - r0 * x;
    const hubLat = v0 + r0 * y;
    const wheelLong = cos * hubLong + sin * hubLat;
    const wheelLat = -sin * hubLong + cos * hubLat;
    const denom = Math.max(3, Math.abs(wheelLong));
    wheel.slipRatio = clamp((wheel.omega * wheel.radius - wheelLong) / denom, -2.5, 2.5);
    wheel.slipAngle = clamp(Math.atan2(wheelLat, Math.max(2, Math.abs(wheelLong))), -0.7, 0.7);

    const hotPressure = (wheel.front ? 145 : 132) * (wheel.carcassTemp + 273.15) / (70 + 273.15);
    wheel.pressure += (hotPressure - wheel.pressure) * Math.min(1, dt * 1.8);
    const thermal = tyreThermalPressureGrip(wheel.surfaceTemp, wheel.carcassTemp,
      wheel.pressure, surface.wetness, tyreTargetPressure(wheel.front, surface.wetness));
    // TrackState.gripAt already includes wetness, puddling and line choice. A
    // legacy/static surface still receives the local wetness fallback here.
    const wetGrip = surface.gripIncludesWetness ? 1 : 1 - 0.42 * surface.wetness;
    const mu = Math.max(0.05, finite(params.mu, 1.6) * surface.grip * wetGrip * thermal);
    const drivenCap = drive * driveShares[i];
    const brakingCap = braking * brakeShares[i] + engineBrake * (wheel.front ? 0 : 0.5);
    // A freely rolling axle cannot consume the friction circle with a phantom
    // longitudinal demand that is immediately clamped away below. Its wheel
    // speed still relaxes through inertia, but lateral grip remains available.
    const forceSlipRatio = drivenCap + brakingCap > 1 ? wheel.slipRatio : 0;
    const target = combinedTyreForces({
      slipRatio: forceSlipRatio,
      slipAngle: wheel.slipAngle,
      normalLoad: wheel.normalLoad,
      mu,
      longitudinalStiffness: cfg.longitudinalStiffness,
      cornerStiffness: cfg.cornerStiffness * (wheel.front ? 0.84 : 1.12),
    }, wheel._forceScratch);
    // The contact patch cannot transmit more longitudinal force than the
    // applied shaft/brake torque can support. This keeps power, brake fade and
    // brake migration observable even when the tyre itself is at saturation.
    target.fx = clamp(target.fx, -brakingCap, drivenCap);
    if (target.fx < 0 && braking > 0) {
      target.fx *= clamp(finite(params.brakeEffectiveness, 1), 0.5, 1);
    }
    // Relaxation length avoids instantaneous force steps and stabilizes 30 Hz
    // validator runs without adding a hidden variable-rate solver.
    const relax = Math.min(1, dt * Math.max(5, absSpeed) / cfg.tyreRelaxationLength);
    wheel.fx += (target.fx - wheel.fx) * relax;
    wheel.fy += (target.fy - wheel.fy) * relax;
    wheel.forceUtilization = target.utilization;
    maxUse = Math.max(maxUse, target.utilization);
    if (Math.abs(wheel.slipRatio) > 0.18 || Math.abs(wheel.slipAngle) > 0.18) slip = true;

    const tyreLong = wheel.fx * cos - wheel.fy * sin;
    const tyreLat = wheel.fx * sin + wheel.fy * cos;
    forceLong += tyreLong;
    forceLat += tyreLat;
    yawMoment += y * tyreLat - x * tyreLong;

    const driveTorque = drive * driveShares[i] * wheel.radius;
    const engineTorque = engineBrake * (wheel.front ? 0 : 0.5) * wheel.radius;
    const brakeTorque = braking * brakeShares[i] * wheel.radius;
    const rollingSign = Math.sign(wheel.omega || wheelLong || 1);
    const netTorque = driveTorque - (engineTorque + brakeTorque) * rollingSign - wheel.fx * wheel.radius;
    wheel.omega += netTorque / cfg.wheelInertia * dt;
    if (params.abs && braking > 0 && wheelLong > 5) {
      wheel.omega = Math.max(wheel.omega, wheelLong * 0.87 / wheel.radius);
    }
    if (params.tc && !wheel.front && drive > 0 && wheelLong > 3) {
      wheel.omega = Math.min(wheel.omega, wheelLong * 1.14 / wheel.radius);
    }
    if (braking > 0 && Math.sign(wheel.omega) !== rollingSign && Math.abs(wheelLong) < 4) wheel.omega = 0;

    const slipPower = Math.abs(wheel.fx * (wheel.omega * wheel.radius - wheelLong)) +
      Math.abs(wheel.fy * wheelLat);
    const surfaceHeat = slipPower * 0.000038 + wheel.normalLoad * absSpeed * 0.0000135;
    const surfaceCool = (wheel.surfaceTemp - 30) * (0.021 + absSpeed * 0.00043);
    wheel.surfaceTemp = clamp(wheel.surfaceTemp + (surfaceHeat - surfaceCool) * dt, 25, 180);
    const carcassFlow = (wheel.surfaceTemp - wheel.carcassTemp) * 0.18;
    const carcassCool = (wheel.carcassTemp - 30) * (0.010 + absSpeed * 0.00025);
    wheel.carcassTemp = clamp(wheel.carcassTemp + (carcassFlow - carcassCool) * dt, 25, 165);
  }

  // Aerodynamic yaw damping is tiny in steady cornering but kills numerical
  // oscillation after a large impulse. No heading-derived kinematic yaw is used.
  if (params.stabilityAssist) {
    const lateralDamping = clamp(v0 * mass * (2.8 + absSpeed * 0.018),
      -mass * G * 0.7, mass * G * 0.7);
    forceLat -= lateralDamping;
  }
  const rawDesiredYaw = Math.abs(u0) > 1
    ? u0 * Math.tan(finite(params.steerAngle, 0)) / cfg.wheelbase
    : 0;
  const lateralCapacity = wheels.reduce((sum, wheel) => sum + wheel._forceScratch.limit, 0) / mass;
  const yawLimit = clamp(0.85 * lateralCapacity / Math.max(3, Math.abs(u0)), 0.18, 2.4);
  const desiredYaw = clamp(rawDesiredYaw, -yawLimit, yawLimit);
  yawMoment -= (r0 - desiredYaw) * (14500 + absSpeed * 240);
  // Integrate body-frame velocity derivatives, but publish and retain physical
  // CG acceleration for telemetry and the next tick's load transfer. Using
  // dv/dt directly as lateral acceleration inverted transfer at high yaw and
  // could unload both tyres on one side on flat asphalt.
  const bodyAccelLong = forceLong / mass + r0 * v0;
  const bodyAccelLat = forceLat / mass - r0 * u0;
  const accelLong = forceLong / mass;
  const accelLat = forceLat / mass;
  const yawAccel = yawMoment / Math.max(1, finite(params.yawInertia, cfg.yawInertia));
  state.velocityLong = clamp(u0 + bodyAccelLong * dt, -8, 115);
  state.velocityLat = clamp(v0 + bodyAccelLat * dt, -32, 32);
  state.yawRate = clamp(r0 + yawAccel * dt, -3.2, 3.2);

  // Parked-state regularisation prevents slip-angle noise from walking a car.
  if (Math.hypot(state.velocityLong, state.velocityLat) < 0.18 && drive < 50) {
    state.velocityLat *= Math.max(0, 1 - dt * 16);
    state.yawRate *= Math.max(0, 1 - dt * 14);
  }
  state.accelLong = accelLong;
  state.accelLat = accelLat;
  state.sideslip = Math.atan2(state.velocityLat, Math.max(0.5, Math.abs(state.velocityLong)));
  const result = state.result;
  result.forceLong = forceLong;
  result.forceLat = forceLat;
  result.yawMoment = yawMoment;
  result.tyreUse = maxUse;
  result.slip = slip;
  return result;
}

export function bodyToWorldVelocity(state, heading, out) {
  const sin = Math.sin(heading), cos = Math.cos(heading);
  out.x = sin * state.velocityLong + cos * state.velocityLat;
  out.z = cos * state.velocityLong - sin * state.velocityLat;
  return out;
}

export function setBodyVelocityFromWorld(state, heading, vx, vz) {
  const sin = Math.sin(heading), cos = Math.cos(heading);
  state.velocityLong = vx * sin + vz * cos;
  state.velocityLat = vx * cos - vz * sin;
  state.sideslip = Math.atan2(state.velocityLat, Math.max(0.5, Math.abs(state.velocityLong)));
}
