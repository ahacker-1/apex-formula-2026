// Headless nametag acceptance: builds a real monza RaceSession, parks a
// chase camera behind the player on the grid, and asserts the screen-space
// invariants of the nametag pass (js/nametags.js + RaceSession.updateNametags):
//   - tags hidden before lights-out (grid + lights phases),
//   - after lights-out: <= TAG_MAX_VISIBLE tags, zero label-label overlap,
//     every rect fully inside the viewport, every car beyond TAG_RANGE
//     unlabelled, every labelled car >= 50% unoccluded by label panels.
// Text-width/panel-width and pixel-level checks need a real canvas and live in
// tools/nametag-harness.html; this file proves the sim-side wiring.
//
// Usage: node tools/nametag-sim-check.mjs

// ---- minimal DOM stubs (canvas textures), same shape as sim-race.mjs ----
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
  fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {},
  fillText() {}, strokeText() {}, createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 0 }),
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
const { RaceSession } = await import('../js/race.js');
const { DRIVERS } = await import('../js/data.js');
const { TAG_MAX_VISIBLE, TAG_RANGE, MAX_CAR_COVER } = await import('../js/nametags.js');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const VW = 1280, VH = 800;
const scene = new THREE.Scene();
const circuit = buildCircuit('monza', TRACKS.monza, scene);
// worst case: player starts DEAD LAST, so all 21 opponents sit ahead in one
// tight pack inside the chase camera's view
const gridOrder = [...DRIVERS.filter((d) => d.id !== DRIVERS[0].id).map((d) => d.id), DRIVERS[0].id];
const session = new RaceSession({
  scene, circuit,
  playerDriverId: DRIVERS[0].id,
  laps: 3, difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true },
  mode: 'race', gridOrder,
  onMessage: () => {},
});
session.setNametags(true);

// chase camera behind the player, main.js camMode 0 geometry at v=0
const camera = new THREE.PerspectiveCamera(72, VW / VH, 0.3, 6500);
function aimChase() {
  const p = session.player.phys;
  const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  const ry = session.player.renderY || 0;
  camera.position.copy(p.pos).addScaledVector(f, -7.6).setY(ry + 2.55);
  const look = p.pos.clone().addScaledVector(f, 10).setY(ry + 0.85);
  camera.lookAt(look);
  camera.updateMatrixWorld();
}

const DT = 1 / 30;
const idle = { steer: 0, throttle: 0, brake: 0, boost: false };

// ---- phase: grid (pre-lights) ----
session.update(DT, idle);
aimChase();
session.updateNametags(camera, VW, VH);
let vis = session.entries.filter((e) => e.tag && e.tag.visible);
console.log(`[grid] phase=${session.phase}`);
check(session.phase === 'grid', 'session starts on the grid');
check(vis.length === 0, 'all tags hidden on the grid', `visible=${vis.length}`);

// ---- phase: lights ----
while (session.phase !== 'lights') { session.update(DT, idle); }
aimChase();
session.updateNametags(camera, VW, VH);
vis = session.entries.filter((e) => e.tag && e.tag.visible);
check(vis.length === 0, 'all tags hidden during the light sequence', `visible=${vis.length}`);

// ---- phase: racing (moments after lights-out: worst-case tight pack) ----
while (session.phase !== 'racing') { session.update(DT, idle); }
session.update(DT, idle);
aimChase();
session.updateNametags(camera, VW, VH);

const pp = session.player.phys.pos;
const tagged = session.entries.filter((e) => e.tag && e.tag.visible);
console.log(`[racing] phase=${session.phase} visibleTags=${tagged.length}`);
check(tagged.length >= 1, 'some tags visible after lights-out', `visible=${tagged.length}`);
check(tagged.length <= TAG_MAX_VISIBLE, `cap: at most ${TAG_MAX_VISIBLE} tags`, `visible=${tagged.length}`);
check(tagged.every((e) => !e.isPlayer), 'player never tagged');

for (const e of session.entries) {
  if (!e.tag || !e.tag.visible) continue;
  const dx = e.phys.pos.x - pp.x, dz = e.phys.pos.z - pp.z;
  if (dx * dx + dz * dz >= TAG_RANGE * TAG_RANGE) {
    check(false, 'distance cull', `${e.driver.code} tagged at ${Math.sqrt(dx * dx + dz * dz).toFixed(1)}m`);
  }
}
check(true, `no tag beyond ${TAG_RANGE}m (checked all ${session.entries.length} entries)`);

// re-run the pass to read its diagnostics through the same code path
const { layoutNametags } = await import('../js/nametags.js');
const cands = session.entries
  .filter((e) => e.tag && !e.isPlayer)
  .map((e) => {
    const dx = e.phys.pos.x - pp.x, dz = e.phys.pos.z - pp.z;
    return { tag: e.tag, x: e.phys.pos.x, y: e.renderY || 0, z: e.phys.pos.z, d2: dx * dx + dz * dz };
  });
const diag = layoutNametags(cands, camera, VW, VH);
check(diag.placed.length === tagged.length, 'diagnostics agree with sprite visibility',
  `${diag.placed.length} vs ${tagged.length}`);

let overlaps = 0, offscreen = 0, buried = 0, maxCover = 0;
const rects = diag.placed.map((p) => p.rect);
for (let i = 0; i < rects.length; i++) {
  const r = rects[i];
  if (r.left < -0.01 || r.top < -0.01 || r.right > VW + 0.01 || r.bottom > VH + 0.01) offscreen++;
  for (let j = i + 1; j < rects.length; j++) {
    const q = rects[j];
    if (r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom) overlaps++;
  }
}
for (const p of diag.placed) {
  let cover = 0;
  for (const q of diag.placed) {
    const w = Math.min(q.rect.right, p.carRect.right) - Math.max(q.rect.left, p.carRect.left);
    const h = Math.min(q.rect.bottom, p.carRect.bottom) - Math.max(q.rect.top, p.carRect.top);
    if (w > 0 && h > 0) cover += w * h;
  }
  const frac = cover / ((p.carRect.right - p.carRect.left) * (p.carRect.bottom - p.carRect.top));
  maxCover = Math.max(maxCover, frac);
  if (frac > MAX_CAR_COVER + 1e-9) buried++;
}
check(overlaps === 0, 'zero label-label rect overlaps', `pairsOverlapping=${overlaps}`);
check(offscreen === 0, 'every rect fully inside the viewport', `offenders=${offscreen}`);
check(buried === 0, `every labelled car >= ${(1 - MAX_CAR_COVER) * 100}% unoccluded`,
  `worst cover=${(maxCover * 100).toFixed(1)}%`);

// ---- toggle off hides instantly ----
session.setNametags(false);
vis = session.entries.filter((e) => e.tag && e.tag.visible);
check(vis.length === 0, 'setNametags(false) hides every tag instantly', `visible=${vis.length}`);

console.log(fail === 0 ? `\nALL NAMETAG SIM CHECKS PASSED: ${pass}/${pass + fail}`
  : `\nNAMETAG SIM CHECKS FAILED: ${fail} of ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
