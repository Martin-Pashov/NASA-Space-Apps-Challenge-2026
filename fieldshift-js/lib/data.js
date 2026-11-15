// Cached, validated loaders for every data source. Used by /api/analyze and by field monitoring.
// Each returns the cache result: { ok, data, cached, stale, ageMs, backup, error, issues }.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import * as src from './sources.js';
import { cachedSource } from './cache.js';
import * as V from './validate.js';
import { geometryKey } from '../public/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pointKey = (lat, lon) => `${(+lat).toFixed(3)}_${(+lon).toFixed(3)}`;

export const SOURCES = {
  climate: { validate: V.validateClimate, load: (lat, lon) => cachedSource('climate', `climate_${pointKey(lat, lon)}`, () => src.getClimate(lat, lon), V.validateClimate) },
  recent: { validate: V.validateRecent, load: (lat, lon) => cachedSource('recent', `recent_${pointKey(lat, lon)}`, () => src.getRecentWeather(lat, lon), V.validateRecent) },
  soil: { validate: V.validateSoil, load: (lat, lon) => cachedSource('soil', `soil_${pointKey(lat, lon)}`, () => src.getSoil(lat, lon), V.validateSoil) },
  terrain: { validate: V.validateTerrain, load: (lat, lon) => cachedSource('terrain', `terrain_${pointKey(lat, lon)}`, () => src.getTerrain(lat, lon), V.validateTerrain) },
  forecast: { validate: V.validateForecast, load: (lat, lon) => cachedSource('forecast', `forecast_${pointKey(lat, lon)}`, () => src.getForecast(lat, lon), V.validateForecast) },
  sentinel: { validate: V.validateSentinel, load: geometry => cachedSource('sentinel', `sentinel_${geometryKey(geometry)}`, () => src.getSentinel(geometry), V.validateSentinel) },
  radar: { validate: V.validateRadar, load: geometry => cachedSource('radar', `radar_${geometryKey(geometry)}`, () => src.getSentinel1(geometry), V.validateRadar) },
};

// Reverse geocoding, cached 30 days per ~1 km cell.
export async function placeName(lat, lon) {
  const r = await cachedSource('reverse', `reverse_${(+lat).toFixed(2)}_${(+lon).toFixed(2)}`, () => src.reverseGeocode(lat, lon));
  return r.ok ? r.data : '';
}

// public/data/pests.json may not exist yet; re-read only when the file changes.
let pestsCache = { mtimeMs: -1, data: null };
export function loadPests() {
  const file = path.join(ROOT, 'public/data/pests.json');
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== pestsCache.mtimeMs) pestsCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return pestsCache.data;
  } catch { return null; }
}
