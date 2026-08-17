'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/calculation');

test('calendar example contains 270 planned minutes', () => {
    const a = '[["00:00",0,0],["10:00",90,0],["00:00",0,0],["10:00",90,1],["10:00",90,0],["00:00",0,0],["00:00",0,0]]';
    const b = '[["00:00",0,0],["00:00",0,0],["00:00",0,0],["00:00",0,0],["00:00",0,0],["00:00",0,0],["00:00",0,0]]';
    assert.equal(c.calendarMinutes(a, b), 270);
});
test('rain always blocks', () => assert.deepEqual(c.decide({raining:true,target:100,mowed:0,planned:270}), {extension:-100,blocked:true,reason:'rain'}));
test('equal target and plan means zero extension', () => assert.equal(c.decide({target:270,mowed:0,planned:270,minTime:30}).extension, 0));
test('sequence follows weighted zone demand', () => assert.deepEqual(c.distributeZones([{id:0,active:true,area:40,soil:2,shade:0},{id:1,active:true,area:60,soil:2,shade:0}],3,10).sort(), [0,0,0,0,1,1,1,1,1,1]));
