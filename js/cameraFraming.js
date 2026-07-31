// Deterministic chase-camera composition. Keeping the photographic intent in a
// dependency-free module lets verification inspect it without booting WebGL.
export const CAMERA_FRAMING = Object.freeze({
  // The nose is foreshortened from a chase view, so its visible longitudinal
  // silhouette is shorter than the car's regulation length.
  representativeProjectedLengthM: 3.4,
  representativeCarHeightM: 0.9,
  normalSpeedSamplesMps: Object.freeze([45, 65, 85]),
  targetViewportHeight: Object.freeze([0.15, 0.20]),
  speedEffectCapMps: 90,
  boostFovDegrees: 1,
  lookHeightM: 0.75,
  // Keep the chase camera attached primarily to the car. Looking mostly down
  // the future racing line made the chassis slide sideways in frame before it
  // actually rotated, exaggerating even modest physical sideslip.
  headingAimWeight: 0.72,
  aheadAimWeight: 0.28,
});

// `pull`, `rise`, and `fovSpeed` are deliberately restrained: the car should
// remain the visual anchor as speed builds instead of shrinking into the road.
export const CAMERA_PROFILES = Object.freeze({
  tight: Object.freeze({
    back: 6.6, pull: 0.004, height: 1.65, rise: 0.0014,
    look: 8, fov: 63, fovSpeed: 0.015,
  }),
  broadcast: Object.freeze({
    back: 7.05, pull: 0.003, height: 1.82, rise: 0.0015,
    look: 9.5, fov: 64, fovSpeed: 0.014,
  }),
  cinematic: Object.freeze({
    back: 7.45, pull: 0.0025, height: 2, rise: 0.0016,
    look: 11.5, fov: 65.5, fovSpeed: 0.013,
  }),
});

export function resolveChaseCamera(profileName, speedMps, boosting = false, output = {}) {
  const profile = CAMERA_PROFILES[profileName] || CAMERA_PROFILES.broadcast;
  const finiteSpeed = Number.isFinite(speedMps) ? speedMps : 0;
  const framingSpeed = Math.min(CAMERA_FRAMING.speedEffectCapMps, Math.max(0, finiteSpeed));
  output.back = profile.back + framingSpeed * profile.pull;
  output.height = profile.height + framingSpeed * profile.rise;
  output.look = profile.look;
  output.fov = profile.fov + framingSpeed * profile.fovSpeed +
    (boosting ? CAMERA_FRAMING.boostFovDegrees : 0);
  return output;
}

// A stable composition proxy: the fraction of viewport height occupied by the
// visible car silhouette after chase-view foreshortening. It intentionally
// omits suspension animation and track pitch so regressions are deterministic.
export function estimateCarViewportHeight(profileName, speedMps) {
  const framing = resolveChaseCamera(profileName, speedMps);
  const halfVerticalFov = framing.fov * Math.PI / 360;
  const aimY = CAMERA_FRAMING.lookHeightM - framing.height;
  const aimZ = framing.look + framing.back;
  const aimLength = Math.hypot(aimY, aimZ);
  const forwardY = aimY / aimLength;
  const forwardZ = aimZ / aimLength;
  const upY = forwardZ;
  const upZ = -forwardY;
  const projectedY = [];
  const halfLength = CAMERA_FRAMING.representativeProjectedLengthM / 2;
  for (const y of [0, CAMERA_FRAMING.representativeCarHeightM]) {
    for (const z of [-halfLength, halfLength]) {
      const relativeY = y - framing.height;
      const relativeZ = z + framing.back;
      const depth = relativeY * forwardY + relativeZ * forwardZ;
      const viewY = relativeY * upY + relativeZ * upZ;
      projectedY.push((viewY / depth) / Math.tan(halfVerticalFov));
    }
  }
  return (Math.max(...projectedY) - Math.min(...projectedY)) / 2;
}

export const CAMERA_FRAMING_METRICS = Object.freeze(Object.fromEntries(
  Object.keys(CAMERA_PROFILES).map((profileName) => [profileName, Object.freeze({
    projectedCarViewportHeight: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(estimateCarViewportHeight(profileName, speed).toFixed(4)))),
    distanceM: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(resolveChaseCamera(profileName, speed).back.toFixed(3)))),
    fovDegrees: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(resolveChaseCamera(profileName, speed).fov.toFixed(3)))),
  })]),
));
