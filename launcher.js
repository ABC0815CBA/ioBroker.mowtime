'use strict';

const createMowtime = require('./main.js');

const adapter = createMowtime();
const originalReady = adapter.listeners('ready').find(listener => listener.name === 'bound onReady');

if (originalReady) adapter.removeListener('ready', originalReady);

let localClockTimer = null;
adapter.lastDecisionSlotKey = '';
adapter.decisionInProgressKey = '';

function isValidTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

async function detectTimeZone() {
    let timeZone = '';

    try {
        const systemConfig = await adapter.getForeignObjectAsync('system.config');
        timeZone = String(systemConfig?.common?.timezone || systemConfig?.common?.timeZone || '').trim();
    } catch (e) {
        adapter.log.debug(`ioBroker-Zeitzone konnte nicht aus system.config gelesen werden: ${e.message}`);
    }

    if (!timeZone) {
        timeZone = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
    }

    if (!timeZone || !isValidTimeZone(timeZone)) {
        adapter.log.warn(`Ungültige oder unbekannte Zeitzone "${timeZone || 'leer'}". Fallback auf UTC.`);
        timeZone = 'UTC';
    }

    return timeZone;
}

function formatLocalTime(timeZone, date = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).format(date);
}

async function updateLocalTimeState(timeZone) {
    await adapter.setStateAsync('runtime.localTime', formatLocalTime(timeZone), true);
}

function getUpcomingDecision(slots, now) {
    const isoDay = adapter.currentIsoDay(now);
    let nextStartMs = Number.POSITIVE_INFINITY;
    const candidates = [];

    for (const slot of slots) {
        if (slot.duration <= 0) continue;

        const daysAhead = (slot.isoDay - isoDay + 7) % 7;
        const start = new Date(now);
        start.setSeconds(0, 0);
        start.setDate(start.getDate() + daysAhead);
        start.setHours(Math.floor(slot.startMinute / 60), slot.startMinute % 60, 0, 0);

        if (start.getTime() <= now.getTime()) {
            start.setDate(start.getDate() + 7);
        }

        const startMs = start.getTime();
        if (startMs < nextStartMs) {
            nextStartMs = startMs;
            candidates.length = 0;
            candidates.push(slot);
        } else if (startMs === nextStartMs) {
            candidates.push(slot);
        }
    }

    if (!Number.isFinite(nextStartMs)) return null;

    const msUntilStart = nextStartMs - now.getTime();
    if (msUntilStart <= 0 || msUntilStart > 15 * 60_000) return null;

    const descriptors = candidates
        .map(slot => `${slot.cal}:${slot.isoDay}:${slot.startMinute}:${slot.duration}:${slot.mandatory ? 1 : 0}`)
        .sort()
        .join('|');

    return {
        slots: candidates,
        key: `${nextStartMs}:${descriptors}`,
        minutesUntilStart: msUntilStart / 60_000,
    };
}

adapter.evaluate = async function evaluateOncePerSlot() {
    if (!this.worxBaseId) return;

    const { targets, actual } = await this.updateStatistics();
    const totalRemaining = targets.reduce((sum, target, i) => sum + Math.max(0, target - actual[i]), 0);
    const slots = await this.getSlots();
    const now = new Date();
    const possibleAll = this.futureSlotMinutes(slots, now, 'all');
    const possibleBase = this.futureSlotMinutes(slots, now, 'mandatory');
    const possibleOptional = this.futureSlotMinutes(slots, now, 'optional');

    await this.setStateAsync('control.MowtimeToDo', Math.round(totalRemaining * 10) / 10, true);
    await this.setStateAsync('control.PossibleMovetimeAll', possibleAll, true);
    await this.setStateAsync('control.PossibleMovetimeBase', possibleBase, true);
    await this.setStateAsync('control.PossibleMovetimeOptional', possibleOptional, true);

    const rainLocked = Date.now() < this.rainLockedUntil;
    await this.setStateAsync('control.rainLockActive', rainLocked, true);
    await this.setStateAsync('control.rainLockedUntil', this.rainLockedUntil || 0, true);

    const optionalNeeded = totalRemaining > possibleBase;
    let output = rainLocked || totalRemaining <= 0 ? -100 : 0;
    let decision = rainLocked || totalRemaining <= 0 ? 0 : (optionalNeeded ? 2 : 1);
    const upcoming = getUpcomingDecision(slots, now);

    if (!rainLocked && totalRemaining > 0 && upcoming) {
        const upcomingMandatory = upcoming.slots.some(slot => slot.mandatory);
        const upcomingOptional = upcoming.slots.some(slot => !slot.mandatory);
        const status = Number((await this.getForeignStateAsync(this.worxStates.status))?.val);
        const home = status === 1;

        if (home && upcomingOptional && !upcomingMandatory && !optionalNeeded) {
            output = -100;
            decision = 0;
        }
    }

    await this.setStateAsync('control.MovetimeDecision', decision, true);
    await this.setStateAsync('control.mowTimeExtendActual', output, true);

    // Regen ist die einzige Ausnahme: eine neue Regensperre wird sofort an Worx weitergegeben.
    if (rainLocked) {
        await this.writeMowTimeExtendIfChanged(-100);
        return;
    }

    // Normale Freigabe/Sperre wird genau einmal pro Mähfenster übertragen:
    // beim ersten Lauf innerhalb der 15 Minuten vor dessen Beginn.
    if (!upcoming || upcoming.key === this.lastDecisionSlotKey || upcoming.key === this.decisionInProgressKey) return;

    this.decisionInProgressKey = upcoming.key;
    try {
        await this.writeMowTimeExtendIfChanged(output);
        this.lastDecisionSlotKey = upcoming.key;
        await this.setStateAsync('runtime.lastDecisionSlotKey', upcoming.key, true);
        this.log.info(`Mähfenster-Entscheidung einmalig ${upcoming.minutesUntilStart.toFixed(1)} min vor Start ausgeführt.`);
    } finally {
        this.decisionInProgressKey = '';
    }
};

adapter.prependListener('ready', async () => {
    try {
        const timeZone = await detectTimeZone();

        // Node verwendet diese Zeitzone anschließend auch für Date#getHours(),
        // Date#getDay(), setHours() usw. in der bestehenden Mowtime-Logik.
        process.env.TZ = timeZone;

        await adapter.setObjectNotExistsAsync('runtime.timeZone', {
            type: 'state',
            common: { name: 'Verwendete Zeitzone', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await adapter.setObjectNotExistsAsync('runtime.localTime', {
            type: 'state',
            common: { name: 'Lokale Zeit Mowtime', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await adapter.setObjectNotExistsAsync('runtime.lastDecisionSlotKey', {
            type: 'state',
            common: { name: 'Zuletzt entschiedener Mähslot', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await adapter.setStateAsync('runtime.timeZone', timeZone, true);
        await updateLocalTimeState(timeZone);
        adapter.lastDecisionSlotKey = String((await adapter.getStateAsync('runtime.lastDecisionSlotKey'))?.val || '');

        localClockTimer = setInterval(() => {
            updateLocalTimeState(timeZone).catch(e => adapter.log.debug(`Lokale Zeit konnte nicht aktualisiert werden: ${e.message}`));
        }, 60_000);
        if (typeof localClockTimer.unref === 'function') localClockTimer.unref();

        adapter.log.info(`Mowtime-Zeitzone: ${timeZone}; lokale Zeit: ${formatLocalTime(timeZone)}`);
    } catch (e) {
        adapter.log.warn(`Zeitzoneninitialisierung fehlgeschlagen: ${e.message}`);
    }

    if (originalReady) {
        try {
            await originalReady();
        } catch (e) {
            adapter.log.error(e.stack || e.message);
        }
    }
});

adapter.on('unload', () => {
    if (localClockTimer) clearInterval(localClockTimer);
    localClockTimer = null;
});
