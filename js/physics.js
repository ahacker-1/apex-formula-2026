// 2026-spec car dynamics: ~50/50 ICE/electric power, active aero X/Z modes,
// Manual Override boost (replaces DRS), tyre compounds + wear, grip circle.
import * as THREE from 'three';
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH } from './contact.js';
import {
  bodyToWorldVelocity,
  createVehicleState,
  readSurfaceSample,
  resetVehicleState,
  setBodyVelocityFromWorld,
  stepVehicleDynamics,
} from './vehicleDynamics.js';

export const COMPOUNDS = {
  S: { key: 'S', name: 'SOFT', grip: 1.045, wearRate: 1.6, wetTyre: 0 },
  M: { key: 'M', name: 'MEDIUM', grip: 1.0, wearRate: 1.0, wetTyre: 0 },
  H: { key: 'H', name: 'HARD', grip: 0.962, wearRate: 0.62, wetTyre: 0 },
  // Wet suitability is consumed by TrackState.gripAt. Intermediate remains the
  // quicker rain tyre until standing water builds; full wet trades dry grip for
  // the strongest water evacuation and aquaplaning resistance.
  I: { key: 'I', name: 'INTERMEDIATE', grip: 0.945, wearRate: 1.20, wetTyre: 0.90 },
  W: { key: 'W', name: 'WET', grip: 0.93, wearRate: 1.35, wetTyre: 1.0 },
};

const G = 9.81, RHO = 1.2;
const BASE_MU = 1.62;
const CDA_Z = 1.45, CDA_X = 0.92;   // drag area: Z-mode vs X-mode (active aero)
const CLA_Z = 4.3, CLA_X = 1.5;     // downforce area
const P_BASE = 585e3;               // ICE + standard MGU-K deploy (W)
const P_OVERRIDE = 240e3;           // Manual Override extra deploy (W)

export function wallSupportDistance(relativeHeading) {
  return CAR_HALF_WIDTH * Math.abs(Math.cos(relativeHeading)) +
    CAR_HALF_LENGTH * Math.abs(Math.sin(relativeHeading));
}

function syncSurfaceFlags(car, circuit, sample) {
  const absLat = Math.abs(car.lat);
  car.offTrack = absLat > circuit.halfWidth + 0.4;
  car.onKerb = absLat > circuit.halfWidth - 0.5 &&
    absLat < circuit.halfWidth + 1.5 && Math.abs(sample.curv) > 1 / 260;
}

// ---- thermal / ERS model constants (additive; see CarPhysics fields) ----
const TYRE_START_T = 70;          // blanket-warmed set on the grid
const TYRE_FRESH_T = 75;          // blanket-warm fresh set, still below peak
const TYRE_COLD_T = 80;           // below this the compound is off temperature
const TYRE_HOT_T = 110;           // above this it starts to grain/overheat
const TYRE_COLD_LOSS = 0.08;      // up to -8% grip when stone cold
const TYRE_HOT_LOSS = 0.05;       // -5% grip once overheated (>115 °C)
const BRAKE_AMB = 90;             // cold-brake reference (°C)
const BRAKE_HEAT_K = 3.6;         // °C/s per 100 kW of braking power
const BRAKE_COOL_K = 0.0042;      // °C/s per °C above ambient (speed-scaled)
const BRAKE_FADE_T = 700;         // fade onset (°C)
const BRAKE_FADE_SPAN = 220;      // °C over which fade saturates
const BRAKE_FADE_MAX = 0.12;      // up to -12% brakeMax
const P_ERS_STD = 110e3;          // standard MGU-K deploy contained in P_BASE
const P_ERS_ATTACK = 40e3;        // extra deploy in attack mode (+40 kW)
const ATT_MAX = 0.045;            // rad clamp for pitch/roll (visual only)
const ATT_SNAP = 1e-4;            // below this the attitude outputs read exactly 0
// per-gear top speeds (m/s): 8-speed
export const GEAR_TOP = [0, 27.5, 37, 46.5, 56, 65.5, 75, 85.5, 96.5];

export function maxSteerAngle(v) {
  return Math.min(0.38, 0.05 + 0.42 / (1 + v * 0.085));
}

export class CarPhysics {
  constructor(circuit, opts = {}) {
    this.circuit = circuit;
    this.perf = opts.perf ?? 1;
    this.isPlayer = !!opts.isPlayer;
    this.assists = Object.assign({ tc: true, abs: true, autoGear: true }, opts.assists);
    this.random = opts.random ?? (() => Math.random());

    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.v = 0;
    this.gear = 1;
    this.rpmFrac = 0.2;
    this.steer = 0; this.roadWheelAngle = 0; this.throttle = 0; this.brake = 0;

    this.battery = 1;
    this.boosting = false;
    this.aeroX = false;
    this._xTimer = 0;

    this.compound = 'M';
    this.wear = 0;
    this.fuel = 1;
    this.fuelBurnPerMeter = 0; // set by race controller

    this.sampleIdx = 0;
    this.totalDist = 0;
    this.progressBase = 0;
    this._lapFloor = 0;
    this._wrongWayAcc = 0;
    this.lat = 0;

    this.offTrack = false;
    this.onKerb = false;
    this.slip = false;
    this.wallHit = 0;
    this.wallImpactNormalSpeed = 0;
    this.wallImpactFront = false;
    this.wallContact = false;
    this.wallScrape = 0;
    this.carScrape = 0;
    this.carScrapeSide = 0;
    this.impactKick = 0;
    this.wallLimit = circuit.wallOff - CAR_HALF_WIDTH;
    this._wallIncidentSide = 0;
    this.slipstream = 0;   // 0..1 set externally
    this.dirtyAir = 0;     // 0..1 set externally
    this.disabled = false; // hidden (in pit / DNF)
    this._shiftCooldown = 0;
    this._spinJitter = 0;

    // ---- additive: tyre & brake thermal state ----
    this.tyreTemp = TYRE_START_T;  // °C bulk carcass temp; window 90-110
    this.tyreGrip = 1;             // grip multiplier from tyreTemp (output)
    this.brakeTemp = BRAKE_AMB;    // °C; fades brakeMax above BRAKE_FADE_T
    this.brakeFade = 0;            // 0..0.12 fraction of brakeMax lost (output)

    // ---- additive: car attitude (visual only, never fed back into dynamics) ----
    this.pitch = 0;                // rad, +nose-up under power / -dive on brakes
    this.roll = 0;                 // rad, lateral body roll
    this.rideBump = 0;             // m, small vertical offset over kerbs
    this._bumpT = 0;

    // ---- additive: ERS mode 0 harvest | 1 balanced | 2 attack ----
    this.ersMode = 1;
    this.ersDeploy = 0;            // W of extra/removed standard deploy (output)

    // ---- additive: surface feel ----
    this.offTrackTime = 0;         // s continuously off track
    this.offTrackSink = 0;         // 0..1 progressive sink (drag up to +60%)
    this.kerbScrub = 0;            // 0..1 how hard the kerb is scrubbing speed
    this.frontAeroLoss = 0;        // 0..0.06 dirty-air front downforce loss

    // ---- four-corner rigid-body dynamics ----
    this.vehicle = createVehicleState(opts.vehicle);
    resetVehicleState(this.vehicle, this._pendingV || 0, TYRE_START_T);
    this.wheels = this.vehicle.wheels; // stable public references, FL/FR/RL/RR
    this.velocityLat = 0;
    this.yawRate = 0;
    this.sideslip = 0;
    this.longitudinalAcceleration = 0;
    this.lateralAcceleration = 0;
    this.slipAngle = 0;
    this.downforce = 0;
    this.brakeBias = THREE.MathUtils.clamp(opts.brakeBias ?? 0.56, 0.45, 0.68);
    this.brakeMigration = THREE.MathUtils.clamp(opts.brakeMigration ?? 0.025, -0.08, 0.08);
    this.diffLock = THREE.MathUtils.clamp(opts.diffLock ?? 0.45, 0, 1);
    this.engineBraking = THREE.MathUtils.clamp(opts.engineBraking ?? 0.055, 0, 0.16);
    this.aeroBalance = THREE.MathUtils.clamp(opts.aeroBalance ?? 0.45, 0.36, 0.55);
    this.rideHeight = THREE.MathUtils.clamp(opts.rideHeight ?? 0.038, 0.012, 0.12);
    this.surface = { grade: 0, camber: 0, bump: 0, grip: 1, wetness: 0,
      bumpFL: 0, bumpFR: 0, bumpRL: 0, bumpRR: 0,
      _gripOptions: { wetTyre: 0 } };
    this._worldVelocity = { x: 0, z: 0 };
    this._dynamicsParams = {};
    this._lastTyreTempAggregate = this.tyreTemp;
  }

  // `v` remains the longitudinal speed API consumed by AI, HUD and race code.
  // Assignments from those callers synchronize wheel speeds but do not erase an
  // already-existing lateral velocity (important during collision resolution).
  get v() { return this.vehicle ? this.vehicle.velocityLong : (this._pendingV || 0); }
  set v(value) {
    const next = Number.isFinite(value) ? value : 0;
    if (!this.vehicle) { this._pendingV = next; return; }
    const changed = Math.abs(next - this.vehicle.velocityLong) > 1e-9;
    this.vehicle.velocityLong = next;
    if (changed) {
      for (const wheel of this.vehicle.wheels) wheel.omega = next / wheel.radius;
    }
    if (Math.abs(next) < 0.01) {
      this.vehicle.velocityLat = 0;
      this.vehicle.yawRate = 0;
    }
  }
  get velocityLat() { return this.vehicle ? this.vehicle.velocityLat : (this._pendingLat || 0); }
  set velocityLat(value) {
    const next = Number.isFinite(value) ? value : 0;
    if (this.vehicle) this.vehicle.velocityLat = next;
    else this._pendingLat = next;
  }
  get yawRate() { return this.vehicle ? this.vehicle.yawRate : (this._pendingYawRate || 0); }
  set yawRate(value) {
    const next = Number.isFinite(value) ? value : 0;
    if (this.vehicle) this.vehicle.yawRate = next;
    else this._pendingYawRate = next;
  }
  get sideslip() { return this.vehicle ? this.vehicle.sideslip : (this._pendingSideslip || 0); }
  set sideslip(value) {
    const next = Number.isFinite(value) ? value : 0;
    if (this.vehicle) this.vehicle.sideslip = next;
    else this._pendingSideslip = next;
  }

  placeAt(pos, heading, idx) {
    this.pos.copy(pos);
    this.heading = heading;
    this.sampleIdx = idx;
    this.v = 0;
    resetVehicleState(this.vehicle, 0, this.tyreTemp);
    this.velocityLat = 0; this.yawRate = 0; this.sideslip = 0;
    this.longitudinalAcceleration = 0; this.lateralAcceleration = 0;
    this.slipAngle = 0; this.downforce = 0;
    this.totalDist = 0;
    // progress = totalDist + distance already covered past S/F; the floor of
    // progress/lapLength changes exactly at S/F crossings (in either direction)
    this.progressBase = idx * this.circuit.ds;
    this._lapFloor = 0;
    this._wrongWayAcc = 0;
    this.gear = 1;
    // attitude/surface state is positional — reset it with the car
    this.pitch = 0; this.roll = 0; this.rideBump = 0; this._bumpT = 0;
    this.offTrackTime = 0; this.offTrackSink = 0; this.kerbScrub = 0;
    this.wallHit = 0; this.wallContact = false; this.wallScrape = 0;
    this.wallImpactNormalSpeed = 0; this.wallImpactFront = false;
    this.carScrape = 0; this.carScrapeSide = 0; this.impactKick = 0; this._wallIncidentSide = 0;
    this.roadWheelAngle = 0;
  }

  setTyre(key) {
    this.compound = COMPOUNDS[key] ? key : 'M';
    this.wear = 0;
    // a fresh set comes out of the blankets cold — hence the slow out-lap
    this.tyreTemp = TYRE_FRESH_T;
    for (const wheel of this.wheels) {
      wheel.surfaceTemp = TYRE_FRESH_T;
      wheel.carcassTemp = TYRE_FRESH_T;
      wheel.pressure = wheel.front ? 145 : 132;
    }
    this._lastTyreTempAggregate = TYRE_FRESH_T;
  }

  get compoundData() { return COMPOUNDS[this.compound] || COMPOUNDS.M; }
  get kmh() { return Math.max(0, this.v) * 3.6; }
  get mass() { return 768 + 62 * this.fuel; }

  // grip multiplier from bulk tyre temperature: cold tyres (<80 °C) lose up to
  // 8%, the 80-110 °C window is peak, and past 115 °C they give up 5% and grain.
  tyreTempGrip() {
    const T = this.tyreTemp;
    if (T < TYRE_COLD_T) return 1 - TYRE_COLD_LOSS * Math.min(1, (TYRE_COLD_T - T) / 20);
    if (T <= TYRE_HOT_T) return 1;
    return 1 - TYRE_HOT_LOSS * Math.min(1, (T - TYRE_HOT_T) / 5);
  }

  muEff() {
    const c = this.compoundData;
    const wearF = 1 - 0.30 * Math.pow(this.wear, 1.5);
    const surface = this.offTrack ? 0.52 : 1;
    const perfF = 0.965 + 0.45 * (this.perf - 0.9); // 0.965..1.01
    const dirty = 1 - 0.05 * this.dirtyAir;
    this.tyreGrip = this.tyreTempGrip();
    // Per-wheel dynamics already applies thermal and pressure grip. Keep the
    // public aggregate for telemetry without charging the same cold loss twice.
    return BASE_MU * c.grip * wearF * surface * perfF * dirty;
  }

  // returns events { crossedSF, wallHit, wrongWay }
  step(dt, input) {
    const ev = { crossedSF: false, wallHit: 0, wrongWay: false };
    if (this.disabled) return ev;
    const c = this.circuit;
    const m = this.mass;

    this.steer += (THREE.MathUtils.clamp(input.steer, -1, 1) - this.steer) * Math.min(1, dt * 16);
    this.throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
    this.brake = THREE.MathUtils.clamp(input.brake, 0, 1);
    this.slip = false;
    this.wallHit = 0;
    this.wallImpactNormalSpeed = 0;
    this.wallImpactFront = false;
    this.wallScrape = 0;
    this.impactKick *= Math.max(0, 1 - dt * 8);
    const v0 = this.v;   // for attitude (pure output) accelerations

    // ---- ERS mode (optional input; unset leaves the current mode alone) ----
    if (input.ersMode != null) {
      const em = Math.round(input.ersMode);
      if (em === 0 || em === 1 || em === 2) this.ersMode = em;
    }

    // Optional setup/control hooks. Omitted fields retain the configured value,
    // so every legacy AI and player input object continues to work unchanged.
    if (Number.isFinite(input.brakeBias)) this.brakeBias = THREE.MathUtils.clamp(input.brakeBias, 0.45, 0.68);
    if (Number.isFinite(input.brakeMigration)) this.brakeMigration = THREE.MathUtils.clamp(input.brakeMigration, -0.08, 0.08);
    if (Number.isFinite(input.diffLock)) this.diffLock = THREE.MathUtils.clamp(input.diffLock, 0, 1);
    if (Number.isFinite(input.engineBraking)) this.engineBraking = THREE.MathUtils.clamp(input.engineBraking, 0, 0.16);
    if (Number.isFinite(input.aeroBalance)) this.aeroBalance = THREE.MathUtils.clamp(input.aeroBalance, 0.36, 0.55);

    // A direct legacy tyreTemp assignment is treated as a blanket/setup change
    // and propagated once into all four thermal states.
    if (Math.abs(this.tyreTemp - this._lastTyreTempAggregate) > 0.05) {
      for (const wheel of this.wheels) {
        wheel.surfaceTemp = this.tyreTemp;
        wheel.carcassTemp = this.tyreTemp;
      }
    }
    // readSurfaceSample reuses this object and its TrackState grip scratch, so
    // changing compound never allocates inside the fixed-step loop.
    this.surface._gripOptions.wetTyre = this.compoundData.wetTyre || 0;
    readSurfaceSample(c, this.sampleIdx, this.pos, this.surface);

    // ---- active aero (X-mode on straights, Z-mode in corners) ----
    const speed = Math.hypot(this.vehicle.velocityLong, this.vehicle.velocityLat);
    const xEligible = Math.abs(this.steer) < 0.12 && speed > 50 && this.throttle > 0.6 && this.brake < 0.05;
    this._xTimer = xEligible ? this._xTimer + dt : 0;
    this.aeroX = this._xTimer > 0.35;
    const cda = (this.aeroX ? CDA_X : CDA_Z) * (1 - 0.28 * this.slipstream);
    const cla = this.aeroX ? CLA_X : CLA_Z;
    const downF = 0.5 * RHO * cla * speed * speed;
    this.downforce = downF;
    const mu = this.muEff();

    // ---- gears / rpm ----
    this._shiftCooldown -= dt;
    const top = GEAR_TOP[this.gear];
    this.rpmFrac = THREE.MathUtils.clamp(Math.max(0, this.v) / top, 0.18, 1.04);
    if (this.assists.autoGear) {
      if (this.rpmFrac > 0.97 && this.gear < 8 && this._shiftCooldown <= 0) { this.gear++; this._shiftCooldown = 0.25; ev.shifted = 1; }
      else if (this.rpmFrac < 0.58 && this.gear > 1 && this._shiftCooldown <= 0) { this.gear--; this._shiftCooldown = 0.2; ev.shifted = -1; }
    } else {
      if (input.shiftUp && this.gear < 8 && this._shiftCooldown <= 0) { this.gear++; this._shiftCooldown = 0.15; ev.shifted = 1; }
      if (input.shiftDown && this.gear > 1 && this._shiftCooldown <= 0) { this.gear--; this._shiftCooldown = 0.15; ev.shifted = -1; }
    }

    // ---- steering and powertrain demand ----
    const dMax = maxSteerAngle(this.v);
    // dirty air robs front downforce first: in corners behind a car the front
    // washes out, so the same steering input yields ~6% less turn-in.
    const cornering = THREE.MathUtils.clamp((Math.abs(this.steer) - 0.12) / 0.18, 0, 1);
    this.frontAeroLoss = 0.06 * THREE.MathUtils.clamp((this.dirtyAir - 0.3) / 0.35, 0, 1) * cornering;
    const delta = this.steer * dMax * (1 - this.frontAeroLoss);
    this.roadWheelAngle = delta;
    let pf = THREE.MathUtils.clamp(0.35 + this.rpmFrac * 0.75, 0, 1.05);
    if (this.rpmFrac > 1.0) pf *= 0.55; // limiter
    // team performance scales effective power 94%..103%
    const perfPow = 0.94 + 0.9 * (this.perf - 0.9);
    let power = P_BASE * perfPow * pf;
    // ---- ERS deployment mode (Manual Override boost is applied on top) ----
    this.ersDeploy = 0;
    if (this.ersMode === 0) {
      // harvest: the standard MGU-K deploy is switched off above 80% throttle
      if (this.throttle > 0.8) {
        this.ersDeploy = -P_ERS_STD * pf;
        power = Math.max(0, power + this.ersDeploy);
      }
    } else if (this.ersMode === 2 && this.throttle > 0.3 && this.battery > 0.02) {
      // attack: extra deploy, drained from the battery
      this.ersDeploy = P_ERS_ATTACK * pf;
      power += this.ersDeploy;
      this.battery = Math.max(0, this.battery - dt * 0.06 * this.throttle);
    }
    this.boosting = !!input.boost && this.battery > 0.04 && this.throttle > 0.5;
    if (this.boosting) {
      power += P_OVERRIDE;
      this.battery = Math.max(0, this.battery - dt * 0.16);
    }
    let fDrive = this.throttle * power / Math.max(Math.abs(this.v), 5.5);
    const rearSlip = Math.max(Math.abs(this.wheels[2].slipRatio), Math.abs(this.wheels[3].slipRatio));
    if (this.assists.tc && rearSlip > 0.11) fDrive *= THREE.MathUtils.clamp(1.7 - rearSlip * 6, 0.18, 1);
    // Unequal rear contact forces already generate real yaw in the four-wheel
    // solver. Random heading injection made symmetric TC-off launches veer.
    // brakes — heat soak fades the discs (brakeTemp updated below)
    this.brakeFade = BRAKE_FADE_MAX *
      THREE.MathUtils.clamp((this.brakeTemp - BRAKE_FADE_T) / BRAKE_FADE_SPAN, 0, 1);
    let fBrake = 0;
    // harvest mode recovers twice as much energy under braking and on the coast
    const harvestF = this.ersMode === 0 ? 2 : 1;
    if (this.brake > 0 && this.v > 0) {
      const brakeMax = mu * (m * G + downF);
      fBrake = this.brake * brakeMax;
      const lockSlip = Math.min(this.wheels[0].slipRatio, this.wheels[1].slipRatio,
        this.wheels[2].slipRatio, this.wheels[3].slipRatio);
      if (this.assists.abs && lockSlip < -0.14) fBrake *= THREE.MathUtils.clamp(1.65 + lockSlip * 5, 0.2, 1);
      if (!this.assists.abs && this.brake > 0.96 && this.v > 12) {
        this.slip = true;
        this.wear += 0.012 * dt * this.compoundData.wearRate;
      }
      this.battery = Math.min(1, this.battery + dt * 0.11 * this.brake * harvestF); // harvest
    } else if (this.throttle < 0.3) {
      this.battery = Math.min(1, this.battery + dt * 0.015 * harvestF);
    }
    // Off-track surfaces get progressively worse the deeper the car digs in.
    // The WHOLE off-track penalty fades below ~6 m/s: with degraded/cold tyres
    // the available traction can drop under the flat 2600N, which permanently
    // beached cars (observed as sim flake at Bahrain). At crawl speed the car
    // must always out-pull the surface.
    const offDrag = this.offTrack
      ? (600 + 2000 * Math.min(1, Math.abs(this.v) / 6)) *
        (1 + 0.6 * this.offTrackSink * Math.min(1, Math.abs(this.v) / 14))
      : 0;
    const fDrag = 0.5 * RHO * cda * speed * speed + 210 + 3.5 * speed + offDrag;
    this._stepBrakeTemp(dt, fBrake);

    // ---- four independent wheel/contact states + rigid body integration ----
    const dynamicBias = THREE.MathUtils.clamp(this.brakeBias - this.brakeMigration * this.brake, 0.45, 0.68);
    const engineBrake = this.throttle < 0.12 && this.v > 2
      ? this.engineBraking * m * G * (1 - this.throttle / 0.12)
      : 0;
    const rideFront = this.rideHeight + this.rideBump + this.pitch * 0.55;
    const rideRear = this.rideHeight + this.rideBump - this.pitch * 0.55;
    const substeps = Math.max(1, Math.ceil(dt * 60 - 1e-9));
    const h = dt / substeps;
    const dyn = this._dynamicsParams;
    dyn.mass = m;
    dyn.steerAngle = delta;
    dyn.driveForce = fDrive;
    dyn.brakeForce = fBrake;
    dyn.brakeEffectiveness = 1 - this.brakeFade;
    dyn.engineBrakeForce = engineBrake;
    dyn.brakeBias = dynamicBias;
    dyn.diffLock = this.diffLock;
    dyn.abs = this.assists.abs;
    dyn.tc = this.assists.tc;
    dyn.stabilityAssist = this.assists.abs || this.assists.tc;
    dyn.downforce = downF;
    dyn.aeroBalance = this.aeroBalance;
    dyn.rideHeightFront = rideFront;
    dyn.rideHeightRear = rideRear;
    dyn.externalForceLong = -fDrag * Math.sign(this.v || 1);
    dyn.mu = mu;
    dyn.surface = this.surface;
    let dynamics;
    for (let sub = 0; sub < substeps; sub++) {
      dynamics = stepVehicleDynamics(this.vehicle, dyn, h);
      this.heading += (this.vehicle.yawRate + this._spinJitter) * h;
      bodyToWorldVelocity(this.vehicle, this.heading, this._worldVelocity);
      this.pos.x += this._worldVelocity.x * h;
      this.pos.z += this._worldVelocity.z * h;
    }
    this._spinJitter *= Math.max(0, 1 - dt * 4);
    this.velocityLat = this.vehicle.velocityLat;
    this.yawRate = this.vehicle.yawRate;
    this.sideslip = this.vehicle.sideslip;
    this.longitudinalAcceleration = this.vehicle.accelLong;
    this.lateralAcceleration = this.vehicle.accelLat;
    this.slipAngle = this.vehicle.sideslip;
    this.slip ||= dynamics.slip;
    const latUse = dynamics.tyreUse;
    const longUse = Math.max(fDrive, fBrake) / Math.max(1, mu * (m * G + downF));
    this.tyreTemp = (this.wheels[0].carcassTemp + this.wheels[1].carcassTemp +
      this.wheels[2].carcassTemp + this.wheels[3].carcassTemp) * 0.25;
    this._lastTyreTempAggregate = this.tyreTemp;
    this.tyreGrip = this.tyreTempGrip();
    this.wear = Math.min(1, this.wear + dynamics.tyreUse * dynamics.tyreUse * 0.00038 * dt *
      this.compoundData.wearRate * (0.85 + speed / 90));
    // fuel burn
    this.fuel = Math.max(0, this.fuel - Math.abs(this.v) * dt * this.fuelBurnPerMeter);
    // Reverse remains the established recovery control (hold brake at rest).
    if (this.v <= 0.15 && this.brake > 0.5 && this.throttle < 0.1 && this.isPlayer) {
      this.vehicle.velocityLong = Math.max(this.v - 6 * dt, -4);
      for (const wheel of this.wheels) wheel.omega = this.vehicle.velocityLong / wheel.radius;
    } else if (this.v < 0 && this.brake < 0.3) {
      this.vehicle.velocityLong = Math.min(this.v + 8 * dt, 0);
    }

    // ---- track relation ----
    const prevIdx = this.sampleIdx;
    this.sampleIdx = c.nearestSample(this.pos, this.sampleIdx);
    const s = c.samples[this.sampleIdx];
    this.lat = c.lateralAt(this.pos, this.sampleIdx);
    const absLat = Math.abs(this.lat);
    this.offTrack = absLat > c.halfWidth + 0.4;
    this.onKerb = absLat > c.halfWidth - 0.5 && absLat < c.halfWidth + 1.5 && Math.abs(s.curv) > 1 / 260;
    if (this.offTrack) this.wear = Math.min(1, this.wear + 0.002 * dt);
    // progressive sink: gravel/grass keeps grabbing more the longer you're in it
    this.offTrackTime = this.offTrack ? Math.min(6, this.offTrackTime + dt) : 0;
    this.offTrackSink = Math.min(1, this.offTrackTime / 2);
    // kerb rumble: riding a kerb hard through a corner scrubs speed
    this.kerbScrub = this.onKerb
      ? THREE.MathUtils.clamp((latUse - 0.7) / 0.3, 0, 1) * (Math.abs(this.v) > 12 ? 1 : 0)
      : 0;
    if (this.kerbScrub > 0) {
      this.v -= this.v * 0.035 * this.kerbScrub * dt;
      this.wear = Math.min(1, this.wear + 0.0006 * dt * this.kerbScrub * this.compoundData.wearRate);
    }
    this._stepAttitude(dt, v0, this.yawRate);

    ev.wallHit = this.resolveWallCollision(true);

    // progress / lap crossing
    let dd = this.sampleIdx - prevIdx;
    if (dd > c.N / 2) dd -= c.N;
    if (dd < -c.N / 2) dd += c.N;
    this.totalDist += dd * c.ds;
    // S/F crossing via continuous progress: the floor of progress/lapLength
    // changes exactly at the line, in either direction (+1 forward, -1 reverse).
    // Immune to jitter double-counts and to being nudged across at v≈0.
    const prog = this.totalDist + this.progressBase;
    const lapFloor = Math.floor(prog / c.length);
    if (lapFloor !== this._lapFloor) {
      ev.crossedSF = lapFloor > this._lapFloor ? 1 : -1;
      this._lapFloor = lapFloor;
    }
    // wrong way: sustained backward progress while under power
    if (dd < 0 && this.v > 3) this._wrongWayAcc += dd * c.ds;
    else this._wrongWayAcc = 0;
    if (this._wrongWayAcc < -25) ev.wrongWay = true;

    return ev;
  }

  // Resolve the yaw-aware car footprint against the nearest wall. The contact
  // impulse is decomposed in wall space, so tangent progress survives a graze
  // while the outward component becomes a small inward separation velocity.
  // Returns a one-tick impact intensity; sustained contact is exposed separately
  // through wallContact/wallScrape.
  projectWallConstraint() {
    const c = this.circuit;
    this.sampleIdx = c.nearestSample(this.pos, this.sampleIdx);
    const s = c.samples[this.sampleIdx];
    this.lat = c.lateralAt(this.pos, this.sampleIdx);
    const trackAng = Math.atan2(s.t.x, s.t.z);
    const wallLim = Math.max(0.1, c.wallOff - wallSupportDistance(angleDiff(this.heading, trackAng)));
    this.wallLimit = wallLim;
    const penetration = Math.abs(this.lat) - wallLim;
    if (penetration <= 0) {
      syncSurfaceFlags(this, c, s);
      return 0;
    }

    // Geometry-only projection for an iterative multi-car constraint solve.
    // Never change heading, speed, incident state, or feedback here: doing so
    // inside every solver pass can oscillate a millimetre overlap into a deep
    // body intersection. The regular physics wall solve owns the impulse.
    const side = Math.sign(this.lat) || 1;
    const dx = this.pos.x - s.p.x;
    const dz = this.pos.z - s.p.z;
    const along = dx * s.t.x + dz * s.t.z;
    this.pos.x = s.p.x + s.t.x * along + s.n.x * side * wallLim;
    this.pos.z = s.p.z + s.t.z * along + s.n.z * side * wallLim;
    this.lat = c.lateralAt(this.pos, this.sampleIdx);
    syncSurfaceFlags(this, c, s);
    return penetration;
  }

  resolveWallCollision(emitImpact = true) {
    const c = this.circuit;
    this.sampleIdx = c.nearestSample(this.pos, this.sampleIdx);
    const s = c.samples[this.sampleIdx];
    this.lat = c.lateralAt(this.pos, this.sampleIdx);
    const trackAng = Math.atan2(s.t.x, s.t.z);
    const support = wallSupportDistance(angleDiff(this.heading, trackAng));
    const wallLim = Math.max(0.1, c.wallOff - support);
    this.wallLimit = wallLim;
    const absLat = Math.abs(this.lat);

    if (absLat <= wallLim) {
      if (this._wallIncidentSide && absLat < wallLim - 0.25) {
        this._wallIncidentSide = 0;
        this.wallContact = false;
      } else {
        this.wallContact = this._wallIncidentSide !== 0;
      }
      this.wallScrape = 0;
      // Car-to-car correction can move a car across the track edge while still
      // inside the wall. Refresh surface state on this early-return path too.
      syncSurfaceFlags(this, c, s);
      return 0;
    }

    const side = Math.sign(this.lat) || this._wallIncidentSide || 1;
    const newIncident = this._wallIncidentSide !== side;
    this._wallIncidentSide = side;
    this.wallContact = true;

    // Correct only along the wall normal. The previous code replaced x and z
    // with the discrete sample anchor, visibly deleting along-track progress.
    const dx = this.pos.x - s.p.x;
    const dz = this.pos.z - s.p.z;
    const along = dx * s.t.x + dz * s.t.z;
    this.pos.x = s.p.x + s.t.x * along + s.n.x * side * wallLim;
    this.pos.z = s.p.z + s.t.z * along + s.n.z * side * wallLim;
    this.lat = c.lateralAt(this.pos, this.sampleIdx);

    const oldSign = this.v < 0 ? -1 : 1;
    bodyToWorldVelocity(this.vehicle, this.heading, this._worldVelocity);
    const vx = this._worldVelocity.x;
    const vz = this._worldVelocity.z;
    const tangentVelocity = vx * s.t.x + vz * s.t.z;
    const normalVelocity = vx * s.n.x + vz * s.n.z;
    const outwardSpeed = Math.max(0, normalVelocity * side);
    const frontContact = side * (Math.sin(this.heading) * s.n.x + Math.cos(this.heading) * s.n.z) > 0.45;

    if (outwardSpeed > 0) {
      const tangentRetention = THREE.MathUtils.clamp(0.96 - outwardSpeed * 0.005, 0.72, 0.94);
      const tangentAfter = tangentVelocity * tangentRetention;
      // Restitution must never accelerate a crawling car. Positional projection
      // already prevents sticking, so no minimum rebound speed is necessary.
      const separationSpeed = Math.min(6, outwardSpeed * 0.12);
      const normalAfter = -side * separationSpeed;
      const nextVx = s.t.x * tangentAfter + s.n.x * normalAfter;
      const nextVz = s.t.z * tangentAfter + s.n.z * normalAfter;
      // Keep a small pre-impact sideslip rather than forcing the velocity vector
      // onto the body axis. Heading compatibility is retained for old render and
      // handling callers while the residual lives in the rigid-body state.
      const retainedBeta = THREE.MathUtils.clamp(this.sideslip || 0, -0.02, 0.02);
      this.heading = Math.atan2(nextVx * oldSign, nextVz * oldSign) - retainedBeta;
      setBodyVelocityFromWorld(this.vehicle, this.heading, nextVx, nextVz);
      this.velocityLat = this.vehicle.velocityLat;
      this.sideslip = this.vehicle.sideslip;
    }

    this.wallScrape = THREE.MathUtils.clamp((Math.abs(tangentVelocity) - 3) / 45, 0, 1) *
      THREE.MathUtils.clamp(1 - outwardSpeed / 22, 0.18, 1);
    syncSurfaceFlags(this, c, s);

    if (emitImpact && newIncident && outwardSpeed > 2) {
      const intensity = THREE.MathUtils.clamp(0.15 + outwardSpeed / 45, 0, 1);
      this.wallHit = Math.max(this.wallHit, intensity);
      this.wallImpactNormalSpeed = outwardSpeed;
      this.wallImpactFront = frontContact;
      this.impactKick = Math.max(this.impactKick, intensity);
      return intensity;
    }
    return 0;
  }

  // ---- additive helpers (all state they touch is new, except tyre wear) ----

  // Brake disc temperature: heats with braking power, cools with airflow.
  _stepBrakeTemp(dt, fBrake) {
    const speed = Math.abs(this.v);
    const heat = BRAKE_HEAT_K * (fBrake * speed) / 1e5;
    const cool = BRAKE_COOL_K * (this.brakeTemp - BRAKE_AMB) * (0.25 + speed / 55);
    this.brakeTemp = THREE.MathUtils.clamp(this.brakeTemp + (heat - cool) * dt, BRAKE_AMB, 1200);
  }

  // Visual-only body attitude. Derived from the accelerations this step and
  // smoothed; nothing here feeds back into the dynamics.
  _stepAttitude(dt, v0, w) {
    const aLong = (this.v - v0) / Math.max(dt, 1e-4);
    const aLat = w * this.v;
    // a parked car sits level, whatever the residual numerical accelerations are
    const still = Math.abs(this.v) < 0.5;
    const pitchT = still ? 0 : THREE.MathUtils.clamp(aLong * 0.0011, -ATT_MAX, ATT_MAX);
    const rollT = still ? 0 : THREE.MathUtils.clamp(-aLat * 0.0010, -ATT_MAX, ATT_MAX);
    this.pitch += (pitchT - this.pitch) * Math.min(1, dt * 7);
    this.roll += (rollT - this.roll) * Math.min(1, dt * 6);
    // kerb rattle: deterministic pseudo-noise, decays away once back on tarmac
    this._bumpT += dt;
    let bumpT = 0;
    if (this.onKerb && Math.abs(this.v) > 3) {
      const n = Math.sin(this._bumpT * 61.7) * Math.sin(this._bumpT * 23.9 + 1.3);
      bumpT = 0.022 * n * Math.min(1, 0.35 + Math.abs(this.v) / 60);
    }
    this.rideBump += (bumpT - this.rideBump) * Math.min(1, dt * 14);
    if (Math.abs(this.pitch) < ATT_SNAP) this.pitch = 0;
    if (Math.abs(this.roll) < ATT_SNAP) this.roll = 0;
    if (Math.abs(this.rideBump) < ATT_SNAP) this.rideBump = 0;
  }
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
