'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RADIATION_TO_LUX, buildOpenMeteoUrl, parseOpenMeteo } = require('../lib/openmeteo');

test('builds a 30-day Open-Meteo request with all required fields', () => {
    const url = new URL(buildOpenMeteoUrl(52.52, 13.41));
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.get('past_days'), '30');
    assert.match(url.searchParams.get('hourly'), /soil_moisture_0_to_1cm/);
    assert.equal(url.searchParams.get('current'), 'precipitation');
});

test('converts Open-Meteo soil moisture and radiation to model units', () => {
    const result = parseOpenMeteo({
        current: { precipitation: 0.2 },
        hourly: {
            temperature_2m: [10, 20],
            soil_moisture_0_to_1cm: [0.3, 0.5],
            shortwave_radiation: [100, 300]
        }
    });
    assert.equal(result.temperature, 15);
    assert.equal(result.moisture, 40);
    assert.equal(result.light, 200 * RADIATION_TO_LUX);
    assert.equal(result.precipitation, 0.2);
});

test('rejects incomplete API responses', () => {
    assert.throws(() => parseOpenMeteo({ current: {}, hourly: {} }), /required weather fields/);
});
