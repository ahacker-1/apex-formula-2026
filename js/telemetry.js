// Stable JSON encoding for browser-exported laps. No wall-clock fields are
// included, so identical seed/input runs produce byte-identical payloads.

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

export function deterministicJSON(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

// Serializable simulation telemetry used by the cockpit, replay tooling and
// the browser acceptance seam. It reads production state only and contains no
// wall-clock fields, so identical seeded runs remain byte-stable.
export function createTelemetrySnapshot(physics, context = {}) {
  const p = physics || {};
  const wheels = Array.isArray(p.wheels) ? p.wheels.map(wheel => ({
    key: wheel.key,
    slipRatio: finite(wheel.slipRatio),
    slipAngle: finite(wheel.slipAngle),
    normalLoad: finite(wheel.normalLoad),
    surfaceTemp: finite(wheel.surfaceTemp),
    carcassTemp: finite(wheel.carcassTemp),
    pressure: finite(wheel.pressure),
    suspensionDeflection: finite(wheel.suspensionDeflection),
    contact: wheel.contact !== false,
  })) : [];
  return {
    speed: finite(p.v),
    speedKmh: finite(p.kmh),
    gear: finite(p.gear, 1),
    rpm: finite(p.rpmFrac),
    throttle: finite(p.throttle),
    brake: finite(p.brake),
    steer: finite(p.steer),
    longitudinalAcceleration: finite(p.longitudinalAcceleration),
    lateralAcceleration: finite(p.lateralAcceleration),
    yawRate: finite(p.yawRate),
    slipAngle: finite(p.slipAngle ?? p.sideslip),
    aeroBalance: finite(p.aeroBalance, 0.45),
    downforce: finite(p.downforce),
    brakeBias: finite(p.brakeBias, 0.56),
    battery: finite(p.battery, 1),
    ersMode: finite(p.ersMode, 1),
    ersDeploy: finite(p.ersDeploy),
    fuel: finite(p.fuel, 1),
    compound: typeof p.compound === 'string' ? p.compound : 'M',
    tyreWear: finite(p.wear),
    tyreGrip: finite(p.tyreGrip, 1),
    tyreTemp: finite(p.tyreTemp),
    trackWetness: finite(p.surface?.wetness),
    lap: finite(context.lap),
    delta: finite(context.delta),
    wheels,
  };
}

export function downloadTelemetry(filename, value) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const blob = new Blob([deterministicJSON(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(filename || 'apex-formula-telemetry.json').replace(/[^a-z0-9_.-]+/gi, '-');
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
