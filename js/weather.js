// Deterministic, bounded circuit weather. The timeline is generated once from a
// string seed and then sampled without consuming random numbers, so replays and
// AI strategy see the same conditions regardless of render frame rate.

export const WEATHER_LIMITS = Object.freeze({
  minDurationS: 300,
  maxDurationS: 10800,
  keyframeStepS: 60,
  maxKeyframes: 181,
  maxForecastPoints: 12,
  maxRainMmH: 18,
  minAirC: 7,
  maxAirC: 38,
  maxWindMS: 16,
});

const CLIMATES = Object.freeze({
  temperate: { air: 22, swing: 4, humidity: 0.55, rainBias: 0.12, cloudBias: 0.38, wind: 3.8 },
  forest: { air: 17, swing: 3, humidity: 0.72, rainBias: 0.31, cloudBias: 0.58, wind: 3.1 },
  desert: { air: 31, swing: 5, humidity: 0.22, rainBias: 0.01, cloudBias: 0.12, wind: 5.2 },
  tropical: { air: 29, swing: 2, humidity: 0.78, rainBias: 0.24, cloudBias: 0.54, wind: 3.5 },
  coastal: { air: 25, swing: 3, humidity: 0.66, rainBias: 0.11, cloudBias: 0.40, wind: 5.7 },
});

const TRACK_CLIMATE = Object.freeze({
  spa: 'forest', suzuka: 'forest', silverstone: 'temperate', zandvoort: 'coastal',
  bahrain: 'desert', jeddah: 'desert', lusail: 'desert', yasmarina: 'desert',
  singapore: 'tropical', miami: 'tropical', interlagos: 'tropical',
  monaco: 'coastal', baku: 'coastal', melbourne: 'coastal',
});

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo));
}

function hash32(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5;
  return h >>> 0;
}

function unit(seed, index, channel) {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 7, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return (x >>> 0) / 4294967295;
}

function smooth(previous, target, amount) {
  return previous + (target - previous) * amount;
}

export class WeatherTimeline {
  constructor(options = {}) {
    this.trackId = String(options.trackId || 'generic');
    this.seed = hash32(`${options.seed ?? 'race'}:${this.trackId}`);
    this.duration = clamp(options.durationS ?? 5400,
      WEATHER_LIMITS.minDurationS, WEATHER_LIMITS.maxDurationS);
    this.step = WEATHER_LIMITS.keyframeStepS;
    this.climateId = options.climate || TRACK_CLIMATE[this.trackId] || 'temperate';
    this.climate = CLIMATES[this.climateId] || CLIMATES.temperate;
    this.time = 0;
    this.override = null;
    this.keyframes = this._build();
    this.current = this.sample(0, {});
  }

  _build() {
    const count = Math.min(WEATHER_LIMITS.maxKeyframes, Math.ceil(this.duration / this.step) + 1);
    const frames = new Array(count);
    const c = this.climate;
    let cloud = clamp(c.cloudBias + (unit(this.seed, 0, 1) - 0.5) * 0.35, 0.03, 0.96);
    let humidity = clamp(c.humidity + (unit(this.seed, 0, 2) - 0.5) * 0.18, 0.12, 0.98);
    let wind = clamp(c.wind + (unit(this.seed, 0, 3) - 0.5) * 2.5, 0, WEATHER_LIMITS.maxWindMS);
    for (let i = 0; i < count; i++) {
      cloud = smooth(cloud, clamp(c.cloudBias + (unit(this.seed, i, 4) - 0.5) * 0.72, 0, 1), 0.22);
      humidity = smooth(humidity, clamp(c.humidity + (unit(this.seed, i, 5) - 0.5) * 0.30, 0.08, 1), 0.18);
      wind = smooth(wind, clamp(c.wind + (unit(this.seed, i, 6) - 0.5) * 5.2, 0, WEATHER_LIMITS.maxWindMS), 0.20);
      const storm = clamp((cloud - (0.68 - c.rainBias * 0.42)) * 2.8 +
        (humidity - 0.68) * 1.7 + (unit(this.seed, i, 7) - 0.58) * 0.8, 0, 1);
      const rainfall = clamp(storm * storm * (5 + unit(this.seed, i, 8) * 13), 0, WEATHER_LIMITS.maxRainMmH);
      const dayWave = Math.sin((i / Math.max(1, count - 1)) * Math.PI * 0.85 - 0.3);
      const airTemperature = clamp(c.air + dayWave * c.swing - cloud * 2.4 +
        (unit(this.seed, i, 9) - 0.5) * 0.8, WEATHER_LIMITS.minAirC, WEATHER_LIMITS.maxAirC);
      frames[i] = Object.freeze({
        time: Math.min(this.duration, i * this.step),
        airTemperature,
        trackTemperature: clamp(airTemperature + (1 - cloud) * 12 - rainfall * 0.22, 6, 55),
        cloudCover: cloud,
        humidity,
        rainfall,
        windSpeed: wind,
        windDirection: unit(this.seed, i, 10) * Math.PI * 2,
      });
    }
    return Object.freeze(frames);
  }

  sample(timeS, out = {}) {
    const t = clamp(timeS, 0, this.duration);
    if (this.override) {
      Object.assign(out, this.override);
      out.time = t;
      out.raining = out.rainfall > 0.08;
      out.intensity = clamp(out.rainfall / WEATHER_LIMITS.maxRainMmH, 0, 1);
      out.condition = out.raining ? 'rain' : (out.cloudCover > 0.72 ? 'overcast' : 'clear');
      return out;
    }
    const f = t / this.step;
    const i0 = Math.min(this.keyframes.length - 1, Math.floor(f));
    const i1 = Math.min(this.keyframes.length - 1, i0 + 1);
    const k = Math.max(0, Math.min(1, f - i0));
    const a = this.keyframes[i0], b = this.keyframes[i1];
    out.time = t;
    for (const key of ['airTemperature', 'trackTemperature', 'cloudCover', 'humidity', 'rainfall', 'windSpeed']) {
      out[key] = a[key] + (b[key] - a[key]) * k;
    }
    const da = Math.atan2(Math.sin(b.windDirection - a.windDirection), Math.cos(b.windDirection - a.windDirection));
    out.windDirection = (a.windDirection + da * k + Math.PI * 2) % (Math.PI * 2);
    out.raining = out.rainfall > 0.08;
    out.intensity = clamp(out.rainfall / WEATHER_LIMITS.maxRainMmH, 0, 1);
    out.condition = out.raining ? 'rain' : (out.cloudCover > 0.72 ? 'overcast' : 'clear');
    return out;
  }

  setOverride(values = {}) {
    const base = this.sample(this.time, {});
    this.override = {
      airTemperature: clamp(values.airTemperature ?? base.airTemperature, WEATHER_LIMITS.minAirC, WEATHER_LIMITS.maxAirC),
      trackTemperature: clamp(values.trackTemperature ?? base.trackTemperature, 6, 55),
      cloudCover: clamp(values.cloudCover ?? base.cloudCover, 0, 1),
      humidity: clamp(values.humidity ?? base.humidity, 0.08, 1),
      rainfall: clamp(values.rainfall ?? base.rainfall, 0, WEATHER_LIMITS.maxRainMmH),
      windSpeed: clamp(values.windSpeed ?? base.windSpeed, 0, WEATHER_LIMITS.maxWindMS),
      windDirection: (((values.windDirection ?? base.windDirection ?? 0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    };
    return this.sample(this.time, this.current);
  }

  clearOverride() {
    this.override = null;
    return this.sample(this.time, this.current);
  }

  advance(dt) {
    this.time = clamp(this.time + clamp(dt, 0, 30), 0, this.duration);
    return this.sample(this.time, this.current);
  }

  reset(timeS = 0) {
    this.time = clamp(timeS, 0, this.duration);
    return this.sample(this.time, this.current);
  }

  forecast(lookaheadS = 1800, intervalS = 300) {
    const interval = clamp(intervalS, 60, 900);
    const count = Math.min(WEATHER_LIMITS.maxForecastPoints,
      Math.max(1, Math.ceil(clamp(lookaheadS, 0, 7200) / interval) + 1));
    const result = new Array(count);
    for (let i = 0; i < count; i++) result[i] = this.sample(this.time + i * interval, {});
    return result;
  }
}

export function createWeatherTimeline(options) {
  return new WeatherTimeline(options);
}
