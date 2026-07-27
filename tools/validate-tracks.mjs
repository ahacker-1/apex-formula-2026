// Validator for js/tracks.js
// Checks, for every circuit:
//   (a) closed polyline length within 15% of lengthKm * 1000
//   (b) minimum consecutive-point distance >= 10 m (including the wrap segment)
//   (c) no segment-segment self-intersection of the closed polyline
//   (d) all 24 required track ids present with the full schema
// Exits non-zero if any check fails.

import { TRACKS } from '../js/tracks.js';

const REQUIRED_IDS = [
  'melbourne', 'shanghai', 'suzuka', 'bahrain', 'jeddah', 'miami', 'montreal',
  'monaco', 'barcelona', 'spielberg', 'silverstone', 'spa', 'hungaroring',
  'zandvoort', 'monza', 'madrid', 'baku', 'singapore', 'austin', 'mexico',
  'interlagos', 'lasvegas', 'lusail', 'yasmarina',
];
const REQUIRED_FIELDS = ['name', 'location', 'country', 'lengthKm', 'width', 'points'];

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL:', msg); };

function closedLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

function minConsecutive(pts) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    m = Math.min(m, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return m;
}

function properIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) {
    // parallel: check collinear overlap
    const cross = (p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x;
    if (Math.abs(cross) > 1e-9) return false;
    const len2 = d1x * d1x + d1y * d1y;
    const t3 = ((p3[0] - p1[0]) * d1x + (p3[1] - p1[1]) * d1y) / len2;
    const t4 = ((p4[0] - p1[0]) * d1x + (p4[1] - p1[1]) * d1y) / len2;
    const lo = Math.min(t3, t4), hi = Math.max(t3, t4);
    return hi > 1e-9 && lo < 1 - 1e-9;
  }
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function selfIntersections(pts) {
  const n = pts.length, bad = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // segments adjacent via wrap
      if (properIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) {
        bad.push([i, j]);
      }
    }
  }
  return bad;
}

// (d) presence + schema
console.log('Schema checks');
const ids = Object.keys(TRACKS);
if (ids.length !== 24) fail(`expected 24 tracks, found ${ids.length}`);
for (const id of REQUIRED_IDS) {
  if (!TRACKS[id]) { fail(`missing required track id '${id}'`); continue; }
  const t = TRACKS[id];
  for (const f of REQUIRED_FIELDS) {
    if (t[f] === undefined) fail(`${id}: missing field '${f}'`);
  }
  if (!Array.isArray(t.points) || t.points.length < 3) fail(`${id}: points must be an array of [x,z] pairs`);
  else if (t.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    fail(`${id}: points contain a malformed entry`);
  }
  if (typeof t.width !== 'number' || t.width < 9 || t.width > 16) fail(`${id}: width ${t.width} out of range`);
}
for (const id of ids) if (!REQUIRED_IDS.includes(id)) fail(`unexpected track id '${id}'`);
if (failures === 0) console.log('  OK: 24/24 tracks present, all fields valid');

// (a)-(c) geometry
console.log('\nGeometry checks');
console.log('track         points   length(m)  target(m)   diff%   minGap(m)  selfInt');
for (const id of REQUIRED_IDS) {
  const t = TRACKS[id];
  if (!t || !Array.isArray(t.points)) continue;
  const pts = t.points;
  const L = closedLength(pts);
  const target = t.lengthKm * 1000;
  const diffPct = 100 * (L - target) / target;
  const minGap = minConsecutive(pts);
  const inter = selfIntersections(pts);

  const row = `${id.padEnd(12)} ${String(pts.length).padStart(6)}  ${L.toFixed(0).padStart(9)}  ${target.toFixed(0).padStart(9)}  ${(diffPct >= 0 ? '+' : '') + diffPct.toFixed(2) + '%'}   ${minGap.toFixed(1).padStart(8)}  ${String(inter.length).padStart(6)}`;
  console.log(row);

  if (Math.abs(diffPct) > 15) fail(`${id}: closed length ${L.toFixed(0)} m deviates ${diffPct.toFixed(1)}% from ${target} m (>15%)`);
  if (minGap < 10) fail(`${id}: consecutive points closer than 10 m (${minGap.toFixed(2)} m)`);
  if (inter.length > 0) fail(`${id}: polyline self-intersects at segment pairs ${JSON.stringify(inter)}`);
}

console.log('');
if (failures > 0) {
  console.error(`VALIDATION FAILED: ${failures} problem(s)`);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED: 24 tracks, lengths within 15%, min spacing >= 10 m, no self-intersections');
}
