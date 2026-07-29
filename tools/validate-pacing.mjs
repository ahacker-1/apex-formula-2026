// Deterministic contract checks for the render-rate-independent fixed-step core.
//
// Usage: node tools/validate-pacing.mjs

import {
  FIXED_DT,
  MAX_FRAME_DT,
  MAX_STEPS,
  FixedStepAccumulator,
} from '../js/fixedStep.js';

let passed = 0;
let failed = 0;

function check(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  [${detail}]` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
  }
}

function near(actual, expected, tolerance = 1e-12) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function checkNear(actual, expected, label, tolerance = 1e-12) {
  check(near(actual, expected, tolerance), label,
    `actual=${actual} expected=${expected}`);
}

console.log('\n[pacing] fixed-step constants');
checkNear(FIXED_DT, 1 / 60, 'simulation step is 60 Hz');
checkNear(MAX_FRAME_DT, 0.05, 'accepted frame delta is capped at 50 ms');
check(MAX_STEPS === 3, 'at most three simulation ticks run per frame', `MAX_STEPS=${MAX_STEPS}`);

console.log('\n[pacing] 10-second cadence parity');
const cadenceResults = new Map();
for (const hz of [30, 60, 120]) {
  const accumulator = new FixedStepAccumulator();
  const frames = hz * 10;
  const perFrameSteps = [];
  const perFrameAlpha = [];
  let ticks = 0;
  let simulatedDt = 0;
  let droppedDt = 0;
  let tickDtMismatch = 0;
  let stepBoundViolations = 0;
  let alphaBoundViolations = 0;

  for (let frame = 0; frame < frames; frame++) {
    const result = accumulator.advance(1 / hz, (dt) => {
      ticks++;
      if (!near(dt, FIXED_DT)) tickDtMismatch++;
    });
    perFrameSteps.push(result.steps);
    perFrameAlpha.push(result.alpha);
    simulatedDt += result.simulatedDt;
    droppedDt += result.droppedDt;
    if (result.steps > MAX_STEPS) stepBoundViolations++;
    if (result.alpha < 0 || result.alpha >= 1) alphaBoundViolations++;
  }

  check(ticks === 600, `${hz} Hz renders exactly 600 simulation ticks over 10 s`, `ticks=${ticks}`);
  checkNear(simulatedDt, 10, `${hz} Hz simulates exactly 10 s`, 1e-10);
  checkNear(droppedDt, 0, `${hz} Hz drops no time under normal pacing`);
  checkNear(perFrameAlpha.at(-1), 0, `${hz} Hz finishes with no fractional remainder`);
  check(tickDtMismatch === 0, `${hz} Hz callback receives only FIXED_DT`, `mismatches=${tickDtMismatch}`);
  check(stepBoundViolations === 0, `${hz} Hz keeps every frame within the tick bound`,
    `violations=${stepBoundViolations}`);
  check(alphaBoundViolations === 0, `${hz} Hz keeps every interpolation alpha in [0, 1)`,
    `violations=${alphaBoundViolations}`);
  cadenceResults.set(hz, { perFrameSteps, perFrameAlpha });
}

check(cadenceResults.get(30).perFrameSteps.every(steps => steps === 2),
  '30 Hz renders execute two ticks per frame');
check(cadenceResults.get(60).perFrameSteps.every(steps => steps === 1),
  '60 Hz renders execute one tick per frame');
check(cadenceResults.get(120).perFrameSteps.every((steps, i) => steps === (i % 2)),
  '120 Hz renders alternate zero and one tick');
check(cadenceResults.get(120).perFrameAlpha.every((alpha, i) =>
  near(alpha, i % 2 === 0 ? 0.5 : 0)),
  '120 Hz interpolation alpha alternates 0.5 and 0');

console.log('\n[pacing] floating-point tick boundary');
{
  const accumulator = new FixedStepAccumulator();
  const deficit = 1e-12;
  const justShort = accumulator.advance(FIXED_DT - deficit);
  check(justShort.steps === 0, 'a genuine sub-picosecond tick deficit does not advance early',
    `steps=${justShort.steps}`);
  checkNear(justShort.alpha * FIXED_DT, FIXED_DT - deficit,
    'a just-short delta remains in the fractional accumulator', 1e-15);
  const completed = accumulator.advance(deficit);
  check(completed.steps === 1, 'supplying the missing tick fraction advances once',
    `steps=${completed.steps}`);
  checkNear(completed.alpha, 0, 'the completed boundary leaves no fractional remainder');
}

console.log('\n[pacing] hitch cap and recovery');
{
  const accumulator = new FixedStepAccumulator();
  let ticks = 0;
  const hitch = accumulator.advance(0.2, () => { ticks++; });
  check(Object.keys(hitch).join(',') === 'steps,simulatedDt,alpha,droppedDt',
    'advance() returns the complete pacing result contract', Object.keys(hitch).join(','));
  check(hitch.steps === 3 && ticks === 3, 'a 200 ms hitch executes exactly three ticks',
    `steps=${hitch.steps} callbacks=${ticks}`);
  checkNear(hitch.simulatedDt, 0.05, 'a 200 ms hitch simulates only the accepted 50 ms');
  checkNear(hitch.droppedDt, 0.15, 'a 200 ms hitch reports the discarded 150 ms');
  checkNear(hitch.alpha, 0, 'a whole-step hitch leaves no fractional remainder');

  ticks = 0;
  const recovered = accumulator.advance(FIXED_DT, () => { ticks++; });
  check(recovered.steps === 1 && ticks === 1,
    'the next 60 Hz frame recovers to one tick with no backlog spiral',
    `steps=${recovered.steps} callbacks=${ticks}`);
  checkNear(recovered.droppedDt, 0, 'the recovery frame drops no additional time');
  checkNear(recovered.alpha, 0, 'the recovery frame finishes at a tick boundary');
}

console.log('\n[pacing] fractional backlog preservation');
{
  const accumulator = new FixedStepAccumulator();
  const half = accumulator.advance(FIXED_DT / 2);
  check(half.steps === 0, 'half a step does not execute a tick');
  checkNear(half.alpha, 0.5, 'half a step is exposed as interpolation alpha');

  const hitch = accumulator.advance(0.2);
  check(hitch.steps === MAX_STEPS, 'a hitch with pending fractional time remains tick-bounded',
    `steps=${hitch.steps}`);
  checkNear(hitch.droppedDt, 0.15, 'only over-cap hitch time is discarded');
  checkNear(hitch.alpha, 0.5, 'backlog discard preserves the fractional remainder');
  checkNear(FIXED_DT / 2 + 0.2,
    hitch.simulatedDt + hitch.alpha * FIXED_DT + hitch.droppedDt,
    'hitch accounting conserves simulated, retained, and dropped time');

  const recovered = accumulator.advance(FIXED_DT / 2);
  check(recovered.steps === 1, 'the next half-step completes the retained fractional tick');
  checkNear(recovered.alpha, 0, 'fractional hitch recovery finishes at a tick boundary');
}

console.log('\n[pacing] invalid deltas');
{
  const accumulator = new FixedStepAccumulator();
  accumulator.advance(FIXED_DT / 2);
  const invalidDeltas = [NaN, Infinity, -Infinity, -1, 0, null, undefined, '0.016', {}, []];
  for (const value of invalidDeltas) {
    let ticks = 0;
    const result = accumulator.advance(value, () => { ticks++; });
    check(result.steps === 0 && ticks === 0,
      `invalid delta ${String(value)} executes no ticks`);
    checkNear(result.simulatedDt, 0, `invalid delta ${String(value)} simulates no time`);
    checkNear(result.droppedDt, 0, `invalid delta ${String(value)} reports no dropped time`);
    checkNear(result.alpha, 0.5, `invalid delta ${String(value)} preserves pending time`);
  }
}

console.log('\n[pacing] reset');
{
  const accumulator = new FixedStepAccumulator();
  accumulator.advance(FIXED_DT / 2);
  accumulator.reset();
  const afterReset = accumulator.advance(FIXED_DT / 2);
  check(afterReset.steps === 0, 'reset discards a pending half-step');
  checkNear(afterReset.alpha, 0.5, 'post-reset half-step starts from an empty accumulator');
  const completed = accumulator.advance(FIXED_DT / 2);
  check(completed.steps === 1, 'two post-reset half-steps produce exactly one tick');
  checkNear(completed.alpha, 0, 'post-reset tick finishes with no remainder');
}

console.log(`\n${failed ? 'PACING CHECKS FAILED' : 'ALL PACING CHECKS PASSED'}: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
