import assert from 'node:assert/strict';
import { createRandom, deriveSeed, normalizeSeed } from '../js/random.js';

const MULBERRY_INCREMENT = 0x6D2B79F5;
let checks = 0;

function check(name, run) {
  run();
  checks++;
  console.log(`[random] PASS ${name}`);
}

function take(random, count) {
  return Array.from({ length: count }, () => random());
}

check('explicit seeds repeat the same Mulberry32 sequence', () => {
  const expected = [
    0.2577907438389957,
    0.9707721115555614,
    0.7853280142880976,
    0.20616457983851433,
    0.30307188746519387,
  ];
  assert.deepEqual(take(createRandom(123456789), expected.length), expected);
  assert.deepEqual(take(createRandom(123456789), expected.length), expected);
  assert.deepEqual(take(createRandom('repeatable-session'), 64), take(createRandom('repeatable-session'), 64));
});

check('derived labels create stable, separated streams', () => {
  const raceSeed = deriveSeed('session-42', 'race');
  const weatherSeed = deriveSeed('session-42', 'weather');
  assert.equal(raceSeed, 3710214052);
  assert.equal(weatherSeed, 339166789);
  assert.notEqual(raceSeed, weatherSeed);
  assert.deepEqual(take(createRandom(raceSeed), 32), take(createRandom(deriveSeed('session-42', 'race')), 32));
  assert.notDeepEqual(take(createRandom(raceSeed), 32), take(createRandom(weatherSeed), 32));
});

check('number and string normalization is stable', () => {
  assert.equal(normalizeSeed(0), 0);
  assert.equal(normalizeSeed(-0), 0);
  assert.equal(normalizeSeed(-1), 0xFFFFFFFF);
  assert.equal(normalizeSeed(0x1_0000_0001), 1);
  assert.equal(normalizeSeed(91.99), 91);
  assert.equal(normalizeSeed('apex-2026'), 375599659);
  assert.equal(normalizeSeed('APEX 🏁'), 908695345);
  assert.equal(normalizeSeed('apex-2026'), normalizeSeed('apex-2026'));
  assert.notEqual(normalizeSeed('1'), normalizeSeed(1));
});

check('state is readable uint32 data and advances once per draw', () => {
  const random = createRandom(0xFFFF_FFF0);
  assert.equal(random.state, 0xFFFF_FFF0);
  assert.equal(Object.getOwnPropertyDescriptor(random, 'state')?.set, undefined);
  random();
  assert.equal(random.state, (0xFFFF_FFF0 + MULBERRY_INCREMENT) >>> 0);
  const firstState = random.state;
  random();
  assert.equal(random.state, (firstState + MULBERRY_INCREMENT) >>> 0);
  assert.equal(random.state, random.state >>> 0);
});

check('every generated value is finite and inside [0, 1)', () => {
  const random = createRandom('bounds');
  for (let i = 0; i < 100_000; i++) {
    const value = random();
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0 && value < 1, `out-of-range value at draw ${i}: ${value}`);
  }
});

check('explicit seeds never consult global Math.random', () => {
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('global Math.random was used'); };
  try {
    assert.deepEqual(take(createRandom(0), 16), take(createRandom(0), 16));
    assert.deepEqual(take(createRandom('explicit'), 16), take(createRandom('explicit'), 16));
    assert.equal(createRandom(0).state, 0);
  } finally {
    Math.random = originalRandom;
  }
});

check('omitting a seed requests fresh entropy', () => {
  const first = createRandom();
  const second = createRandom();
  assert.equal(first.state, first.state >>> 0);
  assert.equal(second.state, second.state >>> 0);
  assert.notEqual(first.state, second.state);
});

check('invalid seed types fail rather than silently becoming entropy', () => {
  assert.throws(() => normalizeSeed(NaN), RangeError);
  assert.throws(() => normalizeSeed(Infinity), RangeError);
  assert.throws(() => normalizeSeed(null), TypeError);
  assert.throws(() => createRandom(undefined), TypeError);
  assert.throws(() => createRandom(null), TypeError);
  assert.throws(() => deriveSeed('root', null), TypeError);
});

console.log(`[random] ${checks} deterministic RNG checks passed`);
