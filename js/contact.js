// Allocation-light 2D contact helpers shared by race collisions and validators.

export const CAR_HALF_LENGTH = 2.48;
export const CAR_HALF_WIDTH = 0.99;
export const CAR_BROADPHASE_RADIUS_SQ = Math.pow(2 * Math.hypot(CAR_HALF_LENGTH, CAR_HALF_WIDTH), 2);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const angleDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export function syncContactBody(out, phys) {
  const heading = phys.heading;
  out.phys = phys;
  out.x = phys.pos.x;
  out.z = phys.pos.z;
  out.fx = Math.sin(heading);
  out.fz = Math.cos(heading);
  out.rx = Math.cos(heading);
  out.rz = -Math.sin(heading);
  out.invMass = 1 / Math.max(1, phys.mass || 830);
  return out;
}

function projectionRadius(body, ax, az) {
  return CAR_HALF_WIDTH * Math.abs(ax * body.rx + az * body.rz) +
    CAR_HALF_LENGTH * Math.abs(ax * body.fx + az * body.fz);
}

// SAT for two oriented car footprints. Returned normal points from B to A.
export function orientedCarContact(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  if (dx * dx + dz * dz > CAR_BROADPHASE_RADIUS_SQ) return null;

  let bestOverlap = Infinity;
  let bestX = 0;
  let bestZ = 0;
  const consider = (axisX, axisZ) => {
    const center = dx * axisX + dz * axisZ;
    const overlap = projectionRadius(a, axisX, axisZ) +
      projectionRadius(b, axisX, axisZ) - Math.abs(center);
    if (overlap <= 0) return false;
    if (overlap < bestOverlap) {
      const direction = center < 0 ? -1 : 1;
      bestOverlap = overlap;
      bestX = axisX * direction;
      bestZ = axisZ * direction;
    }
    return true;
  };

  if (!consider(a.rx, a.rz) || !consider(a.fx, a.fz) ||
      !consider(b.rx, b.rz) || !consider(b.fx, b.fz)) return null;

  // Exact center overlap has no signed projection. Pick a deterministic axis so
  // the solver never emits NaN or depends on object iteration order.
  if (!Number.isFinite(bestOverlap)) return null;
  return { nx: bestX, nz: bestZ, penetration: bestOverlap };
}

export function velocityOf(body, out) {
  out.x = body.fx * body.phys.v;
  out.z = body.fz * body.phys.v;
  return out;
}

export function applyContactVelocity(phys, vx, vz, maxHeadingChange = 0.1) {
  const magnitude = Math.hypot(vx, vz);
  if (!(magnitude > 1e-8)) {
    phys.v = 0;
    return;
  }
  const motionSign = phys.v < 0 ? -1 : 1;
  const targetHeading = Math.atan2(vx * motionSign, vz * motionSign);
  phys.heading += clamp(angleDiff(targetHeading, phys.heading), -maxHeadingChange, maxHeadingChange);
  // The scalar-velocity model cannot retain sideslip. Projecting the resolved
  // vector onto the bounded new heading sheds, rather than invents, energy.
  phys.v = vx * Math.sin(phys.heading) + vz * Math.cos(phys.heading);
}

export function contactSideFor(body, nx, nz, bodyIsA) {
  // `normal` points B -> A. Convert the other car's direction into the local
  // right-axis convention: -1 left, +1 right.
  const towardOtherX = bodyIsA ? -nx : nx;
  const towardOtherZ = bodyIsA ? -nz : nz;
  return clamp(towardOtherX * body.rx + towardOtherZ * body.rz, -1, 1);
}

// +1 means the other body is at this car's nose, -1 at its tail. Keeping this
// separate from the lateral side lets race damage distinguish a front-wing hit
// from a sidepod rub or a car being struck from behind.
export function contactLongitudinalFor(body, nx, nz, bodyIsA) {
  const towardOtherX = bodyIsA ? -nx : nx;
  const towardOtherZ = bodyIsA ? -nz : nz;
  return clamp(towardOtherX * body.fx + towardOtherZ * body.fz, -1, 1);
}
