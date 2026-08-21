'use strict';

const RADIATION_TO_LUX = 126.7;

function buildOpenMeteoUrl(latitude, longitude) {
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'precipitation',
        hourly: 'temperature_2m,soil_moisture_0_to_1cm,shortwave_radiation',
        past_days: '30',
        forecast_days: '1',
        timezone: 'auto'
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function mean(values) {
    const valid = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : NaN;
}

function parseOpenMeteo(data) {
    const temperature = mean(data?.hourly?.temperature_2m);
    const moistureRaw = mean(data?.hourly?.soil_moisture_0_to_1cm);
    const radiation = mean(data?.hourly?.shortwave_radiation);
    const precipitation = Number(data?.current?.precipitation);
    if (![temperature, moistureRaw, radiation, precipitation].every(Number.isFinite)) {
        throw new Error('Open-Meteo response does not contain all required weather fields');
    }
    return {
        temperature,
        moisture: moistureRaw * 100,
        light: radiation * RADIATION_TO_LUX,
        precipitation: Math.max(0, precipitation)
    };
}

module.exports = { RADIATION_TO_LUX, buildOpenMeteoUrl, parseOpenMeteo };
