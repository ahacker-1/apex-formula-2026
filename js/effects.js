// Runtime visual effects: titanium skid sparks (2026 skid blocks), tyre smoke,
// off-track dust, gravel/rubber debris, rain and tyre spray, and player skid
// marks. Every effect is procedural and pooled; the hot update path does not
// grow scene/object counts.
import * as THREE from 'three';

export const EFFECT_POOL_LIMITS = Object.freeze({
  sparks: 260,
  smoke: 36,
  dust: 48,
  debris: 180,
  rain: 320,
  spray: 80,
  skidSegments: 700,
});

export const EFFECT_QUALITY_SCALES = Object.freeze({
  low: 0.45,
  medium: 0.72,
  high: 1,
});

export const EFFECT_QUALITY_DUST_LIMITS = Object.freeze({
  low: 18,
  medium: 32,
  high: EFFECT_POOL_LIMITS.dust,
});

export const EFFECT_QUALITY_WEATHER_LIMITS = Object.freeze({
  low: Object.freeze({ rain: 72, spray: 20 }),
  medium: Object.freeze({ rain: 168, spray: 44 }),
  high: Object.freeze({ rain: EFFECT_POOL_LIMITS.rain, spray: EFFECT_POOL_LIMITS.spray }),
});

const SPARK_POOL = EFFECT_POOL_LIMITS.sparks;
const SMOKE_POOL = EFFECT_POOL_LIMITS.smoke;
const DUST_POOL = EFFECT_POOL_LIMITS.dust;
const DEBRIS_POOL = EFFECT_POOL_LIMITS.debris;
const RAIN_POOL = EFFECT_POOL_LIMITS.rain;
const SPRAY_POOL = EFFECT_POOL_LIMITS.spray;
const SKID_SEGS = EFFECT_POOL_LIMITS.skidSegments;

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

export function effectSurfaceHeight(physics) {
  const fallback = Number.isFinite(physics?.pos?.y) ? physics.pos.y : 0;
  const circuit = physics?.circuit;
  const sample = circuit?.samples?.[physics?.sampleIdx];
  if (!sample || typeof circuit?.heightAt !== 'function' || !Number.isFinite(circuit?.ds) || circuit.ds <= 0) {
    return fallback;
  }
  const along = (physics.pos.x - sample.p.x) * sample.t.x +
    (physics.pos.z - sample.p.z) * sample.t.z;
  const height = circuit.heightAt(physics.sampleIdx + along / circuit.ds);
  return Number.isFinite(height) ? height : fallback;
}

function defaultMotionScale(options) {
  if (Number.isFinite(options.motionScale)) return clamp01(options.motionScale);
  const reduced = options.reducedMotion ??
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced) return 0.28;
  const memory = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : 0;
  const compact = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
  // Match the adaptive renderer's conservative initial-tier heuristics without
  // coupling Effects to main.js or the quality controller.
  return compact || (Number.isFinite(memory) && memory > 0 && memory <= 4) ? 0.62 : 1;
}

function radialSprite(inner, outer, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor(scene, random = () => Math.random(), options = {}) {
    this.scene = scene;
    this.random = random;
    this.preferenceScale = defaultMotionScale(options);
    this.qualityTier = 'high';
    this.motionScale = this.preferenceScale;
    // Lifetime diagnostics are monotonic, unlike ring-buffer cursors. They are
    // intentionally tiny and make density changes observable without exposing
    // or reallocating effect storage.
    this.emissionCounts = {
      sparks: 0, smoke: 0, dust: 0, debris: 0, gravel: 0, rubber: 0, rain: 0, spray: 0,
    };
    this._f = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this._entryState = new WeakMap();
    this.environment = options.environment || null;
    this._rainEmission = 0;
    this.rainEmitterY = 0;
    this.setQualityTier(options.qualityTier);

    // ---- sparks (Points, additive) ----
    this.sparkData = [];
    const sg = new THREE.BufferGeometry();
    const pos = new Float32Array(SPARK_POOL * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    for (let i = 0; i < SPARK_POOL; i++) {
      pos[i * 3 + 1] = -50; // parked underground
      this.sparkData.push({ vel: new THREE.Vector3(), life: 0 });
    }
    this.sparkMat = new THREE.PointsMaterial({
      size: 0.35, map: radialSprite('rgba(255,235,170,1)', 'rgba(255,120,10,0)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.sparks = new THREE.Points(sg, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.userData.gtaoExcluded = true;
    scene.add(this.sparks);
    this._sparkCursor = 0;

    // ---- smoke (sprite pool) ----
    this.smokeTex = radialSprite('rgba(228,228,232,0.55)', 'rgba(228,228,232,0)');
    this.smoke = [];
    for (let i = 0; i < SMOKE_POOL; i++) {
      const m = new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, opacity: 0, depthWrite: false });
      const s = new THREE.Sprite(m);
      s.visible = false;
      // GTAO renders with an opaque override material that cannot see the
      // sprite's radial alpha. Excluding the card prevents a black square from
      // flashing behind the car as smoke appears during wheelspin or braking.
      s.userData.gtaoExcluded = true;
      scene.add(s);
      this.smoke.push({
        sprite: s, vel: new THREE.Vector3(), life: 0, maxLife: 1,
        startScale: 1, strength: 1,
      });
    }
    this._smokeCursor = 0;

    // ---- dust (sprite pool, separate material so smoke stays neutral) ----
    this.dustTex = radialSprite('rgba(214,190,146,0.48)', 'rgba(126,103,72,0)');
    this.dust = [];
    for (let i = 0; i < DUST_POOL; i++) {
      const m = new THREE.SpriteMaterial({
        map: this.dustTex, color: 0xc6aa7d, transparent: true,
        opacity: 0, depthWrite: false,
      });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.userData.gtaoExcluded = true;
      scene.add(s);
      this.dust.push({
        sprite: s, vel: new THREE.Vector3(), life: 0, maxLife: 1,
        startScale: 1, strength: 1,
      });
    }
    this._dustCursor = 0;

    // ---- rain (single point draw; drops are camera-local, not world weather) ----
    const rg = new THREE.BufferGeometry();
    const rpos = new Float32Array(RAIN_POOL * 3);
    rg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    this.rainData = [];
    for (let i = 0; i < RAIN_POOL; i++) {
      rpos[i * 3 + 1] = -50;
      this.rainData.push({ vel: new THREE.Vector3(), life: 0, floor: 0 });
    }
    this.rainTex = radialSprite('rgba(225,238,255,0.90)', 'rgba(180,210,240,0)', 16);
    this.rainMat = new THREE.PointsMaterial({
      size: 0.12, map: this.rainTex, color: 0xcfe6ff, transparent: true,
      opacity: 0.72, depthWrite: false, sizeAttenuation: true,
    });
    this.rain = new THREE.Points(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.userData.gtaoExcluded = true;
    scene.add(this.rain);
    this._rainCursor = 0;

    // ---- tyre spray (soft pooled cards behind wet tyres) -------------------
    this.sprayTex = radialSprite('rgba(218,229,235,0.46)', 'rgba(160,180,190,0)');
    this.spray = [];
    for (let i = 0; i < SPRAY_POOL; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.sprayTex, color: 0xc7d4d9, transparent: true,
        opacity: 0, depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.userData.gtaoExcluded = true;
      scene.add(sprite);
      this.spray.push({
        sprite, vel: new THREE.Vector3(), life: 0, maxLife: 1, startScale: 1, strength: 1,
      });
    }
    this._sprayCursor = 0;

    // ---- gravel / rubber flecks (one Points draw, vertex-coloured) ----
    const dg = new THREE.BufferGeometry();
    const dpos = new Float32Array(DEBRIS_POOL * 3);
    const dcol = new Float32Array(DEBRIS_POOL * 3);
    dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
    this.debrisData = [];
    for (let i = 0; i < DEBRIS_POOL; i++) {
      dpos[i * 3 + 1] = -50;
      this.debrisData.push({
        vel: new THREE.Vector3(), life: 0, floor: 0, settled: false, bounces: 0,
      });
    }
    this.debrisTex = radialSprite('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 32);
    this.debrisMat = new THREE.PointsMaterial({
      size: 0.14, map: this.debrisTex, vertexColors: true,
      transparent: true, opacity: 0.82, depthWrite: false, alphaTest: 0.06,
      sizeAttenuation: true,
    });
    this.debris = new THREE.Points(dg, this.debrisMat);
    this.debris.frustumCulled = false;
    this.debris.userData.gtaoExcluded = true;
    scene.add(this.debris);
    this._debrisCursor = 0;

    // ---- skid marks (ribbon ring buffer, player rear wheels) ----
    const kg = new THREE.BufferGeometry();
    const kidx = [];
    // layout: seg i -> verts [i*8 .. i*8+7]: wheelL(a0,a1,b0,b1), wheelR(a0,a1,b0,b1)
    const kpos2 = new Float32Array(SKID_SEGS * 8 * 3);
    for (let i = 0; i < SKID_SEGS; i++) {
      const v = i * 8;
      kidx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      kidx.push(v + 4, v + 5, v + 6, v + 5, v + 7, v + 6);
    }
    kg.setAttribute('position', new THREE.BufferAttribute(kpos2, 3));
    kg.setIndex(kidx);
    this.skidGeo = kg;
    this.skidMat = new THREE.MeshBasicMaterial({ color: 0x151517, transparent: true, opacity: 0.42, depthWrite: false });
    this.skid = new THREE.Mesh(kg, this.skidMat);
    this.skid.frustumCulled = false;
    this.skid.renderOrder = 1;
    // The mark is a transparent road overlay, not an occluding surface.
    this.skid.userData.gtaoExcluded = true;
    scene.add(this.skid);
    this._skidCursor = 0;
    this._hasSkidPrev = false;
    this._skidPrev = {};
    this._skidCur = {};
    // park all skid verts underground
    for (let i = 0; i < kpos2.length; i += 3) kpos2[i + 1] = -50;
  }

  // Called by the renderer's existing tier-change callback. Kept as a small
  // public hook so main.js can wire it independently of this effects commit.
  // Updating a tier never replaces a pool, texture, material, or typed buffer.
  setQualityTier(tier) {
    const next = Object.hasOwn(EFFECT_QUALITY_SCALES, tier) ? tier : 'high';
    this.qualityTier = next;
    this.motionScale = this.preferenceScale * EFFECT_QUALITY_SCALES[next];
    this.dustLimit = EFFECT_QUALITY_DUST_LIMITS[next];
    this.rainLimit = EFFECT_QUALITY_WEATHER_LIMITS[next].rain;
    this.sprayLimit = EFFECT_QUALITY_WEATHER_LIMITS[next].spray;
    if (this.dust) {
      this._dustCursor %= this.dustLimit;
      for (let i = this.dustLimit; i < this.dust.length; i++) {
        this.dust[i].life = 0;
        this.dust[i].sprite.visible = false;
      }
    }
    if (this.rainData) {
      this._rainCursor %= this.rainLimit;
      const positions = this.rain.geometry.attributes.position.array;
      for (let i = this.rainLimit; i < this.rainData.length; i++) {
        this.rainData[i].life = 0;
        positions[i * 3 + 1] = -50;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    if (this.spray) {
      this._sprayCursor %= this.sprayLimit;
      for (let i = this.sprayLimit; i < this.spray.length; i++) {
        this.spray[i].life = 0;
        this.spray[i].sprite.visible = false;
      }
    }
    return this.motionScale;
  }

  bindEnvironment(environment) {
    this.environment = environment || null;
    return this;
  }

  _emitSpark(x, y, z, heading, v, floor = 0) {
    const i = this._sparkCursor;
    this._sparkCursor = (i + 1) % SPARK_POOL;
    const p = this.sparks.geometry.attributes.position;
    p.array[i * 3] = x; p.array[i * 3 + 1] = y; p.array[i * 3 + 2] = z;
    const d = this.sparkData[i];
    d.floor = floor;
    d.life = 0.28 + this.random() * 0.3;
    // sparks stream backwards + sideways scatter
    d.vel.set(
      -Math.sin(heading) * v * 0.55 + (this.random() - 0.5) * 7,
      1.2 + this.random() * 2.4,
      -Math.cos(heading) * v * 0.55 + (this.random() - 0.5) * 7
    );
    this.emissionCounts.sparks++;
  }

  _emitSmoke(x, y, z, heading = 0, speed = 0, strength = 1) {
    const s = this.smoke[this._smokeCursor];
    this._smokeCursor = (this._smokeCursor + 1) % SMOKE_POOL;
    s.life = s.maxLife = 0.7 + this.random() * 0.5;
    s.strength = clamp01(strength);
    s.startScale = 0.65 + this.random() * 0.5;
    s.sprite.visible = true;
    s.sprite.position.set(x, y, z);
    s.sprite.scale.setScalar(s.startScale);
    s.sprite.material.opacity = 0.26 + s.strength * 0.16;
    s.vel.set(
      -Math.sin(heading) * Math.abs(speed) * 0.035 + (this.random() - 0.5) * 0.7,
      0.38 + this.random() * 0.32,
      -Math.cos(heading) * Math.abs(speed) * 0.035 + (this.random() - 0.5) * 0.7
    );
    this.emissionCounts.smoke++;
  }

  _emitDust(x, y, z, heading, speed, strength = 1) {
    const d = this.dust[this._dustCursor];
    this._dustCursor = (this._dustCursor + 1) % this.dustLimit;
    d.life = d.maxLife = 0.85 + this.random() * 0.65;
    d.strength = clamp01(strength);
    d.startScale = 0.9 + this.random() * 0.7;
    d.sprite.visible = true;
    d.sprite.position.set(x, y, z);
    d.sprite.scale.setScalar(d.startScale);
    d.sprite.material.opacity = 0.2 + d.strength * 0.18;
    d.vel.set(
      -Math.sin(heading) * Math.abs(speed) * 0.045 + (this.random() - 0.5) * 1.2,
      0.14 + this.random() * 0.22,
      -Math.cos(heading) * Math.abs(speed) * 0.045 + (this.random() - 0.5) * 1.2
    );
    this.emissionCounts.dust++;
  }

  _emitRain(x, y, z, windSpeed = 0, windDirection = 0, strength = 1) {
    const i = this._rainCursor;
    this._rainCursor = (i + 1) % this.rainLimit;
    const p = this.rain.geometry.attributes.position;
    p.array[i * 3] = x + (this.random() - 0.5) * 28;
    p.array[i * 3 + 1] = y + 6 + this.random() * 12;
    p.array[i * 3 + 2] = z + (this.random() - 0.5) * 34;
    const d = this.rainData[i];
    d.floor = y;
    d.life = 0.42 + this.random() * 0.48;
    d.vel.set(
      Math.sin(windDirection) * windSpeed * 0.45,
      -(21 + clamp01(strength) * 9),
      Math.cos(windDirection) * windSpeed * 0.45
    );
    p.needsUpdate = true;
    this.emissionCounts.rain++;
  }

  _emitSpray(x, y, z, heading, speed, strength = 1) {
    const s = this.spray[this._sprayCursor];
    this._sprayCursor = (this._sprayCursor + 1) % this.sprayLimit;
    s.life = s.maxLife = 0.42 + this.random() * 0.38;
    s.strength = clamp01(strength);
    s.startScale = 0.45 + this.random() * 0.35;
    s.sprite.visible = true;
    s.sprite.position.set(x, y, z);
    s.sprite.scale.set(s.startScale * 0.65, s.startScale, 1);
    s.sprite.material.opacity = 0.16 + s.strength * 0.24;
    s.vel.set(
      -Math.sin(heading) * Math.abs(speed) * 0.085 + (this.random() - 0.5) * 0.65,
      0.8 + this.random() * 0.55,
      -Math.cos(heading) * Math.abs(speed) * 0.085 + (this.random() - 0.5) * 0.65
    );
    this.emissionCounts.spray++;
  }

  _emitDebris(x, y, z, heading, speed, floor = 0, rubber = false) {
    const i = this._debrisCursor;
    this._debrisCursor = (i + 1) % DEBRIS_POOL;
    const p = this.debris.geometry.attributes.position;
    const c = this.debris.geometry.attributes.color;
    p.array[i * 3] = x;
    p.array[i * 3 + 1] = y;
    p.array[i * 3 + 2] = z;
    const d = this.debrisData[i];
    d.floor = floor;
    d.life = rubber ? 5 + this.random() * 5 : 1.5 + this.random() * 1.5;
    d.settled = false;
    d.bounces = 0;
    const scatter = rubber ? 1.6 : 3.8;
    d.vel.set(
      -Math.sin(heading) * Math.abs(speed) * (rubber ? 0.025 : 0.07) + (this.random() - 0.5) * scatter,
      (rubber ? 0.35 : 0.8) + this.random() * (rubber ? 0.65 : 1.8),
      -Math.cos(heading) * Math.abs(speed) * (rubber ? 0.025 : 0.07) + (this.random() - 0.5) * scatter
    );
    const tone = this.random();
    if (rubber) {
      const v = 0.035 + tone * 0.035;
      c.array[i * 3] = v;
      c.array[i * 3 + 1] = v * 1.02;
      c.array[i * 3 + 2] = v * 1.05;
    } else {
      c.array[i * 3] = 0.24 + tone * 0.16;
      c.array[i * 3 + 1] = 0.18 + tone * 0.11;
      c.array[i * 3 + 2] = 0.10 + tone * 0.07;
    }
    p.needsUpdate = true;
    c.needsUpdate = true;
    this.emissionCounts.debris++;
    this.emissionCounts[rubber ? 'rubber' : 'gravel']++;
  }

  _stateFor(entry) {
    let state = this._entryState.get(entry);
    if (!state) {
      state = { sparks: 0, smoke: 0, dust: 0, debris: 0, rubber: 0, spray: 0, wallCooldown: 0 };
      this._entryState.set(entry, state);
    }
    return state;
  }

  _emissions(state, key, dt, rate, maxBurst = 2) {
    if (rate <= 0 || dt <= 0 || this.motionScale <= 0) {
      state[key] = 0;
      return 0;
    }
    state[key] = Math.min(maxBurst + 0.99, state[key] + rate * dt * this.motionScale);
    const count = Math.min(maxBurst, Math.floor(state[key]));
    state[key] -= count;
    return count;
  }

  _skidSegment(l, r, left, ry = 0) {
    // l/r: rear-left & rear-right contact points (Vector3-ish {x,z}).
    // Each edge carries ITS OWN road height: a quad flattened to the current
    // frame's height tilts out of the road on gradients and reads as dark
    // flakes ("black sparks") behind the car.
    const y = ry + 0.055;
    const cur = this._skidCur;
    cur.l0x = l.x - left.x * 0.14; cur.l0z = l.z - left.z * 0.14;
    cur.l1x = l.x + left.x * 0.14; cur.l1z = l.z + left.z * 0.14;
    cur.r0x = r.x - left.x * 0.14; cur.r0z = r.z - left.z * 0.14;
    cur.r1x = r.x + left.x * 0.14; cur.r1z = r.z + left.z * 0.14;
    cur.y = y;
    if (this._hasSkidPrev) {
      const i = this._skidCursor;
      this._skidCursor = (i + 1) % SKID_SEGS;
      const a = this.skidGeo.attributes.position.array;
      const base = i * 24;
      const P = this._skidPrev;
      a[base] = P.l0x; a[base + 1] = P.y; a[base + 2] = P.l0z;
      a[base + 3] = P.l1x; a[base + 4] = P.y; a[base + 5] = P.l1z;
      a[base + 6] = cur.l0x; a[base + 7] = y; a[base + 8] = cur.l0z;
      a[base + 9] = cur.l1x; a[base + 10] = y; a[base + 11] = cur.l1z;
      a[base + 12] = P.r0x; a[base + 13] = P.y; a[base + 14] = P.r0z;
      a[base + 15] = P.r1x; a[base + 16] = P.y; a[base + 17] = P.r1z;
      a[base + 18] = cur.r0x; a[base + 19] = y; a[base + 20] = cur.r0z;
      a[base + 21] = cur.r1x; a[base + 22] = y; a[base + 23] = cur.r1z;
      this.skidGeo.attributes.position.needsUpdate = true;
    }
    this._hasSkidPrev = true;
    this._skidCur = this._skidPrev;
    this._skidPrev = cur;
  }

  skidBreak() { this._hasSkidPrev = false; }

  update(dt, entries, environment = this.environment) {
    const frameDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    // advance sparks
    const pa = this.sparks.geometry.attributes.position;
    for (let i = 0; i < SPARK_POOL; i++) {
      const d = this.sparkData[i];
      if (d.life <= 0) continue;
      d.life -= frameDt;
      d.vel.y -= 14 * frameDt;
      pa.array[i * 3] += d.vel.x * frameDt;
      pa.array[i * 3 + 1] += d.vel.y * frameDt;
      pa.array[i * 3 + 2] += d.vel.z * frameDt;
      if (d.life <= 0 || pa.array[i * 3 + 1] < (d.floor || 0) + 0.02) { pa.array[i * 3 + 1] = -50; d.life = 0; }
    }
    pa.needsUpdate = true;
    // advance smoke
    for (const s of this.smoke) {
      if (s.life <= 0) continue;
      s.life -= frameDt;
      const t = 1 - s.life / s.maxLife;
      s.sprite.scale.setScalar(s.startScale + t * (2.1 + s.strength * 0.7));
      s.sprite.position.x += s.vel.x * frameDt;
      s.sprite.position.y += s.vel.y * frameDt;
      s.sprite.position.z += s.vel.z * frameDt;
      s.sprite.material.opacity = (0.24 + s.strength * 0.16) * (1 - t) * (1 - t);
      if (s.life <= 0) s.sprite.visible = false;
    }
    // dust hangs lower and spreads wider than tyre smoke
    for (const d of this.dust) {
      if (d.life <= 0) continue;
      d.life -= frameDt;
      const t = 1 - d.life / d.maxLife;
      d.sprite.scale.setScalar(d.startScale + t * (3.1 + d.strength * 1.4));
      d.sprite.position.x += d.vel.x * frameDt;
      d.sprite.position.y += d.vel.y * frameDt;
      d.sprite.position.z += d.vel.z * frameDt;
      d.sprite.material.opacity = (0.18 + d.strength * 0.18) * (1 - t) * (1 - t);
      if (d.life <= 0) d.sprite.visible = false;
    }
    // debris bounces once or twice, then tyre rubber remains briefly as marbles
    const dp = this.debris.geometry.attributes.position;
    for (let i = 0; i < DEBRIS_POOL; i++) {
      const d = this.debrisData[i];
      if (d.life <= 0) continue;
      d.life -= frameDt;
      if (!d.settled) {
        d.vel.y -= 13 * frameDt;
        dp.array[i * 3] += d.vel.x * frameDt;
        dp.array[i * 3 + 1] += d.vel.y * frameDt;
        dp.array[i * 3 + 2] += d.vel.z * frameDt;
        const floor = d.floor + 0.035;
        if (dp.array[i * 3 + 1] <= floor) {
          dp.array[i * 3 + 1] = floor;
          d.bounces++;
          if (Math.abs(d.vel.y) > 0.9 && d.bounces < 2) {
            d.vel.y *= -0.24;
            d.vel.x *= 0.58;
            d.vel.z *= 0.58;
          } else {
            d.settled = true;
            d.vel.set(0, 0, 0);
          }
        }
      }
      if (d.life <= 0) {
        d.life = 0;
        dp.array[i * 3 + 1] = -50;
      }
    }
    dp.needsUpdate = true;

    // Rain is camera-local around the player/lead car, which gives dense streaks
    // without populating the full circuit. The pool and per-frame burst are hard
    // bounded at every adaptive quality tier.
    const weather = environment?.weather?.current || environment?.current || environment?.weather || null;
    const rainStrength = clamp01((weather?.rainfall || 0) / 18);
    const focal = entries.find(entry => entry.isPlayer && !entry.dnf)?.phys ||
      entries.find(entry => !entry.dnf)?.phys;
    if (rainStrength > 0.004 && focal) {
      const rainFloor = effectSurfaceHeight(focal);
      this.rainEmitterY = rainFloor;
      this._rainEmission = Math.min(24.99,
        this._rainEmission + frameDt * (32 + rainStrength * 210) * this.motionScale);
      const count = Math.min(24, Math.floor(this._rainEmission));
      this._rainEmission -= count;
      for (let i = 0; i < count; i++) {
        this._emitRain(focal.pos.x, rainFloor, focal.pos.z, weather?.windSpeed || 0,
          weather?.windDirection || 0, rainStrength);
      }
    } else this._rainEmission = 0;

    const rainPositions = this.rain.geometry.attributes.position;
    for (let i = 0; i < RAIN_POOL; i++) {
      const d = this.rainData[i];
      if (d.life <= 0) continue;
      d.life -= frameDt;
      rainPositions.array[i * 3] += d.vel.x * frameDt;
      rainPositions.array[i * 3 + 1] += d.vel.y * frameDt;
      rainPositions.array[i * 3 + 2] += d.vel.z * frameDt;
      if (d.life <= 0 || rainPositions.array[i * 3 + 1] < d.floor - 1) {
        d.life = 0;
        rainPositions.array[i * 3 + 1] = -50;
      }
    }
    rainPositions.needsUpdate = true;

    for (const s of this.spray) {
      if (s.life <= 0) continue;
      s.life -= frameDt;
      const t = 1 - s.life / s.maxLife;
      s.sprite.scale.set(s.startScale * (0.65 + t * 1.5), s.startScale + t * (2.4 + s.strength), 1);
      s.sprite.position.x += s.vel.x * frameDt;
      s.sprite.position.y += s.vel.y * frameDt;
      s.sprite.position.z += s.vel.z * frameDt;
      s.sprite.material.opacity = (0.15 + s.strength * 0.24) * (1 - t) * (1 - t);
      if (s.life <= 0) s.sprite.visible = false;
    }

    // emissions per car
    for (const e of entries) {
      const p = e.phys;
      if (p.disabled || e.dnf) continue;
      const state = this._stateFor(e);
      state.wallCooldown = Math.max(0, state.wallCooldown - frameDt);
      // render-only elevation offset (physics is planar)
      let ry = 0;
      const cc = p.circuit;
      if (cc && cc.heightAt) {
        const sm = cc.samples[p.sampleIdx];
        const along = (p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z;
        ry = cc.heightAt(p.sampleIdx + along / cc.ds);
      }
      const f = this._f.set(Math.sin(p.heading), 0, Math.cos(p.heading));
      const left = this._l.set(f.z, 0, -f.x);
      const rx = p.pos.x - f.x * 1.6, rz = p.pos.z - f.z * 1.6;
      const speed = Math.abs(p.v);
      let surfaceWetness = clamp01(p.surfaceWetness || 0);
      if (environment?.sampleSurface && Number.isFinite(p.sampleIdx)) {
        surfaceWetness = clamp01(environment.sampleSurface(p.sampleIdx, p.lat || 0, {}).wetness);
      }
      const sprayRate = speed > 9 && surfaceWetness > 0.04
        ? Math.min(28, (2 + speed * 0.22) * surfaceWetness) : 0;
      const sprayCount = this._emissions(state, 'spray', frameDt, sprayRate, 3);
      for (let n = 0; n < sprayCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        this._emitSpray(rx + left.x * 0.82 * side, ry + 0.16,
          rz + left.z * 0.82 * side, p.heading, speed, surfaceWetness);
      }
      // titanium skid sparks: kerb strikes + heavy braking at speed + bottoming on straights
      const sparkRate = (p.onKerb && speed > 32 ? 10 : 0) +
        (p.brake > 0.75 && speed > 52 ? 4 : 0) +
        (p.aeroX && speed > 88 ? 1.4 : 0);
      const sparkCount = this._emissions(state, 'sparks', frameDt, sparkRate);
      for (let n = 0; n < sparkCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        this._emitSpark(rx + left.x * 0.8 * side, ry + 0.06,
          rz + left.z * 0.8 * side, p.heading, speed, ry);
      }
      // tyre smoke on slip
      const smokeRate = p.slip && speed > 14 ? Math.min(14, 6 + speed * 0.09) : 0;
      const smokeCount = this._emissions(state, 'smoke', frameDt, smokeRate);
      for (let n = 0; n < smokeCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        const strength = clamp01(0.45 + p.brake * 0.45 + Math.max(0, p.throttle - 0.7));
        this._emitSmoke(rx + left.x * 0.85 * side, ry + 0.3,
          rz + left.z * 0.85 * side, p.heading, speed, strength);
      }
      // off-track excursions build a low dust wake as the tyres dig in
      const dustRate = p.offTrack && speed > 5
        ? Math.min(15, 4 + speed * 0.1 + (p.offTrackSink || 0) * 5) : 0;
      const dustCount = this._emissions(state, 'dust', frameDt, dustRate);
      for (let n = 0; n < dustCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        this._emitDust(rx + left.x * 0.88 * side, ry + 0.18,
          rz + left.z * 0.88 * side, p.heading, speed,
          0.55 + (p.offTrackSink || 0) * 0.45);
      }
      const gravelRate = p.offTrack && speed > 7
        ? Math.min(10, 2 + speed * 0.055 + (p.offTrackSink || 0) * 3) : 0;
      const gravelCount = this._emissions(state, 'debris', frameDt, gravelRate);
      for (let n = 0; n < gravelCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        this._emitDebris(rx + left.x * 0.86 * side, ry + 0.12,
          rz + left.z * 0.86 * side, p.heading, speed, ry, false);
      }
      // A little rubber is shed under sustained on-track slip and settles as
      // temporary marbles instead of flying like sparks.
      const rubberRate = p.slip && !p.offTrack && speed > 24 ? 1.25 : 0;
      const rubberCount = this._emissions(state, 'rubber', frameDt, rubberRate, 1);
      for (let n = 0; n < rubberCount; n++) {
        const side = this.random() < 0.5 ? 1 : -1;
        this._emitDebris(rx + left.x * 0.86 * side, ry + 0.1,
          rz + left.z * 0.86 * side, p.heading, speed, ry, true);
      }
      // Wall impacts get one restrained burst, guarded against the physics
      // contact signal remaining high across adjacent render frames.
      if (p.wallHit > 0.35 && state.wallCooldown <= 0) {
        state.wallCooldown = 0.32;
        const burst = Math.min(6, Math.ceil((2 + p.wallHit * 4) * this.motionScale));
        for (let n = 0; n < burst; n++) {
          const side = p.lat < 0 ? -1 : 1;
          this._emitSpark(p.pos.x + left.x * side * 0.9, ry + 0.35,
            p.pos.z + left.z * side * 0.9, p.heading, speed * 0.5, ry);
          this._emitDebris(p.pos.x + left.x * side * 0.9, ry + 0.25,
            p.pos.z + left.z * side * 0.9, p.heading, speed * 0.35, ry, false);
        }
      }
      // skid marks: player only
      if (e.isPlayer) {
        if (p.slip && p.v > 12 && !p.offTrack) {
          this._skidSegment(
            { x: rx + left.x * 0.85, z: rz + left.z * 0.85 },
            { x: rx - left.x * 0.85, z: rz - left.z * 0.85 },
            left, ry
          );
        } else this.skidBreak();
      }
    }
  }

  dispose() {
    this.scene.remove(this.sparks, this.debris, this.rain, this.skid);
    for (const s of this.smoke) this.scene.remove(s.sprite);
    for (const d of this.dust) this.scene.remove(d.sprite);
    for (const s of this.spray) this.scene.remove(s.sprite);
    this.sparks.geometry.dispose();
    this.sparkMat.map.dispose(); this.sparkMat.dispose();
    this.debris.geometry.dispose(); this.debrisTex.dispose(); this.debrisMat.dispose();
    this.skidGeo.dispose(); this.skidMat.dispose();
    this.smokeTex.dispose();
    for (const s of this.smoke) s.sprite.material.dispose();
    this.dustTex.dispose();
    for (const d of this.dust) d.sprite.material.dispose();
    this.rain.geometry.dispose(); this.rainTex.dispose(); this.rainMat.dispose();
    this.sprayTex.dispose();
    for (const s of this.spray) s.sprite.material.dispose();
  }
}
