'use strict';

const SOIL_FACTORS = [0.75, 0.85, 1, 1.1, 1.18, 1.25];
const SHADE_FACTORS = [1, 0.85, 0.7];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseCalendar(value) {
    let calendar = value;
    if (typeof value === 'string') calendar = JSON.parse(value);
    if (!Array.isArray(calendar)) return [];
    return calendar.filter(Array.isArray);
}

function calendarMinutes(...calendars) {
    return calendars.flatMap(parseCalendar).reduce((sum, entry) => {
        const minutes = Number(entry[1]);
        return sum + (Number.isFinite(minutes) && minutes > 0 ? minutes : 0);
    }, 0);
}

function zoneDemand(zone, growthMmPerWeek) {
    if (!zone || zone.active === false) return 0;
    const area = Math.max(0, Number(zone.area) || 0);
    const soil = SOIL_FACTORS[clamp(Number(zone.soil) || 0, 0, 5)];
    const shade = SHADE_FACTORS[clamp(Number(zone.shade) || 0, 0, 2)];
    return area * Math.max(0, growthMmPerWeek) * soil * shade;
}

function targetMinutes(zones, growthMmPerWeek, mowingSpeedM2h, referenceGrowthMm = 3) {
    const weightedArea = zones.reduce((sum, zone) => sum + zoneDemand(zone, growthMmPerWeek), 0);
    const speed = Math.max(0.01, Number(mowingSpeedM2h) || 0);
    return (weightedArea / Math.max(0.01, referenceGrowthMm)) / speed * 60;
}

function extensionPercent(target, planned) {
    if (planned <= 0) return target > 0 ? 100 : -100;
    return Math.round(clamp((target / planned - 1) * 100, -100, 100));
}

function distributeZones(zones, growthMmPerWeek, sequenceLength = 10) {
    const demands = zones.map(zone => zoneDemand(zone, growthMmPerWeek));
    const total = demands.reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    const result = [];
    const used = demands.map(() => 0);
    for (let n = 0; n < sequenceLength; n++) {
        let best = 0;
        for (let i = 1; i < demands.length; i++) {
            if (demands[i] / total * (n + 1) - used[i] > demands[best] / total * (n + 1) - used[best]) best = i;
        }
        result.push(Number(zones[best].id));
        used[best]++;
    }
    return result;
}

function decide({ raining, tooWindy, tooCold, target, mowed, planned, minTime, blockedByQuota }) {
    if (raining) return { extension: -100, blocked: true, reason: 'rain' };
    if (tooWindy) return { extension: -100, blocked: true, reason: 'wind' };
    if (tooCold) return { extension: -100, blocked: true, reason: 'temperature' };
    const remaining = Math.max(0, target - mowed);
    const releaseAt = Math.max(0, Number(minTime) || 0);
    if (blockedByQuota && remaining < releaseAt) return { extension: -100, blocked: true, reason: 'quota-hysteresis' };
    if (remaining <= 0) return { extension: -100, blocked: true, reason: 'weekly-target-reached' };
    return { extension: extensionPercent(remaining, planned), blocked: false, reason: 'mowing-demand' };
}

module.exports = { SOIL_FACTORS, SHADE_FACTORS, calendarMinutes, targetMinutes, distributeZones, decide };
