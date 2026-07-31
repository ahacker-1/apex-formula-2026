// Pure steering-input shaping shared by the live game and deterministic tests.

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export const STEERING_PROFILES = Object.freeze({
  // Calm slows initial turn-in but recentres promptly. The old calm return was
  // slower than balanced, so a supposedly safer profile held lock after the
  // key was released and encouraged correction oscillation.
  calm: Object.freeze({ inputRate: 0.78, returnRate: 1.18, filter: 0.88 }),
  balanced: Object.freeze({ inputRate: 1, returnRate: 1, filter: 1 }),
  direct: Object.freeze({ inputRate: 1.22, returnRate: 1.18, filter: 1.14 }),
});

// Binary keys must not request a full Formula steering rack at 180-300 km/h.
// Low-speed authority is retained for hairpins and recovery, while the high-
// speed envelope maps a held arrow to a physically usable road-wheel angle.
export function digitalSteeringLimit(speed) {
  const velocity = Math.abs(Number.isFinite(speed) ? speed : 0);
  return clamp(1.15 - velocity * 0.0105, 0.42, 1);
}

export function steeringProfile(value) {
  return STEERING_PROFILES[value] || STEERING_PROFILES.balanced;
}

export function advanceSteeringInput(current, target, speed, dt, digital = false, profile = null) {
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

  // Optional keyboard tuning is deliberately multiplicative so callers and
  // deterministic validators that omit it retain the established response.
  if (digital && profile) {
    const cfg = typeof profile === 'string' ? steeringProfile(profile) : profile;
    rate *= to !== 0 ? (cfg.inputRate || 1) : (cfg.returnRate || 1);
    // `filter` is a bounded final-stage response control: lower values smooth
    // noisy key taps, higher values make the same fixed-step curve more direct.
    rate *= clamp(Number.isFinite(cfg.filter) ? cfg.filter : 1, 0.65, 1.35);
  }

  const next = from + (to - from) * Math.min(1, rate * step);
  return Math.abs(next) < 1e-5 ? 0 : clamp(next, -1, 1);
}
