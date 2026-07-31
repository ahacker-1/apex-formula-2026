#!/usr/bin/env node
import assert from 'node:assert/strict';

const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '', fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {}, fillText() {}, strokeText() {},
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }), save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
  ellipse() {}, bezierCurveTo() {}, setTransform() {}, drawImage() {},
});
globalThis.document = {
  createElement: tag => tag === 'canvas'
    ? { width: 0, height: 0, getContext: ctxStub }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const THREE = await import('../lib/three.module.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');
const { createRandom } = await import('../js/random.js');

const PILOT_DRIVER_ID = 'hacker';
const DT = 1 / 30;
const ZERO_INPUT = Object.freeze({ steer: 0, throttle: 0, brake: 0, boost: false });
const pilot = DRIVERS.find(driver => driver.id === PILOT_DRIVER_ID);
assert.equal(pilot?.team, 'tacn', 'the full-weekend pilot must be TACN driver hacker');

function makeContext(seed) {
  const scene = new THREE.Scene();
  const circuit = buildCircuit('spa', TRACKS.spa, scene);
  return { scene, circuit, random: createRandom(seed) };
}

function makeSession(context, mode, extra = {}) {
  return new RaceSession({
    scene: context.scene,
    circuit: context.circuit,
    playerDriverId: PILOT_DRIVER_ID,
    laps: 5,
    difficulty: 1,
    assists: { tc: true, abs: true, autoGear: true },
    mode,
    random: context.random,
    ...extra,
  });
}

function makeAutopilot(session, context) {
  return new AIDriver(session.player.phys, context.circuit, pilot, 1, context.random);
}

function runToQualifyingDone(session, autopilot, budget, inputTransform = input => input) {
  let elapsed = 0;
  while (session.qualiState !== 'done' && elapsed < budget) {
    const input = session.player.phys.disabled
      ? ZERO_INPUT
      : inputTransform(autopilot.update(DT, session.entries.map(entry => entry.phys)));
    session.update(DT, input);
    elapsed += DT;
  }
  assert.equal(session.qualiState, 'done', `${session.mode}/${session.qualifying.stage} did not complete in ${budget.toFixed(1)}s`);
  return elapsed;
}

function assertPhysicalRows(rows, expected, label) {
  assert.equal(rows.length, expected, `${label} field size`);
  assert.equal(new Set(rows.map(row => row.driverId)).size, expected, `${label} driver uniqueness`);
  assert.ok(rows.every(row => row.actual && row.time > 30 && row.time < 420), `${label} must contain only earned physical laps`);
}

// FP1: the complete field runs physically and the player earns a timed lap.
const practiceContext = makeContext('tacn-spa-fp1');
const practice = makeSession(practiceContext, 'practice', { qualiStage: 'FP1' });
const practiceElapsed = runToQualifyingDone(
  practice,
  makeAutopilot(practice, practiceContext),
  practiceContext.circuit.idealLap * 6,
);
const practiceRows = practice.practiceClassification();
assertPhysicalRows(practiceRows, DRIVERS.length, 'FP1');
assert.equal(practice.qualifying.stage, 'FP1');

// Q1-Q3: intentionally speed-limit the player in Q1 so the deterministic test
// covers the important eliminated-player path. All subsequent times are still
// earned by the surviving physical AI cars; nothing is sampled or fabricated.
const qualifyingContext = makeContext('tacn-spa-staged-qualifying');
const qualifying = makeSession(qualifyingContext, 'quali', {
  qualiStage: 'Q1',
  qualiFormat: 'staged',
});
const qualifyingAutopilot = makeAutopilot(qualifying, qualifyingContext);
assert.equal(qualifying.aiQualiTimes.length, 0, 'qualifying must not pre-fill synthetic AI times');
const q1Elapsed = runToQualifyingDone(
  qualifying,
  qualifyingAutopilot,
  qualifyingContext.circuit.idealLap * 8,
  input => ({
    ...input,
    throttle: qualifying.player.phys.v > 48 ? 0 : input.throttle * 0.82,
    boost: false,
  }),
);
const q1Rows = qualifying.currentQualifyingClassification();
assertPhysicalRows(q1Rows, 22, 'Q1');

const q2Advance = qualifying.advanceQualifyingStage();
assert.equal(q2Advance.stage, 'Q2');
assert.equal(q2Advance.survivors.length, 15);
assert.equal(q2Advance.eliminated.length, 7);
assert.equal(q2Advance.playerActive, false, 'speed-limited TACN player should exercise eliminated-player spectating');
assert.equal(qualifying.player.phys.disabled, true);
assert.equal(qualifying.qualiState, 'awaiting-field');
assert.notEqual(qualifying.focusEntry, qualifying.player);
assert.equal(qualifying.focusEntry?.phys.disabled, false, 'Q2 must expose a live focus car after player elimination');
assert.ok(qualifying.entries.filter(entry => !entry.phys.disabled).every(entry =>
  entry.phys.compound === 'S' && entry.phys.wear === 0 && entry.tyreAgeLaps === 0 &&
  entry.bestLap === 0 && entry.lapTimes.length === 0 && entry.lap === -1));
const q2Elapsed = runToQualifyingDone(
  qualifying,
  qualifyingAutopilot,
  qualifyingContext.circuit.idealLap * 6,
);
const q2Rows = qualifying.currentQualifyingClassification();
assertPhysicalRows(q2Rows, 15, 'Q2');

const q3Advance = qualifying.advanceQualifyingStage();
assert.equal(q3Advance.stage, 'Q3');
assert.equal(q3Advance.survivors.length, 10);
assert.equal(q3Advance.eliminated.length, 12);
assert.equal(q3Advance.playerActive, false);
const q3Elapsed = runToQualifyingDone(
  qualifying,
  qualifyingAutopilot,
  qualifyingContext.circuit.idealLap * 6,
);
const q3Rows = qualifying.currentQualifyingClassification();
assertPhysicalRows(q3Rows, 10, 'Q3');

const completed = qualifying.advanceQualifyingStage();
assert.equal(completed.stage, 'done');
assert.equal(completed.playerActive, false);
assert.deepEqual(
  Object.fromEntries(Object.entries(qualifying.qualifying.stageResults).map(([stage, rows]) => [stage, rows.length])),
  { Q1: 22, Q2: 15, Q3: 10 },
);
const finalGrid = completed.classification;
assertPhysicalRows(finalGrid, 22, 'final qualifying grid');
assert.deepEqual(finalGrid.slice(0, 10).map(row => row.driverId), q3Rows.map(row => row.driverId), 'Q3 order must own grid positions 1-10');
assert.deepEqual(
  finalGrid.slice(10, 15).map(row => row.driverId),
  q2Rows.filter(row => !new Set(q3Rows.map(q3 => q3.driverId)).has(row.driverId)).map(row => row.driverId),
  'Q2 eliminations must own grid positions 11-15',
);
assert.deepEqual(
  finalGrid.slice(15).map(row => row.driverId),
  q1Rows.filter(row => !new Set(q2Rows.map(q2 => q2.driverId)).has(row.driverId)).map(row => row.driverId),
  'Q1 eliminations must own grid positions 16-22',
);

// The final qualifying order feeds a formation lap, then the normal grid and
// five-light start. Formation crossing must not consume a race lap.
const raceContext = makeContext('tacn-spa-weekend-race');
const messages = [];
const race = makeSession(raceContext, 'race', {
  gridOrder: finalGrid.map(row => row.driverId),
  formationLap: true,
  onMessage: text => messages.push(text),
});
assert.equal(race.phase, 'formation');
assert.equal(race.startFormation(), true);
assert.ok(messages.includes('FORMATION LAP'));
const formationAutopilot = makeAutopilot(race, raceContext);
let formationElapsed = 0;
while (race.phase === 'formation' && formationElapsed < raceContext.circuit.idealLap * 6) {
  race.update(DT, formationAutopilot.update(DT, race.entries.map(entry => entry.phys)));
  formationElapsed += DT;
}
assert.equal(race.phase, 'grid', 'formation lap must return the field to the starting grid');
assert.ok(
  formationElapsed > raceContext.circuit.idealLap * 0.65,
  `formation lap shortcut detected: ${formationElapsed.toFixed(1)}s is not a full Spa lap`,
);
assert.equal(race.player.lap, -1, 'formation lap must not consume race lap one');
assert.equal(race.raceTime, 0, 'formation lap must not consume race time');
assert.equal(race.startProcedure.lapComplete, true);
assert.equal(race.startProcedure.lapStarted, true);
assert.ok(race.startProcedure.formationElapsed > raceContext.circuit.idealLap * 0.65);
assert.ok(
  race.startProcedure.formationDistance >= raceContext.circuit.length * 0.8,
  `formation lap covered only ${race.startProcedure.formationDistance.toFixed(1)}m`,
);
assert.ok(messages.includes('FORMATION LAP UNDERWAY'));
assert.ok(messages.includes('GRID SET — START PROCEDURE'));

let startElapsed = 0;
const lightsSeen = new Set();
while (race.phase !== 'racing' && startElapsed < 12) {
  race.update(DT, ZERO_INPUT);
  if (race.lightsOn > 0) lightsSeen.add(race.lightsOn);
  startElapsed += DT;
}
assert.equal(race.phase, 'racing', 'grid must progress through five lights to racing');
assert.deepEqual([...lightsSeen], [1, 2, 3, 4, 5], 'start sequence must illuminate all five lights');
assert.equal(race.jumpStart, false);
assert.deepEqual(
  race.entries.map(entry => entry.driver.id),
  finalGrid.map(row => row.driverId),
  'race constructor must preserve the physical qualifying grid',
);

console.log(
  `[race-weekend-depth] Spa FP1 ${practiceElapsed.toFixed(1)}s · ` +
  `Q1/Q2/Q3 ${q1Elapsed.toFixed(1)}/${q2Elapsed.toFixed(1)}/${q3Elapsed.toFixed(1)}s · ` +
  `formation ${formationElapsed.toFixed(1)}s · 22-car earned grid`,
);
