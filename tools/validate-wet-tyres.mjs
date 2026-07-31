#!/usr/bin/env node
// Deterministic end-to-end contract for physical intermediate/full-wet tyres.

const noop = () => {};
const context = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '', globalAlpha: 1,
  fillRect: noop, clearRect: noop, beginPath: noop, arc: noop, fill: noop, stroke: noop,
  moveTo: noop, lineTo: noop, quadraticCurveTo: noop, closePath: noop, arcTo: noop,
  fillText: noop, strokeText: noop, save: noop, restore: noop, translate: noop,
  scale: noop, rotate: noop, ellipse: noop, bezierCurveTo: noop, setTransform: noop,
  drawImage: noop, createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }), measureText: () => ({ width: 10 }),
});
globalThis.document = {
  createElement: tag => tag === 'canvas'
    ? { width: 64, height: 64, style: {}, getContext: context, addEventListener: noop, removeEventListener: noop }
    : { style: {} },
  createElementNS: (_ns, tag) => tag === 'canvas'
    ? { width: 64, height: 64, style: {}, getContext: context, addEventListener: noop, removeEventListener: noop }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const THREE = await import('three');
const { COMPOUNDS, CarPhysics } = await import('../js/physics.js');
const { createTelemetrySnapshot } = await import('../js/telemetry.js');
const { TRACKS } = await import('../js/tracks.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { RaceSession } = await import('../js/race.js');
const { DRIVERS } = await import('../js/data.js');

let checks = 0;
function check(condition, label, detail = '') {
  checks++;
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('[wet-tyres] compound definitions and allocation-free physics coupling');
check(COMPOUNDS.I?.wetTyre > 0 && COMPOUNDS.I.wetTyre < COMPOUNDS.W?.wetTyre,
  'intermediate and wet expose ordered water-evacuation capability');
check(COMPOUNDS.M.grip > COMPOUNDS.I.grip && COMPOUNDS.I.grip > COMPOUNDS.W.grip,
  'wet compounds carry a real dry-grip penalty');

let sampledWetTyre = null;
const sample = {
  p: new THREE.Vector3(), t: new THREE.Vector3(0, 0, 1),
  n: new THREE.Vector3(1, 0, 0), curv: 0,
};
const probeCircuit = {
  samples: [sample], N: 1, ds: 2.5, length: 10000, halfWidth: 8, wallOff: 14,
  nearestSample: () => 0,
  lateralAt: position => position.x,
  surfaceAt: (_sampleIndex, _lateral, out) => Object.assign(out, {
    grade: 0, camber: 0, bump: 0, baseGrip: 1, wetness: 0.62,
  }),
  gripAt: (_sampleIndex, _lateral, options, out) => {
    sampledWetTyre = options.wetTyre;
    out.multiplier = 0.8;
    out.wetness = 0.62;
    return out;
  },
};
const probe = new CarPhysics(probeCircuit, { isPlayer: true, random: () => 0.5 });
probe.placeAt(new THREE.Vector3(), 0, 0);
for (const key of ['I', 'W']) {
  probe.setTyre(key);
  probe.step(1 / 60, { steer: 0, throttle: 0, brake: 0, boost: false });
  check(probe.compound === key && sampledWetTyre === COMPOUNDS[key].wetTyre,
    `${key} reaches TrackState grip sampling as the fitted physical compound`);
}
probe.setTyre('not-a-compound');
check(probe.compound === 'M', 'invalid direct tyre requests fail safe to Medium');

console.log('[wet-tyres] dry, damp and standing-water grip ordering');
const scene = new THREE.Scene();
const circuit = buildCircuit('spa', TRACKS.spa, scene);
const track = circuit.trackState;
const result = { surface: {} };
const effectiveGrip = (key, wetness, puddling) => {
  track.setConditions({ wetness, puddling, locked: true });
  return COMPOUNDS[key].grip * track.gripAt(
    Math.round(circuit.N * 0.18), 0, { wetTyre: COMPOUNDS[key].wetTyre }, result,
  ).multiplier;
};
const dry = Object.fromEntries(['S', 'M', 'H', 'I', 'W'].map(key => [key, effectiveGrip(key, 0, 0)]));
check(dry.S > dry.I && dry.M > dry.I && dry.H > dry.I && dry.I > dry.W,
  'every slick beats both rain tyres on a dry track', JSON.stringify(dry));
const damp = Object.fromEntries(['S', 'I', 'W'].map(key => [key, effectiveGrip(key, 0.45, 0.02)]));
check(damp.I > damp.S && damp.I > damp.W,
  'Intermediate is quickest on a damp track', JSON.stringify(damp));
const soaked = Object.fromEntries(['S', 'I', 'W'].map(key => [key, effectiveGrip(key, 0.86, 0.30)]));
check(soaked.W > soaked.I && soaked.I > soaked.S,
  'full Wet is quickest through standing water', JSON.stringify(soaked));

console.log('[wet-tyres] production race start, pit service, visuals and telemetry');
const session = new RaceSession({
  scene, circuit, playerDriverId: DRIVERS[0].id, laps: 12, difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true }, mode: 'race',
  forecast: { wetness: 0.5, trackGrip: damp.I }, random: () => 0.5,
});
const player = session.player;
check(player.phys.compound === 'I' && player.strategyCompound === 'I',
  'a damp race starts on a physically fitted Intermediate');
check(player.plannedPitLap === -1 && player.plannedNext === null,
  'wet starts do not inherit a forced dry-strategy stop');
session._enterPit(player);
check(session.playerChooseTyre('W') && player.pitState.chosen === 'W',
  'player pit selection accepts the full Wet compound');
check(!session.playerChooseTyre('invalid') && player.pitState.chosen === 'W',
  'invalid pit selection cannot replace a valid compound');
player.pitState.phase = 'stopped';
player.pitState.phaseT = 0;
session._updatePit(player, 0);
check(player.phys.compound === 'W' && player.pitState.fittedCompound === 'W',
  'pit service fits full Wet in CarPhysics');
check(player.carHandle.compound === 'W' && player.carHandle.tyreBandMats.length >= 2 &&
    player.carHandle.tyreBandMats.every(material => material.color.getHex() === 0x2f7bff),
  'all live tyre-band materials display full Wet blue');
player.pitState.phaseT = 0;
session._updatePit(player, 0);
check(player.pitState === null && player.strategyCompound === 'W',
  'completed stop publishes the fitted Wet as current strategy state');
const telemetry = createTelemetrySnapshot(player.phys, { lap: player.lap });
check(telemetry.compound === 'W' && Number.isFinite(telemetry.tyreWear) && Number.isFinite(telemetry.tyreGrip),
  'telemetry reports actual fitted Wet, wear and grip');

session.dispose();
console.log(`[wet-tyres] ${checks} deterministic assertions passed`);
