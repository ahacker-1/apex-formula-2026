# Simulation Upgrade Acceptance

This is the mandatory integration contract for the non-online simulation upgrade. It protects the existing suite while the production feature branches land: `npm test` and `npm run test:browser` retain their previous scope, while the complete upgrade gate is explicit.

```sh
npm run test:simulation-upgrade
```

The target must be green before the upgrade is considered integrated. Run its two parts independently while resolving merge failures:

```sh
npm run test:simulation-contract
npm run test:simulation-browser
```

## Product contract

The accepted pilot is the player driver `hacker`, team `tacn` (AI Consulting Network), at track `spa`, whose public fictional venue name is **Greenwood Forest Circuit**. Arrow keys are the primary driving input. The browser must provide a named `cockpit` camera, a visible cockpit dash and telemetry, deterministic weather and track-surface state, finite enhanced vehicle dynamics, stable race-control/damage/strategy state, no remote runtime dependency, and adaptive mobile controls.

The source gate imports pure modules directly in Node. Canonical files and accepted minimum exports are:

| File | Minimum API (either form is accepted) |
| --- | --- |
| `js/vehicleDynamics.js` | `createVehicleState` + `stepVehicleDynamics` (legacy aliases accepted) |
| `js/trackState.js` | `createTrackState`, or `TrackState` |
| `js/weather.js` | `createWeatherTimeline`, or `WeatherTimeline` |
| `js/controls.js` | `advanceSteeringInput` |
| `js/telemetry.js` | `createTelemetrySnapshot`, or `Telemetry` |
| `js/cockpit.js` | `resolveCockpitPose`, or `CockpitView` |
| `js/strategy.js` | `StrategyPlanner` |
| `js/damage.js` | `createVehicleHealth` + `applyImpactDamage` |
| `js/raceControl.js` | `createRaceControlState` + `stepRaceControl`, or `RaceControl` |

Every module must be directly importable in Node. State/dynamics modules (all entries except the cockpit and telemetry presentation modules) must avoid DOM/storage globals, accept simulation time and an injected seeded random stream, and avoid `Math.random()`, `Date.now()` and `performance.now()`. This makes deterministic Node probes possible without preventing cockpit and telemetry renderers from owning presentation code.

`CarPhysics` must also publish finite enhanced output families for longitudinal acceleration, lateral acceleration, yaw/angular velocity, slip angle/tyre slip, and aero balance/downforce. Exact field aliases accepted by the source validator are listed in `tools/validate-simulation-upgrade.mjs`; whichever alias is selected must be included in the browser debug snapshot.

## Browser acceptance API

Production browser tests use the existing test/debug namespace rather than a second global. Driving builds must expose:

```js
window.__game.snapshot();
window.__game.applyScenario(scenario);
```

`snapshot()` must return serializable data with this minimum shape:

```js
{
  state: 'race',
  paused: false,
  player: {
    driverId: 'hacker',
    teamId: 'tacn',
    physics: { /* all numeric leaves finite; includes enhanced outputs */ }
  },
  track: {
    id: 'spa',
    name: 'Greenwood Forest Circuit',
    state: { surface: 'dry', wetness: 0 }
  },
  controls: { throttle: 0, brake: 0, steer: 0 },
  camera: { mode: 'cockpit' },
  telemetry: { visible: true /* finite displayed values */ },
  weather: { condition: 'clear', intensity: 0 },
  raceControl: { state: 'green' },
  damage: { frontWing: 0 },
  strategy: { recommendation: 'stay-out', compound: 'M' },
  quality: { adaptive: true, profile: 'desktop-high' }
}
```

The object is a read-only observation seam except for `applyScenario()`. The scenario method is a deterministic acceptance adapter: applying the same scenario twice at the same seed must produce the same weather, track, race-control, damage and strategy snapshot. The gate uses:

```js
await window.__game.applyScenario({
  weather: { condition: 'rain', intensity: 0.65 },
  track: { surface: 'wet', wetness: 0.6 },
  raceControl: { state: 'vsc' },
  damage: { component: 'frontWing', severity: 0.35 },
  strategy: { recommendation: 'pit-now', compound: 'I' }
});
```

The scenario must flow through the same state models used by the race. It must not replace the simulation with test-only values.

Stable browser markers are required so presentation refactors do not force pixel matching:

- `data-sim-panel="cockpit"`
- `data-sim-panel="telemetry"`
- `data-sim-state="weather"`
- `data-sim-state="damage"`
- `data-sim-state="strategy"`
- `data-sim-state="race-control"`

The marked surfaces must be visible when their state is exercised. Screenshots are behavioral evidence, not golden images; no pixel equality is used.

## Browser flows and budgets

The Playwright target uses its own server port (`127.0.0.1:8342`) and refuses to reuse an existing listener. It exercises:

1. TACN driver and Greenwood Forest selection, launch, local-only requests, and runtime-console health.
2. `ArrowUp`, `ArrowDown`, `ArrowLeft`, and `ArrowRight` through the production keyboard path.
3. `KeyC` cycling into the named cockpit camera, with cockpit and telemetry visible.
4. Pause while throttle is held, input release, resume, and finite recovered physics.
5. Seeded wet surface, rain, VSC, front-wing damage and pit strategy, including repeat stability.
6. A 1440x900 desktop frame sample: p95 at or below 50 ms, p99 at or below 100 ms, with no more than four frames above 50 ms after warm-up.
7. iPhone 13 emulation with no horizontal overflow, visible touch throttle/brake controls, and a non-desktop adaptive quality profile.

Evidence is written per test beneath:

```text
test-results/simulation-upgrade/artifacts/<test-id>/evidence/*.png
```

Playwright also attaches each image to its report. Failure screenshots and traces use the same upgrade artifact root. The entire path is ignored by Git.

## Pre-merge failure interpretation

Before all feature branches are merged, these failures are expected and actionable rather than suppressible:

- missing canonical modules identify the owning feature branch by exact path;
- missing enhanced `CarPhysics` outputs name the absent output families;
- a missing `window.__game.snapshot()` or `window.__game.applyScenario()` reports the required method;
- missing cockpit/telemetry/weather/damage/strategy/race-control markers report the exact attribute;
- browser state mismatches show the required snapshot path and value.

Identity, Spa geometry, arrow steering determinism, and the local-only runtime check should already pass. Any failure in those baseline groups is a regression, not an expected feature-branch gap.
