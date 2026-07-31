// Lightweight cockpit presentation. The camera remains a real world-space
// seated camera; this procedural DOM layer supplies the parts a driver sees at
// arm's length (halo, wheel, dash and proximity mirrors) without another scene
// render or model-specific geometry dependency.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;

export const COCKPIT_FOV = Object.freeze({ focused: 62, natural: 70, wide: 78 });
export const COCKPIT_SEAT = Object.freeze({ low: 0.77, standard: 0.83, high: 0.89 });
const COCKPIT_FLAGS = Object.freeze({
  green: Object.freeze({ label: 'GREEN', className: 'green' }),
  blue: Object.freeze({ label: 'BLUE', className: 'blue' }),
  chequered: Object.freeze({ label: 'CHEQUERED', className: 'white' }),
  'local-yellow': Object.freeze({ label: 'LOCAL YELLOW', className: 'yellow' }),
  yellow: Object.freeze({ label: 'YELLOW', className: 'yellow' }),
  vsc: Object.freeze({ label: 'VSC', className: 'yellow' }),
  'safety-car': Object.freeze({ label: 'SAFETY CAR', className: 'yellow' }),
  'red-flag': Object.freeze({ label: 'RED FLAG', className: 'red' }),
  restart: Object.freeze({ label: 'RESTART', className: 'yellow' }),
});

export function cockpitFov(value) { return COCKPIT_FOV[value] || COCKPIT_FOV.natural; }
export function cockpitSeat(value) { return COCKPIT_SEAT[value] || COCKPIT_SEAT.standard; }

export function cockpitFlagState(session, player) {
  if (session?.phase === 'finished') return COCKPIT_FLAGS.chequered;
  const control = session?.raceControl?.state || (session?.vsc?.active ? 'vsc' : 'green');
  const controlled = control === 'green' ? null : COCKPIT_FLAGS[control];
  if (controlled) return controlled;
  if (session?.blueFlagFor === player?.driver?.id || player?._blueT > 0) {
    return COCKPIT_FLAGS.blue;
  }
  return COCKPIT_FLAGS.green;
}

export class CockpitView {
  constructor(root) {
    this.root = root;
    this.page = 0;
    this.active = false;
    this.onExport = null;
    this.onPage = null;
    root.innerHTML = `
      <div class="cockpit-halo" aria-hidden="true"><i></i><b></b></div>
      <div class="cockpit-mirror left" id="cp-mirror-left"><span>CAR LEFT</span></div>
      <div class="cockpit-mirror right" id="cp-mirror-right"><span>CAR RIGHT</span></div>
      <div class="cockpit-wheel" id="cp-wheel" aria-hidden="true">
        <i class="grip left"></i><i class="grip right"></i><i class="wheel-top"></i>
      </div>
      <section class="cockpit-screen" data-sim-panel="telemetry" aria-label="Formula steering wheel display">
        <div class="cp-shift" id="cp-shift"></div>
        <div class="cp-primary"><strong id="cp-gear">N</strong><span><b id="cp-speed">0</b><small>KM/H</small></span></div>
        <div class="cp-page page-0">
          <div><small>BBAL</small><b id="cp-bbal">56.0</b></div>
          <div><small>ERS</small><b id="cp-ers">BAL</b></div>
          <div><small>DEPLOY</small><b id="cp-deploy">0 kW</b></div>
          <div><small>BAT</small><b id="cp-battery">100%</b></div>
          <div><small>FUEL T/Δ</small><b id="cp-fuel">1.00/+0.00</b></div>
          <div><small>LAP Δ</small><b id="cp-delta">—</b></div>
        </div>
        <div class="cp-page page-1">
          <div><small>FL SURF</small><b id="cp-ts-fl">—</b></div>
          <div><small>FR SURF</small><b id="cp-ts-fr">—</b></div>
          <div><small>RL CARC</small><b id="cp-tc-rl">—</b></div>
          <div><small>RR CARC</small><b id="cp-tc-rr">—</b></div>
          <div><small>PRESS F</small><b id="cp-pf">—</b></div>
          <div><small>PRESS R</small><b id="cp-pr">—</b></div>
        </div>
        <div class="cp-footer"><b id="cp-flag">GREEN</b><b id="cp-compound">M</b><span id="cp-page-label">RACE 1/2</span></div>
      </section>
      <div class="cockpit-actions" role="group" aria-label="Cockpit display controls">
        <button type="button" id="cp-page-button">DASH PAGE <kbd>B</kbd></button>
        <button type="button" id="cp-export-button">EXPORT GHOST <kbd>J</kbd></button>
      </div>`;
    this.$ = (id) => root.querySelector('#' + id);
    this.shiftLights = [];
    for (let i = 0; i < 12; i++) {
      const light = document.createElement('i');
      this.$('cp-shift').appendChild(light);
      this.shiftLights.push(light);
    }
    this.$('cp-page-button').addEventListener('click', () => this.onPage?.());
    this.$('cp-export-button').addEventListener('click', () => this.onExport?.());
  }

  setActive(active) {
    this.active = !!active;
    this.root.classList.toggle('active', this.active);
  }

  nextPage() {
    this.page = (this.page + 1) % 2;
    this.root.dataset.page = String(this.page);
    this.$('cp-page-label').textContent = this.page ? 'TYRES 2/2' : 'RACE 1/2';
    return this.page;
  }

  update({ session, player, delta = null, steer = 0 }) {
    if (!this.active || !player?.phys) return;
    const p = player.phys;
    const rpm = clamp(finite(p.rpmFrac), 0, 1.08);
    const lit = clamp(Math.floor((rpm - 0.55) / 0.45 * 12), 0, 12);
    this.shiftLights.forEach((light, index) => light.classList.toggle('on', index < lit));
    this.$('cp-wheel').style.transform = `translateX(-50%) rotate(${finite(steer) * -112}deg)`;
    this.$('cp-gear').textContent = p.v < -0.1 ? 'R' : finite(p.gear, 1);
    this.$('cp-speed').textContent = Math.max(0, Math.round(finite(p.kmh)));
    this.$('cp-bbal').textContent = finite(p.brakeBias, 0.56) > 1
      ? finite(p.brakeBias, 56).toFixed(1) : (finite(p.brakeBias, 0.56) * 100).toFixed(1);
    this.$('cp-ers').textContent = ['HARV', 'BAL', 'ATTACK'][p.ersMode] || 'BAL';
    this.$('cp-deploy').textContent = `${Math.round(finite(p.ersDeploy) / 1000)} kW`;
    this.$('cp-battery').textContent = `${Math.round(clamp(finite(p.battery, 1), 0, 1) * 100)}%`;
    const lapsLeft = Math.max(1, finite(session?.laps, 1) - Math.max(0, finite(player.lap)));
    const fuelTarget = clamp(lapsLeft / Math.max(1, finite(session?.laps, 1)), 0, 1);
    const fuelDelta = finite(p.fuel, fuelTarget) - fuelTarget;
    this.$('cp-fuel').textContent = `${fuelTarget.toFixed(2)}/${fuelDelta >= 0 ? '+' : ''}${fuelDelta.toFixed(2)}`;
    this.$('cp-delta').textContent = Number.isFinite(delta)
      ? `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(3)}` : '—';
    this.$('cp-delta').className = Number.isFinite(delta) ? (delta <= 0 ? 'gain' : 'loss') : '';
    this.$('cp-compound').textContent = p.compound || 'M';
    this.$('cp-compound').className = `compound-${p.compound || 'M'}`;

    const wheels = Array.isArray(p.wheels) ? p.wheels : [];
    const fl = wheels[0], fr = wheels[1], rl = wheels[2], rr = wheels[3];
    const carcass = finite(p.tyreTemp, 88);
    const derivedSurface = clamp(carcass + finite(p.throttle) * 2.5 + finite(p.brake) * 5.5, 20, 180);
    this.$('cp-ts-fl').textContent = `${Math.round(finite(fl?.surfaceTemp, derivedSurface))}°`;
    this.$('cp-ts-fr').textContent = `${Math.round(finite(fr?.surfaceTemp, derivedSurface))}°`;
    this.$('cp-tc-rl').textContent = `${Math.round(finite(rl?.carcassTemp, carcass))}°`;
    this.$('cp-tc-rr').textContent = `${Math.round(finite(rr?.carcassTemp, carcass))}°`;
    const frontPressure = (finite(fl?.pressure, 154) + finite(fr?.pressure, 154)) * 0.5 * 0.145038;
    const rearPressure = (finite(rl?.pressure, 149) + finite(rr?.pressure, 149)) * 0.5 * 0.145038;
    this.$('cp-pf').textContent = `${frontPressure.toFixed(1)} psi`;
    this.$('cp-pr').textContent = `${rearPressure.toFixed(1)} psi`;

    const flag = cockpitFlagState(session, player);
    this.$('cp-flag').textContent = flag.label;
    this.$('cp-flag').className = flag.className;
    this._updateRadar(session, player);
  }

  _updateRadar(session, player) {
    let left = false, right = false;
    const p = player.phys;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    for (const entry of session?.entries || []) {
      if (entry === player || entry.dnf || entry.phys?.disabled) continue;
      const dx = entry.phys.pos.x - p.pos.x, dz = entry.phys.pos.z - p.pos.z;
      const longitudinal = dx * fx + dz * fz;
      const lateral = dx * fz - dz * fx;
      if (Math.abs(longitudinal) < 7.5 && Math.abs(lateral) < 4.5) {
        if (lateral < -0.8) left = true;
        if (lateral > 0.8) right = true;
      }
    }
    this.$('cp-mirror-left').classList.toggle('near', left);
    this.$('cp-mirror-right').classList.toggle('near', right);
  }
}
