// Deterministic race-strategy decisions. The planner only consumes explicit
// session state; callers may inject forecast snapshots without coupling the
// simulator to a weather or UI implementation.
import { COMPOUNDS } from './physics.js';

const DRY = Object.freeze(['S', 'M', 'H']);
const WET = Object.freeze(['I', 'W']);

export function normalizeForecast(value = {}) {
  const wetness = clamp(value.wetness ?? value.rain ?? 0, 0, 1);
  return {
    wetness,
    trackGrip: clamp(value.trackGrip ?? (1 - wetness * 0.32), 0.45, 1.1),
    rainInLaps: Number.isFinite(value.rainInLaps) ? Math.max(0, value.rainInLaps) : Infinity,
    dryingInLaps: Number.isFinite(value.dryingInLaps) ? Math.max(0, value.dryingInLaps) : Infinity,
  };
}

export function compoundFamily(key) {
  return WET.includes(key) ? 'wet' : DRY.includes(key) ? 'dry' : 'unknown';
}

export function chooseWeatherTyre(forecast, current = 'M') {
  const f = normalizeForecast(forecast);
  if (f.wetness >= 0.68) return 'W';
  if (f.wetness >= 0.22) return 'I';
  return DRY.includes(current) ? current : 'M';
}

export function tyreLifeLaps(compound, totalLaps, aggression = 0.5) {
  const ratio = compound === 'S' ? 0.34 : compound === 'M' ? 0.53 : compound === 'H' ? 0.72 :
    compound === 'I' ? 0.48 : compound === 'W' ? 0.42 : 0.53;
  return Math.max(2, Math.round(totalLaps * ratio * (1.08 - clamp(aggression, 0, 1) * 0.16)));
}

export function fuelTargetMode(fuel, raceProgress, safetyCar = false) {
  const expected = clamp(1 - raceProgress, 0, 1);
  const margin = fuel - expected;
  if (safetyCar || margin > 0.055) return 'push';
  if (margin < -0.035) return 'save';
  return 'balanced';
}

export function ersTargetMode(battery, context = {}) {
  if (context.noOvertake || context.safetyCar) return 0;
  if (battery < 0.24) return 0;
  if (battery > 0.78 || context.attack || context.defend || context.finalLaps <= 2) return 2;
  return 1;
}

export class StrategyPlanner {
  constructor(opts = {}) {
    this.random = opts.random || (() => 0.5);
    this.totalLaps = Math.max(1, opts.totalLaps || 1);
    this.aggression = clamp(opts.aggression ?? 0.5, 0, 1);
    this.forecast = typeof opts.forecast === 'function' ? opts.forecast : () => opts.forecast || {};
    this.stopCount = 0;
    this.lastDecisionLap = -1;
  }

  conditionsAt(lap) {
    return normalizeForecast(this.forecast(lap) || {});
  }

  chooseStartCompound(gridPos = 11) {
    const wet = chooseWeatherTyre(this.conditionsAt(0));
    if (WET.includes(wet)) return wet;
    if (this.totalLaps < 8) return 'S';
    const front = gridPos <= 8;
    const roll = this.random();
    if (front) return roll < 0.7 ? 'S' : 'M';
    return roll < 0.55 ? 'M' : roll < 0.78 ? 'S' : 'H';
  }

  decide(state) {
    const lap = Math.max(0, state.lap || 0);
    const left = Math.max(0, this.totalLaps - lap);
    const current = state.compound || 'M';
    const now = this.conditionsAt(lap);
    const soon = this.conditionsAt(Math.min(this.totalLaps, lap + 2));
    const weatherTyre = chooseWeatherTyre(now, current);
    const life = tyreLifeLaps(current, this.totalLaps, this.aggression);
    const worn = (state.wear || 0) > 0.69 || (state.tyreAgeLaps || 0) >= life;
    const damaged = (state.damageSeverity || 0) >= 0.34;
    const punctureRisk = (state.wear || 0) > 0.88;
    const weatherMismatch = compoundFamily(weatherTyre) !== compoundFamily(current) ||
      (WET.includes(weatherTyre) && weatherTyre !== current && Math.abs(now.wetness - soon.wetness) < 0.24);
    const canStop = lap > 0 && left > 1 && this.lastDecisionLap !== lap;
    const shouldPit = canStop && (weatherMismatch || punctureRisk || damaged ||
      (worn && left > Math.max(1, life * 0.22)));

    let nextCompound = weatherTyre;
    if (!WET.includes(nextCompound)) {
      if (left <= tyreLifeLaps('S', this.totalLaps, this.aggression) && this.aggression > 0.62) nextCompound = 'S';
      else if (left <= tyreLifeLaps('M', this.totalLaps, this.aggression)) nextCompound = 'M';
      else nextCompound = 'H';
      if (nextCompound === current && worn) nextCompound = current === 'S' ? 'M' : current === 'M' ? 'H' : 'M';
    }

    if (shouldPit) this.lastDecisionLap = lap;
    return {
      shouldPit,
      nextCompound,
      repair: damaged,
      reason: weatherMismatch ? 'weather' : damaged ? 'damage' : punctureRisk ? 'puncture-risk' : worn ? 'tyre-life' : 'stay-out',
      fuelMode: fuelTargetMode(state.fuel ?? 1, lap / this.totalLaps, !!state.safetyCar),
      ersMode: ersTargetMode(state.battery ?? 1, {
        noOvertake: state.noOvertake,
        safetyCar: state.safetyCar,
        attack: state.attack,
        defend: state.defend,
        finalLaps: left,
      }),
      conditions: now,
    };
  }

  confirmStop() { this.stopCount++; }
}

export function compoundData(key) {
  return COMPOUNDS[key] || COMPOUNDS.M;
}

function clamp(value, lo, hi) {
  const n = Number(value);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}
