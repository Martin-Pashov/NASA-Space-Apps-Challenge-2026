// FieldShift server: serves the website and fetches all data live for the chosen field.
// The browser never talks to the data APIs directly, so the Copernicus secret stays private.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as src from './lib/sources.js';
import { areaHa, centroid, geometryKey, pickParcel } from './public/geo.js';

loadEnv();
const app = express();
const PORT = process.env.PORT || 3000;
const BACKUP = path.resolve('data/cache');
const MAX_FIELD_HA = 2000; // keeps Sentinel Hub processing quota under control
fs.mkdirSync(BACKUP, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
app.use('/vendor/chart', express.static('node_modules/chart.js/dist'));
app.use('/vendor/leaflet', express.static('node_modules/leaflet/dist'));
app.use('/vendor/geoman', express.static('node_modules/@geoman-io/leaflet-geoman-free/dist'));

// Live call first. Each success is also kept as a backup copy, used only if the live call fails later
// (e.g. bad Wi-Fi during a demo).
async function live(name, fn) {
  const file = path.join(BACKUP, `${name}.json`);
  try {
    const data = await fn();
    fs.writeFileSync(file, JSON.stringify(data));
    return { ok: true, data };
  } catch (err) {
    if (fs.existsSync(file)) return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), backup: true, error: err.message };
    return { ok: false, error: err.message };
  }
}

app.get('/api/geocode', async (req, res) => {
  try { res.json(await src.geocode(req.query.q ?? '')); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/reverse', async (req, res) => {
  try { res.json({ name: await src.reverseGeocode(+req.query.lat, +req.query.lon) }); }
  catch { res.json({ name: '' }); }
});

// Auto-detect the field shape from OpenStreetMap farmland outlines.
app.get('/api/parcel', async (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  try {
    res.json(pickParcel(await src.getParcel(lat, lon)));
  } catch (err) {
    console.warn('Field outline lookup failed ->', err.message);
    res.json({ found: false, unavailable: true, reason: 'We couldn\'t load field outlines from OpenStreetMap right now (the free service is busy).' });
  }
});

// Collects everything about the field. Streams progress as one JSON object per line (NDJSON):
// {type:'step', id, status:'running'|'done'|'failed', ms, error}  ...  {type:'result', data}
app.post('/api/analyze', async (req, res) => {
  const geometry = req.body?.geometry;
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0]) || geometry.coordinates[0].length < 4) {
    return res.status(400).json({ error: 'Please select a field on the map first.' });
  }
  const ha = areaHa(geometry);
  if (ha > MAX_FIELD_HA) return res.status(400).json({ error: `The selected area is ${Math.round(ha)} ha. Please draw a field smaller than ${MAX_FIELD_HA} ha.` });

  const { lat, lon } = centroid(geometry);
  const k = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  const step = async (id, cacheName, fn) => {
    const t0 = Date.now();
    send({ type: 'step', id, status: 'running' });
    const r = await live(cacheName, fn);
    send({ type: 'step', id, status: r.ok ? 'done' : 'failed', ms: Date.now() - t0, backup: !!r.backup, error: r.error });
    return r;
  };

  const [climate, recent, sentinel, soil, terrain] = await Promise.all([
    step('climate', `climate_${k}`, () => src.getClimate(lat, lon)),
    step('recent', `recent_${k}`, () => src.getRecentWeather(lat, lon)),
    step('sentinel', `sentinel_${geometryKey(geometry)}`, () => src.getSentinel(geometry)),
    step('soil', `soil_${k}`, () => src.getSoil(lat, lon)),
    step('terrain', `terrain_${k}`, () => src.getTerrain(lat, lon)),
  ]);
  if (!soil.ok) Object.assign(soil, { ok: true, data: src.defaultSoil() });
  send({ type: 'result', data: { lat, lon, areaHa: ha, geometry, climate, recent, soil, terrain, sentinel } });
  res.end();
});

app.listen(PORT, () => console.log(`FieldShift running at http://localhost:${PORT}`));

function loadEnv() {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
