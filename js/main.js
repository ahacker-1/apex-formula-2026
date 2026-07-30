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
import { createRandom, deriveSeed, normalizeSeed } from './random.js';
import { TRACKS } from './tracks.js';
import { CALENDAR, DRIVERS } from './data.js';

const RETRY_SESSION_KEY = 'apexf1_retry_session_v1';

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
    this.renderer.toneMappingExposure = 1.05;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = null;
    this.circuit = null;
    this.session = null;
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 6500);
    this.camMode = 0; // 0 chase, 1 T-cam, 2 nose
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
    this.paused = false;
    this.raceConfig = null;
    this.clock = new THREE.Clock();
    this.fixedStep = new FixedStepAccumulator();
    this.pacing = { steps: 0, simulatedDt: 0, alpha: 0, droppedDt: 0 };
    this._shiftQueue = [];
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
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
      // so recovery remains correct if renderer internals change.
      this.renderer.info.autoReset = false;
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
    if (saved.mode !== 'race' && saved.mode !== 'quali') return null;
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
        if (payload === 'raceNow') {
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
      this.circuit = buildCircuit(cfg.race.trackId, track, this.scene);
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
        gridOrder: cfg.gridOrder || null,
        random: simulationRandom,
        seed: sessionSeed,
        onMessage: (t, c) => { this.hud.message(t, c); },
      });
      this.session.setNametags(this.ui.settings.nametags);
      this.hud.bindSession(this.session, this.circuit);
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
      this.state = cfg.mode === 'quali' ? 'quali' : 'race';
      this.updateTouchControls();
      this.snapCamera();
      // Circuit/PMREM/car construction is synchronous and can take hundreds of
      // milliseconds. Rebase after it so no build time becomes simulation time.
      this.resetSimulationTiming();
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
          if (documentIsActive()) this.audio.startEngine();
          else this.audio.stopEngine();
        });
      } else if (shouldPauseOnReady()) {
        // Visibility or window focus may have changed while assets/build ran.
        this.togglePause(true);
      } else {
        this.paused = false;
        if (documentIsActive()) this.audio.startEngine();
        else this.audio.stopEngine();
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
    this.hud.hide();
    this.audio.stopEngine();
    if (this.audio.crowdAmbience) this.audio.crowdAmbience(0);
    if (this.audio.stopCrescendo) this.audio.stopCrescendo();
    this._vscAudio = false; this._radioLen = 0; this._pitAudio = false;
    this._timeTrialStatus = null;
    this.onboardingActive = false;
    this.resetSimulationTiming();
    if (!keepConfig) this.paused = false;
  }

  setupEnvironment(effectsRandom = () => Math.random(), environmentKey) {
    this._celestialObjects = [];
    const th = this.circuit.theme;
    this.scene.fog = new THREE.Fog(th.fog, 300, 1600);
    // sky dome: gradient + soft clouds BAKED into the texture (day/dusk).
    // Clouds must never be separate transparent quads again -- sprites read as
    // tinted slab panes (removed in e29383d); baked into the dome they cannot.
    const skyTex = new THREE.CanvasTexture(TEX.skyDome(
      '#' + new THREE.Color(th.skyTop).getHexString(),
      '#' + new THREE.Color(th.skyBot).getHexString(),
      { clouds: !th.night, dusk: th.sunI < 2.2 }
    ));
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 24, 12),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    this.scene.add(sky);
    this.sky = sky;
    const hemi = new THREE.HemisphereLight(th.skyTop, th.ground, th.hemi);
    this.scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(th.sun, th.sunI);
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
      const amb = new THREE.AmbientLight(0x8899cc, 0.5);
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
    } else {
      // stars + moon
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
        map: mkTex(starC), color: 0xcdd8ff, size: 5, sizeAttenuation: false,
        fog: false, transparent: true, opacity: 0.8, depthWrite: false,
      }));
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
      moon.scale.setScalar(190);
      moon.position.set(-1200, 1300, -900);
      this.scene.add(moon);
      this._celestialObjects.push(moon);
    }

    this.effects = new Effects(this.scene, effectsRandom);
    // The controller selects its initial tier before a session owns an Effects
    // instance, so apply it once here as well as in the live tier callback.
    this.effects.setQualityTier(this.quality.tier);

    // Lighting: photographic HDRI sky + true IBL when loaded; PMREM-from-dome
    // fallback renders immediately while only this session's theme downloads.
    const sceneForEnvironment = this.scene;
    const applyHDRI = (hdr) => {
      if (this.scene !== sceneForEnvironment || !hdr) return;
      sceneForEnvironment.environment = hdr;
      sceneForEnvironment.environmentIntensity = th.night ? 0.55 : 0.9;
      if (th.night) {
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
      this.scene.environmentIntensity = th.night ? 0.5 : 0.85;
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
    this.gtao = new ScaledGTAOPass(this.scene, this.camera, innerWidth, innerHeight);
    this.gtao.output = ScaledGTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.72; // 0.9 visibly darkened additive effects (sparks) in AO-heavy corners
    this.gtao.enabled = this.ui.settings.gtao !== false;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      // Night fixtures should glow without turning white bodywork and the
      // racing line into a single clipped shape.  A higher threshold keeps the
      // effect on emissive lamps while preserving paint and asphalt detail.
      th.night ? 0.34 : 0.18,  // strength
      0.55,                    // radius
      th.night ? 0.72 : 0.86   // threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);
    this.quality.bind({ composer: this.composer, gtao: this.gtao, bloom: this.bloom, sun: this.sun });
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
    if (driving && (code.startsWith('Arrow') || code === 'Space')) e.preventDefault();
    if (e.repeat) return;
    if (!down) { this.keys[code] = false; return; }
    if (code === 'Escape') {
      if (driving) this.togglePause();
      return;
    }
    if (!driving || this.paused) return;
    this.keys[code] = true;
    if (code === 'KeyE') this.queueShift(1);
    if (code === 'KeyQ') this.queueShift(-1);
    if (code === 'KeyV') {
      this.ersMode = ((this.ersMode ?? 1) + 1) % 3;
      this.hud.message(['ERS: HARVEST', 'ERS: BALANCED', 'ERS: ATTACK'][this.ersMode], this.ersMode === 2 ? 'yellow' : '');
    }
    if (code === 'KeyC') this.camMode = (this.camMode + 1) % 3;
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
      if (documentIsActive()) this.audio.startEngine();
      else this.audio.stopEngine();
    }
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
    this._shiftQueue.length = 0;
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
    this.hud?.clearTouchState?.();
  }

  queueShift(direction) {
    if (this._shiftQueue.length >= 8) return;
    this._shiftQueue.push(direction > 0 ? 1 : -1);
  }

  playerInput(dt) {
    const k = this.keys;
    let dir = 0;
    if (k.KeyA || k.ArrowLeft) dir += 1;
    if (k.KeyD || k.ArrowRight) dir -= 1;
    let throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
    let brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
    let boost = !!k.Space;
    const touch = this.hud.touchState;
    if (touch) {
      if (touch.left) dir += 1;
      if (touch.right) dir -= 1;
      if (touch.throttle) throttle = 1;
      if (touch.brake) brake = 1;
      if (touch.boost) boost = true;
    }
    let shiftUp = false, shiftDown = false;
    // gamepad
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp) {
      const ax = gp.axes[0] || 0;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      const gamepadBoost = !!gp.buttons[0]?.pressed;
      const gamepadUp = !!gp.buttons[5]?.pressed;
      const gamepadDown = !!gp.buttons[4]?.pressed;
      const neutral = Math.abs(ax) <= 0.08 && rt <= 0.03 && lt <= 0.03 &&
        !gamepadBoost && !gamepadUp && !gamepadDown;
      if (this._gamepadNeedsNeutral) {
        // After pause/focus loss, require every relevant control to be released
        // once. This prevents a held trigger, stick or bumper from reasserting
        // input on the first resumed simulation tick.
        this._gamepadShiftUp = gamepadUp;
        this._gamepadShiftDown = gamepadDown;
        if (neutral) {
          this._gamepadNeedsNeutral = false;
          this._gamepadShiftUp = false;
          this._gamepadShiftDown = false;
        }
      } else {
        if (Math.abs(ax) > 0.08) dir = -ax;
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
    // steering shaping: slower ramp at speed for keyboard
    const v = this.session?.player?.phys.v || 0;
    const rate = 3.4 / (1 + v * 0.02);
    const ret = 6 / (1 + v * 0.01);
    if (dir !== 0) this.keySteer += (dir - this.keySteer) * Math.min(1, rate * dt);
    else this.keySteer += (0 - this.keySteer) * Math.min(1, ret * dt);
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
    const e = this.session?.player;
    const p = e?.phys;
    if (!p) return;
    const pose = e.renderPose;
    const pos = pose ? this._camPlayerPos.set(pose.x, 0, pose.z) : p.pos;
    const heading = pose?.heading ?? p.heading;
    const ry = pose?.y ?? this._roadY(p);
    const speed = pose?.v ?? p.v;
    const f = this._camForward.set(Math.sin(heading), 0, Math.cos(heading));
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
    const e = this.session?.player;
    if (!e) return;
    const p = e.phys;
    const pose = e.renderPose;
    const pos = pose ? this._camPlayerPos.set(pose.x, 0, pose.z) : p.pos;
    const heading = pose?.heading ?? p.heading;
    const speed = pose?.v ?? p.v;
    const ry = pose?.y ?? this._roadY(p);
    const f = this._camForward.set(Math.sin(heading), 0, Math.cos(heading));
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
    const shake = (speed / 95) * 0.035 + (p.onKerb ? 0.05 : 0) + (p.offTrack ? 0.08 : 0);
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

    if (!this.paused && (this.state === 'race' || this.state === 'quali')) {
      this.pacing = this.fixedStep.advance(rawDt, (dt) => {
        s.update(dt, this.playerInput(dt));
        if (this.effects) this.effects.update(dt, s.entries);
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
      if (s._wallEvent) { this.audio.collision(s._wallEvent); s._wallEvent = 0; }
      if (s._touchEvent) { this.audio.collision(s._touchEvent); s._touchEvent = 0; }
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
          this.ui.showQualiResults(s.qualiClassification(), this.raceConfig.driverId, this.raceConfig.race);
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
