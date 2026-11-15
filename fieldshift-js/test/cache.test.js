import { CACHE } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cached, settle, clearMemory, memorySize } from '../lib/cache.js';

const H = 3600e3;
const file = n => path.join(CACHE, `${n}.json`);
const writeNew = (n, data, ageMs) => fs.writeFileSync(file(n), JSON.stringify({ savedAt: new Date(Date.now() - ageMs).toISOString(), data }));
const counter = (value, fail) => { const f = async () => { f.calls++; await new Promise(r => setTimeout(r, 20)); if (fail) throw new Error(fail); return value; }; f.calls = 0; return f; };

test.beforeEach(() => clearMemory());

test('fresh copy returns without calling the network', async () => {
  writeNew('t_fresh', [1, 2, 3], 10 * 60e3);
  const fn = counter('new');
  const r = await cached('t_fresh', H, fn, { maxStaleMs: 24 * H });
  assert.equal(fn.calls, 0);
  assert.deepEqual(r.data, [1, 2, 3]);
  assert.equal(r.ok, true); assert.equal(r.cached, true); assert.equal(r.stale, false); assert.equal(r.backup, false);
  assert.ok(r.ageMs >= 10 * 60e3 - 1000 && r.ageMs < 11 * 60e3);
});

test('legacy raw file uses mtime as savedAt', async () => {
  fs.writeFileSync(file('t_legacy'), JSON.stringify([{ a: 1 }]));
  const fn = counter('new');
  const r = await cached('t_legacy', H, fn);
  assert.equal(fn.calls, 0);
  assert.deepEqual(r.data, [{ a: 1 }]);
  // make it old: beyond maxStale -> refetch and rewrite in the new format
  clearMemory();
  const old = new Date(Date.now() - 48 * H);
  fs.utimesSync(file('t_legacy'), old, old);
  const r2 = await cached('t_legacy', H, fn, { maxStaleMs: 24 * H });
  assert.equal(fn.calls, 1);
  assert.equal(r2.data, 'new'); assert.equal(r2.cached, false);
  const disk = JSON.parse(fs.readFileSync(file('t_legacy'), 'utf8'));
  assert.equal(disk.data, 'new'); assert.ok(Date.parse(disk.savedAt) > Date.now() - 60e3);
});

test('stale copy is returned at once and refreshed in the background', async () => {
  writeNew('t_stale', 'old', 2 * H);
  const fn = counter('fresh');
  const t0 = Date.now();
  const r = await cached('t_stale', H, fn, { maxStaleMs: 24 * H });
  assert.ok(Date.now() - t0 < 15, 'must not wait for the network');
  assert.equal(r.data, 'old'); assert.equal(r.stale, true); assert.equal(r.cached, true); assert.equal(r.ok, true);
  await settle();
  assert.equal(fn.calls, 1);
  const r2 = await cached('t_stale', H, fn, { maxStaleMs: 24 * H });
  assert.equal(r2.data, 'fresh'); assert.equal(r2.stale, false);
  assert.equal(JSON.parse(fs.readFileSync(file('t_stale'), 'utf8')).data, 'fresh');
});

test('failure falls back to an old copy (backup) or reports ok:false', async () => {
  writeNew('t_fb', 'ancient', 1000 * H);
  const r = await cached('t_fb', H, counter(null, 'fetch failed'), { maxStaleMs: 24 * H });
  assert.equal(r.ok, true); assert.equal(r.backup, true); assert.equal(r.data, 'ancient'); assert.match(r.error, /fetch failed/);
  const r2 = await cached('t_none', H, counter(null, 'fetch failed'));
  assert.equal(r2.ok, false); assert.match(r2.error, /fetch failed/);
  assert.equal(fs.existsSync(file('t_none')), false);
});

test('concurrent requests for the same name share one network call', async () => {
  const fn = counter({ v: 1 });
  const rs = await Promise.all([1, 2, 3, 4].map(() => cached('t_dedupe', H, fn)));
  assert.equal(fn.calls, 1);
  assert.ok(rs.every(r => r.ok && r.data.v === 1));
});

test('invalid data is not stored', async () => {
  const validate = d => (d.good ? { ok: true, issues: [] } : { ok: false, issues: ['looks broken'] });
  const r = await cached('t_invalid', H, counter({ good: false }), { validate });
  assert.equal(r.ok, false); assert.deepEqual(r.issues, ['looks broken']);
  assert.equal(fs.existsSync(file('t_invalid')), false);
  writeNew('t_invalid2', { good: true, old: 1 }, 1000 * H);
  const r2 = await cached('t_invalid2', H, counter({ good: false }), { validate, maxStaleMs: 2 * H });
  assert.equal(r2.ok, true); assert.equal(r2.backup, true); assert.equal(r2.data.old, 1); assert.deepEqual(r2.issues, ['looks broken']);
});

test('memory cache is bounded', async () => {
  for (let i = 0; i < 320; i++) await cached(`t_mem_${i}`, H, async () => i);
  assert.ok(memorySize() <= 300);
});
