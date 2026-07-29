# APEX FORMULA 2026

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Play it now

**[Play APEX FORMULA 2026 in your browser](https://apex-formula-2026.vercel.app)**

No download or installation is required.

An original open-wheel racing simulator built with Three.js. It runs in a web
browser with no build step, no CDN, and no runtime network dependency.

APEX FORMULA 2026 includes a fictional 11-team, 22-driver championship and 24
race weekends. Team names, driver names, liveries, engine marques, sponsors,
and visible venue branding are original to this project.

Presented by [The AI Consulting Network](https://theaiconsultingnetwork.com).

> This is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by Formula 1, the FIA, or any real-world racing
> organization, team, driver, circuit, or sponsor. Third-party names and marks
> belong to their respective owners.

## Quick start

The game uses browser ES modules, so serve it over HTTP rather than opening
`index.html` directly:

```bash
git clone https://github.com/ahacker-1/apex-formula-2026.git
cd apex-formula-2026
python3 -m http.server 8341
```

Open <http://localhost:8341>.

For development, `python3 tools/devserver.py 8341 .` adds
`Cache-Control: no-store` so edits appear on a normal reload.

## What is simulated

- A 24-round fictional championship with persistent driver and constructor
  standings.
- Qualifying, standing starts, tyre compounds, wear, pit stops, slipstream,
  dirty air, penalties, AI mistakes, retirements, and fastest laps.
- Active-aero and electric-override systems inspired by a new generation of
  open-wheel racing rules.
- Twenty-one AI opponents with overtaking, defense, braking profiles, and three
  difficulty levels.
- Quick Race, one-click Race Now, Championship, and persistent Time Trial with
  personal-best ghosts and live delta timing.
- Keyboard, gamepad, and responsive touch controls; a legally self-contained
  synthesized engine/effects package; adaptive graphics; and three camera views.

## Controls

| Input | Action |
| --- | --- |
| `W` / `Up` | Throttle |
| `S` / `Down` | Brake or reverse when stopped |
| `A` `D` / `Left` `Right` | Steer |
| `Space` | Electric override boost |
| `Q` / `E` | Shift down / up in manual mode |
| `V` | Change energy deployment mode |
| `P` | Box this lap |
| `C` | Change camera |
| `N` | Toggle driver nametags |
| `M` | Mute |
| `Esc` | Pause |

Gamepads are supported: left stick to steer, triggers for throttle and brake,
the south face button for boost, and bumpers for shifting.

## Development

Node.js 24 is required for the bit-stable headless validation suite. The
browser runtime is vendored; npm installs the matching Three.js version only
for Node-based validation.

```bash
npm ci
npm test
npm run build
npm run test:browser
```

`npm test` runs the track, geometry, physics, race, UI-label, and repository
release gates. `npm run test:browser` launches the production UI in desktop and
mobile Chromium to cover onboarding, accessibility, adaptive rendering,
WebGL recovery, time-trial ghosts, and touch-layout bounds. `npm run build`
creates a deployable static copy in `dist/`.

Individual checks are available through the scripts in `package.json`. The
geometry suite is intentionally thorough and produces verbose output.

### Optional generated audio

The open-source checkout uses the built-in WebAudio synthesizer. The scripts
in `tools/` can generate an optional local sample pack with an ElevenLabs API
key, but generated MP3s are ignored and must not be committed. Anyone using
those scripts is responsible for the service terms and account plan that apply
to their output. After generating the pack, open the local game with
`?sampleAudio=1` (for example, `http://localhost:8341/?sampleAudio=1`) to load
those optional files.

## Project layout

```text
index.html          application shell and import map
css/                menus and in-race presentation
js/data-fictional.js original APEX championship data
js/tracks.js        circuit control-point geometry
js/trackBuilder.js  road, barriers, scenery, and racing line
js/physics.js       vehicle dynamics and energy systems
js/ai.js            opponent driving and racecraft
js/race.js          race direction, timing, pits, and results
js/car.js           3D vehicle model and liveries
js/hud.js           timing tower, dashboard, and overlays
js/ui.js            menus and championship screens
js/audio.js         synthesized audio and optional sample loading
js/quality.js       adaptive graphics presets and frame-time scaling
js/timeTrial.js     persistent personal bests, live delta, and local ghost
lib/                vendored Three.js r160 runtime and add-ons
assets/             project-authored 3D model
textures/           project-authored environment art
tools/              validators, development harnesses, and build scripts
tests/browser/      Playwright desktop/mobile regression coverage
```

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which
explains the scope, validation commands, and asset rules. Please use the issue
templates for bugs and proposals and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Licensing

Original project code and assets are licensed under the
[Apache License 2.0](LICENSE). Copyright ownership is identified in [NOTICE](NOTICE).

The vendored Three.js files in `lib/` remain under the MIT License. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`LICENSES/three.js-MIT.txt`](LICENSES/three.js-MIT.txt). Asset origin and scope
are documented in [ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).

Apache 2.0 does not grant rights to project names, logos, or third-party
trademarks. See [TRADEMARKS.md](TRADEMARKS.md).
