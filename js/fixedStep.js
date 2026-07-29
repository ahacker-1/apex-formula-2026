// Pure fixed-step pacing for the authoritative simulation. Rendering may arrive
// at any cadence; simulation always advances in 60 Hz ticks.

export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.05;
export const MAX_STEPS = 3;

// Snap only arithmetic noise at a tick boundary. A domain-sized epsilon can
// execute genuine time early; a handful of ULPs repairs 120 Hz half-step sums
// without swallowing a measurable positive deficit.
const STEP_EPSILON = Number.EPSILON * FIXED_DT * 8;
const NOOP = () => {};

export class FixedStepAccumulator {
  #accumulator = 0;

  reset() {
    this.#accumulator = 0;
  }

  advance(rawDt, tick = NOOP) {
    if (typeof tick !== 'function') throw new TypeError('tick must be a function');

    const frameDt = typeof rawDt === 'number' && Number.isFinite(rawDt) && rawDt > 0
      ? rawDt
      : 0;
    const acceptedDt = Math.min(frameDt, MAX_FRAME_DT);
    let droppedDt = frameDt - acceptedDt;

    this.#accumulator += acceptedDt;

    // Consume every complete interval from the backlog, but execute only the
    // bounded number of ticks. Removing any excess whole intervals prevents a
    // spiral of death while retaining the sub-step remainder for interpolation.
    const pendingSteps = Math.floor((this.#accumulator + STEP_EPSILON) / FIXED_DT);
    const steps = Math.min(pendingSteps, MAX_STEPS);
    const discardedSteps = pendingSteps - steps;
    this.#accumulator -= pendingSteps * FIXED_DT;
    droppedDt += discardedSteps * FIXED_DT;

    // The epsilon lets two 120 Hz half-steps meet exactly at a 60 Hz boundary.
    // Normalize its tiny subtraction residue so alpha always remains in [0, 1).
    if (this.#accumulator < 0 && this.#accumulator >= -STEP_EPSILON) this.#accumulator = 0;
    const alpha = Math.max(0, Math.min(this.#accumulator / FIXED_DT, 1 - Number.EPSILON));

    for (let i = 0; i < steps; i++) tick(FIXED_DT);

    return {
      steps,
      simulatedDt: steps * FIXED_DT,
      alpha,
      droppedDt,
    };
  }
}
