import { CACHE, DATA, REAL_CACHE, offline, json, realFetch, forecastFrom } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { squareAround, geometryKey } from '../public/geo.js';
import { settle } from '../lib/cache.js';

// a ~9 ha square field whose centroid rounds to the cached location 43.673_27.832
const geometry = squareAround(43.673, 27.832, 300);
const K = '43.673_27.832';
for (const n of ['climate', 'recent', 'soil', 'terrain']) fs.copyFileSync(path.join(REAL_CACHE, `${n}_${K}.json`), path.join(CACHE, `${n}_${K}.json`));
fs.copyFileSync(path.join(REAL_CACHE, 'sentinel_s3hj3y.json'), path.join(CACHE, `sentinel_${geometryKey(geometry)}.json`));

const { app } = await import('../server.js');
offline();
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { await settle(); server.close(); globalThis.fetch = realFetch; });

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const toOpenMeteo = f => ({ daily: {
  time: f.days.map(d => d.date), temperature_2m_max: f.days.map(d => d.tMax), temperature_2m_min: f.days.map(d => d.tMin),
  temperature_2m_mean: f.days.map(d => d.tMean), precipitation_sum: f.days.map(d => d.rainMm), precipitation_probability_max: f.days.map(d => d.rainProb),
  weather_code: f.days.map(d => d.code), wind_gusts_10m_max: f.days.map(d => d.gustKmh), et0_fao_evapotranspiration: f.days.map(d => d.et0Mm),
} });

async function analyze(body = { geometry }) {
  const res = await fetch(`${BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return { status: res.status, body: await res.json() };
  const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
  const steps = Object.fromEntries(lines.filter(l => l.type === 'step' && l.status !== 'running').map(l => [l.id, l]));
  return { status: res.status, lines, steps, result: lines.at(-1).data, last: lines.at(-1) };
}
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('analyze works offline from the cache', async () => {
  const t0 = Date.now();
  const r = await analyze();
  assert.equal(r.status, 200);
  assert.equal(r.last.type, 'result');
  const d = r.result;
  assert.equal(`${d.lat.toFixed(3)}_${d.lon.toFixed(3)}`, K);
  for (const k of ['climate', 'recent', 'soil', 'terrain', 'sentinel']) {
    assert.equal(d[k].ok, true, k);
    assert.equal(d[k].cached, true, k);
    assert.equal(r.steps[k].status, 'done');
    assert.equal(r.steps[k].cached, true); assert.equal(r.steps[k].backup, false);
    assert.equal(typeof r.steps[k].ageMin, 'number');
    assert.equal(d.checks[k].ok, true, `${k}: ${d.checks[k].issues}`);
  }
  assert.equal(d.climate.data.length, 300);
  // no internet -> forecast and radar fail gracefully
  assert.equal(d.forecast.ok, false); assert.match(d.forecast.error, /fetch failed/);
  assert.equal(r.steps.forecast.status, 'failed');
  assert.equal(d.checks.forecast, null);
  assert.equal(d.radar, null); assert.equal(r.steps.radar, undefined); // radar is off by default
  assert.ok(Date.now() - t0 < 3000, 'cache-first should be fast');
});

test('analyze includes a live forecast and then serves it from the cache', async () => {
  let n = 0;
  offline(u => { if (u.includes('open-meteo')) { n++; return json(toOpenMeteo(forecastFrom(today, 16, { 1: { code: 96 }, 2: { gustKmh: 80 } }))); } });
  const r = await analyze();
  assert.equal(r.result.forecast.ok, true); assert.equal(r.result.forecast.cached, false);
  assert.equal(r.result.forecast.data.days.length, 7);
  assert.equal(r.result.checks.forecast.ok, true);
  const r2 = await analyze();
  assert.equal(r2.result.forecast.cached, true); assert.equal(r2.steps.forecast.cached, true);
  assert.equal(n, 1);
  assert.ok(fs.existsSync(path.join(CACHE, `forecast_${K}.json`)));
  offline();
});

test('analyze rejects bad input', async () => {
  assert.equal((await analyze({})).status, 400);
  assert.equal((await analyze({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } })).status, 400);
  assert.equal((await analyze({ geometry: squareAround(43.6, 27.8, 10000) })).status, 400);
});

test('monitoring: subscribe, list, check, delete', async () => {
  let r = await post('/api/monitor', { name: 'Field Dobrich', geometry, phone: '12' });
  assert.equal(r.status, 400);
  r = await post('/api/monitor', { name: 'Field Dobrich', geometry, phone: '0888 123 456', crops: ['Wheat', 'Sunflower'], minLevel: 'warning' });
  assert.equal(r.status, 200);
  const { id, phoneMasked } = await r.json();
  assert.ok(id); assert.equal(phoneMasked, '+359 88*****56');
  const list = await (await fetch(`${BASE}/api/monitor`)).json();
  assert.equal(list.length, 1); assert.equal(list[0].phoneMasked, '+359 88*****56');
  assert.ok(!JSON.stringify(list).includes('888123456'));

  const c = await (await post(`/api/monitor/${id}/check`, {})).json();
  assert.ok(c.alerts.some(a => a.type === 'hail' && a.level === 'urgent'), JSON.stringify(c.alerts.map(a => a.id)));
  assert.ok(c.deliveries.some(d => d.channel === 'call' && d.status === 'dry-run'));
  assert.ok(c.deliveries.some(d => d.channel === 'sms' && d.status === 'dry-run'));
  const outbox = JSON.parse(fs.readFileSync(path.join(DATA, 'outbox.json'), 'utf8'));
  assert.ok(outbox.some(m => m.channel === 'sms' && /^FieldShift URGENT: Hail likely/.test(m.body)));
  // second check: nothing new is sent
  const c2 = await (await post(`/api/monitor/${id}/check`, {})).json();
  assert.ok(c2.deliveries.every(d => d.status === 'duplicate-skipped'));

  assert.equal((await post('/api/monitor/nope/check', {})).status, 404);
  assert.equal((await fetch(`${BASE}/api/monitor/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${BASE}/api/monitor/${id}`, { method: 'DELETE' })).status, 404);
});

test('alerts preview returns texts only', async () => {
  const alerts = [
    { id: 'hail-x', level: 'urgent', type: 'hail', title: 'Hail likely', text: 'Hail.', action: 'Move machinery inside.', when: 'Tue 18 Nov' },
    { id: 'wind-x', level: 'warning', type: 'wind', title: 'Strong wind', text: 'Wind.', action: 'Do not spray.', when: 'Wed 19 Nov' },
    { id: 'info-x', level: 'info', type: 'drought', title: 'Dry', text: 'Dry.', action: 'Check.', when: 'next 14 days' },
  ];
  const before = fs.existsSync(path.join(DATA, 'outbox.json')) ? fs.readFileSync(path.join(DATA, 'outbox.json'), 'utf8') : '';
  const r = await (await post('/api/alerts/preview', { alerts, fieldName: 'Field Dobrich' })).json();
  assert.equal(r.sms.length, 2); assert.equal(r.calls.length, 1);
  assert.equal(r.sms[0].text, 'FieldShift URGENT: Hail likely Tue 18 Nov at Field Dobrich. Move machinery inside. Reply STOP to end');
  assert.match(r.calls[0].script, /Hail likely/);
  const after = fs.existsSync(path.join(DATA, 'outbox.json')) ? fs.readFileSync(path.join(DATA, 'outbox.json'), 'utf8') : '';
  assert.equal(after, before);
  assert.equal((await post('/api/alerts/preview', { alerts: 'x' })).status, 400);
});

test('plant lookup: offline, scientific, common name, invalid', async () => {
  const get = async q => (await fetch(`${BASE}/api/plant?q=${encodeURIComponent(q)}`)).json();
  offline();
  assert.deepEqual(Object.keys(await get('Triticum aestivum')).sort(), ['error', 'offline']);
  offline(u => {
    const url = new URL(u);
    if (url.pathname.endsWith('/species/match')) {
      assert.equal(url.searchParams.get('kingdom'), 'Plantae');
      return json(url.searchParams.get('name') === 'Triticum aestivum'
        ? { matchType: 'EXACT', confidence: 98, kingdom: 'Plantae', rank: 'SPECIES', scientificName: 'Triticum aestivum L.', family: 'Poaceae' }
        : { matchType: 'NONE' });
    }
    if (url.pathname.endsWith('/species/search')) {
      assert.equal(url.searchParams.get('qField'), 'VERNACULAR');
      const q = url.searchParams.get('q');
      if (q === 'слънчоглед') return json({ results: [
        { kingdom: 'Animalia', scientificName: 'Bug' },
        { kingdom: 'Plantae', scientificName: 'Helianthus annuus L.', family: 'Asteraceae', vernacularNames: [{ vernacularName: 'Слънчоглед', language: 'bul' }] },
      ] });
      return json({ results: [{ kingdom: 'Animalia', scientificName: 'Canis lupus' }] });
    }
  });
  const sci = await get('Triticum aestivum');
  assert.equal(sci.found, true); assert.equal(sci.family, 'Poaceae'); assert.equal(sci.source, 'GBIF');
  const bg = await get('слънчоглед');
  assert.equal(bg.found, true); assert.equal(bg.scientificName, 'Helianthus annuus L.'); assert.equal(bg.vernacularName, 'Слънчоглед');
  assert.equal((await get('dragonwort xyz')).found, false);
  offline(); // cached for 365 days -> still answers offline
  assert.equal((await get('Triticum aestivum')).found, true);
  assert.equal((await get('x'.repeat(61))).found, false);
  assert.equal((await get('12345')).invalid, true);
});

test('reverse geocode is cached', async () => {
  let n = 0;
  offline(u => { if (u.includes('nominatim')) { n++; return json({ address: { town: 'Dobrich', country: 'Bulgaria' } }); } });
  const a = await (await fetch(`${BASE}/api/reverse?lat=43.5701&lon=27.8301`)).json();
  const b = await (await fetch(`${BASE}/api/reverse?lat=43.5702&lon=27.8302`)).json();
  assert.equal(a.name, 'Dobrich, Bulgaria'); assert.equal(b.name, 'Dobrich, Bulgaria'); assert.equal(n, 1);
  offline();
});
