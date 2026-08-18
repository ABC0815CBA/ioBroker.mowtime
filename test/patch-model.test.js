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

test('small five-minute growth increments are not rounded away', () => {
    const fiveMinutes = 5 / 1440;
    let growth = 0;
    for (let run = 0; run < 288; run++) growth = model.accumulateGrowth(growth, [0.28], fiveMinutes);
    assert.ok(growth > 0.27 && growth < 0.29);
});

test('hourly simulation lets wind-based ET dry the persistent soil store', () => {
    const patch = { soil: 'mixed', rootDepthCm: 15, shade: 0, fertilityFactor: 1 };
    const result = model.simulateHour(patch, { rainMm: 0, et0Mm: 0.4, temperature: 20, sunshineFraction: 1 }, 3, 10, 1);
    assert.equal(result.soilWaterMm, 9.6);
    assert.ok(result.growthMm > 0);
});
