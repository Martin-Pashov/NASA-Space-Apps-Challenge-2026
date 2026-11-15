import { forecastFrom } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as AL from '../public/alerts.js';

const { weatherAlerts, vegetationAlerts, pestAlerts, buildAlerts, smsText, callScript, channelsFor, LEVELS } = AL;
const at = (y, m, d) => new Date(y, m - 1, d, 9, 0);
const one = (list, type) => { const a = list.filter(x => x.type === type); assert.equal(a.length, 1, `${type}: ${JSON.stringify(list.map(x => x.id))}`); return a[0]; };
const SHAPE = ['id', 'level', 'type', 'title', 'text', 'action', 'when', 'source', 'channels'];
const checkShape = a => { for (const k of SHAPE) assert.ok(a[k] != null && a[k] !== '', `${a.id} missing ${k}`); assert.deepEqual(a.channels, LEVELS[a.level].channels); };

test('exports exactly the agreed API', () => {
  assert.deepEqual(Object.keys(LEVELS), ['urgent', 'warning', 'advice', 'info']);
  for (const f of ['weatherAlerts', 'vegetationAlerts', 'pestAlerts', 'buildAlerts', 'smsText', 'callScript', 'channelsFor']) assert.equal(typeof AL[f], 'function');
  assert.deepEqual(channelsFor('urgent'), ['call', 'sms', 'app']);
  assert.deepEqual(channelsFor('nope'), ['app']);
});

test('no forecast -> no alerts, quiet weather -> no alerts', () => {
  assert.deepEqual(weatherAlerts(null), []);
  assert.deepEqual(buildAlerts({ forecast: null, sentinel: null }), []);
  assert.deepEqual(weatherAlerts(forecastFrom('2026-04-10'), { now: at(2026, 4, 10) }), []);
});

test('hail and thunderstorm', () => {
  const now = at(2026, 6, 10);
  const a = weatherAlerts(forecastFrom('2026-06-10', 16, { 1: { code: 96 }, 6: { code: 99 }, 9: { code: 95 } }), { now });
  const hail = a.filter(x => x.type === 'hail');
  assert.equal(hail.length, 2);
  assert.equal(hail.find(x => x.id === 'hail-2026-06-11').level, 'urgent');
  assert.equal(hail.find(x => x.id === 'hail-2026-06-16').level, 'warning');
  assert.equal(one(a, 'storm').level, 'advice');
  assert.equal(hail[0].when, 'Thu 11 Jun');
  a.forEach(checkShape);
});

test('past forecast days are ignored', () => {
  const a = weatherAlerts(forecastFrom('2026-06-08', 16, { 0: { code: 96 }, 1: { rainMm: 60 } }), { now: at(2026, 6, 10) });
  assert.deepEqual(a, []);
});

test('flood / heavy rain', () => {
  const now = at(2026, 9, 1);
  assert.equal(one(weatherAlerts(forecastFrom('2026-09-01', 16, { 2: { rainMm: 55 } }), { now }), 'flood').level, 'urgent');
  const multi = one(weatherAlerts(forecastFrom('2026-09-01', 16, { 3: { rainMm: 30 }, 4: { rainMm: 32 }, 5: { rainMm: 25 } }), { now }), 'flood');
  assert.equal(multi.level, 'urgent'); assert.equal(multi.id, 'flood-2026-09-05');
  const w = one(weatherAlerts(forecastFrom('2026-09-01', 16, { 4: { rainMm: 35 } }), { now }), 'flood');
  assert.equal(w.level, 'warning');
  assert.match(w.action, /drain/i); assert.match(w.action, /wet soil/i); assert.match(w.action, /spray/i);
  assert.deepEqual(weatherAlerts(forecastFrom('2026-09-01', 16, { 4: { rainMm: 25 } }), { now }).filter(x => x.type === 'flood'), []);
});

test('frost: spring and winter-kill', () => {
  const now = at(2026, 4, 10);
  assert.equal(one(weatherAlerts(forecastFrom('2026-04-10', 16, { 3: { tMin: -3 } }), { now }), 'frost').level, 'urgent');
  assert.equal(one(weatherAlerts(forecastFrom('2026-04-10', 16, { 3: { tMin: -0.5 } }), { now }), 'frost').level, 'warning');
  const jan = at(2026, 1, 10);
  assert.equal(one(weatherAlerts(forecastFrom('2026-01-10', 16, { 2: { tMin: -20, tMax: -10 } }), { now: jan }), 'frost').level, 'warning');
  assert.deepEqual(weatherAlerts(forecastFrom('2026-01-10', 16, { 2: { tMin: -12, tMax: -5 } }), { now: jan }), []);
  // autumn frost is not a spring-frost alert
  assert.deepEqual(weatherAlerts(forecastFrom('2026-11-15', 10, { 2: { tMin: -4 } }), { now: at(2026, 11, 15) }), []);
});

test('heat', () => {
  const now = at(2026, 7, 1);
  assert.equal(one(weatherAlerts(forecastFrom('2026-07-01', 16, { 4: { tMax: 39 } }), { now }), 'heat').level, 'urgent');
  assert.equal(one(weatherAlerts(forecastFrom('2026-07-01', 16, { 4: { tMax: 36 }, 6: { tMax: 35 } }), { now }), 'heat').level, 'warning');
  assert.deepEqual(weatherAlerts(forecastFrom('2026-07-01', 16, { 4: { tMax: 36 } }), { now }).filter(x => x.type === 'heat'), []);
});

test('drought', () => {
  const now = at(2026, 7, 1);
  const dry = forecastFrom('2026-07-01', 16, Object.fromEntries([...Array(16)].map((_, i) => [i, { et0Mm: 5 }])));
  const w = one(weatherAlerts(dry, { now }), 'drought');
  assert.equal(w.level, 'warning'); assert.equal(w.when, 'next 14 days');
  assert.equal(one(buildAlerts({ forecast: dry, now, recent: { last3Pct: -30 } }), 'drought').level, 'urgent');
  assert.equal(one(buildAlerts({ forecast: dry, now, recent: { last3Pct: -10 } }), 'drought').level, 'warning');
  // some rain -> no drought
  const wet = forecastFrom('2026-07-01', 16, { 0: { et0Mm: 5, rainMm: 8 } });
  assert.deepEqual(weatherAlerts(wet, { now }).filter(x => x.type === 'drought'), []);
  // October: sowing moisture info
  const oct = one(weatherAlerts(forecastFrom('2026-10-05'), { now: at(2026, 10, 5) }), 'drought');
  assert.equal(oct.level, 'info'); assert.match(oct.text, /sow/i);
});

test('wind', () => {
  const now = at(2026, 3, 15);
  assert.equal(one(weatherAlerts(forecastFrom('2026-03-15', 16, { 2: { gustKmh: 95 } }), { now }), 'wind').level, 'urgent');
  const w = one(weatherAlerts(forecastFrom('2026-03-15', 16, { 2: { gustKmh: 75 } }), { now }), 'wind');
  assert.equal(w.level, 'warning'); assert.match(w.action, /spray/i);
  assert.deepEqual(weatherAlerts(forecastFrom('2026-03-15', 16, { 2: { gustKmh: 60 } }), { now }), []);
});

// ---------- satellite ----------
function sentinel({ base = 0.7, baseNdmi = 0.3, baseStd = 0.08, month = 5, cur = {}, prev = null, withStd = true } = {}) {
  const rows = [];
  const mm = String(month).padStart(2, '0');
  for (const y of [2022, 2023, 2024, 2025]) {
    for (const d of ['01', '11', '21']) rows.push({ date: `${y}-${mm}-${d}`, ndvi: base, ndmi: baseNdmi, savi: 0.4, bsi: -0.1, bare: 0, ...(withStd ? { ndviStd: baseStd } : {}) });
  }
  if (prev) rows.push({ date: `2026-${String(month - 1).padStart(2, '0')}-21`, ndvi: prev, ndmi: baseNdmi, savi: 0.4, bsi: -0.1, bare: 0 });
  rows.push({ date: `2026-${mm}-01`, ndvi: 0.45, ndmi: baseNdmi, savi: 0.3, bsi: -0.05, bare: 0, ...(withStd ? { ndviStd: baseStd } : {}), ...cur });
  return rows;
}

test('vegetation drop with moisture drop -> drought (crop short of water)', () => {
  const a = vegetationAlerts(sentinel({ cur: { ndvi: 0.45, ndmi: 0.15 } }), { now: at(2026, 5, 10) });
  const x = one(a, 'drought');
  assert.equal(x.level, 'urgent'); assert.match(x.text, /short of water/); assert.equal(x.source, 'ESA Sentinel-2 NDVI/NDMI');
  checkShape(x);
});

test('vegetation drop with rising spread -> patchy damage (pests/disease)', () => {
  const x = one(vegetationAlerts(sentinel({ cur: { ndvi: 0.56, ndviStd: 0.16 } }), { now: at(2026, 5, 10) }), 'vegetation');
  assert.equal(x.level, 'warning');
  assert.match(x.text, /patchy damage: possible pests or disease/);
  assert.match(x.action, /walk the field within 2.3 days/i);
});

test('uniform drop -> nutrient; legacy rows without ndviStd also -> nutrient', () => {
  assert.equal(one(vegetationAlerts(sentinel({ cur: { ndvi: 0.56 } }), { now: at(2026, 5, 10) }), 'nutrient').level, 'warning');
  assert.equal(one(vegetationAlerts(sentinel({ withStd: false }), { now: at(2026, 5, 10) }), 'nutrient').level, 'urgent');
  assert.deepEqual(vegetationAlerts(sentinel({ cur: { ndvi: 0.65 } }), { now: at(2026, 5, 10) }), []);
});

test('harvest month downgrades to info', () => {
  const rows = sentinel({ month: 7, cur: { ndvi: 0.3 } });
  const x = vegetationAlerts(rows, { now: at(2026, 7, 10), crops: ['Wheat', 'Sunflower'] });
  assert.equal(x.length, 1); assert.equal(x[0].level, 'info'); assert.match(x[0].text, /harvest/);
  assert.equal(vegetationAlerts(rows, { now: at(2026, 7, 10), crops: ['Sunflower'] })[0].level, 'urgent');
});

test('sudden drop between two close observations', () => {
  const rows = sentinel({ base: 0.55, prev: 0.72, cur: { ndvi: 0.56 } });
  const x = one(vegetationAlerts(rows, { now: at(2026, 5, 10) }), 'vegetation');
  assert.equal(x.level, 'warning'); assert.match(x.id, /^vegetation-sudden-/);
  // in a harvest month a sudden drop is expected, so no warning
  const july = sentinel({ month: 7, base: 0.55, prev: 0.72, cur: { ndvi: 0.56 } });
  assert.equal(vegetationAlerts(july, { now: at(2026, 7, 10) })[0].level, 'warning');
  assert.deepEqual(vegetationAlerts(july, { now: at(2026, 7, 10), crops: ['Barley'] }), []);
});

test('no satellite alerts out of season or without recent data', () => {
  assert.deepEqual(vegetationAlerts(sentinel({ month: 5 }), { now: at(2026, 11, 20) }), []);
  assert.deepEqual(vegetationAlerts(sentinel(), { now: at(2026, 6, 20) }), []); // last obs 50 days old
  assert.deepEqual(vegetationAlerts(null), []);
});

// ---------- pests ----------
const PESTS = {
  crops: {
    Wheat: {
      pests: [
        { id: 'aphid', name: 'Cereal aphids', nameBg: 'Листни въшки', type: 'insect', months: [4, 5, 6], risk: { tMinC: 12 }, severity: 2, scout: 'Check 20 tillers.', action: 'Spray if above threshold.' },
        { id: 'septoria', name: 'Septoria leaf blotch', nameBg: 'Септориоза', type: 'disease', months: [4, 5], risk: { tMinC: 10, humid: true, rainDaysMin: 3 }, severity: 3, scout: 'Look at the lower leaves.', action: 'Fungicide at flag leaf.' },
        { id: 'sunn', name: 'Sunn pest', type: 'insect', months: [5, 6], risk: { tMinC: 14, tMaxC: 30 }, severity: 3, scout: 'Count adults per m2.', action: 'Treat at 2 per m2.' },
        { id: 'thrips', name: 'Thrips', type: 'insect', months: [5], risk: { tMinC: 13 }, severity: 1, scout: 'Shake ears.', action: 'Rarely needs treatment.' },
        { id: 'hot', name: 'Heat-loving bug', type: 'insect', months: [5], risk: { tMinC: 25 }, severity: 3, scout: 'x', action: 'y' },
        { id: 'drybug', name: 'Dry mite', type: 'insect', months: [5], risk: { tMinC: 10, dry: true }, severity: 3, scout: 'x', action: 'y' },
      ],
      nutrients: { N: 160, P2O5: 60, K2O: 40 },
    },
  },
  deficiencies: [],
};

test('pest risk from the 7-day forecast', () => {
  const now = at(2026, 5, 10);
  const wet = forecastFrom('2026-05-10', 16, { 0: { rainMm: 3 }, 2: { rainMm: 5 }, 4: { rainMm: 2 } });
  const a = pestAlerts(wet, ['Wheat'], PESTS, { now });
  assert.equal(a.length, 3, 'max 3 per crop');
  assert.deepEqual(a.map(x => x.id.split('-')[1]), ['septoria', 'sunn', 'aphid']);
  const sep = a[0];
  assert.equal(sep.type, 'disease'); assert.equal(sep.level, 'warning');
  assert.match(sep.text, /\(Септориоза\)/);
  assert.equal(sep.action, 'Look at the lower leaves. Fungicide at flag leaf.');
  assert.equal(sep.when, 'next 7 days'); assert.equal(sep.source, 'FieldShift pest model + Open-Meteo');
  assert.equal(a[2].level, 'advice'); assert.equal(a[2].type, 'pest');
  // dry week: septoria drops out, dry mite comes in
  const dry = pestAlerts(forecastFrom('2026-05-10'), ['wheat'], PESTS, { now });
  assert.ok(dry.some(x => x.id.includes('drybug')) && !dry.some(x => x.id.includes('septoria')));
  // cold week: nothing
  assert.deepEqual(pestAlerts(forecastFrom('2026-05-10', 16, Object.fromEntries([...Array(16)].map((_, i) => [i, { tMean: 5, tMax: 8, tMin: 2 }]))), ['Wheat'], PESTS, { now }), []);
  assert.deepEqual(pestAlerts(wet, ['Wheat'], null, { now }), []);
  assert.deepEqual(pestAlerts(null, ['Wheat'], PESTS, { now }), []);
});

test('buildAlerts merges, de-duplicates and sorts', () => {
  const now = at(2026, 5, 10);
  const fc = forecastFrom('2026-05-10', 16, { 0: { rainMm: 3 }, 2: { rainMm: 5 }, 4: { rainMm: 2 }, 8: { code: 96 }, 1: { gustKmh: 95 } });
  const all = buildAlerts({ forecast: { ok: true, data: fc }, sentinel: { ok: true, data: sentinel({ cur: { ndvi: 0.56 } }) }, crops: ['Wheat'], pests: PESTS, now });
  const ids = all.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length);
  const ranks = all.map(a => LEVELS[a.level].rank);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
  assert.equal(all[0].type, 'wind');
  assert.ok(all.some(a => a.type === 'hail' && a.level === 'warning'));
  assert.ok(all.some(a => a.type === 'nutrient'));
  all.forEach(checkShape);
});

// ---------- message text ----------
const GSM = /^[A-Za-z0-9 .,:;!?'"()+\-/%&#@*=<>]*$/;

test('smsText fits one GSM-7 SMS', () => {
  const now = at(2026, 5, 10);
  const fc = forecastFrom('2026-05-10', 16, { 1: { code: 96, gustKmh: 95, rainMm: 60, tMax: 39 }, 3: { tMin: -3 } });
  const all = [...buildAlerts({ forecast: fc, sentinel: sentinel({ cur: { ndvi: 0.45, ndmi: 0.1 } }), crops: ['Wheat'], pests: PESTS, now })];
  assert.ok(all.length >= 6);
  for (const name of ['Field Dobrich', 'Нива Добрич – север', 'A very very long field name that goes on and on and on forever and ever', '', '🌾 Field ü']) {
    for (const a of all) {
      const s = smsText(a, name);
      assert.ok(s.length <= 160, `${s.length}: ${s}`);
      assert.match(s, GSM, s);
      assert.match(s, /^FieldShift (URGENT|WARNING|RECOMMENDATION|INFO): /);
      assert.match(s, /Reply STOP to end$/);
    }
  }
  const hail = all.find(a => a.type === 'hail');
  assert.equal(smsText(hail, 'Нива Добрич').includes('at Niva Dobrich.'), true);
  assert.match(smsText(hail, 'Field Dobrich'), /^FieldShift URGENT: Hail likely Mon 11 May at Field Dobrich\. Move machinery inside/);
});

test('callScript is short spoken English', () => {
  const a = weatherAlerts(forecastFrom('2026-05-10', 16, { 1: { code: 96 } }), { now: at(2026, 5, 10) })[0];
  const s = callScript(a, 'Нива Добрич');
  assert.match(s, /^Hello\. This is FieldShift with an urgent alert for Niva Dobrich\./);
  assert.match(s, /What to do:/);
  assert.ok(s.length < 700);
});

test('real public/data/pests.json works with the pest model (skipped if missing)', async t => {
  const fs = await import('node:fs');
  const file = new URL('../public/data/pests.json', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('pests.json not written yet');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const crops = Object.keys(db.crops);
  const wet = forecastFrom('2026-05-10', 16, { 0: { rainMm: 3 }, 1: { rainMm: 3 }, 2: { rainMm: 3 }, 3: { rainMm: 3 } });
  const a = pestAlerts(wet, crops, db, { now: at(2026, 5, 10) });
  assert.ok(a.length > 0);
  for (const crop of crops) assert.ok(a.filter(x => x.title.endsWith(` on ${crop}`)).length <= 3);
  for (const x of a) { checkShape(x); const s = smsText(x, 'Field Dobrich'); assert.ok(s.length <= 160); assert.match(s, GSM); }
});
