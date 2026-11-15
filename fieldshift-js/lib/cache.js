// Cache-first data store: memory -> disk -> network, with stale-while-revalidate.
// Disk format: data/cache/<name>.json = { "savedAt": ISO, "data": ... }.
// Older "legacy" files hold the raw data directly; their file time is used as savedAt.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MEMORY = 300;
const memory = new Map();   // file path -> { savedAt: ms, data }
const inflight = new Map(); // file path -> Promise<{ ok, data } | { ok:false, error, issues }>

export const HOUR = 3600e3, DAY = 24 * HOUR;
export const TTL = {
  climate: { ttlMs: 30 * DAY, maxStaleMs: 365 * DAY },
  recent: { ttlMs: 12 * HOUR, maxStaleMs: 7 * DAY },
  sentinel: { ttlMs: 2 * DAY, maxStaleMs: 30 * DAY },
  radar: { ttlMs: 2 * DAY, maxStaleMs: 30 * DAY },
  soil: { ttlMs: 365 * DAY, maxStaleMs: 5 * 365 * DAY },
  terrain: { ttlMs: 365 * DAY, maxStaleMs: 5 * 365 * DAY },
  forecast: { ttlMs: 3 * HOUR, maxStaleMs: 24 * HOUR },
  plant: { ttlMs: 365 * DAY, maxStaleMs: 5 * 365 * DAY },
  reverse: { ttlMs: 30 * DAY, maxStaleMs: 365 * DAY },
};

// Read at call time so tests can point FIELDSHIFT_CACHE_DIR at a temp folder.
export function cacheDir() {
  return path.resolve(ROOT, process.env.FIELDSHIFT_CACHE_DIR || 'data/cache');
}

const safeName = name => String(name).replace(/[^\w.-]/g, '_').slice(0, 120);
const fileFor = name => path.join(cacheDir(), `${safeName(name)}.json`);

function remember(file, entry) {
  memory.delete(file);
  memory.set(file, entry);
  while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
}

function readDisk(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isNew = raw && !Array.isArray(raw) && typeof raw === 'object' && typeof raw.savedAt === 'string' && 'data' in raw
      && Object.keys(raw).length <= 3;
    const savedAt = isNew ? Date.parse(raw.savedAt) : fs.statSync(file).mtimeMs; // legacy: file time
    if (!Number.isFinite(savedAt)) return null;
    return { savedAt, data: isNew ? raw.data : raw };
  } catch { return null; }
}

function writeDisk(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date(entry.savedAt).toISOString(), data: entry.data }));
    fs.renameSync(tmp, file);
  } catch (err) { console.warn('Cache write failed ->', err.message); }
}

function lookup(file) {
  const m = memory.get(file);
  if (m) { remember(file, m); return m; }
  const d = readDisk(file);
  if (d) remember(file, d);
  return d;
}

// One network call per name at a time; the promise never rejects.
function refresh(file, fn, validate) {
  if (inflight.has(file)) return inflight.get(file);
  const p = (async () => {
    try {
      const data = await fn();
      const check = validate ? validate(data) : { ok: true, issues: [] };
      if (check && check.ok === false) return { ok: false, error: `Data check failed: ${(check.issues ?? []).join('; ')}`, issues: check.issues ?? [] };
      const entry = { savedAt: Date.now(), data };
      remember(file, entry);
      writeDisk(file, entry);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  })().finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

/**
 * cached(name, ttlMs, fn, { maxStaleMs, validate })
 * -> { ok, data, cached, stale, ageMs, backup, error, issues }
 */
export async function cached(name, ttlMs, fn, { maxStaleMs = ttlMs, validate } = {}) {
  const file = fileFor(name);
  const old = lookup(file);
  const ageMs = old ? Math.max(0, Date.now() - old.savedAt) : null;

  if (old && ageMs < ttlMs) return { ok: true, data: old.data, cached: true, stale: false, ageMs, backup: false };
  if (old && ageMs < maxStaleMs) {
    refresh(file, fn, validate).then(r => { if (!r.ok) console.warn(`Background refresh of ${name} failed ->`, r.error); });
    return { ok: true, data: old.data, cached: true, stale: true, ageMs, backup: false };
  }

  const r = await refresh(file, fn, validate);
  if (r.ok) return { ok: true, data: r.data, cached: false, stale: false, ageMs: 0, backup: false };
  // failed or invalid: any older copy is better than nothing
  const fallback = lookup(file) ?? old;
  if (fallback) {
    return { ok: true, data: fallback.data, cached: true, stale: true, ageMs: Math.max(0, Date.now() - fallback.savedAt),
      backup: true, error: r.error, issues: r.issues };
  }
  return { ok: false, data: null, cached: false, stale: false, ageMs: null, backup: false, error: r.error, issues: r.issues };
}

// Shortcut using the TTL table: cachedSource('forecast', 'forecast_43.673_27.832', fn, validate)
export function cachedSource(kind, name, fn, validate) {
  const t = TTL[kind];
  return cached(name, t.ttlMs, fn, { maxStaleMs: t.maxStaleMs, validate });
}

// Test helpers
export const settle = () => Promise.all([...inflight.values()]);
export const clearMemory = () => memory.clear();
export const memorySize = () => memory.size;
