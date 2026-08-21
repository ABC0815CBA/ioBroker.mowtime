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

function weatherControlValue(rainLocked, growthAdjustmentEnabled, forecastValue) {
    if (rainLocked) return -100;
    if (!growthAdjustmentEnabled) return 0;
    return Number(forecastValue);
}

module.exports = { rainLockEnabled, growthWeatherAdjustmentEnabled, sourceFor, neutralWeather, weatherControlValue };
