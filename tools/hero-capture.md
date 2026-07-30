# Hero-capture rig (`tools/hero-capture.html`)

Deterministic Monza hero-shot capture with self-verified framing contracts.
It originated during the round-4 framing review because the prior hero images
kept failing on FRAMING, not content: hero-01 (grid) missed the pit building /
grandstand / gantry, and hero-02 (action) framed neither the raised kerbs nor
the gravel trap it was meant to showcase. This rig makes the framing a
measured, re-runnable pass/fail instead of a hope.

## What it produces

| file (in `tools/shots/`) | shot | framing contract (pixel-verified per run) |
| --- | --- | --- |
| `r4-hero-01.png` | low 3/4 view down the 22-car grid | >= 18 of 22 cars visible (occlusion-aware, >= 100 px each); pit building occupies the left/right frame edge (>= 12k px in the 25% edge band AND bbox touches the edge); gantry crosses the upper frame (span >= 25% W, centroid above 50% H); grandstand visible (>= 10k px) |
| `r4-hero-02.png` | car mid-corner at Lesmo 1 | kerb >= 3% of frame AND gravel trap >= 3% of frame; kerb pixels show both red and white paint populations; car at \|curv\| > 1/210; car >= 8k px |
| `r4-hero-03.png` | grandstand pass | grandstand + crowd >= 25% of frame; car >= 8k px; stand backs >= 60% of the car's columns (stand is BEHIND the car) |
| `r4-hero-04.png` | low nose shot toward the gantry | camera <= 1.1 m above the road; car >= 3% of frame; gantry >= 1.2k px with centroid in the upper 60% |
| `r4-hero-05.png` | wide beauty on the main straight | camera on a real straight (\|curv\| < 1/900); tree walls >= 6%; hoardings >= 0.8%; TV screen >= 700 px |
| `r4-hero-contracts.png` | machine-readable summary | **JSON body** (the `/shot` sink appends `.png` to everything): schema, fixed capture contract, renderer/DPR settings, overall `pass`, per-shot `camera`/`metrics`/`asserts`, and a `failed[]` list of every missed assertion — this is the loud failure |

Every shot also asserts `frame mean luminance > 25` so a black/broken frame can
never "pass" vacuously, then re-renders its fixed scene and records
`repeatStability`. All frames are 2560x1440 at DPR 1, rendered through the
game's own pipeline (buildCircuit scenery, buildCarMesh cars with the sculpted
GLB, and main.js's HDRI/lighting/ACES pipeline). The post-processing order and
sizes mirror the adaptive renderer: RenderPass -> half-resolution
ScaledGTAOPass (`blendIntensity=0.72`) -> UnrealBloomPass -> OutputPass ->
FXAAPass, with composer DPR sizing and production day/night bloom settings.

## How to run

```sh
cd <repo root>
python3 tools/devserver.py 8460 .
# then open in a browser:
#   http://127.0.0.1:8460/tools/hero-capture.html
```

The page runs everything on load (~30 s: 5 shots + ~40 verification renders).
Progress streams to the on-page log; when it finishes, the last line is either
`ALL FRAMING CONTRACTS PASS` or `CONTRACT FAILURES (n): ...`. The PNGs and the
JSON summary are POSTed to the devserver `/shot` sink and land in
`tools/shots/`.

Checking the result from a terminal:

```sh
python3 -c "
import json; d = json.load(open('tools/shots/r4-hero-contracts.png'))
print('PASS' if d['pass'] else 'FAIL'); [print(' -', f) for f in d['failed']]"
```

Or from the browser console: `window.__RIG__` (`.pass`, `.failed`, `.shots`).
The completed browser object also exposes the same machine-readable summary as
`window.__RIG__.manifest`.

## Venue evidence bundle

The Playwright venue suite captures the shipping game at a fixed 1600x900 DPR 1
desktop viewport, persisted high graphics, known seed, canonical grid pose, and
explicit 72-degree chase camera. Each fresh page may advance before the test
sees it, so the harness resets every car to its circuit grid slot, collapses
render interpolation, rebuilds the HUD, copies the camera position/look target,
and renders that fixed state. It preserves the day/dusk/night HDR,
renderer-budget, console, and screenshot-health checks while emitting
reviewable evidence:

```sh
cd <repo root>
APEX_VISUAL_EVIDENCE_DIR=test-results/visual-evidence \
APEX_VISUAL_EVIDENCE_PORT=38612 \
  npx playwright test --config=tests/browser/visual-evidence.config.mjs
```

The port is optional; without it the config derives a per-process high port.
The evidence config always builds the current checkout before serving, uses
`reuseExistingServer: false`, disables retries, and records the served origin.
It therefore cannot silently attach to a stale server from another worktree.

`test-results/visual-evidence/` is already ignored and outside `dist/`, so it
cannot enter a release artifact. A unique `runs/<run-id>/` directory contains
three primary/repeat PNG pairs and one aggregate metrics JSON for each of
Melbourne day, Bahrain dusk, and Singapore night. The atomically finalized root
`manifest.json` (`apex-formula.visual-evidence/v1`) records the fixed contract,
served origin, expected venues, completeness/pass state, HDR, camera and grid
fingerprints, renderer/composer/GTAO/FXAA metrics, image-health metrics,
cross-run comparisons, and SHA-256 digests. Missing, duplicate, unexpected, or
failed records make the manifest fail closed.

Every venue opens three fresh pages/sessions. Camera and canonical-grid metrics
must match exactly. Screenshot comparisons use 160x90 samples: mean absolute
RGB difference must be at most `1.5`, and fewer than `2%` of samples may exceed
the noise threshold. Immediate same-page repeats use a two-level threshold;
fresh WebGL contexts use an eight-level threshold to absorb renderer/driver
rounding without accepting composition movement. PNG hash equality is recorded
but not required across GPU/driver stacks.

## How the contracts are measured (no blind pixels)

- **Object masks** are occlusion-aware: the composed frame is rendered with the
  target objects hidden and again shown; the changed pixels are exactly the
  pixels the object wins in the real frame, environment occlusion included.
- **Per-car visibility** (hero-01) uses two flat-colour ID passes (3 bits per
  pass, channels driven to exactly 0/255 via `toneMapped:false`) so depth
  testing resolves car-on-car occlusion, ANDed with the scene diff mask so a
  car hidden behind scenery does not count.
- **World-derived framing**: the pit side, the Lesmo-1 corner run (nearest
  |curv| > 1/210 run to world anchor [500, -1120]), the grandstand instance
  positions and the straight-ness of the camera arc are all recomputed from the
  live circuit each run — nothing is a hardcoded screen coordinate.

## Determinism

The circuit build is seeded per track id, the cars and cameras are fixed poses
(no gameplay loop, no time-dependent state, no `Math.random` in the rig), so
reruns produce the same framing. The hero rig enforces its immediate repeat at
mean absolute RGB difference <= `1.5` and changed-pixel ratio <= `2%` using a
two-level pixel threshold. Venue evidence additionally proves the fixed camera
and grid fingerprints across three fresh sessions and applies the documented
eight-level cross-context threshold. GPU rasterisation differences can move
individual pixel counts by a fraction of a percent; every framing threshold
carries a wide margin over the measured values (see `metrics` in the JSON —
e.g. kerb 16.4% vs the 3% floor, gravel 19.5% vs 3%, grandstand 30.1% vs 25%).

## Tuning cameras

All framing numbers live in the `SHOTS` object near the top of the script
(arc metres / lateral metres / height above road / fov). For live iteration
without reloading: mutate `window.__RIG__.params[name]` in the console, then
`await window.__RIG__.rerun(name)` — it re-renders that shot, re-verifies its
contract and replaces its record and PNG. Bake the winning numbers back into
`SHOTS` and do one clean reload before trusting the result.

## Notes

- The art itself (car model fidelity, kerb wash-out at close range, etc.) is
  whatever the current game modules produce; this rig owns FRAMING only.
- `tools/shots/` is gitignored — the deliverable is the rig; the images are
  regenerated on demand.
- The rig needs no node_modules (browser importmap resolves `three` to
  `lib/three.module.js`); only the node gate scripts need the repo's
  `node_modules`.
