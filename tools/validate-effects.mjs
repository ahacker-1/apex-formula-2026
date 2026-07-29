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
const { Effects } = await import('../js/effects.js');

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
const effects = new Effects(effectScene);
ok(effects.sparks.userData.gtaoExcluded === true, 'spark pool must be excluded from GTAO');
ok(effects.skid.userData.gtaoExcluded === true, 'skid ribbon must be excluded from GTAO');
ok(effects.smoke.every(({ sprite }) => sprite.userData.gtaoExcluded === true),
  'every smoke card must be excluded from GTAO');

effects.dispose();
pass.dispose();
for (const object of [solid, excluded, hidden]) {
  object.geometry.dispose();
  object.material.dispose();
}

console.log(`[effects] ${checks} GTAO exclusion checks passed`);
