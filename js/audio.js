// audio.js — Synthesized WebAudio broadcast package for the F1 2026 simulator.
// No samples, no external deps: oscillator stacks + filtered noise only.
// The AudioContext is created lazily in init() (browser autoplay policy:
// must be called from a user gesture).
//
// Signal flow
//   engine oscs ─┐
//   turbo/trans ─┼─► engineGain ─► formant ─► engineLP ─┐
//                                                       ├─► engineOut ─► engineDuck ─┐
//   mguk / wind / kerb / gravel / scrub / crackle / wg ──┘                            │
//   one-shots (shift blip, pit gun, radio, ui, crowd, crescendo) ────────────────────┼─► master ─► limiter ─► out
//                                                                                    ┘
// engineOut = start/stop fade, engineDuck = one-shot ducking (-2 dB), master = volume.
//
// Real-time contract: update() touches only pre-built nodes and never allocates.
// Every audible parameter move goes through setTargetAtTime / linearRamp so there
// are no zipper noises or clicks.

import {
  OPPONENT_VOICE_BUDGET,
  createAudioTargets,
  deriveAudioTargets,
  normalizeOpponentCue,
  smoothTelemetry,
} from './audioTelemetry.js';

const EMPTY = {};

// Gear top speeds in m/s — mirrors GEAR_TOP in physics.js. Used only to estimate
// the current gear when the caller does not pass one (keeps this file dep-free).
const GEAR_TOP = [27.5, 37, 46.5, 56, 65.5, 75, 85.5, 96.5];

const DUCK_GAIN = 0.794; // -2 dB

function clamp01(v) {
  v = +v;
  if (!(v > 0)) return 0; // also maps NaN -> 0
  return v > 1 ? 1 : v;
}

function clampNum(v, lo, hi) {
  v = +v;
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export class AudioEngine {
  constructor() {
    // Nothing is created here (autoplay policy). init() builds the graph.
    this.ctx = null;
    this._ready = false;
    this._volume = 0.8;
    this._muted = false;

    // live state
    this._rpm = 0;
    this._thr = 0;
    this._speed = 0;
    this._prevThr = 0;
    this._prevSpeed = 0;
    this._accel = 0; // smoothed m/s^2, used to infer shift direction
    this._spool = 0; // turbo spool-up, lags throttle
    this._load = 0;
    this._slip = 0;
    this._lockup = 0;
    this._wetness = 0;
    this._damage = 0;
    this._bottoming = 0;
    this._gear = 1;
    this._gearCand = 1;
    this._gearCandT = 0;

    // frame-decayed envelopes (drive pitch bend / ignition cut on shifts)
    this._shiftEnv = 0;
    this._shiftDir = 1;
    this._cutEnv = 0;

    // event cooldowns
    this._slipCooldown = 0;
    this._wgCooldown = 0;
    this._wallImpactCooldown = 0;
    this._carImpactCooldown = 0;
    this._bottomCooldown = 0;

    // Reused telemetry/cue records keep the real-time update path allocation-free.
    this._audioTargets = createAudioTargets();
    this._opponentCue = {};
    this._opponentVoices = [];
    this._opponentCooldowns = new Map();

    // beds
    this._crowdLevel = 0;
    this._crowdStarted = false;
    this._cresc = null;
  }

  get ready() {
    return this._ready;
  }

  // Idempotent. Call on first user gesture.
  init() {
    if (this._ready) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC =
      (typeof window !== 'undefined' &&
        (window.AudioContext || window.webkitAudioContext)) ||
      (typeof AudioContext !== 'undefined' ? AudioContext : null);
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;
    queueMicrotask(() => this._decodePending());

    // ---- master chain: master gain -> limiter -> destination ----
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.22;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this._volume;
    this.master.connect(this.limiter);

    // Shared looping noise buffers (one white, one crowd-ish pink) — every noise
    // layer in the game reads from these, so memory and CPU stay flat.
    this._noiseBuffer = this._makeNoiseBuffer(1.7);
    this._crowdBuffer = this._makeCrowdBuffer(3.1);

    // ---- engine bus ----
    this.engineDuck = this._gainNode(1, this.master); // one-shot ducking
    // Driver perspective: cockpit mode closes the bodywork/canopy filter and
    // adds a small low-mid resonance; exterior mode opens it back up. Keeping
    // the filter after engineOut means every continuous car/surface layer shares
    // the same physical perspective without touching UI/radio/crowd cues.
    this.perspectiveBody = this._filter('peaking', 310, 0.8, this.engineDuck);
    this.perspectiveBody.gain.value = 0;
    this.perspectiveLP = this._filter('lowpass', 12000, 0.65, this.perspectiveBody);
    this.engineOut = this._gainNode(0, this.perspectiveLP); // start/stop fade

    this.engineLP = this._filter('lowpass', 400, 0.9, this.engineOut);

    // Per-gear formant: a gentle resonant bump that steps with the gear, so each
    // ratio has its own vowel instead of one static timbre.
    this.formant = ctx.createBiquadFilter();
    this.formant.type = 'peaking';
    this.formant.frequency.value = 620;
    this.formant.Q.value = 1.15;
    this.formant.gain.value = 4.5; // dB — modest, so the limiter is not pinned
    this.formant.connect(this.engineLP);

    this.engineGain = this._gainNode(0.25 * 0.5, this.formant); // idle floor

    // ---- harmonic stack: fundamental (x2 detuned) + 2nd + 3rd + sub ----
    // Gains are re-balanced every frame so the character morphs with rpm:
    // fat and fundamental-heavy down low, harmonic-heavy scream up top.
    this.saw1 = ctx.createOscillator();
    this.saw1.type = 'sawtooth';
    this.saw1.frequency.value = 105;
    this.g1 = this._gainNode(0.146, this.engineGain);
    this.saw1.connect(this.g1);

    this.saw2 = ctx.createOscillator();
    this.saw2.type = 'sawtooth';
    this.saw2.frequency.value = 105 * 1.014;
    this.g2 = this._gainNode(0.114, this.engineGain);
    this.saw2.connect(this.g2);

    this.h2 = ctx.createOscillator(); // 2nd harmonic
    this.h2.type = 'sawtooth';
    this.h2.frequency.value = 210;
    this.gh2 = this._gainNode(0.07, this.engineGain);
    this.h2.connect(this.gh2);

    this.h3 = ctx.createOscillator(); // 3rd harmonic, slightly stretched = metallic
    this.h3.type = 'square';
    this.h3.frequency.value = 317;
    this.gh3 = this._gainNode(0.02, this.engineGain);
    this.h3.connect(this.gh3);

    this.sq = ctx.createOscillator(); // sub / block rumble
    this.sq.type = 'square';
    this.sq.frequency.value = 52;
    this.g3 = this._gainNode(0.26, this.engineGain);
    this.sq.connect(this.g3);

    this.saw1.start();
    this.saw2.start();
    this.h2.start();
    this.h3.start();
    this.sq.start();

    // A restrained firing pulse and gearbox mesh layer fill the gaps between
    // the fundamental and harmonics. They follow load and ratio independently,
    // making throttle and shift state readable without simply getting louder.
    this.firingOsc = ctx.createOscillator();
    this.firingOsc.type = 'triangle';
    this.firingOsc.frequency.value = 82;
    this.firingBP = this._filter('bandpass', 190, 1.35, this.engineGain);
    this.firingGain = this._gainNode(0, this.firingBP);
    this.firingOsc.connect(this.firingGain);
    this.firingOsc.start();

    this.meshOsc = ctx.createOscillator();
    this.meshOsc.type = 'sawtooth';
    this.meshOsc.frequency.value = 920;
    this.meshBP = this._filter('bandpass', 1120, 5.4, this.engineLP);
    this.meshGain = this._gainNode(0, this.meshBP);
    this.meshOsc.connect(this.meshGain);
    this.meshOsc.start();

    // Persistent looping noise source: every white-noise layer taps this one node.
    this._noiseSrc = ctx.createBufferSource();
    this._noiseSrc.buffer = this._noiseBuffer;
    this._noiseSrc.loop = true;

    // Intake hiss: broad bandpass following throttle, muffled by engineLP offtrack.
    this.hissBP = this._filter('bandpass', 900, 1.1, null);
    this.hissGain = this._gainNode(0, this.engineLP);
    this._noiseSrc.connect(this.hissBP);
    this.hissBP.connect(this.hissGain);

    // Turbo spool whistle: narrow noise band + a pure tone, both rising with the
    // spool state (throttle x rpm, lagged) — the "kettle" behind the engine note.
    this.turboBP = this._filter('bandpass', 2000, 13, null);
    this.turboNoiseGain = this._gainNode(0, this.engineLP);
    this._noiseSrc.connect(this.turboBP);
    this.turboBP.connect(this.turboNoiseGain);

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 2000;
    this.turboToneGain = this._gainNode(0, this.engineLP);
    this.turboOsc.connect(this.turboToneGain);
    this.turboOsc.start();

    // Wastegate / blow-off: gated noise band that sweeps down on throttle lift,
    // amplitude-fluttered by a permanent LFO whose depth is gated with it.
    this.wgBP = this._filter('bandpass', 1800, 2.2, null);
    this.wgGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.wgBP);
    this.wgBP.connect(this.wgGain);
    this.wgFlutter = this._lfo('sine', 26, 0, this.wgGain.gain);

    // Overrun crackle: pooled bright noise chain, driven by scheduled pulse trains.
    this.crackleHP = this._filter('highpass', 1700, 0.8, null);
    this.crackleGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.crackleHP);
    this.crackleHP.connect(this.crackleGain);

    // MGU-K: the 2026 signature. Two beating sines through a resonant band, kept
    // audible even off throttle (regen) and pushed hard on deploy.
    this.mgukBP = this._filter('bandpass', 2600, 2.4, this.engineOut);
    this.mgukGain = this._gainNode(0, this.mgukBP);
    this.mgukOsc = ctx.createOscillator();
    this.mgukOsc.type = 'sine';
    this.mgukOsc.frequency.value = 1150;
    this.mgukOsc.connect(this.mgukGain);
    this.mgukOsc2 = ctx.createOscillator();
    this.mgukOsc2.type = 'sine';
    this.mgukOsc2.frequency.value = 2307;
    this.mgukGain2 = this._gainNode(0.45, this.mgukGain);
    this.mgukOsc2.connect(this.mgukGain2);
    this.mgukOsc.start();
    this.mgukOsc2.start();

    // MGU-K deploy air (noise sparkle on top of the whine).
    this.boostBP = this._filter('bandpass', 4200, 9, null);
    this.boostGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.boostBP);
    this.boostBP.connect(this.boostGain);

    // Transmission whine: straight-cut gear tone, only in the low gears on power.
    this.transBP = this._filter('bandpass', 1600, 6.5, null);
    this.transGain = this._gainNode(0, this.engineLP);
    this.transOsc = ctx.createOscillator();
    this.transOsc.type = 'triangle';
    this.transOsc.frequency.value = 1600;
    this.transOsc.connect(this.transBP);
    this.transBP.connect(this.transGain);
    this.transOsc.start();

    // Wind noise: airflow band that grows with speed^2 (post-lowpass so the
    // offtrack muffle doesn't eat it, pre-duck so stopEngine() silences it).
    this.windBP = this._filter('bandpass', 500, 0.6, null);
    this.windGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.windBP);
    this.windBP.connect(this.windGain);

    // Gravel / grass when offtrack (dark, speed-scaled).
    this.gravelLP = this._filter('lowpass', 550, 0.9, null);
    this.gravelGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.gravelLP);
    this.gravelLP.connect(this.gravelGain);

    // Persistent bodywork/barrier scrape bed. The graph is built once; live
    // contact only moves AudioParams, so sustained rubbing allocates no nodes.
    this.contactScrapeBP = this._filter('bandpass', 920, 0.85, null);
    this.contactScrapePan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.contactScrapePan) this.contactScrapePan.connect(this.engineOut);
    this.contactScrapeGain = this._gainNode(0, this.contactScrapePan || this.engineOut);
    this._noiseSrc.connect(this.contactScrapeBP);
    this.contactScrapeBP.connect(this.contactScrapeGain);

    // Tyre scrub: pooled burst chain (no allocation from update()).
    this.scrubBP = this._filter('bandpass', 900, 1.6, null);
    this.scrubGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.scrubBP);
    this.scrubBP.connect(this.scrubGain);

    // Lockup uses its own tonal/noise pair so braking stays distinct from
    // lateral scrub. Both are permanent, gain-gated voices.
    this.lockOsc = ctx.createOscillator();
    this.lockOsc.type = 'triangle';
    this.lockOsc.frequency.value = 1260;
    this.lockBP = this._filter('bandpass', 1380, 7.5, this.engineOut);
    this.lockGain = this._gainNode(0, this.lockBP);
    this.lockOsc.connect(this.lockGain);
    this.lockOsc.start();
    this.lockNoiseBP = this._filter('bandpass', 1750, 2.2, null);
    this.lockNoiseGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.lockNoiseBP);
    this.lockNoiseBP.connect(this.lockNoiseGain);

    // Road texture, rain/spray and damaged bodywork are continuous beds. The
    // telemetry hooks are optional; dry undamaged callers keep them silent.
    this.roadBP = this._filter('bandpass', 420, 0.75, null);
    this.roadGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.roadBP);
    this.roadBP.connect(this.roadGain);

    this.rainHP = this._filter('highpass', 3100, 0.55, null);
    this.rainGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.rainHP);
    this.rainHP.connect(this.rainGain);
    this.sprayBP = this._filter('bandpass', 1450, 0.7, null);
    this.sprayGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.sprayBP);
    this.sprayBP.connect(this.sprayGain);

    this.damageBP = this._filter('bandpass', 760, 3.5, null);
    this.damageGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.damageBP);
    this.damageBP.connect(this.damageGain);
    this.damageFlutter = this._lfo('square', 23, 0, this.damageGain.gain);

    // Floor strikes are pooled: update() triggers these prebuilt nodes on the
    // rising edge instead of allocating a one-shot under heavy kerb load.
    this.bottomOsc = ctx.createOscillator();
    this.bottomOsc.type = 'square';
    this.bottomOsc.frequency.value = 68;
    this.bottomGain = this._gainNode(0, this.engineOut);
    this.bottomOsc.connect(this.bottomGain);
    this.bottomOsc.start();
    this.bottomBP = this._filter('bandpass', 510, 1.1, null);
    this.bottomNoiseGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.bottomBP);
    this.bottomBP.connect(this.bottomNoiseGain);

    // Kerb rumble: low square whose rate tracks speed + a wooden noise rattle.
    // Chest sub-bass: pure sine under everything (bypasses formant/LP so the
    // low end survives). The physical "feel it in your chest" component.
    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.subOsc.frequency.value = 46;
    this.subGain = this._gainNode(0, this.engineDuck);
    this.subOsc.connect(this.subGain);
    this.subOsc.start();

    this.kerbOsc = ctx.createOscillator();
    this.kerbOsc.type = 'square';
    this.kerbOsc.frequency.value = 28;
    this.kerbGain = this._gainNode(0, this.engineOut);
    this.kerbOsc.connect(this.kerbGain);
    this.kerbOsc.start();
    this.kerbBP = this._filter('bandpass', 240, 1.2, null);
    this.kerbNoiseGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.kerbBP);
    this.kerbBP.connect(this.kerbNoiseGain);

    // Pooled shift voices: a square "cut" blip for upshifts and a saw rev-match
    // blip for downshifts, so a gear change allocates nothing at all.
    this.blipUpGain = this._gainNode(0, this.engineOut);
    this.blipUp = ctx.createOscillator();
    this.blipUp.type = 'square';
    this.blipUp.frequency.value = 400;
    this.blipUp.connect(this.blipUpGain);
    this.blipUp.start();

    this.blipDnGain = this._gainNode(0, this.engineOut);
    this.blipDn = ctx.createOscillator();
    this.blipDn.type = 'sawtooth';
    this.blipDn.frequency.value = 400;
    this.blipDn.connect(this.blipDnGain);
    this.blipDn.start();

    // Pit wheel-gun: pooled metallic band driven by scheduled rattle trains.
    this.gunBP = this._filter('bandpass', 1600, 3.2, null);
    this.gunGain = this._gainNode(0, this.master);
    this._noiseSrc.connect(this.gunBP);
    this.gunBP.connect(this.gunGain);

    // Four preallocated opponent voices is enough to communicate the cars that
    // matter around the player while placing a hard ceiling on WebAudio load.
    for (let i = 0; i < OPPONENT_VOICE_BUDGET; i++) {
      const out = this._gainNode(1, this.master);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.connect(out);
      const dest = pan || out;
      const airBP = this._filter('bandpass', 1800, 0.78, null);
      const airGain = this._gainNode(0, dest);
      this._noiseSrc.connect(airBP);
      airBP.connect(airGain);
      const engine = ctx.createOscillator();
      engine.type = 'sawtooth';
      engine.frequency.value = 360;
      const engineBP = this._filter('bandpass', 720, 2.1, null);
      const engineGain = this._gainNode(0, dest);
      engine.connect(engineBP);
      engineBP.connect(engineGain);
      engine.start();
      this._opponentVoices.push({
        id: null, activeUntil: 0, out, pan, airBP, airGain,
        engine, engineBP, engineGain,
      });
    }

    this._noiseSrc.start();

    // Race-engineer radio bus: band-limited comms EQ for radioTone().
    this.radioLP = this._filter('lowpass', 2700, 0.8, this.master);
    this.radioHP = this._filter('highpass', 520, 0.9, this.radioLP);

    // ---- crowd bed (source started lazily on first crowdAmbience call) ----
    this.crowdSrc = ctx.createBufferSource();
    this.crowdSrc.buffer = this._crowdBuffer;
    this.crowdSrc.loop = true;
    this.crowdPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.crowdPan) this.crowdPan.connect(this.master);
    this.crowdGain = this._gainNode(0, this.crowdPan || this.master);
    this.crowdLP = this._filter('lowpass', 950, 0.7, this.crowdGain);
    this.crowdHP = this._filter('highpass', 170, 0.7, this.crowdLP);
    this.crowdSrc.connect(this.crowdHP);
    // Two incommensurate slow LFOs sum into the bed gain = non-periodic cheering
    // swells with zero timers and zero allocation.
    this.crowdSwell = this._lfo('sine', 0.091, 0, this.crowdGain.gain);
    this.crowdSwell2 = this._lfo('triangle', 0.037, 0, this.crowdGain.gain);
    if (this.crowdPan) this._lfo('sine', 0.053, 0.45, this.crowdPan.pan);

    this._ready = true;
  }

  setVolume(v) {
    this._volume = clamp01(v);
    if (!this.ready) return;
    if (!this._muted) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.03);
    }
  }

  setMuted(m) {
    this._muted = !!m;
    if (!this.ready) return;
    const target = this._muted ? 0 : this._volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  // Per-frame update. s = { rpmFrac, throttle, speed, slip, kerb, boost, offtrack }
  // Optional extra: s.gear (1..8) for exact per-gear timbre; estimated if absent.
  // Allocates nothing.
  update(dt, s) {
    // ---- sampled engine crossfade ----
    if (this._eng && s) {
      const rpm = Math.max(0, Math.min(1, s.rpmFrac || 0));
      const thr = Math.max(0, Math.min(1, s.throttle || 0));
      const t0 = this.ctx.currentTime;
      const moving = (s.speed || 0) > 4;
      const coast = thr < 0.12 && moving;
      // equal-power band weights
      for (const l of this._eng.layers) {
        const x = Math.max(0, 1 - Math.abs(rpm - l.center) / l.width);
        const w = Math.sin(x * Math.PI / 2);
        const drive = 0.32 + 0.68 * thr;
        const gain = (coast ? 0.25 : 1) * w * drive * 0.5;
        l.g.gain.setTargetAtTime(gain, t0, 0.045);
        // pitch-track: each layer bends toward the live rpm around its center
        const rate = Math.max(0.62, Math.min(1.6, 0.92 + (rpm - l.center) * 0.75));
        l.src.playbackRate.setTargetAtTime(rate, t0, 0.05);
      }
      if (this._eng.overrun) {
        const og = coast && rpm > 0.25 ? 0.4 * Math.min(1, rpm * 1.4) : 0;
        this._eng.overrun.g.gain.setTargetAtTime(og, t0, 0.06);
        this._eng.overrun.src.playbackRate.setTargetAtTime(0.9 + rpm * 0.3, t0, 0.08);
      }
    }
    // ---- sample-pack surface layers (gain-gated loops; synth continues under) ----
    if (this._samples) {
      const t0 = this.ctx.currentTime;
      const kg = this._sampleLoop('kerb-rumble');
      if (kg) kg.gain.setTargetAtTime(s && s.kerb ? 0.32 : 0, t0, s && s.kerb ? 0.05 : 0.12);
      const gg = this._sampleLoop('gravel');
      if (gg) gg.gain.setTargetAtTime(s && s.offtrack ? 0.4 : 0, t0, s && s.offtrack ? 0.08 : 0.15);
      // ---- trackside atmosphere (race only: follows the crowd level) ----
      const amb = this._crowdLevel || 0;
      this._ambT = (this._ambT || 0) + dt;
      const pa = this._sampleLoop('pa-announcer');
      if (pa) {
        // announcer swells every ~20s, silent when there is no crowd
        const swell = amb > 0 ? (Math.sin(this._ambT * 0.31) > 0.55 ? 0.16 : 0.05) : 0;
        pa.gain.setTargetAtTime(swell, t0, 1.2);
      }
      const heli = this._sampleLoop('helicopter');
      if (heli) {
        const drift = amb > 0 ? Math.max(0, Math.sin(this._ambT * 0.045 + 1.3)) * 0.14 : 0;
        heli.gain.setTargetAtTime(drift, t0, 2.0);
      }
      this._hornCool = Math.max(0, (this._hornCool ?? 20) - dt);
      if (amb > 0.2 && this._hornCool <= 0) {
        this._hornCool = 24 + (this._ambT % 37);
        this._playSample('air-horn', { gain: 0.14, jitter: 0.12 });
      }
      // heavy-braking moan (rare, deep)
      this._brakeCool = Math.max(0, (this._brakeCool || 0) - dt);
      if (s && s.brake > 0.85 && s.speed > 46 && this._brakeCool <= 0) {
        this._brakeCool = 9;
        this._playSample('brake-screech', { gain: 0.24, rate: 0.9, jitter: 0.08 });
      }
      this._screechCool = Math.max(0, (this._screechCool || 0) - dt);
      // screech only on sustained hard slip, rarely, pitched down for weight
      this._slipT = s && s.slip ? (this._slipT || 0) + dt : 0;
      if (this._slipT > 0.55 && s.speed > 26 && this._screechCool <= 0) {
        this._screechCool = 6;
        this._playSample('tyre-screech', { gain: 0.3, rate: 0.85, jitter: 0.06 });
      }
    }
    if (!this.ready) return;
    s = s || EMPTY;
    const t = this.ctx.currentTime;
    const step = Number.isFinite(dt) && dt > 0 ? (dt > 0.1 ? 0.1 : dt) : 1 / 60;
    const targets = deriveAudioTargets(s, this._audioTargets);
    this._rpm = smoothTelemetry(this._rpm, targets.rpm, step, 14, 9);
    this._thr = smoothTelemetry(this._thr, targets.throttle, step, 12, 7);
    this._load = smoothTelemetry(this._load, targets.load, step, 9, 4.5);
    this._slip = smoothTelemetry(this._slip, targets.slip, step, 16, 6);
    this._lockup = smoothTelemetry(this._lockup, targets.lockup, step, 18, 7);
    this._wetness = smoothTelemetry(this._wetness, targets.wetness, step, 2.5, 1.4);
    this._damage = smoothTelemetry(this._damage, targets.damage, step, 4, 1.5);
    const rpm = this._rpm;
    const thr = this._thr;
    const speed = targets.speed;
    this._speed = speed;

    // Smoothed longitudinal acceleration — lets shift() infer up vs down when the
    // caller does not pass a direction (accelerating = upshift, braking = down).
    const rawAccel = (speed - this._prevSpeed) / step;
    this._accel += (rawAccel - this._accel) * Math.min(1, step * 8);
    this._prevSpeed = speed;

    // ---- decay the shift envelopes (pitch bend + ignition cut) ----
    this._shiftEnv *= Math.exp(-step / 0.075);
    if (this._shiftEnv < 1e-4) this._shiftEnv = 0;
    this._cutEnv *= Math.exp(-step / 0.03);
    if (this._cutEnv < 1e-4) this._cutEnv = 0;

    const gear = this._resolveGear(s.gear, speed, rpm, step);

    // ---- harmonic stack ----------------------------------------------------
    // Higher-pitched than the old V8-ish map (105..745 Hz fundamental), with the
    // 2nd/3rd harmonics carrying the top end for the turbo-hybrid scream.
    const f = 105 + rpm * 640;
    // Upshift = momentary pitch drop, downshift = rev-match blip upward.
    const bend = 1 + this._shiftEnv * (this._shiftDir > 0 ? -0.13 : 0.1);
    const ff = f * bend;
    this.saw1.frequency.setTargetAtTime(ff, t, 0.018);
    this.saw2.frequency.setTargetAtTime(ff * 1.014, t, 0.018);
    this.h2.frequency.setTargetAtTime(ff * 2, t, 0.02);
    this.h3.frequency.setTargetAtTime(ff * 3.02, t, 0.02);
    this.sq.frequency.setTargetAtTime(ff * 0.5, t, 0.02);
    this.firingOsc.frequency.setTargetAtTime(52 + ff * 0.42, t, 0.026);
    this.firingBP.frequency.setTargetAtTime(145 + rpm * 260, t, 0.045);
    this.firingGain.gain.setTargetAtTime((0.018 + this._load * 0.055) * (1 - rpm * 0.35), t, 0.055);

    // Independent harmonic gains: fundamental/sub recede as the harmonics bloom,
    // and the total stays ~constant (0.61 idle -> 0.64 flat out) so the balance
    // morphs without the overall level jumping into the limiter.
    const rpm2 = rpm * rpm;
    const h1g = 0.26 - 0.09 * rpm;
    this.g1.gain.setTargetAtTime(h1g * 0.56, t, 0.05);
    this.g2.gain.setTargetAtTime(h1g * 0.44, t, 0.05);
    // Harmonic oscillators thicken the low revs, but at high rpm their pure
    // tones sit at 1.4-2.1 kHz and read as a metallic whistle over the sample
    // bed — taper them out as rpm rises and let the samples carry the top.
    this.gh2.gain.setTargetAtTime((0.07 + 0.10 * rpm) * (1 - 0.65 * rpm), t, 0.05);
    this.gh3.gain.setTargetAtTime((0.02 + 0.08 * rpm2) * (1 - 0.8 * rpm), t, 0.05);
    this.g3.gain.setTargetAtTime(0.26 - 0.14 * rpm, t, 0.05);

    // Per-gear formant: steps ~105 Hz per ratio, glided so it never chatters.
    this.formant.frequency.setTargetAtTime(470 + gear * 105, t, 0.09);

    // Body / brightness. Offtrack squashes the cutoff (muffled).
    let cutoff = 430 + rpm * 5200 + this._load * 900;
    if (s.offtrack) cutoff = Math.min(cutoff, 450 + rpm * 500);
    this.engineLP.frequency.setTargetAtTime(cutoff, t, 0.035);
    this.perspectiveLP.frequency.setTargetAtTime(
      targets.cockpit ? 4200 + speed * 18 : 10500 + rpm * 5500,
      t,
      0.12,
    );
    this.perspectiveBody.frequency.setTargetAtTime(260 + speed * 1.3, t, 0.12);
    this.perspectiveBody.gain.setTargetAtTime(targets.cockpit ? 4.2 : 0, t, 0.16);

    // Loudness follows throttle with an idle floor; the shift cut dips it.
    // When the sampled engine is active it carries the voice — the synth drops
    // to a bed that masks loop seams and keeps continuous pitch precision.
    const load = (0.25 + 0.75 * this._load) * (1 - 0.5 * this._cutEnv);
    const bed = this._eng ? (this._synthBedScale || 0.42) : 1;
    this.engineGain.gain.setTargetAtTime(load * 0.5 * bed, t, 0.04);
    // sub-bass follows rpm/throttle; strongest under full load at high revs
    this.subOsc.frequency.setTargetAtTime(40 + rpm * 42, t, 0.05);
    this.subGain.gain.setTargetAtTime((0.05 + 0.16 * thr) * (0.35 + 0.65 * rpm), t, 0.06);

    // ---- induction + turbo -------------------------------------------------
    this.hissBP.frequency.setTargetAtTime(700 + rpm * 2400, t, 0.05);
    this.hissGain.gain.setTargetAtTime(thr * 0.1, t, 0.06);

    // Spool lags the throttle demand (~0.3 s) so lifts and stabs breathe.
    const spoolTarget = thr * (0.35 + 0.65 * rpm);
    const kSpool = Math.min(1, step * 3.2);
    this._spool += (spoolTarget - this._spool) * kSpool;
    const spool = this._spool;
    const whistle = 1450 + spool * 2500 + rpm * 900;
    this.turboBP.frequency.setTargetAtTime(whistle, t, 0.05);
    this.turboOsc.frequency.setTargetAtTime(whistle, t, 0.06);
    const spoolLvl = spool * spool;
    this.turboNoiseGain.gain.setTargetAtTime(spoolLvl * 0.075, t, 0.07);
    // Pure-sine spool tone reads as a kettle whistle over the samples — keep it
    // out of the mix entirely; the bandpassed noise above carries the spool.
    this.turboToneGain.gain.setTargetAtTime(0, t, 0.07);

    // Wastegate flutter + overrun crackle on a high-rpm throttle lift.
    this._wgCooldown = Math.max(0, this._wgCooldown - step);
    const lift = this._prevThr - thr;
    if (lift > 0.28 && rpm > 0.5 && this._wgCooldown === 0) {
      this._wgCooldown = 0.4;
      const i = Math.min(1, lift * 1.3) * (0.4 + 0.6 * rpm);
      this._wastegate(t, i);
      if (rpm > 0.7) this._crackle(t + 0.04, 0.5 * i, 4);
    }
    this._prevThr = thr;

    // ---- MGU-K ------------------------------------------------------------
    const mgukF = 1150 + rpm * 2350;
    this.mgukOsc.frequency.setTargetAtTime(mgukF, t, 0.05);
    this.mgukOsc2.frequency.setTargetAtTime(mgukF * 2 + 7, t, 0.05);
    this.mgukBP.frequency.setTargetAtTime(mgukF * 1.15, t, 0.06);
    // Present under everything; louder on deploy, and on regen (off throttle,
    // still travelling) which is the sound the 2026 cars are known for.
    const regen = targets.regen * 0.026;
    const mguk = 0.01 + 0.008 * rpm + targets.boost * 0.035 + regen;
    this.mgukGain.gain.setTargetAtTime(mguk, t, 0.07);
    this.boostBP.frequency.setTargetAtTime(3600 + rpm * 1800, t, 0.05);
    this.boostGain.gain.setTargetAtTime(targets.boost * 0.055, t, 0.05);

    // ---- transmission whine (low gears, on power) --------------------------
    const lowGear = gear < 4 ? (4 - gear) / 3 : 0;
    const transF = f * 3.1 + 140 * lowGear;
    this.transOsc.frequency.setTargetAtTime(transF, t, 0.04);
    this.transBP.frequency.setTargetAtTime(transF, t, 0.05);
    this.transGain.gain.setTargetAtTime((0.004 + lowGear * 0.022) * this._load, t, 0.06);
    const meshF = ff * (2.15 + gear * 0.19);
    this.meshOsc.frequency.setTargetAtTime(meshF, t, 0.035);
    this.meshBP.frequency.setTargetAtTime(meshF * 1.04, t, 0.055);
    this.meshGain.gain.setTargetAtTime((0.006 + (9 - gear) * 0.0015) *
      (0.3 + this._load * 0.7), t, 0.07);

    // ---- wind (speed^2) ---------------------------------------------------
    const sp = speed / 82;
    this.windBP.frequency.setTargetAtTime(420 + speed * (targets.cockpit ? 10 : 17), t, 0.08);
    this.windGain.gain.setTargetAtTime(Math.min(0.15, sp * sp *
      (targets.cockpit ? 0.105 : 0.16)), t, 0.1);

    // ---- surfaces ---------------------------------------------------------
    const kerbRate = 18 + Math.min(speed, 62) * 0.55;
    this.kerbOsc.frequency.setTargetAtTime(kerbRate, t, 0.05);
    this.kerbGain.gain.setTargetAtTime(targets.kerb * 0.18, t, targets.kerb ? 0.025 : 0.08);
    this.kerbNoiseGain.gain.setTargetAtTime(targets.kerb * 0.085, t, targets.kerb ? 0.025 : 0.09);

    const gravel = s.offtrack ? Math.min(1, speed / 45) * 0.17 : 0;
    this.gravelGain.gain.setTargetAtTime(gravel, t, 0.05);

    const rolling = clamp01(speed / 58);
    this.roadBP.frequency.setTargetAtTime(260 + speed * 9 + targets.roughness * 480, t, 0.07);
    this.roadGain.gain.setTargetAtTime(targets.roughness * rolling * 0.075, t, 0.075);

    // Continuous scrub is more useful for held arrow-key steering than repeated
    // bursts: intensity and pitch tell the player how close the tyre is to giving up.
    this.scrubBP.frequency.setTargetAtTime(680 + speed * 11 + this._slip * 520, t, 0.045);
    this.scrubGain.gain.setTargetAtTime(this._slip * rolling * (0.045 + targets.roughness * 0.04), t, 0.055);
    this.lockOsc.frequency.setTargetAtTime(1120 + speed * 8, t, 0.045);
    this.lockBP.frequency.setTargetAtTime(1250 + speed * 10, t, 0.05);
    this.lockGain.gain.setTargetAtTime(this._lockup * rolling * 0.055, t, 0.04);
    this.lockNoiseBP.frequency.setTargetAtTime(1500 + speed * 13, t, 0.05);
    this.lockNoiseGain.gain.setTargetAtTime(this._lockup * rolling * 0.09, t, 0.045);

    this.rainHP.frequency.setTargetAtTime(2700 + targets.rain * 1700, t, 0.12);
    this.rainGain.gain.setTargetAtTime(targets.rain * (targets.cockpit ? 0.024 : 0.045), t, 0.25);
    this.sprayBP.frequency.setTargetAtTime(900 + speed * 15, t, 0.1);
    this.sprayGain.gain.setTargetAtTime(Math.max(targets.spray, this._wetness * rolling) *
      rolling * (targets.cockpit ? 0.05 : 0.08), t, 0.12);

    this.damageBP.frequency.setTargetAtTime(560 + gear * 48 + speed * 2, t, 0.08);
    this.damageGain.gain.setTargetAtTime(this._damage * rolling * 0.035, t, 0.12);
    this.damageFlutter.gain.setTargetAtTime(this._damage * rolling * 0.018, t, 0.12);

    this._bottomCooldown = Math.max(0, this._bottomCooldown - step);
    if (targets.bottoming > 0.15 && this._bottoming <= 0.15 && this._bottomCooldown === 0) {
      this._bottomCooldown = 0.14;
      this._bottomStrike(t, targets.bottoming * (0.35 + rolling * 0.65));
    }
    this._bottoming = targets.bottoming;

    const wallScrape = clamp01(s.wallScrape);
    const carScrape = clamp01(s.carScrape);
    const scrapeLevel = Math.max(wallScrape * 0.2, carScrape * 0.12);
    const scrapeOn = scrapeLevel > 0.001;
    this.contactScrapeBP.frequency.setTargetAtTime(
      wallScrape >= carScrape ? 720 + speed * 5 : 1180 + speed * 4,
      t,
      0.035,
    );
    this.contactScrapeBP.Q.setTargetAtTime(wallScrape >= carScrape ? 0.72 : 1.1, t, 0.04);
    this.contactScrapeGain.gain.setTargetAtTime(scrapeLevel, t, scrapeOn ? 0.035 : 0.1);
    if (this.contactScrapePan) {
      this.contactScrapePan.pan.setTargetAtTime(clampNum(s.contactSide, -1, 1) * 0.7, t, 0.04);
    }
    if (s.opponents) this.updateOpponents(s.opponents);
    else this._releaseOpponentVoices(t);
    this._wallImpactCooldown = Math.max(0, this._wallImpactCooldown - step);
    this._carImpactCooldown = Math.max(0, this._carImpactCooldown - step);
  }

  // Gear-shift. dir > 0 (default) = upshift, dir < 0 = downshift.
  // shift() with no argument still works: the direction is inferred from load.
  shift(dir) {
    if (dir < 0) this._playSample('downshift-crackle', { gain: 0.42, rate: 0.95, jitter: 0.08 });
    else this._playSample('gear-shift', { gain: 0.22, rate: 0.88, jitter: 0.04 });

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    let d;
    if (Number.isFinite(+dir) && +dir !== 0) {
      d = +dir > 0 ? 1 : -1;
    } else if (this._accel > 0.35) {
      d = 1; // pulling away -> upshift
    } else if (this._accel < -0.35) {
      d = -1; // braking -> downshift
    } else {
      d = this._rpm > 0.62 ? 1 : -1; // coasting: fall back to where the revs are
    }

    this._shiftDir = d;
    this._shiftEnv = 1; // drives the pitch bend applied in update()
    this._gear = clampNum(this._gear + d, 1, 8);
    this._gearCand = this._gear;
    this._gearCandT = 0;

    const f = 105 + this._rpm * 640;
    if (d > 0) {
      // Upshift: sharp ignition-cut click, brief torque cut, pitch pops down.
      this._cutEnv = 1;
      this._blip(t, 2600, 1.1, 0.16, 0.022);
      const p = this.blipUp.frequency;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(f * 2, t, 0.004);
      p.setTargetAtTime(f * 1.3, t + 0.012, 0.028);
      const g = this.blipUpGain.gain;
      g.cancelScheduledValues(t);
      this._pulse(g, t, 0.09, 0.005, 0.022, 0.026);
    } else {
      // Downshift: rev-match blip (pitch rises) plus overrun crackle.
      this._cutEnv = 0.45;
      this._blip(t, 1500, 0.9, 0.1, 0.03);
      const p = this.blipDn.frequency;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(f * 1.55, t, 0.004);
      p.setTargetAtTime(f * 2.3, t + 0.015, 0.045);
      const g = this.blipDnGain.gain;
      g.cancelScheduledValues(t);
      this._pulse(g, t, 0.085, 0.006, 0.055, 0.04);
      this._crackle(t + 0.03, 0.85, 7);
    }
  }

  wallImpact(event) {
    const payload = typeof event === 'number' ? { intensity: event } : (event || EMPTY);
    const i = clamp01(payload.intensity == null ? 1 : payload.intensity);
    const normal = clamp01((Number(payload.normalSpeed) || 0) / 55);
    const severity = Math.max(i, normal);
    const side = clampNum(payload.side, -1, 1);
    if (i <= 0 || this._wallImpactCooldown > 0) return;
    this._wallImpactCooldown = 0.09;
    if (this._playSample('collision', {
      gain: Math.min(0.66, 0.22 + severity * 0.44), rate: 0.88 - normal * 0.12, jitter: 0.05, duck: 0.3, pan: side * 0.72,
    })) return;
    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 0.22, 0.62);
    this._toneShot({ type: 'sine', freq: 120 - normal * 38, endFreq: 34, peak: 0.25 * severity + 0.05, dur: 0.25 + normal * 0.1, decay: 0.08 + normal * 0.03, pan: side * 0.55 });
    this._noiseShot({ dur: 0.17 + normal * 0.07, type: 'bandpass', freq: 1300 + severity * 900, q: 0.7, peak: 0.17 * severity + 0.04, decay: 0.045, pan: side * 0.82 });
    this._noiseShot({ dur: 0.2 + normal * 0.08, type: 'highpass', freq: 2600, q: 0.55, peak: 0.075 * severity + 0.015, decay: 0.07, delay: 0.012, pan: side * 0.65 });
  }

  carImpact(event) {
    const payload = typeof event === 'number' ? { intensity: event } : (event || EMPTY);
    const i = clamp01(payload.intensity == null ? 0.4 : payload.intensity);
    const closing = clamp01((Number(payload.closingSpeed) || 0) / 32);
    const severity = Math.max(i, closing);
    const side = clampNum(payload.side, -1, 1);
    if (i <= 0 || this._carImpactCooldown > 0) return;
    this._carImpactCooldown = 0.08;
    if (this._playSample('collision', {
      gain: Math.min(0.48, 0.15 + severity * 0.33), rate: 1.1 - closing * 0.12, jitter: 0.055, duck: 0.16, pan: side * 0.68,
    })) return;
    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 0.15, 0.4);
    this._toneShot({ type: 'triangle', freq: 225 - closing * 55, endFreq: 78, peak: 0.16 * severity + 0.035, dur: 0.16 + closing * 0.07, decay: 0.055, pan: side * 0.55 });
    this._noiseShot({ dur: 0.14 + closing * 0.07, type: 'bandpass', freq: 1850 + severity * 700, q: 0.9, peak: 0.13 * severity + 0.025, decay: 0.045, pan: side * 0.78 });
  }

  // Backwards-compatible hook used by older tooling/sample auditions.
  collision(intensity) {
    this.wallImpact(intensity);
  }

  countdownBeep(final) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, final ? 0.5 : 0.2, 1);
    if (final) {
      this._stopCrescendo(0.3); // lights out: release the tension pad
      this._toneShot({ type: 'sine', freq: 880, peak: 0.25, dur: 0.65, decay: 0.22, sustain: 0.3 });
      this._toneShot({ type: 'sine', freq: 146.8, peak: 0.16, dur: 0.5, decay: 0.16 });
    } else {
      this._toneShot({ type: 'sine', freq: 440, peak: 0.22, dur: 0.18, decay: 0.05, sustain: 0.06 });
    }
  }

  uiClick() {
    if (!this.ready) return;
    this._toneShot({ type: 'sine', freq: 1350, peak: 0.1, dur: 0.05, decay: 0.014 });
  }

  uiConfirm() {
    if (!this.ready) return;
    this._toneShot({ type: 'sine', freq: 660, peak: 0.12, dur: 0.12, decay: 0.04 });
    this._toneShot({ type: 'sine', freq: 990, peak: 0.12, dur: 0.16, decay: 0.05, delay: 0.09 });
  }

  finishFanfare() {
    this._playSample('finish-cheer', { gain: 0.85 });

    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 1.2, 1);
    const notes0 = 523.25, notes1 = 659.25, notes2 = 783.99, notes3 = 1046.5; // C major stack
    for (let k = 0; k < 4; k++) {
      const n = k === 0 ? notes0 : k === 1 ? notes1 : k === 2 ? notes2 : notes3;
      this._toneShot({
        type: 'triangle',
        freq: n,
        peak: 0.13,
        dur: 1.1,
        decay: 0.3,
        sustain: 0.15,
        delay: k * 0.07,
      });
      this._toneShot({
        type: 'sawtooth',
        freq: n * 0.5,
        peak: 0.04,
        dur: 1.1,
        decay: 0.3,
        sustain: 0.15,
        delay: k * 0.07,
      });
    }
  }

  stopEngine() {
    if (!this.ready) return;
    this.engineOut.gain.setTargetAtTime(0, this.ctx.currentTime, 0.14);
  }

  startEngine() {
    if (!this.ready) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    this.engineDuck.gain.setTargetAtTime(1, t, 0.05);
    this.engineOut.gain.setTargetAtTime(1, t, 0.2);
  }

  // ---- added one-shots / beds -------------------------------------------

  // Pit stop: four wheel-gun rattle bursts (off, off, on, on) then the car drop.
  // Total span ~2.2 s. Uses the pooled gun chain -> no node churn.
  // ==== ElevenLabs sample pack (optional layer; synthesis is the fallback) ====
  // Loads MP3 samples; each play falls back to the synthesized version when a
  // buffer is missing or still loading. Loops (crowd/kerb/gravel) are started
  // once and gain-gated.
  async loadSamplePack(base = 'sounds/') {
    this._samples = this._samples || {};
    const names = ['crowd-ambience', 'wheel-gun', 'gear-shift', 'collision',
      'kerb-rumble', 'gravel', 'radio-squelch', 'tyre-screech', 'finish-cheer',
      'engine-low', 'engine-mid', 'engine-high', 'engine-overrun',
      'downshift-crackle', 'pa-announcer', 'helicopter', 'air-horn', 'brake-screech', 'passby-whoosh'];
    await Promise.allSettled(names.map(async (n) => {
      try {
        const res = await fetch(base + n + '.mp3');
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        // decode needs a context; defer decode until init() ran
        this._samplesRaw = this._samplesRaw || {};
        this._samplesRaw[n] = buf;
        if (this.ready) {
          this._samples[n] = await this.ctx.decodeAudioData(buf.slice(0));
          this._buildEngineSampler();
        }
      } catch { /* fallback synthesis covers it */ }
    }));
  }

  _decodePending() {
    if (!this.ready || !this._samplesRaw) return;
    const raw = this._samplesRaw;
    this._samplesRaw = null;
    for (const [n, buf] of Object.entries(raw)) {
      this.ctx.decodeAudioData(buf.slice(0)).then(b => { this._samples[n] = b; this._buildEngineSampler(); }).catch(() => {});
    }
  }

  // ==== sampled engine: RPM-banded loop crossfade over the synth bed ========
  // Three steady-state loops (low/mid/high) crossfaded by rpm with equal-power
  // weights and per-layer pitch tracking, plus an overrun loop that takes over
  // on closed throttle at speed. Routed into engineOut so ducking and the
  // off-track muffle chain apply. The synth engine stays underneath at reduced
  // gain to mask loop seams and carry precise continuous pitch.
  _buildEngineSampler() {
    if (this._eng || !this.ready || !this._samples) return;
    const have = ['engine-low', 'engine-mid', 'engine-high'].every(n => this._samples[n]);
    if (!have) return;
    const mk = (name) => {
      const srcN = this.ctx.createBufferSource();
      srcN.buffer = this._samples[name];
      srcN.loop = true;
      // trim loop points inward to dodge generation fade-in/outs
      const d = srcN.buffer.duration;
      srcN.loopStart = Math.min(0.4, d * 0.08);
      srcN.loopEnd = Math.max(d - 0.4, d * 0.92);
      const g = this.ctx.createGain();
      g.gain.value = 0;
      srcN.connect(g);
      return { src: srcN, g };
    };
    const warm = this.ctx.createBiquadFilter();
    warm.type = 'lowshelf'; warm.frequency.value = 160; warm.gain.value = 4;
    warm.connect(this.engineOut);
    this._engWarm = warm;
    this._eng = {
      layers: [
        { ...mk('engine-low'), center: 0.12, width: 0.34 },
        { ...mk('engine-mid'), center: 0.52, width: 0.36 },
        { ...mk('engine-high'), center: 0.9, width: 0.4 },
      ],
      overrun: this._samples['engine-overrun'] ? mk('engine-overrun') : null,
    };
    for (const l of this._eng.layers) { l.g.connect(warm); l.src.start(); }
    if (this._eng.overrun) { this._eng.overrun.g.connect(warm); this._eng.overrun.src.start(); }
    // samples carry the voice: pull the synth engine down to a bed
    this._synthBedScale = 0.42;
  }

  _sampleBus() {
    if (this._sampleBusNode || !this.ready) return this._sampleBusNode;
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 5;
    const high = this.ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 5200; high.gain.value = -5;
    low.connect(high).connect(this.master);
    this._sampleBusNode = low;
    return low;
  }

  _sample(name) { return (this._samples && this._samples[name]) || null; }

  /** Play a one-shot sample. Returns true if a sample was played. */
  _playSample(name, { gain = 1, rate = 1, jitter = 0, duck = 0, pan = 0 } = {}) {
    const buf = this._sample(name);
    if (!buf || !this.ready) return false;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 2 * jitter);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const panner = this.ctx.createStereoPanner && Math.abs(pan) > 1e-4
      ? this.ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clampNum(pan, -1, 1);
      src.connect(g).connect(panner).connect(this._sampleBus() || this.master);
    } else src.connect(g).connect(this._sampleBus() || this.master);
    if (duck) this._duck(t, duck, 1);
    src.start(t);
    src.onended = () => { try { src.disconnect(); g.disconnect(); panner?.disconnect(); } catch {} };
    return true;
  }

  /** Persistent looping sample gated by a gain node. Returns the gain or null. */
  _sampleLoop(name, target) {
    this._loops = this._loops || {};
    if (this._loops[name]) return this._loops[name];
    const buf = this._sample(name);
    if (!buf || !this.ready) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = name === 'kerb-rumble' ? 0.78 : name === 'gravel' ? 0.88 : 1;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(target || this._sampleBus() || this.master);
    src.start();
    this._loops[name] = g;
    return g;
  }

  /**
   * Close pass cue. Legacy passBy(side, intensity) and richer object payloads
   * both work: { id, side, intensity, distance, relativeSpeed, rpmFrac }.
   */
  passBy(side = 0, intensity = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const cue = normalizeOpponentCue(side, intensity, this._opponentCue);
    const prior = this._opponentCooldowns.get(cue.id);
    if (prior != null && now - prior < (cue.id === 'anonymous' ? 1.15 : 0.75)) return;
    if (this._opponentCooldowns.size >= 24 && !this._opponentCooldowns.has(cue.id)) {
      this._opponentCooldowns.delete(this._opponentCooldowns.keys().next().value);
    }
    this._opponentCooldowns.set(cue.id, now);
    this._lastPass = now || Number.EPSILON;
    const voice = this._acquireOpponentVoice(cue.id, now);
    if (!voice) return; // hard voice budget: never allocate around a busy player
    this._schedulePassVoice(voice, cue, now);

    // The generated pack remains an optional sweetener. It shares the same
    // budget/cooldown decision and synthesis still provides the no-network cue.
    this._playSample('passby-whoosh', {
      gain: cue.intensity * 0.2,
      rate: 0.92 + Math.min(0.16, Math.abs(cue.relativeSpeed) / 250),
      jitter: 0.035,
      pan: cue.side * 0.76,
    });
  }

  /**
   * Optional continuous proximity API. Call with at most the nearby cars; the
   * closest/first four receive stable spatial engine voices.
   */
  updateOpponents(opponents) {
    if (!this.ready || !opponents || typeof opponents.length !== 'number') return;
    const now = this.ctx.currentTime;
    const limit = Math.min(opponents.length, OPPONENT_VOICE_BUDGET);
    for (let i = 0; i < limit; i++) {
      const cue = normalizeOpponentCue(opponents[i], 1, this._opponentCue);
      let voice = null;
      for (let v = 0; v < this._opponentVoices.length; v++) {
        if (this._opponentVoices[v].id === cue.id) {
          voice = this._opponentVoices[v];
          break;
        }
      }
      if (!voice) voice = this._acquireOpponentVoice(cue.id, now);
      if (!voice) continue;
      voice.activeUntil = now + 0.16;
      const proximity = cue.intensity / (1 + cue.distance * 0.07);
      const doppler = 1 + clampNum(cue.relativeSpeed / 340, -0.16, 0.16);
      const f = (150 + cue.rpm * 470) * doppler;
      voice.engine.frequency.setTargetAtTime(f, now, 0.045);
      voice.engineBP.frequency.setTargetAtTime(f * 2.05, now, 0.06);
      voice.engineGain.gain.setTargetAtTime(proximity * 0.026, now, 0.07);
      voice.airBP.frequency.setTargetAtTime(900 + Math.abs(cue.relativeSpeed) * 28, now, 0.08);
      voice.airGain.gain.setTargetAtTime(proximity * Math.min(0.05,
        Math.abs(cue.relativeSpeed) / 700), now, 0.07);
      voice.pan?.pan.setTargetAtTime(cue.side * 0.82, now, 0.055);
    }
    this._releaseOpponentVoices(now);
  }

  pitStop() {
    if (this._playSample('wheel-gun', { gain: 0.8, rate: 0.94, jitter: 0.03, duck: 2.2 })) return;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 2.2, 0.8);
    const g = this.gunGain.gain;
    g.cancelScheduledValues(t);
    for (let b = 0; b < 4; b++) {
      const t0 = t + 0.1 + b * 0.5;
      this.gunBP.frequency.setTargetAtTime(1450 + b * 230, t0, 0.02);
      const n = b % 2 === 0 ? 11 : 8; // undo bursts are longer than the do-ups
      for (let i = 0; i < n; i++) {
        const tp = t0 + i * 0.027;
        g.setTargetAtTime(0.2, tp, 0.003);
        g.setTargetAtTime(0.0001, tp + 0.009, 0.008);
      }
    }
    // Jack drop: dull clunk + suspension rattle at ~2.0 s.
    this._toneShot({ type: 'sine', freq: 96, endFreq: 42, peak: 0.5, dur: 0.34, decay: 0.1, delay: 2.0 });
    this._noiseShot({ dur: 0.28, type: 'lowpass', freq: 380, q: 0.8, peak: 0.3, decay: 0.07, delay: 2.0 });
    this._noiseShot({ dur: 0.2, type: 'bandpass', freq: 2500, q: 1.4, peak: 0.11, decay: 0.045, delay: 2.02 });
  }

  // Distant crowd bed with slow cheering swells. level 0..1, 0 fades it out.
  crowdAmbience(level) {
    if (!this.ready) return;
    const l = clamp01(level == null ? 0.6 : level);
    this._crowdLevel = l;
    const t = this.ctx.currentTime;
    // photographic-quality stadium bed when the sample pack is loaded
    const sg = this._sampleLoop('crowd-ambience');
    if (sg) {
      sg.gain.setTargetAtTime(l * 0.5, t, l > 0 ? 0.9 : 0.45);
      // keep the synth bed silent when the sample drives
      if (this._crowdStarted) {
        this.crowdGain.gain.setTargetAtTime(0, t, 0.4);
        this.crowdSwell.gain.setTargetAtTime(0, t, 0.4);
        this.crowdSwell2.gain.setTargetAtTime(0, t, 0.4);
      }
      return;
    }
    if (l > 0 && !this._crowdStarted) {
      this._crowdStarted = true;
      this.crowdSrc.start();
    }
    if (!this._crowdStarted) return;
    this.crowdGain.gain.setTargetAtTime(l * 0.085, t, l > 0 ? 0.7 : 0.45);
    this.crowdSwell.gain.setTargetAtTime(l * 0.05, t, 0.8);
    this.crowdSwell2.gain.setTargetAtTime(l * 0.028, t, 0.8);
    this.crowdLP.frequency.setTargetAtTime(900 + l * 800, t, 0.9);
  }

  // Race-engineer radio: open click, short beep, close click — all band-limited.
  radioTone() {
    if (this._playSample('radio-squelch', { gain: 0.7, jitter: 0.03 })) return;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 0.45, 1);
    const dest = this.radioHP;
    this._noiseShot({ dur: 0.05, type: 'highpass', freq: 1800, q: 0.7, peak: 0.16, decay: 0.012, dest });
    this._toneShot({ type: 'square', freq: 1180, peak: 0.11, dur: 0.12, decay: 0.03, sustain: 0.05, delay: 0.04, dest });
    this._noiseShot({ dur: 0.05, type: 'highpass', freq: 2200, q: 0.7, peak: 0.12, decay: 0.01, delay: 0.22, dest });
  }

  // Virtual Safety Car: double warning tone.
  vscBeep() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 0.6, 1);
    for (let k = 0; k < 2; k++) {
      this._toneShot({
        type: 'square',
        freq: 1046.5,
        peak: 0.13,
        dur: 0.2,
        decay: 0.04,
        sustain: 0.09,
        delay: k * 0.24,
      });
      this._toneShot({
        type: 'sine',
        freq: 523.25,
        peak: 0.09,
        dur: 0.2,
        decay: 0.04,
        sustain: 0.09,
        delay: k * 0.24,
      });
    }
  }

  // Rising tension pad for the start-lights sequence (~5 s). Auto-released when
  // countdownBeep(true) fires at lights-out, and self-terminating otherwise.
  startCrescendo() {
    if (!this.ready) return;
    this._stopCrescendo(0.1);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const DUR = 5.0;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.09, t + DUR * 0.68);
    out.gain.linearRampToValueAtTime(0.16, t + DUR - 0.1);
    out.gain.setTargetAtTime(0.0001, t + DUR, 0.1);
    out.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3.2;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(2600, t + DUR);
    lp.connect(out);

    // Root + fifth + shimmer, all creeping upward.
    const oA = ctx.createOscillator();
    oA.type = 'sawtooth';
    oA.frequency.setValueAtTime(82.4, t);
    oA.frequency.linearRampToValueAtTime(146.83, t + DUR);
    oA.connect(lp);

    const oB = ctx.createOscillator();
    oB.type = 'triangle';
    oB.frequency.setValueAtTime(123.47, t);
    oB.frequency.linearRampToValueAtTime(220, t + DUR);
    oB.connect(lp);

    const shimGain = ctx.createGain();
    shimGain.gain.setValueAtTime(0.0001, t);
    shimGain.gain.exponentialRampToValueAtTime(0.35, t + DUR);
    shimGain.connect(lp);
    const oC = ctx.createOscillator();
    oC.type = 'sine';
    oC.frequency.setValueAtTime(329.63, t);
    oC.frequency.linearRampToValueAtTime(587.33, t + DUR);
    oC.connect(shimGain);

    // Noise swell underneath (grandstand tension).
    const swell = ctx.createBufferSource();
    swell.buffer = this._crowdBuffer;
    swell.loop = true;
    const swBP = ctx.createBiquadFilter();
    swBP.type = 'bandpass';
    swBP.Q.value = 0.8;
    swBP.frequency.setValueAtTime(280, t);
    swBP.frequency.linearRampToValueAtTime(1200, t + DUR);
    const swGain = ctx.createGain();
    swGain.gain.setValueAtTime(0.0001, t);
    swGain.gain.exponentialRampToValueAtTime(0.5, t + DUR);
    swell.connect(swBP);
    swBP.connect(swGain);
    swGain.connect(out);

    const stopAt = t + DUR + 0.4;
    oA.start(t); oB.start(t); oC.start(t); swell.start(t);
    oA.stop(stopAt); oB.stop(stopAt); oC.stop(stopAt); swell.stop(stopAt);

    const self = this;
    const cresc = { out, lp, shimGain, swBP, swGain, oA, oB, oC, swell };
    this._cresc = cresc;
    oA.onended = function () {
      if (self._cresc === cresc) self._cresc = null;
      try {
        oA.disconnect(); oB.disconnect(); oC.disconnect(); swell.disconnect();
        shimGain.disconnect(); swBP.disconnect(); swGain.disconnect();
        lp.disconnect(); out.disconnect();
      } catch (e) { /* already torn down */ }
    };
  }

  // Public escape hatch for aborted starts (menu quit, restart during lights).
  stopCrescendo() {
    if (!this.ready) return;
    this._stopCrescendo(0.25);
  }

  // ---- internals ----

  _acquireOpponentVoice(id, now) {
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.id === id) return voice;
    }
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.activeUntil <= now) {
        voice.id = id;
        return voice;
      }
    }
    return null;
  }

  _schedulePassVoice(voice, cue, now) {
    const duration = cue.duration;
    const strength = cue.intensity * 0.32;
    const closeAt = now + duration * 0.38;
    const endAt = now + duration;
    voice.activeUntil = endAt + 0.08;

    const airF = 2100 + Math.min(1600, Math.abs(cue.relativeSpeed) * 24);
    const af = voice.airBP.frequency;
    af.cancelScheduledValues(now);
    af.setValueAtTime(airF, now);
    af.exponentialRampToValueAtTime(620 + cue.distance * 18, endAt);
    const ag = voice.airGain.gain;
    ag.cancelScheduledValues(now);
    ag.setValueAtTime(0.0001, now);
    ag.exponentialRampToValueAtTime(Math.max(0.001, strength), closeAt);
    ag.exponentialRampToValueAtTime(0.0001, endAt);

    const doppler = 1 + clampNum(cue.relativeSpeed / 310, -0.18, 0.18);
    const ef0 = (155 + cue.rpm * 480) * doppler;
    const ef1 = ef0 / Math.max(0.84, doppler * doppler);
    const ep = voice.engine.frequency;
    ep.cancelScheduledValues(now);
    ep.setValueAtTime(ef0, now);
    ep.exponentialRampToValueAtTime(Math.max(90, ef1), endAt);
    voice.engineBP.frequency.setTargetAtTime(ef0 * 2.1, now, 0.035);
    const eg = voice.engineGain.gain;
    eg.cancelScheduledValues(now);
    eg.setValueAtTime(0.0001, now);
    eg.exponentialRampToValueAtTime(Math.max(0.001, strength * 0.15), closeAt);
    eg.exponentialRampToValueAtTime(0.0001, endAt);

    if (voice.pan) {
      const pp = voice.pan.pan;
      pp.cancelScheduledValues(now);
      pp.setValueAtTime(cue.side * 0.92, now);
      pp.linearRampToValueAtTime(-cue.side * 0.48, endAt);
    }
  }

  _releaseOpponentVoices(now) {
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.activeUntil > now) continue;
      voice.engineGain.gain.setTargetAtTime(0, now, 0.07);
      voice.airGain.gain.setTargetAtTime(0, now, 0.07);
      voice.id = null;
    }
  }

  _bottomStrike(t0, intensity) {
    const i = clamp01(intensity);
    this.bottomOsc.frequency.setTargetAtTime(62 + i * 24, t0, 0.006);
    this.bottomBP.frequency.setTargetAtTime(390 + i * 260, t0, 0.01);
    const body = this.bottomGain.gain;
    const scrape = this.bottomNoiseGain.gain;
    body.cancelScheduledValues(t0);
    scrape.cancelScheduledValues(t0);
    this._pulse(body, t0, 0.11 * i, 0.004, 0.015, 0.045);
    this._pulse(scrape, t0, 0.075 * i, 0.003, 0.012, 0.035);
  }

  _gainNode(v, dest) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  _filter(type, freq, q, dest) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  // Permanent LFO -> depth gain -> target param. Depth is automated, so the
  // modulation can be gated on and off without allocating anything.
  _lfo(type, freq, depth, param) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(param);
    osc.start();
    return g;
  }

  _makeNoiseBuffer(seconds) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Pink-ish noise with a slow rumble component: reads as a distant crowd once
  // it is band-limited, and is long enough that the loop point is inaudible.
  _makeCrowdBuffer(seconds) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.055;
      b1 = 0.963 * b1 + w * 0.2;
      b2 = 0.78 * b2 + w * 0.45;
      let v = b0 * 1.6 + b1 + b2 * 0.5;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      d[i] = v * 0.9;
    }
    return buf;
  }

  // Gentle -2 dB duck of the engine bus for one-shots. amount 0..1 scales it.
  _duck(t0, hold, amount) {
    const a = amount == null ? 1 : clamp01(amount);
    const target = 1 - (1 - DUCK_GAIN) * a;
    const p = this.engineDuck.gain;
    p.cancelScheduledValues(t0);
    p.setTargetAtTime(target, t0, 0.012);
    p.setTargetAtTime(1, t0 + Math.max(0.05, hold || 0.2), 0.09);
  }

  // Click-free pooled envelope: setTargetAtTime always starts from the param's
  // current value, so re-triggering mid-decay can never step or click.
  _pulse(param, t0, peak, atk, hold, dec) {
    param.setTargetAtTime(peak, t0, atk);
    param.setTargetAtTime(0.0001, t0 + hold, dec);
  }

  // Tyre-scrub burst on the pooled scrub chain (called from update()).
  _scrub(t0, freq, peak) {
    this.scrubBP.frequency.setTargetAtTime(freq, t0, 0.02);
    const p = this.scrubGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, peak, 0.012, 0.05, 0.07);
  }

  // Wastegate whoosh: band sweeps down while the flutter LFO is gated open.
  _wastegate(t0, intensity) {
    const i = clamp01(intensity);
    const fp = this.wgBP.frequency;
    fp.cancelScheduledValues(t0);
    fp.setTargetAtTime(2700, t0, 0.01);
    fp.setTargetAtTime(650, t0 + 0.05, 0.13);
    const p = this.wgGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, 0.13 * i, 0.014, 0.07, 0.11);
    const d = this.wgFlutter.gain;
    d.cancelScheduledValues(t0);
    this._pulse(d, t0, 0.05 * i, 0.02, 0.1, 0.09);
  }

  // Overrun crackle: irregular train of short bright noise spits.
  _crackle(t0, intensity, count) {
    const i = clamp01(intensity);
    if (i <= 0) return;
    const n = count || 6;
    const p = this.crackleGain.gain;
    p.cancelScheduledValues(t0);
    this.crackleHP.frequency.setTargetAtTime(1500 + Math.random() * 900, t0, 0.02);
    this.crackleHP.Q.setTargetAtTime(0.8, t0, 0.02);
    let off = 0;
    for (let k = 0; k < n; k++) {
      const tp = t0 + off;
      const peak = (0.05 + Math.random() * 0.11) * i;
      p.setTargetAtTime(peak, tp, 0.0025);
      p.setTargetAtTime(0.0001, tp + 0.008, 0.011);
      off += 0.018 + Math.random() * 0.035;
    }
  }

  // Single bright click on the pooled crackle chain (the shift "cut" transient).
  _blip(t0, freq, q, peak, dec) {
    this.crackleHP.frequency.setTargetAtTime(freq, t0, 0.01);
    this.crackleHP.Q.setTargetAtTime(q, t0, 0.01);
    const p = this.crackleGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, peak, 0.004, 0.012, dec);
  }

  _stopCrescendo(fade) {
    const c = this._cresc;
    if (!c) return;
    this._cresc = null;
    const t = this.ctx.currentTime;
    const f = Math.max(0.02, fade || 0.2);
    c.out.gain.cancelScheduledValues(t);
    c.out.gain.setTargetAtTime(0.0001, t, f / 3);
    const stopAt = t + f + 0.1;
    try {
      c.oA.stop(stopAt); c.oB.stop(stopAt); c.oC.stop(stopAt); c.swell.stop(stopAt);
    } catch (e) { /* already stopped */ }
  }

  // Explicit gear when supplied, otherwise inferred from the speed/rpm ratio
  // (≈ the current gear's top speed) with hysteresis so the formant is stable.
  _resolveGear(gearIn, speed, rpm, step) {
    if (Number.isFinite(+gearIn) && +gearIn >= 1) {
      const g = Math.round(clampNum(gearIn, 1, 8));
      this._gear = g;
      this._gearCand = g;
      this._gearCandT = 0;
      return g;
    }
    const denom = clampNum(0.2 + 0.8 * rpm, 0.28, 1.05);
    const topGuess = speed / denom;
    let g = 1;
    for (let i = 0; i < 8; i++) {
      if (topGuess > GEAR_TOP[i] * 0.97) g = i + 2;
    }
    if (g > 8) g = 8;
    if (g === this._gear) {
      this._gearCand = g;
      this._gearCandT = 0;
      return g;
    }
    if (g !== this._gearCand) {
      this._gearCand = g;
      this._gearCandT = 0;
    }
    this._gearCandT += step;
    if (this._gearCandT > 0.12) {
      this._gear = g;
      this._gearCandT = 0;
    }
    return this._gear;
  }

  // One-shot filtered-noise burst with a click-free exponential envelope.
  _noiseShot(opt) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;

    const filt = ctx.createBiquadFilter();
    filt.type = opt.type || 'bandpass';
    filt.frequency.value = opt.freq || 1000;
    filt.Q.value = opt.q || 1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, opt.peak), t0 + 0.006);
    g.gain.setTargetAtTime(0.0001, t0 + 0.006, opt.decay || 0.05);

    src.connect(filt);
    filt.connect(g);
    const pan = ctx.createStereoPanner && Number.isFinite(opt.pan) && Math.abs(opt.pan) > 1e-4
      ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = clampNum(opt.pan, -1, 1);
      g.connect(pan);
      pan.connect(opt.dest || this.master);
    } else g.connect(opt.dest || this.master);
    src.start(t0);
    src.stop(t0 + (opt.dur || 0.2) + 0.15);
    src.onended = function () {
      src.disconnect();
      filt.disconnect();
      g.disconnect();
      pan?.disconnect();
    };
  }

  // One-shot oscillator with optional pitch sweep and sustain, exp decay.
  _toneShot(opt) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const dur = opt.dur || 0.15;
    const sustain = opt.sustain || 0;

    const osc = ctx.createOscillator();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq || 440, t0);
    if (opt.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.endFreq), t0 + dur);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, opt.peak), t0 + 0.008);
    if (sustain > 0) {
      g.gain.setValueAtTime(Math.max(0.001, opt.peak), t0 + 0.008 + sustain);
    }
    g.gain.setTargetAtTime(0.0001, t0 + 0.008 + sustain, opt.decay || 0.05);

    osc.connect(g);
    const pan = ctx.createStereoPanner && Number.isFinite(opt.pan) && Math.abs(opt.pan) > 1e-4
      ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = clampNum(opt.pan, -1, 1);
      g.connect(pan);
      pan.connect(opt.dest || this.master);
    } else g.connect(opt.dest || this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.25);
    osc.onended = function () {
      osc.disconnect();
      g.disconnect();
      pan?.disconnect();
    };
  }
}
