import * as A from './analysis.js';
import * as M from './map.js';
import * as V from './validate.js';
import * as ML from './ml.js';
import * as AL from './alerts.js';

const $ = id => document.getElementById(id);
const r0 = x => Math.round(x);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const YEAR = new Date().getFullYear();
const HISTORY_YEARS = [YEAR, YEAR - 1, YEAR - 2, YEAR - 3, YEAR - 4]; // newest first, as farmers remember it
const REFERENCE_ROTATION = 'Wheat > Sunflower';
const SURE_DAYS = 7;   // forecast days used (the server fetches 7 days from today)
const SHOW_DAYS = 7;
const state = { crops: [], rotations: {}, pests: null, field: null, placeName: '', data: null, weights: null, ctx: null, overrides: {} };
const charts = {};

// ================= RECENT FIELDS (localStorage) =================

const RECENT_KEY = 'fieldshift.recent';
const loadRecent = () => {
  let list;
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  // drop near-duplicates (the same field saved twice with slightly different corners)
  return list.filter((r, i) => !list.slice(0, i).some(o => o.center && r.center && Math.abs(o.center.lat - r.center.lat) < 0.002 && Math.abs(o.center.lon - r.center.lon) < 0.003));
};
const saveRecent = list => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* storage unavailable */ } };

function rememberField() {
  const f = state.field;
  const entry = { name: state.placeName || 'Field', geometry: f.geometry, areaHa: f.areaHa, center: f.center, date: new Date().toISOString() };
  const key = JSON.stringify(f.geometry.coordinates);
  const near = r => r.center && f.center && Math.abs(r.center.lat - f.center.lat) < 0.002 && Math.abs(r.center.lon - f.center.lon) < 0.003;
  saveRecent([entry, ...loadRecent().filter(r => JSON.stringify(r.geometry.coordinates) !== key && !near(r))]);
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  $('recentWrap').hidden = !list.length;
  $('recent').innerHTML = list.map((r, i) =>
    `<span class="recent-item"><button class="go-recent" data-i="${i}" title="${esc(new Date(r.date).toLocaleDateString())}">📍 ${esc(r.name)} · ${areaTxt(r.areaHa)}</button>` +
    `<button class="x" data-i="${i}" aria-label="Remove">×</button></span>`).join('');
}

// ================= FIELD =================

let nameTimer;
function onFieldChange(field) {
  state.field = field;
  $('analyze').disabled = !field;
  $('clearField').hidden = !field;
  $('fieldCard').classList.toggle('empty', !field);
  $('goHint').textContent = field ? '' : 'Select a field on the map first.';
  refreshPreCheck(!!field && !!state.crops.length);
  if (!field) {
    $('fieldName').textContent = 'No field selected yet';
    $('fieldMeta').textContent = 'Click on the map, or use the ▭ and ⬠ tools on the left to draw your field.';
    $('fieldNote').textContent = '';
    return;
  }
  $('fieldName').textContent = state.placeName || 'Your field';
  $('fieldMeta').textContent = `${areaTxt(field.areaHa)} · ${field.center.lat.toFixed(4)}, ${field.center.lon.toFixed(4)}`;
  if (field.note) $('fieldNote').textContent = field.note;
  if (field.areaHa > 2000) $('fieldNote').textContent = 'This area is too large (max 20,000 dka / 2,000 ha). Please draw your field smaller.';
  clearTimeout(nameTimer);
  nameTimer = setTimeout(async () => {
    try {
      const r = await (await fetch(`/api/reverse?lat=${field.center.lat}&lon=${field.center.lon}`)).json();
      if (r.name && state.field) { state.placeName = r.name; $('fieldName').textContent = r.name; }
    } catch { /* name is optional */ }
  }, 600);
}

// ================= SEARCH =================

let results = [];
function pickResult(r) {
  $('searchResults').hidden = true;
  $('searchInput').value = r.name.split(',').slice(0, 2).join(',');
  state.placeName = r.name.split(',').slice(0, 2).join(',');
  M.zoomTo(r.lat, r.lon, 14);
}

async function search(e) {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.hidden = false;
  box.innerHTML = '<li>Searching…</li>';
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    results = await res.json();
    if (!res.ok) throw new Error(results.error);
    if (!results.length) { box.innerHTML = '<li>No results. Try a nearby town, or click on the map.</li>'; return; }
    box.innerHTML = results.map((r, i) => `<li data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(r.name)}</li>`).join('');
    M.zoomTo(results[0].lat, results[0].lon, 14); // Enter goes straight to the first result
    state.placeName = results[0].name.split(',').slice(0, 2).join(',');
    if (results.length === 1) box.hidden = true;
  } catch (err) {
    box.innerHTML = `<li>Search failed (${esc(err.message)}). Click on the map instead.</li>`;
  }
}

// ================= HISTORY =================

function historyRow(year) {
  const ago = YEAR - year;
  const when = ago === 0 ? 'this year' : ago === 1 ? 'last year' : `${ago} years ago`;
  const placeholder = ago === 0 ? 'e.g. Wheat / Пшеница, or any crop' : 'Type a crop, or leave empty';
  return `<div class="history-row" data-year="${year}">
    <label class="year" for="hist-${year}">${year}<small>${when}</small></label>
    <div class="history-input"><input id="hist-${year}" list="cropList" placeholder="${placeholder}" autocomplete="off">
      <button type="button" class="row-clear" aria-label="Clear ${year}" title="Clear" hidden>×</button></div>
    <span class="resolved"></span></div>`;
}

function syncClear(row) {
  row.querySelector('.row-clear').hidden = !row.querySelector('input').value;
}

// Each row is checked as you type: known crop, other name we know, misspelling ("Did you mean…?"),
// not a crop name at all, or a real plant we don't model yet (then GBIF confirms it exists).
function resolveRow(row) {
  const input = row.querySelector('input'), out = row.querySelector('.resolved');
  const text = input.value;
  const groupSel = out.querySelector('select.group');
  const chk = V.checkCropName(text, state.crops);
  Object.assign(row.dataset, { crop: '', status: chk.status, group: '' });
  row._chk = chk;
  row.classList.remove('bad');
  const ok = crop => { out.innerHTML = `<span class="tag ok">✓ ${esc(crop)}</span>`; row.dataset.crop = crop; };
  if (chk.status === 'empty') { out.innerHTML = ''; return; }
  if (chk.status === 'known' || chk.status === 'alias') return ok(chk.crop);
  if (chk.status === 'invalid') { out.innerHTML = `<span class="tag bad">✗ ${esc(chk.reason)}</span>`; row.classList.add('bad'); return; }
  // "sunflower seeds" -> Sunflower, "tomatoes" -> vegetable group (not a typo of "potatoes")
  const r = A.resolveCrop(text, state.crops, groupSel?.value || undefined);
  if (r?.known && !groupSel) { row.dataset.status = 'alias'; return ok(r.crop); }
  const guess = A.resolveCrop(text, state.crops)?.group ?? null;
  if (chk.status === 'suggest' && !guess && !groupSel) {
    out.innerHTML = `<span class="tag ask">Did you mean ${chk.suggestions.map(x => `<button type="button" class="sugg" data-s="${esc(x)}">${esc(x)}</button>`).join(' or ')}?</span>`;
    out.querySelectorAll('.sugg').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.s; out.innerHTML = ''; resolveRow(row); syncClear(row); $('historyError').hidden = true; }));
    return;
  }
  // a crop we don't model: ask which group it's closest to (pre-filled with our guess)
  row.dataset.status = 'unknown';
  row.dataset.group = guess ?? '';
  const chosen = groupSel?.value || r?.group || '';
  const options = Object.entries(A.GROUPS).map(([k, v]) => `<option value="${k}" ${k === chosen ? 'selected' : ''}>${v}</option>`).join('');
  out.innerHTML = `<select class="group" aria-label="Closest crop group"><option value="">Which group is it closest to?</option>${options}</select><span class="gbif"></span>`;
  out.querySelector('select').addEventListener('change', () => { resolveRow(row); $('historyError').hidden = true; refreshPreCheck(); });
  if (r?.crop) row.dataset.crop = r.crop;
  checkPlantExists(row, text);
}

// Is it a real plant? Ask the GBIF species database (through our server). Offline = no verdict.
const plantCache = {};
function checkPlantExists(row, text) {
  const q = text.trim().toLowerCase();
  const show = res => {
    row._gbif = res;
    const el = row.querySelector('.gbif');
    if (!el || row.querySelector('input').value.trim().toLowerCase() !== q) return;
    if (res?.found) el.innerHTML = `<span class="tag ok small" title="GBIF: ${esc(res.scientificName)}${res.family ? ` (${esc(res.family)})` : ''}">🌿 real plant: ${esc(res.scientificName)}</span>`;
    else if (res?.found === false) el.innerHTML = '<span class="tag bad small">Not found in the world plant database. Check the spelling.</span>';
    else el.innerHTML = '';
    refreshPreCheck();
  };
  row._gbif = plantCache[q];
  if (plantCache[q]) return show(plantCache[q]);
  clearTimeout(row._gbifTimer);
  row._gbifTimer = setTimeout(async () => {
    try { plantCache[q] = await (await fetch(`/api/plant?q=${encodeURIComponent(q)}`)).json(); }
    catch { plantCache[q] = { offline: true }; }
    show(plantCache[q]);
  }, 500);
}

function readHistory() {
  const rows = [...document.querySelectorAll('.history-row')];
  const filled = rows.filter(r => r.querySelector('input').value.trim());
  const blocked = filled.filter(r => !r.dataset.crop || ['invalid', 'suggest'].includes(r.dataset.status) || (r.dataset.status === 'unknown' && r._gbif?.found === false && !r.dataset.group));
  return {
    // oldest first: the analysis reads the list in growing order
    seasons: filled.filter(r => r.dataset.crop).map(r => ({ year: +r.dataset.year, label: r.querySelector('input').value.trim(), crop: r.dataset.crop }))
      .sort((a, b) => a.year - b.year),
    unresolved: blocked.length,
    rows: rows.map(r => ({ year: +r.dataset.year, text: r.querySelector('input').value, status: r.dataset.status || 'empty', crop: r.dataset.crop || null,
      suggestions: r._chk?.suggestions ?? [], reason: r._chk?.reason, gbif: r._gbif, groupGuess: r.dataset.group || null })),
  };
}

// The check list above the "Analyse" button
function currentChecks() {
  const situation = document.querySelector('[name=situation]:checked').value;
  const mode = document.querySelector('[name=mode]:checked').value;
  return V.preAnalysisChecks({ field: state.field, situation, rows: readHistory().rows, mode, focusCrop: $('focusCrop').value, crops: state.crops });
}
function refreshPreCheck(force) {
  const box = $('preCheck');
  if (!force && box.hidden) return;
  const { checks } = currentChecks();
  const icon = { ok: '✅', warn: '⚠️', error: '❌' };
  box.hidden = false;
  box.innerHTML = `<p class="small-label">Check before the analysis</p><ul>${checks.map(c => `<li class="${c.level}">${icon[c.level]} ${esc(c.text)}</li>`).join('')}</ul>`;
}

function fillPreset(list) {
  const crops = list ? list.split(',') : [];
  const rows = [...document.querySelectorAll('.history-row')];
  rows.forEach(row => {
    // this year gets the last crop in the list, earlier years walk back through the pattern
    const ago = YEAR - +row.dataset.year;
    row.querySelector('input').value = crops.length ? crops[crops.length - 1 - (ago % crops.length)] : '';
    row.querySelector('.resolved').innerHTML = '';
    resolveRow(row);
    syncClear(row);
  });
  refreshPreCheck();
}

// ================= PRIORITIES =================

// The three priorities the challenge asks for come first: water, soil, market & machinery.
const MAIN_PRIORITIES = [
  { keys: ['water'], chip: '💧 Water', hint: 'Crops that get by on the rain your field actually gets' },
  { keys: ['soil'], chip: '🌱 Soil', hint: 'Healthier soil: legumes, cover crops, less bare ground' },
  { keys: ['market', 'machinery'], chip: '🚜 Market & machinery', hint: 'Easy to sell, works with the equipment you have' },
];
const DEFAULT_ON = ['water', 'soil', 'risk'];

function renderPriorities() {
  $('prioritiesMain').innerHTML = MAIN_PRIORITIES.map(p =>
    `<label class="prio big" title="${esc(p.hint)}"><input type="checkbox" value="${p.keys.join(',')}" ${p.keys.some(k => DEFAULT_ON.includes(k)) ? 'checked' : ''}><b>${p.chip}</b><small>${p.hint}</small></label>`).join('');
  const inMain = MAIN_PRIORITIES.flatMap(p => p.keys);
  $('priorities').innerHTML = Object.entries(A.PRIORITIES).filter(([k]) => !inMain.includes(k)).map(([k, p]) =>
    `<label class="prio" title="${esc(p.hint)}"><input type="checkbox" value="${k}" ${DEFAULT_ON.includes(k) ? 'checked' : ''}><b>${p.chip}</b><small>${p.hint}</small></label>`).join('');
}

function priorityWeights() {
  const chosen = [...document.querySelectorAll('#prioritiesMain input:checked, #priorities input:checked')].flatMap(i => i.value.split(','));
  // what you picked counts fully; everything else only a little, so your choice really decides
  return Object.fromEntries(Object.keys(A.PRIORITIES).map(k => [k, chosen.length ? (chosen.includes(k) ? 10 : 0.3) : 5]));
}

// ================= ANALYSIS WITH LIVE PROGRESS =================

const STEPS = [
  { id: 'climate', title: 'Reading 25 years of climate', src: 'NASA POWER', required: true },
  { id: 'recent', title: 'Recent weather, last 12 months', src: 'NASA POWER', missing: 'Recent rain vs normal will be missing.' },
  { id: 'sentinel', title: 'Scanning your field with satellites (5 years, every 10 days)', src: 'ESA Sentinel-2', missing: 'Bare soil, moisture and crop vigor checks will be missing.' },
  { id: 'soil', title: 'Soil type, organic carbon and pH', src: 'ISRIC SoilGrids', missing: 'Typical loam soil values will be used instead.' },
  { id: 'terrain', title: 'Slope and elevation', src: 'NASA SRTM', missing: 'Slope-based erosion advice will be missing.' },
  { id: 'forecast', title: 'Weather forecast, next 7 days', src: 'ECMWF + DWD ICON', missing: 'Weather alerts and the forecast part of the season risk will be missing.' },
  { id: 'radar', title: 'Radar check through clouds', src: 'ESA Sentinel-1', missing: 'Not needed: optical satellite data is used instead.', optional: true },
  { id: 'stress', title: 'Stress-testing every crop against every past season', src: 'FieldShift' },
  { id: 'predict', title: 'Predicting next season\'s risk (machine learning)', src: 'FieldShift model' },
  { id: 'compare', title: 'Comparing 3 strategies, alerts and pest risk', src: 'FieldShift' },
  { id: 'checks', title: 'Checking data and results', src: 'FieldShift' },
];
const ICON = { waiting: '○', running: '◌', done: '✅', failed: '⚠️' };

function setStep(id, status, { ms, error, backup, cached, stale, ageMin } = {}) {
  const li = document.querySelector(`#steps li[data-id="${id}"]`);
  const s = STEPS.find(x => x.id === id);
  if (!li || !s) return; // a step the server added that this page doesn't know
  li.className = status;
  li.querySelector('.icon').textContent = ICON[status];
  li.querySelector('.time').textContent = ms != null ? `${(ms / 1000).toFixed(1)} s` : status === 'running' ? 'working…' : '';
  const why = li.querySelector('.why');
  if (status === 'failed') why.textContent = `Couldn't get this data (${plainError(error)}). ${s.missing ?? ''}`;
  else if (backup) why.textContent = 'Live request failed, used the last saved copy.';
  else if (cached) why.textContent = `${s.src} · loaded from cache${ageMin != null ? ` (${ageLabel(ageMin)} old)` : ''}${stale ? ', refreshing in the background' : ''}`;
  else why.textContent = s.src;
}

const ageLabel = m => (m < 60 ? `${Math.max(1, Math.round(m))} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

function plainError(e = '') {
  if (/credentials|login|401|403/i.test(e)) return 'satellite login is not set up';
  if (/timeout|abort/i.test(e)) return 'the service took too long to answer';
  if (/fetch failed|ENOTFOUND|network/i.test(e)) return 'no internet connection to the service';
  return e.length > 80 ? e.slice(0, 80) + '…' : e || 'unknown error';
}

async function analyze() {
  const situation = document.querySelector('[name=situation]:checked').value;
  const history = readHistory();
  refreshPreCheck(true);
  const pre = currentChecks();
  if (!pre.ok || (situation === 'farm' && (!history.seasons.length || history.unresolved))) {
    if (situation === 'farm' && (!history.seasons.length || history.unresolved)) {
      $('historyError').hidden = false;
      $('historyError').textContent = history.unresolved
        ? 'Fix the crops marked in red or pick the closest crop group.'
        : 'Add at least one season, or choose "I\'m starting out".';
      $('historyBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else $('preCheck').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  rememberField();

  state.situation = situation;
  state.monitorId = null; state.checks = null;
  $('monStatus').textContent = ''; $('monResult').innerHTML = '';
  state.history = history.seasons;
  state.weights = priorityWeights();

  $('start').hidden = true; $('progress').hidden = false; $('progressBack').hidden = true;
  $('progressField').textContent = `${state.placeName || 'Your field'} · ${areaTxt(state.field.areaHa)}`;
  $('progressNote').textContent = 'This usually takes 20–60 seconds. Satellite data takes the longest.';
  $('steps').innerHTML = STEPS.filter(s => !s.optional).map(s => `<li data-id="${s.id}" class="waiting"><span class="icon">${ICON.waiting}</span><span>${s.title}<span class="why">${s.src}</span></span><span class="time"></span></li>`).join('');
  window.scrollTo(0, 0);

  try {
    const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry: state.field.geometry }) });
    if (!res.ok) throw new Error((await res.json()).error);
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buf = '', result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (msg.type === 'step') {
          // optional steps (e.g. radar) only appear when the server runs them
          const s = STEPS.find(x => x.id === msg.id);
          if (s?.optional && !document.querySelector(`#steps li[data-id="${msg.id}"]`)) {
            document.querySelector('#steps li[data-id="stress"]').insertAdjacentHTML('beforebegin', `<li data-id="${s.id}" class="waiting"><span class="icon">${ICON.waiting}</span><span>${s.title}<span class="why">${s.src}</span></span><span class="time"></span></li>`);
          }
          setStep(msg.id, msg.status, msg);
        }
        if (msg.type === 'result') result = msg.data;
      }
    }
    if (!result) throw new Error('The server stopped before finishing.');
    if (!result.climate.ok) throw new Error(`NASA climate data is required and couldn't be loaded (${plainError(result.climate.error)}).`);
    state.data = result;

    const timed = async (id, fn) => {
      const t = performance.now();
      setStep(id, 'running');
      await new Promise(r => setTimeout(r, 30)); // let the browser paint the step
      fn();
      setStep(id, 'done', { ms: performance.now() - t });
    };
    await timed('stress', prepare);
    await timed('predict', predict);
    await timed('compare', renderAll);
    await timed('checks', renderChecks);
    $('progressNote').textContent = 'Done!';
    await new Promise(r => setTimeout(r, 700)); // let the farmer see everything finished
    $('progress').hidden = true; $('results').hidden = false; window.scrollTo(0, 0); watchSections();
  } catch (err) {
    $('progressNote').textContent = `Something went wrong: ${err.message}`;
    $('progressBack').hidden = false;
  }
}

// ================= UNITS =================
// Bulgarian farmers think in decares (1 dka = 0.1 ha); hectares on request.

const UNIT_KEY = 'fieldshift.unit';
state.unit = (() => { try { return localStorage.getItem(UNIT_KEY) || 'dka'; } catch { return 'dka'; } })();
const areaTxt = ha => (state.unit === 'dka' ? `${Math.round(ha * 10).toLocaleString('en')} dka` : `${ha.toFixed(1)} ha`);
const money = eurPerHa => {
  const v = state.unit === 'dka' ? eurPerHa / 10 : eurPerHa;
  const shown = Math.abs(v) < 10 && v !== 0 ? Math.abs(v).toFixed(1) : Math.abs(Math.round(v)).toString();
  return `${v < 0 && shown !== '0' && shown !== '0.0' ? '-' : ''}€${shown}/${state.unit}`;
};
const yieldToUi = tHa => (state.unit === 'dka' ? Math.round(tHa * 100) : +tHa.toFixed(2)); // kg/dka or t/ha
const yieldFromUi = v => (state.unit === 'dka' ? v / 100 : v);
const yieldUnit = () => (state.unit === 'dka' ? 'kg/dka' : 't/ha');

function setUnit(u) {
  state.unit = u;
  try { localStorage.setItem(UNIT_KEY, u); } catch { /* optional */ }
  document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === u));
  if (state.field) onFieldChange(state.field);
  renderRecent();
  if (state.ctx) renderAll();
}

// ================= RESULTS =================

if (window.Chart) { Chart.defaults.font.family = "'Golos Text', 'Segoe UI', system-ui, sans-serif"; Chart.defaults.color = '#6b665e'; Chart.defaults.borderColor = '#e7e9e2'; }

function drawChart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), { ...config, options: { responsive: true, maintainAspectRatio: false, animation: false, ...config.options } });
}
const list = items => `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`;
const effectiveCrops = () => state.crops.map(c => (state.overrides[c.crop] ? { ...c, ...state.overrides[c.crop] } : c));

// Heavy calculations that don't depend on the sliders or the user's own numbers
function prepare() {
  const d = state.data, crops = state.crops;
  const sum = A.climateSummary(d.climate.data);
  const soil = d.soil.data;
  const beginner = state.situation === 'new';
  const rotations = { ...state.rotations };
  let currentName, currentLabel, lastCrop = null, known = [];
  if (beginner) {
    currentName = REFERENCE_ROTATION; currentLabel = 'Typical rotation';
  } else {
    const plan = A.compressHistory(state.history.map(h => h.crop));
    currentName = `Your rotation: ${plan.join(' > ')}`;
    currentLabel = 'What you do now';
    for (const [name, r] of Object.entries(rotations)) if (A.sameRotation(r.plan, plan)) delete rotations[name];
    rotations[currentName] = { plan, type: 'current' };
    lastCrop = state.history.at(-1).crop;
    known = [...new Set(state.history.map(h => h.crop))];
  }
  const recent = d.recent.ok ? A.recentVsNormal(d.recent.data, sum) : null;
  const field = d.sentinel.ok ? A.fieldSummary(d.sentinel.data) : null;
  state.ctx = {
    sum, soil, beginner, rotations, currentName, currentLabel, lastCrop, known, recent, field,
    terrain: d.terrain.ok ? d.terrain.data : null,
    forecast: d.forecast?.ok ? d.forecast.data : null,
    // weather models are reliable for about 7-10 days; alerts only use that part
    forecastSure: d.forecast?.ok ? { ...d.forecast.data, days: d.forecast.data.days.slice(0, SURE_DAYS) } : null,
    cy: A.cropYears(d.climate.data, crops, soil.awcMm),
    cyFuture: A.cropYears(A.applyFuture(d.climate.data, sum, 2035), crops, soil.awcMm, d.climate.data),
    autumn: A.autumnCheck(recent, crops),
  };
}

// Machine-learning season risk (analog years); see ml.js
function predict() {
  const d = state.data, c = state.ctx;
  try {
    c.pred = ML.predictSeason({ climate: d.climate.data, cy: c.cy, crops: state.crops, recent: d.recent.ok ? d.recent.data : null, forecast: c.forecast });
  } catch (err) {
    console.error(err);
    c.pred = { ok: false, reason: 'The prediction model could not run on this data.' };
  }
}

function renderAll() {
  const d = state.data, c = state.ctx;
  document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === state.unit));
  $('placeName').textContent = state.placeName || 'Your field';
  $('coords').textContent = `${areaTxt(d.areaHa)} · ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
  $('historyLabel').textContent = c.beginner ? 'Starting out on this land.' : `You grew: ${state.history.map(h => `${h.year} ${h.label}`).join(', ')}`;
  $('basics').hidden = !c.beginner;

  const currentPlan = c.rotations[c.currentName].plan;
  const insights = A.buildInsights({ sum: c.sum, recent: c.recent, field: c.field, soil: c.soil, terrain: c.terrain, cyNow: c.cy, cyFuture: c.cyFuture, crops: state.crops, currentPlan });
  $('insights').innerHTML = insights.map(x => `<div class="insight ${x.level}"><h3>${x.title}</h3><p>${x.text}</p><span class="src">Source: ${x.source}</span></div>`).join('');

  renderSatHistory();
  renderCharts();
  renderAdjust();
  renderOwnNumbers();
  renderDecision();
  renderPastYears();
  renderGuide();
  setView(state.view);
}

// Everything that depends on the chosen strategy (re-run when priorities or prices change)
function renderDecision() {
  renderStrategies();
  renderAlerts();
  renderPrediction();
  renderPests();
  renderMonitorPreview();
  if (state.checks) renderChecks();
}

// Year-by-year check: lets you compare the model with real yields for a specific year
function renderPastYears() {
  const c = state.ctx, sel = $('pastCrop');
  const names = [...new Set(c.cy.rows.map(r => r.crop))].sort();
  if (!names.includes(state.pastCrop)) state.pastCrop = names.includes(c.lastCrop) ? c.lastCrop : names.includes('Wheat') ? 'Wheat' : names[0];
  sel.innerHTML = names.map(n => `<option${n === state.pastCrop ? ' selected' : ''}>${esc(n)}</option>`).join('');
  sel.onchange = () => { state.pastCrop = sel.value; renderPastYears(); };

  const crop = state.crops.find(x => x.crop === state.pastCrop);
  const rows = c.cy.rows.filter(r => r.crop === state.pastCrop).sort((a, b) => b.year - a.year);
  const autumn = A.isAutumnSown(crop);
  const good = rows.filter(r => r.ok).length;
  const cause = r => [!r.sowOk && 'too dry at sowing', !r.keyOk && 'dry winter and spring', r.keyOk && !r.waterOk && 'too little rain while growing', !r.heatOk && 'too hot'].filter(Boolean).join(', ');
  const need = Math.round((rows[0]?.need ?? 0) * 0.75);
  const normal = Math.round(rows[0]?.keyNormal ?? 0), minKey = Math.round((rows[0]?.keyNormal ?? 0) * 0.8);
  $('pastTable').innerHTML = `<caption class="muted">${good} good seasons out of ${rows.length}. A season is bad if any check fails (red).</caption>
    <tr><th>Year</th>${autumn ? `<th>Rain at sowing<br><small>need ${crop.sowRainMm} mm</small></th>` : ''}
    <th>Rain ${rows[0]?.keyMonths ?? ''}<br><small>normal ${normal} mm, need ${minKey}</small></th>
    <th>Season rain + soil water<br><small>need ${need} mm</small></th>
    <th>Hottest key month<br><small>limit ${crop.heatLimitC} °C</small></th><th>Result</th></tr>` +
    rows.map(r => `<tr><td>${r.year}</td>
      ${autumn ? `<td class="${r.sowOk ? '' : 'mismatch'}">${r.sowRain == null ? '–' : Math.round(r.sowRain) + ' mm'}</td>` : ''}
      <td class="${r.keyOk ? '' : 'mismatch'}">${Math.round(r.keyWater)} mm (${Math.round(r.keyWater / r.keyNormal * 100)}%)</td>
      <td class="${!r.keyOk || r.waterOk ? '' : 'mismatch'}">${Math.round(r.seasonRain + r.awcMm)} mm</td>
      <td class="${r.heatOk ? '' : 'mismatch'}">${r.peakTemp.toFixed(1)} °C</td>
      <td>${r.ok ? '✅ Good' : `❌ Bad: ${cause(r)}`}</td></tr>`).join('');
}

function renderSatHistory() {
  const rows = A.satelliteHistory(state.ctx.field, state.ctx.beginner ? null : state.history, state.crops);
  const box = $('satHistory');
  box.hidden = !rows.length;
  if (!rows.length) return;
  const label = { autumn: 'Autumn-sown crop (green in March–April, like wheat, barley, rapeseed)', spring: 'Spring crop (bare in spring, like sunflower, corn)', bare: 'Mostly bare' };
  const mismatches = rows.filter(r => r.match === false);
  box.innerHTML = `<h2>${state.ctx.beginner ? 'What grew here in recent years (seen from space)' : 'What grew here: satellites vs your memory'}</h2>
    <p class="muted">Satellites can tell crops sown in autumn from crops sown in spring, because autumn crops are already green in March–April.</p>
    ${mismatches.length ? `<p class="insight warn">In ${mismatches.map(r => r.year).join(', ')} the satellites saw something different from what you entered. Please check: the recommendations use your history.</p>` : (state.ctx.beginner ? '' : '<p class="insight good">The satellites agree with the history you entered.</p>')}
    <div class="table-wrap"><table class="sat-table"><tr><th>Year</th><th>Satellites saw</th>${state.ctx.beginner ? '' : '<th>You entered</th><th></th>'}</tr>
    ${rows.map(r => `<tr><td>${r.year}</td><td>${label[r.saw]}</td>${state.ctx.beginner ? '' : `<td>${r.entered ? esc(r.entered) : '–'}</td><td class="${r.match === false ? 'mismatch' : r.match ? 'ok' : ''}">${r.match === false ? '⚠️ check' : r.match ? '✓' : ''}</td>`}</tr>`).join('')}
    </table></div>`;
}

function renderCharts() {
  const d = state.data, c = state.ctx;
  const sent = d.sentinel.ok ? d.sentinel.data : [];
  if (sent.length) {
    const yearTick = (_, i) => { const date = sent[i]?.date; return date && (i === 0 || sent[i - 1].date.slice(0, 4) !== date.slice(0, 4)) ? date.slice(0, 4) : ''; };
    drawChart('fieldChart', { type: 'line', data: { labels: sent.map(r => r.date), datasets: [
      { label: 'Greenness', data: sent.map(r => r.ndvi), borderColor: '#2f6b3a', backgroundColor: 'rgba(47,107,58,.12)', fill: true, pointRadius: 0, tension: 0.3 },
      { label: 'Moisture', data: sent.map(r => r.ndmi), borderColor: '#2f6690', pointRadius: 0, tension: 0.3, borderWidth: 1.5 },
    ] }, options: { scales: { x: { ticks: { autoSkip: false, maxRotation: 0, callback: yearTick } } } } });
    $('fieldChartNote').textContent = d.sentinel.backup ? 'Showing the last saved satellite data (live request failed).' : '';
  } else {
    charts.fieldChart?.destroy();
    $('fieldChartNote').textContent = `No satellite history available: ${plainError(d.sentinel.error)}.`;
  }
  if (c.recent) {
    drawChart('rainChart', { type: 'bar', data: { labels: c.recent.months.map(m => m.label), datasets: [
      { label: 'Rain this year', data: c.recent.months.map(m => r0(m.rain)), backgroundColor: '#2f6690', borderRadius: 3 },
      { label: 'Normal year', data: c.recent.months.map(m => r0(m.normal)), type: 'line', borderColor: '#2b241d', backgroundColor: '#2b241d', pointRadius: 2 },
    ] } });
  }
  drawChart('tempChart', { type: 'line', data: { labels: c.sum.years, datasets: [
    { label: 'Avg temp', data: c.sum.yearlyTemp.map(t => +t.toFixed(1)), borderColor: '#9e3b2e', pointRadius: 0, tension: 0.3 },
  ] }, options: { plugins: { legend: { display: false } } } });
  const n = c.cy.years.length;
  const ranks = A.rankCrops(c.cy, state.crops).slice(0, 14);
  const okN = (cy, name) => cy.rows.filter(r => r.crop === name && r.ok).length;
  drawChart('cropChart', { type: 'bar', data: { labels: ranks.map(r => r.crop), datasets: [
    { label: `Good seasons (of ${n})`, data: ranks.map(r => okN(c.cy, r.crop)), backgroundColor: '#2f6b3a', borderRadius: 3 },
    { label: 'By 2035 (trend)', data: ranks.map(r => okN(c.cyFuture, r.crop)), backgroundColor: '#e0b12f', borderRadius: 3 },
  ] }, options: { indexAxis: 'y', scales: { x: { max: n, ticks: { stepSize: 4 } } } } });
}

function renderAdjust() {
  $('adjust').innerHTML = Object.entries(A.PRIORITIES).map(([k, p]) =>
    `<label>${p.chip} <input type="range" min="0" max="10" value="${state.weights[k]}" data-w="${k}"><b>${state.weights[k]}</b></label>`).join('');
  document.querySelectorAll('[data-w]').forEach(s => s.addEventListener('input', () => {
    s.nextElementSibling.textContent = s.value;
    state.weights[s.dataset.w] = +s.value;
    renderDecision();
  }));
}

// Editable yields and prices for the crops that appear in the options
function renderOwnNumbers(names) {
  const c = state.ctx;
  names ??= [...new Set(Object.values(c.rotations).flatMap(r => r.plan.map(i => i.split('+').at(-1))))];
  const show = state.crops.filter(x => state.ownCrops?.includes(x.crop) ?? names.includes(x.crop));
  const eff = Object.fromEntries(effectiveCrops().map(x => [x.crop, x]));
  $('ownNumbers').innerHTML = `<div class="row head"><span>Crop</span><span>Yield (${yieldUnit()})</span><span>Price (€/t)</span></div>` +
    show.map(x => `<div class="row"><span>${x.crop}</span>
      <input type="number" min="0" step="any" data-own="yield" data-crop="${x.crop}" value="${yieldToUi(eff[x.crop].yieldTHa)}">
      <input type="number" min="0" step="any" data-own="price" data-crop="${x.crop}" value="${eff[x.crop].priceEurT}"></div>`).join('') +
    '<button type="button" class="chip-btn" id="resetOwn">Reset to regional estimates</button>';
  document.querySelectorAll('[data-own]').forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!(v >= 0)) return;
    const o = (state.overrides[inp.dataset.crop] ??= {});
    if (inp.dataset.own === 'yield') o.yieldTHa = yieldFromUi(v); else o.priceEurT = v;
    renderDecision();
  }));
  $('resetOwn').addEventListener('click', () => { state.overrides = {}; renderOwnNumbers(); renderDecision(); });
}

const VERDICT_ORDER = { better: 0, now: 1, similar: 2, worse: 3 };

// The season-risk model in one sentence, using the chance of a good season (one number, not two)
const chanceWord = p => (p >= 0.75 ? 'good' : p >= 0.55 ? 'fair' : 'poor');
function seasonLine() {
  const c = state.ctx, pred = c.pred, m = pred?.ok ? pred.byCrop[c.nextCrop] : null;
  if (!m) return '';
  return `<p class="season-line">📈 Chance of a good ${pred.harvestYear} season for ${esc(c.nextCrop)}: <b>${r0(m.p * 100)}% (${chanceWord(m.p)})</b>, usually ${r0(m.base * 100)}%. This autumn looks most like ${m.analogs[0].year}.</p>`;
}

// The evidence for one strategy, each line with the dataset it comes from
function strategyData(p, current, e) {
  const c = state.ctx, n = c.cy.years.length;
  const ok = (cy, crop) => cy.rows.filter(r => r.crop === crop && r.ok).length;
  const out = [`<b>NASA POWER</b>, ${n} seasons of rain and temperature on this field: good seasons ${p.unique.map(x => `${esc(x)} ${ok(c.cy, x)}/${n}`).join(' · ')}.`];
  out.push(`<b>NASA POWER trend</b> (${c.sum.tempTrendDecade >= 0 ? '+' : ''}${c.sum.tempTrendDecade.toFixed(1)} °C per decade): good seasons ${r0(p.risk)}% today → ~${r0(p.riskFuture)}% by 2035.`);
  out.push(`<b>NASA POWER</b>: ${c.sum.droughtYearsRecent} of the last 10 summers were drought summers here; this rotation needs ~${r0(p.waterDemand)} mm of water a year.`);
  if (c.field?.bareDays != null) out.push(`<b>ESA Sentinel-2</b>: your field was bare ~${c.field.bareDays} days in the last 12 months; this rotation leaves ~${p.bare.toFixed(1)} bare months a year${p.rotation !== current.rotation ? ` (now ${current.bare.toFixed(1)})` : ''}.`);
  else out.push(`<b>Bare soil</b>: ~${p.bare.toFixed(1)} bare months a year (from sowing and harvest dates; no satellite data for this field).`);
  if (!c.soil.isDefault) out.push(`<b>ISRIC SoilGrids</b>: ${c.soil.texture.toLowerCase()} soil, organic carbon ${c.soil.socGKg.toFixed(1)} g/kg${p.legumes.length ? `; ${p.legumes.join(', ')} add${p.legumes.length === 1 ? 's' : ''} nitrogen (~${money(p.nSavedEur)} fertilizer saved a year)` : ''}.`);
  if (c.terrain) out.push(`<b>NASA SRTM</b>: slope ${c.terrain.slopePct.toFixed(1)}%${c.terrain.slopePct > 3 ? ', so soil cover against erosion matters' : ''}.`);
  const pr = c.pred?.ok ? c.pred.byCrop[p.mains[0]] : null;
  if (pr) out.push(`<b>FieldShift model</b> (NASA POWER + forecast): chance of a good ${c.pred.harvestYear} season for ${esc(p.mains[0])}: ${r0(pr.p * 100)}% (usually ${r0(pr.base * 100)}%).`);
  return out;
}

// What the data can't tell us about this strategy
function strategyGaps(p, e) {
  const c = state.ctx, out = [];
  out.push('Yields and prices are regional estimates: enter your own under "Use your own yields and prices".');
  if (!c.field) out.push('No satellite history for this field, so bare soil and crop growth come from typical dates.');
  if (c.soil.isDefault) out.push('Soil data was unavailable; typical loam soil was assumed.');
  if (e.newCrops.length) out.push(`Buyers and machinery for ${e.newCrops.join(', ')} near you are not checked.`);
  out.push('Weather is a ~50 km grid, not a station on your field.');
  return out;
}

function renderStrategies() {
  const c = state.ctx, crops = effectiveCrops(), weights = state.weights;
  const ranked = A.scoreRotations({ rotations: c.rotations, crops, cy: c.cy, cyFuture: c.cyFuture, soil: c.soil, field: c.field, weights, known: c.known });
  const focus = document.querySelector('[name=mode]:checked').value === 'crop' ? $('focusCrop').value : null;
  // the challenge: the current rotation (baseline) + exactly 2 new strategies
  const picks = A.pickStrategies(ranked, c.currentName, focus, c.currentLabel).slice(0, 3);
  state.picks = picks;
  const current = ranked.find(r => r.rotation === c.currentName);
  // the suggestion: an option that is clearly better for the farmer (see A.verdict), best one first
  const others = picks.filter(p => p.rotation !== c.currentName)
    .sort((a, b) => (A.verdict(b, current).key === 'better') - (A.verdict(a, current).key === 'better') || b.score - a.score);
  const best = others[0];
  // only suggest a change when it's clearly better, never keep a monoculture
  const mono = current.mains.every(m => m === current.mains[0]) && !crops.find(x => x.crop === current.mains[0]).perennial;
  const keep = !c.beginner && !mono && A.verdict(best, current).key !== 'better';
  const n = c.cy.years.length;
  const sugPlan = (keep || !best ? current : best).plan;
  c.nextItem = A.nextCrop(sugPlan, c.lastCrop, crops);
  c.nextCrop = c.nextItem.split('+').at(-1);
  c.suggestion = keep || !best ? current : best;
  // crops that matter for alerts and pests: the next crop first, then the rest of the suggested rotation
  c.fieldCrops = [...new Set([c.nextCrop, ...c.suggestion.mains].filter(Boolean))];

  // ---- answer card
  const sug = keep || !best ? current : best; // the rotation the answer card recommends
  const ans = A.buildAnswer({ best, current, lastCrop: c.lastCrop, crops, cy: c.cy, autumn: c.autumn, money, beginner: c.beginner, keep });
  const eyebrow = c.beginner ? 'Our suggestion to start' : keep ? 'Your rotation already fits well' : mono ? `Growing only ${current.mains[0]} is costing you` : 'Our suggestion';
  $('answer').innerHTML = `<div class="eyebrow">${eyebrow}</div>
    <h2>${esc(ans.title)}</h2><p class="when">🗓️ ${esc(ans.when)}</p>
    <div class="facts">
      <div class="fact" title="Out of the last 24 years, the share with enough rain and no damaging heat for these crops on your field"><span>Good seasons ⓘ</span><b>${r0(sug.risk)}%</b></div>
      <div class="fact" title="Profit after typical growing costs, before rent and subsidies, in a typical year"><span>Normal year ⓘ</span><b>${money(sug.profitNormal)}</b></div>
      <div class="fact" title="Profit in about 1 year out of 10 (a drought or heat year). A minus means a loss."><span>Bad year (1 in 10) ⓘ</span><b>${money(sug.profitBad)}</b></div>
    </div>
    ${seasonLine()}
    ${list(ans.reasons.map(esc))}
    ${ans.how ? `<div class="how">🌱 ${esc(ans.how)}</div>` : ''}
    ${ans.tradeOff ? `<div class="risk">💶 ${esc(ans.tradeOff)}</div>` : ''}
    ${ans.risk ? `<div class="risk">⚠️ ${esc(ans.risk)}</div>` : ''}
    <p class="rotation">${keep ? 'Keep' : c.beginner ? 'Suggested rotation' : 'Suggested rotation for the next years'}: <b>${esc(ans.rotation.replace(/^Your rotation: /, ''))}</b>. See the comparison below.</p>`;

  // ---- crop verdict (single-crop mode) and crop table
  const ranks = A.rankCrops(c.cy, crops);
  const okN = (cy, name) => cy.rows.filter(r => r.crop === name && r.ok).length;
  const dryNow = new Set(c.autumn.filter(a => a.dry).map(a => a.crop));
  const box = $('verdictBox');
  box.hidden = !focus;
  if (focus) {
    const v = A.cropVerdict(focus, c.cy, c.cyFuture, crops);
    box.className = `card ${v.level}`;
    box.innerHTML = `<h2>${v.verdict}</h2><p>${v.detail}</p><p>${v.note}</p>` +
      (dryNow.has(focus) ? '<p>⚠️ This autumn was too dry at sowing time for this crop.</p>' : '') +
      (v.alternatives.length ? `<p><b>More reliable here:</b> ${v.alternatives.map(a => `${a.crop} (${okN(c.cy, a.crop)} of ${n} good seasons)`).join(', ')}.</p>` : '');
  }
  $('cropTable').innerHTML = `<tr><th>Crop</th><th>Good seasons</th><th>By 2035 (trend)</th><th>Expected profit</th><th>Sowing time</th></tr>` +
    ranks.slice(0, 10).map(r => {
      const k = crops.find(x => x.crop === r.crop);
      return `<tr><td>${r.crop}${r.legume ? ' 🌱' : ''}${dryNow.has(r.crop) ? ' ⚠️' : ''}</td><td>${okN(c.cy, r.crop)} of ${n}</td><td>${okN(c.cyFuture, r.crop)} of ${n}</td><td>${money(r.profit)}</td><td>${k.sowWindow}</td></tr>`;
    }).join('');

  // ---- comparison table: plain words, best value highlighted
  const chosen = Object.entries(weights).filter(([, w]) => w >= 5).map(([k]) => k);
  const extra = { cost: 'Costs (higher = cheaper)', labor: 'Work needed (higher = less)', machinery: 'Fits your machinery', market: 'Easy to sell', forage: 'Animal feed value', pests: 'Breaks pests & diseases', subsidies: 'Fits EU eco-schemes' };
  const level = v => (v >= 70 ? 'High' : v >= 40 ? 'Medium' : 'Low');
  const rows = [
    ['Good seasons, last 24 years', p => `${r0(p.risk)}%`, 'max', p => p.risk],
    ['Good seasons by 2035 (if trends continue)', p => `${r0(p.riskFuture)}%`, 'max', p => p.riskFuture],
    ['Profit in a normal year', p => money(p.profitNormal), 'max', p => p.profitNormal],
    ['Profit in a bad year', p => money(p.profitBad), 'max', p => p.profitBad],
    ['Bare soil (months per year)', p => p.bare.toFixed(1), 'min', p => p.bare],
    ['Water needed (mm per year)', p => r0(p.waterDemand), 'min', p => p.waterDemand],
    ['Fertilizer saved', p => money(p.nSavedEur), 'max', p => p.nSavedEur],
    ...chosen.filter(k => extra[k]).map(k => [extra[k], p => level(p[k]), 'max', p => p[k]]),
    ['Switching effort', p => p.difficulty, null],
  ];
  $('compare').innerHTML = `<tr><th></th>${picks.map(p => { const v = A.verdict(p, current); return `<th>${p.label}<br><b style="color:var(--text)">${esc(p.rotation.replace(/^Your rotation: /, ''))}</b>${v.key === 'now' ? '' : `<br><span class="chip ${v.key}">${v.text}</span>`}</th>`; }).join('')}</tr>` +
    rows.map(([label, fmt, dir, val]) => {
      const target = dir ? (dir === 'max' ? Math.max(...picks.map(val)) : Math.min(...picks.map(val))) : null;
      return `<tr><td>${label}</td>${picks.map(p => `<td class="${dir && val(p) === target ? 'best' : ''}">${fmt(p)}</td>`).join('')}</tr>`;
    }).join('');

  // ---- 3 strategy cards: why we suggest it, NASA/ESA data behind it, benefits, risks and data gaps
  const ctx = { crops, cy: c.cy, field: c.field, soil: c.soil, terrain: c.terrain, sum: c.sum, weights, known: c.known, beginner: c.beginner, money };
  const allNew = new Set();
  const letters = ['A', 'B', 'C'];
  const chosenLabels = Object.entries(weights).filter(([, w]) => w >= 5).map(([k]) => A.PRIORITIES[k].chip);
  $('prioLine').innerHTML = chosenLabels.length ? `Ranked by what matters to you: ${chosenLabels.map(x => `<span class="chip-static">${esc(x)}</span>`).join(' ')}` : '';
  $('strategies').innerHTML = picks.map((p, i) => {
    const e = A.explainStrategy(p, current, ctx);
    e.newCrops.forEach(x => allNew.add(x));
    const v = A.verdict(p, current);
    const isCur = p.rotation === c.currentName;
    const data = strategyData(p, current, e);
    const gaps = strategyGaps(p, e);
    const benefits = isCur ? [c.beginner ? 'The most common rotation in Bulgaria: machinery, seed and buyers are easy to find.' : 'No switching costs: you know these crops, have the machinery and the buyers.'] : e.benefits;
    const isPick = p.rotation === c.suggestion.rotation;
    return `<article class="strategy ${isCur ? 'current' : ''} ${isPick ? 'pick' : ''}">
      <div class="head"><span class="kind">Strategy ${letters[i]} · ${esc(isCur ? (c.beginner ? 'Typical rotation (baseline)' : 'Your rotation now (baseline)') : p.label)}</span>${isPick ? '<span class="chip better simple-only">⭐ Our pick</span>' : ''}${v.key === 'now' ? '' : `<span class="chip ${v.key} detail-only">${v.text}</span>`}</div>
      <h3>${esc(p.rotation.replace(/^Your rotation: /, ''))}</h3>
      <div class="facts"><div class="fact"><span>Good seasons</span><b>${r0(p.risk)}%</b></div>
        <div class="fact"><span>Normal year</span><b>${money(p.profitNormal)}</b></div>
        <div class="fact"><span>Bad year</span><b>${money(p.profitBad)}</b></div></div>
      <p class="simple-only strat-simple">${e.why}</p>
      <div class="detail-only strat-sections">
        <section><h4>🎯 Why we suggest it</h4><p>${e.why}</p></section>
        <section><h4>🛰️ NASA &amp; ESA data behind it</h4>${list(data)}</section>
        <section><h4>✅ Benefits</h4>${list(benefits)}</section>
        <section><h4>⚠️ Risks and gaps in the data</h4>${list([...e.risks, ...gaps])}</section>
      </div></article>`;
  }).join('');
  $('gaps').innerHTML = A.infoGaps({ field: c.field, soil: c.soil, weights, newCrops: [...allNew] }).map(g => `<li>${g}</li>`).join('');

  $('ranking').innerHTML = '<tr><th>#</th><th>Rotation</th><th>Fit</th><th>Good seasons</th><th>Normal year</th><th>Bad year</th><th>Bare months</th></tr>' +
    // grouped like a farmer reads it: better options first, then yours, then similar, then worse
    [...ranked].map(r => ({ r, v: A.verdict(r, current) }))
      .sort((a, b) => VERDICT_ORDER[a.v.key] - VERDICT_ORDER[b.v.key] || b.r.score - a.r.score)
      .map(({ r, v }, i) => `<tr><td>${i + 1}</td><td>${esc(r.rotation.replace(/^Your rotation: /, 'Yours: '))}</td><td><span class="chip ${v.key}">${v.key === 'now' && c.beginner ? 'Typical rotation' : v.text}</span></td>` +
      `<td>${r0(r.risk)}%</td><td>${money(r.profitNormal)}</td><td>${money(r.profitBad)}</td><td>${r.bare.toFixed(1)}</td></tr>`).join('');
}

// ================= ALERTS =================

const ALERT_ICON = { hail: '🧊', flood: '🌊', drought: '☀️', frost: '❄️', heat: '🔥', wind: '💨', storm: '⛈️', pest: '🐛', disease: '🍄', vegetation: '🛰️', nutrient: '🧪' };
const CHANNEL = { call: '📞 call', sms: '💬 SMS', app: '📱 app' };

function computeAlerts() {
  const c = state.ctx, d = state.data;
  try {
    return AL.buildAlerts({ forecast: c.forecastSure, sentinel: d.sentinel.ok ? d.sentinel.data : null, crops: c.fieldCrops, pests: state.pests, recent: c.recent });
  } catch (err) { console.error('alerts', err); return []; }
}

// Why the forecast is missing, in words (also printed in the browser console for debugging)
function forecastProblem() {
  const f = state.data.forecast;
  if (!f) return 'this server is an older version without forecasts: stop it and run npm start again';
  if (f.issues?.length) return `data check failed: ${f.issues.join('; ')}`;
  console.warn('Forecast failed:', f.error);
  return plainError(f.error);
}

function renderAlerts() {
  const c = state.ctx;
  c.alerts = computeAlerts();
  const al = c.alerts, L = AL.LEVELS;
  const major = al.filter(a => a.level === 'urgent' || a.level === 'warning');
  const minor = al.length - major.length;
  const item = a => `<div class="alert lvl-${a.level}${a.level === 'urgent' || a.level === 'warning' ? '' : ' detail-only'}">
      <span class="badge">${L[a.level].label}<small>${L[a.level].labelBg}</small></span>
      <div><h3>${ALERT_ICON[a.type] ?? '⚠️'} ${esc(a.title)}</h3><p>${esc(a.text)}</p>${a.action ? `<p class="action">👉 ${esc(a.action)}</p>` : ''}
      <span class="src">${esc(a.when ?? '')} · ${esc(a.source ?? '')} · sent by ${(a.channels ?? L[a.level].channels).map(x => CHANNEL[x]).join(', ')}</span></div></div>`;
  $('alertsSec').classList.toggle('detail-only', !major.length);
  $('alertsSec').innerHTML = `<h2>🚨 Alerts for your field</h2>
    <p class="muted">Next ${SURE_DAYS} days of weather, the latest satellite image of your field and pest risk for ${c.fieldCrops.map(esc).join(', ')}.</p>
    ${c.forecast ? '' : `<p class="insight warn">The weather forecast could not be loaded, so hail, frost, rain and pest-weather alerts are missing. <small>(${esc(forecastProblem())})</small></p>`}
    ${major.length ? '' : '<p class="insight good">✅ No urgent alerts or warnings right now.</p>'}
    <div class="alerts">${al.map(item).join('')}</div>
    ${c.forecast ? `<details class="adjust-wrap detail-only"><summary>Weather forecast, next ${SHOW_DAYS} days</summary><div class="chart"><canvas id="forecastChart"></canvas></div><p class="muted">${esc(c.forecast.source ?? 'Open-Meteo')}, for your field's exact location. ECMWF and DWD ICON are the two most accurate weather models for Europe; hail and wind take the worse of the two.</p></details>` : ''}`;
  if (c.forecast && window.Chart) {
    const days = c.forecast.days.slice(0, SHOW_DAYS);
    const fade = (col, faded) => days.map((_, i) => (i < SURE_DAYS ? col : faded));
    drawChart('forecastChart', { type: 'bar', data: { labels: days.map(x => x.date.slice(5)), datasets: [
      { label: 'Rain (mm)', data: days.map(x => x.rainMm), backgroundColor: fade('#2f6690', 'rgba(47,102,144,.3)'), borderRadius: 3, yAxisID: 'y1' },
      { label: 'Max °C', data: days.map(x => x.tMax), type: 'line', borderColor: '#9e3b2e', pointBackgroundColor: fade('#9e3b2e', '#fff'), pointRadius: 2, yAxisID: 'y', segment: { borderDash: ctx => (ctx.p1DataIndex >= SURE_DAYS ? [4, 4] : undefined) } },
      { label: 'Min °C', data: days.map(x => x.tMin), type: 'line', borderColor: '#2f6b3a', pointBackgroundColor: fade('#2f6b3a', '#fff'), pointRadius: 2, yAxisID: 'y', segment: { borderDash: ctx => (ctx.p1DataIndex >= SURE_DAYS ? [4, 4] : undefined) } },
    ] }, options: { scales: { y: { position: 'left', title: { display: true, text: '°C' } }, y1: { position: 'right', min: 0, suggestedMax: 10, grid: { display: false }, title: { display: true, text: 'rain, mm' } } } } });
  }
  bindViewButtons($('alertsSec'));
}

// ================= SEASON RISK (machine learning) =================

function renderPrediction() {
  const c = state.ctx, pred = c.pred, box = $('predictSec');
  if (!pred?.ok) {
    box.innerHTML = `<h2>📈 Season risk</h2><p class="muted">${esc(pred?.reason ?? 'Not available.')}</p>`;
    return;
  }
  const crop = c.nextCrop;
  const weatherAlerts = (c.alerts ?? []).filter(a => !['pest', 'disease'].includes(a.type));
  const m = pred.byCrop[crop];
  const word = { low: 'Low', medium: 'Medium', high: 'High' };
  const similar = m.analogs.slice(0, 3).map(a => a.year);
  const goodOf = m.analogs.filter(a => a.ok).length;
  const ev = pred.eval;
  const rows = [...new Set([...c.fieldCrops, ...c.suggestion.mains, ...pred.perCrop.slice(0, 5).map(x => x.crop)])].map(x => pred.byCrop[x]).filter(Boolean);
  box.innerHTML = `<h2>📈 Season risk for ${pred.harvestYear}</h2>
    <p class="muted">A machine-learning model compares this season so far with the last ${pred.nYears} seasons on your field${pred.usedForecast ? ' (including the next 7 days of forecast)' : ''}.</p>
    <div class="risk-gauge lvl-${m.p >= 0.75 ? 'low' : m.p >= 0.55 ? 'medium' : 'high'}">
      <div class="score"><b>${r0(m.p * 100)}</b><span>%</span></div>
      <div><p class="big">Chance of a good season for <b>${esc(crop)}</b> (harvest ${pred.harvestYear}): <b>${chanceWord(m.p)}</b></p>
        <p>In an average year it's ${r0(m.base * 100)}%. This season so far looks most like <b>${similar.join(', ')}</b>; ${goodOf} of the ${m.analogs.length} most similar seasons ended well for ${esc(crop)}.</p></div>
    </div>
    <div class="detail-only">
      <h3 class="sub">What the model sees this season</h3>${list(pred.features.map(esc))}
      <h3 class="sub">Chance of a good season by crop</h3>
      <div class="table-wrap"><table><tr><th>Crop</th><th>This season</th><th>Average year</th><th>Change</th><th>Risk</th><th>Most similar past seasons (✓ good, ✗ bad)</th></tr>
      ${rows.map(x => `<tr><td>${esc(x.crop)}</td><td>${r0(x.p * 100)}%</td><td>${r0(x.base * 100)}%</td><td class="${x.shift < -0.05 ? 'mismatch' : x.shift > 0.05 ? 'ok' : ''}">${x.shift >= 0 ? '+' : ''}${r0(x.shift * 100)}</td><td><span class="chip ${x.level === 'low' ? 'better' : x.level === 'high' ? 'worse' : 'similar'}">${word[x.level]}</span></td>
        <td class="analogs">${x.analogs.slice(0, 6).map(a => `<span class="${a.ok ? 'ok' : 'bad'}">${a.year} ${a.ok ? '✓' : '✗'}</span>`).join(' ')}</td></tr>`).join('')}</table></div>
      <h3 class="sub">How good is the model? (retrospective test)</h3>
      <p>Every one of ${ev.tests} past crop-seasons was predicted from the other years only (leave-one-out). Right <b>${r0(ev.accuracy * 100)}%</b> of the time, vs ${r0(ev.baseAccuracy * 100)}% when you just assume an average year. Brier skill score ${ev.skill >= 0 ? '+' : ''}${ev.skill.toFixed(2)} (above 0 = better than the long-term average).</p>
      <div class="table-wrap"><table><tr><th>Predicting in</th>${pred.backtest.map(b => `<th>${b.month}</th>`).join('')}</tr>
        <tr><td>Right</td>${pred.backtest.map(b => `<td>${r0(b.accuracy * 100)}%</td>`).join('')}</tr>
        <tr><td>Skill vs average</td>${pred.backtest.map(b => `<td class="${b.skill > 0.05 ? 'ok' : ''}">${b.skill >= 0 ? '+' : ''}${b.skill.toFixed(2)}</td>`).join('')}</tr></table></div>
      <p class="muted">Honest reading: in autumn the model is only a little better than the long-term average, because next summer's rain is still unknown. It gets clearly better through winter and spring as the soil fills up (or doesn't). Method: analog-year k-nearest neighbours (k = ${pred.k}) on rain before sowing, rain since October and temperature, labels from the NASA POWER stress test.</p>
    </div>`;
}

// ================= PESTS, DISEASES AND FERTILIZER =================

function renderPests() {
  const c = state.ctx, db = state.pests, box = $('pestsSec');
  if (!db) { box.innerHTML = '<h2>🐛 Pests, diseases and fertilizer</h2><p class="muted">Pest information could not be loaded.</p>'; return; }
  const now = new Date().getMonth() + 1;
  const soon = [0, 1, 2, 3, 4, 5].map(i => (now - 1 + i) % 12 + 1);
  const crops = c.fieldCrops.filter(x => db.crops[x]);
  const months = ms => A.MONTHS.length && ms.map(m => A.MONTHS[m - 1]).join(', ');
  const nameOf = p => `${esc(p.name)}${p.nameBg ? ` <span class="bg">(${esc(p.nameBg)})</span>` : ''}`;
  const typeIcon = { insect: '🐛', mite: '🕷️', disease: '🍄', weed: '🌿', 'parasitic-plant': '🌿', nematode: '🪱', rodent: '🐭', slug: '🐌' };
  // the next ones to watch: active in the coming months, most dangerous first
  const watch = crops.flatMap(cr => db.crops[cr].pests.filter(p => p.months.some(m => soon.includes(m))).map(p => ({ ...p, crop: cr })))
    .sort((a, b) => soon.indexOf(a.months.find(m => soon.includes(m))) - soon.indexOf(b.months.find(m => soon.includes(m))) || b.severity - a.severity).slice(0, 4);
  const pestAlerts = (c.alerts ?? []).filter(a => a.type === 'pest' || a.type === 'disease');
  const n = c.suggestion;
  // fertilizer: needs of the next crop, minus nitrogen left by a legume before it, adjusted for the soil
  const next = db.crops[c.nextCrop];
  const prevLegume = state.crops.find(x => x.crop === c.lastCrop)?.legume;
  const nCredit = prevLegume ? state.crops.find(x => x.crop === c.lastCrop).nFixedKgHa : 0;
  const fert = next?.nutrients;
  const soilNotes = [];
  if (!c.soil.isDefault && c.soil.socGKg < 10) soilNotes.push('Low organic carbon: the soil releases less nitrogen on its own, so don\'t cut nitrogen below the plan.');
  if (!c.soil.isDefault && c.soil.ph < 5.8) soilNotes.push(`Acidic soil (pH ${c.soil.ph.toFixed(1)}): phosphorus is locked up; liming helps more than extra fertilizer.`);
  if (!c.soil.isDefault && c.soil.ph > 7.8) soilNotes.push(`Alkaline soil (pH ${c.soil.ph.toFixed(1)}): watch for zinc and iron shortage, especially in corn.`);
  if (c.soil.texture === 'Sandy') soilNotes.push('Sandy soil: nitrogen washes out after heavy rain; split it into 2–3 smaller doses.');
  const nutrientAlert = (c.alerts ?? []).find(a => a.type === 'nutrient');
  box.innerHTML = `<h2>🐛 Watch this season</h2>
    <p class="muted detail-only">What to watch for ${crops.map(esc).join(', ')} in the coming months, and what to do. Always use products registered by БАБХ and follow the label.</p>
    ${pestAlerts.length ? `<p class="insight warn">The forecast weather favours ${pestAlerts.map(a => esc(a.title)).join('; ')}. See the alerts above.</p>` : ''}
    <ul class="watch simple-only">${watch.slice(0, 3).map(p => `<li><b>${typeIcon[p.type] ?? '🐛'} ${nameOf(p)}</b> · ${esc(p.crop)}, ${months(p.months)}<br><span>${esc(p.action.split(/(?<=\.)\s/)[0])}</span></li>`).join('')}
      ${fert ? `<li><b>🧪 Fertilizer for ${esc(c.nextCrop)}</b><br><span>About ${Math.max(0, fert.N - nCredit)} kg nitrogen, ${fert.P2O5} kg P₂O₅ and ${fert.K2O} kg K₂O per ha for a normal yield. Split the nitrogen.</span></li>` : ''}</ul>
    <div class="pest-cards detail-only">${watch.length ? watch.map(p => `<div class="pest sev-${p.severity}">
      <h3>${typeIcon[p.type] ?? '🐛'} ${nameOf(p)}</h3><p class="muted">${esc(p.crop)} · ${months(p.months)}${p.severity === 3 ? ' · can destroy the crop' : ''}</p>
      <p><b>You'll see:</b> ${esc(p.signs)}</p><p><b>Do:</b> ${esc(p.action)}</p>
      <p class="detail-only"><b>Check:</b> ${esc(p.scout)}</p>${p.satellite ? `<p class="detail-only muted">🛰️ ${esc(p.satellite)}</p>` : ''}</div>`).join('') : '<p>Nothing major to watch in the coming months.</p>'}</div>
    ${fert ? `<div class="detail-only"><h3 class="sub">🧪 Fertilizer for ${esc(c.nextCrop)}</h3>
      <div class="facts nutrients"><div class="fact"><span>Nitrogen N</span><b>${Math.max(0, fert.N - nCredit)} kg/ha</b></div><div class="fact"><span>Phosphorus P₂O₅</span><b>${fert.P2O5} kg/ha</b></div><div class="fact"><span>Potassium K₂O</span><b>${fert.K2O} kg/ha</b></div></div>
      <p class="muted">Typical need for a normal yield${nCredit ? `, minus ~${nCredit} kg N/ha left by ${esc(c.lastCrop)}` : ''}. ${esc(fert.note ?? '')} A soil test every 4–5 years tells you the real numbers.</p>
      ${soilNotes.length ? list(soilNotes.map(esc)) : ''}
      ${nutrientAlert ? `<p class="insight warn">🛰️ ${esc(nutrientAlert.text)}</p>` : ''}</div>` : ''}
    <details class="adjust-wrap detail-only"><summary>All pests and diseases for your crops</summary>
      ${crops.map(cr => `<h4>${esc(cr)}</h4><div class="table-wrap"><table class="pest-table"><tr><th>Pest / disease</th><th>When</th><th>Signs</th><th>Check (threshold)</th><th>What to do</th></tr>
        ${db.crops[cr].pests.map(p => `<tr><td>${typeIcon[p.type] ?? ''} ${nameOf(p)}<br><small><i>${esc(p.latin ?? '')}</i></small></td><td>${months(p.months)}</td><td>${esc(p.signs)}</td><td>${esc(p.scout)}</td><td>${esc(p.action)}</td></tr>`).join('')}</table></div>`).join('')}
    </details>
    <details class="adjust-wrap detail-only"><summary>Nutrient shortage: signs in the field and from space</summary>
      <div class="table-wrap"><table><tr><th>Nutrient</th><th>Signs</th><th>From space</th><th>Likely when</th><th>Fix</th></tr>
      ${db.deficiencies.map(x => `<tr><td><b>${esc(x.nutrient)}</b> ${esc(x.name)} <span class="bg">(${esc(x.nameBg ?? '')})</span></td><td>${esc(x.signs)}</td><td>${esc(x.satellite)}</td><td>${esc(x.likelyWhen ?? '')}</td><td>${esc(x.fix)}</td></tr>`).join('')}</table></div>
      <p class="muted">Sources: ${(db.sources ?? []).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`).join(' · ')}</p>
    </details>`;
}

// ================= AT A GLANCE (simple view) =================

function renderGlance() {
  const c = state.ctx;
  const tiles = [];
  const add = (level, icon, label, value, note, href) => tiles.push(`<a class="tile lvl-${level}" href="#${href}"><span class="ico">${icon}</span><span class="label">${label}</span><b>${value}</b><small>${note}</small></a>`);
  const al = c.alerts ?? [];
  const urgent = al.filter(a => a.level === 'urgent').length, warn = al.filter(a => a.level === 'warning').length;
  add(urgent ? 'bad' : warn ? 'warn' : 'good', '🚨', 'Alerts', urgent ? `${urgent} urgent` : warn ? `${warn} warning${warn > 1 ? 's' : ''}` : 'None', urgent || warn ? al.find(a => a.level === (urgent ? 'urgent' : 'warning')).title : 'Nothing to act on now', 'alertsSec');
  if (c.recent) {
    const p = c.recent.last3Pct;
    add(p < -25 ? 'bad' : p < -10 ? 'warn' : 'good', '💧', 'Water, last 3 months', p < -10 ? 'Drier than normal' : p > 10 ? 'Wetter than normal' : 'About normal', `${p >= 0 ? '+' : ''}${r0(p)}% rain vs normal`, 'insightsSec');
  }
  if (c.pred?.ok) {
    const rs = ML.riskScore(c.pred, c.nextCrop, al.filter(a => !['pest', 'disease'].includes(a.type)));
    add(rs.level === 'high' ? 'bad' : rs.level === 'medium' ? 'warn' : 'good', '📈', `Season risk, ${c.nextCrop}`, `${rs.score}/100`, `${r0(rs.model.p * 100)}% chance of a good ${c.pred.harvestYear} season`, 'predictSec');
  }
  const pests = state.pests?.crops[c.nextCrop]?.pests ?? [];
  const pestAl = al.filter(a => a.type === 'pest' || a.type === 'disease').length;
  add(pestAl ? 'warn' : 'good', '🐛', 'Pests', pestAl ? `${pestAl} to check` : 'Quiet', pestAl ? 'Weather favours an outbreak' : `${pests.length} known pests of ${c.nextCrop}, see when to check`, 'pestsSec');
  if (!c.soil.isDefault) add(c.soil.socGKg < 10 ? 'warn' : 'good', '🌱', 'Soil', `${c.soil.texture}`, `organic carbon ${c.soil.socGKg < 10 ? 'low' : 'OK'}, holds ~${c.soil.awcMm} mm water`, 'pestsSec');
  $('glance').innerHTML = tiles.join('');
}

// ================= CHECKS =================

function renderChecks() {
  const res = V.resultChecks({ data: state.data, ctx: state.ctx, strategies: state.picks ?? [], prediction: state.ctx.pred });
  state.checks = res;
  const groups = [...new Set(res.checks.map(x => x.group))];
  const icon = ok => (ok ? '✅' : ok === false ? '❌' : '➖');
  $('checksBadge').hidden = false;
  $('checksBadge').textContent = `${res.failed ? '⚠️' : '✅'} ${res.passed}/${res.total} data checks passed`;
  $('checksSec').innerHTML = `<h2>${res.failed ? '⚠️' : '✅'} Data and result checks: ${res.passed} of ${res.total} passed</h2>
    <p class="muted">Every data source is checked for missing or impossible values, and the results for consistency, before you see them.${res.failed ? ' Something failed: treat the numbers with extra care.' : ''}</p>
    <div class="detail-only checks">${groups.map(g => `<h3 class="sub">${g}</h3><ul>${res.checks.filter(x => x.group === g).map(x => `<li>${icon(x.ok)} ${esc(x.text)}</li>`).join('')}</ul>`).join('')}</div>`;
}

// ================= HOW TO READ THIS =================

function renderGuide() {
  const item = (t, d, detail) => `<div class="${detail ? 'detail-only' : ''}"><dt>${t}</dt><dd>${d}</dd></div>`;
  $('guideSec').innerHTML = `<h2>📖 How to read your results</h2>
    <p class="muted">What each part shows and how to use it.</p>
    <dl class="guide">
      ${item('🌾 Our suggestion', 'The one thing to do next: which crop to sow and when, with the main reasons and risk.')}
      ${item('🚨 Alerts', 'Things that need action soon. <b>URGENT</b> = act within hours (you also get a call + SMS). <b>WARNING</b> = plan in the next days (SMS). <b>RECOMMENDATION</b> and <b>INFO</b> = good to know (in the app).')}
      ${item('🅰️🅱️🅲 3 strategies', 'A is what you do now (the baseline). B and C are new rotations. Compare the three numbers on each card.')}
      ${item('✅ Good seasons', 'Out of the last 24 years, how many had enough rain and no damaging heat for these crops on your field. Higher is safer.')}
      ${item('💶 Normal year / bad year', 'Profit per decare after typical costs, before rent and subsidies. "Bad year" is about 1 year in 10. A minus means you lose money that year.')}
      ${item('📈 Season risk', '0–100: how risky the coming season looks for your next crop, from comparing this season so far with similar past seasons. Below 30 is low, above 60 is high.')}
      ${item('🐛 Pests and fertilizer', 'The pests and diseases to watch in the coming months, what you\'ll see, what to do, and how much fertilizer the next crop needs.')}
      ${item('🟢 Greenness (NDVI)', 'From Sentinel-2: 0 = bare soil, 0.3 = young or stressed crop, 0.7+ = dense healthy crop. A sudden drop compared with other years can mean pests, disease, lack of nitrogen or drought.', true)}
      ${item('🔵 Moisture (NDMI)', 'Water in the plants and topsoil. If greenness drops and moisture drops too, it\'s drought; if moisture is normal, look for pests, disease or nutrients.', true)}
      ${item('🟫 Bare soil', 'Days without plant cover. Bare soil loses water and topsoil; cover crops reduce it.', true)}
      ${item('🌡️ By 2035', 'The same test with the measured warming and rain trend continued to 2035. A projection, not a forecast.', true)}
      ${item('🎯 Model skill', 'How the season-risk model did on past years it hadn\'t seen. Above 0 means it beats just assuming an average year.', true)}
      ${item('✔️ Data checks', 'Every source is checked for missing or impossible values. If a check fails, that number is less reliable.')}
    </dl>`;
}

// ================= SIMPLE / DETAILED VIEW =================

const VIEW_KEY = 'fieldshift.view';
state.view = (() => { try { return localStorage.getItem(VIEW_KEY) || 'simple'; } catch { return 'simple'; } })();
function setView(v) {
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* optional */ }
  document.body.classList.toggle('view-simple', v === 'simple');
  document.body.classList.toggle('view-detailed', v === 'detailed');
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  Object.values(charts).forEach(ch => ch.resize?.());
}
function bindViewButtons(root = document) {
  root.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => { setView(b.dataset.view); if (!b.classList.contains('view-btn')) window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
}

// ================= PHONE ALERTS =================

async function subscribe(e) {
  e.preventDefault();
  const c = state.ctx, status = $('monStatus');
  const phone = $('monPhone').value.replace(/[\s\-()/]/g, '');
  if (!/^(\+|00)?\d{9,14}$/.test(phone)) { status.textContent = '❌ Please enter a valid mobile number, e.g. 0888 123 456 or +359 888 123 456.'; return; }
  status.textContent = 'Turning on alerts…';
  try {
    const res = await fetch('/api/monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.placeName || 'My field', geometry: state.data.geometry, phone, crops: c.fieldCrops, minLevel: $('monLevel').value }) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || res.status);
    state.monitorId = j.id;
    status.innerHTML = `✅ Alerts are on for <b>${esc(j.phoneMasked ?? phone)}</b>. We check your field every 6 hours.`;
    renderMonitorPreview();
  } catch (err) { status.textContent = `❌ Could not turn on alerts: ${err.message}`; }
}

// What the farmer would get for the current alerts, and a button to run a real check now
function renderMonitorPreview() {
  const c = state.ctx, name = state.placeName || 'your field';
  const min = AL.LEVELS[$('monLevel').value]?.rank ?? 1;
  const send = (c.alerts ?? []).filter(a => AL.LEVELS[a.level].rank <= min);
  $('monResult').innerHTML = `<div class="detail-only">${send.length ? `<p class="small-label">With today's alerts you would get:</p>${send.map(a => `<div class="sms"><span>${AL.channelsFor(a.level).filter(x => x !== 'app').map(x => CHANNEL[x]).join(' + ')}</span><p>${esc(AL.smsText(a, name))}</p></div>`).join('')}` : '<p class="muted">Nothing would be sent today: no alerts at your level.</p>'}</div>
    ${state.monitorId ? '<button class="btn" id="monCheck">Run a check now</button><div id="monLog"></div>' : ''}`;
  $('monCheck')?.addEventListener('click', async () => {
    $('monLog').textContent = 'Checking forecast, satellite and pests…';
    try {
      const j = await (await fetch(`/api/monitor/${state.monitorId}/check`, { method: 'POST' })).json();
      if (j.error) throw new Error(j.error);
      const del = j.deliveries ?? [];
      $('monLog').innerHTML = `<p>${j.alerts?.length ?? 0} alert(s) found, ${del.length} message(s) sent.</p>${del.length ? list(del.map(x => `${CHANNEL[x.channel] ?? x.channel}: ${esc(x.status)}${x.status === 'dry-run' ? ' (demo mode: no SMS provider set up, saved to the outbox)' : ''}`)) : ''}`;
    } catch (err) { $('monLog').textContent = `❌ ${err.message}`; }
  });
}

// Section menu in the results header: highlight where you are, open "How it works" when jumped to
let sectionObserver;
function watchSections() {
  const links = [...document.querySelectorAll('#sectionNav a')];
  const byId = Object.fromEntries(links.map(a => [a.getAttribute('href').slice(1), a]));
  links.forEach(a => a.onclick = () => { const t = $(a.getAttribute('href').slice(1)); if (t?.tagName === 'DETAILS') t.open = true; });
  sectionObserver?.disconnect();
  sectionObserver = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) links.forEach(a => a.classList.toggle('active', a === byId[e.target.id]));
  }, { rootMargin: '-130px 0px -60% 0px' });
  Object.keys(byId).forEach(id => $(id) && sectionObserver.observe($(id)));
}

// ================= START =================

async function init() {
  [state.crops, state.rotations] = await Promise.all(['crops', 'rotations'].map(f => fetch(`data/${f}.json`).then(r => r.json())));
  fetch('data/pests.json').then(r => (r.ok ? r.json() : null)).then(p => { state.pests = p; }).catch(() => { state.pests = null; });
  const mainCrops = state.crops.filter(c => c.crop !== 'Cover crop');
  $('cropList').innerHTML = mainCrops.map(c => `<option value="${c.crop}">${c.nameBg}</option><option value="${c.nameBg}">${c.crop}</option>`).join('');
  $('focusCrop').innerHTML = mainCrops.map(c => `<option value="${c.crop}">${c.crop} · ${c.nameBg}</option>`).join('');
  $('historyRows').innerHTML = HISTORY_YEARS.map(historyRow).join('');
  document.querySelectorAll('.history-row').forEach(row => {
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      row.querySelector('.resolved').innerHTML = ''; resolveRow(row); syncClear(row); $('historyError').hidden = true; refreshPreCheck();
    });
    row.querySelector('.row-clear').addEventListener('click', () => {
      input.value = ''; row.querySelector('.resolved').innerHTML = ''; resolveRow(row); syncClear(row); input.focus();
    });
    // Enter jumps to the next (older) year
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      row.nextElementSibling?.querySelector('input').focus();
    });
  });
  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { fillPreset(b.dataset.preset); $('historyError').hidden = true; }));
  renderPriorities();
  renderRecent();

  document.querySelectorAll('[name=situation]').forEach(r => r.addEventListener('change', () => {
    $('historyBox').hidden = document.querySelector('[name=situation]:checked').value !== 'farm';
    refreshPreCheck();
  }));
  document.querySelectorAll('[name=mode]').forEach(r => r.addEventListener('change', () => {
    $('cropPick').hidden = document.querySelector('[name=mode]:checked').value !== 'crop';
    refreshPreCheck();
  }));
  bindViewButtons();
  setView(state.view);
  $('monitorForm').addEventListener('submit', subscribe);
  $('monLevel').addEventListener('change', () => state.ctx && renderMonitorPreview());

  $('searchForm').addEventListener('submit', search);
  $('searchResults').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) pickResult(results[+li.dataset.i]); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-box')) $('searchResults').hidden = true; });
  $('recent').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const list = loadRecent(), r = list[+b.dataset.i];
    if (b.classList.contains('x')) { list.splice(+b.dataset.i, 1); saveRecent(list); renderRecent(); return; }
    state.placeName = r.name;
    M.showField(r.geometry, `Restored from your recent fields (${new Date(r.date).toLocaleDateString()}).`);
  });
  $('clearField').addEventListener('click', () => { state.placeName = ''; M.clearField(); });
  $('analyze').addEventListener('click', analyze);
  $('focusCrop').addEventListener('change', () => refreshPreCheck());
  document.querySelectorAll('.unit-btn').forEach(b => b.addEventListener('click', () => setUnit(b.dataset.unit)));
  const backToStart = () => { $('results').hidden = true; $('progress').hidden = true; $('start').hidden = false; M.refresh(); };
  $('back').addEventListener('click', backToStart);
  $('progressBack').addEventListener('click', backToStart);

  await M.initMap(onFieldChange);
}

init();
