// Broadcast-style HUD: position tower, timing, sector bar, gap widget, dash,
// minimap, VSC / fastest-lap banners, engineer radio, start lights, pit overlay.
// Pure DOM/canvas over the WebGL view.
//
// Every field consumed off `session` / `entry` beyond the original race.js
// contract is treated as optional: the HUD renders the extra furniture only
// when the data is actually present, and degrades to the classic layout
// otherwise. Nothing here writes to the session except shifting radioQueue,
// which is the documented hand-off for engineer messages.
import { fmtTime } from './format.js';
import { CockpitView } from './cockpit.js';

const SECTORS = 3;
const GAP_HZ = 2;              // gap widget refresh rate
const GAP_TREND_WINDOW = 2.0;  // seconds of history for the gain/loss arrows
const GAP_TREND_EPS = 0.03;    // dead-band so the arrows don't strobe
const TOWER_GAP_CYCLE = 12;    // seconds between INTERVAL <-> LEADER
const FLASH_MS = 1200;         // position-change row pulse
const RADIO_LIFE = 4.0;        // radio card auto-dismiss
const FL_BANNER_MS = 2500;     // fastest-lap sweep duration

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// sector times read as ss.sss on F1 TV; fall back to m:ss.sss for silly values
function fmtSector(t) {
  const v = num(t);
  if (v == null) return '';
  return v < 60 ? v.toFixed(3) : fmtTime(v);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div id="hud-live-polite" class="hud-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
      <div id="hud-live-assertive" class="hud-sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>
      <div id="vscbanner" role="group" aria-label="Race control banner"><span id="vsc-text">VIRTUAL SAFETY CAR</span><span id="vsc-count"></span></div>
      <div id="tower" role="group" aria-label="Race position tower">
        <div class="tower-head"><span id="tw-title">RACE</span><span class="tower-head-right"><span class="gapmode" id="tw-gapmode"></span><span class="lapcount" id="tw-lap"></span></span></div>
        <div id="tw-rows"></div>
      </div>
      <div id="timing" role="group" aria-label="Lap timing">
        <div class="timing-box"><div class="lbl">POS</div><div class="val" id="t-pos">—</div><div class="posdelta" id="t-posdelta"></div></div>
        <div class="timing-box"><div class="lbl">LAP</div><div class="val" id="t-lap">—</div></div>
        <div class="timing-box"><div class="lbl">CURRENT</div><div class="val" id="t-cur">—</div></div>
        <div class="timing-box"><div class="lbl">LAST</div><div class="val" id="t-last">—</div></div>
        <div class="timing-box"><div class="lbl">BEST</div><div class="val purple" id="t-best">—</div></div>
        <div class="timing-box" id="tt-delta-box"><div class="lbl">DELTA</div><div class="val" id="t-delta">—</div></div>
      </div>
      <div id="sectorbar" role="group" aria-label="Sector timing"></div>
      <div id="gapwidget" role="group" aria-label="Cars ahead and behind"></div>
      <div id="flbanner" role="group" aria-label="Fastest lap display"></div>
      <div id="radiocard" role="group" aria-label="Race engineer message"></div>
      <div id="dash" role="group" aria-label="Car speed and energy status">
        <div class="revlights" id="revlights"></div>
        <div class="dash-main">
          <div class="gear" id="d-gear">N</div>
          <div class="speed"><div class="v" id="d-speed">0</div><div class="u">KM/H</div></div>
        </div>
        <div class="bars">
          <div class="bar-row"><span class="lbl">THR</span><div class="bar-track"><div class="bar-fill thr" id="b-thr"></div></div></div>
          <div class="bar-row"><span class="lbl">BRK</span><div class="bar-track"><div class="bar-fill brk" id="b-brk"></div></div></div>
          <div class="bar-row"><span class="lbl">ERS</span><div class="bar-track"><div class="bar-fill ers" id="b-ers"></div></div></div>
        </div>
        <div class="modes">
          <div class="mode-pill z" id="m-z">Z-MODE</div>
          <div class="mode-pill" id="m-x">X-MODE</div>
          <div class="mode-pill boost" id="m-ovr">OVERRIDE</div>
        </div>
      </div>
      <div id="carstat" role="group" aria-label="Tyre, fuel, and pit status">
        <div class="row"><span class="lbl">TYRE</span><span class="val" id="c-tyre">MEDIUM</span></div>
        <div class="row"><div class="bar-track" style="flex:1;height:6px;background:#26262f;border-radius:4px;overflow:hidden"><div id="c-wear" style="height:100%;width:100%;background:var(--green)"></div></div></div>
        <div class="row"><span class="lbl">FUEL</span><span class="val" id="c-fuel">100%</span></div>
        <div class="row"><span class="lbl">PIT</span><span class="val" id="c-box">—</span></div>
      </div>
      <canvas id="minimap" width="200" height="178" role="img" aria-label="Circuit minimap with car positions"></canvas>
      <div id="race-msg" role="group" aria-label="Race messages"></div>
      <div id="startlights" role="img" aria-label="Race start lights"></div>
      <div id="bigflash" role="group" aria-label="Race event banner"></div>
      <div id="session-ready" data-sim-start-gate role="dialog" aria-modal="false"
        aria-labelledby="session-ready-title" aria-hidden="true">
        <div class="session-ready-card">
          <span>CAR READY · CHASE CAMERA</span>
          <strong id="session-ready-title">PRESS ENTER TO START</strong>
          <button type="button" id="session-ready-go">START SESSION</button>
        </div>
      </div>
      <div id="sim-state-strip" role="status" aria-live="polite">
        <span data-sim-state="weather"></span>
        <span data-sim-state="damage"></span>
        <span data-sim-state="strategy"></span>
        <span data-sim-state="race-control"></span>
      </div>
      <div class="boost-vignette" id="boostvin"></div>
      <div id="cockpit-view" data-sim-panel="cockpit" aria-label="Seated Formula cockpit"></div>
      <div id="pit-overlay" role="dialog" aria-modal="false" aria-label="Select tyre compound" aria-hidden="true">
        <h3>SELECT TYRE COMPOUND</h3>
        <div class="tyre-choices">
          <button class="tyre-btn S" data-c="S"><div class="ring"></div><b>SOFT</b><small>FAST · HIGH DEG</small></button>
          <button class="tyre-btn M" data-c="M"><div class="ring"></div><b>MEDIUM</b><small>BALANCED</small></button>
          <button class="tyre-btn H" data-c="H"><div class="ring"></div><b>HARD</b><small>DURABLE</small></button>
          <button class="tyre-btn I" data-c="I"><div class="ring"></div><b>INTER</b><small>DAMP · LIGHT RAIN</small></button>
          <button class="tyre-btn W" data-c="W"><div class="ring"></div><b>WET</b><small>HEAVY RAIN</small></button>
        </div>
      </div>
      <div id="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-hidden="true">
        <div class="onboarding-card">
          <span class="eyebrow">WELCOME TO APEX FORMULA</span>
          <h2 id="onboarding-title">THREE THINGS BEFORE LIGHTS OUT</h2>
          <div class="onboarding-grid">
            <div><b>1 · DRIVE</b><span><kbd>↑</kbd> throttle, <kbd>↓</kbd> brake/reverse, <kbd>←</kbd><kbd>→</kbd> steer.</span></div>
            <div><b>2 · DEPLOY</b><span>Hold <kbd>SPACE</kbd> for electric override. Tap <kbd>V</kbd> to change ERS mode.</span></div>
            <div><b>3 · ADAPT</b><span><kbd>C</kbd> enters cockpit/cycles cameras. <kbd>B</kbd> changes dash page. <kbd>ESC</kbd> pauses.</span></div>
          </div>
          <button type="button" id="onboarding-go">GOT IT — START DRIVING</button>
        </div>
      </div>
      <div id="touch-controls" aria-label="Touch driving controls">
        <div class="touch-steer">
          <button type="button" data-touch="left" aria-label="Steer left">◀</button>
          <button type="button" data-touch="right" aria-label="Steer right">▶</button>
        </div>
        <button type="button" class="touch-pause" data-touch="pause" aria-label="Pause">Ⅱ</button>
        <div class="touch-pedals">
          <button type="button" class="touch-boost" data-touch="boost" aria-label="Electric override">OVR</button>
          <button type="button" class="touch-brake" data-touch="brake" aria-label="Brake">BRK</button>
          <button type="button" class="touch-throttle" data-touch="throttle" aria-label="Throttle">THR</button>
        </div>
      </div>`;
    root.setAttribute('aria-label', 'Driving heads-up display');
    root.setAttribute('aria-hidden', 'true');
    this.cockpit = new CockpitView(this.$('cockpit-view'));
    // rev lights: 5 green, 5 red, 5 blue
    const rl = this.$('revlights');
    this._leds = [];
    for (let i = 0; i < 15; i++) {
      const led = document.createElement('i');
      led.className = i < 5 ? 'g' : i < 10 ? 'r' : 'b';
      rl.appendChild(led);
      this._leds.push(led);
    }
    // start lights: 5 columns x 2 lamps
    const sl = this.$('startlights');
    this._lampCols = [];
    for (let i = 0; i < 5; i++) {
      const col = document.createElement('div');
      col.className = 'col';
      col.appendChild(el('div', 'lamp'));
      col.appendChild(el('div', 'lamp'));
      sl.appendChild(col);
      this._lampCols.push(col);
    }
    this.$('pit-overlay').addEventListener('click', ev => {
      const b = ev.target.closest('.tyre-btn');
      if (b && this._pitCb) { this._pitCb(b.dataset.c); }
    });
    this.touchState = { left: false, right: false, throttle: false, brake: false, boost: false };
    this.$('touch-controls').addEventListener('pointerdown', (event) => {
      const button = event.target.closest('[data-touch]');
      if (!button) return;
      const control = button.dataset.touch;
      event.preventDefault();
      if (control === 'pause') { this._touchPause?.(); return; }
      this.touchState[control] = true;
      button.classList.add('pressed');
      button.setPointerCapture?.(event.pointerId);
    });
    const releaseTouch = (event) => {
      const button = event.target.closest?.('[data-touch]');
      if (!button) return;
      const control = button.dataset.touch;
      if (control !== 'pause') this.touchState[control] = false;
      button.classList.remove('pressed');
    };
    this.$('touch-controls').addEventListener('pointerup', releaseTouch);
    this.$('touch-controls').addEventListener('pointercancel', releaseTouch);
    this.$('touch-controls').addEventListener('lostpointercapture', releaseTouch);

    this._buildSectorBar();
    this._buildGapWidget();

    this._towerRows = [];
    this._mapPath = null;
    this._uiTimer = 0;
    this._resetDerived();
  }

  // ---- state that must not survive a session swap ----
  _resetDerived() {
    this._gapTimer = 0;
    this._gapHist = [];
    this._towerGapT = 0;
    this._towerGapMode = 0;      // 0 = INTERVAL, 1 = LEADER
    this._prevPos = Object.create(null);
    this._flash = Object.create(null);
    this._vscWasActive = false;
    this._greenFlagT = 0;
    this._flKey = '';
    this._flBannerT = 0;
    this._radio = null;
    this._radioTextEl = null;
    this._pulse = 0;
    this._announcedEventKeys = new Set();
    this._announceSeq = 0;
  }

  _buildSectorBar() {
    const bar = this.$('sectorbar');
    this._sectors = [];
    for (let i = 0; i < SECTORS; i++) {
      const seg = el('div', 'sector-seg');
      const fill = el('div', 'sector-fill');
      const time = el('div', 'sector-time');
      const tag = el('div', 'sector-tag', 'S' + (i + 1));
      seg.appendChild(fill);
      seg.appendChild(tag);
      seg.appendChild(time);
      bar.appendChild(seg);
      this._sectors.push({ seg, fill, time, tag });
    }
  }

  _buildGapWidget() {
    const w = this.$('gapwidget');
    const mk = (cls, label) => {
      const row = el('div', 'gap-row ' + cls);
      const lbl = el('span', 'gap-lbl', label);
      const name = el('span', 'gap-name', '—');
      const arrow = el('span', 'gap-arrow', '');
      const val = el('span', 'gap-val', '—');
      row.appendChild(lbl); row.appendChild(name); row.appendChild(arrow); row.appendChild(val);
      w.appendChild(row);
      return { row, name, arrow, val };
    };
    this._gapAhead = mk('ahead', 'AHEAD');
    this._gapBehind = mk('behind', 'BEHIND');
  }

  $(id) { return this.root.querySelector('#' + id); }
  _announce(text, priority = 'polite', eventKey = '') {
    const value = String(text || '').trim();
    if (!value) return;
    const stableKey = String(eventKey || '').trim();
    if (stableKey) {
      if (this._announcedEventKeys.has(stableKey)) return;
      this._announcedEventKeys.add(stableKey);
    }
    this._announceSeq++;
    const semanticPriority = stableKey.startsWith('vsc:') ? 'assertive' : priority;
    const target = this.$(semanticPriority === 'assertive' ? 'hud-live-assertive' : 'hud-live-polite');
    // An invisible separator makes an identical later event a real one-mutation
    // DOM change without clearing the live region first or altering speech.
    target.textContent = value + (this._announceSeq % 2 ? '\u2063' : '\u2063\u2063');
  }
  show() {
    this.root.classList.add('active');
    this.root.setAttribute('aria-hidden', 'false');
  }
  hide() {
    this.root.classList.remove('active');
    this.root.setAttribute('aria-hidden', 'true');
    this.$('hud-live-polite').textContent = '';
    this.$('hud-live-assertive').textContent = '';
    this.$('onboarding').classList.remove('active');
    this.$('onboarding').setAttribute('aria-hidden', 'true');
    this.$('onboarding-go').onclick = null;
    this.hideSessionReady();
    this.$('race-msg').innerHTML = '';
    this.hideLights();
    this.flash('');
    this.showPitOverlay(null);
    this.$('pit-overlay').classList.remove('active');
    this.$('pit-overlay').setAttribute('aria-hidden', 'true');
    this._pitShown = false;
    this._hideRadio();
    this.$('vscbanner').classList.remove('on', 'green');
    this.$('flbanner').classList.remove('on');
    this.enableTouchControls(false);
    this.setCockpitMode(false);
  }

  enableTouchControls(enabled, onPause = null) {
    this._touchPause = onPause;
    this.$('touch-controls').classList.toggle('enabled', !!enabled);
    if (!enabled) this.clearTouchState();
  }

  clearTouchState() {
    for (const key of Object.keys(this.touchState)) this.touchState[key] = false;
    for (const button of this.$('touch-controls').querySelectorAll('.pressed')) {
      button.classList.remove('pressed');
    }
  }

  setCockpitMode(active) {
    this.root.classList.toggle('cockpit-mode', !!active);
    this.cockpit.setActive(active);
  }

  nextCockpitPage() { return this.cockpit.nextPage(); }

  updateSimulationState(snapshot = {}) {
    const values = {
      weather: snapshot.weather?.condition === 'rain'
        ? `RAIN ${Math.round((snapshot.weather.intensity || 0) * 100)}%` : '',
      damage: (snapshot.damage?.frontWing || 0) > 0
        ? `FRONT WING ${Math.round(snapshot.damage.frontWing * 100)}%` : '',
      strategy: snapshot.strategy?.recommendation && snapshot.strategy.recommendation !== 'stay-out'
        ? `${snapshot.strategy.recommendation.replace('-', ' ').toUpperCase()} · ${snapshot.strategy.compound}` : '',
      'race-control': snapshot.raceControl?.state && snapshot.raceControl.state !== 'green'
        ? snapshot.raceControl.state.replace('-', ' ').toUpperCase() : '',
    };
    for (const [key, value] of Object.entries(values)) {
      const element = this.root.querySelector(`[data-sim-state="${key}"]`);
      if (!element) continue;
      element.textContent = value;
      element.classList.toggle('active', !!value);
    }
  }

  showOnboarding(onDone) {
    const overlay = this.$('onboarding');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    const button = this.$('onboarding-go');
    button.onclick = () => {
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      button.onclick = null;
      onDone?.();
    };
    setTimeout(() => button.focus(), 0);
  }

  showSessionReady(onStart) {
    const overlay = this.$('session-ready');
    const button = this.$('session-ready-go');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    button.onclick = () => onStart?.();
    setTimeout(() => button.focus(), 0);
  }

  hideSessionReady() {
    const overlay = this.$('session-ready');
    const button = this.$('session-ready-go');
    overlay?.classList.remove('active');
    overlay?.setAttribute('aria-hidden', 'true');
    if (button) button.onclick = null;
  }

  bindSession(session, circuit) {
    this.session = session;
    this.circuit = circuit;
    this._resetDerived();
    this._timeTrialDelta = null;
    const race = session.mode === 'race';
    this.$('tw-title').textContent = session.trial ? 'TIME TRIAL'
      : session.mode === 'practice' ? 'PRACTICE · FP1'
        : session.mode === 'quali' ? `QUALIFYING · ${session.qualifying?.stage || 'Q1'}` : 'RACE';
    this.$('tw-lap').textContent = '';
    this.$('tw-gapmode').textContent = race ? 'INT' : '';
    this.$('tt-delta-box').style.display = session.trial ? '' : 'none';
    this.$('t-delta').textContent = '—';
    // don't flash the fastest-lap banner for a lap that was set before we bound
    this._flKey = this._fastestKey(session);
    // gap widget / sector bar only make sense with a real player in a race
    // shown only from lights-out: during grid/lights it sits under the start-light board
    this.$('gapwidget').classList.toggle('shown', false);
    this._gapWanted = !!(race && session.player);
    this.$('sectorbar').classList.toggle('shown', !!session.player);

    // tower rows
    const rows = this.$('tw-rows');
    rows.innerHTML = '';
    this._towerRows = [];
    const n = race ? session.entries.length : 0;
    for (let i = 0; i < n; i++) {
      const div = el('div', 'tw-row');
      const pos = el('span', 'pos');
      const bar = el('span', 'bar');
      const code = el('span', 'code');
      const blue = el('span', 'tw-blueflag', '⚑');
      const pen = el('span', 'tw-pen');
      const tyre = el('span', 'tyre');
      const age = el('sup', 'tyre-age');
      const gap = el('span', 'gap');
      [pos, bar, code, blue, pen, tyre, age, gap].forEach(c => div.appendChild(c));
      rows.appendChild(div);
      this._towerRows.push({ el: div, pos, bar, code, blue, pen, tyre, age, gap });
    }

    // minimap path precompute
    const cv = this.$('minimap');
    const ctx = cv.getContext('2d');
    const S = circuit.samples;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const s of S) {
      minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
      minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z);
    }
    const pad = 14;
    const sc = Math.min((cv.width - pad * 2) / (maxX - minX), (cv.height - pad * 2) / (maxZ - minZ));
    const ox = (cv.width - (maxX - minX) * sc) / 2 - minX * sc;
    const oz = (cv.height - (maxZ - minZ) * sc) / 2 - minZ * sc;
    this._map = { ctx, sc, ox, oz, w: cv.width, h: cv.height };
    const path = new Path2D();
    for (let i = 0; i <= S.length; i++) {
      const s = S[i % S.length];
      const x = s.p.x * sc + ox, y = s.p.z * sc + oz;
      i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    this._mapPath = path;
  }

  update(dt) {
    const s = this.session;
    if (!s) return;
    if (!(dt > 0)) dt = 0;
    // gap widget appears at lights-out (it overlaps the start-light board earlier)
    if (this._gapWanted !== undefined) {
      const live = s.phase === 'racing' || s.phase === 'finished';
      this.$('gapwidget').classList.toggle('shown', this._gapWanted && live);
    }
    // If the player is eliminated from staged qualifying, keep the physical
    // session visible by following one of the surviving AI cars. Controls and
    // player identity remain bound to s.player in the game state machine.
    const p = s.focusEntry || s.player;
    this._pulse += dt;
    this._uiTimer -= dt;
    const slow = this._uiTimer <= 0;
    if (slow) this._uiTimer = 0.25;

    if (p) {
      const ph = p.phys;
      // dash (every frame — snappy)
      this.$('d-gear').textContent = ph.v < 0 ? 'R' : ph.gear;
      this.$('d-speed').textContent = Math.round(ph.kmh);
      this.$('b-thr').style.width = (ph.throttle * 100) + '%';
      this.$('b-brk').style.width = (ph.brake * 100) + '%';
      this.$('b-ers').style.width = (ph.battery * 100) + '%';
      const r = ph.rpmFrac;
      const lit = Math.floor(Math.max(0, (r - 0.55)) / 0.45 * 15);
      this._leds.forEach((led, i) => led.classList.toggle('on', i < lit));
      this.$('m-x').classList.toggle('on', ph.aeroX);
      this.$('m-z').classList.toggle('on', !ph.aeroX);
      this.$('m-ovr').classList.toggle('on', ph.boosting);
      this.$('boostvin').style.opacity = ph.boosting ? 1 : 0;
      this.cockpit.update({ session: s, player: p, delta: this._timeTrialDelta, steer: ph.steer });

      if (slow) {
        const stage = s.mode === 'practice' ? 'FP1' : (s.qualifying?.stage || 'Q1');
        this.$('tw-title').textContent = s.trial ? 'TIME TRIAL'
          : s.mode === 'practice' ? 'PRACTICE · FP1'
            : s.mode === 'quali' ? `QUALIFYING · ${stage}` : 'RACE';
        this.$('t-pos').textContent = s.mode === 'race' ? 'P' + p.position : '—';
        this._renderPosDelta(p);
        const sessionStatus = s.qualiState === 'flying' ? 'FLYING'
          : s.qualiState === 'done' ? 'DONE'
            : s.qualiState === 'awaiting-field' ? 'TRACK LIVE' : 'OUT LAP';
        this.$('t-lap').textContent = s.mode === 'race'
          ? (s.phase === 'formation'
            ? 'FORMATION'
            : Math.min(Math.max(p.lap + 1, 1), s.laps) + '/' + s.laps)
          : s.trial ? sessionStatus : `${stage} ${sessionStatus}`;
        const cur = (s.phase === 'racing' || s.phase === 'finished') && p.lap >= 0 ? s.raceTime - p.lapStart : 0;
        this.$('t-cur').textContent = fmtTime(cur);
        this.$('t-last').textContent = p.lastLap ? fmtTime(p.lastLap) : '—';
        this.$('t-best').textContent = p.bestLap ? fmtTime(p.bestLap) : '—';
        // car stat
        const cd = ph.compoundData;
        this.$('c-tyre').textContent = cd.name;
        const wearPct = 1 - ph.wear;
        const wearEl = this.$('c-wear');
        wearEl.style.width = (wearPct * 100) + '%';
        wearEl.style.background = wearPct > 0.5 ? 'var(--green)' : wearPct > 0.25 ? 'var(--yellow)' : 'var(--red)';
        this.$('c-fuel').textContent = Math.round(ph.fuel * 100) + '%';
        this.$('c-box').textContent = p.boxThisLap ? 'BOX THIS LAP' : '—';
        this.$('c-box').style.color = p.boxThisLap ? 'var(--yellow)' : '';
      }
      // sectors run every frame so the live fill is smooth
      this._renderSectors(p);
    }

    if (slow && s.mode === 'race') {
      this._towerGapT += 0.25;
      if (this._towerGapT >= TOWER_GAP_CYCLE) {
        this._towerGapT = 0;
        this._towerGapMode ^= 1;
        this.$('tw-gapmode').textContent = this._towerGapMode ? 'LEADER' : 'INT';
      }
      this._renderTower(s);
    }

    // gap widget at 2Hz
    if (s.mode === 'race' && p) {
      this._gapTimer -= dt;
      if (this._gapTimer <= 0) { this._gapTimer = 1 / GAP_HZ; this._renderGapWidget(s, p); }
    }

    this._renderVSC(s, dt);
    this._renderFastestLap(s, dt);
    this._renderRadio(s, dt);

    // pit overlay auto-show
    if (s._playerPitOpen && !this._pitShown) {
      this._pitShown = true;
      this.$('pit-overlay').classList.add('active');
      this.$('pit-overlay').setAttribute('aria-hidden', 'false');
      this._announce('Pit stop: select tyre compound', 'assertive');
    } else if (!s._playerPitOpen && this._pitShown) {
      this._pitShown = false;
      this.$('pit-overlay').classList.remove('active');
      this.$('pit-overlay').setAttribute('aria-hidden', 'true');
    }

    this._drawMinimap();
  }

  updateTimeTrial(personalBest, delta) {
    if (!this.session?.trial) return;
    this._timeTrialDelta = typeof delta === 'number' && Number.isFinite(delta) ? delta : null;
    if (personalBest > 0) this.$('t-best').textContent = fmtTime(personalBest);
    const value = this.$('t-delta');
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      value.textContent = '—';
      value.classList.remove('green', 'red');
      return;
    }
    value.textContent = `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(3)}`;
    value.classList.toggle('green', delta <= 0);
    value.classList.toggle('red', delta > 0);
  }

  // ================= sector times =================
  _sessionBestSectors() {
    const s = this.session;
    const best = [null, null, null];
    if (!s || !Array.isArray(s.entries)) return best;
    for (const e of s.entries) {
      const bs = e && e.bestSectors;
      if (!Array.isArray(bs)) continue;
      for (let i = 0; i < SECTORS; i++) {
        const v = num(bs[i]);
        if (v != null && (best[i] == null || v < best[i])) best[i] = v;
      }
    }
    return best;
  }

  // F1-TV colouring for a completed sector time
  _sectorColour(t, i, pb, sb) {
    const sBest = num(sb[i]), pBest = pb ? num(pb[i]) : null;
    if (sBest != null && t <= sBest + 1e-6) return 'purple';
    if (pBest != null && t <= pBest + 1e-6) return 'green';
    return 'yellow';
  }

  _renderSectors(p) {
    const s = this.session;
    const cur = Array.isArray(p.sectors) ? p.sectors : null;
    const last = Array.isArray(p.lastSectors) ? p.lastSectors : null;
    const pb = Array.isArray(p.bestSectors) ? p.bestSectors : null;
    const sb = cur || last || pb ? this._sessionBestSectors() : [null, null, null];
    const refLap = (this.circuit && num(this.circuit.idealLap)) || 90;

    // Which sector is live? race.js splits on track thirds, so derive it from
    // the car's position — that stays correct after a mid-lap sector reset
    // (pit exit), where the "first null" heuristic would point at S1.
    let inProg = -1;
    if (cur) {
      const N = this.circuit && num(this.circuit.N);
      const idx = num(p.phys && p.phys.sampleIdx);
      if (N && idx != null) inProg = idx >= 2 * N / 3 ? 2 : idx >= N / 3 ? 1 : 0;
      else {
        for (let i = 0; i < SECTORS; i++) { if (num(cur[i]) == null) { inProg = i; break; } }
      }
      if (inProg >= 0 && num(cur[inProg]) != null) inProg = -1;
    }

    // elapsed inside the live sector
    let elapsed = 0;
    if (cur && inProg >= 0) {
      const lapT = (s.phase === 'racing' || s.phase === 'finished') && p.lap >= 0
        ? Math.max(0, s.raceTime - p.lapStart) : 0;
      let done = 0;
      for (let i = 0; i < inProg; i++) done += num(cur[i]) || 0;
      elapsed = Math.max(0, lapT - done);
    }

    // no live sector data at all: approximate from track position so the bar
    // still reads as a progress indicator
    const trackFrac = !cur && this.circuit && num(p.phys && p.phys.sampleIdx) != null && this.circuit.N
      ? clamp01(p.phys.sampleIdx / this.circuit.N) : null;

    for (let i = 0; i < SECTORS; i++) {
      const seg = this._sectors[i];
      const t = cur ? num(cur[i]) : null;
      let cls = 'sector-fill', width = 0, label = '';

      if (t != null) {
        // completed this lap
        width = 100;
        label = fmtSector(t);
        cls += ' ' + this._sectorColour(t, i, pb, sb);
      } else if (inProg === i) {
        const ref = (last ? num(last[i]) : null) || (pb ? num(pb[i]) : null) || refLap / SECTORS;
        width = clamp01(elapsed / Math.max(0.5, ref)) * 100;
        cls += ' live';
        // only print the running count while it's plausible — a stale lapStart
        // (pit cycle, session swap) would otherwise show a junk number
        label = elapsed > 0.15 && elapsed < ref * 2.5 ? elapsed.toFixed(1) : '';
      } else if (trackFrac != null) {
        // fallback progress mode
        const lo = i / SECTORS, hi = (i + 1) / SECTORS;
        width = clamp01((trackFrac - lo) / (hi - lo)) * 100;
        cls += ' live';
      } else if (last && num(last[i]) != null) {
        // Between laps, and for S3 specifically: race.js folds the closing
        // sector straight into lastSectors, so the last lap's times are the
        // only place a completed S3 ever appears. Colour them, held dimmed.
        const lt = num(last[i]);
        width = 100;
        label = fmtSector(lt);
        cls += ' prev ' + this._sectorColour(lt, i, pb, sb);
      }
      seg.fill.className = cls;
      seg.fill.style.width = width.toFixed(1) + '%';
      seg.time.textContent = label;
    }
  }

  // ================= position tower =================
  _renderTower(s) {
    this.$('tw-lap').textContent = 'LAP ' + Math.min(Math.max((s.entries.find(e => e.position === 1)?.lap ?? 0) + 1, 1), s.laps) + '/' + s.laps;
    const ordered = [...s.entries].sort((a, b) => (a.dnf ? 900 + a.position : a.position) - (b.dnf ? 900 + b.position : b.position));
    const now = performance.now();
    const blueFor = s.blueFlagFor ?? null;
    const leaderMode = this._towerGapMode === 1;

    // position-change detection, keyed by driver so row reuse can't smear it
    for (const e of ordered) {
      const id = e.driver && e.driver.id;
      if (!id) continue;
      const prev = this._prevPos[id];
      if (prev != null && e.position !== prev && !e.dnf) {
        this._flash[id] = { gain: e.position < prev, until: now + FLASH_MS };
      }
      this._prevPos[id] = e.position;
    }

    ordered.forEach((e, i) => {
      const row = this._towerRows[i];
      if (!row) return;
      row.el.classList.toggle('player', !!e.isPlayer);
      const id = e.driver && e.driver.id;
      const fl = id ? this._flash[id] : null;
      const live = !!(fl && fl.until > now);
      if (fl && !live && id) delete this._flash[id];
      row.el.classList.toggle('tw-gain', live && fl.gain);
      row.el.classList.toggle('tw-loss', live && !fl.gain);

      row.pos.textContent = e.dnf ? '—' : e.position;
      row.bar.style.background = '#' + e.team.color.toString(16).padStart(6, '0');
      row.code.textContent = e.driver.code;

      // blue flag (driver currently being shown blue flags)
      row.blue.classList.toggle('shown', !!(blueFor && id === blueFor && !e.dnf));

      // accumulated time penalty
      const pen = num(e.penaltySeconds);
      const showPen = pen != null && pen > 0;
      row.pen.classList.toggle('shown', showPen);
      row.pen.textContent = showPen ? '+' + (pen % 1 ? pen.toFixed(1) : pen.toFixed(0)) + 's' : '';

      row.tyre.className = 'tyre ' + e.phys.compound;
      row.tyre.textContent = e.phys.compound;

      // tyre age (laps on the current set)
      const age = num(e.tyreAgeLaps);
      const showAge = age != null && age >= 0;
      row.age.classList.toggle('shown', showAge);
      row.age.textContent = showAge ? String(Math.round(age)) : '';

      row.gap.className = 'gap' + (e.pitState ? ' pit' : e.dnf ? ' out' : '');
      row.gap.textContent = e.dnf ? 'OUT' : e.pitState ? 'PIT'
        : (i === 0 ? (leaderMode ? 'LEADER' : '') : (leaderMode ? (e.gapText || '') : (e.intervalText || e.gapText || '')));
    });
  }

  // ================= gap to car ahead / behind =================
  // mirrors race.js _updatePositions().progOf, including the pit-lane offset
  _progOf(e) {
    const c = this.circuit;
    if (!c || !e || !e.phys) return null;
    const lap = num(e.lap) ?? 0;
    const idx = num(e.phys.sampleIdx) ?? 0;
    return lap * c.length + idx * c.ds + (e.pitState ? -2 : 0);
  }

  /** seconds from b back to a (a is the car ahead), or null if not derivable */
  _gapSeconds(a, b) {
    const pa = this._progOf(a), pb = this._progOf(b);
    if (pa == null || pb == null) return null;
    const c = this.circuit;
    const dp = pa - pb;
    // race.js orders on a 0.4s timer, so right after a swap (or across the
    // line) our sampled progress can disagree with the published order —
    // report nothing rather than a bogus +0.0 and let the caller fall back.
    if (dp <= 0) return null;
    if (dp >= c.length) return { laps: Math.floor(dp / c.length) };
    const v = Math.max(num(b.phys.v) ?? 0, 28);
    return { s: dp / v };
  }

  /** last-resort gap: reuse the interval string race.js already published */
  _parseGap(str) {
    if (typeof str !== 'string' || !str) return null;
    let m = /^\+?([\d.]+)\s*L$/i.exec(str.trim());
    if (m) return { laps: parseInt(m[1], 10) || 1 };
    m = /^\+?([\d.]+)$/.exec(str.trim());
    if (m) { const v = parseFloat(m[1]); return isFinite(v) ? { s: v } : null; }
    return null;
  }

  _renderGapWidget(s, p) {
    const live = s.entries.filter(e => !e.dnf);
    const ahead = live.find(e => e.position === p.position - 1) || null;
    const behind = live.find(e => e.position === p.position + 1) || null;
    // p.intervalText is the player's gap to the car ahead; behind.intervalText
    // is that car's gap back to the player — both already published by race.js
    const ga = ahead ? (this._gapSeconds(ahead, p) || this._parseGap(p.intervalText)) : null;
    const gb = behind ? (this._gapSeconds(p, behind) || this._parseGap(behind.intervalText)) : null;

    // history for the 2s trend comparison
    const now = this._pulse;
    this._gapHist.push({ t: now, a: ga && ga.s != null ? ga.s : null, b: gb && gb.s != null ? gb.s : null });
    while (this._gapHist.length > 24) this._gapHist.shift();
    let ref = null;
    for (const h of this._gapHist) { if (now - h.t >= GAP_TREND_WINDOW) ref = h; else break; }

    const paint = (slot, entry, gap, prev, aheadSide) => {
      if (!entry) {
        slot.row.classList.remove('shown');
        slot.name.textContent = '—'; slot.val.textContent = '—';
        slot.arrow.className = 'gap-arrow'; slot.arrow.textContent = '';
        return;
      }
      slot.row.classList.add('shown');
      slot.name.textContent = entry.driver.code;
      if (entry.pitState) slot.val.textContent = 'PIT';
      else if (gap && gap.laps) slot.val.textContent = '+' + gap.laps + 'L';
      else if (gap && gap.s != null) slot.val.textContent = '+' + gap.s.toFixed(1);
      else slot.val.textContent = '—';

      let dir = 0;
      const cur = gap && gap.s != null ? gap.s : null;
      if (cur != null && prev != null) {
        const d = cur - prev;
        if (d < -GAP_TREND_EPS) dir = aheadSide ? 1 : -1;   // closing
        else if (d > GAP_TREND_EPS) dir = aheadSide ? -1 : 1; // dropping away
      }
      slot.arrow.className = 'gap-arrow' + (dir > 0 ? ' up' : dir < 0 ? ' down' : '');
      slot.arrow.textContent = dir > 0 ? '▲' : dir < 0 ? '▼' : '–';
    };

    paint(this._gapAhead, ahead, ga, ref ? ref.a : null, true);
    paint(this._gapBehind, behind, gb, ref ? ref.b : null, false);
  }

  _renderPosDelta(p) {
    const d = num(p.positionsGained);
    const box = this.$('t-posdelta');
    if (d == null || d === 0) { box.className = 'posdelta'; box.textContent = ''; return; }
    box.className = 'posdelta ' + (d > 0 ? 'up' : 'down');
    box.textContent = (d > 0 ? '▲' : '▼') + Math.abs(Math.round(d));
  }

  // ================= virtual safety car =================
  _renderVSC(s, dt) {
    const vsc = s.vsc;
    const active = !!(vsc && vsc.active);
    const banner = this.$('vscbanner');
    if (active) {
      if (!this._vscWasActive) {
        this._announce('Virtual safety car deployed', 'assertive', vsc.deployEventKey);
      }
      this._greenFlagT = 0;
      banner.classList.add('on');
      banner.classList.remove('green');
      this.$('vsc-text').textContent = 'VIRTUAL SAFETY CAR';
      const left = num(vsc.timeLeft);
      this.$('vsc-count').textContent = left != null && left > 0 ? Math.ceil(left) + 's' : '';
    } else if (this._vscWasActive) {
      // VSC just ended — green flag flash
      this._greenFlagT = 2.2;
      banner.classList.add('on', 'green');
      this.$('vsc-text').textContent = 'GREEN FLAG';
      this.$('vsc-count').textContent = '';
      this._announce('Green flag. Racing resumed', 'assertive', vsc && vsc.greenEventKey);
    } else if (this._greenFlagT > 0) {
      this._greenFlagT -= dt;
      if (this._greenFlagT <= 0) {
        this._greenFlagT = 0;
        banner.classList.remove('on', 'green');
        this.$('vsc-count').textContent = '';
      }
    }
    this._vscWasActive = active;
  }

  // ================= fastest lap sweep =================
  _fastestKey(s) {
    const fl = s && s.fastestLap;
    return fl ? String(fl.driverId) + ':' + (num(fl.time) ?? '') : '';
  }

  _renderFastestLap(s, dt) {
    const key = this._fastestKey(s);
    const banner = this.$('flbanner');
    if (key !== this._flKey) {
      this._flKey = key;
      const fl = s.fastestLap;
      if (fl) {
        const who = s.entries.find(e => e.driver && e.driver.id === fl.driverId);
        const name = fl.name || (who && who.driver ? who.driver.lastName : '') || String(fl.driverId || '');
        const code = who && who.driver ? who.driver.code : '';
        // rebuild the children so the CSS sweep animation restarts cleanly
        banner.innerHTML = '';
        banner.appendChild(el('span', 'fl-badge', 'FASTEST LAP'));
        banner.appendChild(el('span', 'fl-name', String(name).toUpperCase()));
        if (code) banner.appendChild(el('span', 'fl-code', code));
        banner.appendChild(el('span', 'fl-time', num(fl.time) != null ? fmtTime(fl.time) : ''));
        banner.appendChild(el('span', 'fl-sweep'));
        banner.classList.add('on');
        this._announce(
          `Fastest lap: ${name}${num(fl.time) != null ? ', ' + fmtTime(fl.time) : ''}`,
          'polite',
          fl.eventKey,
        );
        this._flBannerT = FL_BANNER_MS / 1000;
      }
    }
    if (this._flBannerT > 0) {
      this._flBannerT -= dt;
      if (this._flBannerT <= 0) { this._flBannerT = 0; banner.classList.remove('on'); }
    }
  }

  // ================= race engineer radio =================
  _hideRadio() {
    this._radio = null;
    this._radioTextEl = null;
    const card = this.$('radiocard');
    card.className = '';
    card.innerHTML = '';
    card.setAttribute('aria-label', 'Race engineer message');
  }

  _renderRadio(s, dt) {
    const q = s.radioQueue;
    if (!this._radio && Array.isArray(q) && q.length) {
      const item = q.shift();
      const text = String((item && item.text) != null ? item.text : '');
      const tone = item && item.tone === 'warning' ? 'warning'
        : item && item.tone === 'celebration' ? 'celebration' : 'info';
      const card = this.$('radiocard');
      card.innerHTML = '';
      card.setAttribute('aria-label', 'Race engineer: ' + text);
      const head = el('div', 'radio-head');
      head.appendChild(el('span', 'radio-icon', '●••'));
      head.appendChild(el('span', 'radio-who', 'RACE ENGINEER'));
      const body = el('div', 'radio-text', '');
      card.appendChild(head);
      card.appendChild(body);
      card.className = 'on ' + tone;
      this._announce(
        'Race engineer: ' + text,
        tone === 'warning' ? 'assertive' : 'polite',
        item && item.eventKey,
      );
      this._radioTextEl = body;
      // type-on: whole message inside ~0.9s, floor of 26 chars/sec
      this._radio = { text, life: RADIO_LIFE, typed: 0, cps: Math.max(26, text.length / 0.9), shown: -1 };
    }
    const r = this._radio;
    if (!r) return;
    r.typed += dt * r.cps;
    const n = Math.min(r.text.length, Math.floor(r.typed));
    if (n !== r.shown && this._radioTextEl) {
      r.shown = n;
      this._radioTextEl.textContent = r.text.slice(0, n);
    }
    r.life -= dt;
    if (r.life <= 0) this._hideRadio();
  }

  // ================= minimap =================
  _drawMinimap() {
    const m = this._map, s = this.session;
    if (!m || !s) return;
    const { ctx } = m;
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke(this._mapPath);
    // S/F tick
    const s0 = this.circuit.samples[0];
    ctx.fillStyle = '#e10600';
    ctx.fillRect(s0.p.x * m.sc + m.ox - 2.5, s0.p.z * m.sc + m.oz - 2.5, 5, 5);
    // pit-lane marker
    const pi = num(this.circuit.pitExitIdx);
    if (pi != null && this.circuit.samples[pi]) {
      const ps = this.circuit.samples[pi];
      const px = ps.p.x * m.sc + m.ox, py = ps.p.z * m.sc + m.oz;
      ctx.beginPath();
      ctx.arc(px, py, 4.6, 0, 7);
      ctx.fillStyle = 'rgba(10,10,14,0.9)';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,225,74,0.95)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,225,74,0.95)';
      ctx.fillRect(px - 0.7, py - 2.6, 1.4, 5.2);
      ctx.fillRect(px - 0.7, py - 2.6, 3.2, 2.4);
    }
    for (const e of s.entries) {
      if (e.dnf || e.pitState || e.phys.disabled) continue;
      const x = e.phys.pos.x * m.sc + m.ox, y = e.phys.pos.z * m.sc + m.oz;
      let rad = e.isPlayer ? 4.4 : 3;
      if (e.isPlayer && e.phys.boosting) rad *= 1.18 + 0.16 * Math.sin(this._pulse * 11);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, 7);
      ctx.fillStyle = '#' + e.team.color.toString(16).padStart(6, '0');
      ctx.fill();
      if (e.isPlayer) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        // direction-of-travel arrow
        const h = num(e.phys.heading) ?? 0;
        ctx.save();
        ctx.translate(x, y);
        // world heading: +x = sin, +z = cos → screen y follows z, so rotate by -h
        ctx.rotate(-h);
        ctx.beginPath();
        ctx.moveTo(0, -(rad + 6.2));
        ctx.lineTo(-3.4, -(rad + 1.4));
        ctx.lineTo(3.4, -(rad + 1.4));
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();
      }
    }
  }

  message(text, color, meta = null) {
    if (!text) return;
    const box = this.$('race-msg');
    const div = document.createElement('div');
    div.className = 'msg-pill' + (color === 'green' ? ' green' : color === 'yellow' || color === 'purple' ? ' yellow' : '');
    if (color === 'purple') div.style.borderLeftColor = 'var(--purple)';
    div.textContent = text;
    this._announce(
      text,
      color === 'green' || color === 'purple' ? 'polite' : 'assertive',
      meta && meta.eventKey,
    );
    box.appendChild(div);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.4s'; }, 3200);
    setTimeout(() => div.remove(), 3700);
  }

  setLights(n) {
    this.$('startlights').classList.add('active');
    this._lampCols.forEach((col, i) => {
      const lamps = col.querySelectorAll ? col.querySelectorAll('.lamp') : null;
      if (lamps && lamps.length) lamps.forEach(l => l.classList.toggle('on', i < n));
      else if (col.children) Array.prototype.forEach.call(col.children, l => l.classList.toggle('on', i < n));
    });
  }
  lightsOutFlash() {
    this._lampCols.forEach(col => {
      const lamps = col.querySelectorAll ? col.querySelectorAll('.lamp') : null;
      if (lamps && lamps.length) lamps.forEach(l => l.classList.remove('on'));
      else if (col.children) Array.prototype.forEach.call(col.children, l => l.classList.remove('on'));
    });
    setTimeout(() => this.hideLights(), 900);
    this.flash("LIGHTS OUT — IT'S RACING!", 2000);
  }
  hideLights() { this.$('startlights').classList.remove('active'); }

  flash(text, ms = 1800) {
    const box = this.$('bigflash');
    if (!text) { box.style.display = 'none'; return; }
    box.textContent = text;
    this._announce(text, 'assertive');
    box.style.display = 'block';
    clearTimeout(this._flashTo);
    this._flashTo = setTimeout(() => { box.style.display = 'none'; }, ms);
  }

  showPitOverlay(cb) { this._pitCb = cb; }
}
