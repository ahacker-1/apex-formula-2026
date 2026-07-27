// Runtime visual effects: titanium skid sparks (2026 skid blocks), tyre smoke,
// and player skid marks. Pooled, allocation-free per frame.
import * as THREE from 'three';

const SPARK_POOL = 260;
const SMOKE_POOL = 36;
const SKID_SEGS = 700;

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
  constructor(scene) {
    this.scene = scene;
    this._f = new THREE.Vector3();
    this._l = new THREE.Vector3();

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
    scene.add(this.sparks);
    this._sparkCursor = 0;

    // ---- smoke (sprite pool) ----
    this.smokeTex = radialSprite('rgba(228,228,232,0.55)', 'rgba(228,228,232,0)');
    this.smoke = [];
    for (let i = 0; i < SMOKE_POOL; i++) {
      const m = new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, opacity: 0, depthWrite: false });
      const s = new THREE.Sprite(m);
      s.visible = false;
      scene.add(s);
      this.smoke.push({ sprite: s, life: 0, maxLife: 1 });
    }
    this._smokeCursor = 0;

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
    scene.add(this.skid);
    this._skidCursor = 0;
    this._skidPrev = null; // {l0,l1,r0,r1} previous edge points
    // park all skid verts underground
    for (let i = 0; i < kpos2.length; i += 3) kpos2[i + 1] = -50;
  }

  _emitSpark(x, y, z, heading, v, floor = 0) {
    const i = this._sparkCursor;
    this._sparkCursor = (i + 1) % SPARK_POOL;
    const p = this.sparks.geometry.attributes.position;
    p.array[i * 3] = x; p.array[i * 3 + 1] = y; p.array[i * 3 + 2] = z;
    const d = this.sparkData[i];
    d.floor = floor;
    d.life = 0.28 + Math.random() * 0.3;
    // sparks stream backwards + sideways scatter
    d.vel.set(
      -Math.sin(heading) * v * 0.55 + (Math.random() - 0.5) * 7,
      1.2 + Math.random() * 2.4,
      -Math.cos(heading) * v * 0.55 + (Math.random() - 0.5) * 7
    );
  }

  _emitSmoke(x, y, z) {
    const s = this.smoke[this._smokeCursor];
    this._smokeCursor = (this._smokeCursor + 1) % SMOKE_POOL;
    s.life = s.maxLife = 0.7 + Math.random() * 0.5;
    s.sprite.visible = true;
    s.sprite.position.set(x, y, z);
    s.sprite.scale.setScalar(0.7 + Math.random() * 0.5);
    s.sprite.material.opacity = 0.4;
  }

  _skidSegment(l, r, left, ry = 0) {
    // l/r: rear-left & rear-right contact points (Vector3-ish {x,z}).
    // Each edge carries ITS OWN road height: a quad flattened to the current
    // frame's height tilts out of the road on gradients and reads as dark
    // flakes ("black sparks") behind the car.
    const y = ry + 0.055;
    const cur = {
      l0: [l.x - left.x * 0.14, l.z - left.z * 0.14],
      l1: [l.x + left.x * 0.14, l.z + left.z * 0.14],
      r0: [r.x - left.x * 0.14, r.z - left.z * 0.14],
      r1: [r.x + left.x * 0.14, r.z + left.z * 0.14],
      y,
    };
    if (this._skidPrev) {
      const i = this._skidCursor;
      this._skidCursor = (i + 1) % SKID_SEGS;
      const a = this.skidGeo.attributes.position.array;
      const base = i * 24;
      const P = this._skidPrev;
      const put = (o, xy, yy) => { a[base + o] = xy[0]; a[base + o + 1] = yy; a[base + o + 2] = xy[1]; };
      put(0, P.l0, P.y); put(3, P.l1, P.y); put(6, cur.l0, y); put(9, cur.l1, y);
      put(12, P.r0, P.y); put(15, P.r1, P.y); put(18, cur.r0, y); put(21, cur.r1, y);
      this.skidGeo.attributes.position.needsUpdate = true;
    }
    this._skidPrev = cur;
  }

  skidBreak() { this._skidPrev = null; }

  update(dt, entries) {
    // advance sparks
    const pa = this.sparks.geometry.attributes.position;
    for (let i = 0; i < SPARK_POOL; i++) {
      const d = this.sparkData[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vel.y -= 14 * dt;
      pa.array[i * 3] += d.vel.x * dt;
      pa.array[i * 3 + 1] += d.vel.y * dt;
      pa.array[i * 3 + 2] += d.vel.z * dt;
      if (d.life <= 0 || pa.array[i * 3 + 1] < (d.floor || 0) + 0.02) { pa.array[i * 3 + 1] = -50; d.life = 0; }
    }
    pa.needsUpdate = true;
    // advance smoke
    for (const s of this.smoke) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const t = 1 - s.life / s.maxLife;
      s.sprite.scale.setScalar(0.7 + t * 2.6);
      s.sprite.position.y += dt * 0.9;
      s.sprite.material.opacity = 0.38 * (1 - t);
      if (s.life <= 0) s.sprite.visible = false;
    }

    // emissions per car
    for (const e of entries) {
      const p = e.phys;
      if (p.disabled || e.dnf) continue;
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
      // titanium skid sparks: kerb strikes + heavy braking at speed + bottoming on straights
      const sparky = (p.onKerb && p.v > 32) || (p.brake > 0.75 && p.v > 52) ||
        (p.aeroX && p.v > 88 && Math.random() < 0.12);
      if (sparky && Math.random() < 0.75) {
        const side = Math.random() < 0.5 ? 1 : -1;
        this._emitSpark(rx + left.x * 0.8 * side, ry + 0.06, rz + left.z * 0.8 * side, p.heading, p.v, ry);
      }
      // tyre smoke on slip
      if (p.slip && p.v > 14 && Math.random() < 0.55) {
        const side = Math.random() < 0.5 ? 1 : -1;
        this._emitSmoke(rx + left.x * 0.85 * side, ry + 0.3, rz + left.z * 0.85 * side);
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
    this.scene.remove(this.sparks, this.skid);
    for (const s of this.smoke) this.scene.remove(s.sprite);
    this.sparks.geometry.dispose();
    this.sparkMat.map.dispose(); this.sparkMat.dispose();
    this.skidGeo.dispose(); this.skidMat.dispose();
    this.smokeTex.dispose();
    for (const s of this.smoke) s.sprite.material.dispose();
  }
}
