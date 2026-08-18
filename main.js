'use strict';
const utils = require('@iobroker/adapter-core');
const calc = require('./lib/calculation');
const weatherApi = require('./lib/weather');
const patchModel = require('./lib/patch-model');
const dailyPlanner = require('./lib/daily-planner');

class Mowtime extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mowtime' });
        this.timer = null;
        this.weekStartTotal = null;
        this.weatherCache = null;
        this.zoneTracking = Promise.resolve();
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

    async getPatches() {
        const configured = Array.isArray(this.config.patches) ? this.config.patches : [];
        const source = configured.length ? configured : this.getZones().filter(zone => zone.area > 0).map(zone => ({
            name: `Zone ${zone.id}`, enabled: zone.active, mowerZone: zone.id, area: zone.area,
            soil: patchModel.legacySoil(zone.soil), shade: zone.shade, fertilityFactor: 1,
            rainFactor: 1, rootDepthCm: 15, growthStartMm: this.config.growthStartMm,
            minMowingMinutes: 0
        }));
        for (const patch of source) {
            patch.moisturePercent = patch.moistureState ? Number(await this.readValue(patch.moistureState, NaN)) : NaN;
            patch.ownRainMm = patch.rainMode === 'own' && patch.rainState ? Number(await this.readValue(patch.rainState, 0)) : NaN;
        }
        return source;
    }

    async createStates() {
        const states = {
            'info.targetMinutes': ['number', 'min'], 'info.mowedMinutes': ['number', 'min'],
            'info.remainingMinutes': ['number', 'min'], 'info.extensionPercent': ['number', '%'],
            'info.reason': ['string', ''], 'info.zoneSequence': ['string', ''],
            'weather.source': ['string', ''], 'weather.status': ['string', ''],
            'weather.lastSuccess': ['number', ''], 'weather.raining': ['boolean', ''],
            'weather.rainToday': ['number', 'mm'], 'weather.rain10Minutes': ['number', 'mm'],
            'weather.temperature': ['number', '°C'], 'weather.wind': ['number', 'km/h'],
            'weather.sunshineHours': ['number', 'h'], 'history.last7Days': ['string', ''],
            'growth.simulatedMm': ['number', 'mm'],
            'accounting.date': ['string', ''], 'accounting.startTotalHours': ['number', 'h'],
            'accounting.carryByZone': ['string', ''], 'accounting.settled': ['boolean', ''],
            'accounting.actualByZone': ['string', ''], 'accounting.lastTotalHours': ['number', 'h'],
            'accounting.lastAreaIndicator': ['number', ''],
            'history.records': ['string', ''],
            'control.recalculate': ['boolean', '']
        };
        for (const [id, [type, unit]] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: id, type, role: id === 'control.recalculate' ? 'button' : 'value', read: true, write: id === 'control.recalculate', unit: unit || undefined }, native: {} });
        }
    }

    async trackZoneRuntime(totalHours, currentIndicator) {
        let actualByZone;
        try { actualByZone = JSON.parse(String((await this.getStateAsync('accounting.actualByZone'))?.val || '[0,0,0,0]')); } catch { actualByZone = [0, 0, 0, 0]; }
        if (!Array.isArray(actualByZone) || actualByZone.length !== 4) actualByZone = [0, 0, 0, 0];
        const previousTotal = Number((await this.getStateAsync('accounting.lastTotalHours'))?.val);
        const previousZone = Number((await this.getStateAsync('accounting.lastAreaIndicator'))?.val);
        const elapsedMinutes = Number.isFinite(previousTotal) ? Math.max(0, (totalHours - previousTotal) * 60) : 0;
        if (elapsedMinutes > 0 && Number.isInteger(previousZone) && previousZone >= 0 && previousZone < 4) {
            actualByZone[previousZone] = (Number(actualByZone[previousZone]) || 0) + elapsedMinutes;
        }
        const nextZone = Number(currentIndicator);
        await this.setStateAsync('accounting.actualByZone', JSON.stringify(actualByZone), true);
        await this.setStateAsync('accounting.lastTotalHours', totalHours, true);
        if (Number.isInteger(nextZone) && nextZone >= 0 && nextZone < 4) await this.setStateAsync('accounting.lastAreaIndicator', nextZone, true);
        return actualByZone;
    }

    async publishReadableHistory(records) {
        for (let day = 0; day < 7; day++) {
            const record = records[day] || {};
            for (let zone = 0; zone < 4; zone++) {
                const prefix = `history.day${day}.zone${zone}`;
                const values = {
                    date: record.date || '', targetMinutes: Number(record.targetByZone?.[zone]) || 0,
                    actualMinutes: Number(record.actualByZone?.[zone]) || 0,
                    carryMinutes: Number(record.carryByZone?.[zone]) || 0,
                    patchResults: JSON.stringify((record.patches || []).filter(p => Number(p.mowerZone) === zone).map(p => ({ name: p.name, growthMm: p.remainingGrowthMm, targetMinutes: p.demandMinutes, soilWaterMm: p.soilWaterMm })))
                };
                for (const [name, value] of Object.entries(values)) {
                    const type = typeof value === 'number' ? 'number' : 'string';
                    const unit = name.toLowerCase().includes('minutes') ? 'min' : undefined;
                    await this.setObjectNotExistsAsync(`${prefix}.${name}`, { type: 'state', common: { name: `${prefix} ${name}`, type, role: 'value', read: true, write: false, unit }, native: {} });
                    await this.setStateAsync(`${prefix}.${name}`, value, true);
                }
            }
        }
    }

    async getWeather() {
        const legacyMode = this.config.weatherMode || 'sensors';
        const provider = this.config.weatherProvider || (legacyMode === 'brightsky' ? 'brightsky' : 'openmeteo');
        const defaultSource = legacyMode === 'sensors' ? 'state' : 'online';
        const rainSource = this.config.rainSource || defaultSource;
        const windSource = this.config.windSource || defaultSource;
        const temperatureSource = this.config.temperatureSource || defaultSource;
        const sunshineSource = this.config.sunshineSource || defaultSource;
        const onlineNeeded = [rainSource, windSource, temperatureSource, sunshineSource].includes('online');
        if (!onlineNeeded) {
            const rainValue = await this.readValue(this.config.rainState, false);
            const numericRain = typeof rainValue === 'number' ? rainValue : (rainValue ? Number(this.config.rainThreshold) || 0.1 : 0);
            const raining = typeof rainValue === 'number' ? numericRain > (Number(this.config.rainThreshold) || 0.1) : Boolean(rainValue);
            const rainToday = Number(await this.readValue(this.config.rainTodayState, 0)) || 0;
            const temperature = Number(await this.readValue(this.config.temperatureState, 20));
            const sunshineHours = Number(await this.readValue(this.config.sunshineState, 0));
            const et0 = Number(await this.readValue(this.config.et0State, 0));
            let daily = [];
            try {
                daily = JSON.parse(String((await this.getStateAsync('history.last7Days'))?.val || '{}')).weather || [];
            } catch { daily = []; }
            const today = new Date().toISOString().slice(0, 10);
            daily = daily.filter(day => day && day.date !== today).slice(-6);
            daily.push({ date: today, temperatureMean: temperature, precipitation: rainToday, sunshineHours, et0 });
            return {
                interventionAllowed: true,
                raining,
                precipitation: numericRain,
                rain10Minutes: numericRain,
                rainToday,
                wind: Number(await this.readValue(this.config.windState, 0)),
                temperature,
                sunshineHours, daily,
                source: 'sensors', status: 'ok'
            };
        }
        const now = Date.now();
        const pollMs = 15 * 60000;
        if (!this.weatherCache || now - this.weatherCache.lastAttempt >= pollMs) {
            try {
                const configuredThreshold = Number(this.config.rainThreshold);
                const rainThreshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 0.1;
                const values = await weatherApi.fetchWeather(provider, this.config.latitude, this.config.longitude, rainThreshold);
                this.weatherCache = { ...values, lastAttempt: now, lastSuccess: now };
                await this.setStateAsync('weather.lastSuccess', now, true);
            } catch (error) {
                this.log.warn(`Weather request (${provider}) failed: ${error.message}`);
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
        const result = { ...this.weatherCache, interventionAllowed: !stale, source: provider, status: stale ? 'stale-neutral-0%' : (this.weatherCache.lastSuccess === this.weatherCache.lastAttempt ? 'ok' : 'cached-after-error') };
        const threshold = Number(this.config.rainThreshold) || 0.1;
        if (rainSource === 'state') {
            const value = await this.readValue(this.config.rainState, false);
            result.precipitation = typeof value === 'number' ? value : (value ? threshold : 0);
            result.rain10Minutes = result.precipitation;
            result.rainToday = Number(await this.readValue(this.config.rainTodayState, 0)) || 0;
            result.raining = typeof value === 'number' ? result.precipitation > threshold : Boolean(value);
        }
        if (windSource === 'state') result.wind = Number(await this.readValue(this.config.windState, 0));
        if (temperatureSource === 'state') result.temperature = Number(await this.readValue(this.config.temperatureState, 20));
        if (sunshineSource === 'state') result.sunshineHours = Number(await this.readValue(this.config.sunshineState, 0));
        return result;
    }

    async onReady() {
        await this.createStates();
        this.subscribeStates('control.recalculate');
        if (this.config.worxPrefix) this.subscribeForeignStates(`${this.config.worxPrefix}.areas.actualAreaIndicator`);
        this.on('stateChange', (id, state) => {
            if (id.endsWith('control.recalculate') && state && !state.ack) this.run().catch(e => this.log.error(e.stack || e.message));
            if (id === `${this.config.worxPrefix}.areas.actualAreaIndicator` && state) {
                this.zoneTracking = this.zoneTracking.then(async () => {
                    const total = Number(await this.readValue(`${this.config.worxPrefix}.mower.totalTime`, 0));
                    await this.trackZoneRuntime(total, state.val);
                }).catch(e => this.log.warn(`Could not track zone runtime: ${e.message}`));
            }
        });
        await this.run();
        this.timer = this.setInterval(() => this.run().catch(e => this.log.error(e.stack || e.message)), Math.max(1, Number(this.config.intervalMinutes) || 5) * 60000);
    }

    async run() {
        const prefix = this.config.worxPrefix;
        if (!prefix) { this.log.warn('Worx prefix is not configured'); return; }
        const totalHours = Number(await this.readValue(`${prefix}.mower.totalTime`, 0));
        const actualAreaIndicator = await this.readValue(`${prefix}.areas.actualAreaIndicator`, -1);
        await this.zoneTracking;
        const trackedActualByZone = await this.trackZoneRuntime(totalHours, actualAreaIndicator);
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
        const cal1 = await this.readValue(`${prefix}.calendar.calJson`, []);
        const cal2 = await this.readValue(`${prefix}.calendar.calJson2`, []);
        const plannedWeek = calc.calendarMinutes(cal1, cal2);
        const baseGrowth = Number(this.config.growthMmPerWeek) || 0;
        const weather = await this.getWeather();
        const patches = await this.getPatches();
        const patchRainDetected = patches.some(patch => Number.isFinite(patch.ownRainMm) && patch.ownRainMm > (Number(this.config.rainThreshold) || 0.1));
        const patchResults = [];
        const simulations = patches.map(patch => {
            const days = (weather.daily || []).map(day => ({ ...day }));
            if (Number.isFinite(patch.ownRainMm) && days.length) days[days.length - 1].precipitation = patch.ownRainMm;
            return patchModel.simulatePatch({ ...patch, mowingSpeed: this.config.mowingSpeed }, days, baseGrowth);
        });
        for (let i = 0; i < patches.length; i++) {
            const patch = patches[i];
            const result = simulations[i];
            const remainingMm = result.growthMm;
            const safeId = String(patch.name || `patch${i}`).replace(/[^a-zA-Z0-9_-]/g, '_');
            const activeState = `patches.${safeId}.active`;
            await this.setObjectNotExistsAsync(activeState, { type: 'state', common: { name: `Patch ${patch.name} active`, type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });
            const startMm = Number(patch.growthStartMm ?? this.config.growthStartMm);
            const remainingDemandMinutes = result.demandMinutes;
            const active = patch.enabled !== false && remainingMm >= startMm;
            const dailyDemandMinutes = active ? remainingDemandMinutes : 0;
            const values = { ...patch, ...result, demandMinutes: dailyDemandMinutes, remainingGrowthMm: remainingMm, active };
            patchResults.push(values);
            await this.setStateAsync(activeState, active, true);
            for (const [suffix, value, unit] of [['growthMm', remainingMm, 'mm'], ['soilWaterMm', result.soilWaterMm, 'mm'], ['demandMinutes', dailyDemandMinutes, 'min']]) {
                const id = `patches.${safeId}.${suffix}`;
                await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: `${patch.name} ${suffix}`, type: 'number', role: 'value', read: true, write: false, unit }, native: {} });
                await this.setStateAsync(id, value, true);
            }
        }
        const enabledZones = [0, 1, 2, 3].map(i => this.config[`zone${i}Active`] !== false);
        const zoneWeights = patchModel.aggregateZones(patchResults, enabledZones);
        const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        let accountDate = String((await this.getStateAsync('accounting.date'))?.val || '');
        let startTotal = Number((await this.getStateAsync('accounting.startTotalHours'))?.val);
        let settled = Boolean((await this.getStateAsync('accounting.settled'))?.val);
        let accountInitializedNow = false;
        let carryByZone;
        try { carryByZone = JSON.parse(String((await this.getStateAsync('accounting.carryByZone'))?.val || '[0,0,0,0]')); } catch { carryByZone = [0, 0, 0, 0]; }
        if (accountDate !== dateKey || !Number.isFinite(startTotal)) {
            accountInitializedNow = !accountDate || !Number.isFinite(startTotal);
            accountDate = dateKey; startTotal = totalHours; settled = false;
            await this.setStateAsync('accounting.date', dateKey, true);
            await this.setStateAsync('accounting.startTotalHours', startTotal, true);
            await this.setStateAsync('accounting.settled', false, true);
            await this.setStateAsync('accounting.actualByZone', '[0,0,0,0]', true);
        }
        if (accountInitializedNow && now.getHours() >= 23) {
            settled = true;
            await this.setStateAsync('accounting.settled', true, true);
        }
        const desiredByZoneToday = dailyPlanner.nextDemand(zoneWeights, carryByZone);
        const actualToday = Math.max(0, (totalHours - startTotal) * 60);
        if (now.getHours() >= 23 && !settled && !accountInitializedNow) {
            const closed = dailyPlanner.settleDay(desiredByZoneToday, trackedActualByZone);
            carryByZone = closed.carryByZone;
            let records;
            try { records = JSON.parse(String((await this.getStateAsync('history.records'))?.val || '[]')); } catch { records = []; }
            records.unshift({ date: dateKey, targetByZone: desiredByZoneToday, actualByZone: closed.actualByZone, carryByZone, actualAllocation: 'measured by Worx actualAreaIndicator', patches: patchResults });
            records = records.slice(0, 7);
            await this.setStateAsync('history.records', JSON.stringify(records), true);
            await this.setStateAsync('accounting.carryByZone', JSON.stringify(carryByZone), true);
            await this.setStateAsync('accounting.settled', true, true);
            await this.publishReadableHistory(records);
            settled = true;
        }
        const calculationDate = new Date(now);
        if (settled) calculationDate.setDate(calculationDate.getDate() + 1);
        const planned = calc.calendarDayMinutes(calculationDate, cal1, cal2);
        const desiredByZone = settled ? dailyPlanner.nextDemand(zoneWeights, carryByZone) : desiredByZoneToday;
        const targetDaily = desiredByZone.reduce((sum, value) => sum + value, 0);
        let decision;
        if (!weather.interventionAllowed) decision = { extension: 0, blocked: false, reason: 'weather-unavailable-no-intervention' };
        else if (weather.raining || patchRainDetected) decision = { extension: -100, blocked: true, reason: patchRainDetected ? 'rain-patch-sensor' : 'rain' };
        else if (weather.wind > Number(this.config.maxWind)) decision = { extension: -100, blocked: true, reason: 'wind' };
        else if (weather.temperature < Number(this.config.minTemperature)) decision = { extension: -100, blocked: true, reason: 'temperature' };
        else if (targetDaily < Math.max(0, Number(this.config.minTime) || 0)) decision = { extension: -100, blocked: true, reason: 'daily-demand-below-minimum' };
        else decision = { extension: dailyPlanner.extensionPercent(targetDaily, planned), blocked: false, reason: settled ? 'next-day-demand' : 'daily-demand' };
        const sequence = patchModel.sequenceFromWeights(desiredByZone, Number(this.config.sequenceLength) || 10);
        await this.setForeignStateAsync(`${prefix}.mower.mowTimeExtend`, decision.extension, false);
        if (sequence.length) await this.setForeignStateAsync(`${prefix}.areas.startSequence`, JSON.stringify(sequence), false);
        await Promise.all([
            this.setStateAsync('info.targetMinutes', Math.round(targetDaily), true), this.setStateAsync('info.mowedMinutes', Math.round(actualToday), true),
            this.setStateAsync('info.remainingMinutes', Math.round(Math.max(0, targetDaily - actualToday)), true), this.setStateAsync('info.extensionPercent', decision.extension, true),
            this.setStateAsync('info.reason', decision.reason, true), this.setStateAsync('info.zoneSequence', JSON.stringify(sequence), true), this.setStateAsync('control.recalculate', false, true)
            , this.setStateAsync('weather.source', weather.source, true), this.setStateAsync('weather.status', weather.status, true)
            , this.setStateAsync('weather.raining', Boolean(weather.raining), true), this.setStateAsync('weather.temperature', Number(weather.temperature), true), this.setStateAsync('weather.wind', Number(weather.wind), true)
            , this.setStateAsync('weather.rainToday', Number(weather.rainToday) || 0, true)
            , this.setStateAsync('weather.rain10Minutes', Number(weather.rain10Minutes ?? weather.precipitation) || 0, true)
            , this.setStateAsync('weather.sunshineHours', Number(weather.sunshineHours) || 0, true), this.setStateAsync('growth.simulatedMm', patchResults.length ? Math.max(...patchResults.map(p => p.growthMm)) : 0, true)
            , this.setStateAsync('history.last7Days', JSON.stringify({ updated: new Date().toISOString(), weather: weather.daily || [], patches: patchResults, zoneDemandMinutes: desiredByZone, plannedMinutes: planned, plannedWeekMinutes: plannedWeek }), true)
        ]);
    }

    onUnload(callback) { try { if (this.timer) this.clearInterval(this.timer); callback(); } catch { callback(); } }
}
if (require.main !== module) module.exports = options => new Mowtime(options); else new Mowtime();
