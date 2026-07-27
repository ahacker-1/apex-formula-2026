// Physics envelope harness: locks the lap-time envelope the AI calibration
// depends on, and exercises every deep-physics feature added to js/physics.js
// (tyre temperature, brake fade, attitude outputs, ERS modes, surface feel,
// dirty-air understeer).
//
// Usage: node tools/physics-envelope.mjs
//
// The lap-time reference below was measured with this exact rig BEFORE the
// physics work started (pre-change js/physics.js, same seeded RNG, same solo
// AIDriver setup): laps 85.533 85.233 85.400 85.567 85.933 -> mean(2..5).
// The sim-race race-level reference at the same moment was Monza fastestLap
// 84.267s over 5 laps. Keep mean(laps 2-5) within TOL of BASELINE_MONZA.
const BASELINE_MONZA = 85.5333;   // s, mean of laps 2-5, solo AI, difficulty 1
const TOL = 0.015;                // +/-1.5%

// ---- minimal DOM stubs (canvas textures), per tools/sim-race.mjs ----
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '',
  fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {},
  fillText() {}, createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
  ellipse() {}, bezierCurveTo() {}, setTransform() {}, drawImage() {},
});
globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: ctxStub }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// deterministic RNG so lap times are reproducible run to run
let _seed = 0x2f6e2b1;
Math.random = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};
const reseed = () => { _seed = 0x2f6e2b1; };

const THREE = await import('../lib/three.module.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { CarPhysics } = await import('../js/physics.js');
const { AIDriver } = await import('../js/ai.js');

// ---- assertion plumbing ----
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  else { failures++; console.error(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

const DT = 1 / 30;
const scene = new THREE.Scene();
const circuit = buildCircuit('monza', TRACKS.monza, scene);
console.log(`[env] monza: length=${Math.round(circuit.length)}m N=${circuit.N} halfWidth=${circuit.halfWidth.toFixed(1)} wallOff=${circuit.wallOff.toFixed(1)}`);

function newCar(laps = 5, opts = {}) {
  const phys = new CarPhysics(circuit, {
    perf: 0.96, isPlayer: false,
    assists: { tc: true, abs: true, autoGear: true }, ...opts,
  });
  phys.fuelBurnPerMeter = 1 / (laps * circuit.length * 1.06);
  phys.setTyre('M');
  return phys;
}

// rolling start 140m before the line, as the quali out-lap does
function rollingStart(phys) {
  const idx = (circuit.N - Math.round(140 / circuit.ds)) % circuit.N;
  const s = circuit.samples[idx];
  phys.placeAt(s.p.clone(), Math.atan2(s.t.x, s.t.z), idx);
  phys.v = 46;
  phys.gear = 5;
  return idx;
}

// ============================================================
// 1. lap-time envelope + tyre temp band + brake oscillation + attitude bounds
// ============================================================
console.log('[env] 1. five-lap solo AI run (lap times, tyre/brake temps, attitude)');
reseed();
const phys = newCar(5);
rollingStart(phys);
const ai = new AIDriver(phys, circuit, { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);

const lapTimes = [];
const lapStats = [];
let t = 0, lastCross = null, cur = null;
let attMax = { pitch: 0, roll: 0, bump: 0 };
let nanSeen = false, tempFirst90 = null;
const newStat = () => ({ tMin: Infinity, tMax: -Infinity, tSum: 0, n: 0, bMin: Infinity, bMax: -Infinity, bDirFlips: 0, bPrev: null, bRising: null, fadeMax: 0 });
cur = newStat();

while (t < 900 && lapTimes.length < 5) {
  const input = ai.update(DT, [phys]);
  const ev = phys.step(DT, input);
  t += DT;

  if (!finite(phys.tyreTemp) || !finite(phys.brakeTemp) || !finite(phys.pitch) ||
      !finite(phys.roll) || !finite(phys.rideBump) || !finite(phys.v)) nanSeen = true;
  if (tempFirst90 === null && phys.tyreTemp >= 90) tempFirst90 = t;
  cur.n++;
  cur.tSum += phys.tyreTemp;
  cur.tMin = Math.min(cur.tMin, phys.tyreTemp);
  cur.tMax = Math.max(cur.tMax, phys.tyreTemp);
  cur.bMin = Math.min(cur.bMin, phys.brakeTemp);
  cur.bMax = Math.max(cur.bMax, phys.brakeTemp);
  cur.fadeMax = Math.max(cur.fadeMax, phys.brakeFade);
  if (cur.bPrev !== null && Math.abs(phys.brakeTemp - cur.bPrev) > 1e-9) {
    const rising = phys.brakeTemp > cur.bPrev;
    if (cur.bRising !== null && rising !== cur.bRising) cur.bDirFlips++;
    cur.bRising = rising;
  }
  cur.bPrev = phys.brakeTemp;
  attMax.pitch = Math.max(attMax.pitch, Math.abs(phys.pitch));
  attMax.roll = Math.max(attMax.roll, Math.abs(phys.roll));
  attMax.bump = Math.max(attMax.bump, Math.abs(phys.rideBump));

  if (ev.crossedSF === 1) {
    if (lastCross != null) { lapTimes.push(t - lastCross); lapStats.push(cur); }
    lastCross = t;
    cur = newStat();
    ai.newLapNoise();
  }
}

ok(lapTimes.length === 5, 'completed 5 timed laps', `got ${lapTimes.length}`);
const flying = lapTimes.slice(1);
const avg = flying.reduce((a, b) => a + b, 0) / flying.length;
const drift = (avg - BASELINE_MONZA) / BASELINE_MONZA;
console.log(`  laps: ${lapTimes.map(x => x.toFixed(3)).join(' ')}`);
console.log(`  mean(2-5)=${avg.toFixed(3)}s  baseline=${BASELINE_MONZA.toFixed(3)}s  drift=${(drift * 100).toFixed(3)}%`);
for (let i = 0; i < lapStats.length; i++) {
  const s = lapStats[i];
  console.log(`  lap${i + 1}: tyre ${s.tMin.toFixed(0)}/${(s.tSum / s.n).toFixed(0)}/${s.tMax.toFixed(0)} C   brake ${s.bMin.toFixed(0)}..${s.bMax.toFixed(0)} C (flips=${s.bDirFlips}, fadeMax=${(s.fadeMax * 100).toFixed(1)}%)`);
}
ok(Math.abs(drift) <= TOL, `mean lap 2-5 within +/-${(TOL * 100).toFixed(1)}% of baseline`, `drift=${(drift * 100).toFixed(3)}%`);
ok(!nanSeen, 'no NaN/Inf in tyreTemp, brakeTemp, attitude or speed');

// tyre temperature: in the working band within 2 laps, and it stays there
const twoLaps = lapTimes[0] + lapTimes[1];
ok(tempFirst90 !== null && tempFirst90 <= twoLaps,
  'tyreTemp reaches the 90C+ working band within 2 laps',
  `first90=${tempFirst90 === null ? 'never' : tempFirst90.toFixed(1) + 's'} of ${twoLaps.toFixed(1)}s`);
const settled = lapStats.slice(1);
const sMin = Math.min(...settled.map(s => s.tMin));
const sMax = Math.max(...settled.map(s => s.tMax));
const meanOK = settled.every(s => s.tSum / s.n >= 90 && s.tSum / s.n <= 115);
ok(sMin >= 90 && sMax <= 115, 'tyreTemp stays inside 90-115C from lap 2 on',
  `range ${sMin.toFixed(1)}..${sMax.toFixed(1)}C`);
ok(meanOK, 'per-lap mean tyreTemp inside 90-115C from lap 2 on',
  settled.map(s => (s.tSum / s.n).toFixed(0)).join(','));

// brake temperature must actually cycle (heat in the zones, cool on the straights)
const flips = settled.map(s => s.bDirFlips);
const swings = settled.map(s => s.bMax - s.bMin);
ok(flips.every(f => f >= 4), 'brakeTemp oscillates (>=4 direction changes per lap)', flips.join(','));
ok(swings.every(s => s > 30), 'brakeTemp swing >30C per lap', swings.map(x => x.toFixed(0)).join(','));

// attitude outputs stay small
ok(attMax.pitch < 0.06 && attMax.roll < 0.06,
  'pitch/roll bounded below 0.06 rad',
  `maxPitch=${attMax.pitch.toFixed(4)} maxRoll=${attMax.roll.toFixed(4)}`);
ok(attMax.pitch > 0.005 && attMax.roll > 0.005,
  'pitch/roll actually move while driving',
  `maxPitch=${attMax.pitch.toFixed(4)} maxRoll=${attMax.roll.toFixed(4)}`);
ok(attMax.bump > 0 && attMax.bump < 0.06, 'rideBump active over kerbs and bounded',
  `maxBump=${attMax.bump.toFixed(4)}`);

// ============================================================
// 2. attitude is exactly zero at rest
// ============================================================
console.log('[env] 2. attitude at rest');
const rest = newCar(5);
const gs = circuit.gridSlots[0];
rest.placeAt(gs.pos, gs.heading, gs.idx);
for (let i = 0; i < 90; i++) rest.step(DT, { steer: 0, throttle: 0, brake: 0 });
ok(rest.pitch === 0 && rest.roll === 0 && rest.rideBump === 0,
  'pitch/roll/rideBump are exactly 0 standing still',
  `pitch=${rest.pitch} roll=${rest.roll} bump=${rest.rideBump}`);
// and they return to zero after being driven
let drivenPitch = 0, drivenRoll = 0;
for (let i = 0; i < 150; i++) {
  rest.step(DT, { steer: 0.3, throttle: 1, brake: 0 });
  drivenPitch = Math.max(drivenPitch, Math.abs(rest.pitch));
  drivenRoll = Math.max(drivenRoll, Math.abs(rest.roll));
}
for (let i = 0; i < 900; i++) rest.step(DT, { steer: 0, throttle: 0, brake: 1 });
ok(drivenPitch > 0 && drivenRoll > 0 && rest.pitch === 0 && rest.roll === 0,
  'attitude decays back to exactly 0 once stopped',
  `driven pitch=${drivenPitch.toFixed(4)} roll=${drivenRoll.toFixed(4)} -> ${rest.pitch}/${rest.roll}`);

// ============================================================
// 3. tyre temperature grip window + fresh-set out-lap temp
// ============================================================
console.log('[env] 3. tyre temperature grip window');
const gripCar = newCar(5);
rollingStart(gripCar);
ok(gripCar.tyreTemp === 65, 'a fresh set out of the pits starts at 65C', `${gripCar.tyreTemp}C`);
const muAt = (T) => { gripCar.tyreTemp = T; return gripCar.muEff(); };
const muWindow = muAt(100), muCold = muAt(60), muVeryHot = muAt(130), muEdgeHot = muAt(115);
ok(Math.abs(muCold / muWindow - 0.92) < 1e-6, 'stone-cold tyres (60C) lose 8% grip',
  `${((muCold / muWindow - 1) * 100).toFixed(2)}%`);
ok(Math.abs(muEdgeHot / muWindow - 0.95) < 1e-6 && Math.abs(muVeryHot / muWindow - 0.95) < 1e-6,
  'overheated tyres (>115C) lose 5% grip',
  `${((muVeryHot / muWindow - 1) * 100).toFixed(2)}%`);
ok(muAt(90) === muWindow && muAt(110) === muWindow, 'the 90-110C window is full grip');

// ============================================================
// 4. brake fade
// ============================================================
console.log('[env] 4. brake fade above threshold');
function brakeTest(brakeTemp) {
  const c = newCar(5);
  rollingStart(c);
  c.v = 70;
  c.brakeTemp = brakeTemp;
  let dv = 0;
  for (let i = 0; i < 6; i++) {
    const before = c.v;
    c.brakeTemp = brakeTemp;            // hold the disc temperature fixed
    c.step(DT, { steer: 0, throttle: 0, brake: 1 });
    dv += before - c.v;
  }
  return { dv, fade: c.brakeFade };
}
const cool = brakeTest(200), hot = brakeTest(1000);
ok(hot.fade > 0.11 && hot.fade <= 0.12, 'brakeFade saturates at 12%', `fade=${(hot.fade * 100).toFixed(1)}%`);
ok(cool.fade === 0, 'no fade with cool brakes', `fade=${cool.fade}`);
ok(hot.dv < cool.dv * 0.97, 'faded brakes decelerate measurably less',
  `cool dv=${cool.dv.toFixed(2)} hot dv=${hot.dv.toFixed(2)} (-${((1 - hot.dv / cool.dv) * 100).toFixed(1)}%)`);

// ============================================================
// 5. ERS modes change the battery trajectory in the expected direction
// ============================================================
console.log('[env] 5. ERS modes (0 harvest / 1 balanced / 2 attack)');
function ersRun(mode) {
  reseed();
  const c = newCar(5);
  rollingStart(c);
  c.battery = 0.05;                      // nearly empty: room to harvest and to drain
  const drv = new AIDriver(c, circuit, { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);
  let dist = 0;
  for (let i = 0; i < 30 * 22; i++) {    // 22s: reaches the first braking zone
    const inp = drv.update(DT, [c]);
    c.step(DT, { ...inp, boost: false, ersMode: mode });
    dist += Math.max(0, c.v) * DT;
  }
  return { battery: c.battery, mode: c.ersMode, dist };
}
const e0 = ersRun(0), e1 = ersRun(1), e2 = ersRun(2);
console.log(`  battery after 22s: harvest=${e0.battery.toFixed(3)} balanced=${e1.battery.toFixed(3)} attack=${e2.battery.toFixed(3)}`);
console.log(`  distance covered:  harvest=${e0.dist.toFixed(0)}m balanced=${e1.dist.toFixed(0)}m attack=${e2.dist.toFixed(0)}m`);
ok(e0.mode === 0 && e1.mode === 1 && e2.mode === 2, 'input.ersMode selects the mode');
ok(e0.battery < 1 && e1.battery < 1 && e2.battery > 0,
  'battery trajectories are unsaturated (comparison is meaningful)',
  `${e0.battery.toFixed(3)} / ${e1.battery.toFixed(3)} / ${e2.battery.toFixed(3)}`);
ok(e0.battery > e1.battery, 'harvest mode (0) ends with more energy than balanced',
  `${e0.battery.toFixed(3)} > ${e1.battery.toFixed(3)}`);
ok(e2.battery < e1.battery, 'attack mode (2) ends with less energy than balanced',
  `${e2.battery.toFixed(3)} < ${e1.battery.toFixed(3)}`);
const defaultCar = newCar(5);
ok(defaultCar.ersMode === 1, 'default ERS mode is 1 (balanced)');
rollingStart(defaultCar);
defaultCar.step(DT, { steer: 0, throttle: 1, brake: 0 });
ok(defaultCar.ersMode === 1 && defaultCar.ersDeploy === 0,
  'omitting input.ersMode leaves the mode alone and deploys nothing extra');

// ============================================================
// 6. surface feel: progressive off-track sink
// ============================================================
console.log('[env] 6. off-track progressive sink');
// find a long straight so the car stays off track while running in a line
let straightIdx = 0, best = -1;
for (let i = 0; i < circuit.N; i++) {
  let run = 0;
  for (let j = 0; j < 90; j++) {
    if (Math.abs(circuit.samples[(i + j) % circuit.N].curv) > 1 / 3000) break;
    run++;
  }
  if (run > best) { best = run; straightIdx = i; }
}
const offLat = circuit.halfWidth + 2.5;
ok(offLat < circuit.wallOff - 1.5, 'off-track test point is clear of the wall',
  `lat=${offLat.toFixed(1)} wallLimit=${(circuit.wallOff - 0.95).toFixed(1)}`);

function offTrackRun(seconds, startV = 30) {
  const c = newCar(5);
  const s = circuit.samples[straightIdx];
  const p = s.p.clone().addScaledVector(s.n, offLat);
  c.placeAt(p, Math.atan2(s.t.x, s.t.z), straightIdx);
  c.v = startV;
  c.tyreTemp = 100;
  let stayedOff = true;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    c.step(DT, { steer: 0, throttle: 0, brake: 0 });
    if (i > 1 && !c.offTrack) stayedOff = false;
  }
  return { car: c, stayedOff, lost: startV - c.v };
}
const off1 = offTrackRun(1), off3 = offTrackRun(3);
ok(off1.stayedOff && off3.stayedOff, 'car remained off track for the whole excursion');
ok(off3.lost > off1.lost, '3s continuous off-track loses more speed than 1s',
  `1s=-${off1.lost.toFixed(2)}m/s 3s=-${off3.lost.toFixed(2)}m/s`);
ok(off3.car.offTrackSink > 0.99 && off1.car.offTrackSink < 0.75,
  'sink saturates after ~2s off track',
  `1s sink=${off1.car.offTrackSink.toFixed(2)} 3s sink=${off3.car.offTrackSink.toFixed(2)}`);

// same-speed comparison: a fresh excursion vs one already dug in for 3s
const fresh = offTrackRun(1);
const soaked = offTrackRun(3);
soaked.car.v = fresh.car.v + fresh.lost;   // reset to the reference speed (30)
const refV = soaked.car.v;
for (let i = 0; i < 30; i++) soaked.car.step(DT, { steer: 0, throttle: 0, brake: 0 });
const soakedLoss = refV - soaked.car.v;
ok(soakedLoss > fresh.lost * 1.05,
  'at equal speed, a dug-in car drags harder than a fresh excursion',
  `fresh=-${fresh.lost.toFixed(2)}m/s soaked=-${soakedLoss.toFixed(2)}m/s`);

// back on track the sink resets
const backOn = newCar(5);
const sOn = circuit.samples[straightIdx];
backOn.placeAt(sOn.p.clone().addScaledVector(sOn.n, offLat), Math.atan2(sOn.t.x, sOn.t.z), straightIdx);
backOn.v = 25;
for (let i = 0; i < 75; i++) backOn.step(DT, { steer: 0, throttle: 0, brake: 0 });
const sinkOff = backOn.offTrackSink;
backOn.pos.copy(sOn.p);
backOn.step(DT, { steer: 0, throttle: 0, brake: 0 });
ok(sinkOff > 0.9 && backOn.offTrackTime === 0 && backOn.offTrackSink === 0,
  'sink resets the moment the car is back on track', `was ${sinkOff.toFixed(2)}`);

// ============================================================
// 7. kerb rumble scrubs speed under high lateral load
// ============================================================
console.log('[env] 7. kerb rumble scrub');
reseed();
const kerbCar = newCar(5);
rollingStart(kerbCar);
const kerbAI = new AIDriver(kerbCar, circuit, { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);
let kerbFrames = 0, scrubFrames = 0, scrubMax = 0;
for (let i = 0; i < 30 * 120; i++) {
  const inp = kerbAI.update(DT, [kerbCar]);
  kerbCar.step(DT, inp);
  if (kerbCar.onKerb) kerbFrames++;
  if (kerbCar.kerbScrub > 0) { scrubFrames++; scrubMax = Math.max(scrubMax, kerbCar.kerbScrub); }
}
ok(kerbFrames > 0 && scrubFrames > 0 && scrubMax <= 1,
  'kerb rumble scrub engages under high lateral load',
  `kerbFrames=${kerbFrames} scrubFrames=${scrubFrames} maxScrub=${scrubMax.toFixed(2)}`);

// ============================================================
// 8. dirty air trims front-end bite (understeer), not just mu
// ============================================================
console.log('[env] 8. dirty-air understeer');
function yawRun(dirty) {
  const c = newCar(5);
  const s = circuit.samples[straightIdx];
  c.placeAt(s.p.clone(), Math.atan2(s.t.x, s.t.z), straightIdx);
  c.v = 18;
  c.tyreTemp = 100;
  c.dirtyAir = dirty;
  let slipped = false, h0 = null;
  for (let i = 0; i < 10; i++) {
    c.dirtyAir = dirty;
    c.step(DT, { steer: 0.5, throttle: 0.2, brake: 0 });
    if (i === 0) h0 = c.heading;
    if (c.slip) slipped = true;
  }
  return { yaw: Math.abs(c.heading - h0), slipped, loss: c.frontAeroLoss };
}
const clean = yawRun(0), dirty = yawRun(0.8);
ok(!clean.slipped && !dirty.slipped, 'yaw comparison is grip-limited-free (kinematic)');
ok(clean.loss === 0 && dirty.loss > 0.05 && dirty.loss <= 0.06,
  'frontAeroLoss ~6% only when dirtyAir>0.3 in a corner',
  `clean=${clean.loss} dirty=${dirty.loss.toFixed(4)}`);
ok(dirty.yaw < clean.yaw, 'dirty air turns the car in less for the same steering',
  `clean=${clean.yaw.toFixed(5)}rad dirty=${dirty.yaw.toFixed(5)}rad (-${((1 - dirty.yaw / clean.yaw) * 100).toFixed(1)}%)`);
const straightDirty = newCar(5);
rollingStart(straightDirty);
straightDirty.dirtyAir = 0.9;
straightDirty.step(DT, { steer: 0, throttle: 1, brake: 0 });
ok(straightDirty.frontAeroLoss === 0, 'no front-loss penalty running straight in dirty air');

// ============================================================
// 9. out-lap realism: a fresh set fitted mid-run is cold, then comes back in
// ============================================================
console.log('[env] 9. pit out-lap warm-up cycle');
reseed();
const pitCar = newCar(5);
rollingStart(pitCar);
const pitAI = new AIDriver(pitCar, circuit, { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);
for (let i = 0; i < 30 * 120; i++) pitCar.step(DT, pitAI.update(DT, [pitCar]));   // get it up to temp
const hotTemp = pitCar.tyreTemp;
pitCar.setTyre('M');                                                             // fresh set fitted
const freshTemp = pitCar.tyreTemp;
pitCar.step(DT, pitAI.update(DT, [pitCar]));
const coldGrip = pitCar.tyreGrip;
let backInBand = null;
for (let i = 0; i < 30 * 90; i++) {
  pitCar.step(DT, pitAI.update(DT, [pitCar]));
  if (backInBand === null && pitCar.tyreTemp >= 90) backInBand = i * DT;
}
ok(hotTemp >= 90 && freshTemp === 65 && coldGrip < 1,
  'fresh set drops to 65C and runs with reduced grip on the out-lap',
  `hot=${hotTemp.toFixed(0)}C fresh=${freshTemp}C coldGrip=${coldGrip.toFixed(3)}`);
ok(backInBand !== null && backInBand < 90,
  'fresh set is back in the working band inside one lap',
  `${backInBand === null ? 'never' : backInBand.toFixed(1) + 's'}`);

// ============================================================
console.log(failures
  ? `[env] FAILED (${failures} assertion${failures === 1 ? '' : 's'})`
  : '[env] ALL ASSERTIONS PASSED');
process.exitCode = failures ? 1 : 0;
