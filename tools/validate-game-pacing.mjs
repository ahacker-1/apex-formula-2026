// Integration gate for fixed-step pacing and simulation-RNG isolation.
//
// This deliberately uses the real RaceSession, AIDriver, and CarPhysics stack.
// It runs the same 60-second scenario behind 30/60/120 Hz render schedules and
// compares exact (unrounded) authoritative state. The second section consumes
// global Math.random once per rendered frame: it stays green only when every
// simulation-domain random draw uses the injected session stream.

import { createHash } from 'node:crypto';

// ---- minimal DOM stubs used by the existing headless race validators ----
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
  fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {},
  fillText() {}, strokeText() {}, createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
  ellipse() {}, bezierCurveTo() {}, setTransform() {}, drawImage() {},
});

globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, style: {}, getContext: ctxStub }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const THREE = await import('three');
const { FixedStepAccumulator, FIXED_DT } = await import('../js/fixedStep.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');

const DURATION_SECONDS = 60;
const PACINGS = [30, 60, 120];
const SESSION_SEED = 0x5eed2026;
const GLOBAL_SEED = 0xc05ce71c;
const PLAYER_ID = DRIVERS[0].id;
const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, boost: false };
const LEGACY_SHARED_RNG = process.env.APEX_LEGACY_RNG_PROBE === '1';

function mulberry32(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  random.state = () => state >>> 0;
  return random;
}

function plainFastestLap(value) {
  return value ? { driverId: value.driverId, time: value.time, name: value.name ?? null } : null;
}

function plainResult(value) {
  if (!value) return null;
  return value.map((row) => ({
    pos: row.pos,
    gridPos: row.gridPos,
    driverId: row.driver?.id ?? null,
    teamId: row.team?.id ?? null,
    isPlayer: row.isPlayer,
    dnf: row.dnf,
    laps: row.laps,
    pits: row.pits,
    bestLap: row.bestLap,
    gapText: row.gapText,
    penaltySeconds: row.penaltySeconds,
    points: row.points,
    fastestLap: row.fastestLap,
  }));
}

function plainInput(input) {
  return input ? {
    steer: input.steer,
    throttle: input.throttle,
    brake: input.brake,
    boost: input.boost,
  } : null;
}

function entryDigest(entry) {
  const p = entry.phys;
  const ai = entry.ai;
  return {
    driverId: entry.driver.id,
    isPlayer: entry.isPlayer,
    lap: entry.lap,
    maxLap: entry.maxLap ?? null,
    lapStart: entry.lapStart,
    lastLap: entry.lastLap,
    bestLap: entry.bestLap,
    lapTimes: [...entry.lapTimes],
    position: entry.position,
    gridPos: entry.gridPos,
    gapText: entry.gapText,
    intervalText: entry.intervalText,
    pitStops: entry.pitStops,
    pitState: entry.pitState ? {
      phase: entry.pitState.phase,
      timer: entry.pitState.timer,
      chosen: entry.pitState.chosen,
      wing: entry.pitState.wing,
    } : null,
    plannedPitLap: entry.plannedPitLap ?? null,
    plannedNext: entry.plannedNext ?? null,
    boxThisLap: entry.boxThisLap,
    finished: entry.finished,
    finishTime: entry.finishTime,
    coolDown: entry.coolDown ?? null,
    dnf: entry.dnf,
    wheelSpin: entry.wheelSpin,
    sectors: [...entry.sectors],
    lastSectors: [...entry.lastSectors],
    bestSectors: [...entry.bestSectors],
    tyreAgeLaps: entry.tyreAgeLaps,
    penaltySeconds: entry.penaltySeconds,
    positionsGained: entry.positionsGained,
    wingDamage: entry.wingDamage,
    trackLimits: entry.trackLimits,
    sectorStage: entry._secStage,
    sectorSplit: [...entry._secSplit],
    offTrackAccum: entry._offAcc,
    offTrackLatched: entry._offLatched,
    contactCooldown: entry._contactCool,
    stuckTime: entry._stuckT ?? 0,
    stuckReference: entry._stuckRef ?? null,
    physics: {
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      heading: p.heading,
      v: p.v,
      gear: p.gear,
      rpmFrac: p.rpmFrac,
      steer: p.steer,
      throttle: p.throttle,
      brake: p.brake,
      battery: p.battery,
      boosting: p.boosting,
      aeroX: p.aeroX,
      xTimer: p._xTimer,
      compound: p.compound,
      wear: p.wear,
      fuel: p.fuel,
      sampleIdx: p.sampleIdx,
      totalDist: p.totalDist,
      progressBase: p.progressBase,
      lapFloor: p._lapFloor,
      wrongWayAccum: p._wrongWayAcc,
      lat: p.lat,
      offTrack: p.offTrack,
      onKerb: p.onKerb,
      slip: p.slip,
      wallHit: p.wallHit,
      slipstream: p.slipstream,
      dirtyAir: p.dirtyAir,
      disabled: p.disabled,
      shiftCooldown: p._shiftCooldown,
      spinJitter: p._spinJitter,
      tyreTemp: p.tyreTemp,
      tyreGrip: p.tyreGrip,
      brakeTemp: p.brakeTemp,
      brakeFade: p.brakeFade,
      pitch: p.pitch,
      roll: p.roll,
      rideBump: p.rideBump,
      bumpTime: p._bumpT,
      ersMode: p.ersMode,
      ersDeploy: p.ersDeploy,
      offTrackTime: p.offTrackTime,
      offTrackSink: p.offTrackSink,
      kerbScrub: p.kerbScrub,
      frontAeroLoss: p.frontAeroLoss,
    },
    ai: ai ? {
      skill: ai.skill,
      avoidOffset: ai.avoidOffset,
      mistakeTimer: ai.mistakeTimer,
      mistakeCooldown: ai.mistakeCooldown,
      lapNoise: ai.lapNoise,
      vscFactor: ai.vscFactor,
      noOvertake: ai.noOvertake,
      yieldOffset: ai.yieldOffset,
      yieldTime: ai.yieldT,
      scrubTime: ai.scrubT,
      defendOffset: ai.defendOffset,
      defendTime: ai.defendT,
      defendSide: ai._defendSide,
      defendMagnitude: ai._defendMag,
      defendCooldown: ai._defendCool,
      defendArmed: ai._defendArmed,
      battleTime: ai.battleT,
      fighting: ai.fighting,
      input: plainInput(ai.input),
    } : null,
  };
}

function sessionDigest(session, autopilot, simulationRandom) {
  return {
    seed: session.seed ?? SESSION_SEED,
    simulationRandomState: simulationRandom.state(),
    mode: session.mode,
    laps: session.laps,
    difficulty: session.difficulty,
    phase: session.phase,
    phaseTime: session.phaseT,
    raceTime: session.raceTime,
    lightsOn: session.lightsOn,
    lightsHold: session.lightsHold,
    lightsOut: !!session.lightsOut,
    jumpStart: session.jumpStart,
    positionTimer: session._posTimer,
    fastestLap: plainFastestLap(session.fastestLap),
    results: plainResult(session.results),
    vsc: { active: session.vsc.active, timeLeft: session.vsc.timeLeft },
    vscEnding: session._vscEnding,
    vscViolation: session._vscViol,
    vscPenalised: session._vscPenalised,
    vscWarned: session._vscWarned,
    blueFlagFor: session.blueFlagFor,
    radioCooldown: session._radioCool,
    radioQueue: session.radioQueue.map((item) => ({ text: item.text, tone: item.tone })),
    playerAutopilot: {
      avoidOffset: autopilot.avoidOffset,
      mistakeTimer: autopilot.mistakeTimer,
      mistakeCooldown: autopilot.mistakeCooldown,
      lapNoise: autopilot.lapNoise,
      defendOffset: autopilot.defendOffset,
      defendTime: autopilot.defendT,
      battleTime: autopilot.battleT,
      input: plainInput(autopilot.input),
    },
    entries: session.entries.map(entryDigest),
  };
}

function digestHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function firstDifference(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return { path, a, b };
  if (typeof a !== 'object') return { path, a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.join('\0') !== bk.join('\0')) return { path: `${path} keys`, a: ak, b: bk };
  for (const key of ak) {
    const diff = firstDifference(a[key], b[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function showValue(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

const originalRandom = Math.random;
Math.random = mulberry32(0x7accc017);
const scene = new THREE.Scene();
const circuit = buildCircuit('monza', TRACKS.monza, scene);

// Populate module-level car/contact-shadow caches before any measured run. This
// keeps a legacy shared-RNG failure attributable to render-cadenced draws rather
// than to first-session asset initialization consuming a one-off random value.
const warmRandom = mulberry32(0x0a11ce55);
const warmSession = new RaceSession({
  scene,
  circuit,
  playerDriverId: PLAYER_ID,
  laps: 1,
  difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true },
  mode: 'race',
  gridOrder: DRIVERS.map((driver) => driver.id),
  onMessage: () => {},
  seed: 0x0a11ce55,
  random: warmRandom,
});
warmSession.dispose();

function runScenario(renderHz, consumeCosmeticRandom) {
  const globalRandom = mulberry32(GLOBAL_SEED);
  const simulationRandom = mulberry32(SESSION_SEED);
  Math.random = globalRandom;

  const session = new RaceSession({
    scene,
    circuit,
    playerDriverId: PLAYER_ID,
    laps: 5,
    difficulty: 1,
    assists: { tc: true, abs: true, autoGear: true },
    mode: 'race',
    gridOrder: null,
    onMessage: () => {},
    seed: SESSION_SEED,
    // Current and intended injection seam. Older RaceSession builds ignore the
    // option, which makes the red isolation section expose their shared RNG.
    ...(LEGACY_SHARED_RNG ? {} : { random: simulationRandom }),
  });
  const autopilot = new AIDriver(
    session.player.phys,
    circuit,
    { pace: 0.95, consistency: 0.97, racecraft: 0.9 },
    1,
    LEGACY_SHARED_RNG ? undefined : simulationRandom,
  );
  const fixed = new FixedStepAccumulator();
  const allPhysics = session.entries.map((entry) => entry.phys);
  let ticks = 0;
  let cosmeticDraws = 0;
  const frames = DURATION_SECONDS * renderHz;

  for (let frame = 0; frame < frames; frame++) {
    fixed.advance(1 / renderHz, (dt) => {
      const input = session.phase === 'racing' && !session.player.finished
        ? autopilot.update(dt, allPhysics)
        : ZERO_INPUT;
      session.update(dt, input);
      ticks++;
    });
    if (consumeCosmeticRandom) {
      Math.random();
      cosmeticDraws++;
    }
  }

  const digest = sessionDigest(session, autopilot, simulationRandom);
  const result = {
    renderHz,
    frames,
    ticks,
    cosmeticDraws,
    globalRandomState: globalRandom.state(),
    hash: digestHash(digest),
    digest,
  };
  session.dispose();
  return result;
}

function compareSection(label, runs, defectSection = false) {
  console.log(`\n=== ${label} ===`);
  for (const run of runs) {
    console.log(`  ${run.renderHz}Hz: frames=${run.frames} ticks=${run.ticks} ` +
      `cosmeticDraws=${run.cosmeticDraws} digest=${run.hash} globalRng=0x${run.globalRandomState.toString(16)}`);
  }

  let green = true;
  const expectedTicks = DURATION_SECONDS / FIXED_DT;
  for (const run of runs) {
    if (run.ticks !== expectedTicks) {
      green = false;
      console.error(`  RED tick count at ${run.renderHz}Hz: ${run.ticks}, expected ${expectedTicks}`);
    }
  }

  const reference = runs.find((run) => run.renderHz === 60) || runs[0];
  for (const run of runs) {
    if (run === reference) continue;
    const diff = firstDifference(reference.digest, run.digest);
    if (diff) {
      green = false;
      console.error(`  RED ${reference.renderHz}Hz vs ${run.renderHz}Hz first authoritative seam:`);
      console.error(`    ${diff.path}`);
      console.error(`    ${reference.renderHz}Hz = ${showValue(diff.a)}`);
      console.error(`    ${run.renderHz}Hz = ${showValue(diff.b)}`);
    }
  }

  if (green) {
    console.log(`  GREEN ${defectSection ? 'simulation RNG is isolated from render-cadenced global draws' : 'authoritative state is exactly pacing-invariant'}`);
  } else if (defectSection) {
    console.error('  RED DEFECT: cosmetic global RNG consumption changed authoritative simulation state.');
  } else {
    console.error('  RED CONTRACT: the fixed-step wrapper did not produce exact cadence parity.');
  }
  return green;
}

let pacingGreen = false;
let isolationGreen = false;
try {
  if (LEGACY_SHARED_RNG) {
    console.log('LEGACY PROBE: simulation intentionally shares global Math.random');
  }
  const pacingRuns = PACINGS.map((hz) => runScenario(hz, false));
  pacingGreen = compareSection('GREEN CONTRACT: FIXED-STEP 30/60/120 PACING', pacingRuns);

  const isolationRuns = PACINGS.map((hz) => runScenario(hz, true));
  isolationGreen = compareSection('RNG ISOLATION: ONE COSMETIC GLOBAL DRAW PER RENDER', isolationRuns, true);
} finally {
  Math.random = originalRandom;
  circuit.dispose();
}

if (!pacingGreen || !isolationGreen) process.exitCode = 1;
console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'}: game pacing integration gate`);
