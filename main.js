'use strict';
const utils = require('@iobroker/adapter-core');
const calc = require('./lib/calculation');
const weatherApi = require('./lib/weather');

class Mowtime extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mowtime' });
        this.timer = null;
        this.weekStartTotal = null;
        this.blockedByQuota = false;
        this.weatherCache = null;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async readValue(id, fallback = 0) {
        if (!id) return fallback;
        const state = await this.getForeignStateAsync(id);
        return state && state.val !== null ? state.val : fallback;
    }

    getZones() {
        return [0, 1, 2, 3].map(i => ({
            id: i,
            active: this.config[`zone${i}Active`] !== false,
            area: Number(this.config[`zone${i}Area`]) || 0,
            soil: Number(this.config[`zone${i}Soil`]) || 0,
            shade: Number(this.config[`zone${i}Shade`]) || 0
        }));
    }

    async createStates() {
        const states = {
            'info.targetMinutes': ['number', 'min'], 'info.mowedMinutes': ['number', 'min'],
            'info.remainingMinutes': ['number', 'min'], 'info.extensionPercent': ['number', '%'],
            'info.reason': ['string', ''], 'info.zoneSequence': ['string', ''],
            'weather.source': ['string', ''], 'weather.status': ['string', ''],
            'weather.lastSuccess': ['number', ''], 'weather.raining': ['boolean', ''],
            'weather.temperature': ['number', '°C'], 'weather.wind': ['number', 'km/h'],
            'control.recalculate': ['boolean', '']
        };
        for (const [id, [type, unit]] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: id, type, role: id === 'control.recalculate' ? 'button' : 'value', read: true, write: id === 'control.recalculate', unit: unit || undefined }, native: {} });
        }
    }

    async getWeather() {
        const mode = this.config.weatherMode || 'sensors';
        if (mode === 'sensors') {
            return {
                interventionAllowed: true,
                raining: Boolean(await this.readValue(this.config.rainState, false)),
                wind: Number(await this.readValue(this.config.windState, 0)),
                temperature: Number(await this.readValue(this.config.temperatureState, 20)),
                source: 'sensors', status: 'ok'
            };
        }
        const now = Date.now();
        const pollMs = 15 * 60000;
        if (!this.weatherCache || now - this.weatherCache.lastAttempt >= pollMs) {
            try {
                const configuredThreshold = Number(this.config.rainThreshold);
                const rainThreshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 0.1;
                const values = await weatherApi.fetchWeather(mode, this.config.latitude, this.config.longitude, rainThreshold);
                this.weatherCache = { ...values, lastAttempt: now, lastSuccess: now };
                await this.setStateAsync('weather.lastSuccess', now, true);
            } catch (error) {
                this.log.warn(`Weather request (${mode}) failed: ${error.message}`);
                if (this.weatherCache) this.weatherCache.lastAttempt = now;
                else {
                    const persisted = Number((await this.getStateAsync('weather.lastSuccess'))?.val) || 0;
                    this.weatherCache = { raining: false, wind: 0, temperature: 20, lastAttempt: now, lastSuccess: persisted };
                }
            }
        }
        const configuredFailureMinutes = Number(this.config.weatherFailureMinutes);
        const failureMinutes = Number.isFinite(configuredFailureMinutes) ? configuredFailureMinutes : 60;
        const maxAge = Math.max(0, failureMinutes) * 60000;
        const stale = !this.weatherCache.lastSuccess || now - this.weatherCache.lastSuccess > maxAge;
        return { ...this.weatherCache, interventionAllowed: !stale, source: mode, status: stale ? 'stale-neutral-0%' : (this.weatherCache.lastSuccess === this.weatherCache.lastAttempt ? 'ok' : 'cached-after-error') };
    }

    async onReady() {
        await this.createStates();
        this.subscribeStates('control.recalculate');
        this.on('stateChange', (id, state) => { if (id.endsWith('control.recalculate') && state && !state.ack) this.run().catch(e => this.log.error(e.stack || e.message)); });
        await this.run();
        this.timer = this.setInterval(() => this.run().catch(e => this.log.error(e.stack || e.message)), Math.max(1, Number(this.config.intervalMinutes) || 5) * 60000);
    }

    async run() {
        const prefix = this.config.worxPrefix;
        if (!prefix) { this.log.warn('Worx prefix is not configured'); return; }
        const totalHours = Number(await this.readValue(`${prefix}.mower.totalTime`, 0));
        const now = new Date();
        const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
        const savedWeek = await this.getStateAsync('info.weekKey');
        const weekKey = monday.toISOString().slice(0, 10);
        if (!savedWeek || savedWeek.val !== weekKey) {
            this.weekStartTotal = totalHours;
            await this.setObjectNotExistsAsync('info.weekKey', { type: 'state', common: { name: 'Week key', type: 'string', role: 'value', read: true, write: false }, native: {} });
            await this.setObjectNotExistsAsync('info.weekStartTotalHours', { type: 'state', common: { name: 'Total time at week start', type: 'number', role: 'value', read: true, write: false, unit: 'h' }, native: {} });
            await this.setStateAsync('info.weekKey', weekKey, true);
            await this.setStateAsync('info.weekStartTotalHours', totalHours, true);
        } else {
            this.weekStartTotal = Number((await this.getStateAsync('info.weekStartTotalHours'))?.val) || totalHours;
        }
        const mowed = Math.max(0, (totalHours - this.weekStartTotal) * 60);
        const cal1 = await this.readValue(`${prefix}.calendar.calJson`, []);
        const cal2 = await this.readValue(`${prefix}.calendar.calJson2`, []);
        const planned = calc.calendarMinutes(cal1, cal2);
        const growth = Number(this.config.growthMmPerWeek) || 0;
        const zones = this.getZones();
        const target = calc.targetMinutes(zones, growth, Number(this.config.mowingSpeed), Number(this.config.referenceGrowthMm) || 3);
        const weather = await this.getWeather();
        const decision = weather.interventionAllowed
            ? calc.decide({ raining: weather.raining, tooWindy: weather.wind > Number(this.config.maxWind), tooCold: weather.temperature < Number(this.config.minTemperature), target, mowed, planned, minTime: this.config.minTime, blockedByQuota: this.blockedByQuota })
            : { extension: 0, blocked: false, reason: 'weather-unavailable-no-intervention' };
        this.blockedByQuota = decision.reason === 'weekly-target-reached' || decision.reason === 'quota-hysteresis';
        const sequence = calc.distributeZones(zones, growth, Number(this.config.sequenceLength) || 10);
        await this.setForeignStateAsync(`${prefix}.mower.mowTimeExtend`, decision.extension, false);
        if (sequence.length) await this.setForeignStateAsync(`${prefix}.areas.startSequence`, JSON.stringify(sequence), false);
        await Promise.all([
            this.setStateAsync('info.targetMinutes', Math.round(target), true), this.setStateAsync('info.mowedMinutes', Math.round(mowed), true),
            this.setStateAsync('info.remainingMinutes', Math.round(Math.max(0, target - mowed)), true), this.setStateAsync('info.extensionPercent', decision.extension, true),
            this.setStateAsync('info.reason', decision.reason, true), this.setStateAsync('info.zoneSequence', JSON.stringify(sequence), true), this.setStateAsync('control.recalculate', false, true)
            , this.setStateAsync('weather.source', weather.source, true), this.setStateAsync('weather.status', weather.status, true)
            , this.setStateAsync('weather.raining', Boolean(weather.raining), true), this.setStateAsync('weather.temperature', Number(weather.temperature), true), this.setStateAsync('weather.wind', Number(weather.wind), true)
        ]);
    }

    onUnload(callback) { try { if (this.timer) this.clearInterval(this.timer); callback(); } catch { callback(); } }
}
if (require.main !== module) module.exports = options => new Mowtime(options); else new Mowtime();
