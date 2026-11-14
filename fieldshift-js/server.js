// FieldShift server: serves the website and fetches all data live for the chosen field.
// The browser never talks to the data APIs directly, so the Copernicus secret stays private.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as src from './lib/sources.js';

loadEnv();
const app = express();
const PORT = process.env.PORT || 3000;
const BACKUP = path.resolve('data/cache');
fs.mkdirSync(BACKUP, { recursive: true });

app.use(express.static('public'));
app.use('/vendor/chart', express.static('node_modules/chart.js/dist'));
app.use('/vendor/leaflet', express.static('node_modules/leaflet/dist'));

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

// One call collects everything about the field, all sources in parallel.
app.get('/api/analyze', async (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Missing location' });
  const k = `${lat.toFixed(3)}_${lon.toFixed(3)}`;

  const [climate, recent, soil, terrain, sentinel] = await Promise.all([
    live(`climate_${k}`, () => src.getClimate(lat, lon)),
    live(`recent_${k}`, () => src.getRecentWeather(lat, lon)),
    live(`soil_${k}`, () => src.getSoil(lat, lon)),
    live(`terrain_${k}`, () => src.getTerrain(lat, lon)),
    live(`sentinel_${k}`, () => src.getSentinel(lat, lon)),
  ]);
  if (!climate.ok) return res.status(502).json({ error: `Couldn't load NASA climate data: ${climate.error}` });
  if (!soil.ok) Object.assign(soil, { ok: true, data: src.defaultSoil() });
  res.json({ lat, lon, climate, recent, soil, terrain, sentinel });
});

app.listen(PORT, () => console.log(`FieldShift running at http://localhost:${PORT}`));

function loadEnv() {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
