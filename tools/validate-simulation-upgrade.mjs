#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checks = 0;

async function check(name, run) {
  checks++;
  try {
    await run();
    console.log(`[simulation-upgrade] PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name, message });
    console.error(`[simulation-upgrade] FAIL ${name}\n  ${message}`);
  }
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function finiteTree(value, label, seen = new Set()) {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${label} contains non-finite number ${value}`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) finiteTree(child, `${label}.${key}`, seen);
}

function stableShape(value) {
  if (Array.isArray(value)) return value.map(stableShape);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableShape(value[key])]));
}

async function importModule(relative) {
  return import(`${pathToFileURL(path.join(ROOT, relative)).href}?acceptance=${Date.now()}`);
}

const moduleContracts = [
  {
    file: 'js/vehicleDynamics.js',
    exports: [['createVehicleState', 'stepVehicleDynamics'], ['createVehicleDynamicsState', 'stepVehicleDynamics'], ['VehicleDynamics']],
  },
  {
    file: 'js/trackState.js',
    exports: [['createTrackState', 'stepTrackState'], ['TrackState']],
  },
  {
    file: 'js/weather.js',
    exports: [['createWeatherTimeline'], ['WeatherTimeline'], ['createWeatherState', 'stepWeather'], ['WeatherSystem']],
  },
  {
    file: 'js/controls.js',
    exports: [['advanceSteeringInput']],
  },
  {
    file: 'js/telemetry.js',
    exports: [['createTelemetrySnapshot'], ['Telemetry']],
    presentation: true,
  },
  {
    file: 'js/cockpit.js',
    exports: [['resolveCockpitPose'], ['CockpitView']],
    presentation: true,
  },
  {
    file: 'js/strategy.js',
    exports: [['StrategyPlanner'], ['createStrategyState', 'stepStrategy'], ['StrategyEngine']],
  },
  {
    file: 'js/damage.js',
    exports: [['createVehicleHealth', 'applyImpactDamage'], ['createDamageState', 'applyDamage'], ['DamageModel']],
  },
  {
    file: 'js/raceControl.js',
    exports: [['createRaceControlState', 'stepRaceControl'], ['RaceControl']],
  },
];

await check('TACN player identity and Greenwood Forest pilot are canonical data', async () => {
  const { TEAMS, DRIVERS, CALENDAR } = await importModule('js/data.js');
  const team = TEAMS.find(item => item.id === 'tacn');
  const player = DRIVERS.find(item => item.id === 'hacker');
  const pilot = CALENDAR.find(item => item.trackId === 'spa');
  assert.ok(team, "js/data.js must include team id 'tacn'");
  assert.equal(team.name, 'AI Consulting Network');
  assert.ok(player, "js/data.js must include player driver id 'hacker'");
  assert.equal(player.team, 'tacn');
  assert.ok(pilot, "js/data.js must include pilot trackId 'spa'");
  assert.equal(pilot.circuitName, 'Greenwood Forest Circuit');
});

await check('Spa geometry is finite, closed-loop compatible, and desktop-quality', async () => {
  const { TRACKS } = await importModule('js/tracks.js');
  const spa = TRACKS.spa;
  assert.ok(spa, "js/tracks.js must include TRACKS.spa");
  assert.ok(Array.isArray(spa.points) && spa.points.length >= 40, 'TRACKS.spa needs at least 40 authored control points');
  assert.ok(spa.lengthKm >= 6.5, `TRACKS.spa lengthKm is unexpectedly short: ${spa.lengthKm}`);
  finiteTree(spa, 'TRACKS.spa');
});

await check('arrow-key steering shaper is deterministic, finite, and symmetric', async () => {
  const { advanceSteeringInput } = await importModule('js/controls.js');
  assert.equal(typeof advanceSteeringInput, 'function', 'js/controls.js must export advanceSteeringInput');
  const run = target => {
    let value = 0;
    const trace = [];
    for (let i = 0; i < 120; i++) {
      value = advanceSteeringInput(value, target, 52, 1 / 60, true);
      trace.push(value);
    }
    return trace;
  };
  const leftA = run(1);
  const leftB = run(1);
  const right = run(-1);
  assert.deepEqual(leftA, leftB, 'identical digital steering input must reproduce exactly');
  assert.ok(leftA.every(Number.isFinite), 'ArrowLeft steering trace contains a non-finite value');
  assert.ok(right.every(Number.isFinite), 'ArrowRight steering trace contains a non-finite value');
  leftA.forEach((value, index) => assert.ok(Math.abs(value + right[index]) < 1e-12, `steering lost symmetry at tick ${index}`));
});

for (const contract of moduleContracts) {
  await check(`${contract.file} exposes a loadable module API`, async () => {
    const absolute = path.join(ROOT, contract.file);
    assert.ok(
      fs.statSync(absolute, { throwIfNoEntry: false })?.isFile(),
      `${contract.file} is missing. Merge the simulation feature branch that owns this canonical module.`,
    );
    const source = read(contract.file);
    if (!contract.presentation) {
      const executableSource = withoutComments(source);
      assert.doesNotMatch(executableSource, /\b(?:window|document|localStorage|sessionStorage)\b/, `${contract.file} must remain directly importable without DOM globals`);
      assert.doesNotMatch(executableSource, /\bMath\.random\s*\(/, `${contract.file} must consume an injected seeded RNG, not Math.random()`);
      assert.doesNotMatch(executableSource, /\b(?:Date\.now|performance\.now)\s*\(/, `${contract.file} must consume simulation time, not wall-clock time`);
    }
    const imported = await importModule(contract.file);
    const keys = Object.keys(imported).sort();
    const satisfied = contract.exports.some(group => group.every(name => typeof imported[name] === 'function'));
    const alternatives = contract.exports.map(group => group.join(' + ')).join(' OR ');
    assert.ok(satisfied, `${contract.file} must export ${alternatives}; found: ${keys.join(', ') || '(none)'}`);
    finiteTree(stableShape(imported), contract.file);
  });
}

await check('CarPhysics publishes enhanced finite simulation outputs', async () => {
  const source = read('js/physics.js');
  const outputGroups = {
    acceleration: ['longitudinalAcceleration', 'acceleration', 'accelG'],
    lateral: ['lateralAcceleration', 'lateralG'],
    yaw: ['yawRate', 'angularVelocity'],
    slip: ['slipAngle', 'tyreSlip'],
    aero: ['aeroBalance', 'downforce'],
  };
  const missing = Object.entries(outputGroups)
    .filter(([, names]) => !names.some(name => new RegExp(`\\b${name}\\b`).test(source)))
    .map(([label, names]) => `${label} (${names.join(' or ')})`);
  assert.ok(
    missing.length === 0,
    `CarPhysics is missing enhanced output families: ${missing.join(', ')}. Publish finite values for telemetry/debug snapshots.`,
  );
});

await check('runtime source has no remote network dependency', () => {
  const files = ['index.html', ...fs.readdirSync(path.join(ROOT, 'js')).filter(name => name.endsWith('.js')).map(name => `js/${name}`)];
  const remote = [];
  for (const file of files) {
    const source = withoutComments(read(file));
    const patterns = file === 'index.html'
      ? [/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi]
      : [
          /\b(?:import|export)\b[^;\n]*?["'](https?:\/\/[^"']+)/g,
          /\bimport\s*\(\s*["'](https?:\/\/[^"']+)/g,
          /\b(?:fetch|WebSocket|EventSource)\s*\(\s*["'](https?:\/\/[^"']+)/g,
        ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) remote.push(`${file}: ${match[1]}`);
    }
    if (/\b(?:WebSocket|EventSource)\s*\(/.test(source)) remote.push(`${file}: live socket API`);
  }
  assert.deepEqual(remote, [], `remote runtime dependencies are forbidden:\n${remote.join('\n')}`);
});

await check('browser acceptance hook and stable data-sim surfaces are wired', () => {
  const runtime = [read('index.html'), ...fs.readdirSync(path.join(ROOT, 'js')).filter(name => name.endsWith('.js')).map(name => read(`js/${name}`))].join('\n');
  const gaps = [];
  if (!/window\.__game\s*=/.test(runtime) || !/\bsnapshot\s*\(/.test(runtime) || !/\bapplyScenario\s*\(/.test(runtime)) {
    gaps.push('Expose snapshot() and applyScenario() on the existing window.__game runtime hook');
  }
  for (const value of ['telemetry', 'cockpit', 'weather', 'damage', 'strategy', 'race-control']) {
    const marker = new RegExp(
      `(?:data-sim-(?:panel|state)=["']${value}["']|setAttribute\\(\\s*["']data-sim-(?:panel|state)["']\\s*,\\s*["']${value}["']|dataset\\.sim(?:Panel|State)\\s*=\\s*["']${value}["'])`,
    );
    if (!marker.test(runtime)) gaps.push(`Missing stable DOM marker for '${value}'`);
  }
  assert.ok(gaps.length === 0, gaps.join('; '));
});

if (failures.length) {
  console.error(`\n[simulation-upgrade] ${failures.length}/${checks} acceptance groups failed:`);
  failures.forEach((failure, index) => console.error(`  ${index + 1}. ${failure.name}: ${failure.message}`));
  process.exitCode = 1;
} else {
  console.log(`\n[simulation-upgrade] ${checks} acceptance groups passed`);
}
