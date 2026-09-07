'use strict';

const createMowtime = require('./main.js');

const adapter = createMowtime();
const originalReady = adapter.listeners('ready').find(listener => listener.name === 'bound onReady');

if (originalReady) adapter.removeListener('ready', originalReady);

let localClockTimer = null;

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

        await adapter.setStateAsync('runtime.timeZone', timeZone, true);
        await updateLocalTimeState(timeZone);

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
