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
globalThis.document = { createElement: tag => tag === 'canvas' ? { width: 0, height: 0, getContext: ctxStub } : { style: {} } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const THREE = await import('../lib/three.module.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');
const { createRandom } = await import('../js/random.js');

const scene = new THREE.Scene();
const circuit = buildCircuit('monza', TRACKS.monza, scene);
const random = createRandom('full-quali-validator');
const session = new RaceSession({
  scene, circuit, playerDriverId: DRIVERS[0].id, laps: 5, difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true }, mode: 'quali', random,
});
assert.equal(session.entries.length, DRIVERS.length, 'full qualifying must put the complete field on track');
assert.equal(session.aiQualiTimes.length, 0, 'qualifying must not pre-fill synthetic AI times');

const autopilot = new AIDriver(session.player.phys, circuit,
  { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1, random);
const dt = 1 / 30;
let elapsed = 0;
while (session.qualiState !== 'done' && elapsed < circuit.idealLap * 4) {
  const input = autopilot.update(dt, session.entries.map(entry => entry.phys));
  session.update(dt, input);
  elapsed += dt;
}
const classification = session.qualiClassification();
assert.equal(session.qualiState, 'done', 'full qualifying session did not complete');
assert.equal(classification.length, DRIVERS.length, 'qualifying classification field size');
assert.ok(classification.every(row => row.actual && row.time > 30 && row.time < 300), 'every qualifying time must be an earned physical lap');
assert.equal(new Set(classification.map(row => row.driverId)).size, DRIVERS.length, 'qualifying driver uniqueness');

const q2 = session.advanceQualifyingStage();
assert.equal(q2.stage, 'Q2');
assert.equal(q2.survivors.length, 15);
assert.equal(q2.eliminated.length, DRIVERS.length - 15);

console.log(`[race-weekend-depth] physical Q1 complete in ${elapsed.toFixed(1)}s; ${classification.length} earned times; Q2=${q2.survivors.length}`);
