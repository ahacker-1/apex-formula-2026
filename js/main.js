// APEX FORMULA 2026 — boot, renderer, cameras, input, and the game state machine.
import * as THREE from 'three';
import { EffectComposer } from '../lib/postprocessing/EffectComposer.js';
import { RenderPass } from '../lib/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../lib/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from '../lib/postprocessing/GTAOPass.js';
import { OutputPass } from '../lib/postprocessing/OutputPass.js';
import { RGBELoader } from '../lib/loaders/RGBELoader.js';

// photographic HDRI skies (CC0, PolyHaven) — loaded once, shared across sessions
const HDRI = { day: null, dusk: null, night: null, _loaded: false };
function loadHDRIs() {
  if (HDRI._loaded) return;
  HDRI._loaded = true;
  const loader = new RGBELoader();
  for (const key of ['day', 'dusk', 'night']) {
    loader.load(`textures/hdri/${key}.hdr`, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      HDRI[key] = tex;
    }, undefined, () => { /* fallback: procedural sky remains */ });
  }
}
import { buildCircuit } from './trackBuilder.js';
import { RaceSession } from './race.js';
import { HUD } from './hud.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { Championship } from './championship.js';
import { Effects } from './effects.js';
import * as TEX from './textures.js';
import { TRACKS } from './tracks.js';
import { CALENDAR } from './data.js';

class Game {
  constructor() {
    this.state = 'boot';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

    this.hud = new HUD(document.getElementById('hud'));
    this.audio = new AudioEngine();
    this.champ = new Championship();
    this.ui = new UI((action, payload) => this.onUI(action, payload));

    this.keys = {};
    this.keySteer = 0;
    this.paused = false;
    this.raceConfig = null;
    this.clock = new THREE.Clock();
    this._lightsShown = 0;
    this._resultsShown = false;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      if (this.composer) this.composer.setSize(innerWidth, innerHeight);
    });
    addEventListener('keydown', e => this.onKey(e, true));
    addEventListener('keyup', e => this.onKey(e, false));
    // audio unlock on first gesture
    const unlock = () => {
      this.audio.init();
      this.audio.setVolume(this.ui.settings.volume);
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.stopEngine();
      else if ((this.state === 'race' || this.state === 'quali') && !this.paused) this.audio.startEngine();
    });

    this.boot();
    this.loop();
  }

  // ---------- boot ----------
  async boot() {
    loadHDRIs();
    const bar = document.getElementById('boot-progress');
    const status = document.getElementById('boot-status');
    // preload photographic textures (best-effort; procedural art is the fallback)
    const photoManifest = {
      asphalt: 'textures/asphalt.png', grass: 'textures/grass.png',
      gravel: 'textures/gravel.png', crowd: 'textures/crowd.png',
      facadeDay: 'textures/facade-day.png', facadeNight: 'textures/facade-night.png',
      treeBroadleaf: 'textures/tree-broadleaf.png', treePine: 'textures/tree-pine.png',
      treePalm: 'textures/tree-palm.png', scrub: 'textures/scrub.png',
    };
    status.textContent = 'LOADING CIRCUIT PHOTOGRAPHY…';
    await Promise.allSettled(Object.entries(photoManifest).map(([k, url]) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => { TEX.registerPhoto(k, img); res(); };
        img.onerror = rej;
        img.src = url;
      })));
    status.textContent = 'LOADING CAR MODEL…';
    await import('./car.js').then((m) => m.preloadCarModel());
    status.textContent = 'LOADING SOUND PACK…';
    if (this.audio.loadSamplePack) await this.audio.loadSamplePack('sounds/').catch(() => {});
    const steps = [
      ['VERIFYING 2026 ENTRY LIST — 11 TEAMS · 22 DRIVERS', 25],
      ['LOADING 24-ROUND CALENDAR', 45],
      ['CALIBRATING ACTIVE AERO — X/Z MODES', 65],
      ['SYNCING MANUAL OVERRIDE DEPLOYMENT', 85],
      ['READY', 100],
    ];
    for (const [txt, pct] of steps) {
      status.textContent = txt;
      bar.style.width = pct + '%';
      await sleep(260);
    }
    this.state = 'menu';
    this.ui.showMain(this.champ);
  }

  // ---------- UI events ----------
  onUI(action, payload) {
    this.audio.uiClick && this.audio.uiClick();
    switch (action) {
      case 'menu':
        if (payload === 'quick') { this.state = 'team'; this.ui.showTeamSelect('quick'); }
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
        this.startSession({ race: cfg.race, driverId: cfg.driverId, mode: 'race', gridOrder: grid, champRound: cfg.champRound });
        break;
      }
      case 'restartRace':
        this.startSession(this.raceConfig);
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
        if (this.gtao) this.gtao.enabled = payload.gtao !== false;
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
            this.teardownSession(true);
            this.state = 'results';
            this.ui.showResults([{ bestLap: p.bestLap }], null, this.raceConfig.race, 'trial', false);
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
    this.raceConfig = cfg;
    this.teardownSession();
    const track = TRACKS[cfg.race.trackId];
    this.state = 'loading';
    this.ui.showLoading(cfg.race, track);
    this._resultsShown = false;
    this._lightsShown = 0;
    this._qualiDoneShown = false;
    this.ersMode = 1; // every session starts in BALANCED
    // let the loading screen paint before the (sync) circuit build
    setTimeout(() => {
      this.scene = new THREE.Scene();
      this.circuit = buildCircuit(cfg.race.trackId, track, this.scene);
      this.setupEnvironment();
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
        onMessage: (t, c) => { this.hud.message(t, c); },
      });
      this.session.setNametags(this.ui.settings.nametags);
      this.hud.bindSession(this.session, this.circuit);
      this.hud.showPitOverlay(k => {
        this.session.playerChooseTyre(k);
        this.audio.uiConfirm();
      });
      this.ui.hideAll();
      this.hud.show();
      this.state = cfg.mode === 'quali' ? 'quali' : 'race';
      this.audio.startEngine();
      this.snapCamera();
    }, 60);
  }

  teardownSession(keepConfig = false) {
    clearTimeout(this._qualiTimer); this._qualiTimer = null;
    clearTimeout(this._resultsTimer); this._resultsTimer = null;
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
    if (this.effects) { this.effects.dispose(); this.effects = null; }
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose && pass.dispose();
      this.composer.dispose();
      this.composer = null; this.bloom = null; this.gtao = null;
    }
    this.hemi = null;
    this.scene = null;
    this.hud.hide();
    this.audio.stopEngine();
    if (this.audio.crowdAmbience) this.audio.crowdAmbience(0);
    if (this.audio.stopCrescendo) this.audio.stopCrescendo();
    this._vscAudio = false; this._radioLen = 0; this._pitAudio = false;
    if (!keepConfig) this.paused = false;
  }

  setupEnvironment() {
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
      // No cloud sprites: semi-transparent sky quads read as tinted slabs at
      // certain angles (verified by hiding all sprites — sky went clean).
      // Clouds belong painted into the sky-dome texture, where alpha blending
      // and sprite shear cannot produce panes.
    } else {
      // stars + moon
      const starGeo = new THREE.BufferGeometry();
      const sp = new Float32Array(420 * 3);
      for (let i = 0; i < 420; i++) {
        const az = Math.random() * Math.PI * 2, el = Math.random() * Math.PI * 0.42 + 0.14;
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
    }

    this.effects = new Effects(this.scene);

    // lighting: photographic HDRI sky + true IBL when loaded; PMREM-from-dome fallback
    const hdr = HDRI[th.night ? 'night' : th.sunI < 2.2 ? 'dusk' : 'day'];
    if (hdr) {
      // HDRI always drives LIGHTING (environment); but the day/dusk panoramas
      // carry baked structures on their horizons, so only night (a clean
      // moonlit sky) is shown as the visible backdrop — day/dusk keep the
      // procedural dome and get the photographic light without the photobombs.
      this.scene.environment = hdr;
      this.scene.environmentIntensity = th.night ? 0.55 : 0.9;
      if (th.night) {
        this.scene.background = hdr;
        this.scene.backgroundIntensity = 0.7;
        sky.visible = false;
      } else {
        this.scene.background = null;
        sky.visible = true;
      }
      this._envIsHDRI = true;
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
    }

    // post-processing: AO grounds everything, bloom lifts lights, then output
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.72; // 0.9 visibly darkened additive effects (sparks) in AO-heavy corners
    this.gtao.enabled = this.ui.settings.gtao !== false;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      th.night ? 0.5 : 0.18,   // strength
      0.55,                    // radius
      th.night ? 0.6 : 0.86    // threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(innerWidth, innerHeight);
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
    this.keys[code] = down;
    if (!down) return;
    if (code === 'Escape') {
      if (driving) this.togglePause();
      return;
    }
    if (!driving || this.paused) return;
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
    this.paused = want;
    if (want) {
      this.ui.showPause();
      this.audio.stopEngine();
      if (this.session && this.session.phase === 'lights' && this.audio.stopCrescendo) this.audio.stopCrescendo();
    }
    else { this.ui.hidePause(); this.audio.startEngine(); }
  }

  playerInput() {
    const k = this.keys;
    let dir = 0;
    if (k.KeyA || k.ArrowLeft) dir += 1;
    if (k.KeyD || k.ArrowRight) dir -= 1;
    let throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
    let brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
    let boost = !!k.Space;
    // consume shift presses so each tap = one gear
    let shiftUp = !!k.KeyE, shiftDown = !!k.KeyQ;
    k.KeyE = false; k.KeyQ = false;
    // gamepad
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp) {
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.08) dir = -ax;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (rt > 0.03) throttle = rt;
      if (lt > 0.03) brake = lt;
      if (gp.buttons[0]?.pressed) boost = true;
      if (gp.buttons[5]?.pressed) shiftUp = true;
      if (gp.buttons[4]?.pressed) shiftDown = true;
    }
    // steering shaping: slower ramp at speed for keyboard
    const v = this.session?.player?.phys.v || 0;
    const rate = 3.4 / (1 + v * 0.02);
    const ret = 6 / (1 + v * 0.01);
    if (dir !== 0) this.keySteer += (dir - this.keySteer) * Math.min(1, rate * this._dt);
    else this.keySteer += (0 - this.keySteer) * Math.min(1, ret * this._dt);
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
    const p = this.session?.player?.phys;
    if (!p) return;
    const ry = this._roadY(p);
    const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    this._camPos.copy(p.pos).addScaledVector(f, -9).add(new THREE.Vector3(0, ry + 3.6, 0));
    this._camLook.copy(p.pos).setY(ry);
  }

  updateCamera(dt) {
    const e = this.session?.player;
    if (!e) return;
    const p = e.phys;
    const ry = this._roadY(p);
    const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    let targetPos, targetLook, stiff = 5.5;
    if (e.pitState) {
      // hold camera during pit
      targetPos = this._camPos;
      targetLook = this._camLook;
    } else if (this.camMode === 0) {
      // broadcast-style chase: lower, tighter, sits into the car
      const back = 7.6 + p.v * 0.04;
      targetPos = p.pos.clone().addScaledVector(f, -back).setY(ry + 2.55 + p.v * 0.009);
      targetLook = p.pos.clone().addScaledVector(f, 10).setY(this._roadY(p, 10) + 0.85);
    } else if (this.camMode === 1) {
      // T-cam (onboard broadcast)
      targetPos = p.pos.clone().addScaledVector(f, -0.75).setY(ry + 1.62);
      targetLook = p.pos.clone().addScaledVector(f, 14).setY(this._roadY(p, 14) + 1.05);
      stiff = 16;
    } else {
      targetPos = p.pos.clone().addScaledVector(f, 2.3).setY(ry + 0.6);
      targetLook = p.pos.clone().addScaledVector(f, 18).setY(this._roadY(p, 18) + 0.5);
      stiff = 18;
    }
    const t = Math.min(1, stiff * dt);
    this._camPos.lerp(targetPos, t);
    this._camLook.lerp(targetLook, Math.min(1, (stiff + 4) * dt));
    this.camera.position.copy(this._camPos);
    // speed shake: high-frequency micro jitter, stronger on kerbs/grass
    const shake = (p.v / 95) * 0.035 + (p.onKerb ? 0.05 : 0) + (p.offTrack ? 0.08 : 0);
    if (shake > 0.004 && !this.paused) {
      const tt = performance.now() * 0.001;
      const left = new THREE.Vector3(f.z, 0, -f.x);
      this.camera.position.addScaledVector(left, (Math.sin(tt * 47.3) + Math.sin(tt * 91.7) * 0.5) * shake);
      this.camera.position.y += (Math.sin(tt * 53.1) + Math.sin(tt * 78.9) * 0.5) * shake * 0.6;
    }
    this.camera.lookAt(this._camLook);
    // speed/boost FOV
    const fovT = 70 + p.v * 0.11 + (p.boosting ? 4 : 0);
    this.camera.fov += (fovT - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
    // sun shadow follows player (elevation-aware, or the frustum drifts off on climbs)
    if (this.sun) {
      this.sun.position.set(p.pos.x + 260, ry + 380, p.pos.z + 160);
      this.sun.target.position.set(p.pos.x, ry, p.pos.z);
    }
  }

  // ---------- main loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._dt = dt;
    if (!this.session || !this.scene) return;
    const s = this.session;

    if (!this.paused && (this.state === 'race' || this.state === 'quali')) {
      s.update(dt, this.playerInput());

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
        this.audio.update(dt, s.player.pitState ? PIT_IDLE_AUDIO : {
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
      this.hud.update(dt);
      if (this.effects) this.effects.update(dt, s.entries);

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
      this.updateCamera(dt);
      // nametags are laid out in screen space (cap/clamp/overlap), which
      // needs this frame's final camera — so this runs after updateCamera
      if (s.updateNametags) s.updateNametags(this.camera, innerWidth, innerHeight);
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
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
