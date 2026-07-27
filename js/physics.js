// 2026-spec car dynamics: ~50/50 ICE/electric power, active aero X/Z modes,
// Manual Override boost (replaces DRS), tyre compounds + wear, grip circle.
import * as THREE from 'three';

export const COMPOUNDS = {
  S: { key: 'S', name: 'SOFT', grip: 1.045, wearRate: 1.6 },
  M: { key: 'M', name: 'MEDIUM', grip: 1.0, wearRate: 1.0 },
  H: { key: 'H', name: 'HARD', grip: 0.962, wearRate: 0.62 },
};

const G = 9.81, RHO = 1.2;
const BASE_MU = 1.62;
const CDA_Z = 1.45, CDA_X = 0.92;   // drag area: Z-mode vs X-mode (active aero)
const CLA_Z = 4.3, CLA_X = 1.5;     // downforce area
const P_BASE = 585e3;               // ICE + standard MGU-K deploy (W)
const P_OVERRIDE = 240e3;           // Manual Override extra deploy (W)
const WHEELBASE = 3.4;

// ---- thermal / ERS model constants (additive; see CarPhysics fields) ----
const TRACK_TEMP = 30;            // ambient air/track reference (°C)
const TYRE_START_T = 70;          // blanket-warmed set on the grid
const TYRE_FRESH_T = 65;          // fresh set fitted in the pits (out-lap)
const TYRE_HEAT_K = 1.80;         // °C/s at full working load
const TYRE_COOL_K = 0.024;        // °C/s per °C above ambient (speed-scaled)
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

    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.v = 0;
    this.gear = 1;
    this.rpmFrac = 0.2;
    this.steer = 0; this.throttle = 0; this.brake = 0;

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
  }

  placeAt(pos, heading, idx) {
    this.pos.copy(pos);
    this.heading = heading;
    this.sampleIdx = idx;
    this.v = 0;
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
  }

  setTyre(key) {
    this.compound = key;
    this.wear = 0;
    // a fresh set comes out of the blankets cold — hence the slow out-lap
    this.tyreTemp = TYRE_FRESH_T;
  }

  get compoundData() { return COMPOUNDS[this.compound]; }
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
    return BASE_MU * c.grip * wearF * surface * perfF * dirty * this.tyreGrip;
  }

  // returns events { crossedSF, wallHit, wrongWay }
  step(dt, input) {
    const ev = { crossedSF: false, wallHit: 0, wrongWay: false };
    if (this.disabled) return ev;
    const c = this.circuit;
    const m = this.mass;

    this.steer += (THREE.MathUtils.clamp(input.steer, -1, 1) - this.steer) * Math.min(1, dt * 10);
    this.throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
    this.brake = THREE.MathUtils.clamp(input.brake, 0, 1);
    this.slip = false;
    this.wallHit = 0;
    const v0 = this.v;   // for attitude (pure output) accelerations

    // ---- ERS mode (optional input; unset leaves the current mode alone) ----
    if (input.ersMode != null) {
      const em = Math.round(input.ersMode);
      if (em === 0 || em === 1 || em === 2) this.ersMode = em;
    }

    // ---- active aero (X-mode on straights, Z-mode in corners) ----
    const xEligible = Math.abs(this.steer) < 0.12 && this.v > 50 && this.throttle > 0.6 && this.brake < 0.05;
    this._xTimer = xEligible ? this._xTimer + dt : 0;
    this.aeroX = this._xTimer > 0.35;
    const cda = (this.aeroX ? CDA_X : CDA_Z) * (1 - 0.28 * this.slipstream);
    const cla = this.aeroX ? CLA_X : CLA_Z;
    const downF = 0.5 * RHO * cla * this.v * this.v;
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

    // ---- lateral dynamics ----
    const dMax = maxSteerAngle(this.v);
    // dirty air robs front downforce first: in corners behind a car the front
    // washes out, so the same steering input yields ~6% less turn-in.
    const cornering = THREE.MathUtils.clamp((Math.abs(this.steer) - 0.12) / 0.18, 0, 1);
    this.frontAeroLoss = 0.06 * THREE.MathUtils.clamp((this.dirtyAir - 0.3) / 0.35, 0, 1) * cornering;
    const delta = this.steer * dMax * (1 - this.frontAeroLoss);
    const wDes = this.v * Math.tan(delta) / WHEELBASE;
    const aLatMax = mu * (G + downF / m);
    const aNeed = Math.abs(wDes * this.v);
    let w, latUse;
    if (aNeed <= aLatMax || this.v < 2) {
      w = wDes;
      latUse = aLatMax > 0 ? aNeed / aLatMax : 0;
    } else {
      w = Math.sign(wDes) * aLatMax / Math.max(this.v, 1);
      latUse = 1;
      this.slip = true;
      const over = Math.min(1.5, aNeed / aLatMax - 1);
      this.v -= this.v * 0.22 * over * dt;           // understeer scrub
      this.wear += 0.006 * over * dt * this.compoundData.wearRate;
    }
    this.heading += w * dt + this._spinJitter * dt;
    this._spinJitter *= Math.max(0, 1 - dt * 4);

    // ---- longitudinal ----
    const gripCircle = Math.sqrt(Math.max(0.06, 1 - latUse * latUse * 0.92));
    // power
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
    let fDrive = this.throttle * power / Math.max(this.v, 5.5);
    // traction limit (rear axle ~ 62% weight + downforce share)
    const traction = mu * (m * G * 0.62 + downF * 0.55) * gripCircle;
    let longUse = traction > 0 ? Math.min(1, fDrive / traction) : 0;
    if (fDrive > traction) {
      if (this.assists.tc) fDrive = traction;
      else {
        fDrive = traction * 0.55;
        this.slip = true;
        this.wear += 0.008 * dt * this.compoundData.wearRate;
        if (this.gear <= 3 && this.throttle > 0.85) this._spinJitter += (Math.random() - 0.5) * 0.35;
      }
    }
    // brakes — heat soak fades the discs (brakeTemp updated below)
    this.brakeFade = BRAKE_FADE_MAX *
      THREE.MathUtils.clamp((this.brakeTemp - BRAKE_FADE_T) / BRAKE_FADE_SPAN, 0, 1);
    let fBrake = 0;
    // harvest mode recovers twice as much energy under braking and on the coast
    const harvestF = this.ersMode === 0 ? 2 : 1;
    if (this.brake > 0 && this.v > 0) {
      const brakeMax = mu * (m * G + downF) * gripCircle * (1 - this.brakeFade);
      fBrake = this.brake * brakeMax;
      if (!this.assists.abs && this.brake > 0.96 && this.v > 12) {
        fBrake *= 0.72; this.slip = true;
        this.wear += 0.012 * dt * this.compoundData.wearRate;
      }
      longUse = Math.max(longUse, brakeMax > 0 ? Math.min(1, fBrake / brakeMax) : 0);
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
    const fDrag = 0.5 * RHO * cda * this.v * this.v + 180 + 3.5 * this.v + offDrag;
    const a = (fDrive - fBrake - fDrag * Math.sign(this.v || 1)) / m;
    this.v += a * dt;
    this._stepBrakeTemp(dt, fBrake);
    // reverse (recovery) when holding brake at standstill
    if (this.v <= 0.15 && this.brake > 0.5 && this.throttle < 0.1 && this.isPlayer) {
      this.v = Math.max(this.v - 6 * dt, -4);
    } else if (this.v < 0 && this.brake < 0.3) {
      this.v = Math.min(this.v + 8 * dt, 0);
    }
    if (this.v < 0.02 && this.v > -0.02) this.v = this.v < 0 ? 0 : this.v;

    // tyre temperature: heats with lateral/longitudinal load and slip, sheds
    // heat with airflow (so it drops down the straights)
    this._stepTyreTemp(dt, latUse, longUse);
    // tyre thermal/deg from lateral load
    this.wear = Math.min(1, this.wear + latUse * latUse * 0.00038 * dt * this.compoundData.wearRate * (0.85 + this.v / 90));
    // fuel burn
    this.fuel = Math.max(0, this.fuel - Math.abs(this.v) * dt * this.fuelBurnPerMeter);

    // ---- integrate position ----
    const dir = Math.abs(this.v) > 0.001 ? Math.sign(this.v) : 1;
    this.pos.x += Math.sin(this.heading) * this.v * dt;
    this.pos.z += Math.cos(this.heading) * this.v * dt;

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
    this._stepAttitude(dt, v0, w);

    // wall collision
    const wallLim = c.wallOff - 0.95;
    if (absLat > wallLim) {
      const sign = Math.sign(this.lat);
      this.pos.x = s.p.x + s.n.x * sign * wallLim;
      this.pos.z = s.p.z + s.n.z * sign * wallLim;
      const trackAng = Math.atan2(s.t.x, s.t.z);
      let diff = angleDiff(this.heading, trackAng);
      const impact = Math.abs(Math.sin(diff));
      if (impact > 0.08 && Math.abs(this.v) > 2) {
        this.v *= 1 - 0.5 * impact;
        this.wallHit = Math.min(1, impact * Math.abs(this.v) / 40 + 0.15);
        ev.wallHit = this.wallHit;
      } else {
        this.v *= 1 - 0.15 * dt; // grinding
      }
      // deflect heading along wall
      this.heading = trackAng + Math.sign(diff) * Math.min(Math.abs(diff), 0.35) * 0.4;
    }

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

  // ---- additive helpers (all state they touch is new, except tyre wear) ----

  // Tyre carcass temperature. Load (lateral + longitudinal + slip) pushes heat
  // in; airflow takes it out, so temps sag on the straights and build in the
  // corners. Overheating past 115 °C also grains the surface (extra wear).
  _stepTyreTemp(dt, latUse, longUse) {
    const speed = Math.abs(this.v);
    // carcass deformation keeps feeding heat in even on a straight, so the
    // working load never drops to zero at speed
    const rolling = 0.30 * (speed / 80) * (speed / 80);
    const load = Math.min(1.6,
      0.9 * latUse * latUse + 0.5 * longUse * longUse + rolling + (this.slip ? 0.12 : 0));
    const heat = TYRE_HEAT_K * load * (0.55 + speed / 70);
    const cool = TYRE_COOL_K * (this.tyreTemp - TRACK_TEMP) * (0.55 + speed / 140);
    this.tyreTemp = THREE.MathUtils.clamp(this.tyreTemp + (heat - cool) * dt, TRACK_TEMP, 165);
    if (this.tyreTemp > 115) {
      const over = Math.min(1, (this.tyreTemp - 115) / 25);
      this.wear = Math.min(1, this.wear + 0.0004 * over * dt * this.compoundData.wearRate);
    }
    this.tyreGrip = this.tyreTempGrip();
  }

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
