// Deterministic, allocation-free telemetry shaping for audio.js.
// The simulator's current game loop only supplies the core fields. Everything
// else is optional so richer physics/weather/camera integrations can land
// without changing AudioEngine's public API again.

export const OPPONENT_VOICE_BUDGET = 4;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function saturate(value) {
  const n = finite(value);
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function intensity(value, onValue = 1) {
  if (value === true) return onValue;
  if (!value) return 0;
  return saturate(value);
}

export function createAudioTargets() {
  return {
    rpm: 0, throttle: 0, brake: 0, speed: 0, gear: 1,
    slip: 0, lockup: 0, kerb: 0, roughness: 0, bottoming: 0,
    damage: 0, wetness: 0, rain: 0, spray: 0, cockpit: 0,
    load: 0, boost: 0, regen: 0,
  };
}

// Writes into `out`; callers can reuse one object every frame.
export function deriveAudioTargets(input, out = createAudioTargets()) {
  const s = input || {};
  out.rpm = saturate(s.rpmFrac);
  out.throttle = saturate(s.throttle);
  out.brake = saturate(s.brake);
  out.speed = Math.max(0, finite(s.speed));
  out.gear = Math.max(1, Math.min(8, Math.round(finite(s.gear, 1))));

  out.slip = intensity(s.slip, 0.72);
  out.lockup = Math.max(
    intensity(s.lockup ?? s.tyreLock ?? s.wheelLock),
    out.brake > 0.72 ? out.slip * (out.brake - 0.62) / 0.38 : 0,
  );
  out.kerb = intensity(s.kerb, 0.82);
  out.bottoming = intensity(s.bottoming ?? s.floorStrike ?? s.bottomed);
  out.damage = intensity(s.damage ?? s.damageLevel ?? s.aeroDamage);

  const surface = String(s.surface || '').toLowerCase();
  const offtrack = intensity(s.offtrack, 1);
  const gravel = Math.max(intensity(s.gravel), surface === 'gravel' ? 1 : 0);
  const grass = Math.max(intensity(s.grass), surface === 'grass' ? 1 : 0);
  out.roughness = Math.max(out.kerb * 0.72, offtrack * 0.72, gravel, grass * 0.58,
    intensity(s.surfaceRoughness));

  out.wetness = Math.max(intensity(s.wetness), intensity(s.wetSurface),
    surface === 'wet' ? 0.8 : 0);
  out.rain = Math.max(intensity(s.rain), intensity(s.rainIntensity));
  out.spray = Math.max(intensity(s.spray), out.wetness * saturate(out.speed / 72));

  const view = String((s.camera ?? s.cameraMode ?? s.view) || '').toLowerCase();
  out.cockpit = s.cockpit === true || view === 'cockpit' || view === 'onboard' ? 1 : 0;
  out.load = Math.max(out.throttle, intensity(s.load), intensity(s.lateralLoad),
    intensity(s.gForce == null ? 0 : Math.abs(finite(s.gForce)) / 4));
  out.boost = intensity(s.boost ?? s.ersDeploy ?? s.deploy);
  out.regen = Math.max(intensity(s.regen ?? s.ersRegen),
    out.throttle < 0.1 && out.speed > 14 ? 0.65 : 0);
  return out;
}

// Asymmetric one-pole smoothing makes binary arrow-key changes feel physical:
// fast enough on attack for feedback, slower on release to prevent chatter.
export function smoothTelemetry(current, target, dt, rise = 10, fall = 5) {
  const step = Math.max(0, Math.min(0.1, finite(dt, 1 / 60)));
  const rate = target > current ? rise : fall;
  return current + (target - current) * (1 - Math.exp(-rate * step));
}

export function normalizeOpponentCue(sideOrCue, intensityValue = 1, out = {}) {
  const cue = sideOrCue && typeof sideOrCue === 'object' ? sideOrCue : null;
  const side = finite(cue ? (cue.side ?? cue.pan) : sideOrCue);
  const distance = Math.max(0, finite(cue?.distance, 8));
  const relativeSpeed = finite(cue?.relativeSpeed ?? cue?.closingSpeed,
    saturate(intensityValue) * 40);
  out.id = cue?.id ?? cue?.opponentId ?? 'anonymous';
  out.side = Math.max(-1, Math.min(1, side || 1));
  out.distance = distance;
  out.relativeSpeed = relativeSpeed;
  out.rpm = saturate(cue?.rpmFrac ?? 0.72);
  out.intensity = saturate(cue?.intensity ?? intensityValue) /
    (1 + Math.max(0, distance - 5) * 0.055);
  out.duration = Math.max(0.42, Math.min(1.05,
    finite(cue?.duration, 0.86 - Math.min(0.3, Math.abs(relativeSpeed) / 160))));
  return out;
}
