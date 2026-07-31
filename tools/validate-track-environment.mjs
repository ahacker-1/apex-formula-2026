// Focused deterministic validator for weather, evolving track state, grip and
// pooled wet effects. Kept standalone so the offline/static build needs no test
// framework or network dependency.

const noop = () => {};
const makeCanvas = () => ({
  width: 64, height: 64, style: {},
  getContext: () => ({
    fillStyle: '#000', createRadialGradient: () => ({ addColorStop: noop }), fillRect: noop,
  }),
  addEventListener: noop, removeEventListener: noop,
});
globalThis.document = {
  createElement: tag => tag === 'canvas' ? makeCanvas() : { style: {} },
  createElementNS: (_ns, tag) => tag === 'canvas' ? makeCanvas() : { style: {} },
};

const THREE = await import('three');
const { TRACKS } = await import('../js/tracks.js');
const { createWeatherTimeline, WEATHER_LIMITS } = await import('../js/weather.js');
const { createTrackState, TRACK_STATE_LIMITS } = await import('../js/trackState.js');
const {
  Effects, EFFECT_POOL_LIMITS, EFFECT_QUALITY_WEATHER_LIMITS,
} = await import('../js/effects.js');

let checks = 0;
function ok(condition, message) {
  checks++;
  if (!condition) throw new Error(message);
}
function near(a, b, epsilon, message) {
  ok(Math.abs(a - b) <= epsilon, `${message}: ${a} vs ${b}`);
}

const weatherA = createWeatherTimeline({ trackId: 'spa', seed: 'round-8', durationS: 7200 });
const weatherB = createWeatherTimeline({ trackId: 'spa', seed: 'round-8', durationS: 7200 });
ok(JSON.stringify(weatherA.keyframes) === JSON.stringify(weatherB.keyframes),
  'same seed produces byte-equivalent weather keyframes');
ok(weatherA.keyframes.length <= WEATHER_LIMITS.maxKeyframes,
  'weather timeline respects its hard keyframe cap');
for (let t = -500; t < 8500; t += 17.3) {
  const w = weatherA.sample(t, {});
  ok(Object.entries(w).every(([key, value]) =>
    key === 'condition'
      ? ['clear', 'overcast', 'rain'].includes(value)
      : typeof value === 'boolean' || Number.isFinite(value)),
    'weather sampling remains finite outside timeline bounds');
  ok(w.rainfall >= 0 && w.rainfall <= WEATHER_LIMITS.maxRainMmH &&
    w.cloudCover >= 0 && w.cloudCover <= 1 && w.humidity >= 0 && w.humidity <= 1,
  'weather fields remain physically bounded');
}
weatherA.reset(900);
ok(weatherA.forecast(7200, 60).length === WEATHER_LIMITS.maxForecastPoints,
  'forecast is capped independently of requested horizon');

function syntheticState(seed = 'surface-replay') {
  const count = 280;
  const heights = new Float32Array(count);
  const samples = new Array(count);
  const line = new Array(count);
  for (let i = 0; i < count; i++) {
    const u = i / count;
    heights[i] = Math.sin(u * Math.PI * 2) * 10 + Math.sin(u * Math.PI * 6) * 2;
    const angle = u * Math.PI * 2;
    const p = { x: Math.sin(angle) * 1000, z: Math.cos(angle) * 1000 };
    const n = { x: Math.sin(angle), z: Math.cos(angle) };
    samples[i] = { p, n, curv: i % 41 < 15 ? 1 / 110 : -1 / 230 };
    line[i] = { p: { x: p.x + n.x * 1.2, z: p.z + n.z * 1.2 } };
  }
  return createTrackState({
    trackId: 'spa', sampleCount: count, length: 7004, halfWidth: 6.5,
    heights, samples, line, seed, weatherSeed: seed, weatherDurationS: 3600,
  });
}

const stateA = syntheticState();
const stateB = syntheticState();
ok(stateA.publicName === 'Greenwood Forest Circuit', 'Spa exposes the fictional public circuit name');
ok(stateA.segmentCount <= TRACK_STATE_LIMITS.maxSegments,
  'per-segment arrays respect the fixed performance cap');
const traffic = [
  { sampleIndex: 34.5, lateral: 1.2, speed: 72, load: 1.1 },
  { sampleIndex: 118, lateral: -0.8, speed: 48, load: 0.9 },
];
for (let i = 0; i < 480; i++) stateA.advance(0.25, traffic);
for (let i = 0; i < 120; i++) stateB.advance(1, traffic);
for (const key of ['rubber', 'marbles', 'dust', 'temperature', 'wetness', 'puddling', 'lineDrying']) {
  ok(stateA[key].length === stateB[key].length, `${key} replay arrays have equal length`);
  for (let i = 0; i < stateA[key].length; i++) {
    near(stateA[key][i], stateB[key][i], 1e-7, `${key} is invariant to caller frame chunking`);
  }
}

const rubberBefore = syntheticState('rubber').rubber[0];
const rubberState = syntheticState('rubber');
for (let i = 0; i < 800; i++) {
  rubberState.update(0.25, { rainfall: 0, airTemperature: 21, trackTemperature: 34, cloudCover: 0.3, windSpeed: 2 },
    [{ sampleIndex: 0, lateral: 1.2, speed: 70, load: 1 }]);
}
ok(rubberState.rubber[0] > rubberBefore + 0.02, 'repeated racing-line traffic rubbers in its segment');
ok(rubberState.dust[0] < rubberState.profile.initialDust, 'traffic cleans dust from the active line');

const drainage = syntheticState('drainage');
drainage.wetness.fill(0.82);
drainage.puddling.fill(0.45);
drainage.drainage.fill(0.15);
drainage.drainage[1] = 0.95;
for (let i = 0; i < 2400; i++) drainage.update(0.25,
  { rainfall: 0, airTemperature: 20, trackTemperature: 28, cloudCover: 0.4, windSpeed: 4 }, []);
ok(drainage.wetness[1] < drainage.wetness[0] - 0.12,
  'high-drainage segments clear materially faster than basin segments');
ok(drainage.puddling[1] < drainage.puddling[0], 'drained segments retain less puddling');

const grip = syntheticState('grip');
const seg = Math.floor(grip._segmentIndex(50));
grip.rubber[seg] = 1;
const dryGrip = grip.gripAt(50, 1.2, {}).multiplier;
grip.wetness[seg] = 0.86;
grip.puddling[seg] = 0.30;
const wetLine = grip.gripAt(50, 1.2, {});
const wetAlternate = grip.gripAt(50, -3.8, {});
ok(wetLine.multiplier < dryGrip * 0.78, 'standing water materially reduces slick-tyre grip');
ok(wetLine.alternateLineGrip > wetLine.multiplier,
  'wet rubbered line can make the alternate line preferable');
ok(wetAlternate.multiplier > wetLine.multiplier,
  'sampling the alternate lane exposes its wet grip advantage');

for (const index of [-1e12, -0.5, 0, 12.75, 1e12, NaN, Infinity]) {
  for (const lateral of [-100, -7, 0, 7, 100, NaN]) {
    const surface = grip.sampleSurface(index, lateral, {});
    ok(surface.sampleIndex >= 0 && surface.sampleIndex < grip.sampleCount,
      'surface sample index wraps/clamps into range');
    ok(Object.values(surface).every(value => typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)),
      'surface samples never expose NaN/Infinity');
  }
}

// Cheap constructor sweep protects the generic profile for the 23 non-pilot
// circuits without paying to build their full Three.js venue geometry.
for (const [trackId, def] of Object.entries(TRACKS)) {
  const count = Math.max(64, def.points.length);
  const state = createTrackState({
    trackId, sampleCount: count, length: def.lengthKm * 1000, halfWidth: def.width / 2,
    heights: new Float32Array(count), seed: 'all-circuits',
  });
  const sample = state.sampleSurface(count * 4.3, 0, {});
  ok(Number.isFinite(sample.grade) && Number.isFinite(state.gripAt(3, 0, {}).multiplier),
    `${trackId} generic environment remains finite`);
  state.dispose();
}

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function entry() {
  return {
    isPlayer: true, dnf: false,
    phys: {
      disabled: false, pos: { x: 0, z: 0 }, heading: 0.2, v: 64, sampleIdx: 50, lat: 1.2,
      onKerb: false, offTrack: false, offTrackSink: 0, slip: false,
      brake: 0.1, throttle: 0.8, aeroX: false, wallHit: 0,
      circuit: {
        ds: 1,
        samples: Array.from({ length: 280 }, () => ({ p: { x: 0, z: 0 }, t: { x: 0, z: 1 } })),
        heightAt: () => 0,
      },
    },
  };
}
const effectScene = new THREE.Scene();
const effects = new Effects(effectScene, seededRandom(88), { environment: grip });
grip.weather.current.rainfall = 12;
grip.weather.current.windSpeed = 5;
grip.weather.current.windDirection = 1.1;
const effectChildren = effectScene.children.length;
const effectEntry = entry();
for (let i = 0; i < 360; i++) {
  effectEntry.phys.pos.z += effectEntry.phys.v / 60;
  effects.update(1 / 60, [effectEntry]);
}
ok(effects.emissionCounts.rain > 0 && effects.emissionCounts.spray > 0,
  'rainfall and wet asphalt drive visible rain plus tyre spray');
ok(effects.rainData.length === EFFECT_POOL_LIMITS.rain && effects.spray.length === EFFECT_POOL_LIMITS.spray,
  'wet effects retain fixed backing pools');
ok(effectScene.children.length === effectChildren, 'wet updates never grow scene object count');
ok([...effects.rain.geometry.attributes.position.array].every(Number.isFinite) &&
  effects.spray.every(item => item.sprite.position.toArray().every(Number.isFinite)),
  'sustained wet effects remain finite');
effects.setQualityTier('low');
ok(effects.rainLimit === EFFECT_QUALITY_WEATHER_LIMITS.low.rain &&
  effects.sprayLimit === EFFECT_QUALITY_WEATHER_LIMITS.low.spray,
  'adaptive low tier reduces active weather particles');
ok(effects.rainData.slice(effects.rainLimit).every(item => item.life === 0) &&
  effects.spray.slice(effects.sprayLimit).every(item => item.life === 0 && !item.sprite.visible),
  'quality reduction parks excess wet particles without reallocating pools');

for (const state of [stateA, stateB, rubberState, drainage, grip]) state.dispose();
effects.dispose();

console.log(`[track-environment] ${checks} deterministic weather, surface, grip, drainage, rubber and wet-effects checks passed`);
