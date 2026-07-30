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
| `<run-id>-r4-hero-01.png` | low 3/4 view down the 22-car grid | >= 18 of 22 cars visible (occlusion-aware, >= 100 px each); pit building occupies the left/right frame edge (>= 12k px in the 25% edge band AND bbox touches the edge); gantry crosses the upper frame (span >= 25% W, centroid above 50% H); grandstand visible (>= 10k px) |
| `<run-id>-r4-hero-02.png` | car mid-corner at Lesmo 1 | kerb >= 3% of frame AND gravel trap >= 3% of frame; kerb pixels show both red and white paint populations; car at \|curv\| > 1/210; featured car area is 2-3x the measured 22,303 px baseline |
| `<run-id>-r4-hero-03.png` | grandstand pass | grandstand + crowd >= 25% of frame; car >= 8k px; stand backs >= 60% of the car's columns (stand is BEHIND the car) |
| `<run-id>-r4-hero-04.png` | low nose shot toward the gantry | camera <= 1.1 m above the road; car >= 3% of frame; gantry >= 1.2k px with centroid in the upper 60% |
| `<run-id>-r4-hero-05.png` | wide beauty on the main straight | camera on a real straight (\|curv\| < 1/900); tree walls >= 6%; hoardings >= 0.8%; TV screen >= 700 px; featured car area is 2-3x the measured 5,048 px baseline |
| `r4-hero-contracts.png` | machine-readable summary | **JSON body** (the `/shot` sink appends `.png` to everything): schema, fixed capture contract, renderer/DPR settings, overall `pass`, per-shot `camera`/`metrics`/`asserts`, and a `failed[]` list of every missed assertion — this is the loud failure |

Every shot also asserts `frame mean luminance > 25` so a black/broken frame can
never "pass" vacuously, then re-renders its fixed scene and records
`repeatStability`. That comparison scans every pixel and records the unrounded
mean absolute channel difference, true maximum absolute channel difference,
and changed-pixel ratio; a repeat must keep mean <= `1.5`, max <= `8`, and
changed pixels <= `2%` at the two-level threshold. All frames are 2560x1440 at
DPR 1, rendered through the game's own pipeline (buildCircuit scenery,
buildCarMesh cars with the sculpted GLB, and main.js's HDRI/lighting/ACES
pipeline). The ten shipping photo
textures, all three shipping HDRIs, and the sculpted GLB are mandatory. A 404
fails the rig before any image evidence is published; the primitive-car and
generated-lighting fallbacks are intentionally not evidence paths. The
asset gate has a 15-second deadline per request, so a stalled response also
reaches a terminal failed marker instead of leaving `done=false`. The
post-processing order and
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
`ALL FRAMING CONTRACTS PASS`, `CONTRACT FAILURES (n): ...`, or `RIG FAILURE`.
The rig first acquires the server's atomic `.hero-capture.lock` and replaces
the fixed authority file with a unique-run `status: running, pass: false`
marker. A second page receives `409` and cannot overwrite that authority. Each
PNG has the owning run ID in its filename, is POSTed to the devserver `/shot`
sink, fetched back, and accepted only when its persisted bytes have the expected
SHA-256. The full JSON summary replaces the fixed marker and releases ownership
only after the terminal write. On a later failure, a verified `status: failed`
marker replaces the running/candidate marker, so older passing files cannot
masquerade as the current run. Trust `pass:true` only when `activeLock:null` and
the server lock is absent. A non-2xx POST, missing GET, or digest mismatch leaves
`window.__RIG__.pass=false` and
`window.__RIG__.done=true` with a loud final failure status.

The dedicated browser probes cover photo, HDRI, and GLB 404s, a stale prior
success, initial and final `/shot` 500s, a stalled asset, renderer setup
failure, isolated-channel corruption, the disabled partial-rerun path, and the
complete byte-verified happy path. A real two-page probe also proves that a
concurrent invocation cannot steal ownership:

```sh
npx playwright test --config=tests/browser/hero-evidence.config.mjs
```

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

The configured output must be `test-results/visual-evidence/` or one of its
descendants. The config rejects `dist/evidence`, paths outside the repository,
symlink escapes, and disagreeing `APEX_VISUAL_EVIDENCE_DIR` /
`APEX_CAPTURE_DIR` values before the build or an evidence write begins. The
allowed tree is already ignored and outside `dist/`, so it cannot enter a
release artifact. A unique `runs/<run-id>/` directory contains
three primary/repeat PNG pairs and one aggregate metrics JSON for each of
Melbourne day, Bahrain dusk, and Singapore night. Its `manifest.json`
(`apex-formula.visual-evidence/v1`) is the authoritative full record. The root
`manifest.json` is only an atomic pointer carrying the newest run ID, status,
pass/completeness state, and authoritative relative path. An atomic
`.active-run.lock` owns publication while a run is live. Acquisition first
atomically invalidates any stale success as `running/pass:false`, then creates
the active lock under a short manifest-update mutex. Finalization publishes a
terminal pointer with `activeLock` still present, releases actual ownership,
and only then atomically changes `activeLock` to `null`. Crash-injection tests
cover both boundaries. Consumers must trust a pass only when the pointer says
`activeLock:null`; a second invocation cannot steal the root, and an active or
failed run cannot be hidden by an older success. Missing, duplicate,
unexpected, failed, absent, or SHA-mismatched artifacts make the run fail
closed.

Every venue opens three fresh pages/sessions, deliberately advancing them by
0, 600, and 1,800 simulation ticks before freezing. The reset scrubs physics
and thermal/ERS timers, race timing/sectors/pits/penalties/damage, pooled
sparks/smoke/skids, and transient HUD radio/VSC/fastest/flash/message state.
Camera, canonical-state, grid-pose, session-seed, and GTAO-noise fingerprints
must then match exactly. Screenshot comparisons use 160x90 samples and report
the unrounded mean absolute channel difference, true maximum absolute channel
difference, and changed-pixel ratio. Same-page repeats use a two-level channel
threshold; fresh GPU contexts retain the established eight-level rasterisation
threshold. Both require mean <= `1.5` and changed pixels <= `2%`. The production
fix removes stochastic GTAO input rather than widening either budget. PNG
SHA-256 values are recorded and re-read from disk before finalization.

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

The circuit build is seeded per track id, the cars and cameras are fixed poses,
and the production GTAO kernel uses the shared fixed renderer-noise stream.
The hero rig has no gameplay loop or time-dependent capture state, so reruns
produce the same framing. It enforces its immediate repeat at mean absolute
channel difference <= `1.5` and changed-pixel ratio <= `2%` using a two-level
channel threshold. Venue evidence additionally proves the complete frozen-state
and GTAO-noise fingerprints across three fresh, differently aged sessions.
GPU rasterisation differences can still move individual pixel counts by a
fraction of a percent; every framing threshold carries a wide margin over the
measured values (see `metrics` in the JSON — e.g. kerb 16.4% vs the 3% floor,
gravel 19.5% vs 3%, grandstand 30.1% vs 25%).

## Tuning cameras

All framing numbers live in the `SHOTS` object near the top of the script
(arc metres / lateral metres / height above road / fov). The authoritative rig
does not expose a one-shot rerun hook: replacing a PNG without regenerating the
full manifest would invalidate its digest record. Change `SHOTS`, then do one
clean page reload so the running marker, all five images, and final manifest are
republished as one run.

## Notes

- The art itself (car model fidelity, kerb wash-out at close range, etc.) is
  whatever the current game modules produce; this rig owns FRAMING only.
- `tools/shots/` is gitignored — the deliverable is the rig; the images are
  regenerated on demand.
- The rig needs no node_modules (browser importmap resolves `three` to
  `lib/three.module.js`); only the node gate scripts need the repo's
  `node_modules`.
