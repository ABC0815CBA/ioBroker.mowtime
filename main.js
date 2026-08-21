'use strict';

const utils = require('@iobroker/adapter-core');
const { growthFactors, extensionForTarget, totalTimeDeltaMinutes, clamp } = require('./lib/model');
const { remainingCalendarMinutes, calendarPosition, weekKey } = require('./lib/calendar');
const { buildOpenMeteoUrl, parseOpenMeteo } = require('./lib/openmeteo');
const { rainLockEnabled, growthWeatherAdjustmentEnabled, sourceFor, neutralWeather, weatherControlValue } = require('./lib/sources');
const { normalizeSoilType, soilWaterBalance } = require('./lib/soil');

class WorxMowtime extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mowtime' });
        this.timer = null;
        this.lastTotalTime = null;
        this.lastEvaluation = 0;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.createObjects();
        await this.ensureWeek();
        // A configuration save restarts the instance. Recalculate once in the
        // current gap so source and enable/disable changes take effect at once.
        await this.setStateAsync('internal.lastCalculationGap', '', true);
        const interval = Math.max(1, Number(this.config.pollMinutes) || 5) * 60000;
        await this.evaluate();
        this.timer = this.setInterval(() => this.evaluate().catch(error => this.log.error(error.stack || error)), interval);
    }

    async createObjects() {
        const state = async (id, name, type, role, unit, def = null) => this.setObjectNotExistsAsync(id, {
            type: 'state', common: { name, type, role, read: true, write: false, ...(unit ? { unit } : {}), ...(def !== null ? { def } : {}) }, native: {}
        });
        await state('control.mowTimeExtended', 'Calculated mowing time extension', 'number', 'value', '%', 0);
        await state('Worx.MOwTimeExtended', 'Worx mowing time extension output', 'number', 'value', '%', 0);
        await state('control.reason', 'Control reason', 'string', 'text', null, 'initializing');
        await state('rain.delta', 'Rain change in evaluation interval', 'number', 'value', 'mm', 0);
        await state('rain.locked', 'Rain lock active', 'boolean', 'indicator', null, false);
        await state('rain.lastRain', 'Last detected rain', 'number', 'date', null, 0);
        await state('weather.temperature30d', 'Rolling temperature mean', 'number', 'value.temperature', '°C', 0);
        await state('weather.moisture30d', 'Rolling soil moisture mean', 'number', 'value.humidity', '%', 0);
        await state('weather.light30d', 'Rolling light mean', 'number', 'value.brightness', 'lx', 0);
        await state('weather.source', 'Active weather source', 'string', 'text', null, 'states');
        await state('weather.onlineLastSuccess', 'Last successful online weather update', 'number', 'date', null, 0);
        await state('weather.onlineError', 'Online weather error', 'string', 'text', null, '');
        await state('internal.samples', 'Rolling weather samples', 'string', 'json', null, '[]');
        await state('internal.onlineSnapshot', 'Cached Open-Meteo snapshot', 'string', 'json', null, '');
        await state('internal.lastOnlineRainTimestamp', 'Last processed Open-Meteo rain timestamp', 'number', 'date', null, 0);
        await state('internal.lastRainValue', 'Previous cumulative rainfall', 'number', 'value', 'mm', -1);
        await state('internal.week', 'ISO week', 'string', 'text', null, '');
        await state('internal.lastTotalTime', 'Previous totalTime value', 'number', 'value.interval', 'h', 0);
        await this.extendObjectAsync('internal.lastTotalTime', { common: { unit: 'h' } });
        await state('internal.lastCalculationGap', 'Last calculated calendar gap', 'string', 'text', null, '');
        await state('internal.plannedExtension', 'Planned extension without rain override', 'number', 'value', '%', 0);
        await state('internal.plannedReason', 'Planned control reason', 'string', 'text', null, 'initializing');
        for (let zone = 1; zone <= 4; zone++) {
            await state(`zones.${zone}.temperatureFactor`, `Zone ${zone} temperature factor`, 'number', 'value', null, 0);
            await state(`zones.${zone}.moistureFactor`, `Zone ${zone} moisture factor`, 'number', 'value', null, 0);
            await state(`zones.${zone}.lightFactor`, `Zone ${zone} light factor`, 'number', 'value', null, 0);
            await state(`zones.${zone}.soilFactor`, `Zone ${zone} soil quality factor`, 'number', 'value', null, 1);
            await state(`zones.${zone}.soilType`, `Zone ${zone} soil type`, 'string', 'text', null, 'loam');
            await state(`zones.${zone}.waterStorageMm`, `Zone ${zone} calculated soil water storage`, 'number', 'value', 'mm', 0);
            await state(`zones.${zone}.waterCapacityMm`, `Zone ${zone} soil water capacity`, 'number', 'value', 'mm', 0);
            await state(`zones.${zone}.growthMultiplier`, `Zone ${zone} total growth multiplier`, 'number', 'value', null, 0);
            await state(`zones.${zone}.growthPercent`, `Zone ${zone} growth adjustment`, 'number', 'value', '%', 0);
            await state(`zones.${zone}.targetMinutes`, `Zone ${zone} target this week`, 'number', 'value.interval', 'min', 0);
            await state(`zones.${zone}.actualMinutes`, `Zone ${zone} mowed this week`, 'number', 'value.interval', 'min', 0);
            await state(`zones.${zone}.remainingMinutes`, `Zone ${zone} remaining target`, 'number', 'value.interval', 'min', 0);
        }
    }

    async getForeignNumber(id) {
        if (!id) return NaN;
        const state = await this.getForeignStateAsync(id);
        return state ? Number(state.val) : NaN;
    }

    async getForeignValue(id) {
        if (!id) return null;
        const state = await this.getForeignStateAsync(id);
        return state ? state.val : null;
    }

    sourceFor(kind) {
        return sourceFor(this.config, kind);
    }

    async ensureWeek() {
        const key = weekKey();
        const stored = await this.getStateAsync('internal.week');
        if (stored?.val === key) return;
        for (let zone = 1; zone <= 4; zone++) await this.setStateAsync(`zones.${zone}.actualMinutes`, 0, true);
        await this.setStateAsync('internal.week', key, true);
        await this.setStateAsync('internal.lastCalculationGap', '', true);
        const total = await this.getForeignNumber(this.config.totalTimeStateId);
        if (Number.isFinite(total)) await this.setStateAsync('internal.lastTotalTime', total, true);
    }

    async updateActualTimes() {
        const total = await this.getForeignNumber(this.config.totalTimeStateId);
        if (!Number.isFinite(total)) return;
        const previousState = await this.getStateAsync('internal.lastTotalTime');
        const previous = Number(previousState?.val);
        await this.setStateAsync('internal.lastTotalTime', total, true);
        if (!Number.isFinite(previous) || total <= previous) return;
        const status = String(await this.getForeignValue(this.config.statusStateId)).toLowerCase();
        const mowing = String(this.config.mowingStatusValues || '').split(',').map(x => x.trim().toLowerCase()).includes(status);
        const zone = Math.trunc(await this.getForeignNumber(this.config.zoneStateId));
        if (!mowing || zone < 1 || zone > 4) return;
        const current = Number((await this.getStateAsync(`zones.${zone}.actualMinutes`))?.val) || 0;
        await this.setStateAsync(`zones.${zone}.actualMinutes`, current + totalTimeDeltaMinutes(total, previous), true);
    }

    async updateLocalWeather() {
        const now = Date.now();
        const temperature = await this.getForeignNumber(this.config.temperatureStateId);
        const moisture = await this.getForeignNumber(this.config.moistureStateId);
        const light = await this.getForeignNumber(this.config.lightStateId);
        const stored = await this.getStateAsync('internal.samples');
        let samples = [];
        try { samples = JSON.parse(stored?.val || '[]'); } catch { /* reset corrupt history */ }
        const sample = { ts: now };
        if (Number.isFinite(temperature)) sample.temperature = temperature;
        if (Number.isFinite(moisture)) sample.moisture = moisture;
        if (Number.isFinite(light)) sample.light = light;
        if (Object.keys(sample).length > 1) samples.push(sample);
        samples = samples.filter(sample => sample.ts >= now - 30 * 86400000).slice(-9000);
        await this.setStateAsync('internal.samples', JSON.stringify(samples), true);
        const average = key => {
            const values = samples.map(item => Number(item[key])).filter(Number.isFinite);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
        };
        const weather = { temperature: average('temperature'), moisture: average('moisture'), light: average('light') };
        if (Number.isFinite(weather.temperature)) await this.setStateAsync('weather.temperature30d', weather.temperature, true);
        if (Number.isFinite(weather.moisture)) await this.setStateAsync('weather.moisture30d', weather.moisture, true);
        if (Number.isFinite(weather.light)) await this.setStateAsync('weather.light30d', weather.light, true);
        return weather;
    }

    async updateOnlineWeather() {
        const lastSuccess = Number((await this.getStateAsync('weather.onlineLastSuccess'))?.val) || 0;
        const updateMs = Math.max(15, Number(this.config.onlineUpdateMinutes) || 60) * 60000;
        const cachedState = await this.getStateAsync('internal.onlineSnapshot');
        if (lastSuccess && Date.now() - lastSuccess < updateMs && cachedState?.val) {
            try { return JSON.parse(cachedState.val); } catch { /* fetch a fresh snapshot */ }
        }
        const latitude = Number(this.config.latitude);
        const longitude = Number(this.config.longitude);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            throw new Error('Open-Meteo latitude or longitude is invalid');
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            let response;
            try {
                response = await fetch(buildOpenMeteoUrl(latitude, longitude), { signal: controller.signal });
            } finally {
                clearTimeout(timeout);
            }
            if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
            const snapshot = { ...parseOpenMeteo(await response.json()), fetchedAt: Date.now() };
            await this.setStateAsync('internal.onlineSnapshot', JSON.stringify(snapshot), true);
            await this.setStateAsync('weather.onlineLastSuccess', Date.now(), true);
            await this.setStateAsync('weather.onlineError', '', true);
            return snapshot;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.setStateAsync('weather.onlineError', message, true);
            this.log.warn(`Open-Meteo update failed: ${message}`);
            if (cachedState?.val) {
                try { return JSON.parse(cachedState.val); } catch { /* report original error */ }
            }
            throw error;
        }
    }

    async updateWeather() {
        const rainEnabled = rainLockEnabled(this.config);
        const growthEnabled = growthWeatherAdjustmentEnabled(this.config);
        const sources = {
            rain: this.sourceFor('rain'),
            temperature: this.sourceFor('temperature'),
            moisture: this.sourceFor('moisture'),
            light: this.sourceFor('light')
        };
        const needsOnline = (rainEnabled && sources.rain === 'openmeteo') || (growthEnabled && ['temperature', 'moisture', 'light'].some(kind => sources[kind] === 'openmeteo'));
        const needsLocalGrowth = growthEnabled && ['temperature', 'moisture', 'light'].some(kind => sources[kind] === 'states');
        const [onlineWeather, localWeather] = await Promise.all([
            needsOnline ? this.updateOnlineWeather() : Promise.resolve({}),
            needsLocalGrowth ? this.updateLocalWeather() : Promise.resolve({})
        ]);
        const weather = growthEnabled ? {
            temperature: sources.temperature === 'openmeteo' ? onlineWeather.temperature : localWeather.temperature,
            moisture: sources.moisture === 'openmeteo' ? onlineWeather.moisture : localWeather.moisture,
            light: sources.light === 'openmeteo' ? onlineWeather.light : localWeather.light
        } : neutralWeather(this.config);
        weather.precipitation = rainEnabled && sources.rain === 'openmeteo' ? onlineWeather.precipitation : NaN;
        weather.fetchedAt = rainEnabled && sources.rain === 'openmeteo' ? onlineWeather.fetchedAt : 0;
        weather.precipitationHistory = growthEnabled && sources.moisture === 'openmeteo' ? onlineWeather.precipitationHistory : [];
        weather.et0History = growthEnabled && sources.moisture === 'openmeteo' ? onlineWeather.et0History : [];
        const sourceStatus = [
            `rain=${rainEnabled ? sources.rain : 'disabled'}`,
            `temperature=${growthEnabled ? sources.temperature : 'neutral'}`,
            `moisture=${growthEnabled ? sources.moisture : 'neutral'}`,
            `light=${growthEnabled ? sources.light : 'neutral'}`
        ].join(',');
        await this.setStateAsync('weather.source', sourceStatus, true);
        if (growthEnabled && ![weather.temperature, weather.moisture, weather.light].every(Number.isFinite)) {
            throw new Error('At least one selected growth weather source has no usable value');
        }
        if (Number.isFinite(weather.temperature)) await this.setStateAsync('weather.temperature30d', weather.temperature, true);
        if (Number.isFinite(weather.moisture)) await this.setStateAsync('weather.moisture30d', weather.moisture, true);
        if (Number.isFinite(weather.light)) await this.setStateAsync('weather.light30d', weather.light, true);
        return weather;
    }

    async updateRain(onlinePrecipitation = NaN, onlineTimestamp = 0) {
        if (!rainLockEnabled(this.config)) {
            await this.setStateAsync('rain.delta', 0, true);
            await this.setStateAsync('rain.locked', false, true);
            await this.setStateAsync('rain.lastRain', 0, true);
            return false;
        }
        const online = this.sourceFor('rain') === 'openmeteo';
        const current = online ? Number(onlinePrecipitation) : await this.getForeignNumber(this.config.rainStateId);
        const previousState = await this.getStateAsync('internal.lastRainValue');
        const previous = Number(previousState?.val);
        const lastOnlineTimestamp = Number((await this.getStateAsync('internal.lastOnlineRainTimestamp'))?.val) || 0;
        const isNewOnlineValue = online && Number(onlineTimestamp) > lastOnlineTimestamp;
        const delta = online ? isNewOnlineValue ? Math.max(0, current || 0) : 0 : Number.isFinite(current) && Number.isFinite(previous) && previous >= 0 ? Math.max(0, current - previous) : 0;
        if (isNewOnlineValue) await this.setStateAsync('internal.lastOnlineRainTimestamp', Number(onlineTimestamp), true);
        if (!online && Number.isFinite(current)) await this.setStateAsync('internal.lastRainValue', current, true);
        await this.setStateAsync('rain.delta', delta, true);
        const threshold = Math.max(0, Number(this.config.rainThresholdMm) || 0.1);
        const wasLocked = Boolean((await this.getStateAsync('rain.locked'))?.val);
        // A rain event starts above the threshold. Once locked, every non-zero
        // increment restarts the configured uninterrupted dry period.
        if (delta > threshold || (wasLocked && delta > 0)) await this.setStateAsync('rain.lastRain', Date.now(), true);
        const lastRain = Number((await this.getStateAsync('rain.lastRain'))?.val) || 0;
        const locked = lastRain > 0 && Date.now() - lastRain < Math.max(0, Number(this.config.rainDryHours) || 3) * 3600000;
        await this.setStateAsync('rain.locked', locked, true);
        return locked;
    }

    async evaluate() {
        if (this.lastEvaluation && Date.now() - this.lastEvaluation < 1000) return;
        this.lastEvaluation = Date.now();
        await this.ensureWeek();
        await this.updateActualTimes();
        let weather;
        try {
            weather = await this.updateWeather();
        } catch (error) {
            this.log.error(`No usable weather data: ${error instanceof Error ? error.message : error}`);
            await this.writeOutputIfChanged(-100, 'weather unavailable');
            return;
        }
        const [rainLocked, calendar1, calendar2] = await Promise.all([
            this.updateRain(weather.precipitation, weather.fetchedAt), this.getForeignValue(this.config.calendarStateId), this.getForeignValue(this.config.calendar2StateId)
        ]);
        const calendars = [calendar1, calendar2];
        const position = calendarPosition(calendars);
        const lastGap = String((await this.getStateAsync('internal.lastCalculationGap'))?.val || '');
        const growthEnabled = growthWeatherAdjustmentEnabled(this.config);

        // The normal target is recalculated exactly once in every gap between
        // mowing windows. Rain remains an immediate safety override.
        if (!position.active && position.gapKey !== lastGap) {
            await this.calculatePlan(weather, calendars, position.gapKey);
        }

        if (rainLocked) {
            await this.writeOutputIfChanged(weatherControlValue(true, growthEnabled, 0), 'rain lock');
        } else if (!growthEnabled) {
            await this.writeOutputIfChanged(weatherControlValue(false, false, 0), 'weather adjustment disabled');
        } else if (!position.active) {
            const planned = Number((await this.getStateAsync('internal.plannedExtension'))?.val) || 0;
            const reason = String((await this.getStateAsync('internal.plannedReason'))?.val || 'calendar gap calculation');
            await this.writeOutputIfChanged(weatherControlValue(false, true, planned), reason);
        }
    }

    async calculatePlan(weather, calendars, gapKey) {
        const scheduled = remainingCalendarMinutes(calendars);
        let totalTarget = 0;
        let totalActual = 0;
        for (let zone = 1; zone <= 4; zone++) {
            const soilType = normalizeSoilType(this.config[`zone${zone}Soil`]);
            const useWaterBalance = growthWeatherAdjustmentEnabled(this.config) && this.sourceFor('moisture') === 'openmeteo';
            const water = useWaterBalance ? soilWaterBalance(weather.precipitationHistory, weather.et0History, soilType) : null;
            // Soil type affects growth through water storage, never as a direct
            // zero-to-two multiplier. A local moisture sensor already measures
            // this outcome and therefore uses the configured moisture curve.
            const factors = growthFactors(weather, 1, this.config, water?.factor);
            const target = Math.max(0, Number(this.config[`zone${zone}Minutes`]) || 0) * factors.multiplier;
            const actual = Number((await this.getStateAsync(`zones.${zone}.actualMinutes`))?.val) || 0;
            await Promise.all([
                this.setStateAsync(`zones.${zone}.temperatureFactor`, factors.temperature, true),
                this.setStateAsync(`zones.${zone}.moistureFactor`, factors.moisture, true),
                this.setStateAsync(`zones.${zone}.lightFactor`, factors.light, true),
                this.setStateAsync(`zones.${zone}.soilFactor`, factors.soil, true),
                this.setStateAsync(`zones.${zone}.soilType`, soilType, true),
                this.setStateAsync(`zones.${zone}.waterStorageMm`, water?.storageMm || 0, true),
                this.setStateAsync(`zones.${zone}.waterCapacityMm`, water?.capacityMm || 0, true),
                this.setStateAsync(`zones.${zone}.growthMultiplier`, factors.multiplier, true),
                this.setStateAsync(`zones.${zone}.growthPercent`, factors.percent, true),
                this.setStateAsync(`zones.${zone}.targetMinutes`, target, true),
                this.setStateAsync(`zones.${zone}.remainingMinutes`, Math.max(0, target - actual), true)
            ]);
            totalTarget += target;
            totalActual += actual;
        }
        const extension = extensionForTarget(totalTarget, totalActual, scheduled);
        const reason = totalActual >= totalTarget ? 'weekly target reached' : scheduled <= 0 ? 'target deficit, no scheduled time remaining' : 'adapting remaining schedule to target';
        await this.setStateAsync('internal.plannedExtension', extension, true);
        await this.setStateAsync('internal.plannedReason', reason, true);
        await this.setStateAsync('internal.lastCalculationGap', gapKey, true);
    }

    async writeOutputIfChanged(extension, reason) {
        const value = clamp(extension, -100, 100);
        const local = await this.getStateAsync('Worx.MOwTimeExtended');
        if (Number(local?.val) !== value) {
            await this.setStateAsync('control.mowTimeExtended', value, true);
            await this.setStateAsync('Worx.MOwTimeExtended', value, true);
        }
        await this.setStateAsync('control.reason', reason, true);
        if (!this.config.mowTimeExtendedStateId) return;
        const foreign = await this.getForeignStateAsync(this.config.mowTimeExtendedStateId);
        if (Number(foreign?.val) !== value) {
            await this.setForeignStateAsync(this.config.mowTimeExtendedStateId, value, false);
            this.log.info(`Worx MowTimeExtended changed to ${value}% (${reason})`);
        }
    }

    onUnload(callback) {
        try { if (this.timer) this.clearInterval(this.timer); callback(); } catch { callback(); }
    }
}

if (require.main !== module) module.exports = options => new WorxMowtime(options);
else new WorxMowtime();
