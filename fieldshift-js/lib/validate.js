// Plausibility checks for every data source. Pure functions -> { ok, issues: [string] }.
// A failed check means the data looks broken and should not be stored or trusted.

const num = x => typeof x === 'number' && Number.isFinite(x);
const MAX_ISSUES = 6;

function collector() {
  const issues = [];
  const counts = new Map();
  return {
    // groups repeated problems: "temp out of range on 3 rows"
    add(key, msg) { counts.set(key, (counts.get(key) ?? { msg, n: 0 })); counts.get(key).n++; },
    issue(msg) { issues.push(msg); },
    done() {
      for (const { msg, n } of counts.values()) issues.push(n > 1 ? `${msg} (${n} rows)` : msg);
      return { ok: issues.length === 0, issues: issues.slice(0, MAX_ISSUES) };
    },
  };
}

const inRange = (x, lo, hi) => num(x) && x >= lo && x <= hi;

// NASA POWER monthly rows: [{year, month, temp, tempMax, rainMm}]
export function validateClimate(rows) {
  const c = collector();
  if (!Array.isArray(rows)) { c.issue('climate data is not a list'); return c.done(); }
  const years = {};
  for (const r of rows) {
    const complete = num(r?.temp) && num(r?.rainMm);
    if (!complete) c.add('nan', 'missing or invalid number');
    else {
      if (!inRange(r.temp, -30, 45)) c.add('temp', 'temperature outside -30..45 °C');
      if (r.tempMax != null && !inRange(r.tempMax, -30, 45)) c.add('tmax', 'max temperature outside -30..45 °C');
      if (!inRange(r.rainMm, 0, 800)) c.add('rain', 'monthly rain outside 0..800 mm');
    }
    if (complete && Number.isInteger(r.year) && r.month >= 1 && r.month <= 12) (years[r.year] ??= new Set()).add(r.month);
  }
  const full = Object.values(years).filter(s => s.size === 12).length;
  if (full < 20) c.issue(`only ${full} complete years (need at least 20)`);
  return c.done();
}

// NASA POWER daily rows: [{date, temp, tempMax, rainMm}]
export function validateRecent(rows) {
  const c = collector();
  if (!Array.isArray(rows)) { c.issue('recent weather is not a list'); return c.done(); }
  let good = 0;
  for (const r of rows) {
    if (!num(r?.temp) || !num(r?.rainMm) || typeof r?.date !== 'string') { c.add('nan', 'missing or invalid number'); continue; }
    good++;
    if (!inRange(r.temp, -30, 45)) c.add('temp', 'temperature outside -30..45 °C');
    if (r.tempMax != null && !inRange(r.tempMax, -30, 45)) c.add('tmax', 'max temperature outside -30..45 °C');
    if (!inRange(r.rainMm, 0, 300)) c.add('rain', 'daily rain outside 0..300 mm');
  }
  if (good < 200) c.issue(`only ${good} days of weather (need at least 200)`);
  return c.done();
}

// Sentinel-2 rows: [{date, ndvi, savi, ndmi, bsi, bare, ndviStd?}]
export function validateSentinel(rows) {
  const c = collector();
  if (!Array.isArray(rows)) { c.issue('satellite data is not a list'); return c.done(); }
  for (const r of rows) {
    for (const k of ['ndvi', 'ndmi', 'savi', 'bsi']) {
      if (r?.[k] == null && k !== 'ndvi') continue; // ndvi is required, others may be missing
      if (!inRange(r?.[k], -1, 1)) c.add(k, `${k.toUpperCase()} outside -1..1`);
    }
    if (r?.ndviStd != null && !inRange(r.ndviStd, 0, 2)) c.add('std', 'NDVI spread is invalid');
  }
  if (rows.length < 20) c.issue(`only ${rows.length} satellite observations (need at least 20)`);
  for (let i = 1; i < rows.length; i++) {
    if (!(String(rows[i - 1]?.date) <= String(rows[i]?.date))) { c.issue('satellite dates are not in order'); break; }
  }
  return c.done();
}

// SoilGrids: {clayPct, sandPct, siltPct, socGKg, ph}
export function validateSoil(s) {
  const c = collector();
  if (!s || typeof s !== 'object') { c.issue('soil data missing'); return c.done(); }
  const sum = s.clayPct + s.sandPct + s.siltPct;
  if (!num(sum) || sum < 90 || sum > 110) c.issue(`clay + sand + silt = ${num(sum) ? Math.round(sum) : '?'}% (should be about 100%)`);
  if (!inRange(s.ph, 3, 10)) c.issue('soil pH outside 3..10');
  if (!num(s.socGKg) || s.socGKg < 0) c.issue('organic carbon is negative or missing');
  return c.done();
}

// Terrain: {elevationM, slopePct}
export function validateTerrain(t) {
  const c = collector();
  if (!t || typeof t !== 'object') { c.issue('terrain data missing'); return c.done(); }
  if (!inRange(t.elevationM, -50, 3000)) c.issue('elevation outside -50..3000 m');
  if (!inRange(t.slopePct, 0, 100)) c.issue('slope outside 0..100%');
  return c.done();
}

// Open-Meteo forecast: { days: [{date, tMax, tMin, rainMm, ...}] }
export function validateForecast(f) {
  const c = collector();
  const days = f?.days;
  if (!Array.isArray(days)) { c.issue('forecast has no days'); return c.done(); }
  if (days.length < 3) c.issue(`only ${days.length} forecast days (need at least 3)`);
  for (const d of days) {
    if (!num(d?.tMax) || !num(d?.tMin) || typeof d?.date !== 'string') { c.add('nan', 'missing forecast temperature'); continue; }
    if (d.tMin > d.tMax) c.add('order', 'min temperature above max');
    if (!inRange(d.tMax, -40, 50) || !inRange(d.tMin, -40, 50)) c.add('temp', 'forecast temperature out of range');
    if (d.rainMm != null && !(num(d.rainMm) && d.rainMm >= 0)) c.add('rain', 'negative or invalid rain');
  }
  return c.done();
}

// Sentinel-1 radar rows: [{date, vv, vh, rvi}]
export function validateRadar(rows) {
  const c = collector();
  if (!Array.isArray(rows)) { c.issue('radar data is not a list'); return c.done(); }
  if (rows.length < 10) c.issue(`only ${rows.length} radar observations (need at least 10)`);
  for (const r of rows) {
    if (!num(r?.vv) || !num(r?.vh) || r.vv < 0 || r.vh < 0) c.add('bs', 'invalid radar backscatter');
    if (!inRange(r?.rvi, 0, 4)) c.add('rvi', 'radar vegetation index out of range');
  }
  return c.done();
}
