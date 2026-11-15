import { OVERPASS_MIRRORS, overpassQuery, parseOverpass, osmMapUrl, parseOsmMap } from '../public/geo.js';
// All external data sources. Each function returns small, clean JSON.
// Everything is fetched live for the chosen location, so results are always current.

const UA = 'FieldShift/1.0 (NASA Space Apps 2026 hackathon project)';
const timeout = ms => AbortSignal.timeout(ms);
const ymd = d => d.toISOString().slice(0, 10).replaceAll('-', '');

// ---------- NASA POWER: long-term monthly climate ----------
// [{year, month, temp, tempMax, rainMm}]
export async function getClimate(lat, lon) {
  const end = new Date().getFullYear() - 1; // last complete year
  const url = new URL('https://power.larc.nasa.gov/api/temporal/monthly/point');
  url.search = new URLSearchParams({
    parameters: 'T2M,T2M_MAX,PRECTOTCORR', community: 'AG',
    latitude: lat, longitude: lon, start: end - 24, end, format: 'JSON',
  });
  const res = await fetch(url, { signal: timeout(60000) });
  if (!res.ok) throw new Error(`NASA POWER monthly ${res.status}`);
  const p = (await res.json()).properties.parameter;

  const rows = [];
  for (const [key, temp] of Object.entries(p.T2M)) {
    const year = +key.slice(0, 4), month = +key.slice(4);
    const rain = p.PRECTOTCORR[key];
    if (month === 13 || temp == null || rain == null || temp <= -999 || rain <= -999) continue;
    const days = new Date(year, month, 0).getDate();
    rows.push({ year, month, temp, tempMax: p.T2M_MAX[key], rainMm: rain * days }); // mm/day -> mm/month
  }
  return rows;
}

// ---------- NASA POWER: last 12 months, daily ----------
// [{date: 'YYYY-MM-DD', temp, tempMax, rainMm}]
export async function getRecentWeather(lat, lon) {
  const end = new Date(Date.now() - 5 * 864e5);   // POWER has a few days of delay
  const start = new Date(end.getTime() - 365 * 864e5);
  const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
  url.search = new URLSearchParams({
    parameters: 'T2M,T2M_MAX,PRECTOTCORR', community: 'AG',
    latitude: lat, longitude: lon, start: ymd(start), end: ymd(end), format: 'JSON',
  });
  const res = await fetch(url, { signal: timeout(60000) });
  if (!res.ok) throw new Error(`NASA POWER daily ${res.status}`);
  const p = (await res.json()).properties.parameter;
  return Object.keys(p.T2M)
    .filter(k => p.T2M[k] > -999 && p.PRECTOTCORR[k] > -999)
    .map(k => ({ date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`, temp: p.T2M[k], tempMax: p.T2M_MAX[k], rainMm: p.PRECTOTCORR[k] }));
}

// ---------- ISRIC SoilGrids: soil properties ----------
const SOIL_DEFAULT = { clayPct: 25, sandPct: 35, siltPct: 40, socGKg: 12, ph: 6.8 };

export function describeSoil(s) {
  // plant-available water in the whole root zone (~1 m), rough values per texture
  let texture = 'Loam', awcMm = 160;
  if (s.sandPct > 60) { texture = 'Sandy'; awcMm = 80; }
  else if (s.clayPct > 40) { texture = 'Clay'; awcMm = 190; }
  return { ...s, texture, awcMm };
}
export const defaultSoil = () => ({ ...describeSoil({ ...SOIL_DEFAULT }), isDefault: true });

export async function getSoil(lat, lon) {
  const params = new URLSearchParams({ lat, lon, value: 'mean' });
  for (const p of ['clay', 'sand', 'silt', 'soc', 'phh2o']) params.append('property', p);
  for (const d of ['0-5cm', '5-15cm', '15-30cm']) params.append('depth', d);
  const res = await fetch(`https://rest.isric.org/soilgrids/v2.0/properties/query?${params}`, { signal: timeout(60000) });
  if (!res.ok) throw new Error(`SoilGrids ${res.status}`);

  const v = {};
  for (const layer of (await res.json()).properties.layers) {
    const nums = layer.depths.map(d => d.values.mean).filter(x => x != null);
    if (nums.length) v[layer.name] = nums.reduce((a, b) => a + b, 0) / nums.length / layer.unit_measure.d_factor;
  }
  if (!Object.keys(v).length) throw new Error('SoilGrids has no data here');
  return describeSoil({
    // after dividing by d_factor, clay/sand/silt are already in %, soc in g/kg, pH in pH units
    clayPct: v.clay ?? SOIL_DEFAULT.clayPct,
    sandPct: v.sand ?? SOIL_DEFAULT.sandPct,
    siltPct: v.silt ?? SOIL_DEFAULT.siltPct,
    socGKg: v.soc ?? SOIL_DEFAULT.socGKg,
    ph: v.phh2o ?? SOIL_DEFAULT.ph,
  });
}

// ---------- NASA SRTM elevation (via OpenTopoData): slope ----------
// Samples a 3x3 grid (~200 m apart) and returns elevation + steepest slope in %.
export async function getTerrain(lat, lon) {
  const d = 0.002, pts = [];
  for (const dy of [-d, 0, d]) for (const dx of [-d, 0, d]) pts.push([lat + dy, lon + dx]);
  const url = `https://api.opentopodata.org/v1/srtm30m?locations=${pts.map(p => p.join(',')).join('|')}`;
  const res = await fetch(url, { signal: timeout(30000), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Elevation ${res.status}`);
  const z = (await res.json()).results.map(r => r.elevation);
  if (z.some(v => v == null)) throw new Error('No elevation data here');

  const center = z[4];
  const dy = d * 111320, dx = d * 111320 * Math.cos(lat * Math.PI / 180);
  let maxSlope = 0;
  pts.forEach(([pLat, pLon], i) => {
    if (i === 4) return;
    const dist = Math.hypot((pLat - lat) / d * dy, (pLon - lon) / d * dx);
    maxSlope = Math.max(maxSlope, Math.abs(z[i] - center) / dist * 100);
  });
  return { elevationM: center, slopePct: maxSlope };
}

// ---------- ESA Sentinel-2 via Copernicus Sentinel Hub ----------
// 10-day averages for the last ~5 years: [{date, ndvi, savi, ndmi, bsi, bare, ndviStd}]
const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';

const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: ["B02", "B04", "B08", "B8A", "B11", "SCL", "dataMask"],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "savi", bands: 1, sampleType: "FLOAT32" },
      { id: "ndmi", bands: 1, sampleType: "FLOAT32" },
      { id: "bsi",  bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  let savi = 1.5 * (s.B08 - s.B04) / (s.B08 + s.B04 + 0.5);
  let ndmi = (s.B8A - s.B11) / (s.B8A + s.B11);
  let bsi  = ((s.B11 + s.B04) - (s.B08 + s.B02)) / ((s.B11 + s.B04) + (s.B08 + s.B02));
  let clear = s.dataMask == 1 && ![3, 8, 9, 10].includes(s.SCL);
  return { ndvi: [ndvi], savi: [savi], ndmi: [ndmi], bsi: [bsi], dataMask: [clear ? 1 : 0] };
}`;

let cachedToken = null;
async function getToken() {
  const { CDSE_CLIENT_ID: id, CDSE_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('No Copernicus credentials in .env');
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Copernicus login failed (${res.status})`);
  const j = await res.json();
  cachedToken = { value: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function statistics(body) {
  const res = await fetch(STATS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify(body),
    signal: timeout(180000),
  });
  if (!res.ok) throw new Error(`Sentinel Hub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// geometry: GeoJSON Polygon of the field (lon/lat). Only pixels inside it are counted.
export async function getSentinel(geometry) {
  const startYear = new Date().getFullYear() - 5;
  const body = {
    input: {
      bounds: { geometry, properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { maxCloudCoverage: 50 } }],
    },
    aggregation: {
      timeRange: { from: `${startYear}-01-01T00:00:00Z`, to: new Date().toISOString() },
      aggregationInterval: { of: 'P10D' },
      evalscript: EVALSCRIPT,
      resx: 0.0001, resy: 0.0001, // ~10 m pixels
    },
  };
  const rows = [];
  for (const item of (await statistics(body)).data ?? []) {
    const o = item.outputs ?? {};
    const mean = id => o[id]?.bands?.B0?.stats?.mean;
    const r = { date: item.interval.from.slice(0, 10), ndvi: mean('ndvi'), savi: mean('savi'), ndmi: mean('ndmi'), bsi: mean('bsi') };
    if (typeof r.ndvi !== 'number' || typeof r.bsi !== 'number') continue; // fully cloudy period
    r.bare = r.bsi > 0.05 && r.ndvi < 0.25 ? 1 : 0; // same rule as analysis.js
    // NDVI spread inside the field: rising = patchy damage (pests/disease), low = uniform (drought/nutrients)
    const st = o.ndvi?.bands?.B0?.stats ?? {};
    const std = st.stDev ?? st.stdev;
    if (typeof std === 'number' && Number.isFinite(std)) r.ndviStd = std;
    rows.push(r);
  }
  return rows;
}

// ---------- ESA Sentinel-1 radar (sees through clouds) ----------
// 10-day averages of VV/VH backscatter (linear) for the last 2 years: [{date, vv, vh, rvi}]
// rvi = 4*VH/(VV+VH): radar vegetation index, rises as the crop canopy grows.
const S1_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: ["VV", "VH", "dataMask"],
    output: [
      { id: "vv", bands: 1, sampleType: "FLOAT32" },
      { id: "vh", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  return { vv: [s.VV], vh: [s.VH], dataMask: [s.dataMask] };
}`;

export async function getSentinel1(geometry) {
  const from = new Date(Date.now() - 2 * 365 * 864e5);
  const body = {
    input: {
      bounds: { geometry, properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
      data: [{
        type: 'sentinel-1-grd',
        dataFilter: { acquisitionMode: 'IW', polarization: 'DV', resolution: 'HIGH' },
        processing: { orthorectify: true, backCoeff: 'GAMMA0_TERRAIN' },
      }],
    },
    aggregation: {
      timeRange: { from: from.toISOString(), to: new Date().toISOString() },
      aggregationInterval: { of: 'P10D' },
      evalscript: S1_EVALSCRIPT,
      resx: 0.0001, resy: 0.0001,
    },
  };
  const rows = [];
  for (const item of (await statistics(body)).data ?? []) {
    const o = item.outputs ?? {};
    const vv = o.vv?.bands?.B0?.stats?.mean, vh = o.vh?.bands?.B0?.stats?.mean;
    if (typeof vv !== 'number' || typeof vh !== 'number' || !(vv + vh > 0)) continue;
    rows.push({ date: item.interval.from.slice(0, 10), vv, vh, rvi: 4 * vh / (vv + vh) });
  }
  return rows;
}

// ---------- Open-Meteo: 16-day weather forecast (free, no key) ----------
// { source, days: [{date, tMax, tMin, tMean, rainMm, rainProb, code, gustKmh, et0Mm}] }
// 7 days from today, from the two most accurate weather models for Europe, both via Open-Meteo:
// ECMWF IFS (European Centre, the world's best-rated global model) and DWD ICON (German Weather
// Service, 7-13 km over Europe, the only one that reports hail). Temperature and rain come from
// ECMWF (ICON if missing); hail/thunder codes and wind gusts take the worse of the two, so a hazard
// seen by either model is not missed.
const FORECAST_DAYS = 7;
const MODELS = ['ecmwf_ifs025', 'icon_seamless'];
const DAILY = 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,precipitation_probability_max,weather_code,wind_gusts_10m_max,et0_fao_evapotranspiration';
const DAILY_BASIC = 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code';

async function openMeteo(lat, lon, params) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: (+lat).toFixed(4), longitude: (+lon).toFixed(4), timezone: 'auto', forecast_days: FORECAST_DAYS, ...params });
  const res = await fetch(url, { signal: timeout(12000), headers: { 'User-Agent': UA } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Open-Meteo ${res.status}${j.reason ? `: ${j.reason}` : ''}`);
  return j;
}

// value of a daily variable for one model (multi-model responses suffix the keys: temperature_2m_max_ecmwf_ifs025)
const pick = (d, k, i, model) => {
  const v = (model ? d[`${k}_${model}`] : null) ?? d[k];
  return typeof v?.[i] === 'number' ? v[i] : null;
};
const first = (...vals) => vals.find(v => v != null) ?? null;
const worst = (...vals) => { const v = vals.filter(x => x != null); return v.length ? Math.max(...v) : null; };

export async function getForecast(lat, lon) {
  let j, models = MODELS;
  try { j = await openMeteo(lat, lon, { daily: DAILY, models: MODELS.join(',') }); }
  catch (err) {
    console.warn('Forecast (ECMWF + ICON) failed ->', err.message);
    models = [null]; // Open-Meteo's own best model choice, basic variables only
    j = await openMeteo(lat, lon, { daily: DAILY_BASIC });
  }
  const d = j.daily ?? {};
  const [a, b] = models;
  const days = (d.time ?? []).map((date, i) => {
    const get = k => first(pick(d, k, i, a), b ? pick(d, k, i, b) : null);
    const tMax = get('temperature_2m_max'), tMin = get('temperature_2m_min');
    return {
      date, tMax, tMin,
      tMean: get('temperature_2m_mean') ?? (tMax != null && tMin != null ? (tMax + tMin) / 2 : null),
      rainMm: get('precipitation_sum'),
      rainProb: get('precipitation_probability_max'),
      code: worst(pick(d, 'weather_code', i, a), b ? pick(d, 'weather_code', i, b) : null),
      gustKmh: worst(pick(d, 'wind_gusts_10m_max', i, a), b ? pick(d, 'wind_gusts_10m_max', i, b) : null),
      et0Mm: get('et0_fao_evapotranspiration'),
    };
  }).filter(x => x.tMax != null && x.tMin != null).slice(0, FORECAST_DAYS);
  if (!days.length) throw new Error('Open-Meteo returned no forecast days');
  return { source: models[0] ? 'ECMWF IFS + DWD ICON (via Open-Meteo)' : 'Open-Meteo', days };
}

// ---------- OpenStreetMap Overpass: auto-detect the field shape ----------
// Finds farmland polygons that contain the point and returns the smallest one.
const why = err => `${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ''}`;

export async function getParcel(lat, lon) {
  const errors = [];
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ data: overpassQuery(lat, lon) }),
        signal: timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseOverpass(await res.json());
    } catch (err) { errors.push(`${new URL(url).host}: ${why(err)}`); }
  }
  // backup: the main OpenStreetMap API (a small box first, then a bigger one for large fields)
  for (const d of [0.008, 0.02]) {
    try {
      const res = await fetch(osmMapUrl(lat, lon, d), { headers: { 'User-Agent': UA }, signal: timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const shapes = parseOsmMap(await res.json(), lat, lon);
      if (shapes.length) return shapes;
      if (d === 0.02) return [];
    } catch (err) { errors.push(`api.openstreetmap.org: ${why(err)}`); break; }
  }
  throw new Error(errors.join('; '));
}

// ---------- OpenStreetMap Nominatim: address search ----------
export async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'json', limit: 5 })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
  if (!res.ok) throw new Error(`Address search ${res.status}`);
  return (await res.json()).map(r => ({ name: r.display_name, lat: +r.lat, lon: +r.lon }));
}

export async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat, lon, format: 'json', zoom: 12 })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
  if (!res.ok) throw new Error(`Reverse geocode ${res.status}`);
  const a = (await res.json()).address ?? {};
  return [a.village || a.town || a.city || a.municipality || a.county, a.country].filter(Boolean).join(', ');
}
