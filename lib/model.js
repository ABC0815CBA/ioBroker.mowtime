'use strict';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function trapezoid(value, zeroLow, optimalLow, optimalHigh, zeroHigh) {
    const x = Number(value);
    if (!Number.isFinite(x) || x <= zeroLow || x >= zeroHigh) return 0;
    if (x >= optimalLow && x <= optimalHigh) return 1;
    if (x < optimalLow) return (x - zeroLow) / (optimalLow - zeroLow);
    return (zeroHigh - x) / (zeroHigh - optimalHigh);
}

function lightFactor(lux, low, optimal) {
    const x = Number(lux);
    if (!Number.isFinite(x) || x <= low) return 0;
    return clamp((x - low) / (optimal - low), 0, 1);
}

function growthFactors(weather, soilQuality, cfg) {
    const temperature = trapezoid(weather.temperature, cfg.tempMin, cfg.tempOptLow, cfg.tempOptHigh, cfg.tempMax);
    const moisture = trapezoid(weather.moisture, cfg.moistureDry, cfg.moistureOptLow, cfg.moistureOptHigh, cfg.moistureFlood);
    const light = lightFactor(weather.light, cfg.lightLow, cfg.lightOptimal);
    const soil = clamp(soilQuality, 0, 2);
    const multiplier = clamp(temperature * moisture * light * soil, 0, 2);
    return { temperature, moisture, light, soil, multiplier, percent: Math.round((multiplier - 1) * 100) };
}

function extensionForTarget(targetMinutes, actualMinutes, remainingScheduledMinutes) {
    const deficit = Math.max(0, targetMinutes - actualMinutes);
    if (deficit === 0) return -100;
    if (remainingScheduledMinutes <= 0) return 100;
    return Math.round(clamp((deficit / remainingScheduledMinutes - 1) * 100, -100, 100));
}

module.exports = { clamp, trapezoid, lightFactor, growthFactors, extensionForTarget };
