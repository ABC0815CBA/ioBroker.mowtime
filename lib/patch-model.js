'use strict';

const SOILS = {
    sandy: { availableWaterMmPerM: 60, fertility: 0.75 },
    sandyMixed: { availableWaterMmPerM: 90, fertility: 0.85 },
    mixed: { availableWaterMmPerM: 130, fertility: 1 },
    humus: { availableWaterMmPerM: 160, fertility: 1.1 },
    humusLoam: { availableWaterMmPerM: 180, fertility: 1.15 },
    loamy: { availableWaterMmPerM: 170, fertility: 1.05 }
};

const SHADE_TRANSMISSION = [1, 0.65, 0.35];
const SHADE_ET = [1, 0.78, 0.58];
const LEGACY_SOILS = Object.keys(SOILS);

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function temperatureFactor(temperature) {
    const t = Number(temperature);
    if (!Number.isFinite(t) || t <= 5 || t >= 35) return 0;
    if (t < 18) return (t - 5) / 13;
    if (t <= 23) return 1;
    return (35 - t) / 12;
}

function simulatePatch(patch, days, baseGrowthMmPerWeek) {
    const soil = SOILS[patch.soil] || SOILS.mixed;
    const rootDepthM = clamp(Number(patch.rootDepthCm) || 15, 5, 40) / 100;
    const capacity = soil.availableWaterMmPerM * rootDepthM;
    let water = capacity * 0.7;
    let growthMm = 0;
    const shade = clamp(Number(patch.shade) || 0, 0, 2);
    const rainFactor = clamp(Number(patch.rainFactor) || 1, 0, 2);
    const fertility = clamp(Number(patch.fertilityFactor) || soil.fertility, 0.3, 1.5);
    const results = [];
    for (const day of (Array.isArray(days) && days.length ? days.slice(-7) : [{ date: 'estimated', temperatureMean: 18, precipitation: 2, sunshineHours: 6, et0: 3 }])) {
        const rain = Math.max(0, Number(day.precipitation) || 0) * rainFactor;
        const et0 = Math.max(0, Number(day.et0) || 0);
        water = clamp(water + rain - et0 * SHADE_ET[shade], 0, capacity);
        const measured = Number(patch.moisturePercent);
        const waterFraction = Number.isFinite(measured) ? clamp(measured / 100, 0, 1) : water / capacity;
        const waterFactor = waterFraction >= 0.5 ? 1 : waterFraction / 0.5;
        const lightFactor = clamp(0.3 + ((Number(day.sunshineHours) || 0) * SHADE_TRANSMISSION[shade]) / 7, 0.25, 1);
        const increment = Math.max(0, Number(baseGrowthMmPerWeek) || 0) / 7 * temperatureFactor(day.temperatureMean) * waterFactor * lightFactor * fertility;
        growthMm += increment;
        results.push({ date: day.date, waterMm: round(water), waterFactor: round(waterFactor), temperatureFactor: round(temperatureFactor(day.temperatureMean)), lightFactor: round(lightFactor), growthMm: round(increment) });
    }
    const area = Math.max(0, Number(patch.area) || 0);
    const speed = Math.max(0.01, Number(patch.mowingSpeed) || 1);
    const passMinutes = area / speed * 60;
    const demandMinutes = passMinutes;
    return { capacityMm: round(capacity), soilWaterMm: round(water), growthMm: round(growthMm), passMinutes: round(passMinutes), demandMinutes: round(demandMinutes), days: results };
}

function simulateHour(patch, weather, baseGrowthMmPerWeek, currentWaterMm, elapsedHours = 1) {
    const soil = SOILS[patch.soil] || SOILS.mixed;
    const rootDepthM = clamp(Number(patch.rootDepthCm) || 15, 5, 40) / 100;
    const capacity = soil.availableWaterMmPerM * rootDepthM;
    const hours = Math.min(24, Math.max(0, Number(elapsedHours) || 0));
    const shade = clamp(Number(patch.shade) || 0, 0, 2);
    const rainFactor = clamp(Number(patch.rainFactor) || 1, 0, 2);
    const fertility = clamp(Number(patch.fertilityFactor) || soil.fertility, 0.3, 1.5);
    const rain = Math.max(0, Number(weather.rainMm) || 0) * rainFactor;
    const et0 = Math.max(0, Number(weather.et0Mm) || 0);
    const water = clamp(Number.isFinite(Number(currentWaterMm)) ? Number(currentWaterMm) + rain - et0 * SHADE_ET[shade] : capacity * 0.7, 0, capacity);
    const measured = Number(patch.moisturePercent);
    const waterFraction = Number.isFinite(measured) ? clamp(measured / 100, 0, 1) : water / capacity;
    const waterFactor = waterFraction >= 0.5 ? 1 : waterFraction / 0.5;
    const sunshineFraction = clamp(Number(weather.sunshineFraction) || 0, 0, 1);
    const lightFactor = clamp(0.3 + sunshineFraction * SHADE_TRANSMISSION[shade] * 0.7, 0.25, 1);
    const growthMm = Math.max(0, Number(baseGrowthMmPerWeek) || 0) / 168 * hours * temperatureFactor(weather.temperature) * waterFactor * lightFactor * fertility;
    return { capacityMm: round(capacity), soilWaterMm: roundTo(water, 6), waterFactor: roundTo(waterFactor, 6), lightFactor: roundTo(lightFactor, 6), growthMm: roundTo(growthMm, 6) };
}

function aggregateZones(patches, enabledZones = [true, true, true, true]) {
    const zoneReady = [false, false, false, false];
    const zonePassMinutes = [0, 0, 0, 0];
    for (const patch of patches) {
        const zone = clamp(Number(patch.mowerZone) || 0, 0, 3);
        if (enabledZones[zone] === false || patch.enabled === false) continue;
        zoneReady[zone] ||= Boolean(patch.active);
        zonePassMinutes[zone] += Math.max(0, Number(patch.passMinutes) || 0);
    }
    return zonePassMinutes.map((minutes, zone) => zoneReady[zone] ? round(minutes) : 0);
}

function accumulateGrowth(previousMm, dailyGrowthSamples, elapsedDays) {
    const samples = (Array.isArray(dailyGrowthSamples) ? dailyGrowthSamples : []).map(value => Math.max(0, Number(value) || 0));
    const averageDaily = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
    // Keep enough precision for short adapter intervals. Rounding to 0.01 mm here
    // would discard every five-minute increment before it can accumulate.
    return roundTo(Math.max(0, Number(previousMm) || 0) + averageDaily * Math.min(7, Math.max(0, Number(elapsedDays) || 0)), 6);
}

function sequenceFromWeights(weights, length = 10) {
    const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) return [];
    const sequence = [], used = weights.map(() => 0);
    for (let n = 0; n < length; n++) {
        let best = 0;
        for (let i = 1; i < weights.length; i++) if (weights[i] / total * (n + 1) - used[i] > weights[best] / total * (n + 1) - used[best]) best = i;
        sequence.push(best); used[best]++;
    }
    return sequence;
}

function legacySoil(index) { return LEGACY_SOILS[clamp(Number(index) || 0, 0, 5)]; }
function round(value) { return Math.round(value * 100) / 100; }
function roundTo(value, digits) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }

module.exports = { SOILS, temperatureFactor, simulatePatch, simulateHour, aggregateZones, accumulateGrowth, sequenceFromWeights, legacySoil };
