// Field monitoring: subscriptions stored in data/monitor.json, checked every few hours.
// A check loads forecast + satellite data through the cache, builds alerts and sends them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LEVELS, buildAlerts } from '../public/alerts.js';
import { areaHa, centroid } from '../public/geo.js';
import { climateSummary, recentVsNormal } from '../public/analysis.js';
import { normalisePhone, maskPhone, dispatch, dataDir } from './notify.js';
import { SOURCES, loadPests } from './data.js';

const file = () => path.join(dataDir(), 'monitor.json');
const MAX_SUBS = 200, MAX_HA = 2000;

export function loadSubs() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function saveSubs(list) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file());
}

export const publicSub = s => ({
  id: s.id, name: s.name, phoneMasked: maskPhone(s.phone), crops: s.crops, minLevel: s.minLevel,
  createdAt: s.createdAt, lastCheck: s.lastCheck ?? null, lastAlerts: s.lastAlerts ?? 0,
});

const validPolygon = g => g?.type === 'Polygon' && Array.isArray(g.coordinates?.[0]) && g.coordinates[0].length >= 4
  && g.coordinates[0].every(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);

// -> { sub } or { error }
export function validateSubscription(body = {}) {
  const name = String(body.name ?? '').trim().slice(0, 80) || 'My field';
  if (!validPolygon(body.geometry)) return { error: 'Please select a field on the map first.' };
  const ha = areaHa(body.geometry);
  if (ha > MAX_HA) return { error: `The field is ${Math.round(ha)} ha. Please draw a field smaller than ${MAX_HA} ha.` };
  const phone = normalisePhone(body.phone);
  if (!phone) return { error: 'Please enter a valid phone number, e.g. +359 888 123 456 or 0888 123 456.' };
  if (body.crops != null && !Array.isArray(body.crops)) return { error: 'Crops must be a list of names.' };
  const crops = [...new Set((body.crops ?? []).map(c => String(c ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
  const minLevel = body.minLevel ?? 'warning';
  if (!LEVELS[minLevel]) return { error: `minLevel must be one of ${Object.keys(LEVELS).join(', ')}.` };
  return { sub: { name, geometry: body.geometry, phone, crops, minLevel } };
}

export function addSub(body) {
  const v = validateSubscription(body);
  if (v.error) return v;
  const list = loadSubs();
  if (list.length >= MAX_SUBS) return { error: 'Too many monitored fields.' };
  const sub = { id: crypto.randomBytes(5).toString('hex'), ...v.sub, sentIds: [], createdAt: new Date().toISOString() };
  list.push(sub);
  saveSubs(list);
  return { sub };
}

export function removeSub(id) {
  const list = loadSubs();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  saveSubs(next);
  return true;
}

// Builds the alerts for one field (no sending).
export async function alertsForField({ geometry, crops = [] }, { now = new Date() } = {}) {
  const { lat, lon } = centroid(geometry);
  const [forecast, sentinel, climate, recent] = await Promise.all([
    SOURCES.forecast.load(lat, lon), SOURCES.sentinel.load(geometry), SOURCES.climate.load(lat, lon), SOURCES.recent.load(lat, lon),
  ]);
  let recentNorm = null;
  try { if (climate.ok && recent.ok) recentNorm = recentVsNormal(recent.data, climateSummary(climate.data)); } catch { /* optional */ }
  const alerts = buildAlerts({
    forecast: forecast.ok ? { ...forecast.data, days: forecast.data.days.slice(0, 7) } : null, // 7 days, same as the app
    sentinel: sentinel.ok ? sentinel.data : null,
    crops, pests: loadPests(), recent: recentNorm, now,
  });
  return { alerts, sources: { forecast: status(forecast), sentinel: status(sentinel) } };
}
const status = r => ({ ok: r.ok, cached: !!r.cached, stale: !!r.stale, backup: !!r.backup, error: r.error });

export async function checkSub(id, opts) {
  const sub = loadSubs().find(s => s.id === id);
  if (!sub) return null;
  const { alerts, sources } = await alertsForField(sub, opts);
  const deliveries = await dispatch(alerts, sub);
  // re-read before saving so parallel edits (new subscriptions) are not lost
  const list = loadSubs();
  const i = list.findIndex(s => s.id === id);
  if (i >= 0) {
    list[i] = { ...list[i], sentIds: sub.sentIds, lastCheck: new Date().toISOString(), lastAlerts: alerts.length };
    saveSubs(list);
  }
  return { alerts, deliveries, sources };
}

export async function checkAll() {
  const results = [];
  for (const s of loadSubs()) {
    try { results.push({ id: s.id, ...(await checkSub(s.id)) }); }
    catch (err) { console.warn(`Monitor check ${s.id} failed ->`, err.message); results.push({ id: s.id, error: err.message }); }
  }
  return results;
}
