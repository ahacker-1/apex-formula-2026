// AI driver: pure-pursuit on the racing line, braking-horizon speed control,
// side-by-side avoidance & overtaking, defending, battle variance, consistency-
// based mistakes, boost tactics. Race-direction state (VSC, blue flags,
// track-limit scrubs) is pushed in by RaceSession through the fields below.
import { angleDiff, maxSteerAngle } from './physics.js';

const ABRAKE_PLAN = 38;

export class AIDriver {
  constructor(car, circuit, driver, difficulty) {
    this.car = car;
    this.circuit = circuit;
    this.driver = driver;
    // difficulty 0..2 (easy/med/hard); skill combines with driver pace
    const diffF = [0.925, 0.962, 1.0][difficulty] ?? 1.0;
    this.skill = diffF * (0.94 + 0.06 * driver.pace);
    this.avoidOffset = 0;
    this.mistakeTimer = 0;
    this.mistakeCooldown = 8 + Math.random() * 8;
    this.lapNoise = 1;

    // ---- race-direction state (written by RaceSession) ----
    this.vscFactor = 1;       // 1 = green flag, 0.6 while the VSC is deployed
    this.noOvertake = false;  // VSC: hold position (avoidance passes suppressed)
    this.yieldOffset = 0;     // blue flags: metres off the racing line
    this.yieldT = 0;          // seconds of blue-flag yielding remaining
    this.scrubT = 0;          // seconds of track-limits pace scrub remaining

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
    this.lapNoise = 1 + (Math.random() - 0.5) * 0.012 * (2 - this.driver.consistency);
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
      this.mistakeCooldown = 9 + Math.random() * 14;
      const p = (1 - this.driver.consistency) * 0.55;
      if (Math.random() < p && Math.abs(c.line[idx].curv) > 1 / 400) {
        this.mistakeTimer = 1.1; // brake late / run wide
      }
    }
    const mistake = this.mistakeTimer > 0;

    // ---- steering lookahead (needed by avoidance too) ----
    const lookM = Math.min(58, Math.max(9, car.v * 0.52));
    const li = (idx + Math.round(lookM / ds)) % N;
    const straight = Math.abs(c.line[idx].curv) < 1 / 650;

    // ---- avoidance / overtaking / defending / battle awareness ----
    let targetAvoid = 0, chase = null, chaseDist = 1e9, blocking = false;
    let attacker = null, attackerDist = 1e9, nearestGapT = 1e9;
    for (const o of others) {
      if (o === car || o.disabled) continue;
      let ahead = o.sampleIdx - idx;
      if (ahead > N / 2) ahead -= N;
      if (ahead < -N / 2) ahead += N;
      const dAhead = ahead * ds;
      // battle proximity — within a second of the car AHEAD, i.e. actually
      // chasing someone. Train leaders get no free pace from this.
      const absD = Math.abs(dAhead);
      if (dAhead > 0 && dAhead < 140) {
        const gapT = dAhead / Math.max(car.v, 28);
        if (gapT < nearestGapT) nearestGapT = gapT;
      }
      // a faster car close behind is an attacker worth covering off
      if (dAhead < 0 && dAhead > -8 && o.v > car.v + 0.5 && Math.abs(o.lat - car.lat) < 4.5) {
        if (absD < attackerDist) { attackerDist = absD; attacker = o; }
      }
      if (dAhead < -4 || dAhead > 42) continue;
      const latDiff = o.lat - car.lat;
      if (dAhead < chaseDist && dAhead > 2) { chaseDist = dAhead; chase = o; }
      // under the VSC nobody may improve position: no avoidance-based passes
      if (!this.noOvertake && Math.abs(latDiff) < 3.6 && dAhead > 0 && dAhead < 30 && o.v < car.v + 4) {
        // pick the side with room; offset is relative to the line AT the lookahead point
        const room = c.halfWidth - 1.8;
        const side = o.lat > 0 ? -1 : 1;
        targetAvoid = Math.max(-room, Math.min(room, o.lat + side * 3.5)) - lineLat(c, li);
        blocking = dAhead < 10 && Math.abs(latDiff) < 2.2;
      }
    }
    this.avoidOffset += (targetAvoid - this.avoidOffset) * Math.min(1, dt * 2.6);

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
    const defendTarget = this.defendT > 0 ? this._defendSide * this._defendMag : 0;
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
    const lp = c.line[li].p, s = c.samples[li];
    const tx = lp.x + s.n.x * off - car.pos.x;
    const tz = lp.z + s.n.z * off - car.pos.z;
    const desired = Math.atan2(tx, tz);
    let dh = angleDiff(desired, car.heading);
    if (mistake) dh += 0.05;
    const steer = dh / Math.max(0.04, maxSteerAngle(car.v));
    this.input.steer = Math.max(-1, Math.min(1, steer * 1.15));

    // ---- speed target: min over braking horizon ----
    const horizon = Math.max(20, (car.v * car.v) / (2 * ABRAKE_PLAN) + 30);
    const hs = Math.round(horizon / ds);
    let vT = 1e9;
    for (let j = 0; j <= hs; j += 2) {
      const jj = (idx + j) % N;
      const allow = Math.sqrt(c.line[jj].spd * c.line[jj].spd + 2 * ABRAKE_PLAN * j * ds);
      if (allow < vT) vT = allow;
    }
    const tyreF = 1 - 0.06 * car.wear;
    const dirt = 1 - 0.035 * car.dirtyAir;
    vT *= this.skill * this.lapNoise * tyreF * dirt * fightF;
    if (mistake) vT *= 1.055;
    if (this.yieldT > 0) vT *= 0.97;              // blue flags: let them by
    if (this.scrubT > 0) vT *= 0.985;             // track-limits sanction
    if (this.vscFactor !== 1) vT *= this.vscFactor; // virtual safety car
    // don't ram the car directly ahead (kept under the VSC too)
    if (chase && chaseDist < 9 && Math.abs(chase.lat - car.lat) < 2.4 && !blockingFree(this.avoidOffset)) {
      vT = Math.min(vT, Math.max(chase.v * 0.985, 8));
    }

    const err = vT - car.v;
    this.input.throttle = err > 0.4 ? Math.min(1, 0.45 + err * 0.28) : (err > -0.6 ? 0.28 : 0);
    this.input.brake = err < -0.8 ? Math.min(1, -err * 0.22) : 0;

    // ---- Manual Override boost: chase within range on straights ----
    this.input.boost = this.vscFactor === 1 && straight && car.battery > 0.35 && car.v > 45 &&
      ((chase && chaseDist < 26) || car.battery > 0.92);

    return this.input;

    function blockingFree(off) { return Math.abs(off - 0) > 2.8; }
  }
}

function lineLat(c, i) {
  const s = c.samples[i], lp = c.line[i].p;
  return (lp.x - s.p.x) * s.n.x + (lp.z - s.p.z) * s.n.z;
}
