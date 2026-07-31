// Menu system: main, team/driver select, track select, settings, loading,
// quali results, race results, championship standings, pause.
import { TEAMS, DRIVERS, CALENDAR, SEASON } from './data.js';
import { TRACKS } from './tracks.js';
import { fmtTime } from './format.js';

const FLAGS = {
  melbourne: '🇦🇺', shanghai: '🇨🇳', suzuka: '🇯🇵', bahrain: '🇧🇭', jeddah: '🇸🇦',
  miami: '🇺🇸', montreal: '🇨🇦', monaco: '🇲🇨', barcelona: '🇪🇸', spielberg: '🇦🇹',
  silverstone: '🇬🇧', spa: '🇧🇪', hungaroring: '🇭🇺', zandvoort: '🇳🇱', monza: '🇮🇹',
  madrid: '🇪🇸', baku: '🇦🇿', singapore: '🇸🇬', austin: '🇺🇸', mexico: '🇲🇽',
  interlagos: '🇧🇷', lasvegas: '🇺🇸', lusail: '🇶🇦', yasmarina: '🇦🇪',
};
const TIPS = [
  '2026 regs: X-mode slashes drag on the straights — it engages automatically when you hold full throttle with the wheel straight.',
  'MANUAL OVERRIDE (hold SPACE) deploys 350kW of electric power — the 2026 replacement for DRS. Watch your battery.',
  'Harvest energy under braking. Your MGU-K recovers up to twice the energy of the old regulations.',
  'Soft tyres are ~1s per lap faster but degrade quickly. Plan your pit window with P (BOX THIS LAP).',
  'Slipstream gives you reduced drag down the straights — get within a second of the car ahead.',
  'The 2026 cars are 30kg lighter and nimbler than the previous generation.',
  'Kerbs are part of the track — but grass and gravel are not. Track limits cost you lap time.',
  'Following closely through corners costs downforce (dirty air). Time your attack for the next straight.',
];
const DEFAULT_SETTINGS = {
  difficulty: 1, distance: 0, quali: true, tc: true, abs: true, autoGear: true,
  nametags: true, volume: 1, graphicsQuality: 'auto', cameraProfile: 'broadcast',
  autoPause: true, touchControls: true, steeringResponse: 'balanced',
  cockpitFov: 'natural', cockpitSeat: 'standard', headMotion: true,
};
const PILOT_DRIVER_ID = 'hacker';
const PILOT_TRACK_ID = 'spa';
const teamById = Object.fromEntries(TEAMS.map(t => [t.id, t]));

// Power-unit marque glyphs (decorative text badges — no image assets).
// Derived from the ACTIVE roster's engine list so no marque names live in the
// source; anything unmapped falls back to '⬣'.
const ENGINE_GLYPH = (() => {
  const glyphs = ['◈', '✦', '▲', '◆', '▬', '●', '■'];
  const marques = [...new Set(TEAMS.map(t => t.engine))].sort();
  return Object.fromEntries(marques.map((m, i) => [m, glyphs[i % glyphs.length]]));
})();

// The owner's brand mark. Monochrome, no colour, square edges — see the
// `.tacn-*` rules in css/menus.css.
const TACN_URL = 'THEAICONSULTINGNETWORK.COM';
const TACN_FOOTER = `<span class="tacn-mark">PRESENTED BY THE AI CONSULTING NETWORK — ${TACN_URL}</span>`;

// Venue label: each APEX calendar round carries an invented `circuitName`.
function circuitLabel(race, track) {
  return (race && race.circuitName) || (track && track.name) || '';
}

// ---- venue classification -------------------------------------------------
// These two tables MIRROR js/trackBuilder.js (STREET + TRACK_THEME) so the menu
// badges match the circuit you actually get dropped into. Kept as local copies
// on purpose: trackBuilder imports three.js and must not be pulled into the
// menu module graph.
const STREET_TRACKS = new Set([
  'monaco', 'baku', 'singapore', 'jeddah', 'lasvegas', 'miami', 'montreal', 'madrid',
]);
const TRACK_THEME = {
  bahrain: 'dusk', jeddah: 'night', lusail: 'night', singapore: 'night', lasvegas: 'night',
  yasmarina: 'dusk', qatar: 'night', mexico: 'classic', miami: 'city', baku: 'city',
  monaco: 'city', madrid: 'city', montreal: 'classic', melbourne: 'classic', shanghai: 'classic',
  suzuka: 'classic', barcelona: 'classic', spielberg: 'classic', silverstone: 'classic',
  spa: 'classic', hungaroring: 'classic', zandvoort: 'classic', monza: 'classic',
  austin: 'classic', interlagos: 'classic',
};

export class UI {
  constructor(cb) {
    this.cb = cb;   // (action, payload) => {}
    this.settings = this._loadSettings();
    this.lastSelection = this._loadLastSelection();
    this.sel = {
      driverId: this.lastSelection?.driverId || PILOT_DRIVER_ID,
      trackId: this.lastSelection?.trackId || PILOT_TRACK_ID,
      mode: 'quick',
    };
    this.screens = {};
    for (const id of ['main', 'team', 'track', 'settings', 'standings', 'loading', 'results', 'pause', 'boot']) {
      this.screens[id] = document.getElementById('screen-' + id);
    }
    this._factTimer = null;
    this._installMenuKeys();
  }

  // Arrow-key / Enter navigation across every menu screen (spatial: nearest
  // element in the pressed direction). Uses e.key so it works even where
  // e.code is missing. Home/End jump to the ends of the list; Escape or
  // Backspace triggers the screen's own back / main-menu button.
  _installMenuKeys() {
    window.addEventListener('keydown', (e) => {
      const key = e.key === ' ' ? 'Space' : e.key;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End', 'Escape', 'Backspace'].includes(key)) return;
      const screen = document.querySelector('#ui-root .screen.active');
      if (!screen || screen.id === 'screen-boot' ||
          (screen.id === 'screen-loading' && !screen.classList.contains('load-error-screen'))) return;
      const items = [...screen.querySelectorAll('.nav-item, .drv, .track-card, .f1-btn:not(:disabled), .seg button, .tyre-btn, [data-navitem]')]
        .filter(el => el.offsetParent !== null);
      if (key === 'Escape' || key === 'Backspace') {
        // graceful "go back" on every menu screen that offers one
        const back = screen.querySelector('#btn-back') || screen.querySelector('#btn-menu');
        if (!back) return;                              // e.g. pause: let main.js handle ESC
        e.preventDefault();
        back.click();
        return;
      }
      if (!items.length) return;
      e.preventDefault();
      let cur = screen._navFocus && items.includes(screen._navFocus) ? screen._navFocus : null;
      if (key === 'Enter') {
        (cur || items[0]).click();
        return;
      }
      if (key === 'Home') { this._setNavFocus(screen, items[0]); return; }
      if (key === 'End') { this._setNavFocus(screen, items[items.length - 1]); return; }
      if (!cur) {
        this._setNavFocus(screen, items[0]);
        return;
      }
      const cr = cur.getBoundingClientRect();
      const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
      let best = null, bestScore = Infinity;
      for (const el of items) {
        if (el === cur) continue;
        const r = el.getBoundingClientRect();
        const dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
        const along = dx * dir[0] + dy * dir[1];
        if (along < 4) continue;                       // must lie in that direction
        const ortho = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
        const score = along + ortho * 2.2;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) this._setNavFocus(screen, best);
    });
  }

  _setNavFocus(screen, el) {
    if (screen._navFocus) screen._navFocus.classList.remove('kb-focus');
    screen._navFocus = el;
    el.classList.add('kb-focus');
    // Keep the DOM focus ring and assistive-technology cursor aligned with the
    // spatial navigation highlight instead of maintaining a visual-only focus.
    el.focus?.({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.cb('uiclick');
  }

  _loadSettings() {
    try {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('apexf1_settings') || '{}'));
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  saveSettings() {
    try { localStorage.setItem('apexf1_settings', JSON.stringify(this.settings)); } catch {}
  }
  _loadLastSelection() {
    try {
      const saved = JSON.parse(localStorage.getItem('apexf1_last_race') || 'null');
      if (!saved || !DRIVERS.some(d => d.id === saved.driverId) || !TRACKS[saved.trackId]) return null;
      return { driverId: saved.driverId, trackId: saved.trackId };
    } catch { return null; }
  }
  _saveLastSelection() {
    if (!this.sel.driverId || !this.sel.trackId) return;
    this.lastSelection = { driverId: this.sel.driverId, trackId: this.sel.trackId };
    try { localStorage.setItem('apexf1_last_race', JSON.stringify(this.lastSelection)); } catch {}
  }

  showOnly(id) {
    if (id !== 'loading') this._stopFacts();
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('active', k === id);
  }
  hideAll() {
    this._stopFacts();
    for (const el of Object.values(this.screens)) el.classList.remove('active');
  }

  raceLapsFor(trackId) {
    const cal = CALENDAR.find(r => r.trackId === trackId);
    const full = cal ? cal.laps : 50;
    return [5, Math.max(3, Math.round(full * 0.25)), Math.max(5, Math.round(full * 0.5)), full][this.settings.distance];
  }

  // ---- presentation helpers ----------------------------------------------
  // Restart the screen-enter animation. Setting className already dropped
  // `screen-in`; a forced reflow guarantees the keyframes replay even when the
  // same screen is shown twice in a row.
  _enter(el) {
    if (!el || !el.classList) return;
    el.classList.remove('screen-in');
    void el.offsetWidth;
    el.classList.add('screen-in');
  }

  _reducedMotion() {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
  }

  // Points count-up for the player's results row.
  _countUp(el, to, dur = 750) {
    if (!el) return;
    const target = Number(to) || 0;
    if (target <= 0 || typeof requestAnimationFrame !== 'function' || this._reducedMotion()) {
      el.textContent = target ? String(target) : '';
      return;
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const k = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(target * eased));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _stopFacts() {
    if (this._factTimer !== null) {
      clearInterval(this._factTimer);
      this._factTimer = null;
    }
  }

  // ============ MAIN ============
  showMain(champ) {
    this.hideAll();
    const el = this.screens.main;
    el.className = 'screen active menu-screen main-screen';
    let champTile;
    if (champ && champ.active) {
      champTile = `<button type="button" class="nav-item" data-a="champ"><span><h3>CHAMPIONSHIP</h3><p>Continue Round ${champ.roundIndex + 1} of 24 — ${champ.nextRace.gp}</p></span></button>`;
    } else if (champ && champ.finished) {
      champTile = `<button type="button" class="nav-item" data-a="standings"><span><h3>SEASON COMPLETE</h3><p>View the final ${SEASON} standings</p></span></button>
        <button type="button" class="nav-item" data-a="champNew"><span><h3>NEW SEASON</h3><p>Start a fresh ${SEASON} championship (replaces the finished one)</p></span></button>`;
    } else {
      champTile = `<button type="button" class="nav-item" data-a="champ"><span><h3>CHAMPIONSHIP</h3><p>Full ${SEASON} season — 24 rounds, full calendar, points battle</p></span></button>`;
    }
    const lastRace = this.lastSelection && CALENDAR.find(r => r.trackId === this.lastSelection.trackId);
    const lastDriver = this.lastSelection && DRIVERS.find(d => d.id === this.lastSelection.driverId);
    const raceNow = lastRace && lastDriver
      ? `<button type="button" class="nav-item race-now" data-a="raceNow"><span><h3>RACE NOW</h3><p>${lastDriver.code} · ${lastRace.gp} · skip qualifying</p></span></button>`
      : '';
    el.innerHTML = `
      <div class="menu-bg" aria-hidden="true"><div class="bg-carbon"></div><div class="bg-grid"></div><div class="bg-vignette"></div></div>
      ${header('MAIN <small>MENU</small>')}
      ${seasonStrip(champ)}
      <div class="menu-body"><div class="main-nav">
        ${raceNow}
        <button type="button" class="nav-item pilot-run" data-a="pilot"><span><h3>TACN RACE WEEKEND · GREENWOOD FOREST</h3><p>AVI · FP1 · physical Q1/Q2/Q3 · formation lap · race</p></span></button>
        <button type="button" class="nav-item" data-a="quick"><span><h3>QUICK RACE</h3><p>Jump straight into a race weekend — any team, any circuit</p></span></button>
        ${champTile}
        <button type="button" class="nav-item" data-a="trial"><span><h3>TIME TRIAL</h3><p>Empty track, low fuel, soft tyres — chase the perfect lap</p></span></button>
        ${champ && champ.active ? '<button type="button" class="nav-item" data-a="standings"><span><h3>STANDINGS</h3><p>Drivers & Constructors championship tables</p></span></button>' : ''}
        <button type="button" class="nav-item" data-a="settings"><span><h3>SETTINGS</h3><p>Difficulty, race distance, assists, audio, graphics</p></span></button>
      </div></div>
      <div class="menu-footer">
        <span class="key-hint"><b>↑ ↓ ← →</b> drive</span>
        <span class="key-hint"><b>SPACE</b> override boost</span>
        <span class="key-hint"><b>V</b> ERS mode</span>
        <span class="key-hint"><b>P</b> box</span>
        <span class="key-hint"><b>C</b> camera</span>
        <span class="key-hint"><b>ESC</b> pause</span>
        <span class="footer-brand">APEX FORMULA ${SEASON} — an original racing simulation</span>
        ${TACN_FOOTER}
      </div>`;
    el.querySelectorAll('.nav-item').forEach(n =>
      n.addEventListener('click', () => {
        // 'champNew' is its own action in the callback protocol; the rest of the
        // tiles are menu payloads.
        const a = n.dataset.a;
        if (a === 'champNew') this.cb('champNew');
        else this.cb('menu', a);
      }));
    this._enter(el);
  }

  // ============ TEAM SELECT ============
  showTeamSelect(mode) {
    this.hideAll();
    this.sel.mode = mode;
    const el = this.screens.team;
    el.className = 'screen active menu-screen';
    el.innerHTML = `
      ${header('CHOOSE YOUR <small>DRIVER</small>')}
      <div class="menu-body"><div class="card-grid" id="team-grid"></div>
        <div class="btn-row">
          <button class="f1-btn ghost" id="btn-back"><span>← BACK</span></button>
          <button class="f1-btn" id="btn-next" disabled><span>CONTINUE →</span></button>
        </div>
      </div>
      <div class="menu-footer"><span>${SEASON} grid — ${TEAMS.length} teams · ${DRIVERS.length} drivers · original line-ups</span>
        <span style="margin-left:auto">Hover or focus a driver for pace / consistency / racecraft</span></div>`;
    const grid = el.querySelector('#team-grid');
    for (const team of TEAMS) {
      const drs = DRIVERS.filter(d => d.team === team.id);
      const card = document.createElement('div');
      card.className = 'select-card';
      const col = hex(team.color);
      const acc = hex(team.accent);
      const ink = readable(team.color);   // legible tint for text-sized elements
      card.innerHTML = `
        <div class="stripe" style="background:linear-gradient(90deg, ${col}, ${acc})"></div>
        <div class="card-body">
          <h4>${team.name}</h4>
          <div class="sub">${team.engine} power unit</div>
          <div class="badge-row">
            <span class="engine-badge" title="${team.engine} power unit"><i class="engine-glyph" style="color:${ink}">${ENGINE_GLYPH[team.engine] || '⬣'}</i>${team.engine}</span>
            <span class="livery-chips" title="Car livery">${liveryChips(team)}</span>
          </div>
          <div class="drivers">
            ${drs.map(d => `<div class="drv" data-d="${d.id}" role="radio" tabindex="0" aria-checked="false" aria-label="${d.firstName} ${d.lastName}, number ${d.num}">
              <div class="drv-top">
                <span class="num" style="color:${ink}">${d.num}</span>
                <span class="drv-name">${d.firstName} ${d.lastName}</span><span class="code">${d.code}</span>
              </div>
              <div class="drv-stats">
                ${statBar('PAC', d.pace)}${statBar('CON', d.consistency)}${statBar('RCF', d.racecraft)}
              </div>
            </div>`).join('')}
          </div>
          <div class="perf-row"><span class="perf-lbl">CAR</span>
            <div class="perfbar"><div style="width:${(team.perf - 0.88) / 0.12 * 100}%;background:linear-gradient(90deg,${col},${acc})"></div></div>
            <span class="perf-val">${Math.round((team.perf - 0.88) / 0.12 * 100)}</span></div>
        </div>`;
      grid.appendChild(card);
    }
    grid.addEventListener('click', ev => {
      const drv = ev.target.closest('.drv');
      if (!drv) return;
      grid.querySelectorAll('.drv.selected, .select-card.selected').forEach(x => x.classList.remove('selected'));
      grid.querySelectorAll('.drv[aria-checked="true"]').forEach(x => x.setAttribute('aria-checked', 'false'));
      drv.classList.add('selected');
      drv.setAttribute('aria-checked', 'true');
      drv.closest('.select-card').classList.add('selected');
      this.sel.driverId = drv.dataset.d;
      el.querySelector('#btn-next').disabled = false;
      this.cb('uiclick');
    });
    grid.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const drv = ev.target.closest('.drv');
      if (!drv) return;
      ev.preventDefault();
      drv.click();
    });
    el.querySelector('#btn-back').addEventListener('click', () => this.cb('back', 'main'));
    el.querySelector('#btn-next').addEventListener('click', () => {
      if (!this.sel.driverId) return;
      this.cb('teamChosen', { driverId: this.sel.driverId, mode: this.sel.mode });
    });
    // restore a previous selection (e.g. after backing out of circuit select)
    if (this.sel.driverId) {
      const prev = grid.querySelector(`.drv[data-d="${this.sel.driverId}"]`);
      if (prev) {
        prev.classList.add('selected');
        prev.setAttribute('aria-checked', 'true');
        prev.closest('.select-card').classList.add('selected');
        el.querySelector('#btn-next').disabled = false;
      }
    }
    this._enter(el);
  }

  // ============ TRACK SELECT ============
  // `champ` is optional: when a career is running its next round gets a badge.
  showTrackSelect(champ = null) {
    this.hideAll();
    const el = this.screens.track;
    el.className = 'screen active menu-screen';
    const nextId = champ && champ.active && champ.nextRace ? champ.nextRace.trackId : null;
    const focusId = nextId || this.sel.trackId || PILOT_TRACK_ID;
    el.innerHTML = `
      ${header('SELECT <small>CIRCUIT</small>')}
      <div class="menu-body"><div class="card-grid" id="track-grid"></div>
        <div class="btn-row"><button class="f1-btn ghost" id="btn-back"><span>← BACK</span></button></div>
      </div>
      <div class="menu-footer"><span>${SEASON} calendar — 24 rounds${this.sel.mode === 'trial' ? ' · TIME TRIAL' : ''}</span>
        <span style="margin-left:auto">Corner counts estimated from circuit geometry</span></div>`;
    const grid = el.querySelector('#track-grid');
    let nextCard = null;
    for (const race of CALENDAR) {
      const t = TRACKS[race.trackId];
      if (!t) continue;
      const card = document.createElement('div');
      card.className = 'select-card track-card' + (race.trackId === nextId ? ' next-round' : '');
      card.dataset.t = race.trackId;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `${race.gp}, ${circuitLabel(race, t)}, ${t.lengthKm.toFixed(3)} kilometres`);
      card.innerHTML = `
        <div class="round-badge">R${race.round}</div>
        ${race.trackId === nextId ? '<div class="next-badge">NEXT ROUND</div>' : ''}
        <div class="map-wrap"><canvas width="230" height="126"></canvas></div>
        <div class="card-body">
          <h4>${FLAGS[race.trackId] || ''} ${race.gp}</h4>
          <div class="sub">${circuitLabel(race, t)}</div>
          <div class="tstats">
            <span class="tstat"><b>${t.lengthKm.toFixed(3)}</b><i>KM</i></span>
            <span class="tstat"><b>${this.sel.mode === 'trial' ? '1' : this.raceLapsFor(race.trackId)}</b><i>${this.sel.mode === 'trial' ? 'HOTLAP' : 'LAPS'}</i></span>
            <span class="tstat"><b>${cornerCount(t.points)}</b><i>CORNERS</i></span>
          </div>
          <div class="meta"><span>${race.date.slice(5).replace('-', '/')}</span><span class="track-badges">${trackBadges(race.trackId)}</span></div>
        </div>`;
      grid.appendChild(card);
      drawTrackPreview(card.querySelector('canvas'), t.points);
      card.addEventListener('click', () => {
        this.sel.trackId = race.trackId;
        this._saveLastSelection();
        this.cb('trackChosen', { ...this.sel });
      });
      card.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        card.click();
      });
      if (race.trackId === focusId) nextCard = card;
    }
    el.querySelector('#btn-back').addEventListener('click', () => this.cb('back', 'team'));
    if (nextCard && typeof nextCard.scrollIntoView === 'function') {
      nextCard.scrollIntoView({ block: 'nearest' });
    }
    this._enter(el);
  }

  // ============ SETTINGS ============
  showSettings(returnTo = 'main') {
    this.hideAll();
    const el = this.screens.settings;
    el.className = 'screen active menu-screen';
    const s = this.settings;
    const settingLabels = {
      difficulty: 'AI difficulty', distance: 'Race distance', quali: 'Qualifying',
      tc: 'Traction control', abs: 'Anti-lock brakes', autoGear: 'Gearbox',
      nametags: 'Driver nametags', graphicsQuality: 'Graphics quality',
      cameraProfile: 'Camera style', autoPause: 'Auto pause',
      touchControls: 'Touch controls', volume: 'Master volume',
      steeringResponse: 'Keyboard steering response', cockpitFov: 'Cockpit field of view',
      cockpitSeat: 'Cockpit seat position', headMotion: 'Cockpit head motion',
    };
    const seg = (key, opts, cur) => `<div class="seg" data-k="${key}" role="group" aria-label="${settingLabels[key] || key}">${opts.map((o, i) =>
      `<button type="button" class="${i === cur ? 'on' : ''}" data-v="${i}" aria-pressed="${i === cur}">${o}</button>`).join('')}</div>`;
    const row = (title, desc, ctrl) =>
      `<div class="setting-row"><div class="label"><h4>${title}</h4><p>${desc}</p></div>${ctrl}</div>`;
    const group = (name, note, rows) =>
      `<section class="set-group"><header class="set-group-head"><h3>${name}</h3><span>${note}</span></header>${rows}</section>`;
    el.innerHTML = `
      ${header('SETTINGS')}
      <div class="menu-body"><div class="settings-list">
        ${group('RACE', 'Race weekend format', `
          ${row('AI Difficulty', 'How fast the field races', seg('difficulty', ['ROOKIE', 'PRO', 'ELITE'], s.difficulty))}
          ${row('Race Distance', 'Laps per race', seg('distance', ['5 LAPS', '25%', '50%', '100%'], s.distance))}
          ${row('Qualifying', 'One-lap shootout sets your grid slot', seg('quali', ['OFF', 'ON'], s.quali ? 1 : 0))}`)}
        ${group('ASSISTS', 'Driving aids', `
          ${row('Traction Control', 'Tames wheelspin out of corners', seg('tc', ['OFF', 'ON'], s.tc ? 1 : 0))}
          ${row('ABS', 'Prevents brake lockups', seg('abs', ['OFF', 'ON'], s.abs ? 1 : 0))}
          ${row('Gearbox', 'Automatic or manual (Q/E to shift)', seg('autoGear', ['MANUAL', 'AUTO'], s.autoGear ? 1 : 0))}
          ${row('Arrow-key Steering', 'Progressive input filtering and steering return', seg('steeringResponse', ['CALM', 'BALANCED', 'DIRECT'], ['calm', 'balanced', 'direct'].indexOf(s.steeringResponse)))}`)}
        ${group('DISPLAY', 'On-track information', `
          ${row('Driver Nametags', 'Show 3-letter codes above AI cars', seg('nametags', ['OFF', 'ON'], s.nametags ? 1 : 0))}
          ${row('Graphics Quality', 'Auto adjusts resolution and effects to hold frame rate', seg('graphicsQuality', ['AUTO', 'LOW', 'MED', 'HIGH'], ['auto', 'low', 'medium', 'high'].indexOf(s.graphicsQuality)))}
          ${row('Camera Style', 'Chase-camera distance, motion and field of view', seg('cameraProfile', ['TIGHT', 'BROADCAST', 'CINEMATIC'], ['tight', 'broadcast', 'cinematic'].indexOf(s.cameraProfile)))}
          ${row('Cockpit FOV', 'Driver-eye field-of-view framing', seg('cockpitFov', ['FOCUSED', 'NATURAL', 'WIDE'], ['focused', 'natural', 'wide'].indexOf(s.cockpitFov)))}
          ${row('Cockpit Seat', 'Driver eye height inside the halo', seg('cockpitSeat', ['LOW', 'STANDARD', 'HIGH'], ['low', 'standard', 'high'].indexOf(s.cockpitSeat)))}
          ${row('Head Motion', 'Restrained acceleration and kerb response', seg('headMotion', ['OFF', 'ON'], s.headMotion !== false ? 1 : 0))}`)}
        ${group('BEHAVIOUR', 'Device and focus handling', `
          ${row('Auto Pause', 'Pause when the game loses focus', seg('autoPause', ['OFF', 'ON'], s.autoPause !== false ? 1 : 0))}
          ${row('Touch Controls', 'Show steering and pedal controls on touch devices', seg('touchControls', ['OFF', 'ON'], s.touchControls !== false ? 1 : 0))}`)}
        ${group('AUDIO', 'Mix', `
          ${row('Master Volume', 'Engine + effects', seg('volume', ['MUTE', '50%', '100%'], s.volume === 0 ? 0 : s.volume < 0.9 ? 1 : 2))}`)}
      </div>
      <div class="btn-row">
        <button class="f1-btn ghost" id="btn-back"><span>← BACK</span></button>
        <button class="f1-btn ghost danger" id="btn-reset"><span>RESET TO DEFAULTS</span></button>
      </div>
      </div>
      <div class="menu-footer"><span>Settings save automatically</span></div>`;
    el.querySelectorAll('.seg').forEach(segEl => {
      segEl.addEventListener('click', ev => {
        const b = ev.target.closest('button');
        if (!b) return;
        const k = segEl.dataset.k, v = +b.dataset.v;
        segEl.querySelectorAll('button').forEach(x => {
          x.classList.remove('on');
          x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('on');
        b.setAttribute('aria-pressed', 'true');
        if (k === 'difficulty' || k === 'distance') this.settings[k] = v;
        else if (k === 'graphicsQuality') this.settings[k] = ['auto', 'low', 'medium', 'high'][v] || 'auto';
        else if (k === 'cameraProfile') this.settings[k] = ['tight', 'broadcast', 'cinematic'][v] || 'broadcast';
        else if (k === 'steeringResponse') this.settings[k] = ['calm', 'balanced', 'direct'][v] || 'balanced';
        else if (k === 'cockpitFov') this.settings[k] = ['focused', 'natural', 'wide'][v] || 'natural';
        else if (k === 'cockpitSeat') this.settings[k] = ['low', 'standard', 'high'][v] || 'standard';
        else if (k === 'volume') this.settings.volume = [0, 0.5, 1][v];
        else this.settings[k] = v === 1;
        this.saveSettings();
        this.cb('settingsChanged', this.settings);
      });
    });
    el.querySelector('#btn-back').addEventListener('click', () => this.cb('back', returnTo));
    el.querySelector('#btn-reset').addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS };
      this.saveSettings();
      this.showSettings(returnTo);          // repaint every segment from defaults
      this.cb('settingsChanged', this.settings);
    });
    this._enter(el);
  }

  // ============ LOADING ============
  showLoading(race, track) {
    this.hideAll();
    const el = this.screens.loading;
    el.className = 'screen active load-screen';
    const corners = cornerCount(track.points);
    const venue = circuitLabel(race, track);
    const laps = this.sel.mode === 'trial' ? null : this.raceLapsFor(race.trackId);
    el.innerHTML = `
      <div class="load-wrap">
        <div class="load-panel">
          <div class="load-left">
            <div class="load-flag">${FLAGS[race.trackId] || '🏁'}</div>
            <div class="load-track-name">${race.gp}</div>
            <div class="load-track-sub">${venue} — ${track.location}</div>
            <div class="track-badges load-badges">${trackBadges(race.trackId)}</div>
            <div class="load-spinner"></div>
          </div>
          <div class="load-map"><canvas width="360" height="240"></canvas></div>
        </div>
        <div class="load-tip load-fact" id="load-fact"></div>
      </div>`;
    drawTrackPreview(el.querySelector('.load-map canvas'), track.points, 'rgba(255,255,255,0.9)');
    // rotating fact line built from the active calendar / circuit data
    const facts = [
      `ROUND ${race.round} OF ${CALENDAR.length} · ${race.date}`,
      `${venue} — ${track.lengthKm.toFixed(3)} km, ${corners} corners (estimated from the layout)`,
      laps ? `Race distance: ${laps} laps · ${(laps * track.lengthKm).toFixed(1)} km` : 'Time trial: one flying lap, empty circuit',
      `Track width ${track.width} m · ${STREET_TRACKS.has(race.trackId) ? 'street circuit, walls close' : 'permanent circuit with run-off'}`,
      TIPS[(Math.random() * TIPS.length) | 0],
      TIPS[(Math.random() * TIPS.length) | 0],
    ];
    let fi = (Math.random() * facts.length) | 0;
    const paint = () => {
      const node = el.querySelector('#load-fact');
      if (!node) { this._stopFacts(); return; }
      node.textContent = facts[fi % facts.length];
      if (node.classList) {
        node.classList.remove('fact-in');
        void node.offsetWidth;
        node.classList.add('fact-in');
      }
      fi++;
    };
    paint();
    this._stopFacts();
    this._factTimer = setInterval(paint, 3200);
    this._enter(el);
  }

  showLoadError(race, track) {
    this.hideAll();
    const el = this.screens.loading;
    const venue = circuitLabel(race, track);
    el.className = 'screen active load-screen load-error-screen';
    el.innerHTML = `
      <div class="load-wrap" role="alert" aria-labelledby="load-error-title">
        <div class="load-panel">
          <div class="load-left">
            <div class="load-flag">${FLAGS[race.trackId] || '🏁'}</div>
            <div class="load-track-name" id="load-error-title">RACE LOAD INTERRUPTED</div>
            <div class="load-track-sub">${race.gp} · ${venue}</div>
            <p class="load-tip">A required race asset could not be loaded. Check your connection, then retry without losing your selection.</p>
            <div class="btn-row">
              <button type="button" class="f1-btn primary" id="btn-retry">RETRY</button>
              <button type="button" class="f1-btn" id="btn-menu">MAIN MENU</button>
            </div>
          </div>
        </div>
      </div>`;
    el.querySelector('#btn-retry').addEventListener('click', () => this.cb('retryLoad'));
    el.querySelector('#btn-menu').addEventListener('click', () => this.cb('back', 'main'));
    this._enter(el);
    this._setNavFocus(el, el.querySelector('#btn-retry'));
  }

  // ============ QUALI RESULTS ============
  showQualiResults(rows, playerId, race, options = {}) {
    this.hideAll();
    const el = this.screens.results;
    el.className = 'screen active menu-screen';
    const pole = rows[0];
    const spread = Math.max(0.001, rows[rows.length - 1].time - pole.time);
    const title = options.title || 'QUALIFYING <small>CLASSIFICATION</small>';
    const leaderLabel = options.leaderLabel || 'POLE';
    const primaryLabel = options.primaryLabel || 'START RACE →';
    const primaryAction = options.primaryAction || 'startRaceAfterQuali';
    const restartButton = options.allowRestart === false ? '' :
      '<button class="f1-btn ghost" id="btn-requali"><span>RE-RUN QUALIFYING</span></button>';
    const footer = options.footer || `${race.gp} — grid set by qualifying`;
    el.innerHTML = `
      ${header(title)}
      <div class="menu-body">
        <table class="results-table">
          <tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>TIME</th><th>GAP</th></tr>
          ${rows.map((r, i) => {
            const d = DRIVERS.find(x => x.id === r.driverId);
            const t = teamById[d.team];
            const gap = r.time - pole.time;
            return `<tr class="${r.driverId === playerId ? 'player-row' : ''}${i === 0 ? ' pole-row' : ''}">
              <td class="pos-cell">${i + 1}</td>
              <td><span class="teambar" style="background:${hex(t.color)}"></span>${d.firstName} ${d.lastName}</td>
              <td style="color:var(--text-dim)">${t.name}</td>
              <td class="ftime">${fmtTime(r.time)}</td>
              <td class="ftime gap-cell">${i === 0 ? `<b class="pole-tag">${leaderLabel}</b>` : '+' + gap.toFixed(3)}
                ${i === 0 ? '' : `<span class="gap-bar"><i style="width:${Math.min(100, gap / spread * 100).toFixed(1)}%;background:${hex(t.color)}"></i></span>`}</td></tr>`;
          }).join('')}
        </table>
        <div class="btn-row">
          <button class="f1-btn" id="btn-race"><span>${primaryLabel}</span></button>
          ${restartButton}
          <button class="f1-btn ghost" id="btn-menu"><span>MAIN MENU</span></button>
        </div>
      </div>
      <div class="menu-footer"><span>${footer}</span></div>`;
    el.querySelector('#btn-race').addEventListener('click', () => this.cb(primaryAction));
    el.querySelector('#btn-requali')?.addEventListener('click', () => this.cb('restartRace'));
    el.querySelector('#btn-menu').addEventListener('click', () => this.cb('back', 'main'));
    this._enter(el);
  }

  // ============ RACE RESULTS ============
  showResults(results, fastestLap, race, mode, champActive) {
    this.hideAll();
    const el = this.screens.results;
    el.className = 'screen active menu-screen';
    if (mode === 'trial') {
      const p = results[0];
      el.innerHTML = `
        ${header('TIME TRIAL <small>COMPLETE</small>')}
        <div class="menu-body" style="text-align:center">
          <div style="font-size:20px;color:var(--text-dim);margin-top:4vh">BEST LAP</div>
          <div class="trial-time">${p.bestLap ? fmtTime(p.bestLap) : '—'}</div>
          <div class="btn-row" style="justify-content:center">
            <button class="f1-btn" id="btn-again"><span>RUN IT AGAIN</span></button>
            <button class="f1-btn ghost" id="btn-menu"><span>MAIN MENU</span></button>
          </div>
        </div><div class="menu-footer"><span>${race.gp}</span></div>`;
      el.querySelector('#btn-again').addEventListener('click', () => this.cb('restartRace'));
      el.querySelector('#btn-menu').addEventListener('click', () => this.cb('back', 'main'));
      this._enter(el);
      return;
    }
    const podium = results.slice(0, 3);
    // grid slots are not part of the results rows today; render the
    // positions-gained column only when a build does supply them.
    const showGain = results.some(r => gridOf(r) !== null);
    const player = results.find(r => r.isPlayer);
    el.innerHTML = `
      ${header('RACE <small>CLASSIFICATION</small>')}
      <div class="menu-body">
        <div class="podium-strip">
          ${podium.map((r, i) => `
            <div class="podium-card shine p${i + 1}" style="border-top-color:${hex(r.team.color)};--shine-delay:${i * 260}ms">
              <div class="p">P${i + 1}</div>
              <h3>${r.driver.firstName} ${r.driver.lastName}</h3>
              <p>${r.team.name} · ${r.gapText}</p>
              ${r.points ? `<div class="podium-pts">${r.points} PTS</div>` : ''}
            </div>`).join('')}
        </div>
        <table class="results-table">
          <tr><th>POS</th>${showGain ? '<th>+/−</th>' : ''}<th>DRIVER</th><th>TEAM</th><th>TIME</th><th>STOPS</th><th>BEST LAP</th><th>PTS</th></tr>
          ${results.map(r => `<tr class="${r.isPlayer ? 'player-row' : ''}">
            <td class="pos-cell">${r.dnf ? 'NC' : r.pos}</td>
            ${showGain ? `<td>${gainChip(r)}</td>` : ''}
            <td><span class="teambar" style="background:${hex(r.team.color)}"></span>${r.driver.firstName} ${r.driver.lastName}</td>
            <td style="color:var(--text-dim)">${r.team.name}</td>
            <td class="ftime">${r.gapText}</td>
            <td class="ftime">${r.pits}</td>
            <td class="ftime ${r.fastestLap ? 'fl' : ''}">${r.bestLap ? fmtTime(r.bestLap) : '—'}${r.fastestLap ? ' ●' : ''}</td>
            <td class="pts${r.isPlayer ? ' pts-count' : ''}">${r.isPlayer ? '' : (r.points || '')}</td></tr>`).join('')}
        </table>
        ${tacnCard()}
        <div class="btn-row">
          <button class="f1-btn" id="btn-continue"><span>${champActive ? 'CONTINUE →' : 'MAIN MENU'}</span></button>
          ${champActive ? '' : '<button class="f1-btn ghost" id="btn-restart"><span>RESTART RACE</span></button>'}
        </div>
      </div>
      <div class="menu-footer"><span>${race.gp}${fastestLap ? ` · FASTEST LAP: ${fastestLap.name} ${fmtTime(fastestLap.time)}` : ''}</span></div>`;
    el.querySelector('#btn-continue').addEventListener('click', () => this.cb(champActive ? 'afterRaceChamp' : 'back', 'main'));
    const restartBtn = el.querySelector('#btn-restart');
    if (restartBtn) restartBtn.addEventListener('click', () => this.cb('restartRace'));
    if (player) this._countUp(el.querySelector('.pts-count'), player.points || 0);
    this._enter(el);
  }

  // ============ STANDINGS ============
  showStandings(champ, showNext) {
    this.hideAll();
    const el = this.screens.standings;
    el.className = 'screen active menu-screen';
    const ds = champ.driverStandings();
    const ts = champ.teamStandings();
    const log = typeof champ.resultsLog === 'function' ? champ.resultsLog() : [];
    el.innerHTML = `
      ${header('CHAMPIONSHIP <small>STANDINGS</small>')}
      <div class="menu-body">
        <div class="season-panels">
          ${roundStrip(log, champ.playerDriverId)}
          ${pointsBars(ds, champ.playerDriverId)}
        </div>
        <div class="stand-cols">
          <div class="stand-col wide">
            <h3 class="f1-heading stand-head">DRIVERS</h3>
            <table class="results-table">
              <tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>WINS</th><th>PTS</th></tr>
              ${ds.map(r => `<tr class="${r.driver.id === champ.playerDriverId ? 'player-row' : ''}">
                <td class="pos-cell">${r.pos}</td>
                <td><span class="teambar" style="background:${hex(teamById[r.driver.team].color)}"></span>${r.driver.firstName} ${r.driver.lastName}</td>
                <td style="color:var(--text-dim)">${teamById[r.driver.team].name}</td>
                <td class="ftime">${r.wins}</td><td class="pts">${r.points}</td></tr>`).join('')}
            </table>
          </div>
          <div class="stand-col">
            <h3 class="f1-heading stand-head">CONSTRUCTORS</h3>
            <table class="results-table">
              <tr><th>POS</th><th>TEAM</th><th>PTS</th></tr>
              ${ts.map(r => `<tr><td class="pos-cell">${r.pos}</td>
                <td><span class="teambar" style="background:${hex(r.team.color)}"></span>${r.team.name}</td>
                <td class="pts">${r.points}</td></tr>`).join('')}
            </table>
          </div>
        </div>
        <div class="btn-row">
          ${showNext && champ.active ? `<button class="f1-btn" id="btn-nextrace"><span>NEXT: ${champ.nextRace.gp} →</span></button>` : ''}
          ${champ.finished ? `<div class="podium-card champ-card shine" style="max-width:none"><h3>🏆 ${champName(ds)} IS THE ${SEASON} WORLD CHAMPION</h3></div>` : ''}
          <button class="f1-btn ghost" id="btn-menu"><span>MAIN MENU</span></button>
          <button class="f1-btn ghost danger" id="btn-abandon"><span>ABANDON SEASON</span></button>
        </div>
      </div>
      <div class="menu-footer"><span>Round ${Math.min(champ.roundIndex, 24)} of 24 complete</span></div>`;
    const nx = el.querySelector('#btn-nextrace');
    if (nx) nx.addEventListener('click', () => this.cb('champNextRace'));
    el.querySelector('#btn-menu').addEventListener('click', () => this.cb('back', 'main'));
    el.querySelector('#btn-abandon').addEventListener('click', () => this.cb('abandonSeason'));
    this._enter(el);
  }

  // ============ PAUSE ============
  showPause() {
    const el = this.screens.pause;
    el.className = 'screen active';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'pause-title');
    el.innerHTML = `
      <div class="main-nav pause-nav" style="width:420px">
        <div class="pause-title" id="pause-title">PAUSED</div>
        <button type="button" class="nav-item" data-a="resume"><span><h3>RESUME</h3></span></button>
        <button type="button" class="nav-item" data-a="restart"><span><h3>RESTART</h3></span></button>
        <button type="button" class="nav-item" data-a="quit"><span><h3>QUIT TO MENU</h3></span></button>
      </div>`;
    el.querySelectorAll('.nav-item').forEach(n =>
      n.addEventListener('click', () => this.cb('pause', n.dataset.a)));
    this._enter(el);
  }
  hidePause() { this.screens.pause.classList.remove('active'); }
}

// Owner's brand card under the race classification.
function tacnCard() {
  return `<section class="tacn-card">
    <h3 class="tacn-card-head">BUILT BY AI AGENTS</h3>
    <p class="tacn-card-sub">This entire game was built autonomously by AI. Want this capability in your business? ${TACN_URL}</p>
  </section>`;
}

function header(title) {
  return `<div class="menu-header"><div class="brand">APEX<em>FORMULA</em> ${SEASON}</div><div class="title">${title}</div></div>`;
}
function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }
function champName(ds) {
  const d = ds[0].driver;
  return (d.firstName + ' ' + d.lastName).toUpperCase();
}

// ---- small view helpers ---------------------------------------------------

// Driver rating bar. Ratings live in data.js on a ~0.80-0.99 scale; stretch
// that window so the bars actually differentiate the field.
function statBar(key, v) {
  const val = Number(v) || 0;
  const pct = Math.max(4, Math.min(100, (val - 0.78) / 0.22 * 100));
  return `<div class="stat-row"><i class="stat-key">${key}</i>
    <span class="stat-bar"><b style="width:${pct.toFixed(0)}%"></b></span>
    <u class="stat-val">${Math.round(val * 100)}</u></div>`;
}

// Livery chip strip: primary, accent and two derived shades — a stand-in for a
// car render, built from the same colors the 3D car paint uses.
function liveryChips(team) {
  const c = team.color, a = team.accent;
  const cols = [shade(c, 1.25), hex(c), shade(c, 0.62), hex(a), shade(a, 1.2)];
  return cols.map(col => `<i style="background:${col}"></i>`).join('');
}
// Text tinted with a team colour has to stay legible on the dark panels. The
// near-black liveries (including TACN's blue-charcoal) and deep navies fail otherwise, on
// either roster. Blend toward white until the relative luminance clears a
// floor, which keeps the hue.
function readable(n, floor = 0.55) {
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= floor) return `rgb(${r},${g},${b})`;
  const t = (floor - lum) / (1 - lum);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return `rgb(${r},${g},${b})`;
}
function shade(n, k) {
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

function trackBadges(trackId) {
  const out = [];
  if (STREET_TRACKS.has(trackId)) out.push('<i class="tbadge street">STREET</i>');
  const theme = TRACK_THEME[trackId];
  if (theme === 'night') out.push('<i class="tbadge night">NIGHT</i>');
  else if (theme === 'dusk') out.push('<i class="tbadge dusk">TWILIGHT</i>');
  return out.join('');
}

// Positions gained: results rows do not currently carry a grid slot, so this is
// rendered only when one is present under any of the plausible field names.
function gridOf(r) {
  for (const k of ['gridPos', 'grid', 'startPos', 'gridPosition']) {
    if (typeof r[k] === 'number' && isFinite(r[k]) && r[k] > 0) return r[k];
  }
  return null;
}
function gainChip(r) {
  const g = gridOf(r);
  if (g === null || r.dnf) return '';
  const d = g - r.pos;
  if (d === 0) return '<span class="gain-chip same">=</span>';
  return `<span class="gain-chip ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

// Main-menu season header: what the career is doing right now.
function seasonStrip(champ) {
  if (!champ) return '';
  if (champ.active && champ.nextRace) {
    const race = champ.nextRace;
    const t = TRACKS[race.trackId] || {};
    let standing = '';
    if (typeof champ.driverStandings === 'function' && champ.playerDriverId) {
      const ds = champ.driverStandings();
      const me = ds.find(r => r.driver.id === champ.playerDriverId);
      if (me) standing = `<div class="ss-pos"><i>YOU</i><b>P${me.pos}</b><span>${me.points} PTS</span></div>`;
    }
    return `<div class="season-strip">
      <div class="ss-round"><i>NEXT ROUND</i><b>${race.round}<em>/${CALENDAR.length}</em></b></div>
      <div class="ss-gp"><span class="ss-flag">${FLAGS[race.trackId] || '🏁'}</span>
        <b>${race.gp}</b><i>${circuitLabel(race, t)}${t.location ? ' · ' + t.location : ''}</i></div>
      <div class="ss-meta">${race.laps} LAPS${t.lengthKm ? ` · ${t.lengthKm.toFixed(3)} KM` : ''} · ${race.date}
        <span class="track-badges">${trackBadges(race.trackId)}</span></div>
      ${standing}
    </div>`;
  }
  if (champ.finished && typeof champ.driverStandings === 'function') {
    const ds = champ.driverStandings();
    return `<div class="season-strip done">
      <div class="ss-round"><i>SEASON</i><b>${SEASON}<em> COMPLETE</em></b></div>
      <div class="ss-gp"><span class="ss-flag">🏆</span><b>${champName(ds)}</b><i>World Champion — ${ds[0].points} points</i></div>
    </div>`;
  }
  return '';
}

// Per-round finish strip for the player, coloured by result band.
function roundStrip(log, playerId) {
  if (!playerId) return '';
  const byRound = new Map();
  for (const r of log || []) byRound.set(r.round, r);
  const dots = CALENDAR.map(race => {
    const rec = byRound.get(race.round);
    if (!rec) return `<i class="rd pending" title="R${race.round} ${race.gp}">${race.round}</i>`;
    // NOTE: test `!p` first — a null / 0 playerPos would otherwise satisfy
    // `p <= 3` and be painted as a podium.
    const p = rec.playerPos;
    const band = !p ? 'b-dnf' : p === 1 ? 'b-win' : p <= 3 ? 'b-pod' : p <= 10 ? 'b-pts' : 'b-out';
    return `<i class="rd ${band}" title="R${race.round} ${race.gp} — ${p ? 'P' + p : 'NC'}">${p || '—'}</i>`;
  }).join('');
  const done = log ? log.length : 0;
  return `<section class="panel round-panel">
    <header class="panel-head"><h3>YOUR SEASON</h3><span>${done} of ${CALENDAR.length} rounds</span></header>
    <div class="round-strip">${dots}</div>
    <footer class="strip-key">
      <span><i class="rd b-win"></i>WIN</span><span><i class="rd b-pod"></i>PODIUM</span>
      <span><i class="rd b-pts"></i>POINTS</span><span><i class="rd b-out"></i>OUT OF POINTS</span>
      <span><i class="rd b-dnf"></i>NO RESULT</span>
    </footer>
  </section>`;
}

// Points progress toward the championship leader — pure CSS bars.
function pointsBars(ds, playerId) {
  const top = ds.slice(0, 6);
  const lead = Math.max(1, top[0] ? top[0].points : 1);
  return `<section class="panel bars-panel">
    <header class="panel-head"><h3>POINTS PROGRESS</h3><span>top 6 vs leader</span></header>
    <div class="pts-bars">
      ${top.map(r => {
        const col = hex(teamById[r.driver.team].color);
        const w = Math.max(2, r.points / lead * 100);
        const gap = top[0].points - r.points;
        return `<div class="pb-row${r.driver.id === playerId ? ' me' : ''}">
          <span class="pb-name">${r.driver.code}</span>
          <span class="pb-track"><i style="width:${w.toFixed(1)}%;background:linear-gradient(90deg,${col},${shade(teamById[r.driver.team].color, 1.5)})"></i></span>
          <span class="pb-val">${r.points}</span>
          <span class="pb-gap">${gap ? '−' + gap : 'LEADER'}</span>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

// ---- circuit geometry ----------------------------------------------------
// Corner count estimated from the control-point polyline: curvature (rad/m)
// above a threshold opens a corner; a direction change or more than ~69° of
// accumulated rotation starts a new one. Cached per point array.
const _cornerCache = new WeakMap();
const CORNER_K = 0.003;      // rad per metre
const CORNER_SPLIT = 1.2;    // rad of accumulated turn before a run splits

export function cornerCount(points) {
  if (!points || points.length < 4) return 0;
  const hit = _cornerCache.get(points);
  if (hit !== undefined) return hit;
  const n = points.length, m = [];
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n], c = points[i], q = points[(i + 1) % n];
    const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
    const a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const len = (Math.hypot(c[0] - p[0], c[1] - p[1]) + Math.hypot(q[0] - c[0], q[1] - c[1])) / 2;
    m.push({ d, k: Math.abs(d) / Math.max(1, len) });
  }
  // start on the straightest point so a corner is never split by the wrap
  let start = 0;
  for (let i = 1; i < n; i++) if (m[i].k < m[start].k) start = i;
  let corners = 0, run = 0, sign = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const { d, k } = m[(start + i) % n];
    const s = Math.sign(d);
    if (k >= CORNER_K) {
      if (run === 0 || s !== sign || acc >= CORNER_SPLIT) { corners++; acc = 0; }
      run++; sign = s; acc += Math.abs(d);
    } else { run = 0; sign = 0; acc = 0; }
  }
  _cornerCache.set(points, corners);
  return corners;
}

export function drawTrackPreview(canvas, points, color = '#ffffff') {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 12;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const sc = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * sc) / 2 - minX * sc;
  const oz = (H - (maxZ - minZ) * sc) / 2 - minZ * sc;
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  // smooth through midpoints (quadratic) for a clean preview from sparse control points
  const P = points.map(([x, z]) => [x * sc + ox, z * sc + oz]);
  const n = P.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m0 = mid(P[n - 1], P[0]);
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const p = P[i], m1 = mid(p, P[(i + 1) % n]);
    ctx.quadraticCurveTo(p[0], p[1], m1[0], m1[1]);
  }
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // start dot
  ctx.fillStyle = '#e10600';
  ctx.beginPath();
  ctx.arc(P[0][0], P[0][1], 3, 0, 7);
  ctx.fill();
}
