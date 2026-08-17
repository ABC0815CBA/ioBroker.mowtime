'use strict';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** Heuristic daily grass growth derived from temperature, rain and sunshine. */
function dailyGrowth(day, baseGrowthMmPerWeek) {
    const base = Math.max(0, Number(baseGrowthMmPerWeek) || 0) / 7;
    const temperature = Number(day.temperatureMean);
    const rain = Math.max(0, Number(day.precipitation) || 0);
    const sunshineHours = Math.max(0, Number(day.sunshineHours) || 0);
    const tempFactor = Number.isFinite(temperature) ? clamp((temperature - 5) / 15, 0, 1.35) : 1;
    const waterFactor = clamp(0.55 + rain / 5, 0.35, 1.35);
    const sunFactor = clamp(0.65 + sunshineHours / 12, 0.65, 1.25);
    return base * tempFactor * waterFactor * sunFactor;
}

function sevenDayGrowth(days, baseGrowthMmPerWeek) {
    if (!Array.isArray(days) || !days.length) return Math.max(0, Number(baseGrowthMmPerWeek) || 0);
    return days.slice(-7).reduce((sum, day) => sum + dailyGrowth(day, baseGrowthMmPerWeek), 0);
}

function remainingZoneGrowth(growthMm, mowedMinutes, targetMinutes) {
    if (targetMinutes <= 0) return Math.max(0, growthMm);
    return Math.max(0, growthMm * (1 - Math.max(0, mowedMinutes) / targetMinutes));
}

function hysteresis(previousActive, remainingGrowthMm, startMm, stopMm) {
    const start = Math.max(0, Number(startMm) || 0);
    const stop = Math.min(start, Math.max(0, Number(stopMm) || 0));
    return previousActive ? remainingGrowthMm > stop : remainingGrowthMm >= start;
}

module.exports = { dailyGrowth, sevenDayGrowth, remainingZoneGrowth, hysteresis };
