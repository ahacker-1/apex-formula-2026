// APEX FORMULA 2026 — boot, renderer, cameras, input, and the game state machine.
import * as THREE from 'three';
import { EffectComposer } from '../lib/postprocessing/EffectComposer.js';
import { RenderPass } from '../lib/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../lib/postprocessing/UnrealBloomPass.js';
import { ScaledGTAOPass } from '../lib/postprocessing/ScaledGTAOPass.js';
import { OutputPass } from '../lib/postprocessing/OutputPass.js';
import { FXAAPass } from '../lib/postprocessing/FXAAPass.js';
import { RGBELoader } from '../lib/loaders/RGBELoader.js';
import { CAMERA_FRAMING, resolveChaseCamera } from './cameraFraming.js';
import { advanceSteeringInput, digitalSteeringLimit } from './controls.js';
import { cockpitFov, cockpitSeat } from './cockpit.js';
import { createTelemetrySnapshot } from './telemetry.js';

// Photographic HDRI skies (CC0, PolyHaven). Load only the selected session's
// theme; fetching all three at boot used 19.8 MB before the player chose a race.
const HDRI = { day: null, dusk: null, night: null, promises: {} };
const photoManifest = {
  asphalt: 'textures/asphalt.png', grass: 'textures/grass.png',
  gravel: 'textures/gravel.png', crowd: 'textures/crowd.png',
  facadeDay: 'textures/facade-day.png', facadeNight: 'textures/facade-night.png',
  treeBroadleaf: 'textures/tree-broadleaf.png', treePine: 'textures/tree-pine.png',
  treePalm: 'textures/tree-palm.png', scrub: 'textures/scrub.png',
};
let coreAssetPromise = null;
let RaceSession = null;
let buildCircuit = null;
let TEX = null;

function loadCoreAssets() {
  if (coreAssetPromise) return coreAssetPromise;
  const photos = Promise.allSettled(Object.entries(photoManifest).map(([key, url]) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ key, img });
      img.onerror = reject;
      img.src = url;
    })));
  // Keep the menu's module graph lean: the circuit, simulation, car and large
  // procedural-texture modules are only evaluated after a venue is chosen.
  // Their network work overlaps the photo fetches and the selected HDR.
  coreAssetPromise = Promise.all([
    import('./race.js'),
    import('./trackBuilder.js'),
    import('./textures.js'),
    import('./car.js'),
    photos,
  ]).then(([raceModule, circuitModule, textureModule, carModule, loadedPhotos]) => {
    RaceSession = raceModule.RaceSession;
    buildCircuit = circuitModule.buildCircuit;
    TEX = textureModule;
    for (const result of loadedPhotos) {
      if (result.status === 'fulfilled') TEX.registerPhoto(result.value.key, result.value.img);
    }
    return carModule.preloadCarModel();
  }).catch((error) => {
    // A rejected cached promise can never recover. Leave successfully fetched
    // browser modules cached, but allow the user-facing Retry action to rebuild
    // the aggregate load and refetch the missing resource.
    coreAssetPromise = null;
    throw error;
  });
  return coreAssetPromise;
}

function environmentKeyForTrack(trackId) {
  if (['jeddah', 'lusail', 'singapore', 'lasvegas', 'qatar'].includes(trackId)) return 'night';
  if (trackId === 'bahrain' || trackId === 'yasmarina') return 'dusk';
  return 'day';
}

function documentIsActive() {
  return !document.hidden &&
    (typeof document.hasFocus !== 'function' || document.hasFocus());
}

function finiteCameraValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function loadHDRI(key) {
  if (!['day', 'dusk', 'night'].includes(key)) return Promise.reject(new Error(`Unknown HDRI theme: ${key}`));
  if (HDRI[key]) return Promise.resolve(HDRI[key]);
  if (!HDRI.promises[key]) {
    HDRI.promises[key] = new Promise((resolve, reject) => {
      new RGBELoader().load(`textures/hdri/${key}.hdr`, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      HDRI[key] = tex;
        resolve(tex);
      }, undefined, reject);
    }).catch((error) => {
      delete HDRI.promises[key];
      throw error;
    });
  }
  return HDRI.promises[key];
}
import { HUD } from './hud.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { Championship } from './championship.js';
import { Effects } from './effects.js';
import { QualityController } from './quality.js';
import { TimeTrialManager } from './timeTrial.js';
import { FixedStepAccumulator } from './fixedStep.js';
import { createRandom, createRendererNoiseRandom, deriveSeed, normalizeSeed } from './random.js';
import { TRACKS } from './tracks.js';
import { CALENDAR, DRIVERS } from './data.js';

const RETRY_SESSION_KEY = 'apexf1_retry_session_v1';
const RENDER_LOOK = Object.freeze({
  day: Object.freeze({
    exposure: 0.94,
    bloomStrength: 0.18, bloomRadius: 0.55, bloomThreshold: 0.86,
    environmentIntensity: 0.9, fallbackEnvironmentIntensity: 0.85,
  }),
  dusk: Object.freeze({
    exposure: 1.05,
    bloomStrength: 0.18, bloomRadius: 0.55, bloomThreshold: 0.86,
    environmentIntensity: 1.05, fallbackEnvironmentIntensity: 1.0,
    hemiIntensity: 0.74, hemiGround: 0x59606b, sunIntensity: 1.55,
  }),
  night: Object.freeze({
    exposure: 0.92,
    bloomStrength: 0.22, bloomRadius: 0.36, bloomThreshold: 0.92,
    environmentIntensity: 0.55, fallbackEnvironmentIntensity: 0.5,
  }),
  nightJeddah: Object.freeze({
    exposure: 0.95,
    bloomStrength: 0.18, bloomRadius: 0.28, bloomThreshold: 0.98,
    environmentIntensity: 0.48, fallbackEnvironmentIntensity: 0.44,
    hemiIntensity: 0.50, hemiGround: 0x242a32, sunIntensity: 1.05,
    ambientColor: 0x91a9d0, ambientIntensity: 0.34,
  }),
  nightSingapore: Object.freeze({
    exposure: 1.02,
    bloomStrength: 0.16, bloomRadius: 0.20, bloomThreshold: 1.02,
    environmentIntensity: 0.64, fallbackEnvironmentIntensity: 0.60,
    hemiIntensity: 0.72, hemiGround: 0x30363a, sunIntensity: 0.82,
    ambientColor: 0xc0d6ee, ambientIntensity: 0.52,
  }),
  nightLusail: Object.freeze({
    exposure: 0.86,
    bloomStrength: 0.14, bloomRadius: 0.18, bloomThreshold: 1.04,
    environmentIntensity: 0.30, fallbackEnvironmentIntensity: 0.26,
    hemiIntensity: 0.30, hemiGround: 0x11110f, sunIntensity: 0.92,
    ambientColor: 0x746b5e, ambientIntensity: 0.20,
  }),
  nightLasvegas: Object.freeze({
    exposure: 0.96,
    bloomStrength: 0.08, bloomRadius: 0.10, bloomThreshold: 1.10,
    environmentIntensity: 0.42, fallbackEnvironmentIntensity: 0.38,
    hemiIntensity: 0.40, hemiGround: 0x292128, sunIntensity: 0.72,
    ambientColor: 0x826579, ambientIntensity: 0.28,
  }),
});

function renderLookKeyForTrack(trackId, environmentKey) {
  const night = {
    jeddah: 'nightJeddah', singapore: 'nightSingapore',
    lusail: 'nightLusail', qatar: 'nightLusail', lasvegas: 'nightLasvegas',
  }[trackId];
  return night || environmentKey;
}

class Game {
  constructor() {
    this.state = 'boot';
    // The live scene always resolves through the composer and its final FXAA
    // pass. Native MSAA would only allocate extra samples for the default
    // framebuffer, which the composer does not render the scene into.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    // A logical game frame contains many renderer.render() calls across GTAO,
    // bloom, output and FXAA. Reset once around the whole pipeline so info is a
    // bounded per-frame aggregate instead of only describing the final pass.
    this.renderer.info.autoReset = false;
    // Start conservatively; QualityController selects the persisted/automatic
    // tier immediately after UI settings are available.
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = RENDER_LOOK.day.exposure;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = null;
    this.circuit = null;
    this.session = null;
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 6500);
    this.camMode = 0; // 0 chase, 1 seated cockpit, 2 T-cam, 3 nose
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camAhead = new THREE.Vector3();
    this._camLeft = new THREE.Vector3();
    this._camPlayerPos = new THREE.Vector3();
    this._camTargetPos = new THREE.Vector3();
    this._camTargetLook = new THREE.Vector3();
    this._camFraming = { back: 0, height: 0, look: 0, fov: 0 };

    this.hud = new HUD(document.getElementById('hud'));
    this.hud.cockpit.onPage = () => this.hud.nextCockpitPage();
    this.hud.cockpit.onExport = () => this.exportGhostReplay();
    this.audio = new AudioEngine();
    this.champ = new Championship();
    this.ui = new UI((action, payload) => this.onUI(action, payload));
    this.quality = new QualityController(this.renderer, (tier, automatic) => {
      this.effects?.setQualityTier?.(tier);
      if (this.session) this.hud.message(`GRAPHICS: ${tier.toUpperCase()}${automatic ? ' · AUTO' : ''}`);
    });
    this.quality.setMode(this.ui.settings.graphicsQuality);

    this.keys = {};
    this.keySteer = 0;
    this._steerInputMode = null;
    this.paused = false;
    this.awaitingStart = false;
    this.raceConfig = null;
    this.clock = new THREE.Clock();
    this.fixedStep = new FixedStepAccumulator();
    this.pacing = { steps: 0, simulatedDt: 0, alpha: 0, droppedDt: 0 };
    this._shiftQueue = [];
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
    this._gamepadSteeringActive = false;
    this._timeTrialStatus = null;
    this._lightsShown = 0;
    this._resultsShown = false;
    this._sessionGeneration = 0;
    this._sessionBuildTimer = null;
    this.onboardingActive = false;
    this._celestialObjects = [];
    this._frameTelemetry = { count: 0, lastMs: 0, smoothedMs: 0, maxMs: 0 };
    this._renderTelemetry = { calls: 0, triangles: 0, points: 0, lines: 0 };
    this._graphicsContextLost = false;
    this._graphicsContextLosses = 0;
    this._graphicsContextRestores = 0;
    this._wasPausedBeforeContextLoss = null;
    this._simStatusTimer = 0;
    this._audioNearbyEntries = [null, null, null, null];
    this._audioNearbyDistances = [Infinity, Infinity, Infinity, Infinity];
    this._audioOpponentCuePool = Array.from({ length: 4 }, () => ({
      id: '', side: 0, distance: 0, relativeSpeed: 0, rpmFrac: 0, intensity: 0,
    }));
    this._audioOpponentCues = [];
    this._trackGripOptions = {};
    this._trackGripResult = { surface: {} };
    this._trackConditionsSource = null;
    this._trackConditionsTime = -1;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.quality.resize(innerWidth, innerHeight);
    });
    addEventListener('keydown', e => this.onKey(e, true));
    addEventListener('keyup', e => this.onKey(e, false));
    // audio unlock on first gesture
    const unlock = () => {
      this.audio.init();
      this.audio.setVolume(this.ui.settings.volume);
      // A Retry reload can restore a live session before this new document has
      // received an autoplay-unlocking gesture. Start its engine on that first
      // gesture instead of leaving the recovered race permanently silent.
      if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
        this.audio.startEngine();
      }
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      // Never let time spent hidden become simulation catch-up work.
      this.resetSimulationTiming();
      if (document.hidden) {
        if (this.ui.settings.autoPause && this.state === 'loading') this._pauseOnReady = true;
        this.audio.stopEngine();
        if (this.ui.settings.autoPause && (this.state === 'race' || this.state === 'quali') && !this.paused) {
          this.togglePause(true);
        }
      }
      else {
        if (documentIsActive()) this._pauseOnReady = false;
        if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
          this.audio.startEngine();
        }
      }
    });
    addEventListener('blur', () => {
      // Key-up/pointer-up can be lost when focus leaves the window. Never let
      // that turn into a stuck throttle, brake, steer, or boost input.
      this.releaseDrivingInputs();
      this.audio.stopEngine();
      if (this.ui.settings.autoPause && this.state === 'loading') this._pauseOnReady = true;
      if (this.ui.settings.autoPause && (this.state === 'race' || this.state === 'quali') && !this.paused) {
        this.togglePause(true);
      }
    });
    addEventListener('focus', () => {
      this.resetSimulationTiming();
      if (documentIsActive()) this._pauseOnReady = false;
      if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
        this.audio.startEngine();
      }
    });
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._graphicsContextLost = true;
      this._graphicsContextLosses++;
      const driving = this.state === 'race' || this.state === 'quali';
      this._wasPausedBeforeContextLoss = driving ? this.paused : null;
      if (driving && !this.paused) this.togglePause(true);
      this.showGraphicsRecovery('GRAPHICS RESET DETECTED', 'Restoring the renderer…');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this._graphicsContextLost = false;
      this._graphicsContextRestores++;
      // Three preserves this flag internally, but reassert the aggregate mode
      // and the active venue look so recovery remains correct if renderer
      // internals change.
      this.renderer.info.autoReset = false;
      this.renderer.toneMappingExposure = RENDER_LOOK[this._renderLookKey || 'day'].exposure;
      this.quality.apply(true);
      this.showGraphicsRecovery('', '');
      if (this.session) this.hud.message('GRAPHICS RESTORED');
      const shouldResume = this._wasPausedBeforeContextLoss === false &&
        (this.state === 'race' || this.state === 'quali') && documentIsActive();
      this._wasPausedBeforeContextLoss = null;
      if (shouldResume && this.paused) this.togglePause(false);
    });

    this.boot();
    this.loop();
  }

  showGraphicsRecovery(title, detail) {
    let el = document.getElementById('graphics-recovery');
    if (!title) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'graphics-recovery';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'assertive');
      Object.assign(el.style, {
        position: 'fixed', inset: '0', zIndex: '10000', display: 'grid', placeContent: 'center',
        textAlign: 'center', color: '#fff', background: '#050608ee', fontFamily: 'Arial, sans-serif',
        letterSpacing: '.12em', textTransform: 'uppercase',
      });
      document.body.appendChild(el);
    }
    el.innerHTML = `<strong style="font-size:clamp(18px,3vw,34px)">${title}</strong><span style="margin-top:12px;color:#aeb4bd;font-size:12px">${detail}</span>`;
  }

  snapshot() {
    const session = this.session;
    const entry = session?.player;
    const physics = entry?.phys;
    const trackState = this.circuit?.trackState;
    const visual = trackState?.visualState || {};
    const weatherState = this.circuit?.weather?.current || {};
    const wetness = Number.isFinite(visual.wetness) ? visual.wetness : (physics?.surface?.wetness || 0);
    const damage = entry?.damage || {};
    const frontWingDamage = Number.isFinite(damage.frontWing)
      ? 1 - damage.frontWing : (entry?.wingDamage || 0);
    const strategy = entry?.strategyDecision || {};
    const telemetry = createTelemetrySnapshot(physics, {
      lap: entry?.lap,
      delta: this._timeTrialStatus?.delta,
    });
    telemetry.visible = this.camMode === 1 && !!this.hud?.cockpit?.active;
    const tier = this.quality?.appliedTier || this.quality?.tier || 'medium';
    const mobile = typeof innerWidth === 'number' && innerWidth <= 700;
    const cameraMode = ['chase', 'cockpit', 't-cam', 'nose'][this.camMode] || 'chase';
    const round = (value, places = 4) => Number.isFinite(value)
      ? Number(value.toFixed(places)) : 0;
    return {
      state: this.state,
      paused: !!this.paused,
      awaitingStart: !!this.awaitingStart,
      player: {
        driverId: entry?.driver?.id || null,
        teamId: entry?.team?.id || entry?.driver?.team || null,
        physics: telemetry,
      },
      track: {
        id: this.circuit?.id || this.raceConfig?.race?.trackId || null,
        name: this.circuit?.publicName || this.raceConfig?.race?.circuitName || this.circuit?.def?.name || null,
        state: {
          surface: wetness >= 0.15 ? 'wet' : 'dry',
          wetness: round(wetness, 3),
          puddling: round(visual.puddling, 3),
          rubber: round(visual.rubber, 3),
        },
      },
      controls: {
        throttle: this.paused || this.awaitingStart ? 0 : round(physics?.throttle),
        brake: this.paused || this.awaitingStart ? 0 : round(physics?.brake),
        steer: this.paused || this.awaitingStart ? 0 : round(this.keySteer),
      },
      camera: { mode: cameraMode },
      telemetry,
      weather: {
        condition: weatherState.condition || (weatherState.raining ? 'rain' : 'clear'),
        intensity: round(weatherState.intensity ?? ((weatherState.rainfall || 0) / 18), 3),
        rainfall: round(weatherState.rainfall, 3),
      },
      raceControl: { state: session?.raceControl?.state || (session?.vsc?.active ? 'vsc' : 'green') },
      damage: { frontWing: round(frontWingDamage, 3), severity: round(frontWingDamage, 3) },
      strategy: {
        recommendation: strategy.recommendation || (strategy.shouldPit ? 'pit-now' : 'stay-out'),
        compound: strategy.compound || strategy.nextCompound || entry?.strategyCompound || physics?.compound || 'M',
      },
      quality: {
        adaptive: this.quality?.mode === 'auto',
        profile: `${mobile ? 'mobile' : 'desktop'}-${tier}`,
      },
    };
  }

  // Offline authored-race adapter. Every field is applied to the production
  // track, race-control, damage and strategy models before the resulting state
  // is observed; no parallel test-only simulation is maintained.
  applyScenario(scenario = {}) {
    const session = this.session;
    const entry = session?.player;
    const track = this.circuit?.trackState;
    const weather = scenario.weather || {};
    const trackScenario = scenario.track || {};
    const condition = String(weather.condition || '').toLowerCase();
    const surface = String(trackScenario.surface || '').toLowerCase();
    const clearEnvironment = scenario.environment?.clear === true ||
      condition === 'dynamic' || surface === 'dynamic';
    const hasEnvironmentScenario = clearEnvironment || condition || surface ||
      Number.isFinite(weather.intensity) || Number.isFinite(weather.rainfall) ||
      Number.isFinite(weather.cloudCover) || Number.isFinite(trackScenario.wetness) ||
      Number.isFinite(trackScenario.puddling) || Number.isFinite(trackScenario.temperature);
    if (clearEnvironment) track?.clearConditions?.();
    else if (hasEnvironmentScenario) {
      let intensity = Number.isFinite(weather.intensity) ? weather.intensity : undefined;
      if (!Number.isFinite(intensity) && condition === 'rain') intensity = 0.5;
      else if (!Number.isFinite(intensity) && (condition === 'clear' || condition === 'overcast')) intensity = 0;
      let wetness = Number.isFinite(trackScenario.wetness) ? trackScenario.wetness : undefined;
      if (!Number.isFinite(wetness) && surface === 'wet') wetness = 0.6;
      else if (!Number.isFinite(wetness) && surface === 'dry') wetness = 0;
      const rainfall = Number.isFinite(weather.rainfall)
        ? weather.rainfall : (Number.isFinite(intensity) ? intensity * 18 : undefined);
      const cloudCover = Number.isFinite(weather.cloudCover) ? weather.cloudCover
        : condition === 'rain' ? Math.max(0.78, intensity || 0)
          : condition === 'overcast' ? 0.82 : condition === 'clear' ? 0.18 : undefined;
      track?.setConditions?.({
        wetness,
        puddling: trackScenario.puddling,
        temperature: trackScenario.temperature,
        rubber: trackScenario.rubber,
        dust: trackScenario.dust,
        intensity,
        rainfall,
        cloudCover,
        airTemperature: weather.airTemperature,
        humidity: weather.humidity,
        windSpeed: weather.windSpeed,
        windDirection: weather.windDirection,
        locked: scenario.environment?.locked !== false,
      });
    }
    if (hasEnvironmentScenario && session?.setTrackConditions) {
      const visual = track?.visualState;
      session.setTrackConditions({
        wetness: visual?.wetness,
        trackGrip: this.circuit?.gripAt?.(
          entry?.phys?.sampleIdx || 0,
          entry?.phys?.lat || 0,
          this._trackGripOptions,
          this._trackGripResult,
        )?.multiplier,
        rainfall: this.circuit?.weather?.current?.rainfall,
      });
      this._trackConditionsSource = track || null;
      this._trackConditionsTime = track?.time ?? -1;
    }
    const requestedControl = scenario.raceControl?.state;
    if (requestedControl === 'green') session?.resumeRace?.({ immediate: true });
    else if (requestedControl && session?.raceControl?.state !== requestedControl) {
      session?.requestRaceControl?.(requestedControl, { duration: 90, reason: 'authored-scenario' });
    }
    if (entry?.damage && scenario.damage?.component === 'frontWing') {
      const severity = Math.max(0, Math.min(1, Number(scenario.damage.severity) || 0));
      entry.damage.frontWing = 1 - severity;
      entry.wingDamage = severity;
    }
    if (entry && scenario.strategy) {
      entry.strategyDecision = {
        ...(entry.strategyDecision || {}),
        recommendation: scenario.strategy.recommendation || 'stay-out',
        shouldPit: scenario.strategy.recommendation === 'pit-now',
        compound: scenario.strategy.compound || entry.strategyCompound || 'M',
        nextCompound: scenario.strategy.compound || entry.strategyCompound || 'M',
      };
    }
    const result = this.snapshot();
    this.hud?.updateSimulationState?.(result);
    return result;
  }

  get renderTelemetry() {
    const composerTarget = this.composer?.renderTarget1;
    const gtaoTarget = this.gtao?.gtaoRenderTarget;
    const fxaaResolution = this.fxaa?.uniforms?.resolution?.value;
    return {
      frame: { ...this._frameTelemetry },
      quality: {
        mode: this.quality.mode,
        tier: this.quality.appliedTier,
        pixelRatio: this.renderer.getPixelRatio(),
        composerPixelRatio: this.composer?._pixelRatio ?? null,
      },
      targets: {
        drawingBuffer: {
          width: this.renderer.domElement.width,
          height: this.renderer.domElement.height,
        },
        composer: composerTarget ? { width: composerTarget.width, height: composerTarget.height } : null,
        gtao: gtaoTarget ? {
          width: gtaoTarget.width,
          height: gtaoTarget.height,
          scale: this.gtao.resolutionScale,
        } : null,
      },
      passes: {
        gtao: !!this.gtao?.enabled,
        bloom: !!this.bloom?.enabled,
        fxaa: !!this.fxaa?.enabled,
        fxaaResolution: fxaaResolution ? { x: fxaaResolution.x, y: fxaaResolution.y } : null,
      },
      renderer: {
        ...this._renderTelemetry,
        autoReset: this.renderer.info.autoReset,
        textures: this.renderer.info.memory.textures,
        geometries: this.renderer.info.memory.geometries,
      },
      carLod: this.session?.carLodTelemetry ?? null,
      context: {
        lost: this._graphicsContextLost,
        losses: this._graphicsContextLosses,
        restores: this._graphicsContextRestores,
      },
    };
  }

  // ---------- boot ----------
  async boot() {
    const bar = document.getElementById('boot-progress');
    const status = document.getElementById('boot-status');
    // Track photography, the GLB, and the selected HDR are deferred until the
    // player chooses a venue. The menu is fully interactive without them.
    status.textContent = 'INITIALIZING AUDIO…';
    bar.style.width = '72%';
    // The published build intentionally ships only the synthesized WebAudio
    // engine. Avoid probing every optional MP3 (and generating a burst of 404s)
    // unless a local sample-pack user explicitly opts in.
    const sampleAudio = new URLSearchParams(location.search).get('sampleAudio') === '1';
    if (sampleAudio && this.audio.loadSamplePack) {
      await this.audio.loadSamplePack('sounds/').catch(() => {});
    }
    bar.style.width = '94%';
    status.textContent = 'VERIFYING 2026 ENTRY LIST — 11 TEAMS · 22 DRIVERS';
    await sleep(80);
    status.textContent = 'READY';
    bar.style.width = '100%';
    await sleep(120);
    const retryConfig = this.consumeRetrySession();
    if (retryConfig) {
      this.startSession(retryConfig);
    } else {
      this.state = 'menu';
      this.ui.showMain(this.champ);
    }
  }

  consumeRetrySession() {
    let saved = null;
    try {
      const raw = sessionStorage.getItem(RETRY_SESSION_KEY);
      sessionStorage.removeItem(RETRY_SESSION_KEY); // one shot: never reload-loop
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (!saved || typeof saved !== 'object') return null;
    const race = CALENDAR.find(item => item.trackId === saved.trackId);
    if (!race || !DRIVERS.some(driver => driver.id === saved.driverId)) return null;
    if (!['race', 'quali', 'practice'].includes(saved.mode)) return null;
    const driverIds = new Set(DRIVERS.map(driver => driver.id));
    const gridOrder = Array.isArray(saved.gridOrder) &&
      saved.gridOrder.length === DRIVERS.length &&
      new Set(saved.gridOrder).size === DRIVERS.length &&
      saved.gridOrder.every(id => driverIds.has(id))
      ? saved.gridOrder : null;
    return {
      race,
      driverId: saved.driverId,
      mode: saved.mode,
      trial: saved.trial === true,
      pilot: saved.pilot === true,
      fullWeekend: saved.fullWeekend === true,
      weekendSeed: Number.isInteger(saved.weekendSeed) ? saved.weekendSeed : undefined,
      qualiStage: typeof saved.qualiStage === 'string' ? saved.qualiStage : undefined,
      qualiFormat: typeof saved.qualiFormat === 'string' ? saved.qualiFormat : undefined,
      formationLap: saved.formationLap === true,
      champRound: saved.champRound === true,
      gridOrder,
      seed: Number.isInteger(saved.seed) ? saved.seed : undefined,
    };
  }

  reloadForSessionRetry() {
    const cfg = this.raceConfig;
    if (cfg?.race?.trackId && cfg.driverId) {
      try {
        sessionStorage.setItem(RETRY_SESSION_KEY, JSON.stringify({
          trackId: cfg.race.trackId,
          driverId: cfg.driverId,
          mode: cfg.mode,
          trial: cfg.trial === true,
          pilot: cfg.pilot === true,
          fullWeekend: cfg.fullWeekend === true,
          weekendSeed: cfg.weekendSeed,
          qualiStage: cfg.qualiStage,
          qualiFormat: cfg.qualiFormat,
          formationLap: cfg.formationLap === true,
          champRound: cfg.champRound === true,
          gridOrder: cfg.gridOrder || null,
          seed: cfg.seed,
        }));
      } catch {}
    }
    // Failed module imports are cached for the lifetime of this document. A
    // reload is the only standards-compliant retry without cache-busting URLs.
    location.reload();
  }

  // ---------- UI events ----------
  onUI(action, payload) {
    this.audio.uiClick && this.audio.uiClick();
    switch (action) {
      case 'menu':
        if (payload === 'pilot') {
          const race = CALENDAR.find(r => r.trackId === 'spa');
          const driverId = DRIVERS.find(d => d.id === 'hacker' && d.team === 'tacn')?.id
            || DRIVERS.find(d => d.team === 'tacn')?.id;
          if (!race || !driverId) break;
          this.ui.sel.mode = 'weekend';
          this.ui.sel.driverId = driverId;
          this.ui.sel.trackId = 'spa';
          this.startSession({
            race, driverId, mode: 'practice', pilot: true, fullWeekend: true,
            qualiStage: 'FP1', qualiFormat: 'staged',
          });
        }
        else if (payload === 'raceNow') {
          const last = this.ui.lastSelection;
          const race = last && CALENDAR.find(r => r.trackId === last.trackId);
          if (race && last.driverId) this.startSession({ race, driverId: last.driverId, mode: 'race' });
        }
        else if (payload === 'quick') { this.state = 'team'; this.ui.showTeamSelect('quick'); }
        else if (payload === 'trial') { this.state = 'team'; this.ui.showTeamSelect('trial'); }
        else if (payload === 'champ') {
          if (this.champ.active) this.startChampRace();
          else { this.state = 'team'; this.ui.showTeamSelect('champ'); }
        }
        else if (payload === 'standings') { this.state = 'standings'; this.ui.showStandings(this.champ, true); }
        else if (payload === 'settings') { this.state = 'settings'; this.ui.showSettings('main'); }
        break;
      case 'teamChosen':
        if (payload.mode === 'champ') {
          this.champ.startNew(payload.driverId);
          this.startChampRace();
        } else {
          this.state = 'track';
          this.ui.showTrackSelect();
        }
        break;
      case 'trackChosen': {
        const race = CALENDAR.find(r => r.trackId === payload.trackId);
        if (payload.mode === 'trial') {
          this.startSession({ race, driverId: payload.driverId, mode: 'quali', trial: true });
        } else if (this.ui.settings.quali) {
          this.startSession({ race, driverId: payload.driverId, mode: 'quali' });
        } else {
          this.startSession({ race, driverId: payload.driverId, mode: 'race' });
        }
        break;
      }
      case 'startRaceAfterQuali': {
        const grid = this.session.qualiClassification().map(r => r.driverId);
        const cfg = this.raceConfig;
        this.startSession({
          race: cfg.race, driverId: cfg.driverId, mode: 'race', gridOrder: grid,
          champRound: cfg.champRound, seed: cfg.seed,
        });
        break;
      }
      case 'startPilotQualifying': {
        const cfg = this.raceConfig;
        if (!cfg?.fullWeekend) break;
        const weekendSeed = cfg.weekendSeed ?? cfg.seed;
        this.startSession({
          race: cfg.race,
          driverId: cfg.driverId,
          mode: 'quali',
          pilot: true,
          fullWeekend: true,
          weekendSeed,
          qualiStage: 'Q1',
          qualiFormat: 'staged',
          seed: deriveSeed(weekendSeed, 'qualifying'),
        });
        break;
      }
      case 'advancePilotQualifying': {
        const cfg = this.raceConfig;
        const session = this.session;
        if (!cfg?.fullWeekend || session?.mode !== 'quali') break;
        const advanced = session.advanceQualifyingStage();
        if (!advanced) break;
        if (advanced.stage === 'done') {
          const gridOrder = advanced.classification.map(row => row.driverId);
          const weekendSeed = cfg.weekendSeed ?? cfg.seed;
          this.startSession({
            race: cfg.race,
            driverId: cfg.driverId,
            mode: 'race',
            pilot: true,
            fullWeekend: true,
            weekendSeed,
            formationLap: true,
            gridOrder,
            seed: deriveSeed(weekendSeed, 'race'),
          });
          break;
        }
        this._qualiDoneShown = false;
        this.state = 'quali';
        this.ui.hideAll();
        this.hud.show();
        this.camMode = advanced.playerActive ? 0 : 2;
        this.updateTouchControls();
        this.snapCamera();
        this.resetSimulationTiming();
        if (documentIsActive()) this.audio.startEngine();
        break;
      }
      case 'restartRace':
        this.startSession(this.raceConfig);
        break;
      case 'retryLoad':
        this.reloadForSessionRetry();
        break;
      case 'afterRaceChamp':
        this.teardownSession();
        this.state = 'standings';
        this.ui.showStandings(this.champ, true);
        break;
      case 'champNextRace':
        this.startChampRace();
        break;
      case 'abandonSeason':
        this.teardownSession();
        this.champ.abandon();
        this.state = 'menu';
        this.ui.showMain(this.champ);
        break;
      case 'champNew':
        this.state = 'team';
        this.ui.showTeamSelect('champ');
        break;
      case 'uiclick':
        break;
      case 'settingsChanged':
        this.audio.setVolume(payload.volume);
        if (this.session) this.session.setNametags(payload.nametags);
        this.quality.setMode(payload.graphicsQuality);
        this.updateTouchControls();
        break;
      case 'back':
        this.teardownSession();
        this.state = payload === 'team' ? 'team' : payload === 'main' ? 'menu' : payload;
        if (payload === 'main') this.ui.showMain(this.champ);
        else if (payload === 'team') this.ui.showTeamSelect(this.ui.sel.mode);
        break;
      case 'pause':
        if (payload === 'resume') this.togglePause(false);
        else if (payload === 'restart') { this.togglePause(false); this.startSession(this.raceConfig); }
        else if (payload === 'quit') {
          this.togglePause(false);
          const wasTrial = this.raceConfig?.trial;
          if (wasTrial && this.session) {
            const p = this.session.player;
            const bestLap = p.bestLap || this.timeTrial?.personalBest || 0;
            this.teardownSession(true);
            this.state = 'results';
            this.ui.showResults([{ bestLap }], null, this.raceConfig.race, 'trial', false);
          } else {
            this.teardownSession();
            this.state = 'menu';
            this.ui.showMain(this.champ);
          }
        }
        break;
    }
  }

  startChampRace() {
    this.ui.sel.mode = 'champ'; // clear stale 'trial' so loading-screen copy matches the session
    const race = this.champ.nextRace;
    if (!race) { this.state = 'standings'; this.ui.showStandings(this.champ, false); return; }
    const driverId = this.champ.playerDriverId;
    if (this.ui.settings.quali) {
      this.startSession({ race, driverId, mode: 'quali', champRound: true });
    } else {
      this.startSession({ race, driverId, mode: 'race', champRound: true });
    }
  }

  // ---------- session lifecycle ----------
  startSession(cfg) {
    this.teardownSession();
    this.resetSimulationTiming();
    const querySeed = new URLSearchParams(location.search).get('seed');
    const requestedSeed = cfg.seed ?? querySeed;
    const sessionSeed = requestedSeed == null ? createRandom().state : normalizeSeed(requestedSeed);
    cfg = { ...cfg, seed: sessionSeed };
    if (cfg.fullWeekend) cfg.weekendSeed = normalizeSeed(cfg.weekendSeed ?? sessionSeed);
    // Every player-controlled session opens in the elevated rear chase view.
    // Cockpit/T-cam/nose remain available through C after the session is ready.
    this.camMode = 0;
    this.raceConfig = cfg;
    const simulationRandom = createRandom(deriveSeed(sessionSeed, 'simulation'));
    const effectsRandom = createRandom(deriveSeed(sessionSeed, 'effects'));
    this.sessionSeed = sessionSeed;
    const track = TRACKS[cfg.race.trackId];
    this.state = 'loading';
    this.ui.showLoading(cfg.race, track);
    this._resultsShown = false;
    this._lightsShown = 0;
    this._qualiDoneShown = false;
    this.ersMode = 1; // every session starts in BALANCED
    this._pauseOnReady = !!(this.ui.settings.autoPause && !documentIsActive());
    const sessionGeneration = this._sessionGeneration;
    const environmentKey = environmentKeyForTrack(cfg.race.trackId);
    // Begin the one relevant lighting environment in parallel with photos/GLB.
    loadHDRI(environmentKey).catch(() => {});
    // let the loading screen paint before the (sync) circuit build
    this._sessionBuildTimer = setTimeout(async () => {
      this._sessionBuildTimer = null;
      if (sessionGeneration !== this._sessionGeneration) return;
      try {
        await loadCoreAssets();
      } catch (error) {
        if (sessionGeneration !== this._sessionGeneration) return;
        console.error('Race assets failed to load', error);
        this.state = 'loadError';
        this.ui.showLoadError(cfg.race, track);
        return;
      }
      if (sessionGeneration !== this._sessionGeneration) return;
      this.scene = new THREE.Scene();
      this.circuit = buildCircuit(cfg.race.trackId, track, this.scene, {
        weatherSeed: deriveSeed(sessionSeed, 'weather'),
      });
      this.setupEnvironment(effectsRandom, environmentKey);
      const laps = cfg.mode === 'race' ? this.ui.raceLapsFor(cfg.race.trackId) : 1;
      this.session = new RaceSession({
        scene: this.scene,
        circuit: this.circuit,
        playerDriverId: cfg.driverId,
        laps,
        difficulty: this.ui.settings.difficulty,
        assists: { tc: this.ui.settings.tc, abs: this.ui.settings.abs, autoGear: this.ui.settings.autoGear },
        mode: cfg.mode,
        trial: cfg.trial,
        qualiStage: cfg.qualiStage,
        qualiFormat: cfg.qualiFormat,
        formationLap: cfg.formationLap,
        gridOrder: cfg.gridOrder || null,
        random: simulationRandom,
        seed: sessionSeed,
        onMessage: (t, c, meta) => { this.hud.message(t, c, meta); },
      });
      this.applyVenueCarLighting();
      this.session.setNametags(this.ui.settings.nametags);
      this.hud.bindSession(this.session, this.circuit);
      if (cfg.formationLap) this.session.startFormation();
      if (cfg.trial) {
        this.timeTrial = new TimeTrialManager({
          scene: this.scene,
          circuit: this.circuit,
          session: this.session,
          trackId: cfg.race.trackId,
          driverId: cfg.driverId,
          onPersonalBest: (record) => {
            this.hud.message(`PERSONAL BEST SAVED · ${record.lap.toFixed(3)}s`, 'purple');
          },
        });
        this._timeTrialStatus = { personalBest: this.timeTrial.personalBest, delta: null };
        this.hud.updateTimeTrial(this._timeTrialStatus.personalBest, null);
      }
      this.hud.showPitOverlay(k => {
        this.session.playerChooseTyre(k);
        this.audio.uiConfirm();
      });
      this.ui.hideAll();
      this.hud.show();
      this.state = cfg.mode === 'race' ? 'race' : 'quali';
      this.updateTouchControls();
      this.snapCamera();
      // Populate the stationary start screen from real session state without
      // advancing physics. Otherwise the frozen gate displayed constructor
      // placeholders (neutral/Medium) until after the player pressed Start.
      this.hud.update(0);
      this.hud.updateSimulationState?.(this.snapshot());
      // Circuit/PMREM/car construction is synchronous and can take hundreds of
      // milliseconds. Rebase after it so no build time becomes simulation time.
      this.resetSimulationTiming();
      this.awaitingStart = true;
      let onboardingSeen = false;
      try { onboardingSeen = localStorage.getItem('apexf1_onboarding_v1') === '1'; } catch {}
      const shouldPauseOnReady = () => !!(this.ui.settings.autoPause &&
        (this._pauseOnReady || !documentIsActive()));
      if (!onboardingSeen) {
        this.onboardingActive = true;
        this.paused = true;
        this.resetSimulationTiming();
        this.audio.stopEngine();
        this.hud.showOnboarding(() => {
          try { localStorage.setItem('apexf1_onboarding_v1', '1'); } catch {}
          this.onboardingActive = false;
          if (documentIsActive()) this._pauseOnReady = false;
          if (shouldPauseOnReady()) {
            this.paused = true;
            this.resetSimulationTiming();
            this.audio.stopEngine();
            this.ui.showPause();
            return;
          }
          this.paused = false;
          this.resetSimulationTiming();
          this.beginSessionFromGate();
        });
      } else if (shouldPauseOnReady()) {
        // Visibility or window focus may have changed while assets/build ran.
        this.togglePause(true);
      } else {
        this.paused = false;
        this.audio.stopEngine();
        this.hud.showSessionReady(() => this.beginSessionFromGate());
      }
    }, 60);
  }

  updateTouchControls() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.hud.enableTouchControls(
      !!(this.session && this.ui.settings.touchControls && coarse),
      () => this.togglePause(),
    );
  }

  teardownSession(keepConfig = false) {
    this._sessionGeneration++;
    clearTimeout(this._sessionBuildTimer); this._sessionBuildTimer = null;
    clearTimeout(this._qualiTimer); this._qualiTimer = null;
    clearTimeout(this._resultsTimer); this._resultsTimer = null;
    if (this.timeTrial) { this.timeTrial.dispose(); this.timeTrial = null; }
    if (this.session) { this.session.dispose(); this.session = null; }
    if (this.circuit) { this.circuit.dispose(); this.circuit = null; }
    if (this.sky) {
      this.sky.geometry.dispose();
      if (this.sky.material.map) this.sky.material.map.dispose();
      this.sky.material.dispose();
      this.sky = null;
    }
    // HDRI env textures are module-cached and shared across sessions — never
    // dispose those; the PMREM fallback owns a per-session render target.
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this.scene) this.scene.environment = null;
    if (this.sun) { this.sun.dispose(); this.sun = null; }
    if (this._celestialObjects.length) {
      const geometries = new Set(), materials = new Set(), textures = new Set();
      for (const root of this._celestialObjects) {
        root.traverse((object) => {
          // Sprite geometry is shared internally by Three.js.
          if (object.geometry && !object.isSprite) geometries.add(object.geometry);
          const ownedMaterials = object.material
            ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
          for (const material of ownedMaterials) {
            materials.add(material);
            if (material.map) textures.add(material.map);
          }
        });
        this.scene?.remove(root);
      }
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
      this._celestialObjects = [];
    }
    if (this.effects) { this.effects.dispose(); this.effects = null; }
    this.quality.bind({});
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose && pass.dispose();
      this.composer.dispose();
      this.composer = null; this.bloom = null; this.gtao = null; this.fxaa = null;
    }
    this.hemi = null;
    this.scene = null;
    // Do not let a completed night session tint the menu or the next venue while
    // its scene is being assembled. setupEnvironment() reapplies the selected
    // venue's look once the new circuit exists.
    this._environmentKey = null;
    this._renderLookKey = null;
    this.renderer.toneMappingExposure = RENDER_LOOK.day.exposure;
    this.hud.hide();
    this.hud.setCockpitMode(false);
    this.audio.stopEngine();
    if (this.audio.crowdAmbience) this.audio.crowdAmbience(0);
    if (this.audio.stopCrescendo) this.audio.stopCrescendo();
    this._vscAudio = false; this._radioLen = 0; this._pitAudio = false;
    this._timeTrialStatus = null;
    this.onboardingActive = false;
    this.awaitingStart = false;
    this.resetSimulationTiming();
    if (!keepConfig) this.paused = false;
  }

  setupEnvironment(effectsRandom = () => Math.random(), environmentKey) {
    this._celestialObjects = [];
    const th = this.circuit.theme;
    const renderLookKey = renderLookKeyForTrack(this.circuit.id, environmentKey);
    const renderLook = RENDER_LOOK[renderLookKey] || RENDER_LOOK.day;
    this._environmentKey = environmentKey;
    this._renderLookKey = renderLookKey;
    // Day, dusk and night are independently graded. Day holds highlight
    // headroom; dusk trades warm sun/ground lift for neutral sky/IBL fill; night
    // preserves the established restrained fixture response.
    this.renderer.toneMappingExposure = renderLook.exposure;
    this.scene.fog = new THREE.Fog(th.fog, th.fogNear ?? 300, th.fogFar ?? 1600);
    // sky dome: gradient + soft clouds BAKED into the texture (day/dusk).
    // Clouds must never be separate transparent quads again -- sprites read as
    // tinted slab panes (removed in e29383d); baked into the dome they cannot.
    const skyTex = new THREE.CanvasTexture(TEX.skyDome(
      '#' + new THREE.Color(th.skyTop).getHexString(),
      '#' + new THREE.Color(th.skyBot).getHexString(),
      { clouds: !th.night, dusk: environmentKey === 'dusk',
        horizonStop: th.night && !th.proceduralSky ? 1 : 0.52 }
    ));
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 24, 12),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    this.scene.add(sky);
    this.sky = sky;
    const hemi = new THREE.HemisphereLight(
      th.skyTop,
      renderLook.hemiGround ?? th.ground,
      renderLook.hemiIntensity ?? th.hemi,
    );
    this.scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(th.sun, renderLook.sunIntensity ?? th.sunI);
    sun.position.set(260, 380, 160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110;
    sc.near = 50; sc.far = 900;
    sc.updateProjectionMatrix(); // without this the frustum stays at the ±5m default → no visible shadows
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    if (th.night) {
      const amb = new THREE.AmbientLight(
        renderLook.ambientColor ?? 0x8899cc,
        renderLook.ambientIntensity ?? 0.5,
      );
      this.scene.add(amb);
    }

    // ---- celestial dressing ----
    const mkTex = (canvas) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const sunDir = sun.position.clone().normalize();
    if (!th.night) {
      // sun disc + glow
      const glow = (inner, outer, size) => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, inner);
        grad.addColorStop(1, outer);
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const m = new THREE.SpriteMaterial({ map: mkTex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        const s = new THREE.Sprite(m);
        s.scale.setScalar(size);
        return s;
      };
      const sunDisc = glow('rgba(255,252,240,1)', 'rgba(255,240,200,0)', 260);
      sunDisc.position.copy(sunDir).multiplyScalar(2300);
      const sunGlow = glow('rgba(255,230,180,0.55)', 'rgba(255,210,140,0)', 760);
      sunGlow.position.copy(sunDir).multiplyScalar(2280);
      this.scene.add(sunDisc, sunGlow);
      this._celestialObjects.push(sunDisc, sunGlow);
      // No cloud sprites: semi-transparent sky quads read as tinted slabs at
      // certain angles (verified by hiding all sprites — sky went clean).
      // Clouds belong painted into the sky-dome texture, where alpha blending
      // and sprite shear cannot produce panes.
    } else if (th.stars !== false) {
      // Dark rural/coastal nights retain small round stars. Urban Singapore and
      // Las Vegas deliberately skip this whole branch in favour of skyglow.
      const starGeo = new THREE.BufferGeometry();
      const sp = new Float32Array(420 * 3);
      for (let i = 0; i < 420; i++) {
        const az = effectsRandom() * Math.PI * 2, el = effectsRandom() * Math.PI * 0.42 + 0.14;
        const r = 2350;
        sp[i * 3] = Math.cos(az) * Math.cos(el) * r;
        sp[i * 3 + 1] = Math.sin(el) * r;
        sp[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      // soft round star sprite (hard unfiltered squares read as stray pixels)
      const starC = document.createElement('canvas');
      starC.width = starC.height = 32;
      const sg2 = starC.getContext('2d');
      const sgr = sg2.createRadialGradient(16, 16, 0, 16, 16, 16);
      sgr.addColorStop(0, 'rgba(255,255,255,1)');
      sgr.addColorStop(0.4, 'rgba(230,236,255,0.6)');
      sgr.addColorStop(1, 'rgba(230,236,255,0)');
      sg2.fillStyle = sgr;
      sg2.fillRect(0, 0, 32, 32);
      const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
        map: mkTex(starC), color: 0xcdd8ff, size: 1, sizeAttenuation: false,
        fog: false, transparent: true, opacity: 0.62, alphaTest: 0.20, depthWrite: false,
      }));
      stars.name = 'stars';
      this.scene.add(stars);
      this._celestialObjects.push(stars);
      const mc = document.createElement('canvas');
      mc.width = mc.height = 128;
      const mg = mc.getContext('2d');
      const mgrad = mg.createRadialGradient(64, 64, 10, 64, 64, 64);
      mgrad.addColorStop(0, 'rgba(235,240,255,1)');
      mgrad.addColorStop(0.35, 'rgba(220,228,250,0.9)');
      mgrad.addColorStop(1, 'rgba(220,228,250,0)');
      mg.fillStyle = mgrad;
      mg.fillRect(0, 0, 128, 128);
      const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: mkTex(mc), transparent: true, depthWrite: false, fog: false }));
      moon.name = 'moon';
      moon.scale.setScalar(190);
      moon.position.set(-1200, 1300, -900);
      this.scene.add(moon);
      this._celestialObjects.push(moon);
    }

    this.effects = new Effects(this.scene, effectsRandom);
    // The controller selects its initial tier before a session owns an Effects
    // instance, so apply it once here as well as in the live tier callback.
    this.effects.setQualityTier(this.quality.tier);
    this.effects.bindEnvironment?.(this.circuit?.trackState);

    // Lighting: photographic HDRI sky + true IBL when loaded; PMREM-from-dome
    // fallback renders immediately while only this session's theme downloads.
    const sceneForEnvironment = this.scene;
    const applyHDRI = (hdr) => {
      if (this.scene !== sceneForEnvironment || !hdr) return;
      sceneForEnvironment.environment = hdr;
      sceneForEnvironment.environmentIntensity = renderLook.environmentIntensity;
      if (th.night && !th.proceduralSky) {
        sceneForEnvironment.background = hdr;
        sceneForEnvironment.backgroundIntensity = 0.7;
        sky.visible = false;
      } else {
        sceneForEnvironment.background = null;
        sky.visible = true;
      }
      if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
      this._envIsHDRI = true;
    };
    const hdr = HDRI[environmentKey];
    if (hdr) {
      applyHDRI(hdr);
    } else {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const envSky = sky.clone();
      envScene.add(envSky);
      const groundDisc = new THREE.Mesh(
        new THREE.CircleGeometry(2000, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: th.ground })
      );
      groundDisc.position.y = -2;
      envScene.add(groundDisc);
      this._envRT = pmrem.fromScene(envScene, 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = renderLook.fallbackEnvironmentIntensity;
      this._envIsHDRI = false;
      pmrem.dispose();
      groundDisc.geometry.dispose();
      groundDisc.material.dispose();
      loadHDRI(environmentKey).then(applyHDRI).catch(() => {
        // The procedural PMREM environment remains a complete offline fallback.
      });
    }

    // post-processing: AO grounds everything, bloom lifts lights, then output
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new ScaledGTAOPass(this.scene, this.camera, innerWidth, innerHeight, 0.5, {
      noiseRandom: createRendererNoiseRandom(),
    });
    this.gtao.output = ScaledGTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.72; // 0.9 visibly darkened additive effects (sparks) in AO-heavy corners
    this.gtao.enabled = this.ui.settings.gtao !== false;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      // Night bloom stays tight and selective: fixture cores still read as hot,
      // but their halos no longer merge down a straight or bleach road detail.
      renderLook.bloomStrength,
      renderLook.bloomRadius,
      renderLook.bloomThreshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);
    this.quality.bind({ composer: this.composer, gtao: this.gtao, bloom: this.bloom, sun: this.sun });
  }

  applyVenueCarLighting() {
    if (this.circuit?.theme?.nightRig !== 'lasvegas' || !this.session) return;
    const patched = new Set();
    for (const entry of this.session.entries) entry.mesh?.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || patched.has(material) || material.userData?.shared
          || (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial)) continue;
        patched.add(material);
        const previousCompile = material.onBeforeCompile?.bind(material);
        const previousKey = material.customProgramCacheKey?.bind(material) || (() => '');
        material.onBeforeCompile = (shader, renderer) => {
          previousCompile?.(shader, renderer);
          const common = '#include <common>';
          const begin = '#include <begin_vertex>';
          const output = '#include <output_fragment>';
          if (!shader.vertexShader.includes(common) || !shader.vertexShader.includes(begin)
            || !shader.fragmentShader.includes(common) || !shader.fragmentShader.includes(output)) {
            throw new Error('Las Vegas rim-light shader chunks changed; refusing an unpinned patch');
          }
          shader.vertexShader = shader.vertexShader
            .replace(common, `${common}\nvarying vec3 vApexVegasWorld;`)
            .replace(begin, `${begin}\n  vApexVegasWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
          shader.fragmentShader = shader.fragmentShader
            .replace(common, `${common}\nvarying vec3 vApexVegasWorld;`)
            .replace(output, `
  float apexVegasBand = mod(floor((dot(vApexVegasWorld.xz, vec2(0.70710678)) / 100.0) + 4096.0), 4.0);
  vec3 apexVegasWash = apexVegasBand < 0.5 ? vec3(1.0, 0.0296, 0.2874)
    : apexVegasBand < 1.5 ? vec3(0.0176, 0.5776, 1.0)
    : apexVegasBand < 2.5 ? vec3(0.2582, 0.1022, 1.0)
    : vec3(1.0, 0.2582, 0.0176);
  float apexVegasRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 4.0);
  outgoingLight += apexVegasWash * apexVegasRim * 0.58;
  ${output}`);
        };
        material.customProgramCacheKey = () => `${previousKey()}|apex-lasvegas-rim-100m-v1`;
        material.userData.venueRimLight = {
          venue: 'lasvegas', cycleM: 100, colours: [0xff2f92, 0x24c8ff, 0x8b5cff, 0xff8b24],
          dryAir: true, bloomHaze: false,
        };
        material.needsUpdate = true;
      }
    });
  }

  // ---------- input ----------
  // Some environments (embedded browser panes, certain WebViews/IMEs) deliver
  // trusted key events with an EMPTY e.code and only e.key populated. Normalize
  // both channels to the e.code vocabulary so controls work everywhere.
  static normalizeKey(e) {
    if (e.code) return e.code;
    const k = e.key;
    if (!k) return '';
    if (k.startsWith('Arrow') || k === 'Escape' || k === 'Enter' || k === 'Tab') return k;
    if (k === ' ' || k === 'Spacebar') return 'Space';
    if (k.length === 1) {
      const c = k.toUpperCase();
      if (c >= 'A' && c <= 'Z') return 'Key' + c;
      if (c >= '0' && c <= '9') return 'Digit' + c;
    }
    return k;
  }

  onKey(e, down) {
    const code = Game.normalizeKey(e);
    if (!code) return;
    const driving = this.state === 'race' || this.state === 'quali';
    // stop the page from scrolling / space-activating buttons while driving
    if (driving && (code.startsWith('Arrow') || code === 'Space' || code === 'Enter')) e.preventDefault();
    if (e.repeat) return;
    if (!down) { this.keys[code] = false; return; }
    if (driving && this.awaitingStart && code === 'Enter') {
      this.beginSessionFromGate();
      return;
    }
    if (code === 'Escape') {
      if (driving) this.togglePause();
      return;
    }
    if (!driving || this.paused || this.awaitingStart) return;
    this.keys[code] = true;
    if (code === 'KeyE') this.queueShift(1);
    if (code === 'KeyQ') this.queueShift(-1);
    if (code === 'KeyV') {
      this.ersMode = ((this.ersMode ?? 1) + 1) % 3;
      this.hud.message(['ERS: HARVEST', 'ERS: BALANCED', 'ERS: ATTACK'][this.ersMode], this.ersMode === 2 ? 'yellow' : '');
    }
    if (code === 'KeyC') {
      this.camMode = (this.camMode + 1) % 4;
      this.hud.setCockpitMode(this.camMode === 1);
      this.hud.message(['CAMERA: CHASE', 'CAMERA: COCKPIT', 'CAMERA: T-CAM', 'CAMERA: NOSE'][this.camMode]);
      this.snapCamera();
    }
    if (code === 'KeyB') this.hud.nextCockpitPage();
    if (code === 'KeyJ') this.exportGhostReplay();
    if (code === 'KeyP') this.session && this.session.playerRequestBox();
    if (code === 'KeyN') {
      this.ui.settings.nametags = !this.ui.settings.nametags;
      this.ui.saveSettings();
      this.session && this.session.setNametags(this.ui.settings.nametags);
    }
    if (code === 'KeyM') {
      this.ui.settings.volume = this.ui.settings.volume > 0 ? 0 : 0.8;
      this.ui.saveSettings();
      this.audio.setVolume(this.ui.settings.volume);
    }
  }

  togglePause(force) {
    const want = force !== undefined ? force : !this.paused;
    if (this.onboardingActive && !want) return;
    this.paused = want;
    this.resetSimulationTiming();
    if (want) {
      this.ui.showPause();
      this.audio.stopEngine();
      if (this.session && this.session.phase === 'lights' && this.audio.stopCrescendo) this.audio.stopCrescendo();
    }
    else {
      this.ui.hidePause();
      if (this.awaitingStart) {
        this.audio.stopEngine();
        this.hud.showSessionReady(() => this.beginSessionFromGate());
      } else if (documentIsActive()) this.audio.startEngine();
      else this.audio.stopEngine();
    }
  }

  beginSessionFromGate() {
    if (!this.awaitingStart) return false;
    this.awaitingStart = false;
    this.paused = false;
    this.hud.hideSessionReady();
    this.resetSimulationTiming();
    if (documentIsActive()) this.audio.startEngine();
    else this.audio.stopEngine();
    return true;
  }

  resetSimulationTiming() {
    // Rebase Three's wall clock as well as the fixed-step remainder so loading,
    // tab suspension and pause time cannot arrive as one large frame later.
    if (this.clock) this.clock.getDelta();
    this.fixedStep.reset();
    this.pacing = { steps: 0, simulatedDt: 0, alpha: 0, droppedDt: 0 };
    this.releaseDrivingInputs();
    this.session?.resetRenderState?.();
  }

  releaseDrivingInputs() {
    this.keys = {};
    this.keySteer = 0;
    this._steerInputMode = null;
    this._shiftQueue.length = 0;
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
    this._gamepadSteeringActive = false;
    this.hud?.clearTouchState?.();
  }

  queueShift(direction) {
    if (this._shiftQueue.length >= 8) return;
    this._shiftQueue.push(direction > 0 ? 1 : -1);
  }

  exportGhostReplay() {
    if (!this.timeTrial) {
      this.hud.message('GHOST EXPORT AVAILABLE IN TIME TRIAL', 'yellow');
      return false;
    }
    const ok = this.timeTrial.downloadReplay();
    this.hud.message(ok ? 'DETERMINISTIC GHOST JSON EXPORTED' : 'COMPLETE A LAP TO EXPORT', ok ? 'green' : 'yellow');
    return ok;
  }

  _nearbyOpponentAudio(session, player) {
    const entries = this._audioNearbyEntries;
    const distances = this._audioNearbyDistances;
    for (let i = 0; i < 4; i++) { entries[i] = null; distances[i] = Infinity; }
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    for (const entry of session?.entries || []) {
      if (entry.isPlayer || entry.dnf || entry.phys?.disabled) continue;
      const dx = entry.phys.pos.x - player.pos.x, dz = entry.phys.pos.z - player.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 70 * 70 || d2 >= distances[3]) continue;
      let slot = 3;
      while (slot > 0 && d2 < distances[slot - 1]) {
        distances[slot] = distances[slot - 1]; entries[slot] = entries[slot - 1]; slot--;
      }
      distances[slot] = d2; entries[slot] = entry;
    }
    const cues = this._audioOpponentCues;
    cues.length = 0;
    for (let i = 0; i < 4 && entries[i]; i++) {
      const other = entries[i].phys;
      const dx = other.pos.x - player.pos.x, dz = other.pos.z - player.pos.z;
      const cue = this._audioOpponentCuePool[i];
      cue.id = entries[i].driver?.id || String(i);
      cue.side = Math.sign(dx * fz - dz * fx) || 1;
      cue.distance = Math.sqrt(distances[i]);
      cue.relativeSpeed = other.v - player.v;
      cue.rpmFrac = other.rpmFrac;
      cue.intensity = Math.max(0, 1 - cue.distance / 70);
      cues.push(cue);
    }
    return cues;
  }

  _wheelLockup(physics) {
    let lockup = 0;
    for (const wheel of physics?.wheels || []) lockup = Math.max(lockup, -Number(wheel.slipRatio || 0));
    return Math.min(1, lockup);
  }

  playerInput(dt) {
    const k = this.keys;
    let digitalDir = 0;
    let digitalSteerActive = false;
    if (k.KeyA || k.ArrowLeft) { digitalDir += 1; digitalSteerActive = true; }
    if (k.KeyD || k.ArrowRight) { digitalDir -= 1; digitalSteerActive = true; }
    let throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
    let brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
    let boost = !!k.Space;
    const touch = this.hud.touchState;
    if (touch) {
      if (touch.left) { digitalDir += 1; digitalSteerActive = true; }
      if (touch.right) { digitalDir -= 1; digitalSteerActive = true; }
      if (touch.throttle) throttle = 1;
      if (touch.brake) brake = 1;
      if (touch.boost) boost = true;
    }
    let dir = digitalDir;
    let steerInputMode = digitalSteerActive ? 'digital' : null;
    let shiftUp = false, shiftDown = false;
    // gamepad
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp) {
      const ax = gp.axes[0] || 0;
      const axisMagnitude = Math.abs(ax);
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      const gamepadBoost = !!gp.buttons[0]?.pressed;
      const gamepadUp = !!gp.buttons[5]?.pressed;
      const gamepadDown = !!gp.buttons[4]?.pressed;
      const neutral = axisMagnitude <= 0.12 && rt <= 0.03 && lt <= 0.03 &&
        !gamepadBoost && !gamepadUp && !gamepadDown;
      if (this._gamepadNeedsNeutral) {
        // After pause/focus loss, require every relevant control to be released
        // once. This prevents a held trigger, stick or bumper from reasserting
        // input on the first resumed simulation tick.
        this._gamepadShiftUp = gamepadUp;
        this._gamepadShiftDown = gamepadDown;
        if (neutral) {
          this._gamepadNeedsNeutral = false;
          this._gamepadSteeringActive = false;
          this._gamepadShiftUp = false;
          this._gamepadShiftDown = false;
        }
      } else {
        // An actively held key/touch control always wins over a connected
        // controller's idle-axis drift. Analog steering remains unchanged when
        // no digital direction is being requested.
        if (!this._gamepadSteeringActive && axisMagnitude >= 0.22) {
          this._gamepadSteeringActive = true;
        } else if (this._gamepadSteeringActive && axisMagnitude <= 0.10) {
          this._gamepadSteeringActive = false;
        }
        if (this._gamepadSteeringActive && !digitalSteerActive) {
          const scaledAxis = Math.sign(ax) * Math.max(0, (axisMagnitude - 0.12) / 0.88);
          dir = -scaledAxis;
          steerInputMode = 'analog';
        }
        if (rt > 0.03) throttle = rt;
        if (lt > 0.03) brake = lt;
        if (gamepadBoost) boost = true;
        if (gamepadUp && !this._gamepadShiftUp) this.queueShift(1);
        if (gamepadDown && !this._gamepadShiftDown) this.queueShift(-1);
        this._gamepadShiftUp = gamepadUp;
        this._gamepadShiftDown = gamepadDown;
      }
    } else {
      this._gamepadShiftUp = false;
      this._gamepadShiftDown = false;
      this._gamepadNeedsNeutral = false;
      this._gamepadSteeringActive = false;
    }
    const phys = this.session?.player?.phys;
    if (this.ui.settings.autoGear) {
      this._shiftQueue.length = 0;
    } else if (phys && phys._shiftCooldown <= 0) {
      // Preserve press order and keep requests queued through the gearbox's
      // 150 ms cooldown. Impossible boundary shifts are discarded explicitly.
      while (this._shiftQueue.length) {
        const direction = this._shiftQueue[0];
        if ((direction > 0 && phys.gear >= 8) || (direction < 0 && phys.gear <= 1)) {
          this._shiftQueue.shift();
          continue;
        }
        this._shiftQueue.shift();
        shiftUp = direction > 0;
        shiftDown = direction < 0;
        break;
      }
    }
    const v = this.session?.player?.phys.v || 0;
    if (steerInputMode) this._steerInputMode = steerInputMode;
    const digitalResponse = steerInputMode === 'digital' ||
      (dir === 0 && this._steerInputMode === 'digital');
    const steeringTarget = steerInputMode === 'digital'
      ? dir * digitalSteeringLimit(v)
      : dir;
    this.keySteer = advanceSteeringInput(
      this.keySteer, steeringTarget, v, dt, digitalResponse, this.ui.settings.steeringResponse,
    );
    if (dir === 0 && this.keySteer === 0) this._steerInputMode = null;
    return { steer: this.keySteer, throttle, brake, boost, shiftUp, shiftDown, ersMode: this.ersMode ?? 1 };
  }

  // ---------- camera ----------
  // road height at (and ahead of) the player, for render-only elevation
  _roadY(p, aheadM = 0) {
    const c = this.circuit;
    if (!c || !c.heightAt) return 0;
    const sm = c.samples[p.sampleIdx];
    const along = (p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z;
    return c.heightAt(p.sampleIdx + (along + aheadM) / c.ds);
  }

  snapCamera() {
    const e = this.session?.focusEntry || this.session?.player;
    const p = e?.phys;
    if (!p) return;
    const pose = e.renderPose;
    const pos = pose ? this._camPlayerPos.set(pose.x, 0, pose.z) : p.pos;
    const heading = pose?.heading ?? p.heading;
    const ry = pose?.y ?? this._roadY(p);
    const speed = pose?.v ?? p.v;
    const f = this._camForward.set(Math.sin(heading), 0, Math.cos(heading));
    this.hud.setCockpitMode(this.camMode === 1);
    if (this.camMode === 0) {
      const framing = resolveChaseCamera(
        this.ui.settings.cameraProfile, speed, p.boosting, this._camFraming,
      );
      const aheadSample = this.circuit.samples[(p.sampleIdx + Math.round(framing.look / this.circuit.ds)) % this.circuit.N];
      const aim = this._camAhead.set(aheadSample.t.x, 0, aheadSample.t.z);
      this._camPos.copy(pos).addScaledVector(f, -framing.back).setY(ry + framing.height);
      this._camLook.copy(pos)
        .addScaledVector(f, framing.look * CAMERA_FRAMING.headingAimWeight)
        .addScaledVector(aim, framing.look * CAMERA_FRAMING.aheadAimWeight)
        .setY(this._roadY(p, framing.look) + CAMERA_FRAMING.lookHeightM);
      this._cameraFovTarget = framing.fov;
    } else if (this.camMode === 1) {
      const seatY = cockpitSeat(this.ui.settings.cockpitSeat);
      this._camPos.copy(pos).addScaledVector(f, 0.43).setY(ry + seatY);
      this._camLook.copy(pos).addScaledVector(f, 22).setY(this._roadY(p, 22) + 0.74);
      this._cameraFovTarget = cockpitFov(this.ui.settings.cockpitFov);
    } else if (this.camMode === 2) {
      this._camPos.copy(pos).addScaledVector(f, -0.75).setY(ry + 1.62);
      this._camLook.copy(pos).addScaledVector(f, 14).setY(this._roadY(p, 14) + 1.05);
      this._cameraFovTarget = 72 + speed * 0.045 + (p.boosting ? 2 : 0);
    } else {
      this._camPos.copy(pos).addScaledVector(f, 2.3).setY(ry + 0.6);
      this._camLook.copy(pos).addScaledVector(f, 18).setY(this._roadY(p, 18) + 0.5);
      this._cameraFovTarget = 75 + speed * 0.035 + (p.boosting ? 2 : 0);
    }
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
    this.camera.fov = this._cameraFovTarget;
    this.camera.updateProjectionMatrix();
  }

  updateCamera(dt) {
    const e = this.session?.focusEntry || this.session?.player;
    if (!e) return;
    const p = e.phys;
    const pose = e.renderPose;
    const pos = pose ? this._camPlayerPos.set(pose.x, 0, pose.z) : p.pos;
    const heading = pose?.heading ?? p.heading;
    const speed = pose?.v ?? p.v;
    const ry = pose?.y ?? this._roadY(p);
    const f = this._camForward.set(Math.sin(heading), 0, Math.cos(heading));
    this.hud.setCockpitMode(this.camMode === 1);
    const targetPos = this._camTargetPos;
    const targetLook = this._camTargetLook;
    let stiff = 5.5;
    if (e.pitState) {
      // hold camera during pit
      targetPos.copy(this._camPos);
      targetLook.copy(this._camLook);
    } else if (this.camMode === 0) {
      const framing = resolveChaseCamera(
        this.ui.settings.cameraProfile, speed, p.boosting, this._camFraming,
      );
      const aheadSample = this.circuit.samples[(p.sampleIdx + Math.round(framing.look / this.circuit.ds)) % this.circuit.N];
      const aim = this._camAhead.set(aheadSample.t.x, 0, aheadSample.t.z);
      targetPos.copy(pos).addScaledVector(f, -framing.back).setY(ry + framing.height);
      // Blend current heading with the circuit tangent ahead. The camera sees
      // into a hairpin before the chassis finishes rotating, which removes the
      // late snap/pan that made tight turns feel disconnected from steering.
      targetLook.copy(pos)
        .addScaledVector(f, framing.look * CAMERA_FRAMING.headingAimWeight)
        .addScaledVector(aim, framing.look * CAMERA_FRAMING.aheadAimWeight)
        .setY(this._roadY(p, framing.look) + CAMERA_FRAMING.lookHeightM);
      this._cameraFovTarget = framing.fov;
    } else if (this.camMode === 1) {
      // Driver-eye position is fixed to the monocoque, with only centimetres
      // of filtered force feedback. This gives speed/load information without
      // the horizon swings that make cockpit cameras uncomfortable.
      const seatY = cockpitSeat(this.ui.settings.cockpitSeat);
      const motion = this.ui.settings.headMotion === false ? 0 : 1;
      const lateral = this._camLeft.set(f.z, 0, -f.x);
      targetPos.copy(pos).addScaledVector(f, 0.43 - finiteCameraValue(p.pitch) * 0.08 * motion)
        .addScaledVector(lateral, -finiteCameraValue(p.steer) * 0.018 * motion)
        .setY(ry + seatY + (p.onKerb ? Math.sin(performance.now() * .045) * .008 * motion : 0));
      targetLook.copy(pos).addScaledVector(f, 22)
        .addScaledVector(lateral, -finiteCameraValue(p.steer) * 0.10 * motion)
        .setY(this._roadY(p, 22) + 0.74);
      stiff = 22;
      this._cameraFovTarget = cockpitFov(this.ui.settings.cockpitFov) + (p.boosting ? 1 : 0);
    } else if (this.camMode === 2) {
      // T-cam (onboard broadcast)
      targetPos.copy(pos).addScaledVector(f, -0.75).setY(ry + 1.62);
      targetLook.copy(pos).addScaledVector(f, 14).setY(this._roadY(p, 14) + 1.05);
      stiff = 16;
      this._cameraFovTarget = 72 + speed * 0.045 + (p.boosting ? 2 : 0);
    } else {
      targetPos.copy(pos).addScaledVector(f, 2.3).setY(ry + 0.6);
      targetLook.copy(pos).addScaledVector(f, 18).setY(this._roadY(p, 18) + 0.5);
      stiff = 18;
      this._cameraFovTarget = 75 + speed * 0.035 + (p.boosting ? 2 : 0);
    }
    const t = Math.min(1, stiff * dt);
    this._camPos.lerp(targetPos, t);
    this._camLook.lerp(targetLook, Math.min(1, (stiff + 4) * dt));
    this.camera.position.copy(this._camPos);
    // speed shake: high-frequency micro jitter, stronger on kerbs/grass
    const cockpitScale = this.camMode === 1 ? (this.ui.settings.headMotion === false ? 0 : 0.18) : 1;
    const shake = ((speed / 95) * 0.035 + (p.onKerb ? 0.05 : 0) +
      (p.offTrack ? 0.08 : 0) + (p.impactKick || 0) * 0.16) * cockpitScale;
    if (shake > 0.004 && !this.paused) {
      const tt = performance.now() * 0.001;
      const left = this._camLeft.set(f.z, 0, -f.x);
      this.camera.position.addScaledVector(left, (Math.sin(tt * 47.3) + Math.sin(tt * 91.7) * 0.5) * shake);
      this.camera.position.y += (Math.sin(tt * 53.1) + Math.sin(tt * 78.9) * 0.5) * shake * 0.6;
    }
    this.camera.lookAt(this._camLook);
    // speed/boost FOV
    const fovT = this._cameraFovTarget || 70;
    this.camera.fov += (fovT - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
    // sun shadow follows player (elevation-aware, or the frustum drifts off on climbs)
    if (this.sun) {
      this.sun.position.set(pos.x + 260, ry + 380, pos.z + 160);
      this.sun.target.position.set(pos.x, ry, pos.z);
    }
  }

  // ---------- main loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const rawDt = this.clock.getDelta();
    const renderDt = Math.min(rawDt, 0.05);
    if (!this.session || !this.scene) return;
    if (!this.paused) this.quality.update(rawDt);
    const s = this.session;

    if (!this.paused && !this.awaitingStart && (this.state === 'race' || this.state === 'quali')) {
      this.pacing = this.fixedStep.advance(rawDt, (dt) => {
        const weather = this.circuit?.advanceEnvironment?.(dt, s.entries);
        const trackState = this.circuit?.trackState;
        const visual = trackState?.visualState;
        const conditionsChanged = trackState &&
          (trackState !== this._trackConditionsSource || trackState.time !== this._trackConditionsTime);
        if (s.setTrackConditions && visual && conditionsChanged) {
          const player = s.player?.phys;
          const grip = player && this.circuit.gripAt
            ? this.circuit.gripAt(
              player.sampleIdx,
              player.lat,
              this._trackGripOptions,
              this._trackGripResult,
            ).multiplier : 1;
          s.setTrackConditions({
            wetness: visual.wetness,
            trackGrip: grip,
            rainfall: weather?.rainfall || 0,
          });
          this._trackConditionsSource = trackState;
          this._trackConditionsTime = trackState.time;
        }
        s.update(dt, this.playerInput(dt));
        if (this.effects) this.effects.update(dt, s.entries, this.circuit?.trackState);
        if (this.timeTrial) this._timeTrialStatus = this.timeTrial.update(dt);
      });
      s.render?.(this.pacing.alpha);

      // start lights choreography
      if (s.phase === 'lights' && s.lightsOn !== this._lightsShown) {
        if (this._lightsShown === 0 && this.audio.startCrescendo) this.audio.startCrescendo();
        this._lightsShown = s.lightsOn;
        this.hud.setLights(s.lightsOn);
        if (this.circuit.setStartLights) this.circuit.setStartLights(s.lightsOn);
        this.audio.countdownBeep(false);
      }
      if (s.lightsOut) {
        s.lightsOut = false;
        this.hud.lightsOutFlash();
        if (this.circuit.setStartLights) this.circuit.setStartLights(6);
        this.audio.countdownBeep(true);
        if (this.audio.crowdAmbience) this.audio.crowdAmbience(0.45);
      }
      // race-direction audio hooks (fields appear as feature agents land)
      if (s.vsc) {
        if (s.vsc.active && !this._vscAudio) { this._vscAudio = true; this.audio.vscBeep && this.audio.vscBeep(); }
        if (!s.vsc.active && this._vscAudio) { this._vscAudio = false; this.audio.vscBeep && this.audio.vscBeep(); }
      }
      if (s.radioQueue) {
        const n = s.radioQueue.length;
        if (n > (this._radioLen || 0) && this.audio.radioTone) this.audio.radioTone();
        this._radioLen = n;
      }
      const pps = s.player && s.player.pitState;
      if (pps && !this._pitAudio && pps.timer < 2.3) { this._pitAudio = true; this.audio.pitStop && this.audio.pitStop(); }
      if (!pps) this._pitAudio = false;
      // audio events
      if (s._wallEvent) { this.audio.wallImpact(s._wallEvent); s._wallEvent = 0; }
      if (s._touchEvent) { this.audio.carImpact(s._touchEvent); s._touchEvent = 0; }
      if (s._shiftEvent) { this.audio.shift(s._shiftEvent > 0 ? 1 : -1); s._shiftEvent = false; }

      const p = s.player?.phys;
      if (p) {
        // during the pit stop the car idles in the box — feed an idle snapshot
        // instead of the frozen pre-pit throttle/speed state
        this.audio.update(renderDt, s.player.pitState ? PIT_IDLE_AUDIO : {
          rpmFrac: Math.max(0, Math.min(1, (p.rpmFrac - 0.18) / 0.86)),
          throttle: p.throttle,
          brake: p.brake,
          speed: p.v,
          gear: p.gear,
          slip: p.slip,
          kerb: p.onKerb && p.v > 8,
          boost: p.boosting,
          offtrack: p.offTrack,
          wallScrape: p.wallScrape,
          carScrape: p.carScrape,
          contactSide: p.wallScrape >= p.carScrape
            ? (p.lat < 0 ? -1 : 1)
            : p.carScrapeSide,
          lockup: this._wheelLockup(p),
          surface: p.surface?.material,
          surfaceRoughness: Math.min(1, Math.abs(p.surface?.bump || 0) / 0.02),
          bottoming: Math.min(1, Math.abs(p.surface?.bump || 0) / 0.025 + (p.onKerb ? p.kerbScrub * 0.3 : 0)),
          damage: s.player?.damage ? Math.max(0, 1 - (s.player.damage.frontWing ?? 1)) : (s.player?.wingDamage || 0),
          wetness: p.surface?.wetness || this.circuit?.trackState?.visualState?.wetness || 0,
          rain: this.circuit?.weather?.current?.intensity || 0,
          spray: Math.min(1, (p.surface?.wetness || 0) * Math.max(0, p.v) / 55),
          cockpit: this.camMode === 1,
          load: Math.min(1, Math.hypot(p.longitudinalAcceleration || 0, p.lateralAcceleration || 0) / 35),
          ersDeploy: p.boosting || p.ersMode === 2,
          regen: p.ersMode === 0,
          opponents: this._nearbyOpponentAudio(s, p),
        });
        // close high-speed passes: panned doppler whoosh (audio has its own cooldown)
        if (this.audio.passBy && s.entries) {
          const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
          for (const e2 of s.entries) {
            if (e2.isPlayer || e2.dnf || e2.phys.disabled) continue;
            const dx = e2.phys.pos.x - p.pos.x, dz = e2.phys.pos.z - p.pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 13 * 13) continue;
            const rel = Math.abs(e2.phys.v - p.v);
            if (rel < 12) continue;
            const side = Math.sign(dx * fz - dz * fx) || 1; // left of travel = -1
            this.audio.passBy(side, Math.min(1, rel / 40));
            break;
          }
        }
      }
      this.hud.update(renderDt);
      this._simStatusTimer -= renderDt;
      if (this._simStatusTimer <= 0) {
        this._simStatusTimer = 0.25;
        this.hud.updateSimulationState?.(this.snapshot());
      }
      if (this._timeTrialStatus) {
        this.hud.updateTimeTrial(this._timeTrialStatus.personalBest, this._timeTrialStatus.delta);
      }

      // quali flow (timer guarded against session swaps / pause-quit races)
      if (this.state === 'quali' && !this.raceConfig.trial && s.qualiState === 'done' && !this._qualiDoneShown) {
        this._qualiDoneShown = true;
        this._qualiTimer = setTimeout(() => {
          this._qualiTimer = null;
          if (this.session !== s || this.state !== 'quali') return;
          this.audio.finishFanfare();
          this.hud.hide();
          this.audio.stopEngine();
          this.state = 'qualiResults';
          if (this.raceConfig.fullWeekend) {
            const practice = s.mode === 'practice';
            const stage = practice ? 'FP1' : (s.qualifying?.stage || 'Q1');
            const rows = practice
              ? s.practiceClassification()
              : s.currentQualifyingClassification();
            const nextLabel = practice ? 'START Q1 →'
              : stage === 'Q1' ? 'START Q2 →'
                : stage === 'Q2' ? 'START Q3 →' : 'START FORMATION LAP →';
            this.ui.showQualiResults(rows, this.raceConfig.driverId, this.raceConfig.race, {
              title: practice
                ? 'PRACTICE <small>FP1 CLASSIFICATION</small>'
                : `QUALIFYING <small>${stage} CLASSIFICATION</small>`,
              leaderLabel: practice ? 'P1' : 'POLE',
              primaryLabel: nextLabel,
              primaryAction: practice ? 'startPilotQualifying' : 'advancePilotQualifying',
              allowRestart: false,
              footer: `${this.raceConfig.race.gp} · ${stage} · every time earned on track`,
            });
          } else {
            this.ui.showQualiResults(s.qualiClassification(), this.raceConfig.driverId, this.raceConfig.race);
          }
        }, 1400);
      }
      // race results
      if (s.results && !this._resultsShown) {
        this._resultsShown = true;
        this.audio.finishFanfare();
        const results = s.results;
        // idempotent per attempt: the same config object survives restarts,
        // so a championship round can only ever be banked once
        if (this.raceConfig.champRound && !this.raceConfig._champRecorded) {
          this.raceConfig._champRecorded = true;
          this.champ.recordResult(
            results.map(r => ({ id: r.driver.id, dnf: !!r.dnf })),
            s.fastestLap?.driverId || null
          );
        }
        this._resultsTimer = setTimeout(() => {
          this._resultsTimer = null;
          if (this.session !== s || this.state !== 'race') return;
          this.hud.hide();
          this.audio.stopEngine();
          this.state = 'results';
          this.ui.showResults(results, s.fastestLap, this.raceConfig.race, 'race', !!this.raceConfig.champRound);
        }, 900);
      }
      this.updateCamera(renderDt);
      // AI detail selection uses the final smoothed/shaken camera for every
      // camera mode. RaceSession internally limits this presentation-only pass
      // to 10 Hz; callers that never invoke it retain full-fidelity cars.
      if (s.updateCarLod) s.updateCarLod(this.camera);
      // nametags are laid out in screen space (cap/clamp/overlap), which
      // needs this frame's final camera — so this runs after updateCamera
      if (s.updateNametags) s.updateNametags(this.camera, innerWidth, innerHeight);
    }
    const rendererInfo = this.renderer.info;
    rendererInfo.reset();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    const frameMs = rawDt * 1000;
    const telemetry = this._frameTelemetry;
    telemetry.count++;
    telemetry.lastMs = frameMs;
    telemetry.smoothedMs += (frameMs - telemetry.smoothedMs) * (telemetry.count === 1 ? 1 : 0.05);
    telemetry.maxMs = Math.max(telemetry.maxMs, frameMs);
    const render = rendererInfo.render;
    const renderTelemetry = this._renderTelemetry;
    renderTelemetry.calls = render.calls;
    renderTelemetry.triangles = render.triangles;
    renderTelemetry.points = render.points;
    renderTelemetry.lines = render.lines;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// idle-in-the-box audio snapshot (allocation-free: one shared object)
const PIT_IDLE_AUDIO = {
  rpmFrac: 0.06, throttle: 0.04, brake: 0, speed: 0, gear: 1,
  slip: false, kerb: false, boost: false, offtrack: false,
};

const game = new Game();
window.__game = game; // dev/test hook
