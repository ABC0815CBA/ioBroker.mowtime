'use strict';

const utils = require('@iobroker/adapter-core');

class Mowtime extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mowtime' });
        this.lastBladeHours = null;
        this.lastArea = null;
        this.rainReference = null;
        this.lastRainChange = 0;
        this.rainLockedUntil = 0;
        this.timer = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    get worxBaseId() {
        return String(this.config.worxBaseId || '').replace(/\.$/, '');
    }

    get weekStartDay() {
        const value = Number(this.config.weekStartDay);
        return Number.isInteger(value) && value >= 1 && value <= 7 ? value : 1;
    }

    get worxStates() {
        const base = this.worxBaseId;
        return {
            calJson: `${base}.calendar.calJson`,
            calJson2: `${base}.calendar.calJson2`,
            bladeTime: `${base}.mower.totalBladeTime`,
            area: `${base}.areas.actualArea`,
            status: `${base}.mower.status`,
            mowTimeExtend: `${base}.mower.mowTimeExtend`,
        };
    }

    async onReady() {
        await this.createObjects();
        await this.migrateResultsToStatistics();
        await this.restoreRuntime();

        await this.subscribeStatesAsync('control.ResetActualWeek');
        await this.subscribeStatesAsync('Statistics.actualWeek.zone*.realMowtime');

        if (!this.worxBaseId) {
            this.log.error('Keine Worx Basis-Datenpunkt-ID konfiguriert.');
            return;
        }

        const s = this.worxStates;
        const watched = [s.bladeTime, s.area, s.status, s.calJson, s.calJson2];
        if (this.config.rainSource === 'state' && this.config.rainState) watched.push(this.config.rainState);
        for (const id of watched.filter(Boolean)) await this.subscribeForeignStatesAsync(id);

        await this.refreshCalendarSlots();
        await this.sampleInputs();
        await this.evaluate();
        this.timer = this.setInterval(() => this.tick().catch(e => this.log.error(e.stack || e.message)), 60_000);
    }

    async createObjects() {
        for (const week of ['actualWeek', 'pastWeek']) {
            for (let zone = 1; zone <= 4; zone++) {
                const base = `Statistics.${week}.zone${zone}`;
                const realWritable = week === 'actualWeek';
                await this.setObjectNotExistsAsync(`${base}.realMowtime`, {
                    type: 'state',
                    common: { name: 'Real mow time', type: 'number', role: 'value.interval', unit: 'min', min: 0, read: true, write: realWritable },
                    native: {},
                });
                if (realWritable) await this.extendObjectAsync(`${base}.realMowtime`, { common: { write: true, min: 0 } });
                await this.setObjectNotExistsAsync(`${base}.realMowtimePercent`, { type:'state', common:{ name:'Real mow time percent', type:'number', role:'value', unit:'%', read:true, write:false }, native:{} });
                await this.setObjectNotExistsAsync(`${base}.targetMowtime`, { type:'state', common:{ name:'Target mow time', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
                await this.setObjectNotExistsAsync(`${base}.targetMowtimePercent`, { type:'state', common:{ name:'Target mow time percent', type:'number', role:'value', unit:'%', read:true, write:false }, native:{} });
            }
        }

        for (let i = 0; i < 14; i++) {
            await this.setObjectNotExistsAsync(`schedule.slot${String(i).padStart(2, '0')}`, {
                type:'state', common:{ name:`Mähplan Slot ${i + 1}`, type:'string', role:'text', read:true, write:false }, native:{},
            });
        }

        await this.setObjectNotExistsAsync('control.MowtimeExtended', { type:'state', common:{ name:'MowtimeExtended', type:'number', role:'level', unit:'%', min:-100, max:100, read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.PossibleMovetimeAll', { type:'state', common:{ name:'Gesamte noch verfügbare Mähzeit', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.PossibleMovetimeBase', { type:'state', common:{ name:'Noch verfügbare Pflicht-Mähzeit', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.PossibleMovetimeOptional', { type:'state', common:{ name:'Noch verfügbare optionale Mähzeit', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.MovetimeDecision', { type:'state', common:{ name:'Mähzeit Entscheidung', type:'number', role:'value', states:{ 0:'Mähzeit erreicht / gesperrt', 1:'Freigabe Pflichtzeit', 2:'Freigabe optionale Zeit' }, min:0, max:2, read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.ResetActualWeek', { type:'state', common:{ name:'Aktuelle Woche zurücksetzen', type:'boolean', role:'button', read:true, write:true, def:false }, native:{} });
        await this.setObjectNotExistsAsync('control.rainLockActive', { type:'state', common:{ name:'Rain lock active', type:'boolean', role:'indicator', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.rainLockedUntil', { type:'state', common:{ name:'Rain locked until', type:'number', role:'value.time', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastBladeHours', { type:'state', common:{ name:'Last blade hours', type:'number', role:'value', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastArea', { type:'state', common:{ name:'Last area', type:'number', role:'value', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.weekKey', { type:'state', common:{ name:'Mähwochen-Schlüssel', type:'string', role:'text', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.weekStartDay', { type:'state', common:{ name:'Aktiver Wochenstart', type:'number', role:'value', min:1, max:7, read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.rainReference', { type:'state', common:{ name:'Rain reference', type:'number', role:'value', unit:'mm', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastRainChange', { type:'state', common:{ name:'Last rain change', type:'number', role:'value.time', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastWeatherUpdate', { type:'state', common:{ name:'Letzter Wetterabruf', type:'string', role:'text', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.weatherStatus', { type:'state', common:{ name:'Status Wetterabruf', type:'string', role:'text', read:true, write:false }, native:{} });
    }

    async migrateResultsToStatistics() {
        const fields = ['realMowtime', 'realMowtimePercent', 'targetMowtime', 'targetMowtimePercent'];
        for (const week of ['actualWeek', 'pastWeek']) {
            for (let zone = 1; zone <= 4; zone++) {
                for (const field of fields) {
                    const oldId = `Results.${week}.zone${zone}.${field}`;
                    const newId = `Statistics.${week}.zone${zone}.${field}`;
                    const oldState = await this.getStateAsync(oldId);
                    const newState = await this.getStateAsync(newId);
                    if (oldState && oldState.val !== null && oldState.val !== undefined && (!newState || newState.val === null || newState.val === undefined)) {
                        await this.setStateAsync(newId, oldState.val, true);
                    }
                    try {
                        const oldObject = await this.getObjectAsync(oldId);
                        if (oldObject) await this.delObjectAsync(oldId);
                    } catch (e) {
                        this.log.debug(`Alter Results-State ${oldId} konnte nicht entfernt werden: ${e.message}`);
                    }
                }
            }
        }
    }

    async restoreRuntime() {
        const [blade, area, rain, rainChange] = await Promise.all([
            'runtime.lastBladeHours', 'runtime.lastArea', 'runtime.rainReference', 'runtime.lastRainChange',
        ].map(id => this.getStateAsync(id)));
        this.lastBladeHours = typeof blade?.val === 'number' ? blade.val : null;
        this.lastArea = typeof area?.val === 'number' ? area.val : null;
        this.rainReference = typeof rain?.val === 'number' ? rain.val : null;
        this.lastRainChange = typeof rainChange?.val === 'number' ? rainChange.val : 0;
        await this.rollWeekIfNeeded();
    }

    async onStateChange(id, state) {
        if (!state) return;
        try {
            if (id === `${this.namespace}.control.ResetActualWeek` && state.val === true) {
                await this.resetActualWeek();
                await this.setStateAsync('control.ResetActualWeek', false, true);
                if (this.worxBaseId) await this.evaluate();
                return;
            }

            const prefix = `${this.namespace}.Statistics.actualWeek.zone`;
            if (id.startsWith(prefix) && id.endsWith('.realMowtime') && !state.ack) {
                const zone = Number(id.slice(prefix.length).split('.')[0]);
                if (Number.isInteger(zone) && zone >= 1 && zone <= 4) {
                    const value = Math.max(0, Number(state.val) || 0);
                    await this.setStateAsync(`Statistics.actualWeek.zone${zone}.realMowtime`, Math.round(value * 10) / 10, true);
                    if (this.worxBaseId) await this.evaluate();
                    else await this.updateStatistics();
                }
                return;
            }

            if (!this.worxBaseId) return;
            const s = this.worxStates;
            if (id === s.calJson || id === s.calJson2) await this.refreshCalendarSlots();
            if (id === s.bladeTime || id === s.area) await this.sampleInputs();
            if (this.config.rainSource === 'state' && id === this.config.rainState) await this.processRainValue(Number(state.val));
            await this.evaluate();
        } catch (e) {
            this.log.error(e.stack || e.message);
        }
    }

    async tick() {
        await this.rollWeekIfNeeded();
        await this.sampleInputs();
        if (this.config.rainSource === 'openmeteo') await this.updateOpenMeteoRain();
        await this.evaluate();
    }

    parseCalendar(value) {
        try {
            const data = typeof value === 'string' ? JSON.parse(value) : value;
            return Array.isArray(data) && data.length === 7 ? data : Array(7).fill(['00:00', 0, 0]);
        } catch {
            return Array(7).fill(['00:00', 0, 0]);
        }
    }

    formatEndTime(start, duration) {
        const [h, m] = String(start || '00:00').split(':').map(Number);
        const total = ((h || 0) * 60 + (m || 0) + duration) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    async refreshCalendarSlots() {
        if (!this.worxBaseId) return;
        const [a, b] = await Promise.all([
            this.getForeignStateAsync(this.worxStates.calJson),
            this.getForeignStateAsync(this.worxStates.calJson2),
        ]);
        const calendars = [this.parseCalendar(a?.val), this.parseCalendar(b?.val)];
        const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
        for (let cal = 0; cal < 2; cal++) {
            for (let rawDay = 0; rawDay < 7; rawDay++) {
                const raw = calendars[cal][rawDay] || ['00:00', 0, 0];
                const start = String(raw[0] || '00:00');
                const duration = Math.max(0, Number(raw[1]) || 0);
                const text = duration > 0 ? `${days[rawDay]} ${start}–${this.formatEndTime(start, duration)} (${duration} min)` : `${days[rawDay]} – keine Mähzeit`;
                await this.setStateAsync(`schedule.slot${String(cal * 7 + rawDay).padStart(2, '0')}`, text, true);
            }
        }
    }

    isMandatory(index) {
        const direct = this.config[`slotMandatory${String(index).padStart(2, '0')}`];
        if (typeof direct === 'boolean') return direct;
        const legacy = Array.isArray(this.config.mandatorySlots) ? this.config.mandatorySlots[index] : false;
        return !!(legacy?.mandatory ?? legacy);
    }

    async getSlots() {
        const [a, b] = await Promise.all([
            this.getForeignStateAsync(this.worxStates.calJson),
            this.getForeignStateAsync(this.worxStates.calJson2),
        ]);
        const calendars = [this.parseCalendar(a?.val), this.parseCalendar(b?.val)];
        const slots = [];
        for (let cal = 0; cal < 2; cal++) {
            for (let rawDay = 0; rawDay < 7; rawDay++) {
                const raw = calendars[cal][rawDay] || ['00:00', 0, 0];
                const duration = Math.max(0, Number(raw[1]) || 0);
                const [h, m] = String(raw[0] || '00:00').split(':').map(Number);
                const isoDay = rawDay === 0 ? 7 : rawDay;
                const index = cal * 7 + rawDay;
                slots.push({
                    cal,
                    isoDay,
                    weekDayIndex: (isoDay - this.weekStartDay + 7) % 7,
                    startMinute: (h || 0) * 60 + (m || 0),
                    duration,
                    mandatory: this.isMandatory(index),
                });
            }
        }
        return slots;
    }

    async sampleInputs() {
        if (!this.worxBaseId) return;
        const [bladeState, areaState] = await Promise.all([
            this.getForeignStateAsync(this.worxStates.bladeTime),
            this.getForeignStateAsync(this.worxStates.area),
        ]);
        const blade = Number(bladeState?.val);
        const area = Number(areaState?.val);
        if (!Number.isFinite(blade) || !Number.isInteger(area) || area < 0 || area > 3) return;
        if (this.lastBladeHours !== null && blade >= this.lastBladeHours) {
            const delta = (blade - this.lastBladeHours) * 60;
            if (delta > 0 && delta < 180) await this.addZoneMinutes(area + 1, delta);
        }
        this.lastBladeHours = blade;
        this.lastArea = area;
        await this.setStateAsync('runtime.lastBladeHours', blade, true);
        await this.setStateAsync('runtime.lastArea', area, true);
    }

    async addZoneMinutes(zone, delta) {
        const id = `Statistics.actualWeek.zone${zone}.realMowtime`;
        const current = Number((await this.getStateAsync(id))?.val || 0);
        await this.setStateAsync(id, Math.round((current + delta) * 10) / 10, true);
    }

    getTargets() {
        return [1, 2, 3, 4].map(z => Math.max(0, Number(this.config[`zone${z}Target`]) || 0));
    }

    async updateStatistics() {
        const targets = this.getTargets();
        const targetTotal = targets.reduce((a, b) => a + b, 0);
        const actual = [];
        for (let z = 1; z <= 4; z++) actual.push(Math.max(0, Number((await this.getStateAsync(`Statistics.actualWeek.zone${z}.realMowtime`))?.val || 0)));
        const actualTotal = actual.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 4; i++) {
            const base = `Statistics.actualWeek.zone${i + 1}`;
            await this.setStateAsync(`${base}.targetMowtime`, targets[i], true);
            await this.setStateAsync(`${base}.targetMowtimePercent`, targetTotal ? Math.round(targets[i] / targetTotal * 1000) / 10 : 0, true);
            await this.setStateAsync(`${base}.realMowtimePercent`, actualTotal ? Math.round(actual[i] / actualTotal * 1000) / 10 : 0, true);
        }
        return { targets, actual };
    }

    currentIsoDay(now) {
        return now.getDay() === 0 ? 7 : now.getDay();
    }

    currentWeekDayIndex(now) {
        return (this.currentIsoDay(now) - this.weekStartDay + 7) % 7;
    }

    futureSlotMinutes(slots, now, filter = 'all') {
        const todayIndex = this.currentWeekDayIndex(now);
        const minute = now.getHours() * 60 + now.getMinutes();
        let total = 0;
        for (const s of slots) {
            if (s.duration <= 0) continue;
            if (filter === 'mandatory' && !s.mandatory) continue;
            if (filter === 'optional' && s.mandatory) continue;
            if (s.weekDayIndex < todayIndex) continue;
            if (s.weekDayIndex > todayIndex) { total += s.duration; continue; }
            const end = s.startMinute + s.duration;
            if (end <= minute) continue;
            total += end - Math.max(minute, s.startMinute);
        }
        return total;
    }

    async evaluate() {
        if (!this.worxBaseId) return;
        const { targets, actual } = await this.updateStatistics();
        const totalRemaining = targets.reduce((sum, target, i) => sum + Math.max(0, target - actual[i]), 0);
        const slots = await this.getSlots();
        const now = new Date();
        const possibleAll = this.futureSlotMinutes(slots, now, 'all');
        const possibleBase = this.futureSlotMinutes(slots, now, 'mandatory');
        const possibleOptional = this.futureSlotMinutes(slots, now, 'optional');

        await this.setStateAsync('control.PossibleMovetimeAll', possibleAll, true);
        await this.setStateAsync('control.PossibleMovetimeBase', possibleBase, true);
        await this.setStateAsync('control.PossibleMovetimeOptional', possibleOptional, true);

        const rainLocked = Date.now() < this.rainLockedUntil;
        await this.setStateAsync('control.rainLockActive', rainLocked, true);
        await this.setStateAsync('control.rainLockedUntil', this.rainLockedUntil || 0, true);

        let output = 0;
        let decision = 1;
        if (rainLocked || totalRemaining <= 0) {
            output = -100;
            decision = 0;
        } else {
            const isoDay = this.currentIsoDay(now);
            const minute = now.getHours() * 60 + now.getMinutes();
            const current = slots.filter(s => s.isoDay === isoDay && s.duration > 0 && minute >= s.startMinute && minute < s.startMinute + s.duration);
            const currentMandatory = current.some(s => s.mandatory);
            const currentOptional = current.some(s => !s.mandatory);
            const optionalNeeded = totalRemaining > possibleBase;
            const status = Number((await this.getForeignStateAsync(this.worxStates.status))?.val);
            const home = status === 1;
            decision = optionalNeeded ? 2 : 1;
            if (home && currentOptional && !currentMandatory && !optionalNeeded) output = -100;
        }

        await this.setStateAsync('control.MovetimeDecision', decision, true);
        await this.setStateAsync('control.MowtimeExtended', output, true);
        await this.writeMowTimeExtendIfChanged(output);
    }

    async writeMowTimeExtendIfChanged(value) {
        const target = Number(value);
        if (!Number.isFinite(target)) return;
        const state = await this.getForeignStateAsync(this.worxStates.mowTimeExtend);
        const current = Number(state?.val);
        if (Number.isFinite(current) && current === target) return;
        this.log.info(`mowTimeExtend geändert: ${Number.isFinite(current) ? current : 'unbekannt'}% -> ${target}%`);
        await this.setForeignStateAsync(this.worxStates.mowTimeExtend, target, false);
    }

    async processRainValue(mm) {
        if (!Number.isFinite(mm)) return;
        const now = Date.now();
        if (this.rainReference === null) {
            this.rainReference = mm;
            this.lastRainChange = now;
        } else if (Math.abs(mm - this.rainReference) >= 0.1 - 1e-9) {
            this.rainReference = mm;
            this.lastRainChange = now;
            this.rainLockedUntil = now + Math.max(0, Number(this.config.rainLockHours) || 0) * 3600_000;
        }
        if (this.lastRainChange && now - this.lastRainChange < (Number(this.config.rainLockHours) || 0) * 3600_000) {
            this.rainLockedUntil = Math.max(this.rainLockedUntil, this.lastRainChange + (Number(this.config.rainLockHours) || 0) * 3600_000);
        }
        await this.setStateAsync('runtime.rainReference', this.rainReference, true);
        await this.setStateAsync('runtime.lastRainChange', this.lastRainChange, true);
    }

    async updateOpenMeteoRain() {
        if (this.config.rainSource !== 'openmeteo') return;
        const lat = Number(this.config.latitude);
        const lon = Number(this.config.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) {
            await this.setStateAsync('runtime.weatherStatus', 'Fehler: ungültige Koordinaten', true);
            return;
        }
        try {
            await this.setStateAsync('runtime.weatherStatus', 'Abruf läuft', true);
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=precipitation&timezone=auto`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const precipitation = Number(json?.current?.precipitation);
            const now = new Date();
            await this.setStateAsync('runtime.lastWeatherUpdate', now.toLocaleString('de-DE'), true);
            await this.setStateAsync('runtime.weatherStatus', Number.isFinite(precipitation) ? `OK (${precipitation} mm)` : 'OK', true);
            if (Number.isFinite(precipitation) && precipitation >= 0.1) {
                const ms = now.getTime();
                this.lastRainChange = ms;
                this.rainLockedUntil = ms + Math.max(0, Number(this.config.rainLockHours) || 0) * 3600_000;
                await this.setStateAsync('runtime.lastRainChange', ms, true);
            }
        } catch (e) {
            await this.setStateAsync('runtime.weatherStatus', `Fehler: ${e.message}`, true);
            this.log.warn(`Open-Meteo: ${e.message}`);
        }
    }

    weekKey(date) {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const isoDay = d.getDay() === 0 ? 7 : d.getDay();
        d.setDate(d.getDate() - ((isoDay - this.weekStartDay + 7) % 7));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    async resetActualWeek() {
        for (let z = 1; z <= 4; z++) {
            await this.setStateAsync(`Statistics.actualWeek.zone${z}.realMowtime`, 0, true);
            await this.setStateAsync(`Statistics.actualWeek.zone${z}.realMowtimePercent`, 0, true);
        }
        await this.updateStatistics();
    }

    async rollWeekIfNeeded() {
        const key = this.weekKey(new Date());
        const oldKey = (await this.getStateAsync('runtime.weekKey'))?.val;
        const storedStart = Number((await this.getStateAsync('runtime.weekStartDay'))?.val);

        if (!Number.isInteger(storedStart) || storedStart < 1 || storedStart > 7) {
            await this.setStateAsync('runtime.weekStartDay', this.weekStartDay, true);
            await this.setStateAsync('runtime.weekKey', key, true);
            return;
        }

        if (storedStart !== this.weekStartDay) {
            this.log.info(`Wochenstart geändert: ${storedStart} -> ${this.weekStartDay}. Aktuelle Ist-Mähzeiten bleiben erhalten; ResetActualWeek kann für einen manuellen Neustart verwendet werden.`);
            await this.setStateAsync('runtime.weekStartDay', this.weekStartDay, true);
            await this.setStateAsync('runtime.weekKey', key, true);
            return;
        }

        if (!oldKey) {
            await this.setStateAsync('runtime.weekKey', key, true);
            return;
        }
        if (oldKey === key) return;

        for (let z = 1; z <= 4; z++) {
            for (const field of ['realMowtime', 'realMowtimePercent', 'targetMowtime', 'targetMowtimePercent']) {
                const src = Number((await this.getStateAsync(`Statistics.actualWeek.zone${z}.${field}`))?.val || 0);
                await this.setStateAsync(`Statistics.pastWeek.zone${z}.${field}`, src, true);
            }
        }
        await this.resetActualWeek();
        await this.setStateAsync('runtime.weekKey', key, true);
    }

    onUnload(callback) {
        try {
            if (this.timer) this.clearInterval(this.timer);
            callback();
        } catch {
            callback();
        }
    }
}

if (module.parent) module.exports = options => new Mowtime(options);
else new Mowtime();
