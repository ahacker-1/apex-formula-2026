import assert from 'node:assert/strict';
import fs from 'node:fs';
import { advanceSteeringInput, STEERING_PROFILES } from '../js/controls.js';
import { cockpitFov, cockpitSeat } from '../js/cockpit.js';
import { deterministicJSON } from '../js/telemetry.js';

for (const name of ['calm', 'balanced', 'direct']) assert.ok(STEERING_PROFILES[name]);
const calm = advanceSteeringInput(0, 1, 60, 1 / 60, true, 'calm');
const balanced = advanceSteeringInput(0, 1, 60, 1 / 60, true, 'balanced');
const direct = advanceSteeringInput(0, 1, 60, 1 / 60, true, 'direct');
assert.ok(calm > 0 && calm < balanced && balanced < direct, 'steering profiles must be progressive and ordered');
assert.ok(advanceSteeringInput(.5, 0, 20, 1 / 60, true, 'direct') < .5, 'steering must return toward centre');
assert.equal(cockpitFov('natural'), 70);
assert.ok(cockpitSeat('low') < cockpitSeat('standard') && cockpitSeat('standard') < cockpitSeat('high'));
assert.equal(deterministicJSON({ z: 1, a: { y: 2, x: 3 } }), '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');

const ui = fs.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
assert.match(ui, /PILOT_DRIVER_ID = 'hacker'/);
assert.match(ui, /PILOT_TRACK_ID = 'spa'/);
assert.match(ui, /The AI Consulting Network Racing Team/);
assert.match(main, /d\.team === 'tacn'/);
assert.match(main, /\(this\.camMode \+ 1\) % 4/);

console.log('cockpit/controls validator: PASS');
