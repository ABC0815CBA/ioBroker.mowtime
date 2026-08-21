'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSoilType, soilWaterBalance } = require('../lib/soil');

test('migrates legacy numeric soil values without producing zero growth', () => {
    assert.equal(normalizeSoilType(0), 'sand');
    assert.equal(normalizeSoilType(1), 'loam');
    assert.equal(normalizeSoilType(2), 'clay');
});

test('clay retains more water than sand through a dry period', () => {
    const rain = [20, ...Array(239).fill(0)];
    const et0 = Array(240).fill(0.15);
    const sand = soilWaterBalance(rain, et0, 'sand');
    const clay = soilWaterBalance(rain, et0, 'clay');
    assert.ok(clay.storageMm > sand.storageMm);
    assert.ok(clay.capacityMm > sand.capacityMm);
});

test('rain timing matters even when the 30-day sum is identical', () => {
    const et0 = Array(240).fill(0.1);
    const earlyRain = [20, ...Array(239).fill(0)];
    const recentRain = [...Array(239).fill(0), 20];
    assert.notEqual(soilWaterBalance(recentRain, et0, 'sand').factor, soilWaterBalance(earlyRain, et0, 'sand').factor);
});
