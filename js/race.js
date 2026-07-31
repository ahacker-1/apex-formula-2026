// Race session: grid → lights → racing → chequered flag. Owns all 22 cars,
// timing, positions, pit stops, collisions, slipstream/dirty air, results.
import { BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, MeshBasicMaterial, Mesh, PlaneGeometry } from 'three';
import { CarPhysics, COMPOUNDS } from './physics.js';
import { AIDriver } from './ai.js';
import * as CAR from './car.js';
import { layoutNametags } from './nametags.js';
import { DRIVERS, TEAMS, POINTS } from './data.js';
import { fmtTime } from './format.js';
import {
  applyContactVelocity,
  contactLongitudinalFor,
  contactSideFor,
  orientedCarContact,
  syncContactBody,
} from './contact.js';

// Preserve the established public race-module API for headless tooling while
// allowing menu code to import the tiny formatter without loading this module.
export { fmtTime } from './format.js';

const { buildCarMesh, buildNameTag } = CAR;

const teamById = Object.fromEntries(TEAMS.map(t => [t.id, t]));
const CONTACT_SLOP = 0.002;

function solveContactPositions(session, entries, bodies, corrX, corrZ, passes = 8) {
  for (let iteration = 0; iteration < passes; iteration++) {
    corrX.fill(0);
    corrZ.fill(0);
    for (let i = 0; i < entries.length; i++) syncContactBody(bodies[i], entries[i].phys);
    let any = false;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].phys.disabled || entries[i].dnf) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].phys.disabled || entries[j].dnf) continue;
        const contact = orientedCarContact(bodies[i], bodies[j]);
        if (!contact || contact.penetration <= CONTACT_SLOP) continue;
        any = true;
        const invA = bodies[i].invMass;
        const invB = bodies[j].invMass;
        const invSum = invA + invB;
        const correction = Math.min(0.7, contact.penetration - CONTACT_SLOP);
        const moveA = Math.min(0.35, correction * invA / invSum);
        const moveB = Math.min(0.35, correction * invB / invSum);
        corrX[i] += contact.nx * moveA;
        corrZ[i] += contact.nz * moveA;
        corrX[j] -= contact.nx * moveB;
        corrZ[j] -= contact.nz * moveB;
      }
    }
    if (!any) break;
    for (let i = 0; i < entries.length; i++) {
      entries[i].phys.pos.x += corrX[i];
      entries[i].phys.pos.z += corrZ[i];
      entries[i].phys.projectWallConstraint?.();
    }
  }
}

// Square canvas + fully-contained radius: the plane's own scale turns this into
// the ellipse, and alpha genuinely reaches 0 before the quad edge (the old
// 128x64 canvas clipped the gradient at ~0.3 alpha on its top/bottom edges,
// which drew a visible rectangle seam on the road).
// main.js parks the sun at (260,380,160) on every theme, so a cast shadow's
// ground direction is a world constant: away from the sun in plan view. The
// offset is height/tan(elevation) with elevation = atan(380/|(260,160)|) ~51deg,
// i.e. ~0.8x the car's ~1.1m body height, nudged up so the lobe reads.
const SUN_GROUND_AZI = Math.atan2(-260, -160);
const SUN_SHADOW_OFF = 1.15;
export const CAR_LOD_SPEC = Object.freeze({
  enterFarM: 55,
  returnFullM: 45,
  cadenceMs: 100,
  cadenceHz: 10,
  // (55 - 45) / 55 = 18.18%; reported explicitly for telemetry/validators.
  hysteresis: (55 - 45) / 55,
});
const RENDER_LINEAR_FIELDS = [
  'x', 'y', 'z', 'v', 'wheelSpin', 'steer', 'pitch', 'roll', 'rideBump',
];

export function clampRenderAlpha(alpha) {
  if (typeof alpha !== 'number' || Number.isNaN(alpha)) return 0;
  return Math.max(0, Math.min(1, alpha));
}

export function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Presentation-only brake-disc response. Actual thermal state remains owned by
// CarPhysics; keeping this pure also makes the visual curve deterministic and
// independently testable. A faint heat-soak afterglow remains when the driver
// releases the pedal instead of popping off on the next frame.
export function brakeGlowIntensity(brakeTemp, brake, speed) {
  const temp = Math.max(0, Math.min(1, (finiteOrZero(brakeTemp) - 300) / 700));
  const load = Math.max(0, Math.min(1, (finiteOrZero(brake) - 0.08) / 0.82));
  const airflow = Math.max(0, Math.min(1, (Math.abs(finiteOrZero(speed)) - 8) / 42));
  return temp * (0.26 + load * 0.74) * (0.68 + airflow * 0.32);
}

export function resolveCarLod(previous, distanceM, isPlayer = false, mode = 'automatic') {
  if (isPlayer || mode === 'forced-full') return 'full';
  const distance = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  if (previous === 'far') return distance <= CAR_LOD_SPEC.returnFullM ? 'full' : 'far';
  return distance >= CAR_LOD_SPEC.enterFarM ? 'far' : 'full';
}

function applyBrakeGlowState(glows, glow) {
  if (!glows?.length) return;
  const visible = glow > 0.025;
  for (const brakeGlow of glows) brakeGlow.visible = visible;
  const mat = glows[0]?.material;
  if (!mat) return;
  mat.opacity = 0.16 + glow * 0.84;
  // Discs transition from a deep ember to a restrained orange-yellow at peak
  // load; bloom can enhance it on higher tiers, but is not required.
  if (mat.color?.setRGB) mat.color.setRGB(1, 0.12 + glow * 0.42, 0.015);
}

export function interpolateRenderSnapshot(previous, current, alpha, out = {}) {
  const t = clampRenderAlpha(alpha);
  for (const field of RENDER_LINEAR_FIELDS) {
    out[field] = previous[field] + (current[field] - previous[field]) * t;
  }
  out.heading = previous.heading + shortestAngleDelta(previous.heading, current.heading) * t;
  return out;
}

function copyRenderSnapshot(source, target) {
  for (const field of RENDER_LINEAR_FIELDS) target[field] = source[field];
  target.heading = source.heading;
  return target;
}

function makeRenderSnapshot() {
  return {
    x: 0, y: 0, z: 0, heading: 0, v: 0,
    wheelSpin: 0, steer: 0, pitch: 0, roll: 0, rideBump: 0,
  };
}

function radialShadowTex(stops) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  for (const [t, a] of stops) grad.addColorStop(t, `rgba(0,0,0,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.userData.shared = true;
  return tex;
}

// Shared soft contact shadow: one wide blob under the floor plus a STRONGER,
// tighter darkening patch directly beneath each tyre. Unconditional on every
// car (both car-mesh generations, race and quali, near or far) and independent
// of the directional shadow map — the certified grid hero shot showed cars with
// zero contact darkening because the shadow map did not span the grid. The
// per-wheel patches sit a hair above the body blob and draw after it, so the
// two multiply into >=20% darkening at each contact patch even where the blob
// alone has faded out. Exported for the car render harness.
let _shadowTex = null, _wheelShadowTex = null;
function fannedShadowGeometry(fans) {
  if (fans <= 1) return new PlaneGeometry(3.6, 7.0);
  const positions = [], normals = [], uvs = [];
  for (let fan = 0; fan < fans; fan++) {
    const offset = (fan - (fans - 1) / 2) * 0.14;
    const g = new PlaneGeometry(3.25, 6.5).toNonIndexed();
    g.rotateZ(offset);
    g.translate(Math.sin(offset) * 0.52, Math.cos(offset) * 0.22, 0);
    positions.push(...g.attributes.position.array);
    normals.push(...g.attributes.normal.array);
    uvs.push(...g.attributes.uv.array);
    g.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return merged;
}

export function makeContactShadow(shadowFans = 1) {
  const fans = Math.max(1, Math.min(6, Math.round(shadowFans) || 1));
  if (!_shadowTex) {
    _shadowTex = radialShadowTex([[0, 0.5], [0.55, 0.3], [1, 0]]);
    _wheelShadowTex = radialShadowTex([[0, 0.68], [0.4, 0.58], [0.75, 0.34], [1, 0]]);
  }
  const grp = new Group();
  grp.name = 'contactShadow';
  // long axis along the CAR's long axis (+z): the old 6.2 x 3.1 plane was
  // transposed, so it faded to nothing exactly at the axles (z = +-1.6) while
  // spilling 3m sideways — it read as a dark quad on the grass when riding a
  // kerb, and left no darkening under any tyre in the certified grid shot.
  // 2.5 x 5.9 keeps a ~0.3m soft fade past the real ~1.91m-wide footprint
  // (the width the env harness measured as zero detached-on-grass pixels).
  const blob = new Mesh(
    new PlaneGeometry(2.5, 5.9),
    new MeshBasicMaterial({ map: _shadowTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 0;
  // Sun-cast lobe. Round-4 cars major: "no directional cast shadow from any of
  // the 22 cars — the cars read as decals pasted onto the asphalt." The sun is
  // parked at (260,380,160) on every theme, so the ground direction of a cast
  // shadow is a world constant; this lobe is that shadow, kept in the group's
  // LOCAL space by counter-rotating with the car's heading each frame (see
  // updateShadowLobe). Wider and softer than the body blob so it reads as a
  // cast shadow rather than a second contact patch.
  const lobe = new Mesh(
    fannedShadowGeometry(fans),
    new MeshBasicMaterial({
      map: _shadowTex, transparent: true,
      opacity: fans > 1 ? Math.max(0.14, 0.58 / fans) : 0.55,
      depthWrite: false,
    }));
  lobe.rotation.x = -Math.PI / 2;
  lobe.renderOrder = -1;        // under the contact patches
  lobe.name = 'sunShadowLobe';
  lobe.userData.shadowFans = fans;
  grp.add(lobe);
  grp.add(blob);
  // wheel centres in car space are (±0.82, 1.55) front / (±0.85, -1.60) rear on
  // BOTH car generations; the group itself is parked at (0, 0.028, -0.05), so
  // local z compensates that -0.05.
  for (const [wx, wz] of [[-0.82, 1.60], [0.82, 1.60], [-0.85, -1.55], [0.85, -1.55]]) {
    const patch = new Mesh(
      new PlaneGeometry(1.25, 1.0),
      new MeshBasicMaterial({ map: _wheelShadowTex, transparent: true, depthWrite: false }));
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(wx, 0.004, wz);
    patch.renderOrder = 1;
    patch.name = 'wheelContactShadow';
    grp.add(patch);
  }
  return grp;
}

export class RaceSession {
  /**
   * opts: { scene, circuit, playerDriverId, laps, difficulty(0..2), assists,
   *         mode: 'race'|'quali', gridOrder: [driverId]|null, onMessage(text,color,meta),
   *         random: function|null, seed: any }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.circuit = opts.circuit;
    this.mode = opts.mode || 'race';
    this.laps = Math.max(1, opts.laps || 5);
    this.difficulty = opts.difficulty ?? 1;
    this.onMessage = opts.onMessage || (() => {});
    this.playerDriverId = opts.playerDriverId;
    this.trial = !!opts.trial;
    this.random = opts.random || (() => Math.random());
    this.seed = opts.seed;

    this.phase = 'grid';       // grid | lights | racing | finished
    this.phaseT = 0;
    // constant hazard ≈ 2 mechanical DNFs across the field over a full 90-min GP,
    // proportionally fewer in short races (mechanical stress scales with distance)
    this._dnfRate = 0.000017;
    this.lightsOn = 0;
    this.lightsHold = 0;
    this.raceTime = 0;
    this.fastestLap = null;    // {driverId, time}
    this.results = null;
    this.jumpStart = false;
    this._posTimer = 0;
    this._activeContacts = new Set();
    this._impactingContacts = new Set();
    this._wallEvent = 0;
    this._touchEvent = 0;

    // ---- race direction ----
    this.vsc = {
      active: false,
      timeLeft: 0,
      cycle: 0,
      deployEventKey: '',
      greenEventKey: '',
    };                                          // virtual safety car
    this.blueFlagFor = null;    // driverId being shown blue flags (player only)
    this.radioQueue = [];       // {text, tone, eventKey?} — HUD consumes by shifting
    this._radioCool = 0;        // contextual engineer radio: max 1 per 12s
    this._vscEnding = false;
    this._vscViol = 0;          // player VSC over-speed time accumulator
    this._vscPenalised = false;
    this._vscWarned = false;

    const c = this.circuit;
    this.entries = [];
    this._renderDisposed = false;
    this._carLodMode = 'automatic';
    this._carLodNextAt = -Infinity;
    this._carLodLastAt = -Infinity;
    this._carLodUpdates = 0;
    this._carLodSwitches = 0;
    this._carLodInitialized = false;

    if (this.mode === 'quali') {
      this._buildQuali(opts);
      this.resetRenderState();
      return;
    }

    // ---- grid order ----
    let order = opts.gridOrder;
    if (!order) {
      const scored = DRIVERS.map((driver) => ({
        driver,
        score: teamById[driver.team].perf * (0.7 + 0.3 * driver.pace) +
          (this.random() - 0.5) * 0.012,
      }));
      order = scored.sort((a, b) => b.score - a.score).map(({ driver }) => driver.id);
    }

    // ---- build cars ----
    order.forEach((driverId, gi) => {
      const driver = DRIVERS.find(d => d.id === driverId);
      const team = teamById[driver.team];
      const isPlayer = driverId === this.playerDriverId;
      // AI always run full assists (their controller expects auto shifting)
      const phys = new CarPhysics(c, {
        perf: team.perf, isPlayer,
        assists: isPlayer ? opts.assists : { tc: true, abs: true, autoGear: true },
        random: this.random,
      });
      phys.fuelBurnPerMeter = 1 / (this.laps * c.length * 1.06);
      const slot = c.gridSlots[gi];
      phys.placeAt(slot.pos, slot.heading, slot.idx);
      const carHandle = buildCarMesh(team, driver);
      // Standalone/hero cars retain the established body+wheel hierarchy and no
      // proxy allocation. Only non-player race entries opt into distant detail.
      if (!isPlayer) CAR.attachDistantCarProxy?.(carHandle);
      const { group, wheels, wheelRadius } = carHandle;
      group.position.copy(slot.pos);
      group.rotation.y = slot.heading;
      this.scene.add(group);
      const blob = makeContactShadow(c.group.userData.lightingRig?.shadowFans || 1);
      blob.position.set(0, 0.028, -0.05);
      group.add(blob);
      const tag = buildNameTag(driver, team);
      tag.position.y = 1.6;
      tag.visible = false;
      group.add(tag);

      // start compound + one-stop strategy
      const startC = gi < 8 ? (this.random() < 0.7 ? 'S' : 'M') : (this.random() < 0.55 ? 'M' : this.random() < 0.5 ? 'S' : 'H');
      phys.setTyre(startC);
      if (CAR.setTyreCompound) CAR.setTyreCompound(carHandle, startC);
      let plannedPitLap = -1, plannedNext = null;
      if (this.laps >= 12) {
        plannedPitLap = Math.max(3, Math.round(this.laps * (0.42 + this.random() * 0.2)));
        plannedNext = startC === 'S' ? (this.random() < 0.6 ? 'M' : 'H') : startC === 'M' ? 'H' : 'M';
      }

      this.entries.push({
        driver, team, phys, isPlayer, carHandle,
        ai: isPlayer ? null : new AIDriver(phys, c, driver, this.difficulty, this.random),
        mesh: group, wheels, wheelRadius, tag, contactShadow: blob, lodLevel: 'full',
        shadowLobe: blob.getObjectByName('sunShadowLobe'),
        lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, lapTimes: [],
        position: gi + 1, gridPos: gi + 1, gapText: '', intervalText: '',
        pitStops: 0, pitState: null, plannedPitLap, plannedNext, boxThisLap: false,
        finished: false, finishTime: 0, dnf: false, wheelSpin: 0,
        // ---- race-direction / timing detail (read by the HUD) ----
        sectors: [null, null, null],      // live current-lap sector times
        lastSectors: [null, null, null],  // previous completed lap
        bestSectors: [null, null, null],  // session minima
        tyreAgeLaps: 0,
        penaltySeconds: 0,
        positionsGained: 0,
        wingDamage: 0,
        trackLimits: 0,
        _secStage: 0, _secSplit: [null, null], _offAcc: 0, _offLatched: false,
        _blueFrom: null, _blueT: 0, _contactCool: 0,
        _wallDamageCool: 0, _carDamageCool: 0,
      });
    });
    this.player = this.entries.find(e => e.isPlayer) || null;
    this.resetRenderState();
  }

  _buildQuali(opts) {
    const c = this.circuit;
    const driver = DRIVERS.find(d => d.id === this.playerDriverId);
    const team = teamById[driver.team];
    const phys = new CarPhysics(c, {
      perf: team.perf, isPlayer: true, assists: opts.assists, random: this.random,
    });
    phys.fuelBurnPerMeter = 0; phys.fuel = 0.12;
    phys.setTyre('S');
    const startIdx = (c.N - Math.round(140 / c.ds)) % c.N;
    const s = c.samples[startIdx];
    phys.placeAt(s.p.clone(), Math.atan2(s.t.x, s.t.z), startIdx);
    phys.v = 46;
    phys.gear = 5;
    const carHandle = buildCarMesh(team, driver);
    const { group, wheels, wheelRadius } = carHandle;
    if (CAR.setTyreCompound) CAR.setTyreCompound(carHandle, 'S');
    this.scene.add(group);
    const blob = makeContactShadow(c.group.userData.lightingRig?.shadowFans || 1);
    blob.position.set(0, 0.028, -0.05);
    group.add(blob);
    this.entries = [{
      driver, team, phys, isPlayer: true, ai: null, carHandle,
      mesh: group, wheels, wheelRadius, tag: null, contactShadow: blob, lodLevel: 'full',
      shadowLobe: blob.getObjectByName('sunShadowLobe'),
      lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, lapTimes: [],
      position: 1, gridPos: 1, gapText: '', intervalText: '',
      pitStops: 0, pitState: null, boxThisLap: false,
      finished: false, finishTime: 0, dnf: false, wheelSpin: 0,
      sectors: [null, null, null],
      lastSectors: [null, null, null],
      bestSectors: [null, null, null],
      tyreAgeLaps: 0,
      penaltySeconds: 0,
      positionsGained: 0,
      wingDamage: 0,
      trackLimits: 0,
      _secStage: 0, _secSplit: [null, null], _offAcc: 0, _offLatched: false,
      _blueFrom: null, _blueT: 0, _contactCool: 0,
      _wallDamageCool: 0, _carDamageCool: 0,
    }];
    this.player = this.entries[0];
    this.phase = 'racing';
    this.qualiState = 'outlap';   // outlap | flying | done
    this.qualiTime = null;
    // simulated AI quali times
    this.aiQualiTimes = DRIVERS.filter(d => d.id !== this.playerDriverId).map(d => {
      const t = teamById[d.team];
      const diffF = [0.925, 0.962, 1.0][this.difficulty] ?? 1;
      const skill = diffF * (0.94 + 0.06 * d.pace) * (0.955 + 0.05 * (t.perf - 0.9) / 0.1 * 0.9);
      const base = c.idealLap / (skill * 0.965);
      return { driverId: d.id, time: base * (1 + this.random() * 0.008) };
    });
  }

  // Legacy alias: penalties are now per-entry, but callers still read/write the
  // player's total through this property.
  get playerPenalty() { return this.player ? this.player.penaltySeconds : 0; }
  set playerPenalty(v) { if (this.player) this.player.penaltySeconds = v; }

  /** Queue an engineer radio line. Contextual chatter is gated to 1 per 12s;
   *  mandated race-control calls pass force=true. */
  _radio(text, tone = 'info', force = false, meta = null) {
    if (!force && this._radioCool > 0) return false;
    this._radioCool = 12;
    const item = { text, tone };
    if (meta && typeof meta.eventKey === 'string' && meta.eventKey) item.eventKey = meta.eventKey;
    this.radioQueue.push(item);
    // the HUD drains this by shifting; cap it so a headless session can't grow
    while (this.radioQueue.length > 16) this.radioQueue.shift();
    return true;
  }

  // ======== update ========
  update(dt, playerInput) {
    if (this._renderDisposed) return;
    this._beginRenderTick();
    dt = Math.min(dt, 1 / 25);
    const c = this.circuit;
    this.phaseT += dt;

    if (this.phase === 'grid') {
      if (this.phaseT > 2.6) { this.phase = 'lights'; this.phaseT = 0; this.lightsOn = 0; this.lightsHold = 0.5 + this.random(); }
    } else if (this.phase === 'lights') {
      const want = Math.min(5, Math.floor(this.phaseT / 0.9) + 1);
      if (want > this.lightsOn) { this.lightsOn = want; this._lightEvent = true; }
      // jump start check
      if (this.player && this.player.phys.v > 0.6) this.jumpStart = true;
      if (this.lightsOn >= 5 && this.phaseT > 5 * 0.9 + this.lightsHold) {
        this.phase = 'racing'; this.phaseT = 0; this.lightsOut = true;
        this.raceTime = 0;
        for (const e of this.entries) e.lapStart = 0;
        if (this.jumpStart) {
          if (this.player) this.player.penaltySeconds += 5;
          this.onMessage('JUMP START — +5s PENALTY', 'red');
          this._radio('Jump start — that is a five second penalty.', 'warning', true);
        }
      }
    }

    const racing = this.phase === 'racing' || this.phase === 'finished';
    if (racing) this.raceTime += dt;
    if (this._radioCool > 0) this._radioCool = Math.max(0, this._radioCool - dt);

    // ---- race direction: virtual safety car ----
    if (this.mode === 'race') this._updateVSC(dt);

    // ---- aero interactions (slipstream / dirty air) ----
    if (this.mode === 'race') this._aeroInteractions();
    // a damaged front wing costs downforce for the rest of the lap; the existing
    // physics turns a dirtyAir floor into exactly that grip loss
    for (const e of this.entries) {
      if (e.wingDamage > 0) e.phys.dirtyAir = Math.max(e.phys.dirtyAir, 0.6);
    }

    // ---- step cars ----
    const liveDrive = this.phase === 'racing' || this.phase === 'finished';
    const allPhys = this.entries.map(x => x.phys);
    for (const e of this.entries) {
      if (e.dnf) continue;
      if (e.pitState) { this._updatePit(e, dt); continue; }
      // finished cars cool down, then AI cars leave the track (parc fermé)
      if (e.finished && e.coolDown != null) {
        e.coolDown -= dt;
        if (e.coolDown <= 0) {
          e.coolDown = null;
          if (!e.isPlayer) { e.phys.disabled = true; e.mesh.visible = false; }
        }
      }
      let input;
      if (e.isPlayer) {
        input = ((liveDrive && !e.finished) || this.phase === 'lights') ? playerInput : ZERO_INPUT;
      } else {
        input = (liveDrive && !e.finished) ? e.ai.update(dt, allPhys) : ZERO_INPUT;
      }
      if (e._wallDamageCool > 0) e._wallDamageCool -= dt;
      if (e._carDamageCool > 0) e._carDamageCool -= dt;
      const ev = e.phys.step(dt, input);
      if (ev.crossedSF && (racing || this.phase === 'lights')) this._onCross(e, ev.crossedSF);
      if (ev.wrongWay && e.isPlayer) this._msgOnce('wrongway', 'WRONG WAY', 'red');
      if (ev.wallHit) this._handleWallImpact(e, ev.wallHit);
      if (ev.shifted && e.isPlayer) this._shiftEvent = ev.shifted; // ±1: up/down for audio character
      if (racing) {
        this._sectorTiming(e);
        if (this.mode === 'race') this._trackLimits(e, dt);
      }
      // mechanical retirement (AI only, race only)
      if (!e.isPlayer && this.mode === 'race' && this.phase === 'racing' && !e.finished) {
        // ~9% chance per car over the chosen race distance, frame-rate independent
        if (this.random() < this._dnfRate * dt) this._retire(e);
      }
      // stranded watchdog: a car off the racing surface and making no real
      // track progress must never hang the session — AI get recovered by the
      // marshals (retired), the player is lifted back onto the track.
      // "No progress" covers both a parked car (v≈0) and a wall-pinned car
      // grinding nose-in against a street-circuit barrier at walking pace
      // (v≈2-4 with zero sample progress — on singapore that state used to
      // persist for the rest of the race, so the player never reached the
      // lap where their armed pit stop would trigger).
      if (!e.finished && !e.dnf && !e.pitState &&
          (this.phase === 'racing' || this.phase === 'finished') && e.phys.offTrack) {
        // >4m of forward progress since the reference means the car is actually
        // moving through the runoff, not stuck — rebaseline and clear the timer
        if (e._stuckRef == null) e._stuckRef = e.phys.totalDist;
        if (e.phys.totalDist - e._stuckRef > 4) {
          e._stuckT = 0;
          e._stuckRef = e.phys.totalDist;
        }
        e._stuckT = (e._stuckT || 0) + dt;
        if (!e.isPlayer && e._stuckT > 6) {
          this._retire(e);
          this.onMessage(`${e.driver.code} BEACHED — RECOVERED BY MARSHALS`, 'yellow');
        } else if (e.isPlayer && e._stuckT > 10) {
          e._stuckT = 0;
          e._stuckRef = null;
          // placeAt at the car's own nearest sample: no progress gained or lost,
          // and the progress-floor lap tracker re-baselines cleanly
          const i = e.phys.sampleIdx;
          const sm = this.circuit.samples[i];
          e.phys.placeAt(sm.p.clone(), Math.atan2(sm.t.x, sm.t.z), i);
          this.resetRenderState(e);
          this.onMessage('RECOVERED TO THE TRACK', 'yellow');
        }
      } else { e._stuckT = 0; e._stuckRef = null; }
      this._advanceWheelSpin(e, dt);
    }

    if (this.mode === 'race') {
      this._collisions();
      this._posTimer -= dt;
      if (this._posTimer <= 0) { this._posTimer = 0.4; this._updatePositions(); }
      this._blueFlags(dt);
      this._engineerRadio(dt);
    } else this._updateQuali();

    // Capture after collision separation and every teleport-capable subsystem.
    // Applying the current endpoint preserves the legacy update()-drives-mesh
    // contract until the outer render loop calls render(alpha) explicitly.
    this._finishRenderTick();
    this.render(1);

    // finish condition — hard cutoff guarantees the race always classifies
    if (this.mode === 'race' && this.phase === 'finished' && !this.results) {
      const allDone = this.entries.every(e => e.finished || e.dnf);
      const playerDone = !this.player || this.player.finished || this.player.dnf;
      const hardCut = this.phaseT > 90;
      if (allDone || (playerDone && this.phaseT > this._finishGrace) || hardCut) this._classify();
    }
  }

  _aeroInteractions() {
    const c = this.circuit, N = c.N, ds = c.ds;
    for (const e of this.entries) { e.phys.slipstream = 0; e.phys.dirtyAir = 0; }
    for (const a of this.entries) {
      if (a.phys.disabled || a.dnf) continue;
      for (const b of this.entries) {
        if (a === b || b.phys.disabled || b.dnf) continue;
        let ahead = b.phys.sampleIdx - a.phys.sampleIdx;
        if (ahead > N / 2) ahead -= N;
        if (ahead < -N / 2) ahead += N;
        const d = ahead * ds;
        if (d < 2 || d > 42) continue;
        if (Math.abs(b.phys.lat - a.phys.lat) > 3) continue;
        const str = 1 - d / 42;
        const curv = Math.abs(c.line[a.phys.sampleIdx].curv);
        if (curv > 1 / 420) a.phys.dirtyAir = Math.max(a.phys.dirtyAir, str);
        else a.phys.slipstream = Math.max(a.phys.slipstream, str);
      }
    }
  }

  // ======== race direction ========

  /** Deploy the VSC for `secs`: the whole field is neutralised, no overtaking. */
  _startVSC(secs) {
    if (!this.vsc.active) {
      this.vsc.cycle++;
      this.vsc.deployEventKey = `vsc:${this.vsc.cycle}:deploy`;
      this.vsc.greenEventKey = `vsc:${this.vsc.cycle}:green`;
    }
    this.vsc.active = true;
    this.vsc.timeLeft = Math.max(this.vsc.timeLeft, secs);
    this._vscEnding = false;
    // per-deployment sanction state: one warning + one penalty per VSC period
    this._vscViol = 0;
    this._vscWarned = false;
    this._vscPenalised = false;
    for (const e of this.entries) if (e.ai) { e.ai.vscFactor = 0.6; e.ai.noOvertake = true; }
    const meta = { eventKey: this.vsc.deployEventKey };
    this.onMessage('VIRTUAL SAFETY CAR', 'yellow', meta);
    this._radio('Virtual safety car deployed — hold the delta.', 'warning', true, meta);
  }

  _updateVSC(dt) {
    const v = this.vsc;
    if (!v.active) return;
    v.timeLeft -= dt;
    if (v.timeLeft <= 3 && !this._vscEnding) {
      this._vscEnding = true;
      this.onMessage('VSC ENDING', 'yellow');
      this._radio('VSC ending — get ready.', 'info', true);
    }
    if (v.timeLeft <= 0) {
      v.active = false;
      v.timeLeft = 0;
      this._vscEnding = false;
      for (const e of this.entries) if (e.ai) { e.ai.vscFactor = 1; e.ai.noOvertake = false; }
      const meta = { eventKey: v.greenEventKey };
      this.onMessage('GREEN FLAG — RACE RESUMES', 'green', meta);
      this._radio('Green flag — go, go, go.', 'info', true, meta);
      return;
    }
    // the player is expected to slow to the delta; sustained over-speed is a penalty
    const p = this.player;
    if (p && !p.finished && !p.dnf && !p.pitState && p.phys.v > 62) {
      this._vscViol += dt;
      if (this._vscViol > 1 && !this._vscWarned) {
        this._vscWarned = true;
        this.onMessage('VSC — SLOW DOWN', 'yellow');
        this._radio('VSC — slow down, you are over the delta.', 'warning', true);
      } else if (this._vscViol > 3 && !this._vscPenalised) {
        this._vscPenalised = true;
        p.penaltySeconds += 5;
        this.onMessage('VSC INFRINGEMENT — +5s PENALTY', 'red');
        this._radio('VSC infringement — five second penalty.', 'warning', true);
      }
    }
  }

  // ---- sector timing: boundaries at 1/3 and 2/3 of the sample ring ----
  _sectorTiming(e) {
    if (e.lap < 0 || e.pitState || e.finished || e.dnf) return;
    const N = this.circuit.N;
    const idx = e.phys.sampleIdx;
    const t = this.raceTime - e.lapStart;
    if (e._secStage === 0) {
      if (idx >= N / 3 && idx < 2 * N / 3) {
        e._secSplit[0] = t;
        e.sectors[0] = t;
        e._secStage = 1;
      }
    } else if (e._secStage === 1 && idx >= 2 * N / 3) {
      e._secSplit[1] = t;
      e.sectors[1] = e._secSplit[0] != null ? t - e._secSplit[0] : null;
      e._secStage = 2;
    }
  }

  /** Close out the lap's third sector and roll live → last → best. */
  _completeSectors(e, lapTime) {
    const s1 = e._secSplit[0], s2 = e._secSplit[1];
    e.sectors[2] = (s2 != null && lapTime > s2) ? lapTime - s2 : null;
    e.lastSectors = [e.sectors[0], e.sectors[1], e.sectors[2]];
    for (let i = 0; i < 3; i++) {
      const v = e.lastSectors[i];
      if (v != null && v > 0 && (e.bestSectors[i] == null || v < e.bestSectors[i])) {
        e.bestSectors[i] = v;
      }
    }
    this._resetSectors(e);
  }

  /** Drop live sector state, re-deriving the stage from where the car is now. */
  _resetSectors(e) {
    const N = this.circuit.N, idx = e.phys.sampleIdx;
    e.sectors = [null, null, null];
    e._secSplit = [null, null];
    e._secStage = idx >= 2 * N / 3 ? 2 : idx >= N / 3 ? 1 : 0;
  }

  // ---- track limits: a sustained off-track excursion while carrying speed ----
  _trackLimits(e, dt) {
    const p = e.phys;
    if (e.finished || e.dnf || e.pitState) return;
    if (p.offTrack) {
      // gaining an advantage, not crashing: still quick and not hitting anything
      if (p.v > 30 && !p.wallContact) {
        e._offAcc += dt;
        if (e._offAcc > 0.4 && !e._offLatched) {
          e._offLatched = true;
          this._trackLimitViolation(e);
        }
      }
    } else {
      e._offAcc = 0;
      e._offLatched = false;
    }
  }

  _trackLimitViolation(e) {
    e.trackLimits++;
    if (!e.isPlayer) {
      if (e.ai) e.ai.penaltyScrub(2.5);   // AI take a small pace scrub instead
      return;
    }
    if (e.trackLimits <= 3) {
      this._radio(`TRACK LIMITS — WARNING ${e.trackLimits}/3`, 'warning', true);
      if (e.trackLimits === 3) this.onMessage('TRACK LIMITS — FINAL WARNING', 'yellow');
    } else {
      e.penaltySeconds += 5;
      this._radio('TRACK LIMITS — +5s PENALTY', 'warning', true);
      this.onMessage('TRACK LIMITS — +5s PENALTY', 'red');
    }
  }

  // ---- front wing damage ----
  _maybeWingDamage(e, source = 'car') {
    if (e.wingDamage > 0 || e.dnf || e.finished || e.pitState) return;
    // Wall and car incidents have independent debounce windows: a wall brush
    // must not suppress damage from a subsequent nose-to-tail impact (or vice
    // versa). `_contactCool` is retained only as harmless legacy state for old
    // snapshots and tooling.
    const cooldown = source === 'wall' ? '_wallDamageCool' : '_carDamageCool';
    if ((e[cooldown] || 0) > 0) return;
    e[cooldown] = 2;
    if (this.random() >= 0.25) return;
    e.wingDamage = 0.15;
    if (e.isPlayer) {
      this.onMessage('FRONT WING DAMAGE — BOX TO REPAIR', 'red');
      this._radio('FRONT WING DAMAGE — BOX TO REPAIR', 'warning', true);
    } else {
      e.boxThisLap = true;   // AI come in next time by to replace the wing
    }
  }

  _handleWallImpact(e, intensity) {
    if (!(intensity > 0)) return;
    if (e.isPlayer) {
      const candidate = {
        intensity,
        normalSpeed: e.phys.wallImpactNormalSpeed || Math.max(0, (intensity - 0.15) * 45),
        side: e.phys.lat < 0 ? -1 : 1,
      };
      const current = this._wallEvent;
      if (!current || candidate.intensity > (current.intensity || 0) ||
          (candidate.intensity === (current.intensity || 0) &&
            candidate.normalSpeed > (current.normalSpeed || 0))) {
        this._wallEvent = candidate;
      }
    }
    if (intensity > 0.5 && e.phys.wallImpactFront && this.mode === 'race') {
      this._maybeWingDamage(e, 'wall');
    }
  }

  // ---- blue flags: backmarkers must let a lapping car through ----
  _blueFlags(dt) {
    const c = this.circuit, N = c.N, ds = c.ds;
    const avail = e => !e.dnf && !e.finished && !e.pitState && !e.phys.disabled;
    let playerBlue = false;
    for (const b of this.entries) {
      if (!avail(b)) { b._blueT = 0; b._blueFrom = null; continue; }
      let lapper = null, bestT = 1e9;
      for (const a of this.entries) {
        if (a === b || !avail(a)) continue;
        if (a.lap - b.lap < 1) continue;          // must be at least a lap ahead
        let ahead = b.phys.sampleIdx - a.phys.sampleIdx;   // a → b along the track
        if (ahead > N / 2) ahead -= N;
        if (ahead < -N / 2) ahead += N;
        const d = ahead * ds;
        if (d <= 0 || d > 300) continue;          // a has to be behind b, and close
        const t = d / Math.max(a.phys.v, 28);
        if (t < 3 && t < bestT) { bestT = t; lapper = a; }
      }
      if (lapper) {
        b._blueT = 4;
        if (b.isPlayer) {
          playerBlue = true;
          if (b._blueFrom !== lapper.driver.id) {
            b._blueFrom = lapper.driver.id;
            this.onMessage('BLUE FLAGS — LET THE LEADER THROUGH', 'yellow');
            this._radio('Blue flags — let the leader through.', 'warning', true);
          }
        } else if (b.ai) {
          // pull off the racing line toward the side we are already on
          b.ai.setYield((b.phys.lat >= 0 ? 1 : -1) * 2.5, 4);
          b._blueFrom = lapper.driver.id;
        }
      } else if (b._blueT > 0) {
        b._blueT -= dt;
        if (b._blueT <= 0) b._blueFrom = null;
      }
    }
    this.blueFlagFor = playerBlue && this.player ? this.player.driver.id : null;
  }

  // ---- engineer radio: contextual colour, at most one line per 12s ----
  _gapSeconds(ahead, e) {
    const c = this.circuit;
    const d = (ahead.lap - e.lap) * c.length + (ahead.phys.sampleIdx - e.phys.sampleIdx) * c.ds;
    if (d < 0) return null;
    return d / Math.max(e.phys.v, 28);
  }

  _engineerRadio(dt) {
    const p = this.player;
    if (!p || p.dnf) return;

    if (this.phase !== 'racing' || p.finished || p.pitState) return;

    // final lap
    if (this.laps - p.lap === 1 && p.lap > 0 && !this._radioLastLap) {
      this._radioLastLap = true;
      this._radio('Last lap — bring it home', 'info', true);
      return;
    }
    // places gained
    if (this._lastPlayerPos == null) this._lastPlayerPos = p.position;
    if (p.position !== this._lastPlayerPos) {
      const gained = this._lastPlayerPos - p.position;
      this._lastPlayerPos = p.position;
      if (gained > 0 && this._radio(`P${p.position} — great move`, 'celebration')) return;
    }
    // tyre state, once per stint
    if (p.phys.wear > 0.6 && this._radioTyreStint !== p.pitStops) {
      if (this._radio('These tyres are done — box when ready', 'warning')) {
        this._radioTyreStint = p.pitStops;
        return;
      }
    }
    // gap to the car ahead when we are the quicker of the two
    this._gapCheck = (this._gapCheck ?? 0) - dt;
    if (this._gapCheck <= 0) {
      this._gapCheck = 4;
      const ahead = this.entries.find(e => !e.dnf && !e.pitState && e.position === p.position - 1);
      if (ahead && p.lastLap && ahead.lastLap && p.lastLap < ahead.lastLap) {
        const g = this._gapSeconds(ahead, p);
        if (g != null && g < 2.5) {
          this._radio(`Gap to ${ahead.driver.lastName} ${g.toFixed(1)}, you're quicker`, 'info');
        }
      }
    }
  }

  _onCross(e, dir = 1) {
    const c = this.circuit;
    if (dir < 0) { e.lap--; return; }   // reversed back over the line
    e.lap++;
    if (e.lap <= (e.maxLap ?? -1)) return; // re-crossing after a reverse: no double bookkeeping
    e.maxLap = e.lap;
    if (this.phase === 'lights') return;   // jump-start crossing: lap counted, no timing
    if (e.lap === 0) {
      e.lapStart = this.raceTime;
      this._resetSectors(e);
    } else {
      const lt = this.raceTime - e.lapStart;
      e.lapStart = this.raceTime;
      e.lastLap = lt;
      e.lapTimes.push(lt);
      e.tyreAgeLaps++;
      this._completeSectors(e, lt);
      if (!e.bestLap || lt < e.bestLap) e.bestLap = lt;
      if (this.mode === 'race' && (!this.fastestLap || lt < this.fastestLap.time)) {
        const eventKey = `fastest:${e.driver.id}:${lt}`;
        this.fastestLap = { driverId: e.driver.id, time: lt, name: e.driver.lastName, eventKey };
        this.onMessage(`FASTEST LAP — ${e.driver.code} ${fmtTime(lt)}`, 'purple', { eventKey });
      }
    }
    if (this.mode !== 'race') return;

    // pit entry
    if ((e.boxThisLap || (!e.isPlayer && e.lap === e.plannedPitLap) ||
        (!e.isPlayer && e.phys.wear > 0.72 && e.lap < this.laps - 2 && this.laps >= 8))
        && e.lap > 0 && e.lap < this.laps && !e.finished) {
      this._enterPit(e);
    }
    // forced strategy: AI second-guess if wear critical handled above
    if (!e.isPlayer && e.ai) e.ai.newLapNoise();

    // chequered flag
    if (e.lap >= this.laps && !e.finished) {
      e.finished = true;
      e.coolDown = 2.5;
      e.finishTime = this.raceTime;   // time penalties are applied at classification
      if (this.phase !== 'finished') {
        this.phase = 'finished';
        this.phaseT = 0;
        this._finishGrace = 4;
        this.onMessage(`${e.driver.code} WINS THE RACE`, 'yellow');
        this.winner = e;
      }
      if (e.isPlayer) { this._finishGrace = Math.min(this._finishGrace ?? 4, 2.5); }
    } else if (e.isPlayer && this.laps - e.lap <= 3 && this.laps - e.lap > 0 && e.lap > 0) {
      this.onMessage(this.laps - e.lap === 1 ? 'FINAL LAP' : `${this.laps - e.lap} LAPS TO GO`, '');
    }
  }

  _enterPit(e) {
    e.pitState = {
      phase: 'stopped',
      timer: pitLaneLoss(this.circuit) + 2.2 + this.random() * 2 + (this.random() < 0.06 ? 4 : 0)
             + (e.wingDamage > 0 ? 3 : 0),   // front wing change costs extra
      chosen: null,
      wing: e.wingDamage > 0,
    };
    e.phys.disabled = true;
    e.mesh.visible = false;
    e.boxThisLap = false;
    e.pitStops++;
    if (e.isPlayer) this._playerPitOpen = true;
    else {
      const next = e.plannedNext || (e.phys.compound === 'H' ? 'M' : 'H');
      e.pitState.chosen = next;
      e.plannedPitLap = -1;
    }
  }

  _updatePit(e, dt) {
    e.pitState.timer -= dt;
    if (e.pitState.timer <= 0) {
      const c = this.circuit;
      const chosen = e.pitState.chosen || defaultNext(e.phys.compound);
      e.phys.setTyre(chosen);
      const i = c.pitExitIdx;
      const s = c.samples[i];
      e.phys.placeAt(s.p.clone().addScaledVector(s.n, c.halfWidth * 0.5), Math.atan2(s.t.x, s.t.z), i);
      e.phys.v = 23; // pit exit speed
      e.phys.gear = 3;
      e.phys.disabled = false;
      const repaired = e.pitState.wing;
      e.pitState = null;
      e.mesh.visible = true;
      e.tyreAgeLaps = 0;
      e.wingDamage = 0;             // new nose fitted
      e.phys.dirtyAir = 0;
      this._resetSectors(e);
      this.resetRenderState(e);
      if (CAR.setTyreCompound && e.carHandle) CAR.setTyreCompound(e.carHandle, chosen);
      if (e.isPlayer) {
        this._playerPitOpen = false;
        this.onMessage(`${COMPOUNDS[chosen].name} TYRES FITTED`, 'green');
        if (repaired) this._radio('New nose on, wing damage fixed — push now.', 'info', true);
      }
    }
  }

  playerChooseTyre(key) {
    if (this.player && this.player.pitState) this.player.pitState.chosen = key;
  }
  playerRequestBox() {
    if (this.player && !this.player.finished && this.mode === 'race' && this.phase === 'racing') {
      this.player.boxThisLap = !this.player.boxThisLap;
      this.onMessage(this.player.boxThisLap ? 'BOX THIS LAP — CONFIRMED' : 'STAYING OUT', '');
    }
  }

  _retire(e) {
    e.dnf = true;
    e.phys.disabled = true;
    e.mesh.visible = false;
    if (e.ai) { e.ai.vscFactor = 1; e.ai.noOvertake = false; }
    this.onMessage(`${e.driver.code} RETIRES — MECHANICAL`, 'yellow');
    // a car stopping on track often brings out the VSC, but only when there is
    // still enough of the race left to be worth neutralising
    const leadLap = this.entries.reduce((m, x) => Math.max(m, x.lap), 0);
    if (this.mode === 'race' && this.phase === 'racing' && !this.vsc.active &&
        this.laps - leadLap > 2 && this.random() < 0.4) {
      this._startVSC(18 + this.random() * 12);
    }
  }

  _collisions() {
    const es = this.entries;
    const bodies = es.map((entry) => syncContactBody(entry._contactBody || (entry._contactBody = {}), entry.phys));
    const activeNow = new Set();
    const impactingBefore = this._impactingContacts || new Set();
    const impactingNow = new Set();
    const impacts = [];
    const baseVx = new Float64Array(es.length);
    const baseVz = new Float64Array(es.length);
    const deltaVx = new Float64Array(es.length);
    const deltaVz = new Float64Array(es.length);

    for (let i = 0; i < es.length; i++) {
      baseVx[i] = bodies[i].fx * es[i].phys.v;
      baseVz[i] = bodies[i].fz * es[i].phys.v;
    }

    for (const e of es) {
      e.phys.carScrape = 0;
      e.phys.carScrapeSide = 0;
    }

    // Capture contact-entry kinematics before positional correction. Audio and
    // damage are based on relative velocity, never on overlap depth.
    for (let i = 0; i < es.length; i++) {
      const A = es[i];
      if (A.phys.disabled || A.dnf) continue;
      for (let j = i + 1; j < es.length; j++) {
        const B = es[j];
        if (B.phys.disabled || B.dnf) continue;
        const contact = orientedCarContact(bodies[i], bodies[j]);
        if (!contact) continue;
        const aId = String(A.driver?.id ?? i);
        const bId = String(B.driver?.id ?? j);
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        activeNow.add(key);
        const rvx = baseVx[i] - baseVx[j];
        const rvz = baseVz[i] - baseVz[j];
        const closing = Math.max(0, -(rvx * contact.nx + rvz * contact.nz));
        const tx = -contact.nz;
        const tz = contact.nx;
        const tangentSpeed = rvx * tx + rvz * tz;
        const scrape = Math.max(0, Math.min(1, (Math.abs(tangentSpeed) - 0.5) / 14));
        A.phys.carScrape = Math.max(A.phys.carScrape, scrape);
        B.phys.carScrape = Math.max(B.phys.carScrape, scrape);
        if (scrape >= A.phys.carScrape) A.phys.carScrapeSide = contactSideFor(bodies[i], contact.nx, contact.nz, true);
        if (scrape >= B.phys.carScrape) B.phys.carScrapeSide = contactSideFor(bodies[j], contact.nx, contact.nz, false);
        if (impactingBefore.has(key) && closing > 0.15) impactingNow.add(key);
        impacts.push({ i, j, A, B, a: bodies[i], b: bodies[j], contact, closing, tangentSpeed, key });
      }
    }

    const corrX = new Float64Array(es.length);
    const corrZ = new Float64Array(es.length);

    // First remove the overlap represented by the captured contact normal. This
    // preserves the established pack behaviour and gives the impulse a valid
    // non-penetrating starting configuration.
    solveContactPositions(this, es, bodies, corrX, corrZ);

    // Low-restitution impulse plus capped tangential friction. Every pair reads
    // the same pre-solve velocity snapshot and accumulates a world-space delta;
    // applying once per car removes entry-order bias in three-car pileups.
    for (const impact of impacts) {
      const { i, j, A, B, a, b, contact, closing, tangentSpeed, key } = impact;
      if (closing <= 0.5) continue;
      const invSum = a.invMass + b.invMass;
      const normalImpulse = (1.04 * closing) / invSum;
      const tx = -contact.nz;
      const tz = contact.nx;
      const tangentImpulse = Math.max(-normalImpulse * 0.16,
        Math.min(normalImpulse * 0.16, -tangentSpeed / invSum));
      const impulseX = contact.nx * normalImpulse + tx * tangentImpulse;
      const impulseZ = contact.nz * normalImpulse + tz * tangentImpulse;
      deltaVx[i] += impulseX * a.invMass;
      deltaVz[i] += impulseZ * a.invMass;
      deltaVx[j] -= impulseX * b.invMass;
      deltaVz[j] -= impulseZ * b.invMass;
      const intensity = Math.max(0, Math.min(1, (closing - 0.5) / 18));
      A.phys.impactKick = Math.max(A.phys.impactKick || 0, intensity * 0.75);
      B.phys.impactKick = Math.max(B.phys.impactKick || 0, intensity * 0.75);

      const newImpact = !impactingBefore.has(key);
      if (newImpact) {
        impactingNow.add(key);
        if (A.isPlayer || B.isPlayer) {
          const playerBody = A.isPlayer ? a : b;
          const candidate = {
            intensity,
            closingSpeed: closing,
            side: contactSideFor(playerBody, contact.nx, contact.nz, A.isPlayer),
          };
          const current = this._touchEvent;
          if (!current || candidate.intensity > (current.intensity || 0) ||
              (candidate.intensity === (current.intensity || 0) &&
                candidate.closingSpeed > (current.closingSpeed || 0))) {
            this._touchEvent = candidate;
          }
        }
        if (closing > 8) {
          // Front-wing damage belongs only to a nose-first participant. The
          // car being rear-ended, or either car in a sidepod rub, is not assigned
          // fictitious front-wing damage.
          if (contactLongitudinalFor(a, contact.nx, contact.nz, true) > 0.45) {
            this._maybeWingDamage(A, 'car');
          }
          if (contactLongitudinalFor(b, contact.nx, contact.nz, false) > 0.45) {
            this._maybeWingDamage(B, 'car');
          }
        }
      }
    }

    for (let i = 0; i < es.length; i++) {
      if (deltaVx[i] === 0 && deltaVz[i] === 0) continue;
      applyContactVelocity(es[i].phys, baseVx[i] + deltaVx[i], baseVz[i] + deltaVz[i]);
    }

    // Apply at most one real wall impulse after contact has changed velocity and
    // heading. The geometry pass below then resolves bodies using this final
    // response; running the wall impulse after it can recreate deep overlap.
    for (const e of es) {
      const wallHit = e.phys.resolveWallCollision?.(true) || 0;
      if (wallHit) this._handleWallImpact?.(e, wallHit);
    }

    // Solve positions after velocity impulses have updated headings. Doing this
    // in the opposite order let a final yaw-aware wall projection move a newly
    // rotated car deep into its neighbour. Eight alternating Jacobi/contact and
    // wall passes converge small packs and wall squeezes without pair-order bias.
    solveContactPositions(this, es, bodies, corrX, corrZ);

    // Finish with geometry-only wall projection: never rotate a car after the
    // last body constraint pass.
    for (const e of es) e.phys.projectWallConstraint?.();
    this._activeContacts = activeNow;
    this._impactingContacts = impactingNow;
  }

  _updatePositions() {
    const c = this.circuit;
    const live = this.entries.filter(e => !e.dnf);
    const progOf = e => (e.lap) * c.length + e.phys.sampleIdx * c.ds + (e.pitState ? -2 : 0);
    live.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return progOf(b) - progOf(a);
    });
    live.forEach((e, i) => { e.position = i + 1; });
    this.entries.filter(e => e.dnf).forEach((e, i) => { e.position = live.length + 1 + i; });
    for (const e of this.entries) e.positionsGained = (e.gridPos ?? e.position) - e.position;
    const leader = live[0];
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      if (i === 0) { e.gapText = 'LEADER'; e.intervalText = ''; continue; }
      if (e.pitState) { e.gapText = 'PIT'; continue; }
      const dp = progOf(leader) - progOf(e);
      if (dp > c.length) e.gapText = `+${Math.floor(dp / c.length)}L`;
      else e.gapText = '+' + (dp / Math.max(e.phys.v, 28)).toFixed(1);
      const ahead = live[i - 1];
      const di = progOf(ahead) - progOf(e);
      e.intervalText = '+' + (di / Math.max(e.phys.v, 28)).toFixed(1);
    }
  }

  _updateQuali() {
    const e = this.player;
    if (!e || this.qualiState === 'done') return;
    // detect SF crossing handled in _onCross via lap counter
    if (this.qualiState === 'outlap' && e.lap >= 0) {
      this.qualiState = 'flying';
      this.onMessage('FLYING LAP — GO!', 'green');
    } else if (this.qualiState === 'flying' && e.lap >= 1) {
      if (this.trial) {
        // time trial: keep lapping; bestLap accumulates
        if (e.lastLap && e.lapTimes.length && e.lapTimes[e.lapTimes.length - 1] === e.lastLap && this._lastAnnounced !== e.lapTimes.length) {
          this._lastAnnounced = e.lapTimes.length;
          this.onMessage(`LAP ${fmtTime(e.lastLap)}${e.lastLap === e.bestLap ? ' — PERSONAL BEST' : ''}`, e.lastLap === e.bestLap ? 'purple' : '');
        }
      } else {
        this.qualiState = 'done';
        this.qualiTime = e.lastLap;
      }
    }
  }

  qualiClassification() {
    const rows = [...this.aiQualiTimes];
    if (this.qualiTime) rows.push({ driverId: this.playerDriverId, time: this.qualiTime });
    else rows.push({ driverId: this.playerDriverId, time: 9999 });
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }

  _classify() {
    const c = this.circuit;
    const progOf = e => e.lap * c.length + e.phys.sampleIdx * c.ds;
    // time penalties are served here, so they can reorder the classification
    const ft = e => e.finishTime + (e.penaltySeconds || 0);
    const fin = this.entries.filter(e => e.finished).sort((a, b) => ft(a) - ft(b));
    const run = this.entries.filter(e => !e.finished && !e.dnf).sort((a, b) => progOf(b) - progOf(a));
    const dnf = this.entries.filter(e => e.dnf);
    const order = [...fin, ...run, ...dnf];
    const winner = order[0];
    const refLap = winner.bestLap || (ft(winner) / Math.max(1, winner.lap)) || 90;
    // gaps must be monotonic down the classification: a running car's
    // progress-estimated gap can otherwise undercut a finisher's real gap
    let prevGapS = 0;
    this.results = order.map((e, i) => {
      let gapText;
      if (e.dnf) gapText = 'DNF';
      else if (i === 0) gapText = fmtTime(ft(e), true);
      else if (e.finished) {
        const gs = ft(e) - ft(winner);
        prevGapS = Math.max(prevGapS, gs);
        gapText = '+' + fmtTime(gs);
      } else {
        const dl = (progOf(winner) - progOf(e)) / c.length;
        if (dl >= 1) gapText = '+' + Math.floor(dl) + ' LAP' + (dl >= 2 ? 'S' : '');
        else {
          const gs = Math.max(0.001, dl * refLap, prevGapS + 0.4);
          prevGapS = gs;
          gapText = '+' + fmtTime(gs);
        }
      }
      return {
        pos: i + 1,
        gridPos: e.gridPos,
        driver: e.driver, team: e.team, isPlayer: e.isPlayer,
        dnf: e.dnf,
        laps: Math.max(0, e.lap),
        pits: e.pitStops,
        bestLap: e.bestLap,
        gapText,
        penaltySeconds: e.penaltySeconds || 0,
        points: (i < POINTS.length && !e.dnf) ? POINTS[i] : 0,
        fastestLap: this.fastestLap && this.fastestLap.driverId === e.driver.id,
      };
    });
    // post-flag verdict over the radio, using the final classification
    const pr = this.results.find(r => r.isPlayer);
    if (pr && !this._radioResult) {
      this._radioResult = true;
      const n = pr.pos;
      const verdict = pr.dnf ? 'Sorry about that — the car let us down.'
        : n === 1 ? 'Superb drive — that is the win!'
        : n <= 3 ? 'On the podium, brilliant job.'
        : n <= 10 ? 'Points on the board, well driven.'
        : 'Not our day — we go again next time.';
      this._radio(`P${n}. ${verdict}`, !pr.dnf && n <= 3 ? 'celebration' : 'info', true);
    }
  }

  _renderHeight(e) {
    const p = e.phys;
    const c = this.circuit;
    if (!c || !c.heightAt) return 0;
    const sm = c.samples[p.sampleIdx];
    if (!sm) return 0;
    const along = (p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z;
    return c.heightAt(p.sampleIdx + along / c.ds);
  }

  _captureRenderState(e, target) {
    const p = e.phys;
    target.x = p.pos.x;
    target.y = this._renderHeight(e);
    target.z = p.pos.z;
    target.heading = p.heading;
    target.v = p.v || 0;
    target.wheelSpin = e.wheelSpin || 0;
    target.steer = p.steer || 0;
    target.pitch = p.pitch || 0;
    target.roll = p.roll || 0;
    target.rideBump = p.rideBump || 0;
    return target;
  }

  _ensureRenderState(e) {
    if (e.renderPrev && e.renderCurr && e.renderPose) return;
    e.renderPrev = makeRenderSnapshot();
    e.renderCurr = makeRenderSnapshot();
    e.renderPose = makeRenderSnapshot();
    this._captureRenderState(e, e.renderCurr);
    copyRenderSnapshot(e.renderCurr, e.renderPrev);
    copyRenderSnapshot(e.renderCurr, e.renderPose);
  }

  _beginRenderTick() {
    for (const e of this.entries) {
      this._ensureRenderState(e);
      copyRenderSnapshot(e.renderCurr, e.renderPrev);
    }
  }

  _finishRenderTick() {
    for (const e of this.entries) {
      this._ensureRenderState(e);
      this._captureRenderState(e, e.renderCurr);
    }
  }

  _advanceWheelSpin(e, dt) {
    if (Number.isFinite(dt) && dt > 0 && e.wheelRadius > 0) {
      e.wheelSpin += (e.phys.v / e.wheelRadius) * dt;
    }
  }

  /** Collapse interpolation history to authoritative state after construction,
   *  timing resets and teleports. Pass one entry for a local snap (pit/recovery). */
  resetRenderState(entry = null) {
    if (this._renderDisposed) return;
    const entries = entry ? [entry] : this.entries;
    for (const e of entries) {
      this._ensureRenderState(e);
      this._captureRenderState(e, e.renderCurr);
      copyRenderSnapshot(e.renderCurr, e.renderPrev);
      copyRenderSnapshot(e.renderCurr, e.renderPose);
      this._applyRenderPose(e, e.renderPose);
    }
  }

  /** Apply a render-only pose between the previous and current fixed ticks. */
  render(alpha) {
    if (this._renderDisposed) return;
    for (const e of this.entries) {
      this._ensureRenderState(e);
      interpolateRenderSnapshot(e.renderPrev, e.renderCurr, alpha, e.renderPose);
      this._applyRenderPose(e, e.renderPose);
    }
  }

  _applyRenderPose(e, pose) {
    if (!e.mesh) return;
    e.renderY = pose.y;
    e.mesh.position.set(pose.x, pose.y, pose.z);
    e.mesh.rotation.y = pose.heading;

    // Counter-rotate the local lobe so its direction remains fixed in world space.
    if (e.shadowLobe) {
      const a = SUN_GROUND_AZI - pose.heading;
      e.shadowLobe.position.set(Math.sin(a) * SUN_SHADOW_OFF, 0.002,
        Math.cos(a) * SUN_SHADOW_OFF);
      e.shadowLobe.rotation.z = -a;
    }

    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      const w = e.wheels && e.wheels[k];
      if (!w) continue;
      w.rotation.x = pose.wheelSpin;
      if (k === 'fl' || k === 'fr') w.rotation.y = pose.steer * 0.32;
      const farWheel = e.carHandle?.farProxy?.wheels?.[k];
      if (farWheel) {
        farWheel.rotation.x = pose.wheelSpin;
        if (k === 'fl' || k === 'fr') farWheel.rotation.y = pose.steer * 0.32;
      }
    }

    const body = e.carHandle && e.carHandle.body;
    if (body) {
      body.rotation.x = pose.pitch;
      body.rotation.z = pose.roll;
      body.position.y = pose.rideBump;
    }
    const farBody = e.carHandle?.farProxy?.body;
    if (farBody) {
      farBody.rotation.x = pose.pitch;
      farBody.rotation.z = pose.roll;
      farBody.position.y = pose.rideBump;
    }

    // Race-state visual hooks remain presentation-only. They read authoritative
    // controls but never write physics or interpolation snapshots.
    const p = e.phys;
    const ud = e.mesh.userData || {};
    const glow = brakeGlowIntensity(p.brakeTemp, p.brake, p.v);
    applyBrakeGlowState(ud.brakeGlows, glow);
    applyBrakeGlowState(e.carHandle?.farProxy?.brakeGlows, glow);
    const harvesting = (p.brake > 0.1 || p.throttle < 0.25) && p.v > 12;
    const rainVisible = !harvesting || (Math.floor(performance.now() / 110) % 2 === 0);
    if (ud.rainLight) ud.rainLight.visible = rainVisible;
    if (e.carHandle?.farProxy?.rainLight) e.carHandle.farProxy.rainLight.visible = rainVisible;
  }

  _setEntryCarLod(e, level) {
    const handle = e?.carHandle;
    if (!handle) return false;
    const next = e.isPlayer ? 'full' : (level === 'far' ? 'far' : 'full');
    const changed = e.lodLevel !== next;
    e.lodLevel = next;
    handle.lodLevel = next;
    const fullRoots = handle.fullDetailRoots
      || [handle.body, handle.wheels?.fl, handle.wheels?.fr, handle.wheels?.rl, handle.wheels?.rr];
    for (const root of fullRoots) if (root) root.visible = next === 'full';
    if (handle.farProxy) handle.farProxy.root.visible = next === 'far';
    if (e.contactShadow) e.contactShadow.visible = next === 'full';
    if (changed) this._carLodSwitches++;
    return changed;
  }

  /** Select AI detail against the already-settled render camera at 10 Hz. */
  updateCarLod(camera, nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (this._renderDisposed || !camera?.position) return false;
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const clockRebased = now < this._carLodLastAt;
    if (this._carLodInitialized && !clockRebased && now < this._carLodNextAt) {
      return false;
    }
    this._carLodInitialized = true;
    this._carLodLastAt = now;
    this._carLodNextAt = now + CAR_LOD_SPEC.cadenceMs;
    this._carLodUpdates++;
    const cp = camera.position;
    for (const e of this.entries) {
      const dx = e.mesh.position.x - cp.x;
      const dy = e.mesh.position.y - cp.y;
      const dz = e.mesh.position.z - cp.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this._setEntryCarLod(e,
        resolveCarLod(e.lodLevel, distance, e.isPlayer, this._carLodMode));
    }
    return true;
  }

  setCarLodMode(mode) {
    this._carLodMode = mode === 'forced-full' || mode === 'full'
      ? 'forced-full' : 'automatic';
    this._carLodNextAt = -Infinity;
    if (this._carLodMode === 'forced-full') {
      for (const e of this.entries) this._setEntryCarLod(e, 'full');
    }
    return this.carLodTelemetry;
  }

  get carLodTelemetry() {
    let full = 0, far = 0;
    for (const e of this.entries) e.lodLevel === 'far' ? far++ : full++;
    return {
      mode: this._carLodMode,
      initialized: this._carLodInitialized,
      cadenceHz: CAR_LOD_SPEC.cadenceHz,
      enterFarM: CAR_LOD_SPEC.enterFarM,
      returnFullM: CAR_LOD_SPEC.returnFullM,
      hysteresis: CAR_LOD_SPEC.hysteresis,
      updates: this._carLodUpdates,
      switches: this._carLodSwitches,
      full,
      far,
      playerPinnedFull: !this.player || this.player.lodLevel === 'full',
    };
  }

  // Compatibility for tools/direct callers that still request an immediate
  // authoritative mesh sync. Internal fixed ticks use snapshot capture instead.
  _syncMesh(e, dt = 0) {
    if (this._renderDisposed || !e) return;
    this._ensureRenderState(e);
    this._advanceWheelSpin(e, dt);
    this._captureRenderState(e, e.renderCurr);
    copyRenderSnapshot(e.renderCurr, e.renderPrev);
    copyRenderSnapshot(e.renderCurr, e.renderPose);
    this._applyRenderPose(e, e.renderPose);
  }

  _msgOnce(key, text, color) {
    this._onceKeys = this._onceKeys || {};
    const now = performance.now();
    if (!this._onceKeys[key] || now - this._onceKeys[key] > 5000) {
      this._onceKeys[key] = now;
      this.onMessage(text, color);
    }
  }

  setNametags(v) {
    this._tagsWanted = v;
    // hide instantly on toggle-off; toggle-on lets the per-frame screen-space
    // pass (updateNametags) reveal at most TAG_MAX_VISIBLE next frame
    if (!v) for (const e of this.entries) if (e.tag) e.tag.visible = false;
  }

  /**
   * Screen-space nametag pass: distance cull (TAG_RANGE), nearest-first cap
   * (TAG_MAX_VISIBLE), viewport clamp, overlap cull and car-occlusion guard —
   * see js/nametags.js. Runs once per rendered frame from main.js, after the
   * camera settles. Tags stay hidden before lights-out (grid/lights phases)
   * and in headless tools, which never call this.
   */
  updateNametags(camera, vw, vh) {
    const phaseOk = this.phase === 'racing' || this.phase === 'finished';
    const on = this._tagsWanted && phaseOk && !!this.player;
    const pp = on ? (this.player.renderPose || this.player.phys.pos) : null;
    const cands = [];
    for (const e of this.entries) {
      if (!e.tag) continue;
      if (!on || e.isPlayer) { e.tag.visible = false; continue; }
      const pose = e.renderPose || e.phys.pos;
      const dx = pose.x - pp.x, dz = pose.z - pp.z;
      cands.push({ tag: e.tag, x: pose.x, y: e.renderY || 0, z: pose.z, d2: dx * dx + dz * dz });
    }
    if (cands.length) layoutNametags(cands, camera, vw, vh);
  }

  dispose() {
    if (this._renderDisposed) return;
    this._renderDisposed = true;
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    for (const e of this.entries) {
      CAR.releaseCarMesh?.(e.carHandle);
      this.scene.remove(e.mesh);
      e.mesh.traverse(o => {
        // sprites share a module-level geometry inside three — never dispose it
        if (o.isSprite) {
          if (o.material && !o.material.userData.shared) {
            materials.add(o.material);
            if (o.material.map && !o.material.map.userData.shared) textures.add(o.material.map);
          }
          return;
        }
        // resources marked shared are reused across cars/sessions — keep them
        if (o.geometry && !o.geometry.userData.shared) geometries.add(o.geometry);
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.userData.shared) return;
          materials.add(m);
          if (m.map && !m.map.userData.shared) textures.add(m.map);
        });
      });
      e.renderPrev = null;
      e.renderCurr = null;
      e.renderPose = null;
    }
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
  }
}

const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, boost: false };

function defaultNext(cur) { return cur === 'S' ? 'M' : cur === 'M' ? 'H' : 'M'; }

function pitLaneLoss(circuit) {
  return 14 + circuit.length / 380;
}
