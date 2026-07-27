// Headless full-race simulation: builds a circuit, runs a 22-car race with the
// player driven by an AIDriver, and asserts the race classifies correctly.
// Usage: node tools/sim-race.mjs [trackId] [laps]

// Keep the regression run reproducible while gameplay remains stochastic.
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
// alias 'three' importers by URL rewrite is not possible here; modules import 'three'
// so we rely on node_modules/three shim (created alongside this script).

const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');

const trackId = process.argv[2] || 'monza';
const laps = +(process.argv[3] || 5);
// argv[4] can override the first driver in the original APEX grid.
const playerDriverId = process.argv[4] || DRIVERS[0].id;

const scene = new THREE.Scene();
const circuit = buildCircuit(trackId, TRACKS[trackId], scene);
console.log(`[sim] ${trackId}: length=${Math.round(circuit.length)}m N=${circuit.N} idealLap=${circuit.idealLap.toFixed(1)}s`);

const session = new RaceSession({
  scene, circuit,
  playerDriverId,
  laps, difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true },
  mode: 'race', gridOrder: null,
  onMessage: (t, c) => console.log(`  [msg] ${t}`),
});

const autopilot = new AIDriver(session.player.phys, circuit,
  { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);

const DT = 1 / 30;
let simT = 0, boxed = false, pitObserved = false, wallClock = Date.now();
while (!session.results && simT < laps * circuit.idealLap * 3 + 300) {
  const input = session.phase === 'racing' && !session.player.finished
    ? autopilot.update(DT, session.entries.map(e => e.phys))
    : { steer: 0, throttle: 0, brake: 0 };
  session.update(DT, input);
  simT += DT;
  // arm a pit stop for the player on lap 1 (exercises the pit state machine)
  if (!boxed && session.player.lap === 1) { session.playerRequestBox(); boxed = true; }
  if (session.player.pitState) {
    pitObserved = true;
    if (!session.player.pitState.chosen) session.playerChooseTyre('H');
  }
}
const realS = ((Date.now() - wallClock) / 1000).toFixed(1);

// ---- assertions ----
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
if (!session.results) fail(`race did not classify within sim budget (simT=${Math.round(simT)}s)`);
else {
  const r = session.results;
  console.log(`[sim] classified after ${Math.round(simT)}s sim (${realS}s real)`);
  console.log('[sim] podium: ' + r.slice(0, 3).map(x => `${x.pos}.${x.driver.code} ${x.gapText}`).join('  '));
  const player = r.find(x => x.isPlayer);
  console.log(`[sim] player: P${player.pos} laps=${player.laps} pits=${player.pits} gap=${player.gapText} best=${player.bestLap?.toFixed(3)}`);
  if (r.length !== 22) fail(`expected 22 classified, got ${r.length}`);
  if (!r[0].gapText.includes(':')) fail(`winner gap text should be a time: ${r[0].gapText}`);
  const winner = r[0];
  if (winner.laps < laps) fail(`winner laps ${winner.laps} < ${laps}`);
  if (!pitObserved) fail('player pit stop never executed');
  if (player.pits < 1) fail('player pits not counted');
  if (!player.bestLap || player.bestLap < 30 || player.bestLap > 300) fail(`implausible player best lap ${player.bestLap}`);
  const pts = r.filter(x => x.points > 0);
  if (pts.length === 0 || pts[0].points !== 25) fail('points not awarded correctly');
  const dnfs = r.filter(x => x.dnf).length;
  console.log(`[sim] dnfs=${dnfs} fastestLap=${session.fastestLap?.name} ${session.fastestLap?.time?.toFixed(3)}`);
  // positions of non-DNF finishers must be unique & sequential
  const posSet = new Set(r.map(x => x.pos));
  if (posSet.size !== r.length) fail('duplicate positions in classification');
}
console.log(process.exitCode ? '[sim] FAILED' : '[sim] ALL ASSERTIONS PASSED');
