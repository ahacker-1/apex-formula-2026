// Adaptive rendering quality. Keeps the visual stack coherent while scaling the
// expensive parts (pixel ratio, AO, bloom and shadows) as one preset.

export const QUALITY_ORDER = ['low', 'medium', 'high'];

export const QUALITY_PRESETS = {
  low: {
    pixelRatio: 0.9,
    gtao: false,
    gtaoScale: 0.5,
    bloom: false,
    shadows: false,
    shadowMap: 512,
  },
  medium: {
    pixelRatio: 1.25,
    gtao: true,
    gtaoScale: 0.5,
    bloom: true,
    shadows: true,
    shadowMap: 1024,
  },
  high: {
    pixelRatio: 2,
    gtao: true,
    gtaoScale: 0.5,
    bloom: true,
    shadows: true,
    shadowMap: 2048,
  },
};

function safeDeviceMemory() {
  const n = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : 0;
  return Number.isFinite(n) ? n : 0;
}

function initialAutoTier() {
  const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
  const memory = safeDeviceMemory();
  if (mobile || (memory > 0 && memory <= 4)) return 'low';
  return 'high';
}

export class QualityController {
  constructor(renderer, onTierChange = null) {
    this.renderer = renderer;
    this.onTierChange = onTierChange;
    this.mode = 'auto';
    this.autoTier = initialAutoTier();
    this.appliedTier = null;
    this.width = typeof innerWidth === 'number' ? innerWidth : 1280;
    this.height = typeof innerHeight === 'number' ? innerHeight : 720;
    this.composer = null;
    this.gtao = null;
    this.bloom = null;
    this.sun = null;
    this._sampleTime = 0;
    this._sampleFrames = 0;
    this._slowWindows = 0;
    this._fastWindows = 0;
    this._cooldown = 0;
    this._composerSynced = null;
    this._appliedPixelRatio = null;
    this._appliedWidth = null;
    this._appliedHeight = null;
  }

  get tier() { return this.mode === 'auto' ? this.autoTier : this.mode; }

  bind({ composer = null, gtao = null, bloom = null, sun = null } = {}) {
    this.composer = composer;
    this.gtao = gtao;
    this.bloom = bloom;
    this.sun = sun;
    this._composerSynced = null;
    this.apply(true);
  }

  setMode(mode) {
    this.mode = mode === 'auto' || QUALITY_PRESETS[mode] ? mode : 'auto';
    if (this.mode === 'auto' && !QUALITY_PRESETS[this.autoTier]) this.autoTier = initialAutoTier();
    this._slowWindows = 0;
    this._fastWindows = 0;
    this.apply(true);
  }

  resize(width, height) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.apply(true);
  }

  update(rawDt) {
    if (this.mode !== 'auto' || !Number.isFinite(rawDt) || rawDt <= 0) return;
    if (this._cooldown > 0) this._cooldown = Math.max(0, this._cooldown - rawDt);
    // Ignore background-tab gaps; blur/visibility handling pauses the game.
    if (rawDt > 0.25) return;
    this._sampleTime += rawDt;
    this._sampleFrames++;
    if (this._sampleTime < 2) return;

    const frameMs = this._sampleTime / Math.max(1, this._sampleFrames) * 1000;
    this._sampleTime = 0;
    this._sampleFrames = 0;
    this._slowWindows = frameMs > 20.5 ? this._slowWindows + 1 : 0;
    this._fastWindows = frameMs < 16.9 ? this._fastWindows + 1 : 0;
    if (this._cooldown > 0) return;

    const i = QUALITY_ORDER.indexOf(this.autoTier);
    if (this._slowWindows >= 2 && i > 0) {
      this.autoTier = QUALITY_ORDER[i - 1];
      this._slowWindows = 0;
      this._fastWindows = 0;
      this._cooldown = 6;
      this.apply();
    } else if (this._fastWindows >= 4 && i < QUALITY_ORDER.length - 1) {
      this.autoTier = QUALITY_ORDER[i + 1];
      this._slowWindows = 0;
      this._fastWindows = 0;
      this._cooldown = 10;
      this.apply();
    }
  }

  apply(force = false) {
    const tier = this.tier;
    const p = QUALITY_PRESETS[tier] || QUALITY_PRESETS.medium;
    const changed = tier !== this.appliedTier;
    if (!changed && !force) return;

    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const pixelRatio = Math.min(dpr, p.pixelRatio);
    const pixelRatioChanged = pixelRatio !== this._appliedPixelRatio;
    const sizeChanged = this.width !== this._appliedWidth || this.height !== this._appliedHeight;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderer.setSize(this.width, this.height);
    if (this.gtao?.setResolutionScale) this.gtao.setResolutionScale(p.gtaoScale);
    if (this.composer) {
      const composerChanged = this.composer !== this._composerSynced;
      if (composerChanged || pixelRatioChanged) this.composer.setPixelRatio(pixelRatio);
      else if (sizeChanged || force) this.composer.setSize(this.width, this.height);
      this._composerSynced = this.composer;
    }
    if (this.gtao) this.gtao.enabled = p.gtao;
    if (this.bloom) this.bloom.enabled = p.bloom;
    if (this.sun) {
      const sizeChanged = this.sun.shadow.mapSize.x !== p.shadowMap;
      this.sun.castShadow = p.shadows;
      this.sun.shadow.mapSize.set(p.shadowMap, p.shadowMap);
      if (sizeChanged && this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }

    this.appliedTier = tier;
    this._appliedPixelRatio = pixelRatio;
    this._appliedWidth = this.width;
    this._appliedHeight = this.height;
    if (changed && typeof this.onTierChange === 'function') {
      this.onTierChange(tier, this.mode === 'auto');
    }
  }
}
