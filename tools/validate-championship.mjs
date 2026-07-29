#!/usr/bin/env node

import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.items = new Map(); }
  clear() { this.items.clear(); }
  getItem(key) { return this.items.has(String(key)) ? this.items.get(String(key)) : null; }
  removeItem(key) { this.items.delete(String(key)); }
  setItem(key, value) { this.items.set(String(key), String(value)); }
}

const store = new MemoryStorage();
globalThis.localStorage = store;

const { DRIVERS, TEAMS, CALENDAR, STORAGE_SUFFIX } = await import('../js/data.js');
const { Championship } = await import('../js/championship.js');

const STORAGE_KEY = 'apexf1_2026_career' + (STORAGE_SUFFIX || '');
const PLAYER_ID = 'hacker';
const CLASSIFICATION = DRIVERS.map((driver) => driver.id);
const clone = (value) => JSON.parse(JSON.stringify(value));

let checks = 0;

function check(name, fn) {
  try {
    fn();
    checks += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function reset() {
  store.clear();
}

function savedState() {
  const raw = store.getItem(STORAGE_KEY);
  assert.ok(raw, 'expected a persisted championship');
  return JSON.parse(raw);
}

function makeState(rounds = 1) {
  reset();
  const championship = new Championship();
  championship.startNew(PLAYER_ID);
  for (let i = 0; i < rounds; i++) {
    championship.recordResult(CLASSIFICATION, CLASSIFICATION[1]);
  }
  return savedState();
}

function assertFreshChampionship(raw) {
  reset();
  store.setItem(STORAGE_KEY, raw);
  const before = store.getItem(STORAGE_KEY);
  const championship = new Championship();

  assert.equal(championship.active, false);
  assert.equal(championship.finished, false);
  assert.equal(championship.roundIndex, 0);
  assert.equal(championship.nextRace, null);
  assert.equal(championship.playerDriverId, null);
  assert.deepEqual(championship.resultsLog(), []);
  assert.equal(championship.driverStandings().length, DRIVERS.length);
  assert.equal(championship.teamStandings().length, TEAMS.length);
  assert.equal(store.getItem(STORAGE_KEY), before, 'loading must not rewrite corrupt data');
}

function rejectRaw(name, raw) {
  check(name, () => assertFreshChampionship(raw));
}

function rejectState(name, mutate, source = null) {
  const candidate = clone(source || validOneRound);
  mutate(candidate);
  rejectRaw(name, JSON.stringify(candidate));
}

const validZeroRound = makeState(0);
const validOneRound = makeState(1);

check('valid zero-round save reloads', () => {
  reset();
  store.setItem(STORAGE_KEY, JSON.stringify(validZeroRound));
  const championship = new Championship();
  assert.equal(championship.active, true);
  assert.equal(championship.roundIndex, 0);
  assert.equal(championship.nextRace?.trackId, CALENDAR[0].trackId);
  assert.equal(championship.playerDriverId, PLAYER_ID);
});

check('valid current save round-trips with standings and history intact', () => {
  reset();
  store.setItem(STORAGE_KEY, JSON.stringify(validOneRound));
  const championship = new Championship();
  assert.equal(championship.active, true);
  assert.equal(championship.roundIndex, 1);
  assert.equal(championship.nextRace?.trackId, CALENDAR[1].trackId);
  assert.deepEqual(championship.resultsLog(), validOneRound.results);
  assert.equal(
    championship.driverStandings().find((row) => row.driver.id === PLAYER_ID)?.points,
    25,
  );
});

check('reloaded save can record the next round and still be abandoned', () => {
  reset();
  store.setItem(STORAGE_KEY, JSON.stringify(validOneRound));
  const championship = new Championship();
  championship.recordResult(CLASSIFICATION, null);
  assert.equal(championship.roundIndex, 2);
  assert.equal(championship.resultsLog().length, 2);
  assert.equal(savedState().roundIndex, 2);
  championship.abandon();
  assert.equal(championship.active, false);
  assert.equal(store.getItem(STORAGE_KEY), null);
});

check('valid finished save reloads', () => {
  const finished = makeState(CALENDAR.length);
  const championship = new Championship();
  assert.equal(championship.active, false);
  assert.equal(championship.finished, true);
  assert.equal(championship.roundIndex, CALENDAR.length);
  assert.equal(championship.nextRace, null);
  assert.equal(championship.resultsLog().length, CALENDAR.length);
  assert.deepEqual(savedState(), finished);
});

rejectRaw('malformed JSON is rejected', '{"playerDriverId":');
rejectRaw('JSON null root is rejected', 'null');
rejectRaw('JSON array root is rejected', '[]');

rejectState('missing player driver is rejected', (state) => { delete state.playerDriverId; });
rejectState('non-string player driver is rejected', (state) => { state.playerDriverId = 26; });
rejectState('unknown player driver is rejected', (state) => { state.playerDriverId = '__unknown__'; });

for (const [name, value] of [
  ['missing', undefined],
  ['string', '1'],
  ['fractional', 0.5],
  ['negative', -1],
  ['overlarge', CALENDAR.length + 1],
]) {
  rejectState(`${name} roundIndex is rejected`, (state) => {
    if (value === undefined) delete state.roundIndex;
    else state.roundIndex = value;
  });
}

const mapCases = [
  ['driverPoints', DRIVERS[0].id],
  ['teamPoints', TEAMS[0].id],
  ['wins', DRIVERS[0].id],
  ['podiums', DRIVERS[0].id],
  ['teamWins', TEAMS[0].id],
  ['teamPodiums', TEAMS[0].id],
];

for (const [field, validKey] of mapCases) {
  rejectState(`${field} missing is rejected`, (state) => { delete state[field]; });
  rejectState(`${field} array is rejected`, (state) => { state[field] = []; });
  rejectState(`${field} null is rejected`, (state) => { state[field] = null; });
  rejectState(`${field} unknown key is rejected`, (state) => { state[field] = { __unknown__: 1 }; });
  rejectState(`${field} negative value is rejected`, (state) => { state[field] = { [validKey]: -1 }; });
  rejectState(`${field} fractional value is rejected`, (state) => { state[field] = { [validKey]: 1.5 }; });
  rejectState(`${field} string value is rejected`, (state) => { state[field] = { [validKey]: '1' }; });
}

rejectState('missing results history is rejected', (state) => { delete state.results; });
rejectState('non-array results history is rejected', (state) => { state.results = {}; });
rejectState('history length must match roundIndex', (state) => { state.results = []; });
rejectState('non-object result entry is rejected', (state) => { state.results[0] = null; });
rejectState('result round must match calendar', (state) => { state.results[0].round = 2; });
rejectState('result track must match calendar', (state) => { state.results[0].trackId = 'shanghai'; });
rejectState('result name must match calendar', (state) => { state.results[0].gp = 'Wrong GP'; });
rejectState('missing result top three is rejected', (state) => { delete state.results[0].top3; });
rejectState('empty result top three is rejected', (state) => { state.results[0].top3 = []; });
rejectState('oversized result top three is rejected', (state) => {
  state.results[0].top3 = CLASSIFICATION.slice(0, 4);
});
rejectState('unknown result driver is rejected', (state) => { state.results[0].top3[0] = '__unknown__'; });
rejectState('duplicate result driver is rejected', (state) => {
  state.results[0].top3[1] = state.results[0].top3[0];
});
rejectState('missing player position is rejected', (state) => { delete state.results[0].playerPos; });
rejectState('zero player position is rejected', (state) => { state.results[0].playerPos = 0; });
rejectState('fractional player position is rejected', (state) => { state.results[0].playerPos = 1.5; });
rejectState('overlarge player position is rejected', (state) => {
  state.results[0].playerPos = DRIVERS.length + 1;
});
rejectState('player position must agree with podium order', (state) => { state.results[0].playerPos = 2; });
rejectState('missing fastest lap is rejected', (state) => { delete state.results[0].fastestLap; });
rejectState('unknown fastest-lap driver is rejected', (state) => {
  state.results[0].fastestLap = '__unknown__';
});

console.log(`Championship validation passed (${checks} checks).`);
