'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/patch-model');

const summer = Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-${10 + i}`, temperatureMean: 25, precipitation: 1, sunshineHours: 10, et0: 4 }));

test('shade preserves more soil water in a dry hot week', () => {
    const sunny = model.simulatePatch({ area: 100, soil: 'mixed', shade: 0, mowingSpeed: 100 }, summer, 4);
    const shaded = model.simulatePatch({ area: 100, soil: 'mixed', shade: 2, mowingSpeed: 100 }, summer, 4);
    assert.ok(shaded.soilWaterMm > sunny.soilWaterMm);
});

test('subareas aggregate into technical Worx zones', () => {
    assert.deepEqual(model.aggregateZones([
        { mowerZone: 0, active: true, passMinutes: 10 },
        { mowerZone: 0, active: false, passMinutes: 20 },
        { mowerZone: 2, active: true, passMinutes: 30 }
    ]), [30, 0, 30, 0]);
});

test('zone sequence follows aggregated demand', () => {
    const sequence = model.sequenceFromWeights([40, 60, 0, 0], 10);
    assert.equal(sequence.filter(zone => zone === 0).length, 4);
    assert.equal(sequence.filter(zone => zone === 1).length, 6);
});

test('growth accumulates over elapsed days and keeps the previous cycle value', () => {
    assert.equal(model.accumulateGrowth(1.2, [0.4, 0.6], 2), 2.2);
    assert.equal(model.accumulateGrowth(2, [1], 20), 9);
});
