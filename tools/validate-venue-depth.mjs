// Deterministic structural validator for the procedural three-depth venue layer.
// Builds every circuit twice and verifies full instantiated footprints, caps,
// sky containment, far-mass materials, profile identity and matrix determinism.

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
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');

const SKY_R = 2600;
const MIN_MARGIN = 0.95; // builder targets 1.0m; leave 5cm for Float32 transforms
const NEW_NAMES = new Set([
  'venue-near-service', 'venue-near-tyre-stacks',
  'vegetation-near-trunks', 'vegetation-near-shrubs',
  'city-near', 'city-skyline', 'city-skyline-caps',
  'bahrain-paddock-boxes', 'bahrain-paddock-canopies', 'bahrain-paddock-towers',
]);
const isNewMesh = name => NEW_NAMES.has(name) || name.startsWith('vegetation-far-mass-v');

let checks = 0, failures = 0;
function assert(condition, label, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}${detail ? `  ${detail}` : ''}`);
  }
}

function pointSegD2(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  const dx = px - (ax + vx * t), dz = pz - (az + vz * t);
  return dx * dx + dz * dz;
}
function orient(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}
function onSeg(ax, az, bx, bz, px, pz) {
  return px >= Math.min(ax, bx) - 1e-8 && px <= Math.max(ax, bx) + 1e-8
    && pz >= Math.min(az, bz) - 1e-8 && pz <= Math.max(az, bz) + 1e-8;
}
function intersects(ax, az, bx, bz, cx, cz, dx, dz) {
  const o1 = orient(ax, az, bx, bz, cx, cz), o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az), o4 = orient(cx, cz, dx, dz, bx, bz);
  if (((o1 > 1e-8 && o2 < -1e-8) || (o1 < -1e-8 && o2 > 1e-8))
    && ((o3 > 1e-8 && o4 < -1e-8) || (o3 < -1e-8 && o4 > 1e-8))) return true;
  return (Math.abs(o1) <= 1e-8 && onSeg(ax, az, bx, bz, cx, cz))
    || (Math.abs(o2) <= 1e-8 && onSeg(ax, az, bx, bz, dx, dz))
    || (Math.abs(o3) <= 1e-8 && onSeg(cx, cz, dx, dz, ax, az))
    || (Math.abs(o4) <= 1e-8 && onSeg(cx, cz, dx, dz, bx, bz));
}
function segSegD2(ax, az, bx, bz, cx, cz, dx, dz) {
  if (intersects(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(pointSegD2(ax, az, cx, cz, dx, dz), pointSegD2(bx, bz, cx, cz, dx, dz),
    pointSegD2(cx, cz, ax, az, bx, bz), pointSegD2(dx, dz, ax, az, bx, bz));
}

function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const unique = sorted.filter((p, i) => !i || Math.abs(p.x - sorted[i - 1].x) > 1e-7
    || Math.abs(p.z - sorted[i - 1].z) > 1e-7);
  if (unique.length <= 2) return unique;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.z > p.z) !== (b.z > p.z))
      && p.x < ((b.x - a.x) * (p.z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

function hullTrackDistance(circuit, hull) {
  if (!hull.length) return Infinity;
  let best = Infinity;
  for (let j = 0; j < circuit.N; j++) {
    const a = circuit.samples[j].p, b = circuit.samples[(j + 1) % circuit.N].p;
    if (hull.length >= 3 && (pointInPoly(a, hull) || pointInPoly(b, hull))) return 0;
    if (hull.length === 1) {
      best = Math.min(best, pointSegD2(hull[0].x, hull[0].z, a.x, a.z, b.x, b.z));
      continue;
    }
    const edges = hull.length === 2 ? 1 : hull.length;
    for (let e = 0; e < edges; e++) {
      const p = hull[e], q = hull[(e + 1) % hull.length];
      best = Math.min(best, segSegD2(a.x, a.z, b.x, b.z, p.x, p.z, q.x, q.z));
      if (best <= 0) return 0;
    }
  }
  return Math.sqrt(best);
}

const instanceMatrix = new THREE.Matrix4();
const worldMatrix = new THREE.Matrix4();
const vertex = new THREE.Vector3();
function transformedVertices(mesh, index) {
  mesh.getMatrixAt(index, instanceMatrix);
  worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
  const pos = mesh.geometry.attributes.position;
  const points = [];
  let maxSkyR = 0;
  for (let i = 0; i < pos.count; i++) {
    vertex.fromBufferAttribute(pos, i).applyMatrix4(worldMatrix);
    points.push({ x: vertex.x, z: vertex.z });
    maxSkyR = Math.max(maxSkyR, vertex.length());
  }
  return { hull: convexHull(points), maxSkyR };
}

function venueMeshes(circuit) {
  const meshes = [];
  circuit.group.updateMatrixWorld(true);
  circuit.group.traverse(object => {
    if (object.isInstancedMesh && isNewMesh(object.name || '')) meshes.push(object);
  });
  return meshes.sort((a, b) => a.name.localeCompare(b.name));
}

function matrixSnapshot(circuit) {
  return venueMeshes(circuit).map(mesh => ({
    name: mesh.name,
    count: mesh.count,
    matrices: Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)),
  }));
}

function countNamed(meshes, name) {
  const mesh = meshes.find(item => item.name === name);
  return mesh ? mesh.count : 0;
}

const profiles = new Map();
let worstMargin = { value: Infinity, track: '', mesh: '', index: -1 };
let minBatches = Infinity, maxBatches = 0, minTriangles = Infinity, maxTriangles = 0;
let minServices = Infinity, maxSkyRadius = 0;
let bahrainIdentity = null;

for (const trackId of Object.keys(TRACKS)) {
  const first = buildCircuit(trackId, TRACKS[trackId], new THREE.Scene());
  const second = buildCircuit(trackId, TRACKS[trackId], new THREE.Scene());
  const stats = first.group.userData.sceneryDepth;
  const meshes = venueMeshes(first);

  assert(stats && typeof stats === 'object', `${trackId}: sceneryDepth metrics are published`);
  assert(stats.profile !== 'circuit-service', `${trackId}: explicit venue-depth profile`, `[${stats.profile}]`);
  assert(!profiles.has(stats.profile), `${trackId}: profile identity is unique`, `[${stats.profile}]`);
  profiles.set(stats.profile, trackId);
  assert(JSON.stringify(matrixSnapshot(first)) === JSON.stringify(matrixSnapshot(second)),
    `${trackId}: venue instance matrices are deterministic`);

  const actual = {
    trunks: countNamed(meshes, 'vegetation-near-trunks'),
    shrubs: countNamed(meshes, 'vegetation-near-shrubs'),
    serviceParts: countNamed(meshes, 'venue-near-service'),
    tyreStacks: countNamed(meshes, 'venue-near-tyre-stacks'),
    farMass: meshes.filter(mesh => mesh.name.startsWith('vegetation-far-mass-v')).reduce((n, mesh) => n + mesh.count, 0),
    cityNear: countNamed(meshes, 'city-near'),
    citySkyline: countNamed(meshes, 'city-skyline'),
    skylineCaps: countNamed(meshes, 'city-skyline-caps'),
    identityBoxes: countNamed(meshes, 'bahrain-paddock-boxes'),
    identityCanopies: countNamed(meshes, 'bahrain-paddock-canopies'),
    identityTowers: countNamed(meshes, 'bahrain-paddock-towers'),
  };
  const caps = stats.caps;
  assert(actual.trunks <= caps.trunks, `${trackId}: near-trunk cap`, `[${actual.trunks}/${caps.trunks}]`);
  assert(actual.shrubs <= caps.shrubs, `${trackId}: shrub cap`, `[${actual.shrubs}/${caps.shrubs}]`);
  assert(stats.near.serviceBays <= caps.serviceBays, `${trackId}: service-bay cap`, `[${stats.near.serviceBays}/${caps.serviceBays}]`);
  assert(actual.serviceParts <= caps.serviceParts, `${trackId}: service-part cap`, `[${actual.serviceParts}/${caps.serviceParts}]`);
  assert(actual.tyreStacks <= caps.tyreStacks, `${trackId}: tyre-stack cap`, `[${actual.tyreStacks}/${caps.tyreStacks}]`);
  assert(actual.farMass <= caps.farMass, `${trackId}: far-mass cap`, `[${actual.farMass}/${caps.farMass}]`);
  assert(actual.cityNear <= caps.cityNear, `${trackId}: near-city cap`, `[${actual.cityNear}/${caps.cityNear}]`);
  assert(actual.citySkyline <= caps.citySkyline, `${trackId}: skyline cap`, `[${actual.citySkyline}/${caps.citySkyline}]`);
  assert(actual.skylineCaps <= caps.skylineCaps, `${trackId}: skyline-roof cap`, `[${actual.skylineCaps}/${caps.skylineCaps}]`);
  assert(actual.serviceParts === stats.near.serviceParts && actual.tyreStacks === stats.near.tyreStacks
    && actual.trunks === stats.near.trunks && actual.shrubs === stats.near.shrubs
    && actual.cityNear === stats.near.cityBlocks && actual.farMass === stats.far.masses
    && actual.citySkyline === stats.far.skyline && actual.skylineCaps === stats.far.skylineCaps,
  `${trackId}: published counts match instantiated counts`);
  assert(stats.near.serviceBays >= stats.minimums.serviceBays,
    `${trackId}: guaranteed service-bay minimum`, `[${stats.near.serviceBays}/${stats.minimums.serviceBays}]`);
  minServices = Math.min(minServices, stats.near.serviceBays);

  const identityMeshes = meshes.filter(mesh => mesh.name.startsWith('bahrain-paddock-'));
  const identityInstances = actual.identityBoxes + actual.identityCanopies + actual.identityTowers;
  if (trackId === 'bahrain') {
    assert(stats.identity?.feature === 'bahrain-desert-paddock',
      'bahrain: circuit-specific identity feature is published', `[${stats.identity?.feature}]`);
    assert(identityMeshes.map(mesh => mesh.name).join(',')
      === 'bahrain-paddock-boxes,bahrain-paddock-canopies,bahrain-paddock-towers',
    'bahrain: identity has exactly the three expected batches');
    assert(actual.identityBoxes === 9 && actual.identityCanopies === 3 && actual.identityTowers === 3,
      'bahrain: identity object counts are exact',
      `[boxes=${actual.identityBoxes} canopies=${actual.identityCanopies} towers=${actual.identityTowers}]`);
    assert(identityInstances === stats.identity.instances && identityInstances <= caps.identityInstances,
      'bahrain: published identity instance count is capped',
      `[${identityInstances}/${caps.identityInstances}]`);
    assert(identityMeshes.length === stats.identity.batches && identityMeshes.length <= caps.identityBatches,
      'bahrain: identity draw-batch count is capped', `[${identityMeshes.length}/${caps.identityBatches}]`);
    assert(identityMeshes.every(mesh => mesh.userData.venue === 'bahrain'
      && mesh.userData.feature === stats.identity.feature),
    'bahrain: every identity batch carries circuit ownership metadata');
  } else {
    assert(stats.identity?.feature === null && identityMeshes.length === 0 && identityInstances === 0,
      `${trackId}: Bahrain identity remains circuit-exclusive`);
  }

  let batches = 0, triangles = 0;
  let identityTriangles = 0;
  for (const mesh of meshes) {
    batches++;
    const primitiveTriangles = mesh.geometry.index
      ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3;
    triangles += primitiveTriangles * mesh.count;
    if (mesh.name.startsWith('bahrain-paddock-')) identityTriangles += primitiveTriangles * mesh.count;

    if (mesh.name.startsWith('vegetation-far-mass-v')) {
      const material = mesh.material;
      const emission = material.emissive.r * (material.emissiveIntensity ?? 1);
      const emitCap = first.theme.night ? 0.22 : 0.36;
      assert(material.isMeshStandardMaterial && material.map?.isCanvasTexture
        && material.emissiveMap === material.map && material.side === THREE.FrontSide,
      `${trackId}/${mesh.name}: far mass uses lit alpha-cut canvas material`);
      assert(material.alphaTest >= 0.2 && material.transparent === false && material.depthWrite !== false,
        `${trackId}/${mesh.name}: far mass avoids sorting/solid-quad regressions`);
      assert(material.fog !== false, `${trackId}/${mesh.name}: far mass participates in atmospheric fog`);
      assert(emission >= 0.15 && emission <= emitCap + 1e-6,
        `${trackId}/${mesh.name}: far mass emission is bloom-safe`, `[${emission.toFixed(3)}/${emitCap}]`);
      const ys = new Set();
      const p = mesh.geometry.attributes.position;
      for (let q = 0; q < p.count; q++) if (p.getY(q) > 0.5) ys.add(p.getY(q).toFixed(3));
      assert(primitiveTriangles === 20 && p.count === 40 && ys.size >= 4,
        `${trackId}/${mesh.name}: five overlapping panels carry a ragged multi-height top`,
        `[tris=${primitiveTriangles} verts=${p.count} distinct tops=${ys.size}]`);
      const liveCount = mesh.count;
      const normalMaterial = new THREE.MeshNormalMaterial();
      mesh.onBeforeRender(null, null, null, mesh.geometry, normalMaterial);
      const suppressed = mesh.count === 0;
      mesh.onAfterRender(null, null, null, mesh.geometry, normalMaterial);
      const restored = mesh.count === liveCount;
      mesh.onBeforeRender(null, null, null, mesh.geometry, material);
      const colourUntouched = mesh.count === liveCount;
      mesh.onAfterRender(null, null, null, mesh.geometry, material);
      assert(suppressed && restored && colourUntouched,
        `${trackId}/${mesh.name}: far mass opts out of AO and restores for colour`,
        `[suppressed=${suppressed} restored=${restored} colour=${colourUntouched}]`);
      normalMaterial.dispose();
    }

    for (let i = 0; i < mesh.count; i++) {
      const { hull, maxSkyR: instanceSkyR } = transformedVertices(mesh, i);
      const margin = hullTrackDistance(first, hull) - stats.trackEnvelope;
      if (margin < worstMargin.value) worstMargin = { value: margin, track: trackId, mesh: mesh.name, index: i };
      maxSkyRadius = Math.max(maxSkyRadius, instanceSkyR);
      assert(margin >= MIN_MARGIN, `${trackId}/${mesh.name}#${i}: footprint clears road + kerb`,
        `[margin=${margin.toFixed(3)}m, minimum=${MIN_MARGIN.toFixed(2)}m]`);
      assert(instanceSkyR < SKY_R, `${trackId}/${mesh.name}#${i}: geometry stays inside sky dome`,
        `[radius=${instanceSkyR.toFixed(1)}m/${SKY_R}m]`);
    }
  }
  if (trackId === 'bahrain') {
    assert(identityTriangles === stats.identity.triangles && identityTriangles <= caps.identityTriangles,
      'bahrain: published identity triangle cost is exact and capped',
      `[${identityTriangles}/${caps.identityTriangles}]`);
    bahrainIdentity = {
      batches: identityMeshes.length,
      instances: identityInstances,
      triangles: identityTriangles,
      sample: stats.identity.sample,
      side: stats.identity.side,
      offset: stats.identity.offset,
    };
  }
  minBatches = Math.min(minBatches, batches); maxBatches = Math.max(maxBatches, batches);
  minTriangles = Math.min(minTriangles, triangles); maxTriangles = Math.max(maxTriangles, triangles);
  const baseBatches = batches - identityMeshes.length;
  const baseTriangles = triangles - identityTriangles;
  assert(baseBatches >= 7 && baseBatches <= 10,
    `${trackId}: base scenery stays within 7-10 batches`, `[${baseBatches}]`);
  // Formerly 5,700-12,500: the untextured detail-1 icosahedron shrubs cost 80
  // triangles each. Their alpha-cut foliage stars cost 12, while the deliberately
  // richer far-mass run rises from 8 to 20; live all-venue totals are now lower.
  assert(baseTriangles >= 3400 && baseTriangles <= 6000,
    `${trackId}: base scenery triangle cost stays within the foliage-card band`, `[${Math.round(baseTriangles)}]`);
  assert(batches <= 13 && triangles <= 6240,
    `${trackId}: total scenery including identity stays within bounded render cost`,
    `[batches=${batches}/13 triangles=${Math.round(triangles)}/6240]`);

  first.dispose();
  second.dispose();
}

assert(profiles.size === Object.keys(TRACKS).length, 'every circuit has a distinct explicit profile',
  `[${profiles.size}/${Object.keys(TRACKS).length}]`);

console.log(`VENUE DEPTH: ${checks - failures}/${checks} checks passed across ${Object.keys(TRACKS).length} circuits`);
console.log(`worst footprint margin: ${worstMargin.value.toFixed(3)}m (${worstMargin.track}/${worstMargin.mesh}#${worstMargin.index})`);
console.log(`service bays: minimum ${minServices}; batches ${minBatches}-${maxBatches}; triangles ${Math.round(minTriangles)}-${Math.round(maxTriangles)}`);
console.log(`Bahrain identity: ${bahrainIdentity?.batches || 0} batches, ${bahrainIdentity?.instances || 0} instances, ${bahrainIdentity?.triangles || 0} triangles; sample ${bahrainIdentity?.sample ?? 'missing'}, side ${bahrainIdentity?.side ?? 'missing'}, offset ${bahrainIdentity?.offset ?? 'missing'}m`);
console.log(`furthest venue vertex: ${maxSkyRadius.toFixed(1)}m of ${SKY_R}m sky radius`);
process.exit(failures ? 1 : 0);
