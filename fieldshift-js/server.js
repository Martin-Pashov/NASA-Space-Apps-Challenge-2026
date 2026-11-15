// FieldShift server: serves the website and loads all data for the chosen field.
// The browser never talks to the data APIs directly, so the Copernicus / Twilio secrets stay private.
// Data is cache-first (lib/cache.js): fresh copies return instantly, stale ones are refreshed in the background.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as src from './lib/sources.js';
import { SOURCES, placeName } from './lib/data.js';
import { lookupPlant } from './lib/plant.js';
import * as monitor from './lib/monitor.js';
import { LEVELS, smsText, callScript } from './public/alerts.js';
import { areaHa, centroid, pickParcel } from './public/geo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.FIELDSHIFT_NO_ENV_FILE) loadEnv();
export const app = express();
const MAX_FIELD_HA = 2000; // keeps Sentinel Hub processing quota under control
const CHECK_EVERY_MS = 6 * 3600e3;

app.use(express.json({ limit: '1mb' }));
// no-cache: the browser always checks for a newer page, script or style (we change them often)
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/vendor/chart', express.static(path.join(ROOT, 'node_modules/chart.js/dist')));
app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));
app.use('/vendor/geoman', express.static(path.join(ROOT, 'node_modules/@geoman-io/leaflet-geoman-free/dist')));

const validPolygon = g => g?.type === 'Polygon' && Array.isArray(g.coordinates?.[0]) && g.coordinates[0].length >= 4
  && g.coordinates[0].every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

app.get('/api/geocode', async (req, res) => {
  try { res.json(await src.geocode(req.query.q ?? '')); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/reverse', async (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ name: '' });
  try { res.json({ name: await placeName(lat, lon) }); }
  catch { res.json({ name: '' }); }
});

// Auto-detect the field shape from OpenStreetMap farmland outlines (always live).
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
// {type:'step', id, status:'running'|'done'|'failed', ms, backup, error, cached, stale, ageMin}  ...  {type:'result', data}
app.post('/api/analyze', async (req, res) => {
  const geometry = req.body?.geometry;
  if (!validPolygon(geometry)) return res.status(400).json({ error: 'Please select a field on the map first.' });
  const ha = areaHa(geometry);
  if (ha > MAX_FIELD_HA) return res.status(400).json({ error: `The selected area is ${Math.round(ha)} ha. Please draw a field smaller than ${MAX_FIELD_HA} ha.` });

  const { lat, lon } = centroid(geometry);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  const step = async (id, load) => {
    const t0 = Date.now();
    send({ type: 'step', id, status: 'running' });
    let r;
    try { r = await load(); } catch (err) { r = { ok: false, error: err.message }; }
    send({
      type: 'step', id, status: r.ok ? 'done' : 'failed', ms: Date.now() - t0, backup: !!r.backup, error: r.error,
      cached: !!r.cached, stale: !!r.stale, ageMin: r.ageMs != null ? Math.round(r.ageMs / 60000) : null,
    });
    return r;
  };

  const [climate, recent, sentinel, soil, terrain, forecast, radar] = await Promise.all([
    step('climate', () => SOURCES.climate.load(lat, lon)),
    step('recent', () => SOURCES.recent.load(lat, lon)),
    step('sentinel', () => SOURCES.sentinel.load(geometry)),
    step('soil', () => SOURCES.soil.load(lat, lon)),
    step('terrain', () => SOURCES.terrain.load(lat, lon)),
    step('forecast', () => SOURCES.forecast.load(lat, lon)),
    // Sentinel-1 radar: an extra, slow satellite request; off unless FIELDSHIFT_RADAR=1 in .env
    process.env.FIELDSHIFT_RADAR === '1' ? step('radar', () => SOURCES.radar.load(geometry)) : Promise.resolve(null),
  ]);

  const checks = {};
  for (const [k, r] of Object.entries({ climate, recent, sentinel, soil, terrain, forecast, radar })) {
    try { checks[k] = r.ok ? SOURCES[k].validate(r.data) : null; } catch (err) { checks[k] = { ok: false, issues: [err.message] }; }
  }
  if (!soil.ok) Object.assign(soil, { ok: true, data: src.defaultSoil() });
  send({ type: 'result', data: { lat, lon, areaHa: ha, geometry, climate, recent, soil, terrain, sentinel, forecast, radar, checks } });
  res.end();
});

// ---------- Plant existence check (GBIF) ----------
app.get('/api/plant', async (req, res) => {
  try { res.json(await lookupPlant(req.query.q)); }
  catch (err) { res.json({ error: err.message, offline: true }); }
});

// ---------- Field monitoring + alerts ----------
app.post('/api/monitor', (req, res) => {
  try {
    const r = monitor.addSub(req.body ?? {});
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ id: r.sub.id, phoneMasked: monitor.publicSub(r.sub).phoneMasked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitor', (req, res) => {
  res.json(monitor.loadSubs().map(monitor.publicSub));
});

app.post('/api/monitor/:id/check', async (req, res) => {
  try {
    const r = await monitor.checkSub(req.params.id);
    if (!r) return res.status(404).json({ error: 'No such monitored field.' });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/monitor/:id', (req, res) => {
  try {
    if (!monitor.removeSub(req.params.id)) return res.status(404).json({ error: 'No such monitored field.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Message texts only, for the demo UI. Sends nothing.
app.post('/api/alerts/preview', (req, res) => {
  const alerts = req.body?.alerts;
  if (!Array.isArray(alerts) || alerts.length > 100) return res.status(400).json({ error: 'alerts must be a list (max 100).' });
  const fieldName = String(req.body?.fieldName ?? '').slice(0, 80);
  const valid = alerts.filter(a => a && LEVELS[a.level]);
  const sms = valid.filter(a => LEVELS[a.level].channels.includes('sms'))
    .map(a => { const text = smsText(a, fieldName); return { id: a.id, level: a.level, text, length: text.length }; });
  const calls = valid.filter(a => LEVELS[a.level].channels.includes('call'))
    .map(a => ({ id: a.id, level: a.level, script: callScript(a, fieldName) }));
  res.json({ sms, calls });
});

export function startMonitoring() {
  const timer = setInterval(() => {
    monitor.checkAll()
      .then(r => { if (r.length) console.log(`Monitor: checked ${r.length} field(s)`); })
      .catch(err => console.warn('Monitor run failed ->', err.message));
  }, CHECK_EVERY_MS);
  timer.unref();
  return timer;
}

// started directly (node server.js / npm start), not imported by the tests; compared case-insensitively for Windows
const isMain = !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain && !process.env.FIELDSHIFT_NO_LISTEN) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`FieldShift running at http://localhost:${PORT}`));
  startMonitoring();
}

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
