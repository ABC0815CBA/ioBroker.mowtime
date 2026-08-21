'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trapezoid, growthFactors, extensionForTarget, totalTimeDeltaMinutes } = require('../lib/model');

const cfg = { tempMin: 5, tempOptLow: 15, tempOptHigh: 25, tempMax: 35, moistureDry: 10, moistureOptLow: 35, moistureOptHigh: 65, moistureFlood: 95, lightLow: 1000, lightOptimal: 15000 };

test('temperature has no growth outside limits and full growth at optimum', () => {
    assert.equal(trapezoid(5, 5, 15, 25, 35), 0);
    assert.equal(trapezoid(20, 5, 15, 25, 35), 1);
    assert.equal(trapezoid(35, 5, 15, 25, 35), 0);
});

test('growth factors are individually traceable and multiplicative', () => {
    const result = growthFactors({ temperature: 20, moisture: 50, light: 15000 }, 1.2, cfg);
    assert.deepEqual(result, { temperature: 1, moisture: 1, light: 1, soil: 1.2, multiplier: 1.2, percent: 20 });
});

test('extension reaches target using remaining calendar capacity', () => {
    assert.equal(extensionForTarget(120, 60, 60), 0);
    assert.equal(extensionForTarget(120, 90, 60), -50);
    assert.equal(extensionForTarget(120, 120, 60), -100);
    assert.equal(extensionForTarget(120, 0, 0), 100);
});

test('converts Worx totalTime hours to zone minutes', () => {
    assert.equal(totalTimeDeltaMinutes(123.5, 123.25), 15);
    assert.equal(totalTimeDeltaMinutes(124, 123), 60);
    assert.equal(totalTimeDeltaMinutes(5, 100), 0);
    assert.equal(totalTimeDeltaMinutes(102, 100), 60);
});
