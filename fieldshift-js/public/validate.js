// Input and result validation for FieldShift.
//  1. Crop names: exact / alias match, spelling suggestions ("Did you mean…?"), and a check that the
//     text looks like a plant name at all. Unknown names are checked against GBIF (server /api/plant).
//  2. A check list before the analysis starts.
//  3. Sanity checks on the data and on the results after the analysis.

// Other names farmers use for the crops we know (English, Bulgarian, common misspellings)
const ALIASES = {
  Wheat: ['common wheat', 'winter wheat', 'soft wheat', 'жито', 'пшеница', 'зимна пшеница', 'мека пшеница', 'wheet', 'weat'],
  'Durum wheat': ['durum', 'hard wheat', 'твърда пшеница', 'дурум'],
  Barley: ['winter barley', 'spring barley', 'ечемик', 'pivovaren', 'пивоварен ечемик'],
  Triticale: ['тритикале'],
  Oats: ['oat', 'овес'],
  Rye: ['ръж'],
  Rapeseed: ['rape', 'oilseed rape', 'canola', 'colza', 'рапица', 'маслодайна рапица'],
  Sunflower: ['sunflowers', 'слънчоглед', 'слънчогледи', 'sunflour'],
  Corn: ['maize', 'grain maize', 'silage maize', 'царевица', 'kukuruz', 'кукуруз'],
  Sorghum: ['сорго', 'sorgo'],
  Millet: ['просо', 'proso millet'],
  Soybean: ['soy', 'soya', 'soybeans', 'соя'],
  Peas: ['pea', 'field pea', 'field peas', 'грах', 'фуражен грах'],
  Chickpea: ['chickpeas', 'garbanzo', 'нахут'],
  Lentil: ['lentils', 'леща'],
  'Field beans': ['faba bean', 'fava bean', 'broad bean', 'бакла', 'фасул', 'beans'],
  Vetch: ['фий', 'common vetch', 'hairy vetch'],
  Alfalfa: ['lucerne', 'люцерна'],
  Coriander: ['кориандър', 'kolendro', 'колендро'],
  Buckwheat: ['елда'],
  'Sugar beet': ['beet', 'sugarbeet', 'захарно цвекло', 'цвекло'],
  Potatoes: ['potato', 'картофи', 'картоф'],
  Lavender: ['лавандула', 'lavandula', 'лавандула ангустифолия'],
};

const norm = s => s.toLowerCase().normalize('NFKC').replace(/[\s_\-.,;:'"]+/g, ' ').trim();

// classic edit distance (insert / delete / replace / swap of two letters)
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function dictionary(crops) {
  const out = [];
  for (const c of crops) {
    if (c.crop === 'Cover crop') continue;
    out.push({ term: norm(c.crop), crop: c.crop });
    if (c.nameBg) out.push({ term: norm(c.nameBg), crop: c.crop });
    for (const a of ALIASES[c.crop] ?? []) out.push({ term: norm(a), crop: c.crop });
  }
  return out;
}

// Does the text look like a word at all? Catches "123", "asdfgh", "xxxx", "!!".
export function looksLikeText(text) {
  const t = norm(text);
  if (t.length < 2) return { ok: false, reason: 'Too short to be a crop name.' };
  if (t.length > 40) return { ok: false, reason: 'Too long. Type just the crop name.' };
  if (!/\p{L}/u.test(t)) return { ok: false, reason: 'Use letters, not only numbers or symbols.' };
  if (/\d/.test(t)) return { ok: false, reason: 'Crop names don\'t contain numbers.' };
  if (/(.)\1\1/u.test(t.replace(/\s/g, ''))) return { ok: false, reason: 'This doesn\'t look like a crop name.' };
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && !/[aeiouyаъоуеиюяѝ]/i.test(letters)) return { ok: false, reason: 'This doesn\'t look like a crop name.' };
  if (/[a-z]/i.test(letters) && /[а-я]/i.test(letters)) return { ok: false, reason: 'Mixed Latin and Cyrillic letters. Check the keyboard layout.' };
  return { ok: true };
}

/**
 * Check one typed crop name.
 * Returns { status: 'empty' | 'known' | 'alias' | 'suggest' | 'invalid' | 'unknown', crop?, suggestions?, reason? }
 *  known   = exact crop name;  alias = another name we know (e.g. "maize" -> Corn)
 *  suggest = probably misspelled, with up to 3 suggestions;  invalid = not a plant name
 *  unknown = looks like a word but not in our list (we ask the closest group and check GBIF)
 */
export function checkCropName(text, crops) {
  const t = norm(text ?? '');
  if (!t) return { status: 'empty' };
  const dict = dictionary(crops);
  const exact = dict.find(d => d.term === t);
  if (exact) return { status: exact.term === norm(exact.crop) ? 'known' : 'alias', crop: exact.crop };
  const shape = looksLikeText(text);
  if (!shape.ok) return { status: 'invalid', reason: shape.reason };
  // spelling: closest terms, allowing ~1 typo per 4 letters
  const scored = dict.map(d => ({ ...d, dist: editDistance(t, d.term) }))
    .filter(d => d.dist <= Math.max(1, Math.floor(Math.max(t.length, d.term.length) / 4)))
    .sort((a, b) => a.dist - b.dist);
  const seen = new Set();
  const suggestions = scored.filter(d => !seen.has(d.crop) && seen.add(d.crop)).slice(0, 3).map(d => d.crop);
  if (suggestions.length) return { status: 'suggest', suggestions };
  return { status: 'unknown' };
}

// ---------- before the analysis ----------
// Each check: { level: 'ok' | 'warn' | 'error', text }
export function preAnalysisChecks({ field, situation, rows, mode, focusCrop, crops }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (!field) add('error', 'Select your field on the map.');
  else {
    if (field.areaHa < 0.1) add('error', `The field is very small (${(field.areaHa * 10).toFixed(1)} dka). Draw it bigger: satellites need at least ~1 dka.`);
    else if (field.areaHa > 2000) add('error', 'The field is larger than 20,000 dka. Draw a smaller field.');
    else add('ok', `Field selected (${Math.round(field.areaHa * 10).toLocaleString('en')} dka).`);
    const { lat, lon } = field.center ?? {};
    if (lat < 41.2 || lat > 44.3 || lon < 22.3 || lon > 28.7) add('warn', 'This field is outside Bulgaria. Climate data works anywhere, but prices, yields and pest advice are tuned for Bulgaria.');
  }
  if (situation === 'farm') {
    const filled = rows.filter(r => r.text.trim());
    if (!filled.length) add('error', 'Add at least one season you grew, or choose "I\'m starting out".');
    for (const r of filled) {
      if (r.status === 'invalid') add('error', `${r.year}: "${r.text}" ${r.reason ? `— ${r.reason}` : 'is not a crop name.'}`);
      else if (r.status === 'suggest') add('error', `${r.year}: "${r.text}" is not a crop we know. Did you mean ${r.suggestions.join(' or ')}?`);
      else if (r.status === 'unknown' && r.gbif?.found === false && !r.groupGuess) add('error', `${r.year}: "${r.text}" was not found in the world plant database (GBIF). Check the spelling.`);
      else if (r.status === 'unknown' && !r.crop) add('error', `${r.year}: we don't know "${r.text}". Pick the closest crop group next to it.`);
      else if (r.status === 'unknown') add('warn', `${r.year}: "${r.text}" is not in our crop list, so it's treated like ${r.crop}${r.gbif?.found ? ` (found in the GBIF plant database as ${r.gbif.scientificName})` : ''}.`);
    }
    const known = filled.filter(r => r.crop);
    if (known.length >= 3 && known.every(r => r.crop === known[0].crop) && !crops.find(c => c.crop === known[0].crop)?.perennial) {
      add('warn', `${known[0].crop} every year: monoculture. We'll show what it costs you.`);
    }
    if (filled.length && !filled.some(r => r.status === 'invalid' || r.status === 'suggest' || r.status === 'unknown')) {
      add('ok', `${filled.length} season${filled.length > 1 ? 's' : ''} of history, all crops recognised.`);
    }
  }
  if (mode === 'crop' && !focusCrop) add('error', 'Choose which crop you want to check.');
  return { checks: out, ok: !out.some(c => c.level === 'error') };
}

// ---------- after the analysis ----------
// Combines the server's data checks with sanity checks on our own results.
export function resultChecks({ data, ctx, strategies, prediction }) {
  const out = [];
  const add = (ok, group, text) => out.push({ ok, group, text });
  const label = { climate: 'NASA POWER climate', recent: 'NASA POWER recent weather', sentinel: 'ESA Sentinel-2', soil: 'ISRIC SoilGrids', terrain: 'NASA SRTM elevation', forecast: 'Weather forecast', radar: 'Sentinel-1 radar' };
  for (const [k, name] of Object.entries(label)) {
    const src = data[k];
    if (!src) continue;
    const chk = data.checks?.[k];
    if (!src.ok) { add(k === 'climate' ? false : null, 'Data', `${name}: not available (${src.error ? 'service unreachable' : 'no data'}).`); continue; }
    if (chk && !chk.ok) add(false, 'Data', `${name}: ${chk.issues.join('; ')}`);
    else add(true, 'Data', `${name}: values in a realistic range${src.cached ? ' (from cache)' : ''}.`);
  }
  // client-side sanity checks of the raw data (also work when the server didn't send checks)
  const years = ctx.sum.years.length;
  add(years >= 20, 'Data', `${years} complete years of climate (need at least 20).`);
  const s = data.sentinel?.ok ? data.sentinel.data : [];
  if (s.length) add(s.every(r => r.ndvi >= -1 && r.ndvi <= 1), 'Data', 'Satellite greenness (NDVI) values between −1 and 1.');
  const soil = ctx.soil;
  if (!soil.isDefault) add(Math.abs(soil.clayPct + soil.sandPct + soil.siltPct - 100) < 10, 'Data', 'Soil clay + sand + silt adds up to ~100%.');

  // results
  const finite = v => Number.isFinite(v);
  add(strategies.length === 3, 'Results', `Exactly 3 strategies compared (${strategies.length}).`);
  add(strategies.every(p => finite(p.profitNormal) && finite(p.profitBad) && p.profitBad <= p.profitNormal + 1), 'Results', 'Profit numbers are valid and a bad year never earns more than a normal year.');
  add(strategies.every(p => p.profitNormal > -2000 && p.profitNormal < 6000), 'Results', 'Profits are within a realistic range (−€200 to €600 per dka).');
  add(strategies.every(p => p.risk >= 0 && p.risk <= 100 && p.riskFuture >= 0 && p.riskFuture <= 100), 'Results', 'Good-season percentages are between 0 and 100.');
  add(ctx.cy.rows.length === ctx.cy.years.length * new Set(ctx.cy.rows.map(r => r.crop)).size, 'Results', `Stress test covers every crop in every one of the ${ctx.cy.years.length} seasons.`);
  if (prediction?.ok) {
    add(prediction.perCrop.every(x => x.p >= 0 && x.p <= 1), 'Results', 'Model probabilities are between 0 and 1.');
    add(prediction.eval.tests > 100, 'Results', `Prediction model validated on ${prediction.eval.tests} past crop-seasons (leave-one-out).`);
  }
  const failed = out.filter(c => c.ok === false).length;
  return { checks: out, passed: out.filter(c => c.ok).length, failed, total: out.filter(c => c.ok !== null).length };
}
