'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const weather = require('../lib/weather');

test('converts Open-Meteo hourly rain to a 10-minute amount', () => {
    assert.deepEqual(weather.parseOpenMeteo({ current: { precipitation: 0.9, rain: 0.9, wind_speed_10m: 12, temperature_2m: 18 } }, 0.1), { raining: true, precipitation: 0.15, rain10Minutes: 0.15, rainToday: 0, wind: 12, temperature: 18, sunshineHours: 0, daily: [] });
});

test('requires more than the configured 10-minute rain threshold', () => {
    const result = weather.parseOpenMeteo({ current: { precipitation: 0.6, rain: 0.6, wind_speed_10m: 4, temperature_2m: 18 } }, 0.1);
    assert.equal(result.raining, false);
});

test('parses Bright Sky current weather', () => {
    assert.deepEqual(weather.parseBrightSky({ weather: { precipitation: 0, condition: 'dry', wind_speed: 8, temperature: 16 } }, 0.1), { raining: false, precipitation: 0, rain10Minutes: 0, rainToday: 0, wind: 8, temperature: 16, sunshineHours: 0, daily: [] });
});

test('builds a keyless Open-Meteo request', async () => {
    let requested;
    const result = await weather.fetchWeather('openmeteo', 52.5, 13.4, 0.1, async url => {
        requested = url;
        return { current: { precipitation: 0, rain: 0, wind_speed_10m: 4, temperature_2m: 20 } };
    });
    assert.match(requested, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    assert.equal(requested.includes('apikey'), false);
    assert.equal(result.raining, false);
});
