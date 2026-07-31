import { createWeatherTimeline } from './weather.js';

const TAU = Math.PI * 2;
const MATERIAL_GRIP = Object.freeze({ asphalt: 1, kerb: 0.82, runoff: 0.88, gravel: 0.61, grass: 0.49 });

export const TRACK_STATE_LIMITS = Object.freeze({
  minSegments: 64,
  maxSegments: 640,
  targetSegmentM: 12,
  fixedStepS: 0.25,
  maxAdvanceS: 30,
});

export const TRACK_PROFILES = Object.freeze({
  spa: Object.freeze({
    publicName: 'Greenwood Forest Circuit',
    shade: 0.70,
    bump: 0.0075,
    camber: 0.045,
    drainage: 0.50,
    initialDust: 0.10,
    weatherClimate: 'forest',
  }),
  default: Object.freeze({
    publicName: null,
    shade: 0.28,
    bump: 0.0045,
    camber: 0.032,
    drainage: 0.62,
    initialDust: 0.08,
    weatherClimate: null,
  }),
});

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo));
}

function hash32(value) {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function wrap(value, count) {
  if (!Number.isFinite(value) || count <= 0) return 0;
  const n = value % count;
  return n < 0 ? n + count : n;
}

function lerpArray(array, index) {
  const f = wrap(index, array.length);
  const i = Math.floor(f), k = f - i;
  return array[i] + (array[(i + 1) % array.length] - array[i]) * k;
}

function average(array) {
  let total = 0;
  for (let i = 0; i < array.length; i++) total += array[i];
  return total / Math.max(1, array.length);
}

export class TrackState {
  constructor(options) {
    if (!options || !Number.isInteger(options.sampleCount) || options.sampleCount < 3) {
      throw new TypeError('TrackState requires sampleCount >= 3');
    }
    this.trackId = String(options.trackId || 'generic');
    this.sampleCount = options.sampleCount;
    this.length = Math.max(1, Number(options.length) || this.sampleCount * (Number(options.ds) || 1));
    this.ds = this.length / this.sampleCount;
    this.halfWidth = clamp(options.halfWidth ?? 6, 3, 12);
    this.profile = TRACK_PROFILES[this.trackId] || TRACK_PROFILES.default;
    this.publicName = this.profile.publicName || options.publicName || options.name || 'Grand Prix Circuit';
    this.seed = hash32(`${options.seed ?? 'surface'}:${this.trackId}`);
    this.heights = new Float32Array(this.sampleCount);
    const sourceHeights = options.heights || [];
    for (let i = 0; i < this.sampleCount; i++) {
      this.heights[i] = Number.isFinite(sourceHeights[i]) ? sourceHeights[i] : 0;
    }
    this.curvature = new Float32Array(this.sampleCount);
    for (let i = 0; i < this.sampleCount; i++) {
      this.curvature[i] = Number(options.samples?.[i]?.curv) || Number(options.curvature?.[i]) || 0;
    }
    this.lineOffset = new Float32Array(this.sampleCount);
    for (let i = 0; i < this.sampleCount; i++) {
      const sample = options.samples?.[i], line = options.line?.[i];
      this.lineOffset[i] = sample && line
        ? (line.p.x - sample.p.x) * sample.n.x + (line.p.z - sample.p.z) * sample.n.z : 0;
    }

    this.grade = new Float32Array(this.sampleCount);
    this.camber = new Float32Array(this.sampleCount);
    this.bump = new Float32Array(this.sampleCount);
    this.staticShade = new Float32Array(this.sampleCount);
    this.staticDrainage = new Float32Array(this.sampleCount);
    this._buildStaticSurface();

    this.segmentCount = Math.max(TRACK_STATE_LIMITS.minSegments,
      Math.min(TRACK_STATE_LIMITS.maxSegments, Math.ceil(this.length / TRACK_STATE_LIMITS.targetSegmentM)));
    this.segmentLength = this.length / this.segmentCount;
    this.rubber = new Float32Array(this.segmentCount);
    this.marbles = new Float32Array(this.segmentCount);
    this.dust = new Float32Array(this.segmentCount);
    this.temperature = new Float32Array(this.segmentCount);
    this.shade = new Float32Array(this.segmentCount);
    this.wetness = new Float32Array(this.segmentCount);
    this.puddling = new Float32Array(this.segmentCount);
    this.drainage = new Float32Array(this.segmentCount);
    this.lineDrying = new Float32Array(this.segmentCount);
    this._activity = new Float32Array(this.segmentCount);
    for (let i = 0; i < this.segmentCount; i++) {
      const sample = (i / this.segmentCount) * this.sampleCount;
      this.rubber[i] = 0.08;
      this.marbles[i] = 0.015;
      this.dust[i] = this.profile.initialDust;
      this.temperature[i] = 22;
      this.shade[i] = lerpArray(this.staticShade, sample);
      this.drainage[i] = lerpArray(this.staticDrainage, sample);
    }
    this.weather = options.weather || createWeatherTimeline({
      trackId: this.trackId,
      seed: options.weatherSeed ?? options.seed,
      durationS: options.weatherDurationS,
      climate: this.profile.weatherClimate || undefined,
    });
    this.time = 0;
    this._accumulator = 0;
    this._visualHook = null;
    this.conditionOverride = null;
    this.visualState = {
      wetness: 0, puddling: 0, rainfall: 0, rubber: average(this.rubber),
      roadRoughness: 1, reflectionStrength: 0, racingLineOpacity: 0.25,
    };
  }

  _buildStaticSurface() {
    const n = this.sampleCount;
    const phase = (this.seed % 10000) / 10000 * TAU;
    for (let i = 0; i < n; i++) {
      const prev = this.heights[(i - 1 + n) % n] || 0;
      const next = this.heights[(i + 1) % n] || 0;
      this.grade[i] = clamp((next - prev) / (2 * this.ds), -0.20, 0.20);
      const u = i / n;
      this.camber[i] = clamp(-this.curvature[i] * 8.5 + Math.sin(u * TAU * 3 + phase) * 0.006,
        -this.profile.camber, this.profile.camber);
      this.bump[i] = (Math.sin(u * TAU * 37 + phase) * 0.55 +
        Math.sin(u * TAU * 91 + phase * 1.7) * 0.30 +
        Math.sin(u * TAU * 173 + phase * 0.3) * 0.15) * this.profile.bump;
      const forestWave = 0.5 + 0.5 * Math.sin(u * TAU * 5 + phase * 0.6);
      this.staticShade[i] = clamp(this.profile.shade * (0.55 + forestWave * 0.45), 0, 0.92);
      const basin = Math.max(0, -this.grade[i] * 5) + (0.5 + 0.5 * Math.sin(u * TAU * 7 + phase)) * 0.16;
      this.staticDrainage[i] = clamp(this.profile.drainage + Math.abs(this.grade[i]) * 4.8 +
        Math.abs(this.camber[i]) * 2.2 - basin - this.staticShade[i] * 0.08, 0.12, 0.98);
    }
  }

  _segmentIndex(sampleIndex) {
    return wrap(sampleIndex, this.sampleCount) / this.sampleCount * this.segmentCount;
  }

  materialAt(lateral = 0) {
    const a = Math.abs(Number.isFinite(lateral) ? lateral : 0);
    if (a <= this.halfWidth - 0.45) return 'asphalt';
    if (a <= this.halfWidth + 1.15) return 'kerb';
    if (a <= this.halfWidth + 5.5) return 'runoff';
    return this.trackId === 'spa' ? 'gravel' : 'grass';
  }

  sampleSurface(sampleIndex, lateral = 0, out = {}) {
    const i = wrap(sampleIndex, this.sampleCount);
    const si = this._segmentIndex(i);
    const safeLateral = Number.isFinite(lateral) ? lateral : 0;
    const material = this.materialAt(safeLateral);
    const lineOffset = lerpArray(this.lineOffset, i);
    const lineDistance = Math.abs(safeLateral - lineOffset);
    out.sampleIndex = i;
    out.distance = i * this.ds;
    out.elevation = lerpArray(this.heights, i);
    out.grade = lerpArray(this.grade, i);
    out.camber = lerpArray(this.camber, i);
    out.bump = lerpArray(this.bump, i);
    out.material = material;
    out.baseGrip = MATERIAL_GRIP[material];
    out.rubber = lerpArray(this.rubber, si);
    out.marbles = lerpArray(this.marbles, si);
    out.dust = lerpArray(this.dust, si);
    out.temperature = lerpArray(this.temperature, si);
    out.shade = lerpArray(this.shade, si);
    out.wetness = lerpArray(this.wetness, si);
    out.puddling = lerpArray(this.puddling, si);
    out.drainage = lerpArray(this.drainage, si);
    out.onRacingLine = lineDistance <= 1.8;
    out.lineDistance = lineDistance;
    out.lineDrying = lerpArray(this.lineDrying, si);
    return out;
  }

  sampleDistance(distanceM, lateral = 0, out = {}) {
    return this.sampleSurface(wrap(distanceM, this.length) / this.ds, lateral, out);
  }

  gripAt(sampleIndex, lateral = 0, options = {}, out = {}) {
    const surface = this.sampleSurface(sampleIndex, lateral, out.surface || {});
    const tyreWet = clamp(options.wetTyre ?? 0, 0, 1);
    const wet = clamp(surface.wetness - (surface.onRacingLine ? surface.lineDrying * 0.34 : 0), 0, 1);
    const rubberBand = surface.onRacingLine ? surface.rubber : surface.rubber * 0.18;
    const debris = surface.dust * 0.10 + (!surface.onRacingLine ? surface.marbles * 0.18 : 0);
    const dry = surface.baseGrip * (1 + rubberBand * 0.075) * (1 - debris);
    const waterLoss = wet * (0.43 - tyreWet * 0.22) + surface.puddling * (0.20 - tyreWet * 0.08);
    const wetRubberPenalty = surface.onRacingLine ? rubberBand * wet * 0.12 : 0;
    const selected = clamp(dry * (1 - waterLoss - wetRubberPenalty), 0.28, 1.16);
    const alternateWet = clamp(surface.wetness * 0.88, 0, 1);
    const alternate = clamp(surface.baseGrip * (1 - alternateWet * (0.39 - tyreWet * 0.20) -
      surface.marbles * 0.16 - surface.dust * 0.08), 0.30, 1.08);
    out.multiplier = selected;
    out.dryGrip = clamp(dry, 0.35, 1.16);
    out.wetGrip = selected;
    out.alternateLineGrip = alternate;
    out.preferredLine = wet > 0.32 && alternate > selected + 0.015 ? 'alternate' : 'racing';
    out.wetness = wet;
    out.material = surface.material;
    out.surface = surface;
    return out;
  }

  _step(dt, weather, traffic) {
    const rain = clamp(weather?.rainfall ?? 0, 0, 18);
    const air = clamp(weather?.airTemperature ?? 22, 0, 50);
    const targetTrack = clamp(weather?.trackTemperature ?? air + 6, 0, 60);
    const cloud = clamp(weather?.cloudCover ?? 0.4, 0, 1);
    const wind = clamp(weather?.windSpeed ?? 3, 0, 20);
    const activity = this._activity;
    activity.fill(0);
    if (Array.isArray(traffic)) {
      for (const vehicle of traffic) {
        const state = vehicle?.phys || vehicle;
        const sample = Number(state?.sampleIndex ?? state?.sampleIdx ?? state?.idx ?? 0);
        const seg = Math.floor(this._segmentIndex(sample)) % this.segmentCount;
        const speed = clamp(Math.abs(state?.speed ?? state?.v ?? 35), 0, 110);
        const load = clamp(state?.load ?? vehicle?.load ?? 1, 0, 2);
        const lateral = Math.abs(state?.lateral ?? state?.lat ?? 0);
        const a = load * (0.35 + speed / 110);
        activity[seg] += a;
        this.rubber[seg] = clamp(this.rubber[seg] + dt * a * (lateral < 2.2 ? 0.00034 : 0.00005), 0, 1);
        this.marbles[seg] = clamp(this.marbles[seg] + dt * a * (lateral > 2.5 ? 0.00022 : 0.00008), 0, 1);
        this.dust[seg] = clamp(this.dust[seg] - dt * a * 0.00055, 0, 1);
        this.lineDrying[seg] = clamp(this.lineDrying[seg] + dt * a * this.wetness[seg] * 0.0014, 0, 1);
      }
    }
    for (let i = 0; i < this.segmentCount; i++) {
      const shade = this.shade[i];
      const trafficHeat = activity[i] * 1.3;
      const target = targetTrack - shade * (5 + (1 - cloud) * 4) + trafficHeat;
      this.temperature[i] += (target - this.temperature[i]) * Math.min(1, dt * (0.0024 + wind * 0.00012));
      const rainfallGain = rain * dt * 0.00014 * (0.92 + shade * 0.16);
      const evaporation = rain < 0.08
        ? dt * (0.00010 + Math.max(0, this.temperature[i] - air) * 0.000012 + wind * 0.000012) * (1 - shade * 0.45)
        : 0;
      const drainageLoss = dt * this.drainage[i] * (0.00020 + this.wetness[i] * 0.00034);
      this.wetness[i] = clamp(this.wetness[i] + rainfallGain - evaporation - drainageLoss, 0, 1);
      const puddleTarget = clamp((this.wetness[i] - 0.52) * 2.2 * (1 - this.drainage[i]), 0, 1);
      this.puddling[i] += (puddleTarget - this.puddling[i]) * Math.min(1, dt * 0.018);
      if (rain > 0.08) {
        this.dust[i] = clamp(this.dust[i] - dt * rain * 0.00016, 0, 1);
        this.marbles[i] = clamp(this.marbles[i] - dt * rain * 0.000035, 0, 1);
        this.lineDrying[i] = clamp(this.lineDrying[i] - dt * rain * 0.00020, 0, 1);
      } else {
        this.lineDrying[i] = clamp(this.lineDrying[i] - dt * 0.00016, 0, 1);
      }
      if (this.conditionOverride) {
        const authored = this.conditionOverride;
        if (Number.isFinite(authored.wetness)) this.wetness[i] = authored.wetness;
        if (Number.isFinite(authored.puddling)) this.puddling[i] = authored.puddling;
        if (Number.isFinite(authored.temperature)) this.temperature[i] = authored.temperature;
      }
    }
  }

  advance(dt, traffic = []) {
    const safeDt = clamp(dt, 0, TRACK_STATE_LIMITS.maxAdvanceS);
    this._accumulator += safeDt;
    const step = TRACK_STATE_LIMITS.fixedStepS;
    while (this._accumulator + 1e-9 >= step) {
      const weather = this.weather.advance(step);
      this._step(step, weather, traffic);
      this._accumulator -= step;
      this.time += step;
    }
    this.syncVisuals();
    return this.weather.current;
  }

  update(dt, weather, traffic = []) {
    const safeDt = clamp(dt, 0, TRACK_STATE_LIMITS.maxAdvanceS);
    this._accumulator += safeDt;
    while (this._accumulator + 1e-9 >= TRACK_STATE_LIMITS.fixedStepS) {
      this._step(TRACK_STATE_LIMITS.fixedStepS, weather, traffic);
      this._accumulator -= TRACK_STATE_LIMITS.fixedStepS;
      this.time += TRACK_STATE_LIMITS.fixedStepS;
    }
    this.syncVisuals(weather);
  }

  setVisualHook(hook) {
    this._visualHook = typeof hook === 'function' ? hook : null;
    this.syncVisuals();
  }

  // Deterministic offline race-director hook. This mutates the same fixed
  // arrays sampled by physics, AI and visuals; it is useful for authored race
  // weekends, replay restoration and acceptance scenarios without introducing
  // a parallel test-only state.
  setConditions(conditions = {}) {
    if (conditions.clear === true) return this.clearConditions();
    const wetness = conditions.wetness;
    const puddling = conditions.puddling;
    const temperature = conditions.trackTemperature ?? conditions.temperature;
    const rainfall = conditions.rainfall ??
      (Number.isFinite(conditions.intensity) ? conditions.intensity * 18 : undefined);
    const locked = conditions.locked !== false;
    if (Number.isFinite(wetness)) {
      this.wetness.fill(clamp(wetness, 0, 1));
      this.lineDrying.fill(0);
    }
    if (Number.isFinite(puddling)) this.puddling.fill(clamp(puddling, 0, 1));
    else if (Number.isFinite(wetness)) {
      this.puddling.fill(clamp((wetness - 0.52) * 1.15, 0, 1));
    }
    if (Number.isFinite(temperature)) this.temperature.fill(clamp(temperature, 0, 60));
    if (Number.isFinite(conditions.rubber)) this.rubber.fill(clamp(conditions.rubber, 0, 1));
    if (Number.isFinite(conditions.dust)) this.dust.fill(clamp(conditions.dust, 0, 1));
    this.conditionOverride = locked ? {
      wetness: Number.isFinite(wetness) ? clamp(wetness, 0, 1) : undefined,
      puddling: Number.isFinite(puddling) ? clamp(puddling, 0, 1)
        : (Number.isFinite(wetness) ? clamp((wetness - 0.52) * 1.15, 0, 1) : undefined),
      temperature: Number.isFinite(temperature) ? clamp(temperature, 0, 60) : undefined,
    } : null;
    const hasWeather = Number.isFinite(rainfall) || Number.isFinite(conditions.cloudCover) ||
      Number.isFinite(conditions.airTemperature) || Number.isFinite(conditions.humidity) ||
      Number.isFinite(conditions.windSpeed) || Number.isFinite(conditions.windDirection);
    if (!locked) this.weather.clearOverride();
    else if (hasWeather) this.weather.setOverride({
      rainfall: Number.isFinite(rainfall) ? clamp(rainfall, 0, 18) : undefined,
      trackTemperature: Number.isFinite(temperature) ? temperature : undefined,
      airTemperature: conditions.airTemperature,
      cloudCover: conditions.cloudCover,
      humidity: conditions.humidity,
      windSpeed: conditions.windSpeed,
      windDirection: conditions.windDirection,
    });
    return this.syncVisuals(this.weather.current);
  }

  clearConditions() {
    this.conditionOverride = null;
    this.weather.clearOverride();
    return this.syncVisuals(this.weather.current);
  }

  syncVisuals(weather = this.weather.current) {
    const wetness = average(this.wetness);
    const puddling = average(this.puddling);
    const rubber = average(this.rubber);
    this.visualState.wetness = wetness;
    this.visualState.puddling = puddling;
    this.visualState.rainfall = clamp(weather?.rainfall ?? 0, 0, 18);
    this.visualState.rubber = rubber;
    this.visualState.roadRoughness = clamp(1 - wetness * 0.38 - puddling * 0.10, 0.48, 1);
    this.visualState.reflectionStrength = clamp(wetness * 0.70 + puddling * 0.25, 0, 0.88);
    this.visualState.racingLineOpacity = clamp(0.16 + rubber * 0.70 - wetness * 0.18, 0.08, 0.90);
    if (this._visualHook) this._visualHook(this.visualState);
    return this.visualState;
  }

  dispose() { this._visualHook = null; }
}

export function createTrackState(options) {
  return new TrackState(options);
}
