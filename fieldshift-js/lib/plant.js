// Does this plant exist? Looks names up in GBIF (Global Biodiversity Information Facility).
// Scientific names via /species/match, common names (English, Bulgarian, ...) via vernacular search.
import { cachedSource } from './cache.js';

const UA = 'FieldShift/1.0 (NASA Space Apps 2026 hackathon project)';
const GBIF = 'https://api.gbif.org/v1/species';

export function checkPlantQuery(q) {
  const s = String(q ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { error: 'Please type a plant name.' };
  if (s.length > 60) return { error: 'Plant name is too long (max 60 characters).' };
  if (!/\p{L}/u.test(s)) return { error: 'Plant name must contain letters.' };
  return { q: s };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GBIF ${res.status}`);
  return res.json();
}

export async function gbifLookup(q) {
  // 1. scientific name (Latin letters only)
  if (/^[A-Za-z .×-]+$/.test(q)) {
    const m = await getJson(`${GBIF}/match?${new URLSearchParams({ name: q, kingdom: 'Plantae', verbose: 'false' })}`);
    const good = m && m.matchType && m.matchType !== 'NONE' && m.kingdom === 'Plantae'
      && (m.matchType === 'EXACT' || (m.confidence ?? 0) >= 90)
      && ['SPECIES', 'GENUS', 'SUBSPECIES', 'VARIETY', 'FORM'].includes(m.rank);
    if (good) {
      return { found: true, scientificName: m.scientificName ?? m.canonicalName, family: m.family ?? null, vernacularName: null, rank: m.rank, source: 'GBIF' };
    }
  }
  // 2. common name
  const s = await getJson(`${GBIF}/search?${new URLSearchParams({ q, qField: 'VERNACULAR', limit: '10' })}`);
  const ql = q.toLowerCase();
  const plants = (s?.results ?? []).filter(r => r.kingdom === 'Plantae');
  const vernOf = r => (r.vernacularNames ?? []).find(v => String(v.vernacularName).toLowerCase() === ql)
    ?? (r.vernacularNames ?? []).find(v => String(v.vernacularName).toLowerCase().includes(ql));
  const best = plants.find(r => vernOf(r)) ?? plants[0];
  if (!best) return { found: false };
  return {
    found: true,
    scientificName: best.scientificName ?? best.canonicalName,
    family: best.family ?? null,
    vernacularName: vernOf(best)?.vernacularName ?? null,
    rank: best.rank ?? null,
    source: 'GBIF',
  };
}

// Always resolves: { found:true, ... } | { found:false } | { error, offline:true }
export async function lookupPlant(raw) {
  const c = checkPlantQuery(raw);
  if (c.error) return { found: false, error: c.error, invalid: true };
  const key = `plant_${encodeURIComponent(c.q.toLowerCase()).replace(/%/g, '').slice(0, 100)}`;
  const r = await cachedSource('plant', key, () => gbifLookup(c.q));
  if (r.ok) return r.data;
  return { error: `Plant lookup unavailable (${r.error})`, offline: true };
}
