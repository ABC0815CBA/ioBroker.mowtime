'use strict';

function number(value, name) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`Missing or invalid weather value: ${name}`);
    return result;
}

function parseOpenMeteo(data, rainThreshold = 0.1) {
    if (!data || !data.current) throw new Error('Open-Meteo response has no current weather');
    const current = data.current;
    const precipitation = number(current.precipitation, 'precipitation');
    const daily = data.daily && Array.isArray(data.daily.time) ? data.daily.time.map((date, i) => ({
        date,
        temperatureMean: Number(data.daily.temperature_2m_mean?.[i]),
        precipitation: Number(data.daily.precipitation_sum?.[i]) || 0,
        sunshineHours: (Number(data.daily.sunshine_duration?.[i]) || 0) / 3600
        , et0: Number(data.daily.et0_fao_evapotranspiration?.[i]) || 0
    })) : [];
    // Open-Meteo's current precipitation is the preceding-hour sum.
    const rain10Minutes = precipitation / 6;
    return {
        raining: rain10Minutes > rainThreshold,
        precipitation: rain10Minutes,
        rain10Minutes,
        rainToday: daily.at(-1)?.precipitation || 0,
        wind: number(current.wind_speed_10m, 'wind_speed_10m'),
        temperature: number(current.temperature_2m, 'temperature_2m'),
        sunshineHours: daily.at(-1)?.sunshineHours || 0,
        daily
    };
}

function parseBrightSky(data, rainThreshold = 0.1) {
    const current = data && (data.weather || data.current_weather);
    if (!current) throw new Error('Bright Sky response has no current weather');
    const precipitation = number(current.precipitation ?? 0, 'precipitation');
    return {
        raining: precipitation > rainThreshold,
        precipitation,
        rain10Minutes: precipitation,
        rainToday: Number(current.precipitation_24h ?? current.precipitation_today) || 0,
        wind: number(current.wind_speed, 'wind_speed'),
        temperature: number(current.temperature, 'temperature'),
        sunshineHours: Number(current.sunshine) ? Number(current.sunshine) / 60 : 0,
        daily: []
    };
}

async function getJson(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ioBroker.mowtime/0.4.1' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchWeather(provider, latitude, longitude, rainThreshold, fetchJson = getJson) {
    const lat = number(latitude, 'latitude');
    const lon = number(longitude, 'longitude');
    if (provider === 'openmeteo') {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,precipitation,rain,wind_speed_10m&daily=temperature_2m_mean,precipitation_sum,sunshine_duration,et0_fao_evapotranspiration&past_days=7&forecast_days=1&timezone=auto`;
        return parseOpenMeteo(await fetchJson(url), rainThreshold);
    }
    if (provider === 'brightsky') {
        const url = `https://api.brightsky.dev/current_weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
        return parseBrightSky(await fetchJson(url), rainThreshold);
    }
    throw new Error(`Unsupported weather provider: ${provider}`);
}

module.exports = { parseOpenMeteo, parseBrightSky, fetchWeather };
