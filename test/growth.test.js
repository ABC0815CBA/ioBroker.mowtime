'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const growth = require('../lib/growth');

test('warm wet sunny days grow more than cold dry days', () => {
    const warm = growth.dailyGrowth({ temperatureMean: 20, precipitation: 3, sunshineHours: 8 }, 3);
    const cold = growth.dailyGrowth({ temperatureMean: 4, precipitation: 0, sunshineHours: 1 }, 3);
    assert.ok(warm > cold);
});

test('growth hysteresis has separate on and off thresholds', () => {
    assert.equal(growth.hysteresis(false, 1.9, 2, 0.5), false);
    assert.equal(growth.hysteresis(false, 2, 2, 0.5), true);
    assert.equal(growth.hysteresis(true, 1, 2, 0.5), true);
    assert.equal(growth.hysteresis(true, 0.4, 2, 0.5), false);
});
