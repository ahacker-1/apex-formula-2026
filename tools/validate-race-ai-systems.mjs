#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRandom } from '../js/random.js';
import {
  StrategyPlanner, chooseWeatherTyre, ersTargetMode, fuelTargetMode,
} from '../js/strategy.js';
import {
  applyImpactDamage, applyRepairPlan, createVehicleHealth,
  damageSeverity, performanceModifiers, repairPlan, stepReliability,
} from '../js/damage.js';
import { RaceControl } from '../js/raceControl.js';
import { normalizeClassification } from '../js/championship.js';
import { DRIVERS } from '../js/data.js';

let checks = 0;
const check = (condition, message) => { checks++; assert.ok(condition, message); };

const seed = 'race-ai-depth-v1';
const forecast = (lap) => lap < 4
  ? { wetness: 0, rainInLaps: 4 - lap }
  : { wetness: 0.54, trackGrip: 0.72 };
const plannerA = new StrategyPlanner({ random: createRandom(seed), totalLaps: 18, aggression: 0.72, forecast });
const plannerB = new StrategyPlanner({ random: createRandom(seed), totalLaps: 18, aggression: 0.72, forecast });
check(plannerA.chooseStartCompound(4) === plannerB.chooseStartCompound(4), 'seeded start strategy must reproduce');
check(chooseWeatherTyre({ wetness: 0.5 }) === 'I', 'intermediate threshold');
check(chooseWeatherTyre({ wetness: 0.8 }) === 'W', 'wet threshold');
const wetDecision = plannerA.decide({ lap: 5, compound: 'S', wear: 0.25, tyreAgeLaps: 2, fuel: 0.7, battery: 0.8 });
check(wetDecision.shouldPit && wetDecision.nextCompound === 'I' && wetDecision.reason === 'weather', 'strategy must react to wet forecast');
check(fuelTargetMode(0.3, 0.5) === 'save', 'fuel deficit must trigger saving');
check(ersTargetMode(0.9, { attack: true }) === 2 && ersTargetMode(0.1) === 0, 'ERS state logic');

const damageA = createVehicleHealth();
const damageB = createVehicleHealth();
applyImpactDamage(damageA, { severity: 0.72, front: true, side: 0.2 }, createRandom(seed));
applyImpactDamage(damageB, { severity: 0.72, front: true, side: 0.2 }, createRandom(seed));
assert.deepEqual(damageA, damageB, 'seeded impact damage must reproduce'); checks++;
check(damageSeverity(damageA) > 0 && performanceModifiers(damageA).aeroLoss > 0, 'damage must cost performance');
const repair = repairPlan(damageA, 10);
check(repair.repairs.some(item => item.part === 'frontWing'), 'pit repair plan must detect wing');
applyRepairPlan(damageA, repair);
check(damageA.frontWing === 1, 'repair plan must restore wing');

const failureA = createVehicleHealth();
const failureB = createVehicleHealth();
const rndA = createRandom('reliability');
const rndB = createRandom('reliability');
for (let i = 0; i < 20000; i++) {
  stepReliability(failureA, 1 / 30, { stress: 1.1, raceProgress: i / 20000 }, rndA);
  stepReliability(failureB, 1 / 30, { stress: 1.1, raceProgress: i / 20000 }, rndB);
}
assert.deepEqual(failureA, failureB, 'seeded reliability sequence must reproduce'); checks++;

const events = [];
const control = new RaceControl({ onEvent: event => events.push(event) });
control.deploy('local-yellow', { duration: 1, zone: { start: 95, end: 5 } });
check(control.controlForSample(99, 100).noOvertake, 'wrapped local-yellow zone');
check(!control.controlForSample(50, 100).noOvertake, 'local yellow must remain local');
control.update(1);
check(control.state === 'green', 'local yellow must clear to green');
control.deploy('safety-car', { duration: 2 });
control.update(2);
check(control.state === 'restart' && control.noOvertake, 'safety car must enter restart state');
control.update(5);
check(control.state === 'green', 'restart must return to green');
control.deploy('red-flag');
check(control.paceFactor === 0, 'red flag must stop the field');
control.resume({ restartType: 'standing', duration: 1 });
control.update(1);
check(control.state === 'green' && events.some(event => event.restartType === 'standing'), 'standing red-flag restart');

const official = DRIVERS.map(driver => driver.id);
check(normalizeClassification(official)?.length === DRIVERS.length, 'complete official classification');
check(normalizeClassification(official.slice(1)) === null, 'partial classification must be rejected');
check(normalizeClassification([...official.slice(0, -1), official[0]]) === null, 'duplicate classification must be rejected');
check(normalizeClassification([{ id: official[0], dnf: true }, ...official.slice(1)]) === null, 'retirement cannot precede finishers');

console.log(`[race-ai-systems] ${checks} deterministic assertions passed`);
