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

function growthFactors(weather, soilQuality, cfg, moistureOverride = NaN) {
    const temperature = trapezoid(weather.temperature, cfg.tempMin, cfg.tempOptLow, cfg.tempOptHigh, cfg.tempMax);
    const moisture = Number.isFinite(moistureOverride) ? clamp(moistureOverride, 0, 1) : trapezoid(weather.moisture, cfg.moistureDry, cfg.moistureOptLow, cfg.moistureOptHigh, cfg.moistureFlood);
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

function totalTimeDeltaMinutes(currentHours, previousHours, maxMinutes = 60) {
    const current = Number(currentHours);
    const previous = Number(previousHours);
    if (!Number.isFinite(current) || !Number.isFinite(previous) || current <= previous) return 0;
    return Math.min((current - previous) * 60, Math.max(0, Number(maxMinutes) || 0));
}

function worxZoneToDisplayZone(rawZone) {
    const zone = Number(rawZone);
    return Number.isInteger(zone) && zone >= 0 && zone <= 3 ? zone + 1 : 0;
}

module.exports = { clamp, trapezoid, lightFactor, growthFactors, extensionForTarget, totalTimeDeltaMinutes, worxZoneToDisplayZone };
