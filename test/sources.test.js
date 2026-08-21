'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rainLockEnabled, growthWeatherAdjustmentEnabled, sourceFor, neutralWeather, weatherControlValue } = require('../lib/sources');

test('individual sources override the legacy common source', () => {
    const config = { weatherSource: 'openmeteo', rainSource: 'states' };
    assert.equal(sourceFor(config, 'rain'), 'states');
    assert.equal(sourceFor(config, 'temperature'), 'openmeteo');
});

test('legacy configurations retain their common source', () => {
    assert.equal(sourceFor({ weatherSource: 'openmeteo' }, 'light'), 'openmeteo');
    assert.equal(sourceFor({}, 'light'), 'states');
});

test('rain lock and growth weather can be switched independently', () => {
    const config = { enableRainLock: true, enableGrowthWeatherAdjustment: false, tempOptLow: 15, tempOptHigh: 25, moistureOptLow: 35, moistureOptHigh: 65, lightOptimal: 15000 };
    assert.equal(rainLockEnabled(config), true);
    assert.equal(growthWeatherAdjustmentEnabled(config), false);
    assert.deepEqual(neutralWeather(config), { temperature: 20, moisture: 50, light: 15000 });
});

test('output follows rain and weather adjustment priority table', () => {
    assert.equal(weatherControlValue(true, false, 42), -100);
    assert.equal(weatherControlValue(true, true, 42), -100);
    assert.equal(weatherControlValue(false, false, 42), 0);
    assert.equal(weatherControlValue(false, true, 42), 42);
});
