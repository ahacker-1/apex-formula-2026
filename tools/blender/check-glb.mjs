// Loads assets/f1car-2026.glb through the game's OWN three.js + GLTFLoader and
// asserts the export contract from the resulting scene graph — i.e. it checks
// what the browser will actually see, not what Blender thinks it wrote.
//
//   node tools/blender/check-glb.mjs
//
// DOM/canvas stubs follow tools/sim-race.mjs. GLTFLoader in node needs
// TextDecoder + atob, both of which node >= 18 provides globally; the GLB is fed
// in from a Buffer via loader.parse() so no fetch/XHR is involved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GLB = path.join(ROOT, 'assets', 'f1car-2026.glb');

/* ---- minimal DOM stubs (same shape as tools/sim-race.mjs) ---------------- */
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
  createElement: (tag) => (tag === 'canvas'
    ? { width: 0, height: 0, getContext: ctxStub }
    : { style: {} }),
  createElementNS: () => ({ style: {} }),
};
globalThis.self = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const THREE = await import('../../lib/three.module.js');
const { GLTFLoader } = await import('../../lib/loaders/GLTFLoader.js');

/* ---- assertions ---------------------------------------------------------- */
let pass = 0;
const fails = [];
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${msg}${detail ? ' ' + detail : ''}`); }
  else { fails.push(msg); console.log(`  FAIL  ${msg}${detail ? ' ' + detail : ''}`); }
};
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;

const WHEELS = {
  wheel_fl: [-0.82, 0.34, 1.55, 0.30],
  wheel_fr: [0.82, 0.34, 1.55, 0.30],
  wheel_rl: [-0.85, 0.34, -1.60, 0.38],
  wheel_rr: [0.85, 0.34, -1.60, 0.38],
};
const REQUIRED_MATS = ['body', 'accent', 'carbon', 'tyre', 'rim', 'glow',
  'rainlight', 'band'];

console.log('=== GLB load check (three r' + THREE.REVISION + ' + GLTFLoader) ===');
ok(fs.existsSync(GLB), 'assets/f1car-2026.glb exists',
  `[${(fs.statSync(GLB).size / 1024).toFixed(1)} KB]`);

const buf = fs.readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(ab, '', resolve, reject);
});
const scene = gltf.scene;
scene.updateMatrixWorld(true);
ok(!!scene, 'GLTFLoader.parse() produced a scene');

/* ---- named nodes -------------------------------------------------------- */
const byName = new Map();
let meshCount = 0;
let nodeCount = 0;
scene.traverse((o) => {
  nodeCount++;
  if (o.name) byName.set(o.name, o);
  if (o.isMesh) meshCount++;
});

for (const n of [...Object.keys(WHEELS), 'body_root', 'brake_glow_l',
  'brake_glow_r', 'rain_light']) {
  ok(byName.has(n), `node '${n}' present in the loaded graph`);
}

const wv = new THREE.Vector3();
for (const [name, [x, y, z, width]] of Object.entries(WHEELS)) {
  const o = byName.get(name);
  if (!o) continue;
  o.getWorldPosition(wv);
  ok(near(wv.x, x) && near(wv.y, y) && near(wv.z, z),
    `'${name}' world position (${x}, ${y}, ${z})`,
    `[${wv.x.toFixed(4)}, ${wv.y.toFixed(4)}, ${wv.z.toFixed(4)}]`);

  const kids = o.children.filter((c) => c.isMesh).map((c) => c.name.split('_')[0]);
  ok(kids.length === 3 && new Set(kids).size === 3
    && ['tyre', 'rim', 'band'].every((k) => kids.includes(k)),
    `'${name}' contains tyre + rim + band meshes`, `[${kids.join(',')}]`);

  const box = new THREE.Box3().setFromObject(o);
  const size = box.getSize(new THREE.Vector3());
  ok(near(size.x, width, 0.006), `'${name}' is ${width} m wide`,
    `[${size.x.toFixed(4)}]`);
  ok(near(size.y, 0.68, 0.006) && near(size.z, 0.68, 0.006),
    `'${name}' tyre diameter 0.68 (radius 0.34)`,
    `[${size.y.toFixed(4)} x ${size.z.toFixed(4)}]`);
  ok(near(box.min.y, 0.0, 0.004), `'${name}' touches the ground plane`,
    `[min y = ${box.min.y.toFixed(4)}]`);

  // every wheel mesh must be centred on its own node origin
  for (const c of o.children) {
    if (!c.isMesh) continue;
    ok(c.position.lengthSq() < 1e-8, `'${c.name}' is centred on its wheel node`,
      `[${c.position.toArray().map((v) => v.toFixed(3)).join(',')}]`);
  }
}

// symmetry
for (const [a, b] of [['wheel_fl', 'wheel_fr'], ['wheel_rl', 'wheel_rr']]) {
  const pa = byName.get(a).getWorldPosition(new THREE.Vector3());
  const pb = byName.get(b).getWorldPosition(new THREE.Vector3());
  ok(near(pa.x, -pb.x, 1e-5) && near(pa.y, pb.y, 1e-5) && near(pa.z, pb.z, 1e-5),
    `${a} / ${b} are symmetric about x = 0`);
}

/* ---- body_root ---------------------------------------------------------- */
const root = byName.get('body_root');
if (root) {
  const wheelMeshes = new Set();
  for (const n of Object.keys(WHEELS)) {
    byName.get(n)?.traverse((o) => { if (o.isMesh) wheelMeshes.add(o); });
  }
  const orphans = [];
  scene.traverse((o) => {
    if (!o.isMesh || wheelMeshes.has(o)) return;
    let p = o.parent, inside = false;
    while (p) { if (p === root) { inside = true; break; } p = p.parent; }
    if (!inside) orphans.push(o.name);
  });
  ok(orphans.length === 0, "'body_root' contains every non-wheel mesh",
    orphans.length ? `[orphans: ${orphans.join(',')}]` : '');
}

/* ---- materials ---------------------------------------------------------- */
const mats = new Map();
scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (m) mats.set(m.name, m);
  }
});
for (const m of REQUIRED_MATS) ok(mats.has(m), `material '${m}' is present`);
ok(mats.get('glow')?.emissive?.getHex() > 0, "'glow' is emissive",
  `[#${mats.get('glow')?.emissive?.getHexString()}]`);
ok(mats.get('rainlight')?.emissive?.getHex() > 0, "'rainlight' is emissive",
  `[#${mats.get('rainlight')?.emissive?.getHexString()}]`);
for (const [name, want] of [['brake_glow_l', 'glow'], ['brake_glow_r', 'glow'],
  ['rain_light', 'rainlight']]) {
  ok(byName.get(name)?.material?.name === want,
    `'${name}' uses material '${want}'`,
    `[${byName.get(name)?.material?.name}]`);
}

/* ---- geometry ----------------------------------------------------------- */
let tris = 0;
scene.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry;
  tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  ok(!!g.attributes.normal, `'${o.name}' has vertex normals`);
});
ok(tris >= 25000 && tris <= 60000, 'triangle count in [25000, 60000]',
  `[${tris}]`);

const box = new THREE.Box3().setFromObject(scene);
const size = box.getSize(new THREE.Vector3());
ok(size.z <= 5.4 && size.x <= 2.09 && size.y <= 1.1,
  'bbox within 5.4 x 2.09 x 1.1 (L x W x H)',
  `[${size.z.toFixed(3)} x ${size.x.toFixed(3)} x ${size.y.toFixed(3)}]`);
ok(box.min.y >= -1e-5, 'nothing below y = 0', `[${box.min.y.toFixed(6)}]`);
ok(size.z >= 4.6, 'car is ~5 m long', `[${size.z.toFixed(3)}]`);
ok(near(box.max.z, 2.556, 0.25) && box.max.z > 0,
  '+Z is forward (front wing is at max z)', `[max z = ${box.max.z.toFixed(3)}]`);

const bodyBox = new THREE.Box3().setFromObject(root);
ok(bodyBox.max.x <= 0.96 && bodyBox.min.x >= -0.96,
  'bodywork is ~1.90 m wide',
  `[${bodyBox.min.x.toFixed(3)} .. ${bodyBox.max.x.toFixed(3)}]`);

/* ---- car.js integration -------------------------------------------------- */
const CAR = await import('../../js/car.js');
for (const fn of ['preloadCarModel', 'buildCarMesh', 'buildNameTag',
  'setTyreCompound', 'snapDecals', 'carVariant']) {
  ok(typeof CAR[fn] === 'function', `js/car.js exports ${fn}()`);
}
ok((await CAR.preloadCarModel(GLB)) === null,
  'preloadCarModel() resolves null in node (primitives fallback stays in charge)');

// js/car.js fits its livery planes to the real bodywork at preload time; run the
// same fit here and require every plane to land ON a surface.
const decals = CAR.snapDecals(scene);
ok(decals.length === CAR.GLB_DECALS.filter((d) => d.mirror).length * 2
  + CAR.GLB_DECALS.filter((d) => !d.mirror).length,
  'every livery decal found a surface to sit on',
  `[${decals.length} planes]`);
const rc = new THREE.Raycaster();
rc.far = 1.0;
const bodyTargets = [];
root.traverse((o) => { if (o.isMesh) bodyTargets.push(o); });
for (const d of decals) {
  rc.set(d.position.clone().addScaledVector(d.normal, 0.30),
    d.normal.clone().negate());
  const hits = rc.intersectObjects(bodyTargets, false);
  const gap = hits.length ? hits[0].distance - 0.30 : NaN;
  ok(hits.length > 0 && gap > 0.0005 && gap < 0.06,
    `decal '${d.name}' floats just off the bodywork`,
    Number.isNaN(gap) ? '[nothing behind it]'
      : `[${(gap * 1000).toFixed(1)} mm off ${hits[0].object.name}, `
        + `bulge ${(d.bulge * 1000).toFixed(1)} mm]`);
}
ok(nodeCount + decals.length + 1 <= 80,
  'per-car object count within the 80-object budget',
  `[${nodeCount} GLB nodes + ${decals.length} decals + 1 group `
  + `= ${nodeCount + decals.length + 1}]`);

/* ---- both build paths, end to end --------------------------------------- */
const TEAM = { id: 'ferrari', color: 0xe10600, accent: 0xffe66d };
const DRIVER = { num: 16, code: 'LEC' };

// primitives first: installing the template is one-way inside the module
{
  const h = CAR.buildCarMesh(TEAM, DRIVER);
  ok(h.source === 'primitives', 'buildCarMesh() uses primitives before preload',
    `[${h.source}]`);
  ok(h.wheelRadius === 0.34 && ['fl', 'fr', 'rl', 'rr'].every(
    (k) => h.wheels[k] && h.wheels[k].rotation.order === 'YXZ'),
  'primitives handle keeps the wheels API');
}

const tpl = await CAR.preloadCarModel(scene.clone(true));
ok(!!tpl && CAR.carModelLoaded(), 'preloadCarModel(scene) installs the template');

const a = CAR.buildCarMesh(TEAM, DRIVER);
const b = CAR.buildCarMesh({ id: 'mclaren', color: 0xff8000, accent: 0x111111 },
  { num: 4, code: 'NOR' });
ok(a.source === 'glb', 'buildCarMesh() uses the GLB template once loaded',
  `[${a.source}]`);
ok(a.wheelRadius === 0.34, 'wheelRadius still 0.34', `[${a.wheelRadius}]`);
for (const k of ['fl', 'fr', 'rl', 'rr']) {
  ok(!!a.wheels[k] && a.wheels[k].name === 'wheel_' + k,
    `wheels.${k} is wired to node 'wheel_${k}'`);
  ok(a.wheels[k].rotation.order === 'YXZ', `wheels.${k} uses YXZ Euler order`);
  ok(a.wheels[k].parent === a.group, `wheels.${k} hangs off the car group`);
}
ok(a.group.userData.brakeGlows?.length === 2
  && a.group.userData.brakeGlows.every((g) => g.visible === false),
'userData.brakeGlows holds both discs, hidden');
ok(!!a.group.userData.rainLight && a.group.userData.rainLight.visible === true,
  'userData.rainLight present and visible');
ok(!!a.body && a.body.name === 'body_root',
  'handle.body is the body_root group (race.js drives pitch/roll on it)');

// axle sanity: the exact write pattern race.js uses
let worstTilt = 0;
for (const steer of [-0.32, 0, 0.32]) {
  for (const spin of [0, 1.9, 5.1]) {
    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      a.wheels[k].rotation.x = spin;
      a.wheels[k].rotation.y = (k[0] === 'f') ? steer : 0;
    }
    a.group.updateMatrixWorld(true);
    for (const k of ['fl', 'fr']) {
      const axle = new THREE.Vector3()
        .setFromMatrixColumn(a.wheels[k].matrixWorld, 0).normalize();
      worstTilt = Math.max(worstTilt, Math.abs(axle.y));
    }
  }
}
ok(worstTilt < 1e-9, 'steered + spinning front axles stay horizontal',
  `[max |axle.y| = ${worstTilt.toExponential(2)}]`);

// per-car recolour isolation
const matOf = (h, name) => {
  let found = null;
  h.group.traverse((o) => {
    if (o.isMesh && o.material && o.material.name === name) found = o.material;
  });
  return found;
};
const bodyA = matOf(a, 'body'), bodyB = matOf(b, 'body');
ok(bodyA && bodyB && bodyA !== bodyB, "'body' material is cloned per car");
ok(bodyA.color.getHex() === 0xe10600 && bodyB.color.getHex() === 0xff8000,
  "'body' is recoloured to team.color",
  `[#${bodyA.color.getHexString()} / #${bodyB.color.getHexString()}]`);
const accA = matOf(a, 'accent');
ok(accA && accA.color.getHex() === 0xffe66d, "'accent' is recoloured to team.accent",
  `[#${accA.color.getHexString()}]`);
for (const n of ['body', 'accent', 'band', 'glow', 'rainlight']) {
  const m = matOf(a, n);
  ok(m && !m.userData.shared,
    `'${n}' clone is NOT flagged shared (dispose() reclaims it)`);
}
for (const n of ['carbon', 'tyre', 'rim']) {
  const m = matOf(a, n);
  ok(m && m.userData.shared === true, `'${n}' stays shared across cars`);
}
{
  let geos = 0, sharedGeos = 0;
  a.group.traverse((o) => {
    if (!o.isMesh) return;
    geos++;
    if (o.geometry.userData.shared) sharedGeos++;
  });
  ok(geos === sharedGeos, 'every cloned geometry is flagged shared',
    `[${sharedGeos}/${geos}]`);
}

// compound bands
ok(CAR.setTyreCompound(a, 'S') === true && matOf(a, 'band').color.getHex() === 0xe10600,
  "setTyreCompound('S') paints the bands red");
CAR.setTyreCompound(a, 'H');
ok(matOf(a, 'band').color.getHex() === 0xf0f0f0, "setTyreCompound('H') paints them white");
CAR.setTyreCompound(a, 'M');
ok(matOf(a, 'band').color.getHex() === 0xffd24a && a.compound === 'M',
  "setTyreCompound('M') paints them yellow");
ok(matOf(b, 'band').color.getHex() === 0xffd24a,
  'compound changes do not leak between cars');

// decals reached the car, and the object budget holds for a REAL car
{
  const names = [];
  let objects = 0;
  a.group.traverse((o) => { objects++; if (o.isMesh) names.push(o.name); });
  for (const d of CAR.GLB_DECALS) {
    ok(names.includes(d.name), `decal plane '${d.name}' is attached to the body`);
  }
  ok(objects <= 80, 'a built car stays within 80 objects', `[${objects}]`);
  // undo the axle sweep above: a spun wheel's AABB-of-AABB dips below the road
  // even though its vertices do not, so measure the car at rest and precisely.
  for (const k of ['fl', 'fr', 'rl', 'rr']) a.wheels[k].rotation.set(0, 0, 0);
  a.group.updateMatrixWorld(true);
  const cbox = new THREE.Box3().setFromObject(a.group, true);
  ok(cbox.min.y >= -1e-5, 'built car has nothing below y = 0',
    `[${cbox.min.y.toFixed(6)}]`);
  const csize = cbox.getSize(new THREE.Vector3());
  ok(csize.z <= 5.4 && csize.x <= 2.09 && csize.y <= 1.1,
    'built car bbox within 5.4 x 2.09 x 1.1',
    `[${csize.z.toFixed(3)} x ${csize.x.toFixed(3)} x ${csize.y.toFixed(3)}]`);
}
ok(typeof CAR.buildNameTag(DRIVER, TEAM).isSprite === 'boolean'
  || CAR.buildNameTag(DRIVER, TEAM).isSprite === true,
'buildNameTag() still returns a sprite');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
