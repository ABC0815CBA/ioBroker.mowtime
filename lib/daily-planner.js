'use strict';

function extensionPercent(desiredMinutes, plannedMinutes) {
    if (plannedMinutes <= 0) return desiredMinutes > 0 ? 100 : -100;
    return Math.round(Math.min(100, Math.max(-100, (desiredMinutes / plannedMinutes - 1) * 100)));
}

function settleDay(targetByZone, actualTotalMinutes) {
    const targetTotal = targetByZone.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const actualByZone = targetByZone.map(value => targetTotal > 0 ? Math.max(0, actualTotalMinutes) * Math.max(0, value) / targetTotal : 0);
    const carryByZone = targetByZone.map((value, i) => (Number(value) || 0) - actualByZone[i]);
    return { targetTotal, actualByZone, carryByZone };
}

function nextDemand(targetByZone, carryByZone) {
    return targetByZone.map((target, i) => Math.max(0, (Number(target) || 0) + (Number(carryByZone[i]) || 0)));
}

module.exports = { extensionPercent, settleDay, nextDemand };
