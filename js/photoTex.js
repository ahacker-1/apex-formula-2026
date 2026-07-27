// Photo-texture pipeline: loads raster textures from /textures when present,
// falls back to the procedural module otherwise, and derives normal maps from
// albedo luminance (Sobel) so photo surfaces get real relief under the sun.
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

const cache = new Map();

// resolves to THREE.Texture or null (missing file / load error)
export function loadPhoto(key) {
  if (cache.has(key)) return cache.get(key);
  const url = manifest[key];
  if (!url) return Promise.resolve(null);
  const p = new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
  cache.set(key, p);
  return p;
}

// Sobel height-from-luminance normal map. strength ~0.6-2.
export function deriveNormalMap(image, strength = 1.2, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0, size, size);
  const src = g.getImageData(0, 0, size, size);
  const out = g.createImageData(size, size);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (src.data[i * 4] * 0.299 + src.data[i * 4 + 1] * 0.587 + src.data[i * 4 + 2] * 0.114) / 255;
  }
  const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      out.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out.data[o + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex; // linear space (normal data) — do NOT set SRGB
}

// Convenience: apply a photo texture + derived normal to a MeshStandardMaterial,
// keeping whatever procedural map the material already has as the fallback.
export async function upgradeMaterial(mat, key, { repeat, normalStrength = 1.2, normalScale = 0.65 } = {}) {
  const tex = await loadPhoto(key);
  if (!tex) return false;
  if (repeat) tex.repeat.copy(repeat.isVector2 ? repeat : new THREE.Vector2(repeat[0], repeat[1]));
  else if (mat.map) tex.repeat.copy(mat.map.repeat);
  mat.map = tex;
  try {
    const nm = deriveNormalMap(tex.image, normalStrength);
    nm.repeat.copy(tex.repeat);
    mat.normalMap = nm;
    mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  } catch { /* normal derivation is best-effort */ }
  mat.needsUpdate = true;
  return true;
}
