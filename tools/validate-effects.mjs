// Regression check for transparent runtime effects in the GTAO normal/depth
// pass. GTAO uses an opaque override material, so alpha cards must be excluded
// or they render as dark rectangles around smoke and skid marks.

const noop = () => {};
const makeCanvas = () => ({
  width: 64,
  height: 64,
  style: {},
  getContext: () => ({
    fillStyle: '#000',
    createRadialGradient: () => ({ addColorStop: noop }),
    fillRect: noop,
  }),
  addEventListener: noop,
  removeEventListener: noop,
});

globalThis.document = {
  createElement: (tag) => tag === 'canvas' ? makeCanvas() : { style: {} },
  createElementNS: (_ns, tag) => tag === 'canvas' ? makeCanvas() : { style: {} },
};

const THREE = await import('../lib/three.module.js');
const { GTAOPass } = await import('../lib/postprocessing/GTAOPass.js');
const { Effects, EFFECT_POOL_LIMITS } = await import('../js/effects.js');

let checks = 0;
const ok = (condition, message) => {
  checks++;
  if (!condition) throw new Error(message);
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
const excluded = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
excluded.userData.gtaoExcluded = true;
hidden.visible = false;
scene.add(solid, excluded, hidden);

const pass = new GTAOPass(scene, camera, 8, 8);
pass.overrideVisibility();
ok(solid.visible, 'ordinary opaque meshes must remain visible in the GTAO pass');
ok(!excluded.visible, 'gtaoExcluded geometry must be hidden in the GTAO pass');
ok(!hidden.visible, 'originally hidden geometry must stay hidden in the GTAO pass');
pass.restoreVisibility();
ok(solid.visible, 'ordinary mesh visibility must restore after GTAO');
ok(excluded.visible, 'excluded mesh visibility must restore after GTAO');
ok(!hidden.visible, 'originally hidden mesh visibility must restore after GTAO');

const effectScene = new THREE.Scene();
const seededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};
const effects = new Effects(effectScene, seededRandom(26));
ok(effects.sparks.userData.gtaoExcluded === true, 'spark pool must be excluded from GTAO');
ok(effects.skid.userData.gtaoExcluded === true, 'skid ribbon must be excluded from GTAO');
ok(effects.smoke.every(({ sprite }) => sprite.userData.gtaoExcluded === true),
  'every smoke card must be excluded from GTAO');
ok(effects.dust.every(({ sprite }) => sprite.userData.gtaoExcluded === true),
  'every dust card must be excluded from GTAO');
ok(effects.debris.userData.gtaoExcluded === true, 'debris pool must be excluded from GTAO');
ok(effects.sparkData.length === EFFECT_POOL_LIMITS.sparks,
  'spark storage matches its fixed pool limit');
ok(effects.smoke.length === EFFECT_POOL_LIMITS.smoke,
  'smoke storage matches its fixed pool limit');
ok(effects.dust.length === EFFECT_POOL_LIMITS.dust,
  'dust storage matches its fixed pool limit');
ok(effects.debrisData.length === EFFECT_POOL_LIMITS.debris,
  'debris storage matches its fixed pool limit');

function makeEntry() {
  return {
    isPlayer: true,
    dnf: false,
    phys: {
      disabled: false,
      pos: { x: 8, z: 14 }, heading: 0.45, v: 46,
      onKerb: true, offTrack: true, offTrackSink: 0.8,
      slip: true, brake: 0.9, throttle: 0.15, aeroX: false,
      wallHit: 0.7, lat: 8, sampleIdx: 0,
      circuit: {
        ds: 1,
        samples: [{ p: { x: 0, z: 0 }, t: { x: 0, z: 1 } }],
        heightAt: () => 0.35,
      },
    },
  };
}

function effectDigest(value) {
  const sparkPos = value.sparks.geometry.attributes.position.array;
  const debrisPos = value.debris.geometry.attributes.position.array;
  return JSON.stringify({
    cursors: [value._sparkCursor, value._smokeCursor, value._dustCursor, value._debrisCursor],
    sparkPos: Array.from(sparkPos.slice(0, 36)),
    sparkLife: value.sparkData.slice(0, 12).map(item => item.life),
    smoke: value.smoke.slice(0, 8).map(item => [item.life, item.sprite.position.toArray()]),
    dust: value.dust.slice(0, 8).map(item => [item.life, item.sprite.position.toArray()]),
    debrisPos: Array.from(debrisPos.slice(0, 48)),
    debrisLife: value.debrisData.slice(0, 16).map(item => item.life),
  });
}

const mirrorScene = new THREE.Scene();
const mirror = new Effects(mirrorScene, seededRandom(26));
const entryA = makeEntry();
const entryB = makeEntry();
const childCount = effectScene.children.length;
const poolRefs = [
  effects.sparkData, effects.smoke, effects.dust, effects.debrisData,
  effects.sparks.geometry.attributes.position.array,
  effects.debris.geometry.attributes.position.array,
];
for (let frame = 0; frame < 180; frame++) {
  entryA.phys.pos.z += entryA.phys.v / 60;
  entryB.phys.pos.z += entryB.phys.v / 60;
  // Let the one-shot collision burst re-arm later in the deterministic run.
  entryA.phys.wallHit = entryB.phys.wallHit = frame === 0 || frame === 90 ? 0.7 : 0;
  effects.update(1 / 60, [entryA]);
  mirror.update(1 / 60, [entryB]);
}
ok(effectDigest(effects) === effectDigest(mirror),
  'identical seeded inputs produce identical atmosphere buffers');
ok(effectScene.children.length === childCount,
  'updates never grow the scene object count');
ok(poolRefs[0] === effects.sparkData && poolRefs[1] === effects.smoke &&
  poolRefs[2] === effects.dust && poolRefs[3] === effects.debrisData &&
  poolRefs[4] === effects.sparks.geometry.attributes.position.array &&
  poolRefs[5] === effects.debris.geometry.attributes.position.array,
  'updates reuse the original pools and typed buffers');
ok([...effects.sparks.geometry.attributes.position.array,
  ...effects.debris.geometry.attributes.position.array].every(Number.isFinite),
  'particle positions remain finite after sustained mixed emissions');

const reducedScene = new THREE.Scene();
const reduced = new Effects(reducedScene, seededRandom(26), { reducedMotion: true });
const reducedEntry = makeEntry();
for (let frame = 0; frame < 60; frame++) reduced.update(1 / 60, [reducedEntry]);
ok(reduced.motionScale < effects.motionScale,
  'prefers-reduced-motion mode lowers emission density without disabling cues');
ok(reduced._dustCursor < effects._dustCursor || effects._dustCursor < 10,
  'reduced-motion mode emits fewer dust plumes over the same interval');

effects.dispose();
mirror.dispose();
reduced.dispose();
pass.dispose();
for (const object of [solid, excluded, hidden]) {
  object.geometry.dispose();
  object.material.dispose();
}

console.log(`[effects] ${checks} GTAO exclusion checks passed`);
