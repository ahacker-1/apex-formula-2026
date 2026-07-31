// Subsystem damage and reliability model. It intentionally emits performance
// multipliers rather than mutating CarPhysics internals, keeping the integration
// reversible and allowing deterministic headless validation.
const PARTS = Object.freeze(['frontWing', 'floor', 'suspension', 'powerUnit', 'gearbox', 'brakes', 'cooling']);

export function createVehicleHealth() {
  return {
    frontWing: 1, floor: 1, suspension: 1, powerUnit: 1,
    gearbox: 1, brakes: 1, cooling: 1,
    temperature: 0.42,
    suspensionBias: 0,
    puncture: false,
    terminal: false,
    cause: null,
    warnings: [],
  };
}

export function damageSeverity(health) {
  if (!health) return 0;
  const losses = PARTS.map((part) => 1 - finite(health[part], 1));
  return Math.max(health.puncture ? 0.78 : 0, ...losses);
}

export function applyImpactDamage(health, impact = {}, random = () => 0.5) {
  const h = health || createVehicleHealth();
  const force = clamp(impact.severity ?? impact.intensity ?? 0, 0, 1);
  if (force <= 0) return h;
  const front = impact.front !== false;
  const signedSide = clamp(impact.side || 0, -1, 1);
  const side = Math.abs(signedSide);
  if (front) h.frontWing = clamp(h.frontWing - force * (0.38 + random() * 0.28), 0, 1);
  h.floor = clamp(h.floor - force * (0.08 + random() * 0.16), 0, 1);
  if (side > 0.25 || !front) {
    h.suspension = clamp(h.suspension - force * side * (0.22 + random() * 0.3), 0, 1);
    if (side > 0.25) {
      h.suspensionBias = clamp(finite(h.suspensionBias, 0) * 0.35 + signedSide * 0.65, -1, 1);
    }
  }
  if (force > 0.7 && random() < (force - 0.6) * 0.42) h.puncture = true;
  if (h.suspension < 0.08 || (force > 0.94 && random() < 0.22)) {
    h.terminal = true;
    h.cause = 'collision-damage';
  }
  return h;
}

export function stepReliability(health, dt, context = {}, random = () => 0.5) {
  const h = health || createVehicleHealth();
  if (h.terminal) return { failed: true, cause: h.cause, warning: null };
  const stress = clamp(context.stress ?? 0.5, 0, 1.6);
  const wear = clamp(context.raceProgress ?? 0, 0, 1);
  const damage = damageSeverity(h);
  h.temperature = clamp(h.temperature + dt * (stress * 0.012 + damage * 0.008 - 0.007), 0, 1.4);

  // Roughly two field-wide mechanical retirements in a full-length event at
  // nominal stress, with failures becoming more likely late and when damaged.
  const hazard = dt * (0.000010 + wear * 0.000008) * (0.65 + stress * stress) * (1 + damage * 3);
  let warning = null;
  if (random() < hazard * 5) {
    const roll = random();
    const part = roll < 0.32 ? 'powerUnit' : roll < 0.53 ? 'gearbox' : roll < 0.72 ? 'cooling' : roll < 0.88 ? 'brakes' : 'suspension';
    h[part] = clamp(h[part] - (0.08 + random() * 0.2), 0, 1);
    warning = part;
    if (!h.warnings.includes(part)) h.warnings.push(part);
  }
  if (h.cooling < 0.65) h.temperature = clamp(h.temperature + dt * (0.65 - h.cooling) * 0.035, 0, 1.4);
  if (h.temperature > 1.05) h.powerUnit = clamp(h.powerUnit - dt * (h.temperature - 1) * 0.006, 0, 1);
  const failedPart = PARTS.find((part) => h[part] <= (part === 'frontWing' || part === 'floor' ? -1 : 0.04));
  if (failedPart) {
    h.terminal = true;
    h.cause = `${failedPart}-failure`;
  }
  return { failed: h.terminal, cause: h.cause, warning };
}

export function performanceModifiers(health) {
  const h = health || createVehicleHealth();
  return {
    power: clamp(0.58 + h.powerUnit * 0.42, 0.5, 1) * clamp(0.72 + h.cooling * 0.28, 0.65, 1),
    topSpeed: clamp(0.82 + h.powerUnit * 0.18, 0.72, 1),
    grip: clamp(0.5 + h.suspension * 0.3 + h.floor * 0.2, 0.42, 1) * (h.puncture ? 0.55 : 1),
    braking: clamp(0.45 + h.brakes * 0.55, 0.38, 1),
    // Unsided wear/reliability loss reduces grip without silently pulling left.
    // A genuinely sided impact carries a signed bias supplied by collision data.
    steeringBias: clamp(finite(h.suspensionBias, 0), -1, 1) * (1 - h.suspension) * 0.055,
    aeroLoss: clamp((1 - h.frontWing) * 0.72 + (1 - h.floor) * 0.3, 0, 0.85),
  };
}

export function repairPlan(health, timeAvailable = Infinity) {
  const h = health || createVehicleHealth();
  const repairs = [];
  if (h.frontWing < 0.92 && timeAvailable >= 3) repairs.push({ part: 'frontWing', seconds: 3, target: 1 });
  if (h.puncture) repairs.push({ part: 'puncture', seconds: 0, target: false });
  if (h.brakes < 0.6 && timeAvailable >= 6) repairs.push({ part: 'brakes', seconds: 6, target: Math.min(0.82, h.brakes + 0.35) });
  if (h.cooling < 0.58 && timeAvailable >= 8) repairs.push({ part: 'cooling', seconds: 8, target: Math.min(0.8, h.cooling + 0.3) });
  return { repairs, seconds: repairs.reduce((sum, item) => sum + item.seconds, 0) };
}

export function applyRepairPlan(health, plan) {
  for (const item of plan?.repairs || []) {
    if (item.part === 'puncture') health.puncture = false;
    else health[item.part] = item.target;
  }
  return health;
}

function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }
function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, finite(Number(value), lo))); }
