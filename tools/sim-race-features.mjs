// Headless feature simulation for the race-direction layer: sector timing,
// tyre age, virtual safety car, track limits, blue flags, front wing damage,
// engineer radio and penalty-aware classification.
//
// Runs a 12-lap Monza race at dt=1/30 plus a set of forced scenarios that put
// each mechanic into the state it is supposed to react to.
// Usage: node tools/sim-race-features.mjs

// Race incidents deliberately use randomness in the game. Pin the headless
// harness so CI exercises the same incident sequence on every run.
let randomState = 0x5eed2026;
Math.random = () => {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- minimal DOM stubs (canvas textures) ----
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '',
  fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {},
  fillText() {}, strokeText() {}, createLinearGradient: () => ({ addColorStop() {} }),
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

const THREE = await import('../lib/three.module.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession, fmtTime } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');
const { createRandom } = await import('../js/random.js');

// Use the first driver in the original APEX grid as the headless player.
const PLAYER_ID = DRIVERS[0].id;
const DT = 1 / 30;
const TRACK = 'monza';
const LAPS = 12;

// ---- assertion plumbing ----
let checks = 0;
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
const ok = (cond, m) => { checks++; if (!cond) fail(m); };

const scene = new THREE.Scene();
const circuit = buildCircuit(TRACK, TRACKS[TRACK], scene);
console.log(`[feat] ${TRACK}: length=${Math.round(circuit.length)}m N=${circuit.N} halfWidth=${circuit.halfWidth.toFixed(1)} wallOff=${circuit.wallOff.toFixed(1)}`);

// ---- helpers ----
function newSession(opts = {}) {
  const msgs = [];
  const random = opts.seed == null ? undefined : createRandom(opts.seed);
  const session = new RaceSession({
    scene, circuit,
    playerDriverId: PLAYER_ID,
    laps: opts.laps ?? LAPS,
    difficulty: 1,
    assists: { tc: true, abs: true, autoGear: true },
    mode: 'race', gridOrder: null,
    random, seed: opts.seed,
    onMessage: (t, c) => msgs.push({ text: t, color: c }),
  });
  const autopilot = new AIDriver(session.player.phys, circuit,
    { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1, random);
  return { session, autopilot, msgs };
}

/** One simulation frame, player driven by its autopilot. */
function frame(ctx, override) {
  const { session, autopilot } = ctx;
  const input = session.phase === 'racing' && !session.player.finished
    ? autopilot.update(DT, session.entries.map(e => e.phys))
    : { steer: 0, throttle: 0, brake: 0 };
  session.update(DT, override ? Object.assign({}, input, override) : input);
}

/** Run frames until `pred()` or the time budget runs out. Returns true if met. */
function runUntil(ctx, pred, budget, onFrame) {
  let t = 0;
  while (t < budget) {
    if (onFrame) onFrame(t);
    frame(ctx);
    t += DT;
    if (pred()) return true;
  }
  return false;
}

function placeAtIdx(phys, idx, latOff = 0, v = 70) {
  const s = circuit.samples[((idx % circuit.N) + circuit.N) % circuit.N];
  phys.placeAt(s.p.clone().addScaledVector(s.n, latOff), Math.atan2(s.t.x, s.t.z), s === undefined ? 0 : ((idx % circuit.N) + circuit.N) % circuit.N);
  phys.v = v;
  phys.gear = 6;
}

const liveAI = (s) => s.entries.filter(e => e.ai && !e.dnf && !e.pitState && !e.phys.disabled && !e.finished);
const meanSpeed = (list) => list.reduce((a, e) => a + e.phys.v, 0) / Math.max(1, list.length);

// =====================================================================
// S1 — main 12-lap race: sectors, tyre age, radio, classification
// =====================================================================
console.log('\n[S1] 12-lap race — sector timing, tyre age, engineer radio, classification');
{
  const ctx = newSession();
  const { session } = ctx;
  const p = session.player;

  const radio = [];                    // drained HUD-style, by shifting
  const lastSectorsByLap = [];         // every completed lap's lastSectors
  let sawLiveS1 = false, sawLiveS2 = false, maxLiveNonNull = 0;
  let ageBeforePit = 0, ageAfterPit = null, ageRegrown = 0;
  let boxed = false, pitSeen = false, pitDone = false;
  let seenLap = p.lap;

  let t = 0;
  const budget = LAPS * circuit.idealLap * 3 + 400;
  while (!session.results && t < budget) {
    frame(ctx);
    t += DT;
    while (session.radioQueue.length) radio.push(session.radioQueue.shift());

    // live sector progression within the current lap
    const nn = p.sectors.filter(x => x != null).length;
    if (nn > maxLiveNonNull) maxLiveNonNull = nn;
    if (p.sectors[0] != null && p.sectors[1] == null) sawLiveS1 = true;
    if (p.sectors[1] != null && p.sectors[2] == null) sawLiveS2 = true;

    if (p.lap !== seenLap) {
      seenLap = p.lap;
      if (p.lap >= 1) lastSectorsByLap.push([...p.lastSectors]);
      if (!pitDone) ageBeforePit = Math.max(ageBeforePit, p.tyreAgeLaps);
      else ageRegrown = Math.max(ageRegrown, p.tyreAgeLaps);
    }
    // pit once, on lap 4, to exercise the tyre-age reset
    if (!boxed && p.lap === 4) { session.playerRequestBox(); boxed = true; }
    if (p.pitState) {
      pitSeen = true;
      if (!p.pitState.chosen) session.playerChooseTyre('H');
    } else if (pitSeen && !pitDone) {
      pitDone = true;
      ageAfterPit = p.tyreAgeLaps;
    }
  }

  ok(!!session.results, `S1 race did not classify within budget (t=${Math.round(t)}s)`);
  console.log(`  laps recorded=${lastSectorsByLap.length} liveMaxNonNull=${maxLiveNonNull} sawS1=${sawLiveS1} sawS2=${sawLiveS2}`);

  // --- sectors ---
  ok(sawLiveS1, 'S1 live sectors[0] never populated on its own mid-lap');
  ok(sawLiveS2, 'S1 live sectors[1] never populated mid-lap');
  ok(lastSectorsByLap.length >= 3, `S1 expected >=3 completed laps of sector data, got ${lastSectorsByLap.length}`);
  const fullLaps = lastSectorsByLap.filter(s => s.every(x => x != null && x > 0));
  ok(fullLaps.length >= 3, `S1 expected >=3 laps with all 3 sectors non-null, got ${fullLaps.length}`);
  console.log(`  lastSectors sample=[${fullLaps[0].map(x => x.toFixed(3)).join(', ')}]  bestSectors=[${p.bestSectors.map(x => x == null ? 'null' : x.toFixed(3)).join(', ')}]`);
  ok(p.bestSectors.every(x => x != null && x > 0), `S1 bestSectors incomplete: ${JSON.stringify(p.bestSectors)}`);
  // bestSectors must be the running minimum of every lastSectors seen
  for (let i = 0; i < 3; i++) {
    const seen = lastSectorsByLap.map(s => s[i]).filter(x => x != null && x > 0);
    const min = Math.min(...seen);
    ok(Math.abs(p.bestSectors[i] - min) < 1e-9,
      `S1 bestSectors[${i}]=${p.bestSectors[i]} is not the minimum of observed sectors (${min})`);
  }
  // a lap's three sectors must reconstruct that lap time
  const li = lastSectorsByLap.findIndex(s => s.every(x => x != null));
  if (li >= 0) {
    const sum = lastSectorsByLap[li].reduce((a, b) => a + b, 0);
    const lapT = p.lapTimes[li];
    ok(lapT != null && Math.abs(sum - lapT) < 0.05,
      `S1 sectors sum ${sum?.toFixed(3)} != lap time ${lapT?.toFixed(3)}`);
  }

  // --- tyre age ---
  console.log(`  tyreAge beforePit=${ageBeforePit} afterPit=${ageAfterPit} regrown=${ageRegrown} pits=${p.pitStops}`);
  ok(pitSeen, 'S1 player pit stop never executed');
  ok(ageBeforePit >= 3, `S1 tyreAgeLaps should climb before the stop, got ${ageBeforePit}`);
  ok(ageAfterPit === 0, `S1 tyreAgeLaps should reset to 0 on the stop, got ${ageAfterPit}`);
  ok(ageRegrown >= 1, `S1 tyreAgeLaps should climb again after the stop, got ${ageRegrown}`);

  // --- engineer radio: at least 3 distinct kinds of message ---
  const kindOf = (m) => {
    const s = m.text.toUpperCase();
    if (s.includes('TRACK LIMITS')) return 'trackLimits';
    if (s.includes('WING')) return 'wing';
    if (s.includes('VSC') || s.includes('SAFETY CAR') || s.includes('GREEN FLAG')) return 'vsc';
    if (s.includes('BLUE FLAG')) return 'blue';
    if (s.includes('TYRES ARE DONE')) return 'tyres';
    if (s.startsWith('GAP TO')) return 'gap';
    if (s.includes('LAST LAP')) return 'lastLap';
    if (/^P\d+ —/.test(m.text)) return 'posGain';
    if (/^P\d+\./.test(m.text)) return 'result';
    return 'other';
  };
  const kinds = new Set(radio.map(kindOf));
  const tones = new Set(radio.map(m => m.tone));
  console.log(`  radio n=${radio.length} kinds=[${[...kinds].join(',')}] tones=[${[...tones].join(',')}]`);
  ok(radio.length >= 3, `S1 expected >=3 radio messages, got ${radio.length}`);
  ok(kinds.size >= 3, `S1 expected >=3 distinct radio message types, got ${kinds.size}: ${[...kinds]}`);
  ok(radio.every(m => m && typeof m.text === 'string' && typeof m.tone === 'string'),
    'S1 radio entries must be {text, tone}');
  ok(radio.every(m => ['info', 'warning', 'celebration'].includes(m.tone)),
    `S1 unexpected radio tone in ${[...tones]}`);
  ok(session.radioQueue.length === 0, 'S1 radioQueue should be drainable by shifting');
  ok(kinds.has('result'), 'S1 expected a post-flag result radio message');

  // --- classification ---
  const r = session.results;
  console.log(`  classified rows=${r.length} winner=${r[0].driver.code} ${r[0].gapText}`);
  ok(r.length === 22, `S1 expected 22 classified rows, got ${r.length}`);
  ok(new Set(r.map(x => x.pos)).size === r.length, 'S1 duplicate positions in classification');
  ok(r.every(x => typeof x.penaltySeconds === 'number'), 'S1 results rows must carry penaltySeconds');

  // --- positionsGained ---
  ok(session.entries.every(e => e.positionsGained === e.gridPos - e.position),
    'S1 positionsGained must equal gridPos - position');
  ok(session.entries.some(e => e.positionsGained !== 0), 'S1 nobody changed position all race');
}

// =====================================================================
// S2 — virtual safety car
// =====================================================================
console.log('\n[S2] virtual safety car — deploy, neutralise the field, end and clear');
{
  const ctx = newSession();
  const { session, msgs } = ctx;

  // get racing, a couple of laps in so ">2 laps to go" holds comfortably
  ok(runUntil(ctx, () => session.phase === 'racing', 60), 'S2 race never went green');
  runUntil(ctx, () => session.entries.some(e => e.lap >= 1), 200);

  const speedBefore = meanSpeed(liveAI(session));

  // force retirements until one of them brings out the VSC (bounded attempts)
  let attempts = 0;
  const victims = session.entries.filter(e => e.ai && !e.dnf);
  while (!session.vsc.active && attempts < 20 && attempts < victims.length) {
    session._retire(victims[attempts]);
    attempts++;
    frame(ctx);
  }
  console.log(`  retirements needed=${attempts} vscActive=${session.vsc.active} timeLeft=${session.vsc.timeLeft.toFixed(1)}`);
  ok(session.vsc.active, `S2 VSC never deployed after ${attempts} forced retirements`);
  ok(session.vsc.timeLeft >= 18 && session.vsc.timeLeft <= 30,
    `S2 VSC window should be 18-30s, got ${session.vsc.timeLeft.toFixed(1)}`);
  ok(msgs.some(m => m.text === 'VIRTUAL SAFETY CAR' && m.color === 'yellow'),
    'S2 missing yellow VIRTUAL SAFETY CAR message');

  // every live AI must be neutralised and told to hold position
  const neutralised = liveAI(session);
  ok(neutralised.length > 0, 'S2 no live AI left to neutralise');
  ok(neutralised.every(e => e.ai.vscFactor === 0.6), 'S2 AI vscFactor should be 0.6 under the VSC');
  ok(neutralised.every(e => e.ai.noOvertake === true), 'S2 AI should hold position under the VSC');

  // let the field slow to the delta
  let t = 0;
  while (t < 7 && session.vsc.active) { frame(ctx); t += DT; }
  const speedDuring = meanSpeed(liveAI(session));
  console.log(`  mean AI speed before=${speedBefore.toFixed(1)} during=${speedDuring.toFixed(1)} m/s`);
  ok(speedDuring < speedBefore * 0.8,
    `S2 AI speeds should drop sharply under the VSC (${speedBefore.toFixed(1)} -> ${speedDuring.toFixed(1)})`);

  // ride it out: warning at 3s, then green
  ok(runUntil(ctx, () => !session.vsc.active, 60), 'S2 VSC never ended');
  ok(session.vsc.active === false && session.vsc.timeLeft === 0,
    `S2 VSC state not cleared: ${JSON.stringify(session.vsc)}`);
  ok(msgs.some(m => m.text === 'VSC ENDING'), 'S2 missing VSC ENDING message');
  ok(msgs.some(m => m.text === 'GREEN FLAG — RACE RESUMES' && m.color === 'green'),
    'S2 missing green GREEN FLAG — RACE RESUMES message');
  const resumed = liveAI(session);
  ok(resumed.every(e => e.ai.vscFactor === 1 && e.ai.noOvertake === false),
    'S2 AI not released back to green-flag running');

  // speeds recover once released — average over a 10s window so the pack
  // being mid-corner at any single instant can't alias the measurement
  let t2 = 0, accum = 0, n2 = 0;
  while (t2 < 14) {
    frame(ctx); t2 += DT;
    if (t2 > 4) { accum += meanSpeed(liveAI(session)); n2++; }
  }
  const after = accum / Math.max(1, n2);
  console.log(`  mean AI speed after green=${after.toFixed(1)} m/s (10s window)`);
  ok(after > speedDuring * 1.15, `S2 AI should speed back up after the green flag (${after.toFixed(1)})`);
}

// =====================================================================
// S3 — track limits: warnings then a time penalty that reaches the results
// =====================================================================
console.log('\n[S3] track limits — 3 warnings, then +5s penalties');
{
  const ctx = newSession();
  const { session } = ctx;
  const p = session.player;
  const radio = [];

  // sit the car in the run-off: past the off-track threshold, clear of the wall
  const off = circuit.halfWidth + 0.9;
  ok(off < circuit.wallOff - 1.2,
    `S3 run-off too narrow to test without hitting the wall (off=${off.toFixed(1)} wallOff=${circuit.wallOff.toFixed(1)})`);

  ok(runUntil(ctx, () => session.phase === 'racing', 60), 'S3 race never went green');

  const holdOff = () => {
    const s = circuit.samples[p.phys.sampleIdx];
    p.phys.pos.copy(s.p).addScaledVector(s.n, off);
    p.phys.heading = Math.atan2(s.t.x, s.t.z);
    p.phys.v = Math.max(p.phys.v, 48);
  };

  // five excursions: each >0.4s off, separated by a clean stint back on track
  for (let cycle = 0; cycle < 5; cycle++) {
    let t = 0;
    while (t < 1.1) { holdOff(); frame(ctx); t += DT; while (session.radioQueue.length) radio.push(session.radioQueue.shift()); }
    let t2 = 0;
    while (t2 < 0.9) {   // back on the racing line so the excursion latch resets
      const s = circuit.samples[p.phys.sampleIdx];
      p.phys.pos.copy(s.p);
      p.phys.heading = Math.atan2(s.t.x, s.t.z);
      p.phys.v = Math.max(p.phys.v, 48);
      frame(ctx); t2 += DT;
      while (session.radioQueue.length) radio.push(session.radioQueue.shift());
    }
  }

  const texts = radio.map(m => m.text);
  console.log(`  violations=${p.trackLimits} penaltySeconds=${p.penaltySeconds}`);
  console.log(`  radio=${JSON.stringify(texts.filter(x => x.includes('TRACK LIMITS')))}`);
  ok(p.trackLimits >= 4, `S3 expected >=4 track-limit violations, got ${p.trackLimits}`);
  ok(texts.includes('TRACK LIMITS — WARNING 1/3'), 'S3 missing warning 1/3');
  ok(texts.includes('TRACK LIMITS — WARNING 2/3'), 'S3 missing warning 2/3');
  ok(texts.includes('TRACK LIMITS — WARNING 3/3'), 'S3 missing warning 3/3');
  ok(texts.includes('TRACK LIMITS — +5s PENALTY'), 'S3 missing +5s penalty radio call');
  // no other penalty source may have contaminated the total
  ok(!session.jumpStart, 'S3 unexpected jump start polluted the penalty total');
  ok(!session.vsc.active, 'S3 unexpected VSC polluted the penalty total');
  ok(p.penaltySeconds === 5 * (p.trackLimits - 3),
    `S3 penalty should be 5s per violation past 3: limits=${p.trackLimits} pen=${p.penaltySeconds}`);
  // legacy alias must still track the player's total
  ok(session.playerPenalty === p.penaltySeconds,
    `S3 playerPenalty alias out of sync (${session.playerPenalty} vs ${p.penaltySeconds})`);

  // an AI going off is scrubbed, never given a time penalty
  const aiOff = session.entries.filter(e => e.ai && e.trackLimits > 0);
  ok(aiOff.every(e => e.penaltySeconds === 0),
    'S3 AI should take a pace scrub, not a time penalty, for track limits');

  // the penalty has to survive into the classification
  const carried = p.penaltySeconds;
  let t = 0;
  const budget = LAPS * circuit.idealLap * 3 + 400;
  while (!session.results && t < budget) { frame(ctx); t += DT; }
  ok(!!session.results, 'S3 race did not classify');
  if (session.results) {
    const row = session.results.find(x => x.isPlayer);
    console.log(`  results: player P${row.pos} penaltySeconds=${row.penaltySeconds} rows=${session.results.length}`);
    ok(session.results.length === 22, `S3 expected 22 rows, got ${session.results.length}`);
    ok(row.penaltySeconds >= carried,
      `S3 player penalty missing from results (${row.penaltySeconds} < ${carried})`);
  }
}

// =====================================================================
// S4 — blue flags
// =====================================================================
console.log('\n[S4] blue flags — backmarker yields, player is told');
{
  // --- 4a: an AI backmarker must physically yield ---
  const ctx = newSession();
  const { session } = ctx;
  ok(runUntil(ctx, () => session.phase === 'racing', 60), 'S4 race never went green');

  const ais = session.entries.filter(e => e.ai && !e.dnf);
  const back = ais[ais.length - 1];      // the car being lapped
  const lapper = ais[0];                 // the car doing the lapping
  // park them nose-to-tail on track and make the lapper a full lap up
  const idx = Math.round(circuit.N * 0.5);
  placeAtIdx(back.phys, idx, 0, 72);
  placeAtIdx(lapper.phys, idx - Math.round(45 / circuit.ds), 0, 82);
  back.lap = 2;
  lapper.lap = 3;
  back.ai.yieldOffset = 0;
  back.ai.yieldT = 0;

  frame(ctx);
  console.log(`  backmarker=${back.driver.code} yieldOffset=${back.ai.yieldOffset.toFixed(2)} yieldT=${back.ai.yieldT.toFixed(2)} blueFlagFor=${session.blueFlagFor}`);
  ok(back.ai.yieldT > 0, 'S4 lapped AI was not put under blue flags');
  ok(Math.abs(back.ai.yieldOffset) > 2, `S4 yieldOffset should move ~2.5m off line, got ${back.ai.yieldOffset}`);
  ok(Math.abs(Math.abs(back.ai.yieldOffset) - 2.5) < 1e-9,
    `S4 yieldOffset magnitude should be 2.5m, got ${Math.abs(back.ai.yieldOffset)}`);

  // yielding costs a little pace and expires
  const yieldStart = back.ai.yieldT;
  ok(yieldStart <= 4 + 1e-9, `S4 yield window should be 4s, got ${yieldStart}`);
  // pull the lapper away so the flag drops, then let the timer run out
  placeAtIdx(lapper.phys, idx + Math.round(600 / circuit.ds), 0, 82);
  lapper.lap = 3;
  let t = 0;
  while (t < 5.5 && back.ai.yieldT > 0) { frame(ctx); t += DT; }
  ok(back.ai.yieldT === 0, `S4 yield never expired (${back.ai.yieldT})`);
  ok(back.ai.yieldOffset === 0, `S4 yieldOffset not cleared (${back.ai.yieldOffset})`);

  // --- 4b: the player gets the flag and the message ---
  const ctx2 = newSession();
  const s2 = ctx2.session;
  ok(runUntil(ctx2, () => s2.phase === 'racing', 60), 'S4b race never went green');
  const pl = s2.player;
  const l2 = s2.entries.find(e => e.ai && !e.dnf);
  const idx2 = Math.round(circuit.N * 0.4);
  placeAtIdx(pl.phys, idx2, 0, 70);
  placeAtIdx(l2.phys, idx2 - Math.round(40 / circuit.ds), 0, 85);
  pl.lap = 1;
  l2.lap = 2;
  frame(ctx2);
  console.log(`  player blueFlagFor=${s2.blueFlagFor} msg=${ctx2.msgs.some(m => m.text === 'BLUE FLAGS — LET THE LEADER THROUGH')}`);
  ok(s2.blueFlagFor === pl.driver.id,
    `S4b blueFlagFor should be the player's driverId, got ${s2.blueFlagFor}`);
  ok(ctx2.msgs.some(m => m.text === 'BLUE FLAGS — LET THE LEADER THROUGH'),
    'S4b missing BLUE FLAGS message for the player');
  // once per encounter, not once per frame
  frame(ctx2); frame(ctx2); frame(ctx2);
  const n = ctx2.msgs.filter(m => m.text === 'BLUE FLAGS — LET THE LEADER THROUGH').length;
  ok(n === 1, `S4b blue-flag message should fire once per encounter, fired ${n}x`);
  // and it clears when nobody is lapping the player
  placeAtIdx(l2.phys, idx2 + Math.round(900 / circuit.ds), 0, 85);
  l2.lap = 2;
  frame(ctx2);
  ok(s2.blueFlagFor === null, `S4b blueFlagFor should clear, got ${s2.blueFlagFor}`);
}

// =====================================================================
// S5 — front wing damage
// =====================================================================
console.log('\n[S5] front wing damage — forced contact, aero loss, repaired in the pits');
{
  const ctx = newSession();
  const { session } = ctx;
  ok(runUntil(ctx, () => session.phase === 'racing', 60), 'S5 race never went green');

  const ais = session.entries.filter(e => e.ai && !e.dnf && !e.pitState);
  const A = ais[0], B = ais[1];
  // A piles into the back of B: same heading, big speed delta, noses/tails
  // initially just 0.1m inside the oriented 5m body envelope.
  const idx = Math.round(circuit.N * 0.25);
  placeAtIdx(B.phys, idx, 0, 40);
  placeAtIdx(A.phys, idx - Math.round(4.9 / circuit.ds), 0, 95);
  A.phys.pos.copy(B.phys.pos).addScaledVector(circuit.samples[idx].t, -4.9);
  A.wingDamage = 0; B.wingDamage = 0;
  A._wallDamageCool = 0; B._wallDamageCool = 0;
  A._carDamageCool = 0; B._carDamageCool = 0;
  session._activeContacts.clear();
  session._impactingContacts.clear();

  // force the 25% roll to land so the contact is deterministic
  const rnd = Math.random;
  Math.random = () => 0.1;
  frame(ctx);
  Math.random = rnd;

  console.log(`  A=${A.driver.code} wing=${A.wingDamage}  B=${B.driver.code} wing=${B.wingDamage}`);
  ok(A.wingDamage === 0.15,
    'S5 nose-first striker should receive the forced front-wing damage');
  ok(B.wingDamage === 0,
    'S5 rear-ended car must not receive fictitious front-wing damage');
  const dmg = A;

  // the damage has to show up as an aero (downforce) loss every frame
  frame(ctx);
  console.log(`  ${dmg.driver.code} dirtyAir floor=${dmg.phys.dirtyAir.toFixed(2)}`);
  ok(dmg.phys.dirtyAir >= 0.6,
    `S5 damaged car should carry a dirtyAir floor of 0.6, got ${dmg.phys.dirtyAir}`);
  ok(!dmg.isPlayer ? dmg.boxThisLap === true : true,
    'S5 damaged AI should be told to box next lap');

  // a wing change costs exactly 3s more stationary time
  const clean = ais.find(e => e !== dmg && e.wingDamage === 0 && !e.pitState && !e.finished);
  ok(!!clean, 'S5 needed an undamaged car to compare pit times against');
  if (clean) {
    const rnd2 = Math.random;
    Math.random = () => 0.5;          // identical random component for both stops
    session._enterPit(dmg);
    session._enterPit(clean);
    Math.random = rnd2;
    const delta = dmg.pitState.timer - clean.pitState.timer;
    console.log(`  pit timer: damaged=${dmg.pitState.timer.toFixed(2)}s clean=${clean.pitState.timer.toFixed(2)}s delta=${delta.toFixed(3)}s`);
    ok(dmg.pitState.wing === true, 'S5 pit stop should be flagged as a wing change');
    ok(Math.abs(delta - 3) < 1e-9, `S5 wing change should add exactly 3s, added ${delta}`);
  }

  // ride out the stop: the new nose clears the damage and the aero floor
  dmg.tyreAgeLaps = 7;
  ok(runUntil(ctx, () => dmg.pitState === null, 120), 'S5 pit stop never completed');
  console.log(`  after stop: wing=${dmg.wingDamage} tyreAgeLaps=${dmg.tyreAgeLaps}`);
  ok(dmg.wingDamage === 0, `S5 wing damage should be repaired in the pits, got ${dmg.wingDamage}`);
  ok(dmg.tyreAgeLaps === 0, `S5 tyreAgeLaps should reset on the stop, got ${dmg.tyreAgeLaps}`);
}

// =====================================================================
// S6 — time penalties are served at classification
// =====================================================================
console.log('\n[S6] classification — time penalties applied and able to reorder');
{
  // 6a: exact, deterministic check of the penalty arithmetic. A synthetic full
  // classification (every car home, 2s apart) is the only way to pin the
  // ordering down — in a live race the field may not all have finished, and
  // finishers always rank above non-finishers regardless of any penalty.
  const { session } = newSession({ laps: 2 });
  session.entries.forEach((e, i) => {
    e.finished = true;
    e.dnf = false;
    e.lap = 2;
    e.finishTime = 1000 + i * 2;     // 1000, 1002, ... 1042
    e.bestLap = 85 + i * 0.01;
    e.penaltySeconds = 0;
  });
  const victim = session.entries[0];  // on-road winner at 1000
  victim.penaltySeconds = 11;         // -> 1011, i.e. between 1010 and 1012
  session._classify();

  const r = session.results;
  const row = r.find(x => x.driver.id === victim.driver.id);
  console.log(`  synthetic: ${victim.driver.code} 1000s +11s -> P${row.pos} ${row.gapText}; winner=${r[0].driver.code} ${r[0].gapText}`);
  ok(r.length === 22, `S6 expected 22 rows, got ${r.length}`);
  ok(row.penaltySeconds === 11, `S6 penalty missing from results row (${row.penaltySeconds})`);
  ok(row.pos === 6, `S6 a +11s penalty should drop 1000s from P1 to P6, got P${row.pos}`);
  ok(r[0].driver.id === session.entries[1].driver.id,
    `S6 the 1002s car should inherit the win, got ${r[0].driver.code}`);
  ok(r[0].gapText === fmtTime(1002), `S6 winner time should be its own unpenalised 1002s, got ${r[0].gapText}`);
  ok(row.gapText === '+' + fmtTime(9), `S6 penalised gap should be 1011-1002=9s, got ${row.gapText}`);
  // whole field must be ordered by finishTime + penaltySeconds
  const byId = new Map(session.entries.map(e => [e.driver.id, e]));
  const ft = e => e.finishTime + (e.penaltySeconds || 0);
  for (let i = 1; i < r.length; i++) {
    const a = byId.get(r[i - 1].driver.id), b = byId.get(r[i].driver.id);
    ok(ft(a) <= ft(b) + 1e-9,
      `S6 classification not ordered by penalised time at P${r[i].pos} (${ft(a).toFixed(3)} > ${ft(b).toFixed(3)})`);
  }
  ok(r[0].points === 25, `S6 winner should score 25, got ${r[0].points}`);

  // 6b: a real race still classifies a full grid, penalties and all
  // Give this acceptance race its own stream. Its outcome must not depend on
  // how many random draws the unrelated S1-S5 scenarios happened to consume.
  const ctx2 = newSession({ laps: 2, seed: 0x5eed2026 });
  const s2 = ctx2.session;
  let t = 0, raceTicks = 0, contactTicks = 0, pairTicks = 0, maxPairs = 0;
  while (!s2.results && t < 2 * circuit.idealLap * 4 + 300) {
    frame(ctx2);
    t += DT;
    if ((s2.phase === 'racing' || s2.phase === 'finished') && !s2.results) {
      const pairs = s2._activeContacts.size;
      raceTicks++;
      pairTicks += pairs;
      if (pairs > 0) contactTicks++;
      maxPairs = Math.max(maxPairs, pairs);
    }
  }
  ok(!!s2.results, 'S6b race did not classify');
  if (s2.results) {
    const byId2 = new Map(s2.entries.map(e => [e.driver.id, e]));
    const finRows = s2.results.filter(x => byId2.get(x.driver.id).finished);
    const survivingRows = s2.results.filter(x => !x.dnf);
    const contactDuty = raceTicks ? contactTicks / raceTicks : 1;
    const avgPairs = raceTicks ? pairTicks / raceTicks : Infinity;
    const recoveries = ctx2.msgs.filter(message =>
      message.text.includes('BEACHED') || message.text.includes('RECOVERED TO THE TRACK')).length;
    console.log(`  live 2-lap race: rows=${s2.results.length} finishers=${finRows.length} winner=${s2.results[0].driver.code} ${s2.results[0].gapText}`);
    console.log(`  contact telemetry: duty=${(contactDuty * 100).toFixed(1)}% pairTicks=${pairTicks} avgPairs=${avgPairs.toFixed(3)} maxPairs=${maxPairs} recoveries=${recoveries}`);
    ok(s2.results.length === 22, `S6b expected 22 rows, got ${s2.results.length}`);
    // The player receives results after a short 2.5s grace. With the corrected
    // 168m-long FIA grid, healthy cars farther back are legitimately classified
    // as running rather than `finished`; attrition is measured by DNF/recovery.
    ok(survivingRows.length >= 20,
      `S6b realistic contact should leave at least 20 non-DNF cars, got ${survivingRows.length}`);
    ok(contactDuty <= 0.32,
      `S6b contact duty should stay at or below 32%, got ${(contactDuty * 100).toFixed(1)}%`);
    ok(avgPairs <= 0.5,
      `S6b average simultaneous contact pairs should stay at or below 0.5, got ${avgPairs.toFixed(3)}`);
    ok(maxPairs <= 8,
      `S6b contact solver should avoid grid-wide pileups, max pairs was ${maxPairs}`);
    ok(recoveries <= 2,
      `S6b should need at most two marshal recoveries, got ${recoveries}`);
    for (let i = 1; i < finRows.length; i++) {
      const a = byId2.get(finRows[i - 1].driver.id), b = byId2.get(finRows[i].driver.id);
      ok(ft(a) <= ft(b) + 1e-9,
        `S6b finishers not ordered by penalised time at P${finRows[i].pos}`);
    }
    ok(s2.results[0].gapText.includes(':'), `S6b winner gap should be a time, got ${s2.results[0].gapText}`);
  }
}

console.log(`\n[feat] ${checks} assertions evaluated`);
console.log(process.exitCode ? '[feat] FAILED' : '[feat] ALL ASSERTIONS PASSED');
