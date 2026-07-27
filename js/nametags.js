// Driver nametag screen-space layout.
//
// The tag sprites are world-anchored (child of each car, TAG_ANCHOR_Y up) but
// everything that makes them readable is a screen-space problem: panels must
// not pile into an opaque column on the grid, must not run off the frame edge,
// and must not bury the car they name. This module owns that per-frame pass.
// It is pure three.js math (no DOM), shared verbatim by the game (js/race.js)
// and the acceptance harness (tools/nametag-harness.html) so what the tests
// measure is exactly what the game runs.
//
// Guarantees, in priority order (nearest car first):
//   1. distance cull: only cars within TAG_RANGE metres of the player,
//   2. hard cap: at most TAG_MAX_VISIBLE tags on screen,
//   3. viewport clamp: a shown tag's rect sits fully inside the frame
//      (screen-space shift via sprite.center — the anchor stays on the car),
//   4. no stacking: a tag that would overlap an already-placed tag is dropped,
//   5. no burying: every tagged car keeps at least (1 - MAX_CAR_COVER) of its
//      projected rect free of tag panels. Placed rects are disjoint (rule 4),
//      so per-car coverage is the exact sum of pairwise intersections.

import { Vector3, Matrix4 } from 'three';

export const TAG_MAX_VISIBLE = 8; // hard cap — nearest cars win
export const TAG_RANGE = 70;      // metres, the long-standing distance cull
export const TAG_ANCHOR_Y = 1.6;  // sprite offset above the car origin (m)
export const MAX_CAR_COVER = 0.5; // a tagged car keeps >= 50% visible

// occlusion footprint of a car in world metres (screen-facing worst case:
// broadside length x wheel-top height, centred CAR_MID_Y above the origin)
const CAR_LEN = 5.6, CAR_H = 1.0, CAR_MID_Y = 0.5;

const _view = new Matrix4();
const _v = new Vector3();

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function interArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return (w > 0 && h > 0) ? w * h : 0;
}
function area(r) { return (r.right - r.left) * (r.bottom - r.top); }

/**
 * Lay out nametag sprites in screen space. Mutates tag.visible and tag.center.
 *
 * cands: [{ tag, x, y, z, d2 }] — tag is a THREE.Sprite built by
 *   buildNameTag() (center (0.5, 0), i.e. bottom-centre anchored); (x, y, z)
 *   is the car origin in world space (y = render elevation of the car base);
 *   d2 is the squared planar distance to the player in m².
 * camera: PerspectiveCamera (symmetric frustum), vw/vh: viewport CSS pixels.
 *
 * Returns diagnostics for harnesses:
 *   { placed: [{ tag, cand, rect, carRect, covered }] }
 * where rect/carRect are {left, top, right, bottom} in screen px (y down) and
 * covered is the tag-panel area currently sitting on that car's rect.
 */
export function layoutNametags(cands, camera, vw, vh) {
  camera.updateMatrixWorld();
  _view.copy(camera.matrixWorld).invert();
  const pe = camera.projectionMatrix.elements;
  const P00 = pe[0], P11 = pe[5];
  const near = camera.near || 0.1;

  const sorted = cands.slice().sort((a, b) => a.d2 - b.d2);
  const placed = [];
  for (const c of sorted) {
    const tag = c.tag;
    tag.visible = false;
    tag.center.set(0.5, 0);
    if (c.d2 >= TAG_RANGE * TAG_RANGE) continue;
    if (placed.length >= TAG_MAX_VISIBLE) continue;

    _v.set(c.x, c.y + TAG_ANCHOR_Y, c.z).applyMatrix4(_view);
    const depth = -_v.z;
    if (depth <= near) continue;
    // anchor (bottom-centre of the quad) in screen px, y down
    const sx = (P00 * _v.x / depth * 0.5 + 0.5) * vw;
    const sy = (0.5 - P11 * _v.y / depth * 0.5) * vh;
    // on-screen size of the sprite quad (view-space rect at the tag's depth)
    const w = tag.scale.x * P00 / depth * vw * 0.5;
    const h = tag.scale.y * P11 / depth * vh * 0.5;
    if (!(w > 0 && h > 0) || w > vw || h > vh) continue;
    // an anchor more than one tag-size outside the frame belongs to an
    // off-screen car: hide it rather than pin its tag to the frame edge
    if (sx < -w || sx > vw + w || sy < -h || sy > vh + 2 * h) continue;

    let left = sx - w / 2, top = sy - h;
    // clamp the rect fully inside the viewport
    let dx = 0, dy = 0;
    if (left < 0) dx = -left;
    else if (left + w > vw) dx = vw - (left + w);
    if (top < 0) dy = -top;
    else if (top + h > vh) dy = vh - (top + h);
    left += dx; top += dy;
    const rect = { left, top, right: left + w, bottom: top + h };

    // no stacking: drop any tag that would overlap an already-placed one
    if (placed.some((p) => overlaps(rect, p.rect))) continue;

    // no burying: adding this panel must not push any tagged car (its own
    // included) past MAX_CAR_COVER of its screen rect
    _v.set(c.x, c.y + CAR_MID_Y, c.z).applyMatrix4(_view);
    const cd = -_v.z;
    const cw = CAR_LEN * P00 / cd * vw * 0.5;
    const ch = CAR_H * P11 / cd * vh * 0.5;
    const ccx = (P00 * _v.x / cd * 0.5 + 0.5) * vw;
    const ccy = (0.5 - P11 * _v.y / cd * 0.5) * vh;
    const carRect = { left: ccx - cw / 2, top: ccy - ch / 2, right: ccx + cw / 2, bottom: ccy + ch / 2 };
    let ok = true;
    for (const p of placed) {
      if (p.covered + interArea(rect, p.carRect) > MAX_CAR_COVER * area(p.carRect)) { ok = false; break; }
    }
    let covered = interArea(rect, carRect);
    if (ok) {
      for (const p of placed) covered += interArea(p.rect, carRect);
      if (covered > MAX_CAR_COVER * area(carRect)) ok = false;
    }
    if (!ok) continue;

    for (const p of placed) p.covered += interArea(rect, p.carRect);
    // screen shift -> sprite.center offset (center moves the quad opposite
    // its own axis in view space; view +y is screen up, hence the signs)
    tag.center.set(0.5 - dx / w, dy / h);
    tag.visible = true;
    placed.push({ tag, cand: c, rect, carRect, covered });
  }
  return { placed };
}
