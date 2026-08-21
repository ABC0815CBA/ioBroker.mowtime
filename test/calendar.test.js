'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCalendar, remainingCalendarMinutes, calendarPosition, weekKey } = require('../lib/calendar');

test('parses Worx calendar JSON', () => {
    assert.equal(parseCalendar('[[' + '"10:00",90,0]]')[0][1], 90);
    assert.deepEqual(parseCalendar('invalid'), []);
});

test('counts current and future appointments from both calendars', () => {
    const cal = [['00:00', 0, 0], ['10:00', 90, 0], ['12:00', 60, 0], ['00:00', 0, 0], ['00:00', 0, 0], ['00:00', 0, 0], ['00:00', 0, 0]];
    const tuesdayNine = new Date(2026, 7, 18, 9, 0);
    assert.equal(remainingCalendarMinutes([cal, cal], tuesdayNine), 300);
});

test('returns stable ISO week keys', () => {
    assert.equal(weekKey(new Date(2026, 0, 1)), '2026-W01');
});

test('identifies mowing windows and stable gaps between them', () => {
    const cal = [['00:00', 0, 0], ['10:00', 90, 0], ['12:00', 60, 0], ['00:00', 0, 0], ['00:00', 0, 0], ['00:00', 0, 0], ['00:00', 0, 0]];
    assert.equal(calendarPosition([cal], new Date(2026, 7, 18, 10, 30)).active, true);
    assert.deepEqual(calendarPosition([cal], new Date(2026, 7, 18, 11, 45)), { active: false, gapKey: '2026-W34:gap:1' });
    assert.deepEqual(calendarPosition([cal], new Date(2026, 7, 18, 11, 55)), { active: false, gapKey: '2026-W34:gap:1' });
});
