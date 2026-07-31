// Deterministic race-control state machine. Consumers decide how to present the
// states; this module owns legal transitions, pace deltas and restart timing.
export const CONTROL_STATES = Object.freeze([
  'green', 'local-yellow', 'yellow', 'vsc', 'safety-car', 'red-flag', 'restart',
]);

const DEFAULTS = Object.freeze({
  'local-yellow': 12,
  yellow: 16,
  vsc: 24,
  'safety-car': 42,
  'red-flag': Infinity,
  restart: 5,
});

export class RaceControl {
  constructor(opts = {}) {
    this.random = opts.random || (() => 0.5);
    this.onEvent = opts.onEvent || (() => {});
    this.state = 'green';
    this.timeLeft = 0;
    this.cycle = 0;
    this.reason = '';
    this.zone = null;
    this.restartType = 'rolling';
    this.pending = null;
  }

  get active() { return this.state !== 'green'; }
  get noOvertake() { return this.state !== 'green' && this.state !== 'local-yellow'; }
  get paceFactor() {
    return this.state === 'vsc' ? 0.6
      : this.state === 'safety-car' ? 0.38
      : this.state === 'yellow' ? 0.72
      : this.state === 'red-flag' ? 0
      : this.state === 'restart' ? 0.68 : 1;
  }

  deploy(kind, opts = {}) {
    if (!CONTROL_STATES.includes(kind) || kind === 'green' || kind === 'restart') {
      throw new RangeError(`Unsupported race-control state: ${kind}`);
    }
    const previous = this.state;
    this.cycle++;
    this.state = kind;
    this.timeLeft = Number.isFinite(opts.duration) ? Math.max(0, opts.duration) : DEFAULTS[kind];
    this.reason = opts.reason || 'incident';
    this.zone = kind === 'local-yellow' ? normalizeZone(opts.zone) : null;
    this.restartType = opts.restartType === 'standing' ? 'standing' : 'rolling';
    this.pending = null;
    this._emit('deploy', previous);
    return this.snapshot();
  }

  resume(opts = {}) {
    if (this.state === 'green') return this.snapshot();
    const previous = this.state;
    if (opts.immediate === true) {
      this.state = 'green';
      this.timeLeft = 0;
      this.reason = '';
      this.zone = null;
      this.pending = null;
      if (opts.restartType === 'standing' || opts.restartType === 'rolling') {
        this.restartType = opts.restartType;
      }
      this._emit('green', previous);
      return this.snapshot();
    }
    this.state = 'restart';
    this.timeLeft = Number.isFinite(opts.duration) ? Math.max(0, opts.duration) : DEFAULTS.restart;
    this.restartType = opts.restartType === 'standing' ? 'standing' : this.restartType;
    this.zone = null;
    this._emit('restart', previous);
    return this.snapshot();
  }

  update(dt) {
    if (this.state === 'green' || this.state === 'red-flag') return null;
    this.timeLeft = Math.max(0, this.timeLeft - Math.max(0, dt));
    if (this.timeLeft > 0) return null;
    if (this.state === 'safety-car' || this.state === 'yellow') return this.resume();
    const previous = this.state;
    this.state = 'green';
    this.reason = '';
    this.zone = null;
    this._emit('green', previous);
    return this.snapshot();
  }

  controlForSample(sampleIdx, sampleCount) {
    if (this.state !== 'local-yellow') return { paceFactor: this.paceFactor, noOvertake: this.noOvertake };
    const active = inWrappedZone(sampleIdx, sampleCount, this.zone);
    return { paceFactor: active ? 0.65 : 1, noOvertake: active };
  }

  snapshot() {
    return {
      state: this.state,
      active: this.active,
      timeLeft: this.timeLeft,
      cycle: this.cycle,
      reason: this.reason,
      zone: this.zone ? { ...this.zone } : null,
      restartType: this.restartType,
      paceFactor: this.paceFactor,
      noOvertake: this.noOvertake,
    };
  }

  _emit(action, previous) {
    this.onEvent({ action, previous, ...this.snapshot(), eventKey: `control:${this.cycle}:${action}` });
  }
}

function normalizeZone(zone = {}) {
  return { start: Math.max(0, Math.round(zone.start || 0)), end: Math.max(0, Math.round(zone.end || 0)) };
}

function inWrappedZone(idx, count, zone) {
  if (!zone || !count) return false;
  const value = ((idx % count) + count) % count;
  const start = zone.start % count;
  const end = zone.end % count;
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
}
