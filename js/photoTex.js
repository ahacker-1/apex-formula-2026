// Photo/surface texture helpers. Colour maps are sRGB; generated normal and
// roughness maps are linear data. CPU response canvases are cached, while each
// circuit owns the GPU textures that it can safely dispose on teardown.
import * as THREE from 'three';

const manifest = {
  asphalt: 'textures/asphalt.png',
  grass: 'textures/grass.png',
  gravel: 'textures/gravel.png',
  crowd: 'textures/crowd.png',
  treeline: 'textures/treeline.png',
  treeBroadleaf: 'textures/tree-broadleaf.png',
  treePine: 'textures/tree-pine.png',
  treePalm: 'textures/tree-palm.png',
  scrub: 'textures/scrub.png',
  facadeDay: 'textures/facade-day.png',
  facadeNight: 'textures/facade-night.png',
};

const photoCache = new Map();
// Weak source hints retain only small cache-key strings, never response canvases.
// A hint is useful only while its globally-bounded LRU entry is still resident.
const responseKeyBySource = new WeakMap();
const responseLRU = new Map();
const materialEpoch = new WeakMap();
const materialOwnedTextures = new WeakMap();
const materialCleanupHandlers = new WeakMap();
const MAX_CACHED_RESPONSES = 16;
let neutralResponse = null;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function linearChannel(x) {
  x /= 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function samplingKey({ size, normalStrength, roughnessLow, roughnessHigh, cavity }) {
  return `${size}|${normalStrength}|${roughnessLow}|${roughnessHigh}|${cavity}`;
}

function normalizeResponseOptions({
  size = 256,
  normalStrength = 1.2,
  roughnessLow = 0.84,
  roughnessHigh = 0.98,
  cavity = 0.12,
} = {}) {
  const opts = {
    size: Math.max(8, Math.min(1024, Math.round(Number(size) || 256))),
    normalStrength: Math.max(0, Number(normalStrength) || 0),
    roughnessLow: clamp01(Number.isFinite(Number(roughnessLow)) ? Number(roughnessLow) : 0.84),
    roughnessHigh: clamp01(Number.isFinite(Number(roughnessHigh)) ? Number(roughnessHigh) : 0.98),
    cavity: Math.max(0, Number(cavity) || 0),
  };
  if (opts.roughnessLow > opts.roughnessHigh) {
    [opts.roughnessLow, opts.roughnessHigh] = [opts.roughnessHigh, opts.roughnessLow];
  }
  return opts;
}

function fingerprint(data) {
  // Two independent 32-bit streams make accidental reuse for unlike authored
  // tiles vanishingly unlikely, without retaining the source's full pixel copy.
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ (v + i), 0x85ebca6b);
  }
  return `${a >>> 0}:${b >>> 0}`;
}

function rememberResponse(key, value) {
  if (responseLRU.has(key)) responseLRU.delete(key);
  responseLRU.set(key, value);
  while (responseLRU.size > MAX_CACHED_RESPONSES) {
    responseLRU.delete(responseLRU.keys().next().value);
  }
}

function rememberSourceKey(image, optionKey, responseKey) {
  let hints = responseKeyBySource.get(image);
  if (!hints) {
    hints = new Map();
    responseKeyBySource.set(image, hints);
  }
  if (hints.has(optionKey)) hints.delete(optionKey);
  hints.set(optionKey, responseKey);
  while (hints.size > MAX_CACHED_RESPONSES) hints.delete(hints.keys().next().value);
}

export function getSurfaceResponseCacheStats(source) {
  const hints = source ? responseKeyBySource.get(source) : null;
  let sourceRetainedResponses = 0;
  if (hints) {
    for (const value of hints.values()) {
      if (value && typeof value === 'object') sourceRetainedResponses++;
    }
  }
  return {
    retainedResponses: responseLRU.size,
    maxRetainedResponses: MAX_CACHED_RESPONSES,
    sourceHints: hints?.size || 0,
    sourceRetainedResponses,
  };
}

function responseCanvases(image, options = {}, sourceColorSpace = THREE.SRGBColorSpace) {
  const opts = normalizeResponseOptions(options);
  const optionKey = `${samplingKey(opts)}|${sourceColorSpace || 'linear-data'}`;
  const hints = responseKeyBySource.get(image);
  const hintedKey = hints?.get(optionKey);
  if (hintedKey) {
    const sourceHit = responseLRU.get(hintedKey);
    if (sourceHit) {
      rememberResponse(hintedKey, sourceHit);
      rememberSourceKey(image, optionKey, hintedKey);
      return sourceHit;
    }
    hints.delete(optionKey); // stale hint: its bounded LRU entry was evicted
  }

  const sample = document.createElement('canvas');
  sample.width = sample.height = opts.size;
  const sg = sample.getContext('2d', { willReadFrequently: true });
  if (!sg) throw new Error('2D canvas is unavailable for surface response');
  sg.drawImage(image, 0, 0, opts.size, opts.size);
  const src = sg.getImageData(0, 0, opts.size, opts.size);
  const globalKey = `${optionKey}|${fingerprint(src.data)}`;
  let response = responseLRU.get(globalKey);
  if (response) {
    // Refresh LRU order. Cached values are CPU canvases only: a disposed texture
    // from an old circuit can never be handed to a restarted circuit.
    rememberResponse(globalKey, response);
  } else {
    const n = opts.size * opts.size;
    const lum = new Float32Array(n);
    // sRGB and Display-P3 use the same nonlinear transfer curve; their primaries
    // differ, but the scalar height response only needs transfer decoding.
    const decode = (sourceColorSpace === THREE.SRGBColorSpace
      || sourceColorSpace === THREE.DisplayP3ColorSpace)
      ? linearChannel
      : (value) => value / 255;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      lum[i] = decode(src.data[o]) * 0.2126
        + decode(src.data[o + 1]) * 0.7152
        + decode(src.data[o + 2]) * 0.0722;
    }
    const at = (x, y) => lum[((y + opts.size) % opts.size) * opts.size
      + ((x + opts.size) % opts.size)];
    const normalCanvas = document.createElement('canvas');
    const roughnessCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = opts.size;
    roughnessCanvas.width = roughnessCanvas.height = opts.size;
    const ng = normalCanvas.getContext('2d');
    const rg = roughnessCanvas.getContext('2d');
    if (!ng || !rg) throw new Error('2D canvas is unavailable for surface maps');
    const normal = ng.createImageData(opts.size, opts.size);
    const roughness = rg.createImageData(opts.size, opts.size);
    const roughRange = opts.roughnessHigh - opts.roughnessLow;

    for (let y = 0; y < opts.size; y++) {
      for (let x = 0; x < opts.size; x++) {
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
          - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
          - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        const nx = -dx * opts.normalStrength;
        // Canvas rows increase downward while a flipY CanvasTexture's V axis
        // increases upward, so Y needs the opposite sign from X here.
        const ny = dy * opts.normalStrength;
        const inv = 1 / Math.hypot(nx, ny, 1);
        const o = (y * opts.size + x) * 4;
        normal.data[o] = Math.round(clamp01(nx * inv * 0.5 + 0.5) * 255);
        normal.data[o + 1] = Math.round(clamp01(ny * inv * 0.5 + 0.5) * 255);
        normal.data[o + 2] = Math.round(clamp01(inv * 0.5 + 0.5) * 255);
        normal.data[o + 3] = 255;

        // High-frequency contrast raises roughness, while shallow dark cavities
        // get a small extra lift. This preserves the source's authored structure
        // without treating colour hue itself as material data.
        const centre = at(x, y);
        const mean = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.25;
        const detail = clamp01(Math.hypot(dx, dy) * 1.4 + Math.abs(centre - mean) * 3.0);
        const pit = Math.max(0, mean - centre);
        const responseLevel = clamp01(detail + pit * opts.cavity);
        const r = opts.roughnessLow + roughRange * responseLevel;
        const q = Math.round(r * 255);
        roughness.data[o] = roughness.data[o + 1] = roughness.data[o + 2] = q;
        roughness.data[o + 3] = 255;
      }
    }
    ng.putImageData(normal, 0, 0);
    rg.putImageData(roughness, 0, 0);
    response = { normalCanvas, roughnessCanvas };
    rememberResponse(globalKey, response);
  }
  rememberSourceKey(image, optionKey, globalKey);
  return response;
}

function copySampling(target, source) {
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.magFilter = source.magFilter;
  target.minFilter = source.minFilter;
  target.anisotropy = source.anisotropy;
  target.channel = source.channel;
  target.flipY = source.flipY;
  target.repeat.copy(source.repeat);
  target.offset.copy(source.offset);
  target.center.copy(source.center);
  target.rotation = source.rotation;
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  if (!source.matrixAutoUpdate) target.matrix.copy(source.matrix);
  target.colorSpace = THREE.NoColorSpace;
  target.needsUpdate = true;
  return target;
}

function neutralResponseCanvases() {
  if (neutralResponse) return neutralResponse;
  const make = (normal) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is unavailable for neutral surface maps');
    if (typeof g.createImageData === 'function' && typeof g.putImageData === 'function') {
      const data = g.createImageData(8, 8);
      for (let i = 0; i < 64; i++) {
        const o = i * 4;
        if (normal) {
          data.data[o] = data.data[o + 1] = 128;
          data.data[o + 2] = 255;
        } else {
          data.data[o] = data.data[o + 1] = data.data[o + 2] = 242;
        }
        data.data[o + 3] = 255;
      }
      g.putImageData(data, 0, 0);
    } else {
      // Several simulation-only validators intentionally expose just the Canvas
      // fill subset. It still produces the same neutral values in a real canvas.
      g.fillStyle = normal ? 'rgb(128,128,255)' : 'rgb(242,242,242)';
      g.fillRect(0, 0, 8, 8);
    }
    return canvas;
  };
  neutralResponse = { normalCanvas: make(true), roughnessCanvas: make(false) };
  return neutralResponse;
}

// Create circuit-owned data textures aligned exactly to an existing colour map.
// The expensive CPU derivation is cached; the returned GPU resources are fresh.
export function createSurfaceMaps(albedoTexture, options = {}) {
  if (!albedoTexture?.image) throw new TypeError('createSurfaceMaps requires a texture with an image');
  const normalized = normalizeResponseOptions(options);
  let response;
  try {
    response = responseCanvases(albedoTexture.image, normalized, albedoTexture.colorSpace);
  } catch {
    // A tainted canvas, reduced headless 2D implementation, or memory pressure
    // must not prevent a circuit from loading. Neutral linear-data maps preserve
    // the material contract and are byte-for-byte deterministic.
    response = neutralResponseCanvases();
  }
  const normalMap = copySampling(new THREE.CanvasTexture(response.normalCanvas), albedoTexture);
  const roughnessMap = copySampling(new THREE.CanvasTexture(response.roughnessCanvas), albedoTexture);
  // Values are authored as final perceptual roughness, not multipliers intended
  // for an additional material-level scale. Consumers should use roughness = 1.
  roughnessMap.userData.valueRange = [normalized.roughnessLow, normalized.roughnessHigh];
  return { normalMap, roughnessMap };
}

// Resolves to a module-owned template texture or null. Callers that mutate
// sampling state must clone it; upgradeMaterial does so below.
export function loadPhoto(key) {
  if (photoCache.has(key)) return photoCache.get(key);
  const url = manifest[key];
  if (!url) return Promise.resolve(null);
  const pending = new Promise((resolve) => {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
  photoCache.set(key, pending);
  return pending;
}

// Backwards-compatible single-map helper. It benefits from the same response
// cache and always returns a linear-data texture.
export function deriveNormalMap(image, strength = 1.2, size = 512,
  colorSpace = THREE.SRGBColorSpace) {
  const response = responseCanvases(image, { size, normalStrength: strength }, colorSpace);
  const tex = new THREE.CanvasTexture(response.normalCanvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function disposeTextureSet(textures) {
  if (!textures) return;
  for (const texture of [...textures]) texture.dispose();
}

function ensureMaterialCleanup(mat) {
  if (materialCleanupHandlers.has(mat)) return;
  const cleanup = () => {
    // Invalidate an in-flight replacement before releasing the current set.
    materialEpoch.set(mat, (materialEpoch.get(mat) || 0) + 1);
    const owned = materialOwnedTextures.get(mat);
    materialOwnedTextures.delete(mat);
    disposeTextureSet(owned);
    mat.removeEventListener('dispose', cleanup);
    materialCleanupHandlers.delete(mat);
  };
  materialCleanupHandlers.set(mat, cleanup);
  mat.addEventListener('dispose', cleanup);
}

function registerMaterialOwnedTextures(mat, textures) {
  const owned = new Set(textures);
  materialOwnedTextures.set(mat, owned);
  for (const texture of owned) {
    const forget = () => {
      owned.delete(texture);
      texture.removeEventListener('dispose', forget);
    };
    texture.addEventListener('dispose', forget);
  }
  ensureMaterialCleanup(mat);
}

// Async compatibility path. Each request gets private textures and an epoch plus
// dispose listener prevents a late load from reviving a torn-down material. Only
// textures created by this helper are released on replacement; an existing map
// supplied by the caller remains externally owned.
export async function upgradeMaterial(mat, key, {
  repeat,
  normalStrength = 1.2,
  normalScale = 0.65,
  roughnessLow = 0.84,
  roughnessHigh = 0.98,
} = {}) {
  const epoch = (materialEpoch.get(mat) || 0) + 1;
  materialEpoch.set(mat, epoch);
  let disposed = false;
  let tex = null, maps = null, committed = false;
  const onDispose = () => { disposed = true; };
  mat.addEventListener('dispose', onDispose);
  try {
    const template = await loadPhoto(key);
    if (!template || disposed || materialEpoch.get(mat) !== epoch) return false;
    tex = template.clone();
    tex.needsUpdate = true;
    if (repeat) tex.repeat.copy(repeat.isVector2 ? repeat : new THREE.Vector2(repeat[0], repeat[1]));
    else if (mat.map) tex.repeat.copy(mat.map.repeat);
    maps = createSurfaceMaps(tex, { normalStrength, roughnessLow, roughnessHigh });
    if (disposed || materialEpoch.get(mat) !== epoch) return false;

    const previousOwned = materialOwnedTextures.get(mat);
    mat.map = tex;
    mat.normalMap = maps.normalMap;
    mat.roughnessMap = maps.roughnessMap;
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
    mat.roughness = 1; // roughnessMap contains the final target values
    mat.needsUpdate = true;
    materialOwnedTextures.delete(mat);
    registerMaterialOwnedTextures(mat, [tex, maps.normalMap, maps.roughnessMap]);
    committed = true;
    disposeTextureSet(previousOwned);
    return true;
  } catch {
    return false;
  } finally {
    mat.removeEventListener('dispose', onDispose);
    if (!committed) {
      const pending = new Set([tex, maps?.normalMap, maps?.roughnessMap].filter(Boolean));
      disposeTextureSet(pending);
    }
  }
}
