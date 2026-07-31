// AI driver: pure-pursuit on the racing line, braking-horizon speed control,
// side-by-side avoidance & overtaking, defending, battle variance, consistency-
// based mistakes, boost tactics. Race-direction state (VSC, blue flags,
// track-limit scrubs) is pushed in by RaceSession through the fields below.
import { angleDiff, maxSteerAngle } from './physics.js';

const ABRAKE_PLAN = 38;

export class AIDriver {
  constructor(car, circuit, driver, difficulty, random = () => Math.random()) {
    this.car = car;
    this.circuit = circuit;
    this.driver = driver;
    this.random = random;
    // difficulty 0..2 (easy/med/hard); skill combines with driver pace
    const diffF = [0.925, 0.962, 1.0][difficulty] ?? 1.0;
    this.skill = diffF * (0.94 + 0.06 * driver.pace);
    this.avoidOffset = 0;
    this.mistakeTimer = 0;
    this.mistakeCooldown = 8 + this.random() * 8;
    this.lapNoise = 1;

    // ---- race-direction state (written by RaceSession) ----
    this.vscFactor = 1;       // 1 = green flag, 0.6 while the VSC is deployed
    this.noOvertake = false;  // VSC: hold position (avoidance passes suppressed)
    this.yieldOffset = 0;     // blue flags: metres off the racing line
    this.yieldT = 0;          // seconds of blue-flag yielding remaining
    this.scrubT = 0;          // seconds of track-limits pace scrub remaining

    // ---- environment / car state (safe defaults; RaceSession may override) ----
    this.trackGrip = 1;
    this.wetness = 0;
    this.damage = { power: 1, topSpeed: 1, grip: 1, braking: 1, steeringBias: 0, aeroLoss: 0 };
    this.fuelMode = 'balanced';
    this.strategy = null;
    this.raceControlState = 'green';

    // ---- racecraft ----
    this.defendOffset = 0;    // metres of defensive line change
    this.defendT = 0;         // seconds of the current defensive move left
    this._defendSide = 0;
    this._defendMag = 1.8;    // metres of the move, scaled to circuit width
    this._defendCool = 0;     // minimum gap between defensive moves
    this._defendArmed = true; // one legal line change per straight
    this.battleT = 0;         // seconds spent within 1s of another car
    this.fighting = false;    // battle variance currently active

    this.input = { steer: 0, throttle: 0, brake: 0, boost: false };
  }

  newLapNoise() {
    this.lapNoise = 1 + (this.random() - 0.5) * 0.012 * (2 - this.driver.consistency);
  }

  // ---- hooks used by RaceSession ----
  /** Blue flags: move `offset` metres off line and back off for `secs`. */
  setYield(offset, secs = 4) {
    this.yieldOffset = offset;
    this.yieldT = Math.max(this.yieldT, secs);
  }
  /** Track-limits sanction for AI: a small, brief pace scrub. */
  penaltyScrub(secs = 3) {
    this.scrubT = Math.max(this.scrubT, secs);
  }

  /** Additive integration hook for weather, strategy, damage and race control. */
  setRaceContext(context = {}) {
    if (Number.isFinite(context.trackGrip)) this.trackGrip = Math.max(0.45, Math.min(1.1, context.trackGrip));
    if (Number.isFinite(context.wetness)) this.wetness = Math.max(0, Math.min(1, context.wetness));
    if (context.damage) this.damage = Object.assign({}, this.damage, context.damage);
    if (context.fuelMode === 'save' || context.fuelMode === 'balanced' || context.fuelMode === 'push') this.fuelMode = context.fuelMode;
    if (context.strategy) this.strategy = context.strategy;
    if (typeof context.raceControlState === 'string') this.raceControlState = context.raceControlState;
  }

  update(dt, others) {
    const c = this.circuit, car = this.car;
    if (car.disabled) return this.input;
    const N = c.N, ds = c.ds;
    const idx = car.sampleIdx;

    // ---- timers ----
    if (this.yieldT > 0) {
      this.yieldT -= dt;
      if (this.yieldT <= 0) { this.yieldT = 0; this.yieldOffset = 0; }
    }
    if (this.scrubT > 0) this.scrubT = Math.max(0, this.scrubT - dt);
    if (this.defendT > 0) this.defendT = Math.max(0, this.defendT - dt);

    // ---- mistakes ----
    this.mistakeCooldown -= dt;
    if (this.mistakeTimer > 0) this.mistakeTimer -= dt;
    else if (this.mistakeCooldown <= 0) {
      this.mistakeCooldown = 9 + this.random() * 14;
      const p = (1 - this.driver.consistency) * 0.55;
      if (this.random() < p && Math.abs(c.line[idx].curv) > 1 / 400) {
        this.mistakeTimer = 1.1; // brake late / run wide
      }
    }
    const mistake = this.mistakeTimer > 0;

    // ---- steering lookahead (needed by avoidance too) ----
    const lookM = Math.min(58, Math.max(9, car.v * 0.52));
    const li = (idx + Math.round(lookM / ds)) % N;
    const straight = Math.abs(c.line[idx].curv) < 1 / 650;

    // ---- avoidance / overtaking / defending / battle awareness ----
    let targetAvoid = 0, avoidDist = 1e9, chase = null, chaseDist = 1e9;
    let follow = null, followDist = 1e9;
    let brakeLead = null, brakeLeadDist = 1e9;
    let attacker = null, attackerDist = 1e9, nearestGapT = 1e9;
    const selfSample = c.samples[idx];
    const selfAlong = (car.pos.x - selfSample.p.x) * selfSample.t.x +
      (car.pos.z - selfSample.p.z) * selfSample.t.z;
    for (const o of others) {
      if (o === car || o.disabled) continue;
      let ahead = o.sampleIdx - idx;
      if (ahead > N / 2) ahead -= N;
      if (ahead < -N / 2) ahead += N;
      // sampleIdx is quantised to ds (normally 2.5 m), which is half a car
      // length. Add each car's along-track residual so following decisions do
      // not disappear for a frame just as two cars reach contact distance.
      const otherSample = c.samples[o.sampleIdx];
      const otherAlong = (o.pos.x - otherSample.p.x) * otherSample.t.x +
        (o.pos.z - otherSample.p.z) * otherSample.t.z;
      const dAhead = ahead * ds + otherAlong - selfAlong;
      // battle proximity — within a second of the car AHEAD, i.e. actually
      // chasing someone. Train leaders get no free pace from this.
      const absD = Math.abs(dAhead);
      if (dAhead > 0 && dAhead < 140) {
        const gapT = dAhead / Math.max(car.v, 28);
        if (gapT < nearestGapT) nearestGapT = gapT;
      }
      // a faster car close behind is an attacker worth covering off
      // Commit to a defensive line before the attacker reaches car-length
      // range. Starting a move inside that range turns a legal cover into a
      // side-swipe with the full-size contact boxes.
      if (dAhead < -5.8 && dAhead > -22 && o.v > car.v + 0.5 && Math.abs(o.lat - car.lat) < 4.5) {
        if (absD < attackerDist) { attackerDist = absD; attacker = o; }
      }
      if (dAhead < -4 || dAhead > 42) continue;
      const latDiff = o.lat - car.lat;
      if (dAhead < chaseDist && dAhead > 0.35) { chaseDist = dAhead; chase = o; }
      if (dAhead < followDist && dAhead > 0.35 && Math.abs(latDiff) < 2.55) {
        followDist = dAhead;
        follow = o;
      }
      if (dAhead < brakeLeadDist && dAhead > 0.35 && Math.abs(latDiff) < 2.8) {
        brakeLeadDist = dAhead;
        brakeLead = o;
      }
      // under the VSC nobody may improve position: no avoidance-based passes
      if (!this.noOvertake && Math.abs(latDiff) < 3.6 && dAhead > 0 && dAhead < 30 &&
          dAhead < avoidDist && o.v < car.v + 4) {
        const room = c.halfWidth - 1.8;
        const side = o.lat > 0 ? -1 : 1;
        targetAvoid = Math.max(-room, Math.min(room, o.lat + side * 3.7)) - lineLat(c, li);
        avoidDist = dAhead;
      }
    }
    // Turn into a pass promptly, then blend back more gently. The physical
    // lateral separation (not this target) controls headway release below.
    const avoidRate = targetAvoid !== 0 ? 3.4 : 2.6;
    this.avoidOffset += (targetAvoid - this.avoidOffset) * Math.min(1, dt * avoidRate);

    // ---- defending: one legal line change per straight ----
    // The re-arm interval matters: circuits like Monaco expose ~17 short
    // "straights" a lap, and covering off on every one of them would be both
    // unrealistic and a real lap-time cost.
    if (this._defendCool > 0) this._defendCool = Math.max(0, this._defendCool - dt);
    if (!straight) this._defendArmed = true;
    if (straight && attacker && this._defendArmed && this.defendT <= 0 &&
        this._defendCool <= 0 && !this.noOvertake && this.yieldT <= 0 && car.v > 40) {
      this._defendArmed = false;
      this.defendT = 2.4;
      this._defendCool = 7;
      this._defendSide = Math.sign(attacker.lat - car.lat) || (car.lat > 0 ? -1 : 1);
      // narrow circuits simply have less room to move over
      this._defendMag = Math.min(1.8, Math.max(0.9, (c.halfWidth - 1.9) * 0.5));
    }
    // Passing/avoidance has priority over defending, preventing two line-change
    // intents from combining while cars are already close together.
    const defendTarget = this.defendT > 0 && targetAvoid === 0
      ? this._defendSide * this._defendMag : 0;
    this.defendOffset += (defendTarget - this.defendOffset) * Math.min(1, dt * 2.2);

    // ---- battle variance: a sustained close fight raises commitment ----
    if (nearestGapT < 1) this.battleT = Math.min(12, this.battleT + dt);
    else this.battleT = Math.max(0, this.battleT - dt * 2);
    this.fighting = this.battleT > 5;
    const fightF = this.fighting ? 1 + (this.driver.racecraft ?? 0.9) * 0.01 : 1;

    // ---- steering: pure pursuit on racing line + lateral offsets ----
    // Only the new defend/yield offsets are width-limited: avoidance already
    // caps itself at halfWidth-1.8, so with no extra offset `off` reduces to
    // this.avoidOffset exactly and the original line is reproduced untouched.
    const baseLat = lineLat(c, li);
    let off = this.avoidOffset;
    const extra = this.defendOffset + this.yieldOffset;
    if (extra !== 0) {
      const room = c.halfWidth - 1.6;
      off = Math.max(-room, Math.min(room, baseLat + off + extra)) - baseLat;
    }
    // In the wet, leave the polished dry apex by a small, width-safe amount.
    // This is intentionally modest because circuits do not yet expose a
    // dedicated alternate-line spline.
    if (this.wetness > 0.18 && targetAvoid === 0 && this.yieldT <= 0) {
      const wetSide = -Math.sign(c.line[li].curv || 1);
      const wetOffset = wetSide * Math.min(1.1, this.wetness * 1.25);
      const room = c.halfWidth - 1.8;
      off = Math.max(-room, Math.min(room, baseLat + off + wetOffset)) - baseLat;
    }
    const lp = c.line[li].p, s = c.samples[li];
    const tx = lp.x + s.n.x * off - car.pos.x;
    const tz = lp.z + s.n.z * off - car.pos.z;
    const desired = Math.atan2(tx, tz);
    let dh = angleDiff(desired, car.heading);
    if (mistake) dh += 0.05;
    const steer = dh / Math.max(0.04, maxSteerAngle(car.v));
    this.input.steer = Math.max(-1, Math.min(1, steer * 1.15));

    // ---- speed target: min over braking horizon ----
    const brakeAbility = Math.max(0.38, this.damage.braking ?? 1) *
      Math.sqrt(Math.max(0.45, this.trackGrip));
    const planBrake = ABRAKE_PLAN * brakeAbility;
    const horizon = Math.max(20, (car.v * car.v) / (2 * planBrake) + 30);
    const hs = Math.round(horizon / ds);
    let vT = 1e9;
    for (let j = 0; j <= hs; j += 2) {
      const jj = (idx + j) % N;
      const allow = Math.sqrt(c.line[jj].spd * c.line[jj].spd + 2 * planBrake * j * ds);
      if (allow < vT) vT = allow;
    }
    const tyreF = 1 - 0.06 * car.wear;
    const dirt = 1 - 0.035 * car.dirtyAir;
    const wetGrip = Math.sqrt(Math.max(0.45, this.trackGrip)) * (1 - this.wetness * 0.08);
    const damageF = Math.max(0.48, Math.min(this.damage.grip ?? 1, this.damage.topSpeed ?? 1));
    vT *= this.skill * this.lapNoise * tyreF * dirt * fightF * wetGrip * damageF;
    if (mistake) vT *= 1.055;
    if (this.yieldT > 0) vT *= 0.97;              // blue flags: let them by
    if (this.scrubT > 0) vT *= 0.985;             // track-limits sanction
    if (this.vscFactor !== 1) vT *= this.vscFactor; // virtual safety car
    // Keep a real nose-to-tail buffer until the cars have PHYSICALLY separated
    // laterally. Releasing this from avoidOffset let the throttle come back as
    // soon as a pass was requested, several frames before the car moved over.
    let followBrake = 0;
    if (follow) {
      const closing = Math.max(0, car.v - follow.v);
      const speedBuffer = Math.min(3.2, car.v * 0.045);
      const safeGap = 6.35 + speedBuffer + Math.min(7, closing * 0.6);
      const gapError = safeGap - followDist;
      if (gapError > 0) {
        const backoff = Math.min(4, 0.85 + gapError * 0.35 + closing * 0.2);
        vT = Math.min(vT, Math.max(follow.v - backoff, 6));
        followBrake = Math.min(0.7, 0.04 + gapError * 0.12 + closing * 0.06);
      }
    }

    const err = vT - car.v;
    this.input.throttle = err > 0.4 ? Math.min(1, 0.45 + err * 0.28) : (err > -0.6 ? 0.28 : 0);
    const powerCap = Math.max(0.5, this.damage.power ?? 1) * (this.fuelMode === 'save' ? 0.86 : 1);
    this.input.throttle = Math.min(this.input.throttle, powerCap);
    this.input.brake = err < -0.8 ? Math.min(1, -err * 0.22) : 0;
    if (followBrake > 0) {
      this.input.throttle = 0;
      this.input.brake = Math.max(this.input.brake, followBrake);
    }
    // Propagate a braking wave before it becomes a contact wave. At racing
    // speed a car needs to react to the aligned car ahead before the static
    // body-clearance controller engages; the preview collapses at low speed.
    const brakePreview = 6.35 + Math.min(3.2, car.v * 0.045) +
      Math.max(4, Math.min(14, car.v * 0.18));
    if (brakeLead && brakeLeadDist < brakePreview && brakeLead.brake > 0.03) {
      this.input.throttle = 0;
      this.input.brake = Math.max(this.input.brake, Math.min(0.92, brakeLead.brake * 0.96));
    }

    // ---- Manual Override boost: chase within range on straights ----
    this.input.boost = this.vscFactor === 1 && this.fuelMode !== 'save' && straight && car.battery > 0.35 && car.v > 45 &&
      this.input.brake < 0.03 && ((chase && chaseDist < 26) || car.battery > 0.92);
    this.input.ersMode = this.strategy?.ersMode ?? (this.noOvertake ? 0
      : car.battery < 0.25 ? 0
      : ((chase && chaseDist < 30) || attacker || car.battery > 0.86) ? 2 : 1);

    const steerBias = this.damage.steeringBias ?? 0;
    if (steerBias) this.input.steer = Math.max(-1, Math.min(1, this.input.steer + steerBias));

    return this.input;
  }
}

function lineLat(c, i) {
  const s = c.samples[i], lp = c.line[i].p;
  return (lp.x - s.p.x) * s.n.x + (lp.z - s.p.z) * s.n.z;
}
