#!/usr/bin/env node
// Focused headless contract check for circuit PBR surface maps.

function makeContext() {
  const noop = () => {};
  let stored = null;
  return {
    fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
    lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', filter: 'none',
    shadowBlur: 0, shadowColor: '#000', globalCompositeOperation: 'source-over',
    fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    arcTo: noop, ellipse: noop, rect: noop, roundRect: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, fill: noop, stroke: noop, clip: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }),
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    transform: noop, setTransform: noop, resetTransform: noop, setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null, drawImage: noop,
    putImageData: (image) => {
      stored = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
    },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    // Deterministic non-flat pixels exercise Sobel + roughness derivation even
    // though this validator intentionally does not depend on a native canvas.
    getImageData: (_x, _y, w, h) => {
      if (stored && stored.width === w && stored.height === h) {
        return { data: new Uint8ClampedArray(stored.data), width: w, height: h };
      }
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const v = (x * 17 + y * 29 + ((x ^ y) & 31) * 5) & 255;
        data[o] = v; data[o + 1] = (v * 3 + 37) & 255;
        data[o + 2] = (v * 7 + 11) & 255; data[o + 3] = 255;
      }
      return { data, width: w, height: h };
    },
  };
}

function makeCanvas() {
  const context = makeContext();
  return {
    nodeName: 'CANVAS', tagName: 'CANVAS', width: 300, height: 150, style: {},
    getContext: () => context, toDataURL: () => 'data:,',
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, getAttribute: () => null,
  };
}

globalThis.document = {
  createElementNS: (_ns, tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : { style: {} }),
  createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : { style: {} }),
  createTextNode: () => ({}), addEventListener: () => {}, removeEventListener: () => {},
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globalThis.self = globalThis.window;

const THREE = await import('three');
const { TRACKS } = await import('../js/tracks.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const {
  createSurfaceMaps,
  getSurfaceResponseCacheStats,
  upgradeMaterial,
} = await import('../js/photoTex.js');

let checks = 0;
function assert(condition, message) {
  checks++;
  if (!condition) throw new Error(`PBR surface validation failed: ${message}`);
}

function named(circuit, name) {
  return circuit.group.getObjectByName(name);
}

function near(a, b, epsilon = 1e-9) { return Math.abs(a - b) <= epsilon; }

function checkSampling(material, label, { colour = true, range } = {}) {
  assert(!!material.normalMap?.isCanvasTexture, `${label} has a normal map`);
  assert(!!material.roughnessMap?.isCanvasTexture, `${label} has a roughness map`);
  assert(material.normalMap.colorSpace === THREE.NoColorSpace, `${label} normal map is linear data`);
  assert(material.roughnessMap.colorSpace === THREE.NoColorSpace, `${label} roughness map is linear data`);
  assert(material.normalMap.repeat.equals(material.roughnessMap.repeat), `${label} response repeats align`);
  assert(material.normalMap.wrapS === material.roughnessMap.wrapS
    && material.normalMap.wrapT === material.roughnessMap.wrapT, `${label} response wrapping aligns`);
  assert(material.normalMap.channel === material.roughnessMap.channel,
    `${label} response maps use the same UV channel`);
  assert(material.roughness === 1, `${label} does not multiply final roughness values twice`);
  const encodedRange = material.roughnessMap.userData.valueRange;
  assert(Array.isArray(encodedRange) && encodedRange.length === 2
    && encodedRange.every(Number.isFinite), `${label} publishes its encoded roughness range`);
  if (range) {
    assert(near(encodedRange[0] * material.roughness, range[0])
      && near(encodedRange[1] * material.roughness, range[1]),
    `${label} effective roughness is ${range[0]}..${range[1]}`);
    const canvas = material.roughnessMap.image;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lo = 255, hi = 0;
    for (let i = 1; i < pixels.length; i += 4) {
      lo = Math.min(lo, pixels[i]); hi = Math.max(hi, pixels[i]);
    }
    const tolerance = 1 / 255 + 1e-9;
    assert((lo / 255) * material.roughness >= range[0] - tolerance
      && (hi / 255) * material.roughness <= range[1] + tolerance,
    `${label} encoded pixels stay inside their effective roughness range`);
  }
  if (colour) {
    assert(material.map?.colorSpace === THREE.SRGBColorSpace, `${label} colour map is sRGB`);
    assert(material.map.repeat.equals(material.normalMap.repeat), `${label} colour/normal repeats align`);
    assert(material.map.channel === material.normalMap.channel, `${label} colour/data UV channels align`);
    assert(material.map.anisotropy === material.normalMap.anisotropy
      && material.map.anisotropy === material.roughnessMap.anisotropy,
    `${label} colour/data anisotropy aligns`);
  }
}

function allTextures(circuit) {
  const textures = new Set();
  circuit.group.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material
      : (object.material ? [object.material] : []);
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  return textures;
}

function build(id) {
  const scene = new THREE.Scene();
  return buildCircuit(id, TRACKS[id], scene);
}

const first = build('monza');
const road = named(first, 'road');
const grass = named(first, 'ground');
const kerbs = named(first, 'kerbs');
const gravel = named(first, 'gravel-traps');
assert(road && grass && kerbs && gravel, 'Monza exposes all four target surface classes');
checkSampling(road.material, 'road asphalt', { range: [0.82, 0.97] });
checkSampling(grass.material, 'grass ground', { range: [0.88, 1] });
checkSampling(gravel.material, 'gravel trap', { range: [0.90, 1] });
checkSampling(kerbs.material, 'painted kerb', { colour: false, range: [0.82, 0.97] });
assert(kerbs.geometry.attributes.uv?.count === kerbs.geometry.attributes.position.count,
  'kerb response has one UV per vertex');
assert(kerbs.material.map === null, 'kerb keeps its vertex-colour paint contract');
assert(kerbs.material.normalMap === road.material.normalMap
  && kerbs.material.roughnessMap === road.material.roughnessMap,
'road and kerb reuse one aligned asphalt response texture set');
assert(gravel.material.map.repeat.x === 4 && gravel.material.map.repeat.y === 4,
  'gravel apron keeps its authored 4x repeat');

const oldNormal = road.material.normalMap;
const oldRoughness = road.material.roughnessMap;
const sharedEnvironment = new THREE.CanvasTexture(makeCanvas());
sharedEnvironment.userData.shared = true;
let sharedDisposeCount = 0;
sharedEnvironment.addEventListener('dispose', () => { sharedDisposeCount++; });
road.material.envMap = sharedEnvironment;
const textures = allTextures(first);
const disposeCounts = new Map();
for (const texture of textures) {
  if (texture.userData.shared) continue;
  disposeCounts.set(texture, 0);
  texture.addEventListener('dispose', () => disposeCounts.set(texture, disposeCounts.get(texture) + 1));
}
first.dispose();
assert([...disposeCounts.values()].every((count) => count === 1),
  'teardown disposes every unique colour/data texture exactly once');
assert(disposeCounts.get(oldNormal) === 1 && disposeCounts.get(oldRoughness) === 1,
  'teardown disposes owned normal and roughness maps exactly once');
assert(sharedDisposeCount === 0,
  'teardown preserves a shared external texture even when attached as envMap');
sharedEnvironment.dispose();
assert(sharedDisposeCount === 1, 'the external owner can dispose its shared texture later');

const restarted = build('monza');
const restartedNormal = named(restarted, 'road').material.normalMap;
assert(restartedNormal !== oldNormal && restartedNormal.uuid !== oldNormal.uuid,
  'restart receives fresh GPU texture objects');
assert(restartedNormal.image === oldNormal.image,
  'restart reuses cached CPU-derived response canvas');
restarted.dispose();

const modern = build('bahrain');
checkSampling(named(modern, 'ground').material, 'gravel venue ground', { range: [0.90, 1] });
checkSampling(named(modern, 'runoff-paint').material, 'painted runoff', { range: [0.84, 0.98] });
modern.dispose();

// The exported helper must preserve non-default UV channels and distinguish
// colour-encoded source pixels from already-linear source data.
const responseSource = makeCanvas();
const srgbAlbedo = new THREE.CanvasTexture(responseSource);
srgbAlbedo.colorSpace = THREE.SRGBColorSpace;
srgbAlbedo.channel = 1;
const linearAlbedo = new THREE.CanvasTexture(responseSource);
linearAlbedo.colorSpace = THREE.LinearSRGBColorSpace;
linearAlbedo.channel = 1;
const p3Albedo = new THREE.CanvasTexture(responseSource);
p3Albedo.colorSpace = THREE.DisplayP3ColorSpace;
p3Albedo.channel = 1;
const srgbResponse = createSurfaceMaps(srgbAlbedo, { size: 16 });
const linearResponse = createSurfaceMaps(linearAlbedo, { size: 16 });
const p3Response = createSurfaceMaps(p3Albedo, { size: 16 });
assert(srgbResponse.normalMap.channel === 1 && srgbResponse.roughnessMap.channel === 1,
  'surface response copies a non-default source UV channel');
const digest = (canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 0x811c9dc5;
  for (const value of data) hash = Math.imul(hash ^ value, 0x01000193);
  return hash >>> 0;
};
assert(digest(srgbResponse.normalMap.image) !== digest(linearResponse.normalMap.image),
  'surface derivation decodes sRGB luminance but leaves linear source values linear');
assert(digest(srgbResponse.normalMap.image) === digest(p3Response.normalMap.image),
  'Display-P3 receives the same nonlinear transfer decoding as sRGB');
for (const texture of [srgbAlbedo, linearAlbedo, p3Albedo, srgbResponse.normalMap,
  srgbResponse.roughnessMap, linearResponse.normalMap, linearResponse.roughnessMap,
  p3Response.normalMap, p3Response.roughnessMap]) texture.dispose();

// A long-lived source requesting many profiles used to retain every response in
// its WeakMap value even after global LRU eviction. Hints are now bounded strings.
const hotSource = makeCanvas();
for (let i = 0; i < 24; i++) {
  const albedo = new THREE.CanvasTexture(hotSource);
  albedo.colorSpace = THREE.SRGBColorSpace;
  const maps = createSurfaceMaps(albedo, {
    size: 8,
    normalStrength: 0.4 + i * 0.031,
    roughnessLow: 0.7 + i * 0.001,
    roughnessHigh: 0.95,
  });
  albedo.dispose(); maps.normalMap.dispose(); maps.roughnessMap.dispose();
}
const cacheStats = getSurfaceResponseCacheStats(hotSource);
assert(cacheStats.retainedResponses <= cacheStats.maxRetainedResponses,
  'global CPU response retention stays inside the 16-entry bound');
assert(cacheStats.retainedResponses === 16 && cacheStats.sourceHints <= 16,
  'more than 16 option requests evict old responses and source hints');
assert(cacheStats.sourceRetainedResponses === 0,
  'per-source hints retain cache-key strings, never response canvases');

// Repeated async upgrades must dispose only the previous helper-owned set. The
// caller's fallback stays external, and material teardown releases the final set.
const originalLoad = THREE.TextureLoader.prototype.load;
let loaderCalls = 0;
THREE.TextureLoader.prototype.load = function (_url, onLoad) {
  loaderCalls++;
  const template = new THREE.CanvasTexture(makeCanvas());
  template.colorSpace = THREE.SRGBColorSpace;
  onLoad(template);
  return template;
};
const fallbackMap = new THREE.CanvasTexture(makeCanvas());
fallbackMap.userData.shared = true;
let fallbackDisposes = 0;
fallbackMap.addEventListener('dispose', () => { fallbackDisposes++; });
const upgradedMaterial = new THREE.MeshStandardMaterial({ map: fallbackMap, roughness: 0.5 });
try {
  assert(await upgradeMaterial(upgradedMaterial, 'asphalt', { normalStrength: 0.8 }),
    'first async material upgrade succeeds');
  assert(fallbackDisposes === 0, 'first upgrade preserves its externally-owned fallback map');
  const firstOwned = [upgradedMaterial.map, upgradedMaterial.normalMap, upgradedMaterial.roughnessMap];
  const firstDisposes = new Map(firstOwned.map(texture => [texture, 0]));
  for (const texture of firstOwned) {
    texture.addEventListener('dispose', () => firstDisposes.set(texture, firstDisposes.get(texture) + 1));
  }
  assert(await upgradeMaterial(upgradedMaterial, 'asphalt', { normalStrength: 1.6 }),
    'second async material upgrade succeeds');
  assert([...firstDisposes.values()].every(count => count === 1),
    'second upgrade disposes every superseded helper-owned texture exactly once');
  assert(fallbackDisposes === 0, 'repeated upgrade still preserves the external fallback');
  assert(upgradedMaterial.roughness === 1,
    'async upgrade treats its encoded roughness values as final');
  const finalOwned = [upgradedMaterial.map, upgradedMaterial.normalMap, upgradedMaterial.roughnessMap];
  const finalDisposes = new Map(finalOwned.map(texture => [texture, 0]));
  for (const texture of finalOwned) {
    texture.addEventListener('dispose', () => finalDisposes.set(texture, finalDisposes.get(texture) + 1));
  }
  upgradedMaterial.dispose();
  assert([...finalDisposes.values()].every(count => count === 1),
    'material teardown disposes the final helper-owned texture set exactly once');
  assert(loaderCalls === 1, 'repeated upgrades reuse the module-owned photo template');
  assert(fallbackDisposes === 0, 'material teardown never disposes the external fallback');
} finally {
  THREE.TextureLoader.prototype.load = originalLoad;
}
fallbackMap.dispose();

console.log(`PBR SURFACE CHECKS PASSED: ${checks}/${checks}`);
