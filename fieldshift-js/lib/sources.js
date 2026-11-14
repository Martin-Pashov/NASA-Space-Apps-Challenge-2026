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
// 10-day averages for the last ~5 years: [{date, ndvi, savi, ndmi, bsi, bare}]
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
  const res = await fetch(STATS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify(body),
    signal: timeout(180000),
  });
  if (!res.ok) throw new Error(`Sentinel Hub ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const rows = [];
  for (const item of (await res.json()).data ?? []) {
    const o = item.outputs ?? {};
    const mean = id => o[id]?.bands?.B0?.stats?.mean;
    const r = { date: item.interval.from.slice(0, 10), ndvi: mean('ndvi'), savi: mean('savi'), ndmi: mean('ndmi'), bsi: mean('bsi') };
    if (typeof r.ndvi !== 'number' || typeof r.bsi !== 'number') continue; // fully cloudy period
    r.bare = r.bsi > 0.05 && r.ndvi < 0.25 ? 1 : 0; // same rule as analysis.js
    rows.push(r);
  }
  return rows;
}

// ---------- OpenStreetMap Overpass: auto-detect the field shape ----------
// Finds farmland polygons that contain the point and returns the smallest one.
export async function getParcel(lat, lon) {
  const tags = '^(farmland|farmyard|orchard|vineyard|meadow|grass|plant_nursery)$';
  const query = `[out:json][timeout:25];is_in(${lat},${lon})->.a;(way(pivot.a)[landuse~"${tags}"];rel(pivot.a)[landuse~"${tags}"];);out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ data: query }),
    signal: timeout(30000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);

  const shapes = [];
  for (const el of (await res.json()).elements ?? []) {
    let pts = null;
    if (el.type === 'way' && el.geometry) pts = el.geometry;
    if (el.type === 'relation') {
      const outers = (el.members ?? []).filter(m => m.role === 'outer' && m.geometry);
      if (outers.length === 1) pts = outers[0].geometry;
    }
    if (!pts || pts.length < 4) continue;
    const ring = pts.map(p => [p.lon, p.lat]);
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
    shapes.push({ geometry: { type: 'Polygon', coordinates: [ring] }, landuse: el.tags?.landuse });
  }
  return shapes;
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
