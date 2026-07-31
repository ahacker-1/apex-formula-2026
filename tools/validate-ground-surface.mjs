#!/usr/bin/env node
// Deterministic ground-surface validator: authored grass spectrum/seam, runtime
// vertex-colour macro variation, and a geometric upper bound on canopy alpha.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, groundTileMetrics } from './make-ground-tiles.mjs';

function makeCtx2D() {
  const noop = () => {};
  return {
    fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
    lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0,
    shadowColor: '#000', globalCompositeOperation: 'source-over', filter: 'none',
    fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    arcTo: noop, ellipse: noop, rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    fill: noop, stroke: noop, clip: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }),
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    transform: noop, setTransform: noop, resetTransform: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null, drawImage: noop,
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: noop,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
}

function makeCanvas() {
  const ctx = makeCtx2D();
  return {
    nodeName: 'CANVAS', tagName: 'CANVAS', width: 300, height: 150, style: {},
    getContext: () => ctx, toDataURL: () => 'data:,',
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, getAttribute: () => null,
  };
}

globalThis.document = globalThis.document || {
  createElementNS: (_ns, tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : { style: {} }),
  createElement: tag => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : { style: {} }),
  createTextNode: () => ({}), addEventListener: () => {}, removeEventListener: () => {},
};
globalThis.window = globalThis.window || { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globalThis.self = globalThis.self || globalThis.window;

const THREE = await import('three');
const { buildCircuit, VENUE } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRASS = path.join(ROOT, 'textures/grass.png');
const EXPECTED_MEAN = 97.74;
// Pre-fix wrapped horizontal/vertical first-difference RMS, measured from the
// original 2,485,122-byte tile before tools/make-ground-tiles.mjs was applied.
const PRE_FIX_HIGH_FREQUENCY_RMS = 25.24709320322419;
const PRE_FIX_WRAP_SEAM_MAD = 0;
const MIN_COLOUR_LUMA_STDDEV = 0.018;
// Measured after moving the 46m/16m macro octaves and the woodland density out
// of vertex colours: worst 0.07760 (Suzuka), down from 0.24717. The remaining
// delta is the deliberately broad track-distance/biome transition.
const MAX_ADJACENT_VERTEX_LUMA_DELTA = 0.08;
const CANOPY_ALPHA_CEILING = 0.55;

let checks = 0, failures = 0;
function assert(condition, label, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}${detail ? `  ${detail}` : ''}`);
  }
}

const grassBytes = fs.readFileSync(GRASS);
const grass = groundTileMetrics(decodePng(grassBytes));
assert(grass.dominantColumn.amplitude <= 2,
  'grass dominant column-banding amplitude is <= 2.0 luma',
  `[${grass.dominantColumn.amplitude.toFixed(4)} @ ${grass.dominantColumn.cycles} cycles/tile]`);
assert(grass.columnPeakToPeak <= 12,
  'grass column peak-to-peak is <= 12 luma', `[${grass.columnPeakToPeak.toFixed(4)}]`);
assert(Math.abs(grass.meanLuma - EXPECTED_MEAN) <= 1,
  'grass mean luminance stays within 1.0 luma of the authored baseline',
  `[${grass.meanLuma.toFixed(4)} vs ${EXPECTED_MEAN.toFixed(2)}]`);
const hfRatio = grass.highFrequencyRms / PRE_FIX_HIGH_FREQUENCY_RMS;
assert(hfRatio >= 0.9 && hfRatio <= 1.1,
  'grass high-frequency RMS stays within 10% of the pre-fix tile',
  `[${grass.highFrequencyRms.toFixed(4)} vs ${PRE_FIX_HIGH_FREQUENCY_RMS.toFixed(4)}, ${(hfRatio * 100).toFixed(2)}%]`);
assert(grass.wrapSeamMad <= PRE_FIX_WRAP_SEAM_MAD + 1e-9,
  'grass horizontal wrap seam is no worse than before the transform',
  `[${grass.wrapSeamMad.toFixed(6)} vs ${PRE_FIX_WRAP_SEAM_MAD.toFixed(6)} mean RGB delta]`);

function named(circuit, name) {
  let found = null;
  circuit.group.traverse(object => { if (!found && object.name === name) found = object; });
  return found;
}

function attributeBytes(attribute) {
  return Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
}

function colourStats(attribute) {
  let sum = 0, sum2 = 0, bad = 0;
  for (let i = 0; i < attribute.count; i++) {
    const r = attribute.getX(i), g = attribute.getY(i), b = attribute.getZ(i);
    if (![r, g, b].every(value => Number.isFinite(value) && value >= 0 && value <= 2)) bad++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma; sum2 += luma * luma;
  }
  const mean = sum / attribute.count;
  return { bad, stddev: Math.sqrt(Math.max(0, sum2 / attribute.count - mean * mean)) };
}

function adjacentColourStats(mesh) {
  const colour = mesh.geometry.attributes.color;
  const index = mesh.geometry.index;
  let max = 0, sum = 0, samples = 0;
  const luma = i => 0.2126 * colour.getX(i) + 0.7152 * colour.getY(i) + 0.0722 * colour.getZ(i);
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let edge = 0; edge < 3; edge++) {
      const delta = Math.abs(luma(tri[edge]) - luma(tri[(edge + 1) % 3]));
      max = Math.max(max, delta);
      sum += delta;
      samples++;
    }
  }
  return { max, mean: sum / Math.max(1, samples), samples };
}

function canopyBlobs(mesh) {
  const position = mesh.geometry.attributes.position;
  const colour = mesh.geometry.attributes.color;
  if (!position || !colour || position.count % 4 !== 0 || colour.count !== position.count) return [];
  // The quad is deliberately oversized while its generated alpha dies at this
  // fraction of the half-extent. Measure visible support, not transparent moat.
  const alphaSupport = mesh.userData.shadePolicy?.alphaSupportHalfExtent ?? 1;
  const blobs = [];
  for (let base = 0; base < position.count; base += 4) {
    let x = 0, z = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let alpha = 0;
    for (let k = 0; k < 4; k++) {
      const px = position.getX(base + k), pz = position.getZ(base + k);
      x += px; z += pz; alpha += colour.getX(base + k);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
    }
    blobs.push({
      x: x / 4, z: z / 4, alpha: alpha / 4,
      support: Math.max((maxX - minX) / 2, (maxZ - minZ) / 2) * alphaSupport,
    });
  }
  return blobs;
}

// If several ellipse supports cover one point, every pair of their supports
// overlaps. Therefore each member's total overlap count is at least the number
// covering that point. alpha_i * overlapCount_i <= ceiling is a conservative
// proof that the sum at every point is <= ceiling, even before the radial mask
// attenuates the ellipses toward their edges.
function canopyAlphaBound(blobs) {
  let worst = 0;
  for (let i = 0; i < blobs.length; i++) {
    let overlaps = 0;
    for (let j = 0; j < blobs.length; j++) {
      const dx = blobs[i].x - blobs[j].x, dz = blobs[i].z - blobs[j].z;
      const reach = blobs[i].support + blobs[j].support;
      if (dx * dx + dz * dz <= reach * reach + 1e-6) overlaps++;
    }
    worst = Math.max(worst, blobs[i].alpha * overlaps);
  }
  return worst;
}

let minStddev = { value: Infinity, track: '' };
let worstAdjacent = { value: 0, track: '', mean: 0 };
let maxCanopyAlpha = { value: 0, track: '', blobs: 0 };
const bandSignatures = new Map();
const measuredGroundGreenness = new Map();
const groundRows = [];
let greenContrast = null;
for (const trackId of Object.keys(TRACKS)) {
  const first = buildCircuit(trackId, TRACKS[trackId], new THREE.Scene());
  const second = buildCircuit(trackId, TRACKS[trackId], new THREE.Scene());
  const ground = named(first, 'ground');
  const otherGround = named(second, 'ground');
  assert(!!ground && !!otherGround, `${trackId}: ground mesh exists in both independent builds`);
  if (ground && otherGround) {
    const colour = ground.geometry.attributes.color;
    const otherColour = otherGround.geometry.attributes.color;
    const positions = ground.geometry.attributes.position;
    assert(!!colour && colour.itemSize === 3 && colour.count === positions.count,
      `${trackId}: ground has one RGB colour per vertex`,
      `[colours=${colour?.count ?? 0} vertices=${positions.count}]`);
    assert(ground.material.vertexColors === true,
      `${trackId}: ground material consumes vertex colours`);
    if (colour && otherColour) {
      const stats = colourStats(colour);
      assert(stats.bad === 0, `${trackId}: every ground colour component is finite and within [0,2]`,
        `[bad=${stats.bad}/${colour.count * 3}]`);
      assert(attributeBytes(colour).equals(attributeBytes(otherColour)),
        `${trackId}: ground vertex colours are byte-identical across independent builds`);
      assert(stats.stddev >= MIN_COLOUR_LUMA_STDDEV,
        `${trackId}: ground macro variation exceeds the luma standard-deviation floor`,
        `[${stats.stddev.toFixed(5)} >= ${MIN_COLOUR_LUMA_STDDEV.toFixed(3)}]`);
      if (stats.stddev < minStddev.value) minStddev = { value: stats.stddev, track: trackId };
      const adjacent = adjacentColourStats(ground);
      assert(adjacent.max <= MAX_ADJACENT_VERTEX_LUMA_DELTA,
        `${trackId}: adjacent ground-vertex luma cannot encode visible high-frequency cells`,
        `[max=${adjacent.max.toFixed(5)} mean=${adjacent.mean.toFixed(5)} ceiling=${MAX_ADJACENT_VERTEX_LUMA_DELTA.toFixed(3)}]`);
      if (adjacent.max > worstAdjacent.value) {
        worstAdjacent = { value: adjacent.max, track: trackId, mean: adjacent.mean };
      }
    }
    const meta = ground.userData;
    const expectedBands = VENUE[trackId]?.ground;
    const realisedBands = meta.groundBands;
    assert(Array.isArray(expectedBands) && Array.isArray(realisedBands)
      && expectedBands.length >= 2 && expectedBands.length <= 3
      && realisedBands.length === expectedBands.length,
    `${trackId}: VENUE and realised ground both carry two or three genuine outward bands`);
    if (expectedBands && realisedBands) {
      const exact = expectedBands.every((band, i) => band.to === realisedBands[i]?.to
        && band.surface === realisedBands[i]?.surface && band.tint === realisedBands[i]?.tint
        && ['grass', 'gravel', 'asphalt'].includes(realisedBands[i]?.tile));
      assert(exact, `${trackId}: realised ground bands match its VENUE entry exactly`);
      assert(realisedBands.slice(0, -1).every((band, i) => Number.isFinite(band.to)
        && band.to > (i ? realisedBands[i - 1].to : 0)) && realisedBands.at(-1).to === Infinity,
        `${trackId}: ground bands are ordered outward and terminate at Infinity`);
      const signature = realisedBands.map(band => `${band.to}:${band.surface}:${band.tint}`).join('|');
      assert(!bandSignatures.has(signature), `${trackId}: ground-band identity is not shared with another circuit`,
        `[duplicate=${bandSignatures.get(signature) || 'none'}]`);
      bandSignatures.set(signature, trackId);
      groundRows.push(`${trackId}: ${realisedBands.map(band => `${band.surface}/${band.tile}@${Number.isFinite(band.to) ? `${band.to}m` : 'inf'}`).join(' > ')}`);

      // Measure the authored colour actually supplied to the ground shader over
      // the first 180m outfield. Area is sampled in metres so a narrow artificial
      // turf strip cannot make an otherwise desert venue test as green. The
      // normalized opponent score is positive for green-biased ground and near
      // zero for pale yellow/grey sand.
      let score = 0, samples = 0;
      for (let metres = 2; metres <= 180; metres += 4) {
        const band = realisedBands.find(candidate => metres <= candidate.to);
        const tint = new THREE.Color(band.tint);
        const sum = tint.r + tint.g + tint.b;
        score += sum > 1e-9 ? (2 * tint.g - tint.r - tint.b) / sum : 0;
        samples++;
      }
      measuredGroundGreenness.set(trackId, score / samples);
    }
    assert(Array.isArray(meta.macroOctaves) && meta.macroOctaves.length === 3
      && meta.vertexMacroOctaves?.length === 1 && meta.vertexMacroOctaves[0].wavelength >= 560
      && meta.fragmentMacroOctaves?.length === 2
      && meta.zoneBands?.mass && meta.noiseAmplitude >= 0.10 && meta.noiseAmplitude <= 0.14
      && meta.woodlandLayer?.placements >= 0,
    `${trackId}: ground publishes split vertex/fragment macro, zoning, noise, and woodland metadata`);
    const shaderMeta = ground.material.userData.macroShader;
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <map_fragment>' };
    ground.material.onBeforeCompile(shader);
    const totalWeight = meta.macroOctaves.reduce((sum, octave) => sum + octave.weight, 0);
    assert(shaderMeta?.stage === 'fragment' && shaderMeta.coordinate === 'world-xz'
      && shaderMeta.octaves?.length === 2 && Math.abs(totalWeight - 1) < 1e-9
      && shader.vertexShader.includes('vApexGroundWorldXZ')
      && shader.fragmentShader.includes('apexGroundNoise(vApexGroundWorldXZ, 46.0')
      && shader.fragmentShader.includes('apexGroundNoise(vApexGroundWorldXZ, 16.0')
      && shader.fragmentShader.includes('texture2D(apexGroundDistanceMap')
      && shader.fragmentShader.includes('texture2D(apexGroundBandMap0')
      && shader.fragmentShader.includes('texture2D(apexWoodlandMap, apexWoodlandUV)'),
    `${trackId}: macro variation and band selection are evaluated per fragment from world position`);
    const distanceTexture = ground.material.userData.groundDistanceTexture;
    const otherDistanceTexture = otherGround.material.userData.groundDistanceTexture;
    assert(distanceTexture?.isDataTexture && distanceTexture.image.width === meta.groundDistanceField?.textureSize
      && distanceTexture.minFilter === THREE.LinearFilter && distanceTexture.magFilter === THREE.LinearFilter
      && Buffer.from(distanceTexture.image.data).equals(Buffer.from(otherDistanceTexture?.image?.data || [])),
    `${trackId}: outward kerb-distance field is deterministic and linearly filtered`);
    assert(meta.groundBandCoordinate === 'metres-outward-from-outer-kerb'
      && meta.groundDistanceField?.stage === 'fragment'
      && ground.material.userData.groundBandTextures?.every(texture => texture?.isTexture
        && texture.repeat.x === 1 && texture.repeat.y === 1 && texture.anisotropy >= 16),
    `${trackId}: band selection preserves fixed UV repeat and high anisotropy`);
    if (trackId === 'suzuka') {
      assert(meta.groundBandTintResponse?.cutScars?.surface === 'graded-green-earth-bank'
        && shader.fragmentShader.includes('apexSuzukaClayScar'),
      'suzuka exposes sparse shader-level clay cut scars without a clay field band');
    }
    const woodland = ground.material.userData.woodlandTexture;
    const otherWoodland = otherGround.material.userData.woodlandTexture;
    assert(woodland?.isDataTexture && woodland.image.width === meta.woodlandLayer.textureSize
      && woodland.minFilter === THREE.LinearFilter && woodland.magFilter === THREE.LinearFilter
      && Buffer.from(woodland.image.data).equals(Buffer.from(otherWoodland?.image?.data || [])),
    `${trackId}: woodland density is a deterministic linearly-filtered fragment texture`);
  }

  const canopy = named(first, 'ground-shade-canopy');
  assert(!!canopy, `${trackId}: canopy dapple mesh exists`);
  if (canopy) {
    const blobs = canopyBlobs(canopy);
    assert(blobs.length > 0 && blobs.length * 4 === canopy.geometry.attributes.position.count,
      `${trackId}: canopy mesh is a deterministic set of merged ellipse quads`,
      `[blobs=${blobs.length}]`);
    const bound = canopyAlphaBound(blobs);
    assert(bound <= CANOPY_ALPHA_CEILING + 1e-5,
      `${trackId}: summed canopy decal alpha cannot exceed ${CANOPY_ALPHA_CEILING}`,
      `[conservative upper bound=${bound.toFixed(4)} across ${blobs.length} blobs]`);
    if (bound > maxCanopyAlpha.value) maxCanopyAlpha = { value: bound, track: trackId, blobs: blobs.length };
  }
  first.dispose();
  second.dispose();
}

assert(bandSignatures.size === Object.keys(TRACKS).length,
  'no two circuits share an identical realised ground-band set',
  `[${bandSignatures.size}/${Object.keys(TRACKS).length}]`);

{
  const wetGreen = ['spa', 'suzuka', 'monza'];
  const paleArid = ['bahrain', 'lusail', 'zandvoort'];
  const wetFloor = Math.min(...wetGreen.map(id => measuredGroundGreenness.get(id)));
  const aridCeiling = Math.max(...paleArid.map(id => measuredGroundGreenness.get(id)));
  greenContrast = { wetFloor, aridCeiling };
  assert(wetFloor >= aridCeiling + 0.15,
    'spa, suzuka, and monza ground tint is clearly greener than bahrain, lusail, and zandvoort',
    `[wet floor=${wetFloor.toFixed(3)} arid ceiling=${aridCeiling.toFixed(3)} gap=${(wetFloor - aridCeiling).toFixed(3)}]`);
}

console.log(`GROUND SURFACE: ${checks - failures}/${checks} checks passed across ${Object.keys(TRACKS).length} circuits`);
console.log(`ground-band signatures: ${bandSignatures.size}/${Object.keys(TRACKS).length} unique`);
console.log(`wet/arid green-score gap: ${greenContrast.wetFloor.toFixed(3)} - ${greenContrast.aridCeiling.toFixed(3)} = ${(greenContrast.wetFloor - greenContrast.aridCeiling).toFixed(3)} (floor 0.150)`);
for (const row of groundRows) console.log(`ground bands ${row}`);
console.log(`grass: ${grassBytes.length.toLocaleString('en-US')} bytes; mean ${grass.meanLuma.toFixed(4)}; dominant ${grass.dominantColumn.amplitude.toFixed(4)} @ ${grass.dominantColumn.cycles} cycles/tile; column p-p ${grass.columnPeakToPeak.toFixed(4)}; HF RMS ${grass.highFrequencyRms.toFixed(4)}; seam ${grass.wrapSeamMad.toFixed(4)}`);
console.log(`ground colour luma stddev: minimum ${minStddev.value.toFixed(5)} (${minStddev.track}), floor ${MIN_COLOUR_LUMA_STDDEV.toFixed(3)}`);
console.log(`adjacent ground-vertex luma delta: worst ${worstAdjacent.value.toFixed(5)} (${worstAdjacent.track}; mean ${worstAdjacent.mean.toFixed(5)}), ceiling ${MAX_ADJACENT_VERTEX_LUMA_DELTA.toFixed(3)}`);
console.log(`canopy summed-alpha upper bound: ${maxCanopyAlpha.value.toFixed(4)} (${maxCanopyAlpha.track}, ${maxCanopyAlpha.blobs} blobs), ceiling ${CANOPY_ALPHA_CEILING}`);
process.exit(failures ? 1 : 0);
