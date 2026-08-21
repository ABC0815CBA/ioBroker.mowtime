'use strict';

function rainLockEnabled(config) {
    return config.enableRainLock !== false;
}

function growthWeatherAdjustmentEnabled(config) {
    return config.enableGrowthWeatherAdjustment !== false;
}

function sourceFor(config, kind) {
    return config[`${kind}Source`] || config.weatherSource || 'states';
}

function neutralWeather(config) {
    return {
        temperature: (Number(config.tempOptLow) + Number(config.tempOptHigh)) / 2,
        moisture: (Number(config.moistureOptLow) + Number(config.moistureOptHigh)) / 2,
        light: Number(config.lightOptimal)
    };
}

module.exports = { rainLockEnabled, growthWeatherAdjustmentEnabled, sourceFor, neutralWeather };
