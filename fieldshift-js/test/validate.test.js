import { readReal } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../lib/validate.js';
import { defaultSoil } from '../lib/sources.js';

const LOC = ['43.673_27.832', '42.179_24.799'];

test('real cached data passes every check', () => {
  for (const k of LOC) {
    for (const [name, fn] of [['climate', V.validateClimate], ['recent', V.validateRecent], ['soil', V.validateSoil], ['terrain', V.validateTerrain]]) {
      const r = fn(readReal(`${name}_${k}`));
      assert.equal(r.ok, true, `${name}_${k}: ${r.issues}`);
    }
  }
  for (const s of ['sentinel_s3hj3y', 'sentinel_1qnuov4']) assert.equal(V.validateSentinel(readReal(s)).ok, true, s);
  assert.equal(V.validateSoil(defaultSoil()).ok, true);
});

test('broken climate fails', () => {
  const rows = readReal('climate_43.673_27.832');
  assert.equal(V.validateClimate(rows.slice(0, 12 * 15)).ok, false);
  const bad = rows.map((r, i) => (i === 5 ? { ...r, temp: 60 } : i === 6 ? { ...r, rainMm: -3 } : i === 7 ? { ...r, temp: NaN } : r));
  const v = V.validateClimate(bad);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(x => /temperature/.test(x)) && v.issues.some(x => /rain/.test(x)) && v.issues.some(x => /invalid/.test(x)));
  assert.equal(V.validateClimate(null).ok, false);
});

test('broken recent / sentinel / soil / terrain / forecast fail', () => {
  const recent = readReal('recent_43.673_27.832');
  assert.equal(V.validateRecent(recent.slice(0, 100)).ok, false);
  assert.equal(V.validateRecent(recent.map((r, i) => (i === 3 ? { ...r, rainMm: 500 } : r))).ok, false);

  const s = readReal('sentinel_s3hj3y');
  assert.equal(V.validateSentinel(s.slice(0, 10)).ok, false);
  assert.equal(V.validateSentinel(s.map((r, i) => (i === 2 ? { ...r, ndvi: 1.5 } : r))).ok, false);
  assert.equal(V.validateSentinel([...s].reverse()).ok, false);

  assert.equal(V.validateSoil({ clayPct: 50, sandPct: 50, siltPct: 50, socGKg: 10, ph: 7 }).ok, false);
  assert.equal(V.validateSoil({ clayPct: 30, sandPct: 30, siltPct: 40, socGKg: -1, ph: 12 }).issues.length, 2);
  assert.equal(V.validateTerrain({ elevationM: 5000, slopePct: 3 }).ok, false);
  assert.equal(V.validateTerrain({ elevationM: 200, slopePct: -1 }).ok, false);

  const f = { days: [{ date: '2026-11-15', tMax: 10, tMin: 2, rainMm: 0 }, { date: '2026-11-16', tMax: 10, tMin: 2, rainMm: 1 }, { date: '2026-11-17', tMax: 10, tMin: 2, rainMm: 1 }] };
  assert.equal(V.validateForecast(f).ok, true);
  assert.equal(V.validateForecast({ days: f.days.slice(0, 2) }).ok, false);
  assert.equal(V.validateForecast({ days: f.days.map(d => ({ ...d, tMin: 15 })) }).ok, false);
  assert.equal(V.validateForecast({ days: f.days.map(d => ({ ...d, rainMm: -2 })) }).ok, false);
  assert.equal(V.validateForecast(null).ok, false);
});
