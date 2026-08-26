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
        await this.initializeMandatorySlots();
        await this.restoreRuntime();

        if (!this.worxBaseId) {
            this.log.error('Keine Worx Basis-Datenpunkt-ID konfiguriert.');
            return;
        }

        const states = this.worxStates;
        const watched = [states.bladeTime, states.area, states.status, states.calJson, states.calJson2];
        if (this.config.rainSource === 'state' && this.config.rainState) watched.push(this.config.rainState);
        for (const id of watched.filter(Boolean)) await this.subscribeForeignStatesAsync(id);

        await this.sampleInputs();
        await this.evaluate();
        this.timer = this.setInterval(() => this.tick().catch(e => this.log.error(e.stack || e.message)), 60_000);
    }

    async initializeMandatorySlots() {
        if (Array.isArray(this.config.mandatorySlots) && this.config.mandatorySlots.length === 14) {
            if (typeof this.config.mandatorySlots[0] === 'object') return;
            this.config.mandatorySlots = this.config.mandatorySlots.map((mandatory, i) => ({
                mandatory: !!mandatory,
                label: `${i < 7 ? 'calJson' : 'calJson2'} ${['Mo','Di','Mi','Do','Fr','Sa','So'][i % 7]}`,
            }));
        } else {
            this.config.mandatorySlots = Array.from({ length: 14 }, (_, i) => ({
                mandatory: false,
                label: `${i < 7 ? 'calJson' : 'calJson2'} ${['Mo','Di','Mi','Do','Fr','Sa','So'][i % 7]}`,
            }));
        }
    }

    async createObjects() {
        for (const week of ['actualWeek', 'pastWeek']) {
            for (let zone = 1; zone <= 4; zone++) {
                const base = `Results.${week}.zone${zone}`;
                await this.setObjectNotExistsAsync(`${base}.realMowtime`, { type:'state', common:{ name:'Real mow time', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
                await this.setObjectNotExistsAsync(`${base}.realMowtimePercent`, { type:'state', common:{ name:'Real mow time percent', type:'number', role:'value', unit:'%', read:true, write:false }, native:{} });
                await this.setObjectNotExistsAsync(`${base}.targetMowtime`, { type:'state', common:{ name:'Target mow time', type:'number', role:'value.interval', unit:'min', read:true, write:false }, native:{} });
                await this.setObjectNotExistsAsync(`${base}.targetMowtimePercent`, { type:'state', common:{ name:'Target mow time percent', type:'number', role:'value', unit:'%', read:true, write:false }, native:{} });
            }
        }
        await this.setObjectNotExistsAsync('control.MowtimeExtended', { type:'state', common:{ name:'MowtimeExtended', type:'number', role:'level', unit:'%', min:-100, max:100, read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.rainLockActive', { type:'state', common:{ name:'Rain lock active', type:'boolean', role:'indicator', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('control.rainLockedUntil', { type:'state', common:{ name:'Rain locked until', type:'number', role:'value.time', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastBladeHours', { type:'state', common:{ name:'Last blade hours', type:'number', role:'value', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastArea', { type:'state', common:{ name:'Last area', type:'number', role:'value', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.weekKey', { type:'state', common:{ name:'ISO week key', type:'string', role:'text', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.rainReference', { type:'state', common:{ name:'Rain reference', type:'number', role:'value', unit:'mm', read:true, write:false }, native:{} });
        await this.setObjectNotExistsAsync('runtime.lastRainChange', { type:'state', common:{ name:'Last rain change', type:'number', role:'value.time', read:true, write:false }, native:{} });
    }

    async restoreRuntime() {
        const blade = await this.getStateAsync('runtime.lastBladeHours');
        const area = await this.getStateAsync('runtime.lastArea');
        const rain = await this.getStateAsync('runtime.rainReference');
        const rainChange = await this.getStateAsync('runtime.lastRainChange');
        this.lastBladeHours = blade && typeof blade.val === 'number' ? blade.val : null;
        this.lastArea = area && typeof area.val === 'number' ? area.val : null;
        this.rainReference = rain && typeof rain.val === 'number' ? rain.val : null;
        this.lastRainChange = rainChange && typeof rainChange.val === 'number' ? rainChange.val : 0;
        await this.rollWeekIfNeeded();
    }

    async onStateChange(id, state) {
        if (!state || !this.worxBaseId) return;
        try {
            const states = this.worxStates;
            if (id === states.bladeTime || id === states.area) await this.sampleInputs();
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

    async sampleInputs() {
        if (!this.worxBaseId) return;
        const states = this.worxStates;
        const [bladeState, areaState] = await Promise.all([
            this.getForeignStateAsync(states.bladeTime),
            this.getForeignStateAsync(states.area),
        ]);
        const blade = Number(bladeState?.val);
        const area = Number(areaState?.val);
        if (!Number.isFinite(blade) || !Number.isInteger(area) || area < 0 || area > 3) return;

        if (this.lastBladeHours !== null && blade >= this.lastBladeHours) {
            const deltaMinutes = (blade - this.lastBladeHours) * 60;
            if (deltaMinutes > 0 && deltaMinutes < 180) {
                // totalBladeTime is an absolute counter. Its increase is assigned to the currently reported zone.
                await this.addZoneMinutes(area + 1, deltaMinutes);
            }
        }
        this.lastBladeHours = blade;
        this.lastArea = area;
        await this.setStateAsync('runtime.lastBladeHours', blade, true);
        await this.setStateAsync('runtime.lastArea', area, true);
    }

    async addZoneMinutes(zone, delta) {
        const id = `Results.actualWeek.zone${zone}.realMowtime`;
        const current = Number((await this.getStateAsync(id))?.val || 0);
        await this.setStateAsync(id, Math.round((current + delta) * 10) / 10, true);
    }

    getTargets() {
        return [1,2,3,4].map(z => Math.max(0, Number(this.config[`zone${z}Target`]) || 0));
    }

    async updateResults() {
        const targets = this.getTargets();
        const targetTotal = targets.reduce((a,b) => a+b, 0);
        const actual = [];
        for (let z=1; z<=4; z++) actual.push(Number((await this.getStateAsync(`Results.actualWeek.zone${z}.realMowtime`))?.val || 0));
        const actualTotal = actual.reduce((a,b) => a+b, 0);
        for (let i=0; i<4; i++) {
            const base = `Results.actualWeek.zone${i+1}`;
            await this.setStateAsync(`${base}.targetMowtime`, targets[i], true);
            await this.setStateAsync(`${base}.targetMowtimePercent`, targetTotal ? Math.round(targets[i] / targetTotal * 1000) / 10 : 0, true);
            await this.setStateAsync(`${base}.realMowtimePercent`, actualTotal ? Math.round(actual[i] / actualTotal * 1000) / 10 : 0, true);
        }
        return { targets, actual };
    }

    parseCalendar(value) {
        try {
            const data = typeof value === 'string' ? JSON.parse(value) : value;
            return Array.isArray(data) && data.length === 7 ? data : Array(7).fill(['00:00',0,0]);
        } catch { return Array(7).fill(['00:00',0,0]); }
    }

    async getSlots() {
        const states = this.worxStates;
        const [a,b] = await Promise.all([this.getForeignStateAsync(states.calJson), this.getForeignStateAsync(states.calJson2)]);
        const cals = [this.parseCalendar(a?.val), this.parseCalendar(b?.val)];
        const flags = Array.isArray(this.config.mandatorySlots) ? this.config.mandatorySlots : [];
        const slots = [];
        for (let cal=0; cal<2; cal++) for (let day=0; day<7; day++) {
            const raw = cals[cal][day] || ['00:00',0,0];
            const duration = Math.max(0, Number(raw[1]) || 0);
            const [h,m] = String(raw[0] || '00:00').split(':').map(Number);
            slots.push({ cal, day, startMinute:(h||0)*60+(m||0), duration, mandatory:!!(flags[cal*7+day]?.mandatory ?? flags[cal*7+day]) });
        }
        return slots;
    }

    async evaluate() {
        if (!this.worxBaseId) return;
        const { targets, actual } = await this.updateResults();
        const remaining = targets.map((t,i) => Math.max(0, t - actual[i]));
        const totalRemaining = remaining.reduce((a,b) => a+b, 0);
        let output = 0;

        const rainLocked = Date.now() < this.rainLockedUntil;
        await this.setStateAsync('control.rainLockActive', rainLocked, true);
        await this.setStateAsync('control.rainLockedUntil', this.rainLockedUntil || 0, true);

        if (rainLocked || totalRemaining <= 0) {
            output = -100;
        } else {
            const slots = await this.getSlots();
            const now = new Date();
            const day = (now.getDay() + 6) % 7;
            const minute = now.getHours()*60 + now.getMinutes();
            const current = slots.filter(s => s.day === day && s.duration > 0 && minute >= s.startMinute && minute < s.startMinute+s.duration);
            const currentMandatory = current.some(s => s.mandatory);
            const currentOptional = current.some(s => !s.mandatory);
            const futureMandatoryMinutes = this.futureSlotMinutes(slots, now, true);
            const optionalNeeded = totalRemaining > futureMandatoryMinutes;
            const status = Number((await this.getForeignStateAsync(this.worxStates.status))?.val);
            const home = status === 1;

            if (home && currentOptional && !currentMandatory && !optionalNeeded) output = -100;
            else output = 0;
        }

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

    futureSlotMinutes(slots, now, mandatoryOnly) {
        const today = (now.getDay()+6)%7;
        const minute = now.getHours()*60+now.getMinutes();
        let total = 0;
        for (const s of slots) {
            if (s.duration <= 0 || (mandatoryOnly && !s.mandatory)) continue;
            if (s.day < today) continue;
            if (s.day > today) { total += s.duration; continue; }
            const end = s.startMinute + s.duration;
            if (end <= minute) continue;
            total += end - Math.max(minute, s.startMinute);
        }
        return total;
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
        if (this.lastRainChange && now - this.lastRainChange < (Number(this.config.rainLockHours)||0)*3600_000) {
            this.rainLockedUntil = Math.max(this.rainLockedUntil, this.lastRainChange + (Number(this.config.rainLockHours)||0)*3600_000);
        }
        await this.setStateAsync('runtime.rainReference', this.rainReference, true);
        await this.setStateAsync('runtime.lastRainChange', this.lastRainChange, true);
    }

    async updateOpenMeteoRain() {
        const lat = Number(this.config.latitude), lon = Number(this.config.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) return;
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=precipitation&timezone=auto`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const precipitation = Number(json?.current?.precipitation);
            if (Number.isFinite(precipitation) && precipitation >= 0.1) {
                const now = Date.now();
                this.lastRainChange = now;
                this.rainLockedUntil = now + Math.max(0, Number(this.config.rainLockHours)||0)*3600_000;
                await this.setStateAsync('runtime.lastRainChange', now, true);
            }
        } catch (e) { this.log.warn(`Open-Meteo: ${e.message}`); }
    }

    weekKey(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
        const week = Math.ceil((((d-yearStart)/86400000)+1)/7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
    }

    async rollWeekIfNeeded() {
        const key = this.weekKey(new Date());
        const old = (await this.getStateAsync('runtime.weekKey'))?.val;
        if (!old) { await this.setStateAsync('runtime.weekKey', key, true); return; }
        if (old === key) return;
        for (let z=1; z<=4; z++) {
            for (const field of ['realMowtime','realMowtimePercent','targetMowtime','targetMowtimePercent']) {
                const src = Number((await this.getStateAsync(`Results.actualWeek.zone${z}.${field}`))?.val || 0);
                await this.setStateAsync(`Results.pastWeek.zone${z}.${field}`, src, true);
            }
            await this.setStateAsync(`Results.actualWeek.zone${z}.realMowtime`, 0, true);
            await this.setStateAsync(`Results.actualWeek.zone${z}.realMowtimePercent`, 0, true);
        }
        await this.setStateAsync('runtime.weekKey', key, true);
        await this.updateResults();
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