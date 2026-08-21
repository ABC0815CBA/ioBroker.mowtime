'use strict';

const SOILS = {
    sand: { capacityMm: 30, drainageMmPerHour: 4, infiltration: 0.85 },
    sandyLoam: { capacityMm: 50, drainageMmPerHour: 2, infiltration: 0.92 },
    loam: { capacityMm: 75, drainageMmPerHour: 1, infiltration: 0.95 },
    clay: { capacityMm: 95, drainageMmPerHour: 0.35, infiltration: 0.8 }
};

function normalizeSoilType(value) {
    if (SOILS[value]) return value;
    if (Number(value) === 0) return 'sand';
    if (Number(value) === 2) return 'clay';
    return 'loam';
}

function moistureStress(ratio) {
    if (ratio <= 0.1) return 0;
    if (ratio < 0.45) return (ratio - 0.1) / 0.35;
    if (ratio <= 1) return 1;
    return Math.max(0, 1 - (ratio - 1) / 0.25);
}

function soilWaterBalance(precipitation, et0, soilType) {
    const type = normalizeSoilType(soilType);
    const profile = SOILS[type];
    const rain = Array.isArray(precipitation) ? precipitation : [];
    const evaporation = Array.isArray(et0) ? et0 : [];
    const length = Math.max(rain.length, evaporation.length);
    let storage = profile.capacityMm * 0.6;
    const recentFactors = [];
    for (let index = 0; index < length; index++) {
        storage += Math.max(0, Number(rain[index]) || 0) * profile.infiltration;
        storage -= Math.max(0, Number(evaporation[index]) || 0) * 0.85;
        if (storage > profile.capacityMm) storage -= Math.min(storage - profile.capacityMm, profile.drainageMmPerHour);
        storage = Math.min(profile.capacityMm * 1.25, Math.max(0, storage));
        if (index >= length - 72) recentFactors.push(moistureStress(storage / profile.capacityMm));
    }
    const factor = recentFactors.length ? recentFactors.reduce((sum, value) => sum + value, 0) / recentFactors.length : moistureStress(storage / profile.capacityMm);
    return { type, storageMm: storage, capacityMm: profile.capacityMm, factor };
}

module.exports = { SOILS, normalizeSoilType, moistureStress, soilWaterBalance };
