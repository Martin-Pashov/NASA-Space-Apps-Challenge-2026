// Shared test setup: isolated temp cache/data dirs, no real credentials, no .env file.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldshift-test-'));
export const CACHE = path.join(TMP, 'cache');
export const DATA = path.join(TMP, 'data');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FIELDSHIFT_CACHE_DIR = CACHE;
process.env.FIELDSHIFT_DATA_DIR = DATA;
process.env.FIELDSHIFT_NO_ENV_FILE = '1';
process.env.FIELDSHIFT_NO_LISTEN = '1';
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'CDSE_CLIENT_ID', 'CDSE_CLIENT_SECRET']) delete process.env[k];

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REAL_CACHE = path.join(ROOT, 'data/cache');
export const readReal = name => JSON.parse(fs.readFileSync(path.join(REAL_CACHE, `${name}.json`), 'utf8'));

export const realFetch = globalThis.fetch;
// Default: no internet, like the sandbox. Local requests (to the test server) pass through.
export function offline(handler) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opts);
    if (handler) { const r = await handler(u, opts); if (r) return r; }
    throw new TypeError('fetch failed');
  };
}
export const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Synthetic Open-Meteo-style forecast data object starting at `start` (YYYY-MM-DD).
export function forecastFrom(start, n = 16, patch = {}) {
  const days = [];
  const t0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  for (let i = 0; i < n; i++) {
    days.push({ date: new Date(t0 + i * 864e5).toISOString().slice(0, 10), tMax: 20, tMin: 10, tMean: 15, rainMm: 0, rainProb: 0, code: 1, gustKmh: 20, et0Mm: 2, ...(patch[i] ?? {}) });
  }
  return { source: 'Open-Meteo (ECMWF/DWD models)', days };
}
