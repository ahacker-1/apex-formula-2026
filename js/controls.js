// Pure steering-input shaping shared by the live game and deterministic tests.

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export function advanceSteeringInput(current, target, speed, dt, digital = false) {
  const from = clamp(Number.isFinite(current) ? current : 0, -1, 1);
  const to = clamp(Number.isFinite(target) ? target : 0, -1, 1);
  // Fixed simulation ticks are normally 1/60s, but tests and recovery paths may
  // intentionally sample a full second. Preserve the established analog snap in
  // that case instead of imposing a second hidden long-frame clamp here.
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 1);
  const rawVelocity = Number.isFinite(speed) ? speed : 0;
  // Digital direction is symmetric in forward/reverse. Analog retains the
  // established signed-speed curve exactly (the playable reverse range is only
  // -4m/s, where the denominator remains safely positive).
  const velocity = digital ? Math.abs(rawVelocity) : rawVelocity;

  let rate;
  if (to !== 0) {
    rate = digital
      ? 6.8 / (1 + velocity * 0.01)
      : 3.4 / (1 + velocity * 0.02);
    // Binary keys need a decisive crossover through chicanes and corrections;
    // analog sticks retain their established response curve.
    if (digital && from * to < 0) rate *= 1.25;
  } else {
    rate = digital
      ? 9 / (1 + velocity * 0.006)
      : 6 / (1 + velocity * 0.01);
  }

  const next = from + (to - from) * Math.min(1, rate * step);
  return Math.abs(next) < 1e-5 ? 0 : clamp(next, -1, 1);
}
