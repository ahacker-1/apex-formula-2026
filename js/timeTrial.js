// Persistent time-trial personal bests and a lightweight local ghost.
// Ghost data never leaves the browser: each completed PB is sampled at 12 Hz
// and stored per circuit + driver in localStorage.
import { downloadTelemetry } from './telemetry.js';

const STORE_VERSION = 1;
const STORE_PREFIX = 'apexf1_tt_v1:';
const SAMPLE_INTERVAL = 1 / 12;

const round = (n, places = 2) => {
  const m = 10 ** places;
  return Math.round(n * m) / m;
};

function safeRead(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value && value.version === STORE_VERSION && Array.isArray(value.frames) ? value : null;
  } catch { return null; }
}

function safeWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function materialCopies(material) {
  const source = Array.isArray(material) ? material : [material];
  return source.map((m) => {
    const copy = m.clone();
    copy.transparent = true;
    copy.opacity = Math.min(0.28, Math.max(0.14, (m.opacity ?? 1) * 0.24));
    copy.depthWrite = false;
    copy.color && copy.color.lerp({ r: 0.25, g: 0.78, b: 1 }, 0.38);
    return copy;
  });
}

export class TimeTrialManager {
  constructor({ scene, circuit, session, trackId, driverId, onPersonalBest = null }) {
    this.scene = scene;
    this.circuit = circuit;
    this.session = session;
    this.trackId = trackId;
    this.driverId = driverId;
    this.onPersonalBest = onPersonalBest;
    this.key = `${STORE_PREFIX}${trackId}:${driverId}`;
    this.record = safeRead(this.key);
    this.frames = [];
    this.lapIndex = -1;
    this.sampleClock = 0;
    this.ghost = null;
    this.ghostMaterials = [];
    if (this.record) this._buildGhost();
  }

  get personalBest() { return this.record?.lap || 0; }

  exportData() {
    const source = this.record || (this.frames.length ? {
      lap: 0, sectors: [], frames: this.frames,
    } : null);
    if (!source) return null;
    return {
      format: 'apex-formula-ghost',
      version: 1,
      sampleHz: Math.round(1 / SAMPLE_INTERVAL),
      seed: Number.isInteger(this.session?.seed) ? this.session.seed : null,
      trackId: this.trackId,
      driverId: this.driverId,
      lapSeconds: round(source.lap || 0, 3),
      sectors: (source.sectors || []).map(v => Number.isFinite(v) ? round(v, 3) : null),
      // [elapsed, worldX, renderY, worldZ, headingRadians, distanceMetres]
      channels: ['time', 'x', 'y', 'z', 'heading', 'distance'],
      frames: source.frames.map(frame => frame.map((value, index) => round(value, index === 4 ? 4 : index === 0 ? 3 : 2))),
    };
  }

  downloadReplay() {
    const data = this.exportData();
    if (!data) return false;
    return downloadTelemetry(`apex-${this.trackId}-${this.driverId}-ghost.json`, data);
  }

  _progress(phys) {
    const c = this.circuit;
    const sample = c.samples[phys.sampleIdx];
    if (!sample) return 0;
    const along = (phys.pos.x - sample.p.x) * sample.t.x + (phys.pos.z - sample.p.z) * sample.t.z;
    const d = phys.sampleIdx * c.ds + along;
    return Math.max(0, Math.min(c.length, d));
  }

  _capture(player) {
    const p = player.phys;
    const elapsed = Math.max(0, this.session.raceTime - player.lapStart);
    const d = this._progress(p);
    const prior = this.frames[this.frames.length - 1];
    // Reverse excursions should not make the reference distance non-monotonic.
    if (prior && d + 2 < prior[5]) return;
    this.frames.push([
      round(elapsed, 3), round(p.pos.x), round(player.renderY || 0), round(p.pos.z), round(p.heading, 4), round(d),
    ]);
  }

  _completeLap(player) {
    const lap = player.lastLap;
    if (!(lap > 0) || this.frames.length < 20) return false;
    const improved = !this.record || lap < this.record.lap - 0.001;
    if (!improved) return false;
    const finalFrames = this.frames.slice();
    const last = finalFrames[finalFrames.length - 1];
    if (last && last[5] < this.circuit.length - 3) {
      finalFrames.push([round(lap, 3), last[1], last[2], last[3], last[4], round(this.circuit.length)]);
    }
    this.record = {
      version: STORE_VERSION,
      trackId: this.trackId,
      driverId: this.driverId,
      lap: round(lap, 3),
      sectors: Array.isArray(player.lastSectors) ? player.lastSectors.map(v => v ? round(v, 3) : null) : [],
      savedAt: new Date().toISOString(),
      frames: finalFrames,
    };
    safeWrite(this.key, this.record);
    this._buildGhost();
    if (typeof this.onPersonalBest === 'function') this.onPersonalBest(this.record);
    return true;
  }

  _buildGhost() {
    this._removeGhost();
    const source = this.session.player?.mesh;
    if (!source || !this.record?.frames?.length) return;
    const ghost = source.clone(true);
    ghost.name = 'personal-best-ghost';
    ghost.visible = false;
    ghost.traverse((object) => {
      object.castShadow = false;
      object.receiveShadow = false;
      object.userData.gtaoExcluded = true;
      if (object.isSprite) object.visible = false;
      if (object.isMesh && object.material) {
        const copies = materialCopies(object.material);
        this.ghostMaterials.push(...copies);
        object.material = Array.isArray(object.material) ? copies : copies[0];
      }
    });
    this.scene.add(ghost);
    this.ghost = ghost;
  }

  _removeGhost() {
    if (this.ghost?.parent) this.ghost.parent.remove(this.ghost);
    for (const material of this.ghostMaterials) material.dispose();
    this.ghostMaterials.length = 0;
    this.ghost = null;
  }

  _frameAt(indexValue, indexColumn) {
    const frames = this.record?.frames;
    if (!frames?.length) return null;
    if (indexValue <= frames[0][indexColumn]) return { a: frames[0], b: frames[0], mix: 0 };
    let lo = 0, hi = frames.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid][indexColumn] <= indexValue) lo = mid;
      else hi = mid;
    }
    const a = frames[lo], b = frames[hi];
    const span = b[indexColumn] - a[indexColumn];
    return { a, b, mix: span > 0 ? Math.max(0, Math.min(1, (indexValue - a[indexColumn]) / span)) : 0 };
  }

  _referenceTimeAt(progress) {
    const hit = this._frameAt(progress, 5);
    if (!hit) return null;
    return hit.a[0] + (hit.b[0] - hit.a[0]) * hit.mix;
  }

  _renderGhost(elapsed) {
    if (!this.ghost) return;
    const hit = this._frameAt(elapsed, 0);
    if (!hit) { this.ghost.visible = false; return; }
    const { a, b, mix } = hit;
    this.ghost.visible = elapsed <= this.record.lap + 0.25;
    this.ghost.position.set(
      a[1] + (b[1] - a[1]) * mix,
      a[2] + (b[2] - a[2]) * mix + 0.025,
      a[3] + (b[3] - a[3]) * mix,
    );
    let dh = b[4] - a[4];
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    this.ghost.rotation.y = a[4] + dh * mix;
  }

  update(dt) {
    const player = this.session.player;
    if (!player) return { personalBest: this.personalBest, delta: null };
    if (player.lap !== this.lapIndex) {
      if (this.lapIndex >= 0) this._completeLap(player);
      this.lapIndex = player.lap;
      this.frames = [];
      this.sampleClock = 0;
      if (player.lap >= 0) this._capture(player);
    }
    if (player.lap < 0 || this.session.qualiState !== 'flying') {
      if (this.ghost) this.ghost.visible = false;
      return { personalBest: this.personalBest, delta: null };
    }
    this.sampleClock += dt;
    if (this.sampleClock >= SAMPLE_INTERVAL) {
      this.sampleClock %= SAMPLE_INTERVAL;
      this._capture(player);
    }
    const elapsed = Math.max(0, this.session.raceTime - player.lapStart);
    const refTime = this._referenceTimeAt(this._progress(player.phys));
    this._renderGhost(elapsed);
    return { personalBest: this.personalBest, delta: refTime == null ? null : elapsed - refTime };
  }

  dispose() {
    this._removeGhost();
    this.frames = [];
  }
}
