'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { weatherAdjustmentsEnabled, sourceFor, neutralWeather } = require('../lib/sources');

test('individual sources override the legacy common source', () => {
    const config = { weatherSource: 'openmeteo', rainSource: 'states' };
    assert.equal(sourceFor(config, 'rain'), 'states');
    assert.equal(sourceFor(config, 'temperature'), 'openmeteo');
});

test('legacy configurations retain their common source', () => {
    assert.equal(sourceFor({ weatherSource: 'openmeteo' }, 'light'), 'openmeteo');
    assert.equal(sourceFor({}, 'light'), 'states');
});

test('disabled weather uses neutral climate values', () => {
    const config = { enableWeatherAdjustments: false, tempOptLow: 15, tempOptHigh: 25, moistureOptLow: 35, moistureOptHigh: 65, lightOptimal: 15000 };
    assert.equal(weatherAdjustmentsEnabled(config), false);
    assert.deepEqual(neutralWeather(config), { temperature: 20, moisture: 50, light: 15000 });
});
