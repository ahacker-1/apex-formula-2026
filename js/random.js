const UINT32_RANGE = 0x1_0000_0000;
const MULBERRY_INCREMENT = 0x6D2B79F5;
const FNV_OFFSET = 0x811C9DC5;
const FNV_PRIME = 0x01000193;

let entropyCounter = 0;
let previousEntropySeed = null;

function mix32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7FEB352D);
  value = Math.imul(value ^ (value >>> 15), 0x846CA68B);
  return (value ^ (value >>> 16)) >>> 0;
}

function hashString(value) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < value.length; i++) {
    const codeUnit = value.charCodeAt(i);
    hash = Math.imul(hash ^ (codeUnit & 0xFF), FNV_PRIME);
    hash = Math.imul(hash ^ (codeUnit >>> 8), FNV_PRIME);
  }
  return mix32(hash ^ value.length);
}

/** Convert a finite number or string into a stable unsigned 32-bit seed. */
export function normalizeSeed(seed) {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new RangeError('A numeric seed must be finite');
    return Math.trunc(seed) >>> 0;
  }
  if (typeof seed === 'string') return hashString(seed);
  throw new TypeError('A seed must be a number or string');
}

/** Derive an independent deterministic stream seed from a root and label. */
export function deriveSeed(root, label) {
  if (typeof label !== 'number' && typeof label !== 'string') {
    throw new TypeError('A seed label must be a number or string');
  }
  const rootSeed = normalizeSeed(root);
  const labelSeed = hashString(`${typeof label}:${label}`);
  return mix32(rootSeed ^ labelSeed ^ 0x9E3779B9);
}

function freshEntropySeed() {
  let entropy;
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const words = new Uint32Array(1);
    cryptoApi.getRandomValues(words);
    entropy = words[0];
  } else {
    const now = Date.now();
    const clock = typeof globalThis.performance?.now === 'function'
      ? Math.trunc(globalThis.performance.now() * 1000)
      : 0;
    entropy = (Math.trunc(Math.random() * UINT32_RANGE)
      ^ (now >>> 0)
      ^ Math.trunc(now / UINT32_RANGE)
      ^ clock) >>> 0;
  }

  entropyCounter = (entropyCounter + 0x9E3779B9) >>> 0;
  let seed = mix32(entropy ^ entropyCounter);
  if (seed === previousEntropySeed) seed = (seed + MULBERRY_INCREMENT) >>> 0;
  previousEntropySeed = seed;
  return seed;
}

/**
 * Create a callable Mulberry32-style PRNG.
 * Calling it returns a float in [0, 1); its current uint32 state is readable.
 */
export function createRandom(seed) {
  let state = arguments.length === 0 ? freshEntropySeed() : normalizeSeed(seed);

  function random() {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  Object.defineProperty(random, 'state', {
    enumerable: true,
    get: () => state >>> 0,
  });
  return random;
}

// Renderer noise must be independent from gameplay/session draw order and
// identical whenever a post-processing pass is reconstructed.
export const RENDERER_NOISE_SEED = 'apex-formula-renderer-noise-v1';

export function createRendererNoiseRandom() {
  return { random: createRandom(RENDERER_NOISE_SEED) };
}
