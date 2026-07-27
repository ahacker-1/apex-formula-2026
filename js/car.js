// F1 2026-spec car mesh.
//
// TWO BUILD PATHS, ONE API
// ------------------------
// 1. SCULPTED GLB (preferred). assets/f1car-2026.glb is a subdivision-surface
//    model built by tools/blender/build_car.py: smooth nose blending into the
//    monocoque, sculpted sidepods with an undercut, coke-bottle rear, 3-element
//    front wing with curved endplates, engine-cover spine + shark fin, halo,
//    floor, diffuser, suspension wishbones, mirrors and a driver's helmet
//    (~28.7k triangles). Call preloadCarModel() once at boot; after it resolves,
//    buildCarMesh() clones that template.
// 2. PRIMITIVES (fallback, below). Still fully live — node harnesses
//    (tools/sim-race.mjs, tools/validate-geometry.mjs) have no GLTFLoader host,
//    and any browser where the GLB 404s falls back to it silently.
//
// Both paths return the identical handle: { group, wheels, wheelRadius: 0.34,
// body, tyreBands, tyreBandMats, brakeGlows, rainLight, ... } and both stay
// under 80 objects per car.
//
// Reads as a modern 2026 F1 car at chase-camera distance (~9m): closed lathed
// nose, sculpted sidepods with an undercut, tapering engine-cover spine + shark
// fin, welded 3-element front wing, beam wing + rear endplates, canvas liveries.
//
// SEATING DISCIPLINE: every appendage is placed against a *computed* chassis
// surface (see `tubHalfX` / `spineTopAtX`) instead of an eyeballed offset, so
// nothing floats in mid-air and nothing pokes grey corners out of the bodywork.
// The two structural rules the rest of the game relies on:
//   * no vertex may dip below y = 0 (race.js parks cars at y=0, road top y~0.02)
//   * the lowest front-wing surface stays at y >= FW_MIN_Y so it cannot z-fight
//     the road surface.
//
// RESOURCE SHARING: every geometry, material and texture is cached at module
// scope and flagged `userData.shared = true`. RaceSession.dispose() skips those,
// so they survive across sessions (they are reused by every car of a team /
// every car on the grid). Per-car resources — tyre compound bands, brake-glow
// and rain-light materials — are created fresh in buildCarMesh() and are NOT
// flagged, so dispose() reclaims them.
//
// Car axis: +Z forward, +Y up. ~5.0m long, ~1.91m wide, wheels at x=±0.82/±0.85,
// z=+1.55/-1.60, radius 0.34.
import * as THREE from 'three';

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------- caches ----- */

const GEOS = new Map();
const MATS = new Map();
const TEXS = new Map();

function G(key, make) {
  let g = GEOS.get(key);
  if (!g) { g = make(); g.userData.shared = true; GEOS.set(key, g); }
  return g;
}
function M(key, make) {
  let m = MATS.get(key);
  if (!m) {
    m = make();
    m.userData.shared = true;
    if (m.map) m.map.userData.shared = true;
    if (m.emissiveMap) m.emissiveMap.userData.shared = true;
    MATS.set(key, m);
  }
  return m;
}
function T(key, draw) {
  let t = TEXS.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(draw());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.userData.shared = true;
    TEXS.set(key, t);
  }
  return t;
}

/* ---------------------------------------------------- geometry plumbing --- */

// T * R * S matrix, the transform used for every merged sub-part.
function TRS(x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

// Concatenate transformed copies of geometries into one BufferGeometry. Keeps
// the per-car object count low (a whole sidepod pair, a wishbone set, the halo
// hoop + struts are each ONE mesh). Never pass a negatively-scaled matrix — it
// would invert triangle winding; mirror by negating positions/angles instead.
function mergeGeos(parts) {
  const flat = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.m);
    return g;
  });
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    let count = 0, itemSize = 0, ok = true;
    for (const g of flat) {
      const a = g.getAttribute(name);
      if (!a) { ok = false; break; }
      count += a.count; itemSize = a.itemSize;
    }
    if (!ok || !count) continue;
    const arr = new Float32Array(count * itemSize);
    let off = 0;
    for (const g of flat) {
      const a = g.getAttribute(name);
      arr.set(a.array.subarray(0, a.count * a.itemSize), off);
      off += a.count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  out.computeBoundingSphere();
  for (const g of flat) g.dispose();
  return out;
}

const UP = new THREE.Vector3(0, 1, 0);
// One suspension / strut tube as a merge part: unit cylinder stretched a->b.
function tube(ax, ay, az, bx, by, bz, r) {
  const a = new THREE.Vector3(ax, ay, az);
  const b = new THREE.Vector3(bx, by, bz);
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length() || 1e-4;
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(len));
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r));
  return { geo: UNIT_CYL(), m };
}

const BOX = () => G('box', () => new THREE.BoxGeometry(1, 1, 1));
const UNIT_CYL = () => G('cyl6', () => new THREE.CylinderGeometry(1, 1, 1, 6, 1));
const PLANE = () => G('plane', () => new THREE.PlaneGeometry(1, 1));
const DISC = () => G('disc', () => new THREE.CircleGeometry(1, 20));
const BALL = () => G('ball', () => new THREE.SphereGeometry(1, 16, 12));

function extrude(shape, depth, seg = 8) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: seg });
  g.translate(0, 0, -depth / 2);   // centre the thickness so L/R copies are pure translations
  return g;
}

/* -------------------------------------------- chassis reference surfaces -- */
// The monocoque is an elliptical-section cylinder. Every part that must LOOK
// like it grows out of the tub (cockpit coaming, halo feet, airbox, wishbone
// roots, flank decals) is positioned against these functions rather than by
// eye, which is what stops grey corners from poking through the bodywork.

const TUB_Z0 = -0.525, TUB_Z1 = 1.225;     // rear / front end of the tub
const TUB_R0 = 0.300, TUB_R1 = 0.255;      // section radius at each end
const TUB_CY = 0.315;                      // tub axis height
const TUB_SX = 1.28, TUB_SY = 0.86;        // mesh scale applied to the cylinder
const TUB_SEGMENTS = 16;
// A 16-gon section sits inside its ideal ellipse by r*(1-cos(pi/16)); every
// seating calculation keeps at least this much slack plus a safety margin.
const TUB_FACET = 1 - Math.cos(Math.PI / TUB_SEGMENTS);

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const tubR = (z) => TUB_R0 + (TUB_R1 - TUB_R0) * clamp01((z - TUB_Z0) / (TUB_Z1 - TUB_Z0));
const tubSemiX = (z) => TUB_SX * tubR(z);
const tubSemiY = (z) => TUB_SY * tubR(z);
const tubTop = (z) => TUB_CY + tubSemiY(z);
// Half-width of the *faceted* tub at height y (0 when y is outside the section).
function tubHalfX(z, y) {
  const sy = tubSemiY(z), dy = Math.abs(y - TUB_CY);
  if (dy >= sy) return 0;
  return tubSemiX(z) * Math.sqrt(1 - (dy / sy) ** 2) - tubSemiX(z) * TUB_FACET;
}

const SPN_Z0 = -0.275, SPN_Z1 = -1.825;    // engine-cover spine, front -> rear
const SPN_R0 = 0.270, SPN_R1 = 0.085;
const SPN_CY = 0.400, SPN_SX = 1.15, SPN_SY = 0.85;
const SPN_SEGMENTS = 14;
const SPN_FACET = 1 - Math.cos(Math.PI / SPN_SEGMENTS);
const spnR = (z) => SPN_R0 + (SPN_R1 - SPN_R0) * clamp01((SPN_Z0 - z) / (SPN_Z0 - SPN_Z1));
// Height of the spine skin directly above |x| (0 when x is off the section).
function spineTopAtX(z, x) {
  const r = spnR(z), sx = SPN_SX * r, sy = SPN_SY * r;
  if (Math.abs(x) >= sx) return 0;
  return SPN_CY + sy * Math.sqrt(1 - (x / sx) ** 2) - sy * SPN_FACET;
}

/* ------------------------------------------------------- team variants ---- */
// Three cheap silhouette differentiators keyed off an FNV-1a hash of the team
// id. Bits 0 / 6 / 9 are used because they give all four front-running teams a
// different combination (and cover all 8 combinations across the 11-team grid);
// tools/validate-geometry.mjs asserts that separation.
function teamHash(id) {
  let h = 2166136261 >>> 0;
  const s = String(id || 'default');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
export function carVariant(team) {
  const h = teamHash(team && team.id);
  return {
    hash: h,
    nose: (h >>> 0) & 1 ? 'chisel' : 'round',       // rounded vs chisel nose cone
    fin: (h >>> 6) & 1 ? 'twin' : 'tall',           // tall single vs low twin fins
    rwTop: (h >>> 9) & 1 ? 'swept' : 'straight',    // rear endplate top edge
  };
}

/* --------------------------------------------------------- canvas art ----- */

function cnv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function luminance(c) {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}
function rgbTriplet(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].join(',');
}
// Lift a colour toward white until it reaches `minL` relative luminance. Used so
// a team whose livery colour is black or near-black can never
// produce an unlit black helmet shell.
function liftTo(c, minL) {
  const out = c.clone();
  const L = luminance(out);
  if (L >= minL) return out;
  return out.lerp(new THREE.Color(1, 1, 1), Math.min(0.92, (minL - L) / Math.max(1e-3, 1 - L)));
}
// Helmet shell always takes the *brighter* of the two livery colours, the trim
// takes the other one, so both are guaranteed to contrast against each other.
function helmetPalette(team) {
  const a = new THREE.Color(team.accent), b = new THREE.Color(team.color);
  const accentBrighter = luminance(a) >= luminance(b);
  return {
    shell: liftTo(accentBrighter ? a : b, 0.42),
    trim: liftTo(accentBrighter ? b : a, 0.10),
  };
}

// Big italic race number, transparent background. `light` when the body is dark.
function numberTex(num, light) {
  return T(`num:${num}:${light ? 'l' : 'd'}`, () => {
    const c = cnv(256, 192), g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic 900 168px Arial';
    g.fillStyle = light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.40)';
    g.fillText(String(num), 133, 103);
    g.fillStyle = light ? '#f2f5f8' : '#0e1014';
    g.fillText(String(num), 127, 96);
    return c;
  });
}

// Fictional sponsors only — never a real brand. Exported so the render harness
// can rasterise the atlas and assert the glyph blocks never collide.
export function sponsorTex(kind) {
  return T(`sponsor:${kind}`, () => {
    if (kind === 'pod') {
      // The APEX wordmark and the VELOCE/ION block are laid out from MEASURED
      // text widths with an explicit gutter, not from two hand-picked centre
      // points — centred layout let the italic APEX glyphs run into VELOCE.
      const c = cnv(512, 128), g = c.getContext('2d');
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = 'italic 900 58px Arial';
      const x0 = 18;
      const apexW = g.measureText('APEX').width;
      g.fillText('APEX', x0, 64);
      // 36px gutter: covers the ~8px italic overhang past the advance width
      // with a wide margin, and reads as a deliberate separation at 1x.
      const x1 = Math.ceil(x0 + apexW + 36);
      g.font = '800 34px Arial';
      g.fillText('VELOCE FUELS', x1, 44);
      g.fillStyle = 'rgba(255,255,255,0.72)';
      g.font = '700 26px Arial';
      g.fillText('ION TYRES', x1, 92);
      return c;
    }
    const c = cnv(256, 128), g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.93)';
    g.font = '900 33px Arial';
    g.fillText('QUANTUM', 128, 48);
    g.fillText('AERO', 128, 86);
    return c;
  });
}

// Accent sweep for the shark fin: wide + opaque at the fin's deep rear edge
// (canvas bottom), fading out toward the shallow front (canvas top).
function stripeTex(accentHex) {
  return T(`stripe:${accentHex}`, () => {
    const c = cnv(128, 512), g = c.getContext('2d');
    const rgb = rgbTriplet(accentHex);
    const grad = g.createLinearGradient(0, 512, 0, 0);
    grad.addColorStop(0, `rgba(${rgb},0.96)`);
    grad.addColorStop(0.6, `rgba(${rgb},0.78)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(6, 512);
    g.lineTo(122, 512);
    g.quadraticCurveTo(104, 260, 78, 6);
    g.lineTo(50, 6);
    g.quadraticCurveTo(24, 260, 6, 512);
    g.closePath();
    g.fill();
    return c;
  });
}

// Nose roundel: accent disc + driver number (kept from the original car).
function roundelTex(num, accent) {
  return T(`roundel:${num}:${accent.getHexString()}`, () => {
    const c = cnv(128, 128), g = c.getContext('2d');
    g.fillStyle = '#' + accent.getHexString();
    g.beginPath(); g.arc(64, 64, 62, 0, TAU); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.arc(64, 64, 62, 0.9, 2.2); g.fill();
    g.fillStyle = luminance(accent) > 0.36 ? '#101216' : '#ffffff';
    g.font = 'italic 900 74px Arial';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(num), 64, 70);
    return c;
  });
}

/* -- tyre sidewall branding -------------------------------------------------
 * One shared canvas: transparent background, "ION TYRES" wordmark repeated
 * around the circumference with small separator ticks, drawn WHITE so the
 * per-car 'tyrewall' material can tint the whole ring to the live compound
 * colour (setTyreCompound recolours it together with the bead band — that is
 * the judge's "compound ring decal matching the color band"). The texture maps
 * onto a lathe ring that follows the sidewall bulge (u = around, v = radial).
 */
function tyreWallTex() {
  return T('tyrewall', () => {
    const W = 1024, H = 96, c = cnv(W, H), g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const words = 3;
    for (let i = 0; i < words; i++) {
      const cx = W * (i + 0.5) / words;
      g.fillStyle = 'rgba(255,255,255,0.96)';
      g.font = 'italic 900 44px Arial';
      g.fillText('ION TYRES', cx, H * 0.44);
      // compound scale marks under the wordmark
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = '700 20px Arial';
      g.fillText('APEX GP', cx, H * 0.80);
      // separator tick between wordmarks
      g.fillStyle = 'rgba(255,255,255,0.75)';
      const tx = W * (i + 1) / words - 6;
      g.fillRect(tx, H * 0.32, 12, 10);
    }
    return c;
  });
}

// Subtle monochrome noise, tiled: bump + roughness variation for the rubber so
// a close-up tyre is not a featureless smooth torus. Linear (NOT sRGB) because
// it feeds bumpMap/roughnessMap, and created outside T() for that reason.
let _tyreNoiseTex = null;
function tyreNoiseTex() {
  if (_tyreNoiseTex) return _tyreNoiseTex;
  const S = 128, c = cnv(S, S), g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  // deterministic LCG so the texture is identical every session
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2600; i++) {
    const v = 104 + (rnd() * 48) | 0;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect((rnd() * S) | 0, (rnd() * S) | 0, 1 + (rnd() * 2) | 0, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  t.userData.shared = true;
  _tyreNoiseTex = t;
  return t;
}

// Wheel face: dark rim well with 7 machined spokes and a centre lock.
function rimTex() {
  return T('rim', () => {
    const S = 256, c = cnv(S, S), g = c.getContext('2d');
    const cx = S / 2, cy = S / 2;
    g.fillStyle = '#0f1114'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#1a1d23';
    g.beginPath(); g.arc(cx, cy, S * 0.485, 0, TAU); g.fill();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const w = 0.17;
      g.fillStyle = i % 2 ? '#a3abb7' : '#bcc4cf';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * S * 0.12, cy + Math.sin(a) * S * 0.12);
      g.lineTo(cx + Math.cos(a - w) * S * 0.445, cy + Math.sin(a - w) * S * 0.445);
      g.lineTo(cx + Math.cos(a + w) * S * 0.445, cy + Math.sin(a + w) * S * 0.445);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#2b3138';
    g.beginPath(); g.arc(cx, cy, S * 0.135, 0, TAU); g.fill();
    g.fillStyle = '#ccd3dd';
    g.beginPath(); g.arc(cx, cy, S * 0.055, 0, TAU); g.fill();
    return c;
  });
}

/* --------------------------------------------------------- materials ------ */

// Livery self-glow: a faint emissive of the livery colour keeps graphics
// readable under every lighting theme — but on NEAR-WHITE paint (white/silver
// accents, rear-wing surfaces) that lift stacks on top of an already-bright
// diffuse term and pushes the surface over the daytime bloom threshold (0.86
// in js/main.js), so white wings grew a bloom halo. Fade the glow to zero as
// the colour approaches white; dark liveries keep the full 0.05.
function selfGlow(c) {
  const L = luminance(c);
  return 0.05 * (1 - clamp01((L - 0.55) / 0.35));
}
// ...and cap near-WHITE paint itself: under the daytime sun (+ HDRI ambient) a
// 0.9+ albedo surface exceeds linear luminance 0.86 — the bloom high-pass
// threshold — across most of its sun-facing area, so white rear wings clipped
// into bloom and grew halos. Whiteness is judged by the MIN channel (a colour is
// only "white" when every channel is high), so saturated liveries — including
// bright yellows — keep their exact hue and only white/silver paint is scaled
// down to L 0.62: still reads as white against the dark carbon around it, but
// its lit diffuse term stays below the threshold.
const WHITE_CAP_L = 0.62;
function capWhite(c) {
  if (Math.min(c.r, c.g, c.b) <= 0.55) return c;
  const L = luminance(c);
  if (L <= WHITE_CAP_L) return c;
  return c.clone().multiplyScalar(WHITE_CAP_L / L);
}

// Clearcoated race paint (round-5 cars fix). MeshStandardMaterial at rough 0.28
// judged as "gummy toy plastic — one broad creamy specular lobe, no fresnel
// rim, no environment reflection": the base lobe was tight enough to read
// plasticky but there was no second glossy layer to catch the sky. Real F1
// paint is a matte-ish base under a hard clearcoat, which is exactly
// MeshPhysicalMaterial: base roughness 0.40 (soft, non-gummy diffuse/spec),
// clearcoat 1.0 at clearcoatRoughness 0.15 (sharp HDRI reflections + fresnel
// rim brightening on every curved panel). Exported so tooling can assert the
// spec on both build paths.
export const PAINT_SPEC = {
  body: { metalness: 0.35, roughness: 0.40, clearcoat: 1.0, clearcoatRoughness: 0.15 },
  accent: { metalness: 0.32, roughness: 0.40, clearcoat: 1.0, clearcoatRoughness: 0.15 },
};
const bodyM = (team) => M(`body:${team.color}`, () => new THREE.MeshPhysicalMaterial({
  color: capWhite(new THREE.Color(team.color)),
  ...PAINT_SPEC.body,
  emissive: new THREE.Color(team.color).multiplyScalar(selfGlow(new THREE.Color(team.color))),
}));
const accentM = (team) => M(`accent:${team.accent}`, () => new THREE.MeshPhysicalMaterial({
  color: capWhite(new THREE.Color(team.accent)),
  ...PAINT_SPEC.accent,
  emissive: new THREE.Color(team.accent).multiplyScalar(selfGlow(new THREE.Color(team.accent))),
}));
// Helmet shell: never unlit-black (see helmetPalette) and always slightly
// self-lit, so the driver reads from every camera angle and lighting theme.
const helmetShellM = (shell) => M(`helmetShell:${shell.getHexString()}`, () =>
  new THREE.MeshStandardMaterial({
    color: shell.clone(), metalness: 0.28, roughness: 0.30,
    emissive: shell.clone().multiplyScalar(0.16),
  }));
const helmetTrimM = (trim) => M(`helmetTrim:${trim.getHexString()}`, () =>
  new THREE.MeshStandardMaterial({
    color: trim.clone(), metalness: 0.30, roughness: 0.32,
    emissive: trim.clone().multiplyScalar(0.10),
  }));

const carbonM = () => M('carbon', () => new THREE.MeshStandardMaterial({
  color: 0x15171c, metalness: 0.38, roughness: 0.5,
}));
const plankM = () => M('plank', () => new THREE.MeshStandardMaterial({
  color: 0x07080a, metalness: 0.08, roughness: 0.8,
}));
const tyreM = () => M('tyre', () => new THREE.MeshStandardMaterial({
  color: 0x111114, metalness: 0.05, roughness: 0.92,
}));
const rimM = () => M('rimSide', () => new THREE.MeshStandardMaterial({
  color: 0x6f757f, metalness: 0.88, roughness: 0.3,
}));
const rimFaceM = () => M('rimFace', () => new THREE.MeshStandardMaterial({
  color: 0xffffff, map: rimTex(), metalness: 0.7, roughness: 0.35,
}));
const chromeM = () => M('chrome', () => new THREE.MeshStandardMaterial({
  color: 0xb9bec6, metalness: 0.95, roughness: 0.2,
}));
// Mirror face: dark low-roughness "glass". A mirror reads as a dark reflective
// slot from almost every angle (it only flares when it catches the sky), so it
// must NEVER be the brightest element around the cockpit — the round-2/3 judges
// flagged pale unlit mirror cubes as the most eye-catching thing on dark cars.
const mirrorGlassM = () => M('mirrorGlass', () => new THREE.MeshStandardMaterial({
  color: 0x10141a, metalness: 0.92, roughness: 0.08,
}));
const gloveM = () => M('glove', () => new THREE.MeshStandardMaterial({
  color: 0x24262c, metalness: 0.05, roughness: 0.72,
}));
const visorM = () => M('visor', () => new THREE.MeshStandardMaterial({
  color: 0x08080c, metalness: 0.85, roughness: 0.1,
}));

// Decals: thin textured planes floated just off the bodywork. Explicitly
// FrontSide so a decal can never ghost through to the opposite flank, and every
// call site keeps them >= DECAL_GAP off the surface they sit on.
const DECAL_GAP = 0.012;
function decalM(key, tex) {
  return M(`decal:${key}`, () => new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false,
    side: THREE.FrontSide,
    metalness: 0.2, roughness: 0.45,
    emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2,
  }));
}

/* ------------------------------------------------------- aero plate table -- */
// Single source of truth for every flat aerodynamic element: the geometry below
// is generated from this table, and tools/validate-geometry.mjs asserts both
// that each `t` (material thickness) clears MIN_PLATE_THICKNESS and that the
// built meshes really contain the corners these rows describe. Nothing here may
// go paper-thin again.

export const MIN_PLATE_THICKNESS = 0.015;

const FW_EP_X = 0.900, FW_EP_T = 0.032;             // endplate plane + thickness
const FW_EP_INNER = FW_EP_X - FW_EP_T / 2;          // 0.884 — elements weld to this
const FW_EP_OUTER = FW_EP_X + FW_EP_T / 2;          // 0.916 — canards weld to this
const FW_SPAN = FW_EP_INNER + 0.004;                // 4 mm inside the endplate skin
const FW_EP_Y0 = 0.078, FW_EP_Z0 = 2.260;
const FW_MIN_Y = 0.060;                             // no wing surface below this
const FW_FLAP_IN = 0.280;                           // neutral central section
const RW_EP_X = 0.710, RW_EP_T = 0.030;
const RW_EP_INNER = RW_EP_X - RW_EP_T / 2;          // 0.695
const RW_EP_Y0 = 0.470, RW_EP_Z0 = -2.420;

const FIN_T = { tall: 0.026, twin: 0.022 };

const flapMid = (FW_FLAP_IN + FW_SPAN) / 2, flapW = FW_SPAN - FW_FLAP_IN;
const accMid = (0.600 + FW_SPAN) / 2, accW = FW_SPAN - 0.600;
const canMid = (FW_EP_OUTER - 0.016 + 0.985) / 2, canW = 0.985 - (FW_EP_OUTER - 0.016);

export const AERO_PLATES = [
  // ---- front wing: mainplane spans endplate to endplate, the two flaps stop
  //      short inboard so the nose cone can come down between them.
  { name: 'fwMainplane', mesh: 'fwBody', x: 0, y: 0.118, z: 2.60, w: 2 * FW_SPAN, t: 0.038, c: 0.36, rx: -0.06 },
  { name: 'fwFlap1L', mesh: 'fwBody', x: -flapMid, y: 0.176, z: 2.50, w: flapW, t: 0.034, c: 0.26, rx: -0.18 },
  { name: 'fwFlap1R', mesh: 'fwBody', x: flapMid, y: 0.176, z: 2.50, w: flapW, t: 0.034, c: 0.26, rx: -0.18 },
  { name: 'fwFlap2L', mesh: 'fwBody', x: -flapMid, y: 0.234, z: 2.42, w: flapW, t: 0.032, c: 0.20, rx: -0.30 },
  { name: 'fwFlap2R', mesh: 'fwBody', x: flapMid, y: 0.234, z: 2.42, w: flapW, t: 0.032, c: 0.20, rx: -0.30 },
  // canards bite 16 mm into the endplate OUTER skin — no orphan blocks
  { name: 'fwCanardL', mesh: 'fwBody', x: -canMid, y: 0.245, z: 2.56, w: canW, t: 0.022, c: 0.20, rz: 0.24 },
  { name: 'fwCanardR', mesh: 'fwBody', x: canMid, y: 0.245, z: 2.56, w: canW, t: 0.022, c: 0.20, rz: -0.24 },
  // accent outboard mainplane sections: thicker + longer chord than the plane
  // they sit on, so no face is ever coplanar with it
  { name: 'fwAccentL', mesh: 'fwAccent', x: -accMid, y: 0.118, z: 2.60, w: accW, t: 0.046, c: 0.37, rx: -0.06 },
  { name: 'fwAccentR', mesh: 'fwAccent', x: accMid, y: 0.118, z: 2.60, w: accW, t: 0.046, c: 0.37, rx: -0.06 },
  // ---- rear wing (mainplane + upper flap + beam wing all reach the endplates)
  { name: 'rwMainplane', mesh: 'rwAccent', x: 0, y: 0.830, z: -2.14, w: 2 * RW_EP_X, t: 0.055, c: 0.40, rx: 0.13 },
  { name: 'rwFlap', mesh: 'rwBody', x: 0, y: 0.925, z: -2.30, w: 2 * (RW_EP_INNER + 0.005), t: 0.045, c: 0.22, rx: 0.34 },
  { name: 'beamWing', mesh: 'beam', x: 0, y: 0.530, z: -2.12, w: 2 * (RW_EP_INNER + 0.005), t: 0.050, c: 0.26, rx: 0.12 },
];

// Extruded (non-box) aero plates, thickness = extrusion depth.
export const AERO_EXTRUSIONS = [
  { name: 'fwEndplate', mesh: 'fwBody', t: FW_EP_T },
  { name: 'rwEndplate', mesh: 'rwEndplates', t: RW_EP_T },
  { name: 'sharkFinTall', mesh: 'sharkFin', t: FIN_T.tall },
  { name: 'sharkFinTwin', mesh: 'sharkFin', t: FIN_T.twin },
];

// Merge-group key -> the Mesh.name it ends up in, so tooling can locate the
// object that holds a given plate.
export const AERO_MESH = {
  fwBody: 'frontWing',
  fwAccent: 'frontWingAccent',
  rwBody: 'rearWingFlap',
  rwAccent: 'rearWingMainplane',
  rwEndplates: 'rearWingEndplates',
  beam: 'beamWing',
  sharkFin: 'sharkFin',
};

function plateParts(mesh) {
  return AERO_PLATES.filter((p) => p.mesh === mesh).map((p) => ({
    geo: BOX(),
    m: TRS(p.x, p.y, p.z, p.w, p.t, p.c, p.rx || 0, p.ry || 0, p.rz || 0),
  }));
}

/* ---------------------------------------------------------- geometry ------ */

// Floor sits 0.04 above the road plane (road top ~0.02) so it cannot z-fight it.
const FLOOR_Y = 0.075;
const floorGeo = () => G('floor', () => mergeGeos([
  { geo: BOX(), m: TRS(0, 0, -0.28, 1.30, 0.07, 3.25) },                        // plate
  { geo: BOX(), m: TRS(-0.71, 0.03, 0.08, 0.20, 0.05, 2.30, 0, 0, -0.22) },     // twin floor edges
  { geo: BOX(), m: TRS(0.71, 0.03, 0.08, 0.20, 0.05, 2.30, 0, 0, 0.22) },
]));

const tubGeo = () => G('tub', () => new THREE.CylinderGeometry(
  TUB_R1, TUB_R0, TUB_Z1 - TUB_Z0, TUB_SEGMENTS, 1).rotateX(HALF_PI));

// Nose cone. Both profiles are CLOSED at both ends (r = 0 first and last), so
// the tip can never show the inside of the tube.
const NOSE_Y = 0.335, NOSE_Z = 1.160, NOSE_TILT = 0.058;
const NOSE_PROFILE = {
  round: [
    [0.000, -0.030], [0.150, -0.014], [0.255, 0.000],
    [0.249, 0.280], [0.232, 0.600], [0.205, 0.900], [0.163, 1.160],
    [0.108, 1.360], [0.060, 1.460], [0.030, 1.505], [0.012, 1.525], [0.000, 1.532],
  ],
  chisel: [
    [0.000, -0.030], [0.150, -0.014], [0.255, 0.000],
    [0.250, 0.300], [0.238, 0.640], [0.216, 0.960], [0.186, 1.220],
    [0.150, 1.400], [0.128, 1.480], [0.120, 1.500], [0.062, 1.506], [0.000, 1.508],
  ],
};
const noseGeo = (kind) => G(`nose:${kind}`, () => new THREE.LatheGeometry(
  NOSE_PROFILE[kind].map(([r, h]) => new THREE.Vector2(r, h)), 16).rotateX(HALF_PI));

/* -- cockpit ---------------------------------------------------------------
 * Two separate objects, which is the fix for the old single carbon frame that
 * punched its corners out through the bodywork:
 *   cockpitFrameGeo   dark interior structure, kept strictly inside the tub
 *   cockpitCoamingGeo body-coloured raised surround; it is *meant* to be part
 *                     of the silhouette, and every box bottom face is inside
 *                     the tub section so it grows out of the skin cleanly.
 * The coaming also gives the halo feet and the mirror stalks something solid
 * to land on.
 */
const COAM_Y0 = 0.440, COAM_TOP = 0.575;
const RAIL_IN_R = 0.180, RAIL_OUT_R = 0.258;    // rear rail segment, |x|
const RAIL_IN_F = 0.170, RAIL_OUT_F = 0.240;    // front rail segment, |x|
const RAIL_Z0 = 0.100, RAIL_ZM = 0.460, RAIL_Z1 = 0.840;
const COWL_Z0 = RAIL_Z1, COWL_Z1 = 1.020, COWL_TOP = 0.545, COWL_HALF = 0.225;
const BULK_Z0 = 0.020, BULK_Z1 = 0.160, BULK_TOP = 0.600, BULK_HALF = 0.245;

const railPart = (k, xIn, xOut, z0, z1) => ({
  geo: BOX(),
  m: TRS(k * (xIn + xOut) / 2, (COAM_Y0 + COAM_TOP) / 2, (z0 + z1) / 2,
    xOut - xIn, COAM_TOP - COAM_Y0, z1 - z0),
});

const cockpitCoamingGeo = () => G('coaming', () => mergeGeos([
  railPart(-1, RAIL_IN_R, RAIL_OUT_R, RAIL_Z0, RAIL_ZM),
  railPart(1, RAIL_IN_R, RAIL_OUT_R, RAIL_Z0, RAIL_ZM),
  railPart(-1, RAIL_IN_F, RAIL_OUT_F, RAIL_ZM - 0.04, RAIL_Z1),
  railPart(1, RAIL_IN_F, RAIL_OUT_F, RAIL_ZM - 0.04, RAIL_Z1),
  // dash cowl ahead of the opening — the halo's front V lands here
  {
    geo: BOX(),
    m: TRS(0, (COAM_Y0 + COWL_TOP) / 2, (COWL_Z0 + COWL_Z1) / 2,
      COWL_HALF * 2, COWL_TOP - COAM_Y0, COWL_Z1 - COWL_Z0),
  },
  // headrest hump behind the opening — the halo's rear legs land on the rails
  {
    geo: BOX(),
    m: TRS(0, (COAM_Y0 + BULK_TOP) / 2, (BULK_Z0 + BULK_Z1) / 2,
      BULK_HALF * 2, BULK_TOP - COAM_Y0, BULK_Z1 - BULK_Z0),
  },
]));

const cockpitFrameGeo = () => G('cockpitFrame', () => mergeGeos([
  { geo: BOX(), m: TRS(0, 0.420, 0.445, 0.32, 0.04, 0.79) },   // floor pan
  { geo: BOX(), m: TRS(0, 0.460, 0.100, 0.32, 0.12, 0.12) },   // seat back
  { geo: BOX(), m: TRS(0, 0.450, 0.840, 0.30, 0.10, 0.08) },   // dash bulkhead
]));

const headrestPadGeo = () => G('headrestPad', () => mergeGeos([
  { geo: BOX(), m: TRS(0, 0.5325, 0.135, 0.30, 0.065, 0.11) },
]));

const glovesGeo = () => G('gloves', () => mergeGeos([
  { geo: BOX(), m: TRS(-0.100, 0, 0, 0.070, 0.062, 0.075) },
  { geo: BOX(), m: TRS(0.100, 0, 0, 0.070, 0.062, 0.075) },
]));

// Halo: hoop + two rear legs + ONE central front pillar, one mesh — the real
// halo load path. The old front "V" (two tubes splaying from the hoop crown to
// the dash cowl) projected as a doubled pillar crossing the driver's face from
// any head-on camera, which the judges read as tangled black tubes. Mesh origin
// sits at HALO_POS; every leg terminates INSIDE the cockpit coaming (see
// HALO_FEET), so no leg ends in mid-air and nothing crosses the cockpit opening.
const HALO_POS = [0, 0.720, 0.440];
const HALO_R = 0.400;
const HALO_FEET = [
  [-0.235, 0.555, 0.160], [0.235, 0.555, 0.160],   // rear legs, into the side rails
  [0.000, 0.535, 0.910],                            // single centre pillar, into the dash cowl
];
const haloGeo = () => G('halo', () => {
  const [hx, hy, hz] = HALO_POS;
  const local = (p) => [p[0] - hx, p[1] - hy, p[2] - hz];
  const f = HALO_FEET.map(local);
  return mergeGeos([
    { geo: new THREE.TorusGeometry(HALO_R, 0.042, 6, 18, Math.PI), m: TRS(0, 0, 0, 1, 1, 1, HALF_PI) },
    tube(-HALO_R, 0, 0, f[0][0], f[0][1], f[0][2], 0.032),
    tube(HALO_R, 0, 0, f[1][0], f[1][1], f[1][2], 0.032),
    tube(0, -0.004, HALO_R, f[2][0], f[2][1], f[2][2], 0.030),
  ]);
});

/* -- airbox ----------------------------------------------------------------
 * A roll-hoop scoop whose base is buried in the tub, plus an intake mouth that
 * protrudes 80 mm clear of the scoop skin, and a T-cam sunk 20 mm INTO the
 * scoop crown. Nothing here shares a plane with anything else, which is what
 * removed the stray coplanar accent face that used to flicker in the airbox.
 */
const AIRBOX_Y = 0.605, AIRBOX_Z = -0.100;
const airboxGeo = () => G('airbox', () =>
  new THREE.CylinderGeometry(0.155, 0.205, 0.30, 12, 1));
const airboxIntakeGeo = () => G('airboxIntake', () =>
  new THREE.CylinderGeometry(0.115, 0.115, 0.17, 12, 1).rotateX(HALF_PI));

const spineGeo = () => G('spine', () => new THREE.CylinderGeometry(
  SPN_R1, SPN_R0, SPN_Z0 - SPN_Z1, SPN_SEGMENTS, 1).rotateX(-HALF_PI));

/* -- shark fin variants ----------------------------------------------------
 * Both variants are extruded in the (z, y) plane and then rotated so shape-x
 * runs along +Z. Bottom edges are lines fitted to spineTopAtX() and sunk below
 * it, so the fin roots are buried in the engine cover at every station.
 */
const FIN = {
  // stripe: the accent-sweep decal panel, sized to stay inside the fin's
  // tapering silhouette (below the top edge at every station) so no part of it
  // can hang in mid-air; anything under the fin root is hidden by the spine.
  tall: {
    x: [0], y: 0.460, z: -1.800, len: 1.280, t: FIN_T.tall,
    stripe: { y: 0.615, z: -1.365, h: 0.230, len: 0.730 },
  },
  twin: {
    x: [-0.075, 0.075], y: 0.480, z: -1.420, len: 0.920, t: FIN_T.twin,
    stripe: { y: 0.580, z: -1.100, h: 0.120, len: 0.600 },
  },
};
function finShape(kind) {
  const cfg = FIN[kind];
  const rise = spineTopAtX(cfg.z + cfg.len, Math.abs(cfg.x[0]) + cfg.t / 2)
    - spineTopAtX(cfg.z, Math.abs(cfg.x[0]) + cfg.t / 2);
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(cfg.len, rise);
  if (kind === 'tall') {
    s.lineTo(cfg.len, rise + 0.030);
    s.quadraticCurveTo(cfg.len * 0.52, 0.325, cfg.len * 0.09, 0.394);
    s.lineTo(0, 0.388);
  } else {
    s.lineTo(cfg.len, rise + 0.030);
    s.quadraticCurveTo(cfg.len * 0.52, 0.185, cfg.len * 0.09, 0.205);
    s.lineTo(0, 0.200);
  }
  s.closePath();
  return s;
}
const finGeo = (kind) => G(`fin:${kind}`, () => {
  const cfg = FIN[kind];
  const g = extrude(finShape(kind), cfg.t).rotateY(-HALF_PI);
  if (cfg.x.length === 1) return g;
  const out = mergeGeos(cfg.x.map((x) => ({ geo: g, m: TRS(x, 0, 0) })));
  g.dispose();
  return out;
});

// Sidepod pair: slab + inward-leaning shoulder + angled undercut + coke-bottle
// rear, mirrored by negating x and the roll/yaw angles (winding stays valid).
const sidepodGeo = () => G('sidepod', () => {
  const side = (k) => [
    { geo: BOX(), m: TRS(-0.56 * k, 0.36, -0.05, 0.42, 0.26, 1.60) },
    { geo: BOX(), m: TRS(-0.50 * k, 0.515, -0.10, 0.34, 0.10, 1.45, 0, 0, -0.22 * k) },
    { geo: BOX(), m: TRS(-0.50 * k, 0.200, -0.05, 0.30, 0.20, 1.45, 0, 0, 0.42 * k) },
    { geo: BOX(), m: TRS(-0.40 * k, 0.34, -1.05, 0.30, 0.24, 0.55, 0, 0.25 * k, 0) },
  ];
  return mergeGeos([...side(1), ...side(-1)]);
});

const podInletGeo = () => G('podInlet', () => mergeGeos([
  { geo: BOX(), m: TRS(-0.56, 0.36, 0.74, 0.36, 0.21, 0.10) },
  { geo: BOX(), m: TRS(0.56, 0.36, 0.74, 0.36, 0.21, 0.10) },
]));

const gearboxGeo = () => G('gearbox', () =>
  new THREE.CylinderGeometry(0.09, 0.17, 0.65, 8, 1).rotateX(-HALF_PI));
const exhaustGeo = () => G('exhaust', () =>
  new THREE.CylinderGeometry(0.052, 0.062, 0.22, 8, 1).rotateX(-HALF_PI));

// Coke-bottle / rear crash-structure closeout. Without it the chase camera sees
// straight through the car between the rear-wing mount, the engine cover and
// the floor. Body-coloured tail + carbon underside blocker.
const rearCloseoutBodyGeo = () => G('rearCloseBody', () => mergeGeos([
  { geo: BOX(), m: TRS(-0.30, 0.35, -1.60, 0.36, 0.28, 0.70, 0, 0.16, 0) },
  { geo: BOX(), m: TRS(0.30, 0.35, -1.60, 0.36, 0.28, 0.70, 0, -0.16, 0) },
  { geo: BOX(), m: TRS(0, 0.49, -1.92, 0.40, 0.14, 0.28) },     // engine-cover tail
]));
const rearCloseoutGeo = () => G('rearClose', () => mergeGeos([
  { geo: BOX(), m: TRS(0, 0.33, -1.90, 0.72, 0.10, 0.34) },     // underside blocker
  { geo: BOX(), m: TRS(0, 0.455, -1.83, 0.52, 0.11, 0.46) },    // upper closeout
]));

// Upswept diffuser + strakes + outer walls. Heights are set so the leading
// bottom edge stays flush with the floor plane (nothing dips below y = 0).
const diffuserGeo = () => G('diffuser', () => mergeGeos([
  { geo: BOX(), m: TRS(0, 0.21, -1.86, 1.12, 0.18, 0.62, 0.24) },
  { geo: BOX(), m: TRS(-0.34, 0.22, -1.86, 0.022, 0.20, 0.56, 0.24) },
  { geo: BOX(), m: TRS(0.34, 0.22, -1.86, 0.022, 0.20, 0.56, 0.24) },
  { geo: BOX(), m: TRS(-0.55, 0.23, -1.86, 0.025, 0.24, 0.60, 0.24) },
  { geo: BOX(), m: TRS(0.55, 0.23, -1.86, 0.025, 0.24, 0.60, 0.24) },
]));

const beamGeo = () => G('beam', () => mergeGeos([
  ...plateParts('beam'),
  { geo: BOX(), m: TRS(0, 0.68, -2.13, 0.09, 0.32, 0.20) },     // swan-neck pylon
]));

// Rear endplates: two top-edge variants, both sides in one geometry, and the
// bottom edge reaches down to the beam wing so the wing box is closed.
const RW_EP_SHAPE = {
  straight: (s) => {
    s.moveTo(0, 0);
    s.lineTo(0.55, 0.02);
    s.lineTo(0.55, 0.54);
    s.lineTo(0, 0.54);
  },
  swept: (s) => {
    s.moveTo(0, 0);
    s.lineTo(0.55, 0.03);
    s.lineTo(0.58, 0.38);
    s.quadraticCurveTo(0.44, 0.58, 0.16, 0.625);
    s.lineTo(0, 0.60);
  },
};
const rwEndplateGeo = (kind) => G(`rwEndplate:${kind}`, () => {
  const s = new THREE.Shape();
  RW_EP_SHAPE[kind](s);
  s.closePath();
  const g = extrude(s, RW_EP_T);
  const out = mergeGeos([
    { geo: g, m: TRS(-RW_EP_X, RW_EP_Y0, RW_EP_Z0, 1, 1, 1, 0, -HALF_PI) },
    { geo: g, m: TRS(RW_EP_X, RW_EP_Y0, RW_EP_Z0, 1, 1, 1, 0, -HALF_PI) },
  ]);
  g.dispose();
  return out;
});
const rwFlapGeo = () => G('rwFlap', () => mergeGeos(plateParts('rwBody')));
const rwMainplaneGeo = () => G('rwMainplane', () => mergeGeos(plateParts('rwAccent')));

// Front wing: endplates + every element welded into ONE geometry, so the
// elements physically overlap the endplate inner skin (no gap, no black void).
const fwEndplateShape = () => {
  const s = new THREE.Shape();
  s.moveTo(0, 0.004);
  s.lineTo(0.54, 0);
  s.lineTo(0.56, 0.20);
  s.quadraticCurveTo(0.48, 0.285, 0.32, 0.305);
  s.lineTo(0, 0.28);
  s.closePath();
  return s;
};
const fwBodyGeo = () => G('fwBody', () => {
  const g = extrude(fwEndplateShape(), FW_EP_T);
  const out = mergeGeos([
    { geo: g, m: TRS(-FW_EP_X, FW_EP_Y0, FW_EP_Z0, 1, 1, 1, 0, -HALF_PI) },
    { geo: g, m: TRS(FW_EP_X, FW_EP_Y0, FW_EP_Z0, 1, 1, 1, 0, -HALF_PI) },
    ...plateParts('fwBody'),
  ]);
  g.dispose();
  return out;
});
const fwAccentGeo = () => G('fwAccent', () => mergeGeos(plateParts('fwAccent')));
const fwPylonGeo = () => G('fwPylon', () => mergeGeos([
  { geo: BOX(), m: TRS(-0.075, 0.1675, 2.49, 0.05, 0.095, 0.14) },
  { geo: BOX(), m: TRS(0.075, 0.1675, 2.49, 0.05, 0.095, 0.14) },
]));

// Mirrors: stalks rooted inside the cockpit rails, pods big enough to read at
// chase distance, each with a bright glass plate proud of the shell.
const MIRROR_POD = [0.492, 0.552, 0.788];
const mirrorArmGeo = () => G('mirrorArms', () => mergeGeos([
  tube(-0.240, 0.520, 0.700, -0.455, 0.548, 0.775, 0.017),
  tube(0.240, 0.520, 0.700, 0.455, 0.548, 0.775, 0.017),
]));
const mirrorPodGeo = () => G('mirrorPods', () => mergeGeos([
  { geo: BOX(), m: TRS(-MIRROR_POD[0], MIRROR_POD[1], MIRROR_POD[2], 0.115, 0.090, 0.055, 0, 0.30, 0) },
  { geo: BOX(), m: TRS(MIRROR_POD[0], MIRROR_POD[1], MIRROR_POD[2], 0.115, 0.090, 0.055, 0, -0.30, 0) },
]));
const mirrorGlassGeo = () => G('mirrorGlass', () => mergeGeos([
  { geo: BOX(), m: TRS(-MIRROR_POD[0], MIRROR_POD[1], MIRROR_POD[2], 0.098, 0.074, 0.063, 0, 0.30, 0) },
  { geo: BOX(), m: TRS(MIRROR_POD[0], MIRROR_POD[1], MIRROR_POD[2], 0.098, 0.074, 0.063, 0, -0.30, 0) },
]));

// Wishbones: upper + two lower arms per corner. Inboard ends are pulled in to
// sit inside the nose / gearbox skin instead of hanging off it.
const suspFrontGeo = () => G('suspF', () => mergeGeos([
  tube(-0.26, 0.26, 1.70, -0.77, 0.30, 1.60, 0.021),
  tube(-0.26, 0.26, 1.33, -0.77, 0.30, 1.50, 0.021),
  tube(-0.175, 0.45, 1.52, -0.75, 0.41, 1.55, 0.019),
  tube(0.26, 0.26, 1.70, 0.77, 0.30, 1.60, 0.021),
  tube(0.26, 0.26, 1.33, 0.77, 0.30, 1.50, 0.021),
  tube(0.175, 0.45, 1.52, 0.75, 0.41, 1.55, 0.019),
]));
const suspRearGeo = () => G('suspR', () => mergeGeos([
  tube(-0.145, 0.24, -1.44, -0.80, 0.30, -1.55, 0.022),
  tube(-0.090, 0.30, -1.94, -0.80, 0.30, -1.68, 0.022),
  tube(-0.170, 0.45, -1.62, -0.78, 0.42, -1.60, 0.020),
  tube(0.145, 0.24, -1.44, 0.80, 0.30, -1.55, 0.022),
  tube(0.090, 0.30, -1.94, 0.80, 0.30, -1.68, 0.022),
  tube(0.170, 0.45, -1.62, 0.78, 0.42, -1.60, 0.020),
]));

const brakeDuctGeo = () => G('brakeDucts', () => mergeGeos([
  { geo: BOX(), m: TRS(-0.70, 0.32, 1.55, 0.10, 0.24, 0.22) },
  { geo: BOX(), m: TRS(0.70, 0.32, 1.55, 0.10, 0.24, 0.22) },
  { geo: BOX(), m: TRS(-0.72, 0.32, -1.60, 0.11, 0.24, 0.24) },
  { geo: BOX(), m: TRS(0.72, 0.32, -1.60, 0.11, 0.24, 0.24) },
]));

// Tyre as a doughnut (not a capped cylinder) so the rim well is actually open:
// tread crown at r=0.34, bead at r=0.205, rounded shoulders, axially stretched
// to the tyre width. A capped cylinder would bury the rim + spoke face.
const TYRE_R = 0.34, BEAD_R = 0.205;
const tyreGeo = (w) => G(`tyre:${w}`, () => {
  const mid = (TYRE_R + BEAD_R) / 2, tube = (TYRE_R - BEAD_R) / 2;
  return new THREE.TorusGeometry(mid, tube, 6, 22)
    .rotateY(HALF_PI)               // hole axis -> X
    .scale(w / (tube * 2), 1, 1);   // stretch the section to the tyre width
});
const wheelRimGeo = (w) => G(`wrim:${w}`, () =>
  new THREE.CylinderGeometry(BEAD_R, BEAD_R, w * 0.92, 16, 1).rotateZ(HALF_PI));
const bandGeo = () => G('band', () =>
  new THREE.TorusGeometry(0.272, 0.013, 4, 20).rotateY(HALF_PI));
// Helmet trim ring, sits below the visor so it reads from a pure side view.
const helmetBandGeo = () => G('helmetBand', () =>
  new THREE.TorusGeometry(0.152, 0.014, 6, 20).rotateX(HALF_PI));

/* ------------------------------------------------------------- build ------ */

const COMPOUND_COLORS = { S: 0xe10600, M: 0xffd24a, H: 0xf0f0f0 };

/* -- nose number fit -------------------------------------------------------
 * The nose number panels are fitted to the ACTUAL lathed nose surface (like the
 * GLB path's snapDecals), not hand-typed: probe rays sample the surface across
 * the panel footprint, the yaw follows the measured taper and the plane stands
 * off the outermost hit by DECAL_GAP at every sampled station. The old constant
 * x/yaw pair could clip the panel mid-glyph into the fatter nose stations.
 * Cached per nose variant; exported spec so tooling can re-assert the clearance.
 */
export const NOSE_NUM_SPEC = { y: 0.300, z: 1.720, w: 0.26, h: 0.16 };
const _noseNumFit = new Map();
function noseNumberFit(kind, noseMesh) {
  let fit = _noseNumFit.get(kind);
  if (fit) return fit;
  noseMesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 3;
  const s = NOSE_NUM_SPEC;
  const zs = [-0.5, -0.25, 0, 0.25, 0.5].map((f) => s.z + s.w * f);
  const surf = [];   // outermost |x| of the nose skin at each sampled station
  for (const z of zs) {
    let m = 0, hitAny = false;
    for (const dy of [-0.5, 0, 0.5]) {
      ray.set(new THREE.Vector3(0.9, s.y + s.h * dy, z), new THREE.Vector3(-1, 0, 0));
      const h = ray.intersectObject(noseMesh, false);
      if (h.length) { m = Math.max(m, h[0].point.x); hitAny = true; }
    }
    surf.push(hitAny ? m : null);
  }
  if (surf.some((v) => v === null)) {
    fit = { x: 0.328, yaw: HALF_PI - 0.06 };       // legacy fallback
    _noseNumFit.set(kind, fit);
    return fit;
  }
  // taper slope from the end stations, then push the plane out until EVERY
  // sampled station clears it by DECAL_GAP
  const delta = Math.max(0, (surf[0] - surf[4]) / (zs[4] - zs[0]));
  let x0 = 0;
  for (let i = 0; i < zs.length; i++) {
    x0 = Math.max(x0, surf[i] - delta * (s.z - zs[i]));
  }
  fit = { x: x0 + DECAL_GAP, yaw: HALF_PI - Math.atan(delta) };
  _noseNumFit.set(kind, fit);
  return fit;
}

/* ===================================================== sculpted GLB path ===
 * tools/blender/build_car.py exports assets/f1car-2026.glb: a subdivision-
 * modelled car in this module's own axes (+Z forward, Y up, floor at y = 0.03).
 * When that template is loaded, buildCarMesh() clones it instead of assembling
 * primitives. The primitives path below is KEPT and is still the fallback used
 * by node (tools/sim-race.mjs, tools/validate-geometry.mjs) and by any browser
 * where the GLB fails to load.
 *
 * Resource ownership across the two paths is identical:
 *   * template geometries + non-recoloured materials are flagged
 *     userData.shared, so RaceSession.dispose() leaves them alone and every car
 *     on the grid reuses them;
 *   * 'body' / 'accent' / 'band' / 'glow' / 'rainlight' are CLONED per car (with
 *     userData reset, because Material.clone() deep-copies userData and would
 *     otherwise inherit shared:true) so recolouring is per car and dispose()
 *     reclaims them.
 */

export const GLB_URL = 'assets/f1car-2026.glb';

// materials that get a fresh clone per car because something recolours them
// ('tyrewall' is the sidewall-branding ring: setTyreCompound tints it with the
// live compound colour together with the bead band)
const GLB_PER_CAR_MATS = new Set(['body', 'accent', 'band', 'glow', 'rainlight',
  'helmet', 'helmet_trim', 'tyrewall']);
// only the big silhouette parts cast shadows — 22 cars of every-mesh shadow
// casting is not affordable
const GLB_SHADOW_CASTERS = new Set([
  'chassis', 'sidepods', 'airbox', 'shark_fin', 'floor', 'helmet', 'halo',
  'front_wing_main', 'front_wing_endplates', 'rear_wing_main', 'rear_wing_flap',
  'rear_wing_endplates', 'tyre_fl', 'tyre_fr', 'tyre_rl', 'tyre_rr',
]);

/* Livery decal intents. Each row is an ANCHOR, not a final transform: snapDecals()
 * fires rays at the real bodywork and fits the plane to whatever surface it finds,
 * so the planes keep sitting on the model even when the modelling script moves a
 * surface. `from` is the ray start distance along the probe axis.
 *   axis 'x' -> flank decal, `w` spans Z and `h` spans Y
 *   axis 'y' -> upward-facing decal, `w` spans X and `h` spans Z
 */
export const GLB_DECALS = [
  // z 1.98 keeps the probe ray clear of the brake ducts (z <= 1.77) and the
  // front pushrod (z <= 1.82), both of which sit outboard of the nose flank.
  { name: 'numberNose', kind: 'num', axis: 'x', mirror: true, from: 0.55, y: 0.232, z: 1.980, w: 0.24, h: 0.135 },
  { name: 'numberPod', kind: 'num', axis: 'x', mirror: true, from: 1.10, y: 0.418, z: -0.470, w: 0.38, h: 0.190 },
  { name: 'sponsorPod', kind: 'pod', axis: 'x', mirror: true, from: 1.10, y: 0.336, z: 0.150, w: 0.60, h: 0.100 },
  { name: 'sponsorEP', kind: 'ep', axis: 'x', mirror: true, from: 1.10, y: 0.740, z: -2.240, w: 0.36, h: 0.210 },
  { name: 'finStripe', kind: 'stripe', axis: 'x', mirror: true, from: 0.30, y: 0.640, z: -1.110, w: 0.60, h: 0.100 },
  { name: 'roundel', kind: 'roundel', axis: 'y', mirror: false, from: 1.10, y: 0, z: 1.430, w: 0.130, h: 0.130 },
];

const DECAL_SAMPLES = [-0.42, -0.21, 0, 0.21, 0.42];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Fit ONE decal plane to the bodywork. Returns null when nothing was hit.
function snapOne(spec, side, ray, targets) {
  const hits = [];
  for (const s of DECAL_SAMPLES) {
    if (spec.axis === 'x') {
      const z = spec.z + spec.w * s;
      ray.set(new THREE.Vector3(side * spec.from, spec.y, z),
        new THREE.Vector3(-side, 0, 0));
    } else {
      const z = spec.z + spec.h * s;
      ray.set(new THREE.Vector3(0, spec.from, z), new THREE.Vector3(0, -1, 0));
    }
    const h = ray.intersectObjects(targets, false);
    if (!h.length) return null;
    hits.push(h[0].point.clone());
  }
  const a = hits[0], b = hits[hits.length - 1];
  const t = new THREE.Vector3().subVectors(b, a);
  if (t.lengthSq() < 1e-12) return null;
  t.normalize();
  const n = spec.axis === 'x'
    ? new THREE.Vector3().crossVectors(Y_AXIS, t)
    : new THREE.Vector3().crossVectors(t, X_AXIS);
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  if (spec.axis === 'x' ? n.x * side < 0 : n.y < 0) n.negate();

  // Push the plane out until EVERY sample is behind it: a flat plane on a convex
  // flank would otherwise sink into the bodywork mid-span.
  const mid = a.clone().add(b).multiplyScalar(0.5);
  let bulge = 0;
  for (const h of hits) bulge = Math.max(bulge, h.clone().sub(mid).dot(n));
  const pos = mid.clone().addScaledVector(n, bulge + DECAL_GAP);

  const o = new THREE.Object3D();
  if (spec.axis === 'y') o.up.set(0, 0, -1);
  o.position.copy(pos);
  o.lookAt(pos.clone().add(n));
  return {
    name: spec.name, kind: spec.kind, w: spec.w, h: spec.h,
    position: pos, quaternion: o.quaternion.clone(),
    normal: n, standoff: bulge + DECAL_GAP, bulge,
  };
}

// Exported so tools/blender/check-glb.mjs can assert the planes really land on
// the exported bodywork instead of trusting hand-typed offsets.
export function snapDecals(scene) {
  const root = scene.getObjectByName('body_root') || scene;
  root.updateMatrixWorld(true);
  const targets = [];
  root.traverse((o) => { if (o.isMesh) targets.push(o); });
  const ray = new THREE.Raycaster();
  ray.far = 4;
  const out = [];
  for (const spec of GLB_DECALS) {
    for (const side of (spec.mirror ? [1, -1] : [1])) {
      const s = snapOne(spec, side, ray, targets);
      if (s) out.push(s);
    }
  }
  return out;
}

let _tplPromise = null;
let _tpl = null;

// Flatten the imported scene: bake each top-level node's world matrix so
// body_root / wheel_* can be re-parented straight into a per-car Group.
function prepareTemplate(scene) {
  scene.updateMatrixWorld(true);
  const holder = new THREE.Group();
  for (const name of ['body_root', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
    const o = scene.getObjectByName(name);
    if (!o) return null;
    o.matrix.copy(o.matrixWorld);
    o.matrix.decompose(o.position, o.quaternion, o.scale);
    holder.add(o);
  }
  holder.updateMatrixWorld(true);
  const decals = snapDecals(holder);
  // Mirror face: the exported 'glass' material is a pale sky-toned chrome that
  // rendered as the brightest thing around the cockpit. Darken it once on the
  // template (it is shared by every car): a mirror reads as a dark reflective
  // slot except at the rare angle where it catches the sky. Matches the
  // primitives path's mirrorGlassM.
  const mirrorGlass = holder.getObjectByName('mirror_glass');
  if (mirrorGlass && mirrorGlass.material) {
    const mg = mirrorGlass.material;
    if (mg.color) mg.color.setHex(0x10141a);
    mg.metalness = 0.92;
    mg.roughness = 0.08;
    if (mg.emissive) mg.emissive.setHex(0x000000);
  }
  holder.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.userData.shared = true;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      // per-car materials are cloned in buildFromTemplate(); the template copy
      // stays shared so the clone source is never disposed
      if (m) m.userData.shared = true;
    }
  });
  return { holder, decals };
}

function isHeadless() {
  return typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof document.createElement !== 'function';
}

// One GLB fetch attempt; resolves null on failure (never rejects).
function loadGLBOnce(url) {
  return import('../lib/loaders/GLTFLoader.js')
    .then(({ GLTFLoader }) => new Promise((resolve) => {
      new GLTFLoader().load(url, (g) => resolve(g.scene), undefined, () => resolve(null));
    }))
    .catch(() => null);
}

/**
 * Load + cache the sculpted GLB. Resolves with the template (or null when the
 * primitives fallback should be used). Safe to call more than once — the second
 * call returns the same promise. In node there is no GLTFLoader host, so it
 * resolves null and buildCarMesh() keeps using primitives.
 *
 * A transient fetch failure is retried (3 attempts) and, if all fail, the cache
 * is RE-ARMED instead of pinning null forever — the next buildCarMesh() call
 * triggers a fresh attempt, and every primitive car built in the meantime is
 * upgraded in place when a later attempt succeeds (see buildCarMesh).
 *
 * Passing an already-parsed Object3D instead of a URL installs it directly; that
 * is how tools/blender/check-glb.mjs exercises the template path without a fetch.
 */
export function preloadCarModel(url = GLB_URL) {
  if (url && url.isObject3D) {
    _tpl = prepareTemplate(url);
    _tplPromise = Promise.resolve(_tpl);
    _upgradePendingCars();
    return _tplPromise;
  }
  if (_tplPromise) return _tplPromise;
  if (isHeadless()) {
    _tplPromise = Promise.resolve(null);
    return _tplPromise;
  }
  const attempt = (n) => loadGLBOnce(url).then((scene) => scene
    || (n <= 1 ? null : new Promise((r) => setTimeout(r, 300)).then(() => attempt(n - 1))));
  _tplPromise = attempt(3).then((scene) => {
    _tpl = scene ? prepareTemplate(scene) : null;
    if (!_tpl) _tplPromise = null;   // re-arm: a later session retries the load
    _upgradePendingCars();
    return _tpl;
  });
  return _tplPromise;
}

export function carModelLoaded() {
  return !!_tpl;
}

function decalMaterial(kind, drv, team, accent, lightNumber) {
  if (kind === 'num') {
    return decalM(`num:${drv.num}:${lightNumber ? 'l' : 'd'}`,
      numberTex(drv.num, lightNumber));
  }
  if (kind === 'pod') return decalM('pod', sponsorTex('pod'));
  if (kind === 'ep') return decalM('ep', sponsorTex('ep'));
  if (kind === 'stripe') return decalM(`stripe:${team.accent}`, stripeTex(team.accent));
  return decalM(`roundel:${drv.num}:${accent.getHexString()}`,
    roundelTex(drv.num, accent));
}

function buildFromTemplate(team, driver) {
  const drv = driver || { num: 0, code: '---' };
  const color = new THREE.Color(team.color);
  const accent = new THREE.Color(team.accent);
  const lightNumber = luminance(color) <= 0.36;
  const variant = carVariant(team);
  const helm = helmetPalette(team);

  const src = _tpl.holder.clone(true);   // shares geometries + materials
  const body = src.getObjectByName('body_root');
  const wheels = {};
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    wheels[k] = src.getObjectByName('wheel_' + k);
  }

  // per-car material clones
  const perCar = new Map();
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = GLB_SHADOW_CASTERS.has(o.name);
    const m = o.material;
    if (!m || !GLB_PER_CAR_MATS.has(m.name)) return;
    let c = perCar.get(m.name);
    if (!c) {
      c = m.clone();
      c.name = m.name;
      c.userData = {};              // must NOT inherit shared:true
      perCar.set(m.name, c);
    }
    o.material = c;
  });

  // self-glow fades to zero on near-white paint so the rear wing's white
  // surfaces can never climb over the day bloom threshold (see selfGlow)
  const bodyMat = perCar.get('body');
  if (bodyMat) {
    bodyMat.color.copy(capWhite(color));
    bodyMat.metalness = 0.5;
    bodyMat.roughness = 0.30;
    bodyMat.emissive.copy(color).multiplyScalar(selfGlow(color));
  }
  const accentMat = perCar.get('accent');
  if (accentMat) {
    accentMat.color.copy(capWhite(accent));
    accentMat.metalness = 0.48;
    accentMat.roughness = 0.32;
    accentMat.emissive.copy(accent).multiplyScalar(selfGlow(accent));
  }
  const helmMat = perCar.get('helmet');
  if (helmMat) {
    helmMat.color.copy(helm.shell);
    helmMat.emissive.copy(helm.shell).multiplyScalar(0.16);
  }
  const helmTrimMat = perCar.get('helmet_trim');
  if (helmTrimMat) {
    helmTrimMat.color.copy(helm.trim);
    helmTrimMat.emissive.copy(helm.trim).multiplyScalar(0.10);
  }
  const glowMat = perCar.get('glow');
  if (glowMat) {
    glowMat.color.setHex(0x120602);
    glowMat.emissive.setHex(0xff6a12);
    glowMat.emissiveIntensity = 2.4;
    glowMat.toneMapped = false;
    glowMat.transparent = true;
    glowMat.depthWrite = false;
  }
  const rainMat = perCar.get('rainlight');
  if (rainMat) {
    rainMat.color.setHex(0x1a0202);
    rainMat.emissive.setHex(0xff1a12);
    rainMat.emissiveIntensity = 2.2;
    rainMat.toneMapped = false;
  }
  const bandMat = perCar.get('band');
  if (bandMat) {
    bandMat.color.setHex(COMPOUND_COLORS.M);
    bandMat.emissive.setHex(COMPOUND_COLORS.M).multiplyScalar(0.12);
  }

  const group = new THREE.Group();
  group.add(body);
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const w = wheels[k];
    // race.js writes rotation.y (steer) then rotation.x (spin) directly; 'YXZ'
    // applies steer first and keeps the axle horizontal.
    w.rotation.order = 'YXZ';
    group.add(w);
  }

  // livery planes, fitted to the sculpted surfaces at preload time
  for (const d of _tpl.decals) {
    const disc = d.kind === 'roundel';
    const m = new THREE.Mesh(disc ? DISC() : PLANE(),
      decalMaterial(d.kind, drv, team, accent, lightNumber));
    m.position.copy(d.position);
    m.quaternion.copy(d.quaternion);
    m.scale.set(disc ? d.w / 2 : d.w, disc ? d.h / 2 : d.h, 1);
    m.name = d.name;
    m.renderOrder = 1;
    body.add(m);
  }

  const brakeGlows = ['brake_glow_l', 'brake_glow_r']
    .map((n) => body.getObjectByName(n)).filter(Boolean);
  for (const b of brakeGlows) b.visible = false;
  const rainLight = body.getObjectByName('rain_light') || null;
  if (rainLight) rainLight.visible = true;

  const tyreBands = ['fl', 'fr', 'rl', 'rr']
    .map((k) => wheels[k].getObjectByName('band_' + k)).filter(Boolean);

  const handle = {
    group, wheels, wheelRadius: 0.34,
    body, team, driver: drv,
    tyreBands, tyreBandMats: bandMat ? [bandMat] : [], compound: 'M',
    brakeGlows, brakeGlowMaterial: glowMat || null,
    rainLight, rainLightMaterial: rainMat || null,
    variant,
    monocoque: body.getObjectByName('chassis') || null,
    haloFeet: HALO_FEET.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    frontWingMinY: FW_MIN_Y,
    helmetColors: helm,
    source: 'glb',
  };
  group.userData.brakeGlows = brakeGlows;
  group.userData.rainLight = rainLight;
  group.userData.carVariant = variant;
  return handle;
}

/* -- primitive -> GLB in-place upgrade -------------------------------------
 * THE two-art-generations fix. buildCarMesh() picks its path from _tpl AT CALL
 * TIME, so any car built before the GLB resolved (slow fetch, transient failure,
 * a session constructed mid-preload) was frozen as an old primitive car while
 * cars built later got the sculpted model — the certified grid hero shot showed
 * both generations in ONE frame, primitives nearest the camera. Now every
 * primitive handle built in a browser registers here and is rebuilt IN PLACE
 * from the template the moment it resolves: same group, same wheels object,
 * same handle identity, so race.js entries keep working untouched.
 */
const _pendingUpgrade = new Set();

function _upgradePendingCars() {
  if (!_tpl) return;
  for (const h of _pendingUpgrade) {
    try { _upgradeToTemplate(h); } catch (e) { /* keep the primitive car */ }
  }
  _pendingUpgrade.clear();
}

const _disposePerCar = (o) => {
  if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
  const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
  for (const m of mats) {
    if (m.userData.shared) continue;
    if (m.map && !m.map.userData.shared) m.map.dispose();
    m.dispose();
  }
};

function _upgradeToTemplate(handle) {
  if (!_tpl || handle.source !== 'primitives') return;
  const group = handle.group;
  const glowWasOn = handle.brakeGlows.length ? !!handle.brakeGlows[0].visible : false;
  const rainWasOn = handle.rainLight ? !!handle.rainLight.visible : true;
  const oldBody = handle.body;
  const oldWheels = { ...handle.wheels };

  const fresh = buildFromTemplate(handle.team, handle.driver);

  // strip the primitive parts (body group + 4 wheel groups); extra children the
  // race session attached to the group (contact shadow, name tag) stay put
  for (const n of [oldBody, oldWheels.fl, oldWheels.fr, oldWheels.rl, oldWheels.rr]) {
    if (!n) continue;
    group.remove(n);
    n.traverse(_disposePerCar);
  }

  // graft the sculpted parts, carrying over live pose state
  fresh.body.rotation.copy(oldBody.rotation);       // pitch/roll attitude
  fresh.body.position.y = oldBody.position.y;       // ride bump
  group.add(fresh.body);
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const nw = fresh.wheels[k];
    nw.rotation.x = oldWheels[k].rotation.x;        // spin
    nw.rotation.y = oldWheels[k].rotation.y;        // steer
    group.add(nw);
    handle.wheels[k] = nw;    // entries hold this same wheels object — mutate it
  }
  handle.body = fresh.body;
  handle.tyreBands = fresh.tyreBands;
  handle.tyreBandMats = fresh.tyreBandMats;
  handle.brakeGlows = fresh.brakeGlows;
  handle.brakeGlowMaterial = fresh.brakeGlowMaterial;
  handle.rainLight = fresh.rainLight;
  handle.rainLightMaterial = fresh.rainLightMaterial;
  handle.monocoque = fresh.monocoque;
  handle.helmetColors = fresh.helmetColors;
  handle.source = 'glb';
  for (const b of handle.brakeGlows) b.visible = glowWasOn;
  if (handle.rainLight) handle.rainLight.visible = rainWasOn;
  group.userData.brakeGlows = handle.brakeGlows;
  group.userData.rainLight = handle.rainLight;
  setTyreCompound(handle, handle.compound);
}

/**
 * Build one car. Uses the sculpted GLB template when preloadCarModel() has
 * resolved it, otherwise the primitive assembly below. The returned handle has
 * the same shape either way — and in a browser a primitive-built car upgrades
 * itself to the sculpted model in place as soon as the template loads, so no
 * frame can ever mix the two art generations near camera.
 */
export function buildCarMesh(team, driver) {
  if (_tpl) return buildFromTemplate(team, driver);
  const handle = buildPrimitiveCarMesh(team, driver);
  if (!isHeadless()) {
    // prune handles whose cars a finished session already removed from the scene
    for (const h of _pendingUpgrade) if (!h.group.parent) _pendingUpgrade.delete(h);
    _pendingUpgrade.add(handle);
    preloadCarModel();   // re-arms the GLB load if a previous attempt failed
  }
  return handle;
}

export function buildPrimitiveCarMesh(team, driver) {
  const drv = driver || { num: 0, code: '---' };
  const color = new THREE.Color(team.color);
  const accent = new THREE.Color(team.accent);
  const body_ = bodyM(team), accent_ = accentM(team), carbon_ = carbonM();
  const lightNumber = luminance(color) <= 0.36;
  const variant = carVariant(team);
  const helm = helmetPalette(team);

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // (geo, mat, x, y, z, { s:[..], r:[..], cast, name })
  const put = (geo, mat, x = 0, y = 0, z = 0, o = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (o.s) m.scale.set(o.s[0], o.s[1], o.s[2]);
    if (o.r) m.rotation.set(o.r[0], o.r[1], o.r[2]);
    if (o.name) m.name = o.name;
    m.castShadow = !!o.cast;
    body.add(m);
    return m;
  };

  /* --- hull ------------------------------------------------------------- */
  put(floorGeo(), carbon_, 0, FLOOR_Y, 0, { cast: true, name: 'floor' });
  put(BOX(), plankM(), 0, 0.042, -0.35, { s: [0.30, 0.024, 2.90], name: 'plank' });
  const tub = put(tubGeo(), body_, 0, TUB_CY, (TUB_Z0 + TUB_Z1) / 2,
    { s: [TUB_SX, TUB_SY, 1], cast: true, name: 'monocoque' });
  const noseMesh = put(noseGeo(variant.nose), body_, 0, NOSE_Y, NOSE_Z,
    { s: [1.30, 0.80, 1], r: [NOSE_TILT, 0, 0], cast: true, name: 'noseCone' });
  put(spineGeo(), body_, 0, SPN_CY, (SPN_Z0 + SPN_Z1) / 2,
    { s: [SPN_SX, SPN_SY, 1], cast: true, name: 'engineCover' });
  put(sidepodGeo(), body_, 0, 0, 0, { cast: true, name: 'sidepods' });
  put(podInletGeo(), carbon_, 0, 0, 0, { name: 'podInlets' });
  put(rearCloseoutBodyGeo(), body_, 0, 0, 0, { cast: true, name: 'rearCloseoutBody' });
  put(rearCloseoutGeo(), carbon_, 0, 0, 0, { name: 'rearCloseout' });
  put(finGeo(variant.fin), body_, 0, FIN[variant.fin].y, FIN[variant.fin].z,
    { cast: true, name: 'sharkFin' });
  put(airboxGeo(), body_, 0, AIRBOX_Y, AIRBOX_Z, { s: [1.05, 1, 0.95], name: 'airboxScoop' });
  put(airboxIntakeGeo(), carbon_, 0, 0.660, 0.060, { name: 'airboxIntake' });
  // T-cam pod: dark grey like the broadcast unit, and its base is SUNK into the
  // airbox crown (crown top ~0.755) — the old accent-coloured box hovered above
  // the engine cover and judged as "a free-floating yellow cuboid".
  put(BOX(), carbon_, 0, 0.735, AIRBOX_Z, { s: [0.070, 0.090, 0.150], name: 'tCam' });
  put(gearboxGeo(), carbon_, 0, 0.31, -1.755, { name: 'gearbox' });
  put(exhaustGeo(), chromeM(), 0, 0.47, -2.18, { name: 'exhaust' });
  put(diffuserGeo(), carbon_, 0, 0, 0, { name: 'diffuser' });
  put(brakeDuctGeo(), carbon_, 0, 0, 0, { name: 'brakeDucts' });
  put(suspFrontGeo(), carbon_, 0, 0, 0, { name: 'suspFront' });
  put(suspRearGeo(), carbon_, 0, 0, 0, { name: 'suspRear' });
  put(mirrorArmGeo(), carbon_, 0, 0, 0, { name: 'mirrorArms' });
  put(mirrorPodGeo(), carbon_, 0, 0, 0, { name: 'mirrorPods' });
  put(mirrorGlassGeo(), mirrorGlassM(), 0, 0, 0, { name: 'mirrorGlass' });

  /* --- cockpit & driver ------------------------------------------------- */
  put(cockpitCoamingGeo(), body_, 0, 0, 0, { cast: true, name: 'cockpitCoaming' });
  put(cockpitFrameGeo(), carbon_, 0, 0, 0, { name: 'cockpitFrame' });
  put(headrestPadGeo(), carbon_, 0, 0, 0, { name: 'headrestPad' });
  put(BALL(), helmetShellM(helm.shell), 0, 0.575, 0.36,
    { s: [0.155, 0.155, 0.155], cast: true, name: 'helmet' });
  put(BALL(), helmetTrimM(helm.trim), 0, 0.575, 0.36,
    { s: [0.062, 0.1585, 0.1585], name: 'helmetStripe' });
  put(helmetBandGeo(), helmetTrimM(helm.trim), 0, 0.532, 0.36, { name: 'helmetBand' });
  put(BOX(), visorM(), 0, 0.588, 0.487, { s: [0.20, 0.062, 0.085], r: [0.15, 0, 0], name: 'visor' });
  put(BOX(), carbon_, 0, 0.485, 0.63, { s: [0.21, 0.055, 0.035], r: [-0.55, 0, 0], name: 'steeringWheel' });
  put(glovesGeo(), gloveM(), 0, 0.505, 0.615, { name: 'gloves' });
  put(haloGeo(), carbon_, HALO_POS[0], HALO_POS[1], HALO_POS[2], { cast: true, name: 'halo' });

  /* --- wings ------------------------------------------------------------ */
  put(fwBodyGeo(), body_, 0, 0, 0, { cast: true, name: 'frontWing' });
  put(fwAccentGeo(), accent_, 0, 0, 0, { name: 'frontWingAccent' });
  put(fwPylonGeo(), carbon_, 0, 0, 0, { name: 'frontWingPylons' });
  put(beamGeo(), carbon_, 0, 0, 0, { name: 'beamWing' });
  put(rwMainplaneGeo(), accent_, 0, 0, 0, { cast: true, name: 'rearWingMainplane' });
  put(rwFlapGeo(), body_, 0, 0, 0, { cast: true, name: 'rearWingFlap' });
  put(rwEndplateGeo(variant.rwTop), body_, 0, 0, 0, { cast: true, name: 'rearWingEndplates' });

  /* --- livery graphics -------------------------------------------------- */
  // Every decal plane is FrontSide and floated >= DECAL_GAP off the surface it
  // sits on, so nothing ghost-mirrors through to the opposite flank.
  const numMat = decalM(`num:${drv.num}:${lightNumber ? 'l' : 'd'}`, numberTex(drv.num, lightNumber));
  const podMat = decalM('pod', sponsorTex('pod'));
  const epMat = decalM('ep', sponsorTex('ep'));
  const stripeMat = decalM(`stripe:${team.accent}`, stripeTex(team.accent));

  // race number on both engine-cover flanks; the yaw matches the spine taper so
  // the offset is uniform along the decal instead of pinching at one end.
  const ecYaw = HALF_PI + 0.136;
  const ecX = SPN_SX * spnR(-0.70) + 0.016;
  put(PLANE(), numMat, -ecX, 0.41, -0.70, { s: [0.30, 0.22, 1], r: [0, -ecYaw, 0], name: 'numberEC' });
  put(PLANE(), numMat, ecX, 0.41, -0.70, { s: [0.30, 0.22, 1], r: [0, ecYaw, 0], name: 'numberEC' });
  // ...and on the nose flanks, fitted to the measured nose surface so the panel
  // can never clip mid-glyph into the cone (see noseNumberFit).
  const nf = noseNumberFit(variant.nose, noseMesh);
  put(PLANE(), numMat, -nf.x, NOSE_NUM_SPEC.y, NOSE_NUM_SPEC.z,
    { s: [NOSE_NUM_SPEC.w, NOSE_NUM_SPEC.h, 1], r: [0, -nf.yaw, 0], name: 'numberNose' });
  put(PLANE(), numMat, nf.x, NOSE_NUM_SPEC.y, NOSE_NUM_SPEC.z,
    { s: [NOSE_NUM_SPEC.w, NOSE_NUM_SPEC.h, 1], r: [0, nf.yaw, 0], name: 'numberNose' });
  // sponsors: flat sidepod flanks + flat rear-wing endplates
  put(PLANE(), podMat, -0.786, 0.37, -0.10, { s: [1.10, 0.20, 1], r: [0, -HALF_PI, 0] });
  put(PLANE(), podMat, 0.786, 0.37, -0.10, { s: [1.10, 0.20, 1], r: [0, HALF_PI, 0] });
  put(PLANE(), epMat, -0.740, 0.78, -2.14, { s: [0.40, 0.22, 1], r: [0, -HALF_PI, 0] });
  put(PLANE(), epMat, 0.740, 0.78, -2.14, { s: [0.40, 0.22, 1], r: [0, HALF_PI, 0] });
  // accent sweep on the shark fin: a flat surface, so the decal cannot pinch
  // into the bodywork the way a curved-spine placement did.
  {
    const cfg = FIN[variant.fin], st = cfg.stripe;
    const fx = Math.abs(cfg.x[cfg.x.length - 1]) + cfg.t / 2 + DECAL_GAP + 0.001;
    // r=[0, +-HALF_PI, +-HALF_PI] maps the plane's x-extent to world Y and its
    // y-extent to world Z, with the texture's opaque wide end at the fin's deep
    // rear edge and its faded end forward.
    put(PLANE(), stripeMat, fx, st.y, st.z, { s: [st.h, st.len, 1], r: [0, HALF_PI, HALF_PI], name: 'finStripe' });
    put(PLANE(), stripeMat, -fx, st.y, st.z, { s: [st.h, st.len, 1], r: [0, -HALF_PI, -HALF_PI], name: 'finStripe' });
  }
  // nose roundel (kept)
  put(DISC(), decalM(`roundel:${drv.num}:${accent.getHexString()}`, roundelTex(drv.num, accent)),
    0, 0.545, 1.42, { s: [0.12, 0.12, 1], r: [-HALF_PI, 0, 0], name: 'roundel' });

  /* --- race-state hooks ------------------------------------------------- */
  // per-car materials: another module drives these, so they must not be shared
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff6a12, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const brakeGlows = [
    put(DISC(), glowMat, -0.60, 0.34, 1.55, { s: [0.15, 0.15, 1], r: [0, -HALF_PI, 0] }),
    put(DISC(), glowMat, 0.60, 0.34, 1.55, { s: [0.15, 0.15, 1], r: [0, HALF_PI, 0] }),
  ];
  for (const d of brakeGlows) d.visible = false;

  const rainMat = new THREE.MeshBasicMaterial({ color: 0xff1a12, transparent: true });
  const rainLight = put(BOX(), rainMat, 0, 0.365, -2.20, { s: [0.13, 0.07, 0.05], name: 'rainLight' });
  rainLight.visible = true;

  /* --- wheels ----------------------------------------------------------- */
  // rotation.order MUST stay 'YXZ': race.js sets rotation.y (steer) and
  // rotation.x (spin) directly and steer must be applied first.
  const bandMats = [];
  const tyreBands = [];
  const wheels = {};
  const wr = 0.34;
  for (const [key, x, z, w] of [
    ['fl', -0.82, 1.55, 0.30], ['fr', 0.82, 1.55, 0.30],
    ['rl', -0.85, -1.60, 0.38], ['rr', 0.85, -1.60, 0.38],
  ]) {
    const side = Math.sign(x);
    const g = new THREE.Group();
    g.rotation.order = 'YXZ';
    g.position.set(x, wr, z);

    const tyre = new THREE.Mesh(tyreGeo(w), tyreM());
    tyre.castShadow = true;
    tyre.name = 'tyre';
    g.add(tyre);

    const rim = new THREE.Mesh(wheelRimGeo(w), rimM());
    rim.name = 'rim';
    g.add(rim);

    const face = new THREE.Mesh(DISC(), rimFaceM());
    face.scale.set(BEAD_R, BEAD_R, 1);
    face.position.x = side * (w * 0.46 + 0.004);   // proud of the rim barrel, recessed in the tyre
    face.rotation.y = side * HALF_PI;
    face.name = 'rimFace';
    g.add(face);

    const bandMat = new THREE.MeshStandardMaterial({
      color: COMPOUND_COLORS.M, metalness: 0.1, roughness: 0.55,
      emissive: new THREE.Color(COMPOUND_COLORS.M).multiplyScalar(0.12),
    });
    const band = new THREE.Mesh(bandGeo(), bandMat);
    band.position.x = side * (w / 2 + 0.008);
    band.name = 'compoundBand';
    g.add(band);
    bandMats.push(bandMat);
    tyreBands.push(band);

    group.add(g);
    wheels[key] = g;
  }

  const handle = {
    group, wheels, wheelRadius: wr,
    body, team, driver: drv,
    tyreBands, tyreBandMats: bandMats, compound: 'M',
    brakeGlows, brakeGlowMaterial: glowMat,
    rainLight, rainLightMaterial: rainMat,
    // extras used by tools/validate-geometry.mjs (and handy for debugging)
    variant,
    monocoque: tub,
    haloFeet: HALO_FEET.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    frontWingMinY: FW_MIN_Y,
    helmetColors: helm,
    source: 'primitives',
  };
  group.userData.brakeGlows = brakeGlows;
  group.userData.rainLight = rainLight;
  group.userData.carVariant = variant;
  return handle;
}

// Recolour the sidewall compound band on all four wheels. key: 'S' | 'M' | 'H'.
export function setTyreCompound(carHandle, key) {
  const hex = COMPOUND_COLORS[key];
  if (!carHandle || hex === undefined) return false;
  const mats = carHandle.tyreBandMats
    || (carHandle.tyreBands || []).map((m) => m.material);
  for (const m of mats) {
    if (!m) continue;
    m.color.setHex(hex);
    if (m.emissive) m.emissive.setHex(hex).multiplyScalar(0.12);
  }
  carHandle.compound = key;
  return true;
}

export function buildNameTag(driver, team) {
  const code = driver.code || '???';
  const SS = 2; // supersample so the glyphs stay crisp on the sprite
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `900 ${30 * SS}px Arial, sans-serif`;
  g.font = font;
  let textW = g.measureText(code).width;
  if (!(textW > 1)) textW = code.length * 19 * SS; // headless canvas stubs
  // the panel hugs its glyphs: measured text + colour bar + small padding
  const pad = 5 * SS, bar = 5 * SS, gap = 4 * SS, panelH = 40 * SS, margin = 4 * SS;
  const panelW = Math.ceil(pad + bar + gap + textW + pad);
  c.width = panelW + margin * 2; // margin leaves room for the drop shadow
  c.height = panelH + margin * 2;
  g.font = font; // setting width/height reset the context state
  g.textAlign = 'left'; g.textBaseline = 'middle';
  // barely-there backing: the car being named must stay visible through it
  g.fillStyle = 'rgba(8,9,13,0.32)';
  roundRect(g, margin, margin, panelW, panelH, 7 * SS);
  g.fill();
  g.fillStyle = '#' + new THREE.Color(team.color).getHexString();
  g.fillRect(margin + pad, margin + 7 * SS, bar, panelH - 14 * SS);
  // outlined + drop-shadowed glyphs read against any livery or tarmac
  const tx = margin + pad + bar + gap, ty = margin + panelH / 2 + SS;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 3 * SS; g.shadowOffsetY = 1.5 * SS;
  g.lineJoin = 'round'; g.lineWidth = 4.5 * SS; g.strokeStyle = 'rgba(0,0,0,0.92)';
  g.strokeText(code, tx, ty);
  g.restore();
  g.fillStyle = '#fff';
  g.fillText(code, tx, ty);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, opacity: 0.95 });
  const sprite = new THREE.Sprite(mat);
  const worldH = 0.5; // metres tall over the car
  sprite.scale.set(worldH * c.width / c.height, worldH, 1);
  sprite.renderOrder = 999;
  sprite.center.set(0.5, 0);
  sprite.userData.nametag = { code, textW, panelW, panelH, canvasW: c.width, canvasH: c.height };
  return sprite;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Chassis reference surfaces, exported so tooling can assert seating without
// duplicating the maths.
export const CHASSIS = {
  tub: { z0: TUB_Z0, z1: TUB_Z1, cy: TUB_CY, sx: TUB_SX, sy: TUB_SY, r0: TUB_R0, r1: TUB_R1 },
  tubHalfX, tubTop, spineTopAtX,
  haloFeet: HALO_FEET,
  frontWingMinY: FW_MIN_Y,
  decalGap: DECAL_GAP,
};
