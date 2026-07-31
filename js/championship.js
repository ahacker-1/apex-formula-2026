// championship.js — Season / career state with localStorage persistence.
// NOTE: no fastest-lap point — abolished for 2025 onward; the fastest-lap
// driver is stored per round for display only.

import { DRIVERS, TEAMS, CALENDAR, POINTS, STORAGE_SUFFIX } from './data.js';

// The suffix preserves compatibility with saves created by earlier APEX builds.
const STORAGE_KEY = 'apexf1_2026_career' + (STORAGE_SUFFIX || '');

export function pointsFor(pos) {
  return POINTS[pos] || 0;
}

/** Validate and normalize a complete official classification atomically. */
export function normalizeClassification(classification) {
  if (!Array.isArray(classification) || classification.length !== DRIVERS.length) return null;
  const rows = [];
  const seen = new Set();
  let reachedRetirements = false;
  for (const value of classification) {
    const row = typeof value === 'string' ? { id: value, dnf: false } : value;
    if (!isRecord(row) || typeof row.id !== 'string' || !DRIVER_IDS.has(row.id) || seen.has(row.id)) return null;
    const dnf = !!row.dnf;
    // Retirements are ordered after every running/finished car. This prevents
    // malformed callers from awarding a classified position through array order.
    if (dnf) reachedRetirements = true;
    else if (reachedRetirements) return null;
    seen.add(row.id);
    rows.push({ id: row.id, dnf });
  }
  return seen.size === DRIVERS.length ? rows : null;
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

const DRIVER_BY_ID = new Map(DRIVERS.map((d) => [d.id, d]));
const DRIVER_IDS = new Set(DRIVER_BY_ID.keys());
const TEAM_IDS = new Set(TEAMS.map((team) => team.id));

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

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeCounterMap(value, validIds) {
  if (!isRecord(value)) return null;
  const normalized = {};
  for (const [id, count] of Object.entries(value)) {
    if (!validIds.has(id) || !Number.isInteger(count) || count < 0) return null;
    normalized[id] = count;
  }
  return normalized;
}

function normalizeResult(value, index, playerDriverId) {
  if (!isRecord(value)) return null;
  const race = CALENDAR[index];
  if (!race || value.round !== race.round || value.trackId !== race.trackId || value.gp !== race.gp) {
    return null;
  }

  if (!Array.isArray(value.top3) || value.top3.length < 1 || value.top3.length > 3) return null;
  if (value.top3.some((id) => typeof id !== 'string' || !DRIVER_IDS.has(id))) return null;
  if (new Set(value.top3).size !== value.top3.length) return null;

  const playerPos = value.playerPos;
  if (playerPos !== null &&
      (!Number.isInteger(playerPos) || playerPos < 1 || playerPos > DRIVERS.length)) return null;

  const podiumIndex = value.top3.indexOf(playerDriverId);
  if (playerPos === null) {
    if (podiumIndex !== -1) return null;
  } else if (playerPos <= 3) {
    if (value.top3[playerPos - 1] !== playerDriverId) return null;
  } else if (podiumIndex !== -1) return null;

  const fastestLap = value.fastestLap;
  if (fastestLap !== null && (typeof fastestLap !== 'string' || !DRIVER_IDS.has(fastestLap))) {
    return null;
  }

  return {
    round: value.round,
    trackId: value.trackId,
    gp: value.gp,
    top3: value.top3.slice(),
    playerPos,
    fastestLap,
  };
}

function normalizeState(value) {
  if (!isRecord(value) || typeof value.playerDriverId !== 'string' ||
      !DRIVER_IDS.has(value.playerDriverId)) return null;
  if (!Number.isInteger(value.roundIndex) || value.roundIndex < 0 ||
      value.roundIndex > CALENDAR.length) return null;
  if (!Array.isArray(value.results) || value.results.length !== value.roundIndex) return null;

  const driverPoints = normalizeCounterMap(value.driverPoints, DRIVER_IDS);
  const teamPoints = normalizeCounterMap(value.teamPoints, TEAM_IDS);
  const wins = normalizeCounterMap(value.wins, DRIVER_IDS);
  const podiums = normalizeCounterMap(value.podiums, DRIVER_IDS);
  const teamWins = normalizeCounterMap(value.teamWins, TEAM_IDS);
  const teamPodiums = normalizeCounterMap(value.teamPodiums, TEAM_IDS);
  if (!driverPoints || !teamPoints || !wins || !podiums || !teamWins || !teamPodiums) return null;

  const results = value.results.map((result, index) =>
    normalizeResult(result, index, value.playerDriverId));
  if (results.some((result) => result === null)) return null;

  return {
    playerDriverId: value.playerDriverId,
    roundIndex: value.roundIndex,
    driverPoints,
    teamPoints,
    wins,
    podiums,
    teamWins,
    teamPodiums,
    results,
  };
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
          this._state = normalizeState(parsed);
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
    if (!DRIVER_IDS.has(playerDriverId)) return false;
    this._state = freshState(playerDriverId);
    this._save();
    return true;
  }

  // classification: array (finishing order) of driverId strings OR
  // { id, dnf } objects. DNF entries score nothing (matching the results
  // screen); scoring position stays the classified index — no promotion.
  recordResult(classification, fastestLapDriverId) {
    if (!this._state || this.finished) return false;
    const rows = normalizeClassification(classification);
    if (!rows) return false;
    if (fastestLapDriverId != null && (!DRIVER_IDS.has(fastestLapDriverId) ||
        rows.find(row => row.id === fastestLapDriverId)?.dnf)) return false;
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
    return true;
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
