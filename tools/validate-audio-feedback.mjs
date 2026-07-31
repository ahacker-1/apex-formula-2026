import assert from 'node:assert/strict';
import {
  OPPONENT_VOICE_BUDGET,
  createAudioTargets,
  deriveAudioTargets,
  normalizeOpponentCue,
  smoothTelemetry,
} from '../js/audioTelemetry.js';
import { AudioEngine } from '../js/audio.js';

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  _at(kind, value, time, constant = 0) {
    this.value = value;
    this.events.push([kind, value, time, constant]);
  }
  setValueAtTime(v, t) { this._at('set', v, t); }
  setTargetAtTime(v, t, c) { this._at('target', v, t, c); }
  linearRampToValueAtTime(v, t) { this._at('linear', v, t); }
  exponentialRampToValueAtTime(v, t) { this._at('exponential', v, t); }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}

class FakeNode {
  constructor(context) {
    this.context = context;
    this.connections = [];
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.Q = new FakeParam(1);
    this.pan = new FakeParam(0);
    this.playbackRate = new FakeParam(1);
    this.detune = new FakeParam(0);
  }
  connect(dest) { this.connections.push(dest); return dest; }
  disconnect() { this.connections.length = 0; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeBuffer {
  constructor(channels, length, rate) {
    this.duration = length / rate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'running';
    this.destination = new FakeNode(this);
    this.created = 1;
  }
  _node() { this.created++; return new FakeNode(this); }
  createGain() { return this._node(); }
  createBiquadFilter() { return this._node(); }
  createOscillator() { return this._node(); }
  createBufferSource() { return this._node(); }
  createStereoPanner() { return this._node(); }
  createDynamicsCompressor() {
    const n = this._node();
    n.threshold = new FakeParam(); n.knee = new FakeParam(); n.ratio = new FakeParam();
    n.attack = new FakeParam(); n.release = new FakeParam();
    return n;
  }
  createBuffer(channels, length, rate) { return new FakeBuffer(channels, length, rate); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

// Pure mapping: aliases, inference, and in-place reuse must remain deterministic.
const target = createAudioTargets();
const mapped = deriveAudioTargets({
  rpmFrac: 0.8, throttle: 0.05, brake: 0.94, speed: 64, gear: 7,
  slip: true, kerb: 0.6, bottomed: 0.7, damageLevel: 0.35,
  surface: 'wet', rainIntensity: 0.55, cameraMode: 'cockpit',
  ersDeploy: 0.9, lateralLoad: 0.72,
}, target);
ok(mapped === target, 'telemetry derivation must reuse the caller-owned target');
ok(mapped.lockup > 0.5 && mapped.slip === 0.72, 'braking slip must infer a useful lockup layer');
ok(mapped.wetness === 0.8 && mapped.spray > 0.6 && mapped.rain === 0.55,
  'wet surface must derive rain and speed-scaled spray');
ok(mapped.cockpit === 1 && mapped.boost === 0.9 && mapped.regen === 0.65,
  'camera and 2026 deploy/regen hooks must map independently');
ok(deriveAudioTargets({ surface: 'gravel' }, target).roughness === 1,
  'named rough surfaces must activate their texture bed without extra flags');

let a = 0, b = 0;
for (let i = 0; i < 60; i++) {
  a = smoothTelemetry(a, i < 20 ? 1 : 0, 1 / 60, 12, 6);
  b = smoothTelemetry(b, i < 20 ? 1 : 0, 1 / 60, 12, 6);
}
ok(a === b && a > 0 && a < 0.2, 'arrow-key attack/release smoothing must be deterministic and bounded');

const cueA = normalizeOpponentCue({ id: 'car-7', side: -1, distance: 4,
  relativeSpeed: 31, rpmFrac: 0.88, intensity: 0.9 });
const cueB = normalizeOpponentCue({ id: 'car-7', side: -1, distance: 24,
  relativeSpeed: 31, rpmFrac: 0.88, intensity: 0.9 });
ok(cueA.intensity > cueB.intensity && cueA.side === -1,
  'opponent cues must preserve side and attenuate with distance');

globalThis.AudioContext = FakeAudioContext;
const audio = new AudioEngine();
ok(audio.ctx === null && audio.ready === false, 'construction must remain autoplay-safe and lazy');
audio.init();
ok(audio.ready && audio._opponentVoices.length === OPPONENT_VOICE_BUDGET,
  'init must create the fixed opponent voice budget');
const ctx = audio.ctx;
const graphNodes = ctx.created;
const refs = [audio.scrubGain, audio.lockGain, audio.rainGain, audio.damageGain,
  audio.bottomGain, ...audio._opponentVoices];

for (let frame = 0; frame < 180; frame++) {
  ctx.currentTime = frame / 60;
  audio.update(1 / 60, {
    rpmFrac: 0.35 + frame / 360, throttle: frame < 90 ? 1 : 0,
    brake: frame >= 90 ? 0.9 : 0, speed: 58, gear: frame < 90 ? 4 : 3,
    slip: frame >= 90 ? 0.85 : 0.25, kerb: frame > 30 && frame < 50 ? 0.8 : 0,
    boost: frame < 80, bottoming: frame === 42 ? 0.9 : 0,
    damage: 0.4, wetness: 0.7, rain: 0.5, cockpit: true,
  });
}
ok(ctx.created === graphNodes, 'per-frame updates must not allocate WebAudio nodes');
ok(refs[0] === audio.scrubGain && refs[1] === audio.lockGain && refs[2] === audio.rainGain &&
  refs[3] === audio.damageGain && refs[4] === audio.bottomGain,
  'continuous feedback beds must remain pooled');
ok(audio.lockGain.gain.value > 0 && audio.sprayGain.gain.value > 0 &&
  audio.damageGain.gain.value > 0, 'lockup, wet spray, and damage telemetry must reach audible gains');
ok(audio.perspectiveLP.frequency.value < 7000 && audio.perspectiveBody.gain.value > 3,
  'cockpit perspective must close and reinforce the car bus');

ctx.currentTime = 4;
for (let i = 0; i < 6; i++) {
  audio.passBy({ id: `opponent-${i}`, side: i % 2 ? -1 : 1, intensity: 0.9,
    distance: 5 + i, relativeSpeed: 28 + i, rpmFrac: 0.75 });
}
ok(audio._opponentVoices.length === OPPONENT_VOICE_BUDGET &&
  audio._opponentVoices.filter(v => v.activeUntil > ctx.currentTime).length === OPPONENT_VOICE_BUDGET,
  'simultaneous passes must never exceed the fixed voice budget');
ok(ctx.created === graphNodes, 'procedural pass-bys must reuse the opponent pool');
ok(audio._opponentVoices.some(v => v.pan && v.pan.pan.events.some(e => e[0] === 'linear')),
  'pass-by voices must sweep across the stereo field');

const publicMethods = ['init', 'update', 'shift', 'wallImpact', 'carImpact', 'collision',
  'passBy', 'updateOpponents', 'loadSamplePack', 'startEngine', 'stopEngine', 'setVolume', 'setMuted'];
ok(publicMethods.every(name => typeof audio[name] === 'function'),
  'legacy API plus optional opponent telemetry API must remain available');

delete globalThis.AudioContext;
console.log(`[audio-feedback] ${checks} deterministic, pooled, spatial, and telemetry checks passed`);
