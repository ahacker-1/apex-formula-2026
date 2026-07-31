# iRacing-Inspired Offline Formula Simulation Plan

## Product boundary

This upgrade targets a high-quality, single-player Formula simulation in a web
browser. The pilot experience is Avi Hacker in the AI Consulting Network car at
Greenwood Forest Circuit (`spa`). Arrow keys remain the primary driving input.

Online ranked competition, safety rating, iRating, matchmaking, stewarding
services, licensed Formula One branding, and a literal copy of iRacing are out
of scope.

## What the official iRacing material gets right

The useful lesson is not one visual effect. It is that the car, road, weather,
feedback, and race weekend share one simulation state.

| iRacing strength | Official evidence | Browser-simulator response |
| --- | --- | --- |
| Vehicle-specific dynamics | The [cars archive](https://www.iracing.com/cars/) describes dynamic physics and tyre modelling; the [McLaren MP4-30 page](https://www.iracing.com/cars/new-mclaren/) describes car-specific ERS, MGU, energy storage/depletion and overtaking systems. | Four-corner tyre forces, load transfer, yaw/sideslip, suspension, aero platform, ERS modes, active aero, fuel, damage and finite telemetry in `js/physics.js` and `js/vehicleDynamics.js`. |
| A road that changes | [Track Technology](https://www.iracing.com/track-technology/) connects track geometry, camber and undulations with rubber, surface temperature, shade and evolving grip. | Greenwood uses authored elevation, grade, camber, bump and drainage data plus rubber, marbles, dust, temperature, wetness, puddling and line drying in `js/trackState.js`. |
| Weather that changes driving | The [Weather System](https://www.iracing.com/weather/) describes water interacting with tyres, alternate wet lines, forecasts, spotter calls, rain audio and spray. | Seeded weather drives real surface grip, Intermediate/Wet tyre choice, wet-line strategy, rain/spray visuals and layered audio through `js/weather.js`, `js/trackState.js`, `js/effects.js`, `js/strategy.js` and `js/audio.js`. |
| Driver information, not arcade clutter | The Formula experience emphasizes precision and extracting the car's systems; iRacing's [2026 Season 3 notes](https://support.iracing.com/support/solutions/articles/31000179016-2026-season-3-initial-release-notes-2026-06-09-01-) also document track-map, fuel and tyre UI work. | Seated cockpit, halo, steering wheel, shift lights, two dash pages, proximity radar, track map, per-wheel temperatures/pressures, fuel/ERS/strategy/damage/race-control status and JSON ghost export. |
| Configurable offline race events | The official [AI racing guide](https://support.iracing.com/support/solutions/articles/31000153530-how-to-use-iracing-ai) covers single races and championships with selectable practice, weather, track conditions, time of day and opponent difficulty. | A dedicated TACN weekend exposes physical FP1, Q1/Q2/Q3, formation, start, race, pit strategy, reliability, damage, flags and 22-car AI while preserving quick race, time trial and championship. |
| Iteration backed by measurement | iRacing release notes continually tune tyres, track state, AI, damage and race control instead of treating them as finished effects. | Deterministic Node probes, browser interaction tests, runtime-error/network checks, mobile layout checks and p95/p99 frame budgets are explicit release gates. |

## Delivery map

| Area | Production owner | Completion evidence |
| --- | --- | --- |
| Arrow-key feel | `js/controls.js`, `js/main.js` | Symmetric, frame-rate-stable steering traces; all four arrows exercised through the browser path. |
| Vehicle and contact physics | `js/physics.js`, `js/vehicleDynamics.js`, `js/contact.js` | Four-wheel finite-state probe, braking/cornering envelopes, full lateral collision regression. |
| Physical track and weather | `js/trackState.js`, `js/weather.js`, `js/trackBuilder.js` | Seed/chunking replay, 5,000+ bounded environment checks, dry/damp/wet grip ordering. |
| Formula systems and tyres | `js/strategy.js`, `js/race.js`, `js/damage.js`, `js/raceControl.js` | Real S/M/H/I/W fitting, ERS/fuel targets, repairs/reliability, flags and restart-state probes. |
| Cockpit and telemetry | `js/cockpit.js`, `js/telemetry.js`, `js/hud.js` | Named cockpit camera, stable `data-sim-*` markers, finite snapshot and responsive layout. |
| Offline race weekend and AI | `js/race.js`, `js/ai.js`, `js/main.js`, `js/ui.js` | Earned 22-car FP1/Q1 times, 15 Q2 and 10 Q3 survivors, final grid, formation-to-lights flow. |
| Visual and audio feedback | `js/effects.js`, `js/audio.js`, venue/car render modules | Elevation-aware rain/spray, surface/contact feedback, pooled nearby-car audio and browser WebAudio probe. |
| Quality and stability | `js/quality.js`, Playwright and `tools/validate-*.mjs` | Desktop/mobile adaptive profiles, local-only runtime, console cleanliness and frame-budget gate. |

## Mandatory release loop

1. Build the production modules; do not satisfy a test through a parallel mock
   state.
2. Run the focused deterministic probe for the changed subsystem.
3. Run `npm test` to protect the existing tracks, race loop, physics, assets and
   performance budgets.
4. Run `npm run test:simulation-upgrade` for the TACN/Greenwood contract.
5. Inspect the actual browser at desktop and mobile sizes, exercise the arrow
   keys, and check console/network state.
6. Fix the first real failure and repeat until every gate is green.

## Honest limits

- Greenwood is high-detail authored geometry, not a licensed laser scan.
- The car is the fictional AI Consulting Network entry, not a licensed Formula
  One chassis or livery.
- Keyboard filters can communicate weight and grip, but cannot reproduce a
  force-feedback wheel or motion rig.
- Race control models flags, pacing, neutralization and restarts; it does not
  render a physical safety car.
- Aerodynamics, tyre construction, power-unit systems and damage are bounded
  real-time approximations designed for a browser, not manufacturer-grade
  engineering solvers.

Those limits are deliberate. The quality target is coherent, responsive and
truthful simulation behavior inside the browser—not an unsupported claim of
parity with iRacing's licensed data and desktop hardware stack.
