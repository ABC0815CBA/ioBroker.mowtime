'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../lib/daily-planner');

test('60 desired minutes in a 90 minute schedule reduce it by one third', () => {
    assert.equal(planner.extensionPercent(60, 90), -33);
});

test('30 minute deficit is added to next day', () => {
    const closed = planner.settleDay([60, 0, 0, 0], 30);
    assert.deepEqual(closed.carryByZone, [30, 0, 0, 0]);
    assert.deepEqual(planner.nextDemand([60, 0, 0, 0], closed.carryByZone), [90, 0, 0, 0]);
    assert.equal(planner.extensionPercent(90, 90), 0);
});

test('measured zone minutes are used without proportional estimation', () => {
    const closed = planner.settleDay([60, 30, 0, 0], [45, 25, 0, 0]);
    assert.deepEqual(closed.actualByZone, [45, 25, 0, 0]);
    assert.deepEqual(closed.carryByZone, [15, 5, 0, 0]);
});
