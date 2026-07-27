// championship.js — Season / career state with localStorage persistence.
// NOTE: no fastest-lap point — abolished for 2025 onward; the fastest-lap
// driver is stored per round for display only.

import { DRIVERS, TEAMS, CALENDAR, POINTS, STORAGE_SUFFIX } from './data.js';

// The suffix preserves compatibility with saves created by earlier APEX builds.
const STORAGE_KEY = 'apexf1_2026_career' + (STORAGE_SUFFIX || '');

export function pointsFor(pos) {
  return POINTS[pos] || 0;
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

const DRIVER_BY_ID = new Map(DRIVERS.map((d) => [d.id, d]));

function freshState(playerDriverId) {
  return {
    playerDriverId: playerDriverId,
    roundIndex: 0,
    driverPoints: {}, // id -> points
    teamPoints: {}, // id -> points
    wins: {}, // driverId -> count
    podiums: {}, // driverId -> count
    teamWins: {}, // teamId -> count
    teamPodiums: {}, // teamId -> count
    results: [], // per-round result records
  };
}

function isValidState(s) {
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.playerDriverId === 'string' &&
    DRIVER_BY_ID.has(s.playerDriverId) &&
    typeof s.roundIndex === 'number' &&
    s.roundIndex >= 0 &&
    Array.isArray(s.results) &&
    !!s.driverPoints &&
    !!s.teamPoints
  );
}

export class Championship {
  constructor() {
    this._state = null;
    const store = storage();
    if (store) {
      try {
        const raw = store.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isValidState(parsed)) this._state = parsed;
        }
      } catch (e) {
        // Corrupt storage -> fresh (no career) state.
        this._state = null;
      }
    }
  }

  get active() {
    return !!this._state && this._state.roundIndex < CALENDAR.length;
  }

  get finished() {
    return !!this._state && this._state.roundIndex >= CALENDAR.length;
  }

  get roundIndex() {
    return this._state ? this._state.roundIndex : 0;
  }

  get nextRace() {
    if (!this._state) return null;
    return this._state.roundIndex < CALENDAR.length
      ? CALENDAR[this._state.roundIndex]
      : null;
  }

  get playerDriverId() {
    return this._state ? this._state.playerDriverId : null;
  }

  startNew(playerDriverId) {
    this._state = freshState(playerDriverId);
    this._save();
  }

  // classification: array (finishing order) of driverId strings OR
  // { id, dnf } objects. DNF entries score nothing (matching the results
  // screen); scoring position stays the classified index — no promotion.
  recordResult(classification, fastestLapDriverId) {
    if (!this._state || this.finished) return;
    if (!Array.isArray(classification) || classification.length === 0) return;

    const rows = classification.map((e) =>
      typeof e === 'string' ? { id: e, dnf: false } : { id: e.id, dnf: !!e.dnf }
    );
    const s = this._state;
    const race = CALENDAR[s.roundIndex];

    for (let i = 0; i < rows.length; i++) {
      const { id, dnf } = rows[i];
      const driver = DRIVER_BY_ID.get(id);
      if (!driver || dnf) continue;

      const pts = pointsFor(i);
      if (pts > 0) {
        s.driverPoints[id] = (s.driverPoints[id] || 0) + pts;
        s.teamPoints[driver.team] = (s.teamPoints[driver.team] || 0) + pts;
      }
      if (i === 0) {
        s.wins[id] = (s.wins[id] || 0) + 1;
        s.teamWins[driver.team] = (s.teamWins[driver.team] || 0) + 1;
      }
      if (i < 3) {
        s.podiums[id] = (s.podiums[id] || 0) + 1;
        s.teamPodiums[driver.team] = (s.teamPodiums[driver.team] || 0) + 1;
      }
    }

    const playerIdx = rows.findIndex((r) => r.id === s.playerDriverId);
    s.results.push({
      round: race ? race.round : s.roundIndex + 1,
      trackId: race ? race.trackId : null,
      gp: race ? race.gp : null,
      top3: rows.slice(0, 3).map((r) => r.id),
      playerPos: playerIdx >= 0 ? playerIdx + 1 : null,
      fastestLap: fastestLapDriverId || null, // display only, no point
    });

    s.roundIndex += 1;
    this._save();
  }

  driverStandings() {
    const s = this._state;
    const rows = DRIVERS.map((driver) => ({
      driver: driver,
      points: (s && s.driverPoints[driver.id]) || 0,
      wins: (s && s.wins && s.wins[driver.id]) || 0,
      podiums: (s && s.podiums && s.podiums[driver.id]) || 0,
      pos: 0,
    }));
    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.podiums !== a.podiums) return b.podiums - a.podiums;
      const an = a.driver.lastName + ' ' + a.driver.firstName;
      const bn = b.driver.lastName + ' ' + b.driver.firstName;
      return an.localeCompare(bn);
    });
    for (let i = 0; i < rows.length; i++) rows[i].pos = i + 1;
    return rows;
  }

  teamStandings() {
    const s = this._state;
    const rows = TEAMS.map((team) => ({
      team: team,
      points: (s && s.teamPoints[team.id]) || 0,
      wins: (s && s.teamWins && s.teamWins[team.id]) || 0,
      podiums: (s && s.teamPodiums && s.teamPodiums[team.id]) || 0,
      pos: 0,
    }));
    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.podiums !== a.podiums) return b.podiums - a.podiums;
      return a.team.name.localeCompare(b.team.name);
    });
    for (let i = 0; i < rows.length; i++) rows[i].pos = i + 1;
    return rows;
  }

  resultsLog() {
    return this._state ? this._state.results.slice() : [];
  }

  abandon() {
    this._state = null;
    const store = storage();
    if (store) {
      try {
        store.removeItem(STORAGE_KEY);
      } catch (e) {
        // ignore storage failures
      }
    }
  }

  _save() {
    const store = storage();
    if (!store || !this._state) return;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(this._state));
    } catch (e) {
      // Quota / private-mode failures are non-fatal; state stays in memory.
    }
  }
}
