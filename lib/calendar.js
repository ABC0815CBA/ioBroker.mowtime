'use strict';

function parseCalendar(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function minutesOfDay(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
}

function remainingCalendarMinutes(calendars, now = new Date()) {
    const mondayIndex = (now.getDay() + 6) % 7;
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    let total = 0;
    for (const calendar of calendars.map(parseCalendar)) {
        calendar.forEach((entry, day) => {
            if (!Array.isArray(entry) || day < mondayIndex) return;
            const start = minutesOfDay(entry[0]);
            const duration = Math.max(0, Number(entry[1]) || 0);
            if (day > mondayIndex) total += duration;
            else if (currentMinute <= start) total += duration;
            else if (currentMinute < start + duration) total += start + duration - currentMinute;
        });
    }
    return total;
}

function calendarPosition(calendars, now = new Date()) {
    const mondayIndex = (now.getDay() + 6) % 7;
    const current = mondayIndex * 1440 + now.getHours() * 60 + now.getMinutes();
    let active = false;
    let endedSlots = 0;
    for (const calendar of calendars.map(parseCalendar)) {
        calendar.forEach((entry, day) => {
            if (!Array.isArray(entry)) return;
            const duration = Math.max(0, Number(entry[1]) || 0);
            if (!duration) return;
            const start = day * 1440 + minutesOfDay(entry[0]);
            const end = start + duration;
            if (current >= start && current < end) active = true;
            if (current >= end) endedSlots++;
        });
    }
    return { active, gapKey: `${weekKey(now)}:gap:${endedSlots}` };
}

function weekKey(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = { parseCalendar, remainingCalendarMinutes, calendarPosition, weekKey };
