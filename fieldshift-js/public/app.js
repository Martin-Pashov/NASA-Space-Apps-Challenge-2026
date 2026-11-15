import * as A from './analysis.js';
import * as M from './map.js';

const $ = id => document.getElementById(id);
const r0 = x => Math.round(x);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const YEAR = new Date().getFullYear();
const HISTORY_YEARS = [YEAR - 4, YEAR - 3, YEAR - 2, YEAR - 1, YEAR];
const REFERENCE_ROTATION = 'Wheat > Sunflower';
const state = { crops: [], rotations: {}, field: null, placeName: '', data: null, weights: null, ctx: null, overrides: {} };
const charts = {};

// ================= RECENT FIELDS (localStorage) =================

const RECENT_KEY = 'fieldshift.recent';
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
const saveRecent = list => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* storage unavailable */ } };

function rememberField() {
  const f = state.field;
  const entry = { name: state.placeName || 'Field', geometry: f.geometry, areaHa: f.areaHa, center: f.center, date: new Date().toISOString() };
  const key = JSON.stringify(f.geometry.coordinates);
  saveRecent([entry, ...loadRecent().filter(r => JSON.stringify(r.geometry.coordinates) !== key)]);
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
  return `<div class="history-row" data-year="${year}"><span class="year">${year}</span>
    <input list="cropList" placeholder="e.g. Wheat / Пшеница, or any crop">
    <span class="resolved"></span></div>`;
}

function resolveRow(row) {
  const input = row.querySelector('input'), out = row.querySelector('.resolved');
  const groupSel = out.querySelector('select');
  const r = A.resolveCrop(input.value, state.crops, groupSel?.value || undefined);
  row.dataset.crop = '';
  if (!r) { out.innerHTML = ''; return; }
  if (r.known) { out.innerHTML = `<span class="tag ok">✓ ${esc(r.crop)}</span>`; row.dataset.crop = r.crop; return; }
  // unknown crop: ask which group it's closest to (pre-filled with our guess)
  const options = Object.entries(A.GROUPS).map(([k, v]) => `<option value="${k}" ${k === r.group ? 'selected' : ''}>${v}</option>`).join('');
  out.innerHTML = `<select class="group" aria-label="Closest crop group"><option value="">Which group is it closest to?</option>${options}</select>`;
  out.querySelector('select').addEventListener('change', () => { resolveRow(row); $('historyError').hidden = true; });
  if (r.crop) row.dataset.crop = r.crop;
}

function readHistory() {
  const rows = [...document.querySelectorAll('.history-row')];
  const filled = rows.filter(r => r.querySelector('input').value.trim());
  const unresolved = filled.filter(r => !r.dataset.crop);
  return {
    seasons: filled.filter(r => r.dataset.crop).map(r => ({ year: +r.dataset.year, label: r.querySelector('input').value.trim(), crop: r.dataset.crop })),
    unresolved: unresolved.length,
  };
}

function fillPreset(list) {
  const crops = list ? list.split(',') : [];
  const rows = [...document.querySelectorAll('.history-row')];
  rows.forEach((row, i) => {
    // fill backwards from the most recent year so the pattern ends with the last crop in the list
    const fromEnd = rows.length - 1 - i;
    row.querySelector('input').value = crops.length ? crops[(crops.length - 1 - (fromEnd % crops.length))] : '';
    row.querySelector('.resolved').innerHTML = '';
    resolveRow(row);
  });
}

// ================= PRIORITIES =================

function renderPriorities() {
  $('priorities').innerHTML = Object.entries(A.PRIORITIES).map(([k, p]) =>
    `<label class="prio" title="${esc(p.hint)}"><input type="checkbox" value="${k}" ${k === 'water' || k === 'risk' ? 'checked' : ''}><b>${p.chip}</b><small>${p.hint}</small></label>`).join('');
}

function priorityWeights() {
  const chosen = [...document.querySelectorAll('#priorities input:checked')].map(i => i.value);
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
  { id: 'stress', title: 'Stress-testing every crop against every past season', src: 'FieldShift' },
  { id: 'compare', title: 'Comparing rotation strategies', src: 'FieldShift' },
];
const ICON = { waiting: '○', running: '◌', done: '✅', failed: '⚠️' };

function setStep(id, status, { ms, error, backup } = {}) {
  const li = document.querySelector(`#steps li[data-id="${id}"]`);
  const s = STEPS.find(x => x.id === id);
  li.className = status;
  li.querySelector('.icon').textContent = ICON[status];
  li.querySelector('.time').textContent = ms != null ? `${(ms / 1000).toFixed(1)} s` : status === 'running' ? 'working…' : '';
  const why = li.querySelector('.why');
  if (status === 'failed') why.textContent = `Couldn't get this data (${plainError(error)}). ${s.missing ?? ''}`;
  else if (backup) why.textContent = 'Live request failed, used the last saved copy.';
  else why.textContent = s.src;
}

function plainError(e = '') {
  if (/credentials|login|401|403/i.test(e)) return 'satellite login is not set up';
  if (/timeout|abort/i.test(e)) return 'the service took too long to answer';
  if (/fetch failed|ENOTFOUND|network/i.test(e)) return 'no internet connection to the service';
  return e.length > 80 ? e.slice(0, 80) + '…' : e || 'unknown error';
}

async function analyze() {
  const situation = document.querySelector('[name=situation]:checked').value;
  const history = readHistory();
  if (situation === 'farm' && (!history.seasons.length || history.unresolved)) {
    $('historyError').hidden = false;
    $('historyError').textContent = history.unresolved
      ? 'Pick the closest crop group for the crops we don\'t know yet.'
      : 'Add at least one season, or choose "I\'m starting out".';
    $('historyBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (state.field.areaHa > 2000) return;
  rememberField();

  state.situation = situation;
  state.history = history.seasons;
  state.weights = priorityWeights();

  $('start').hidden = true; $('progress').hidden = false; $('progressBack').hidden = true;
  $('progressField').textContent = `${state.placeName || 'Your field'} · ${areaTxt(state.field.areaHa)}`;
  $('progressNote').textContent = 'This usually takes 20–60 seconds. Satellite data takes the longest.';
  $('steps').innerHTML = STEPS.map(s => `<li data-id="${s.id}" class="waiting"><span class="icon">${ICON.waiting}</span><span>${s.title}<span class="why">${s.src}</span></span><span class="time"></span></li>`).join('');
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
        if (msg.type === 'step') setStep(msg.id, msg.status, msg);
        if (msg.type === 'result') result = msg.data;
      }
    }
    if (!result) throw new Error('The server stopped before finishing.');
    if (!result.climate.ok) throw new Error(`NASA climate data is required and couldn't be loaded (${plainError(result.climate.error)}).`);
    state.data = result;

    let t = performance.now();
    setStep('stress', 'running');
    prepare();
    setStep('stress', 'done', { ms: performance.now() - t });
    t = performance.now();
    setStep('compare', 'running');
    renderAll();
    setStep('compare', 'done', { ms: performance.now() - t });
    $('progressNote').textContent = 'Done!';
    await new Promise(r => setTimeout(r, 700)); // let the farmer see everything finished
    $('progress').hidden = true; $('results').hidden = false; window.scrollTo(0, 0);
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
    cy: A.cropYears(d.climate.data, crops, soil.awcMm),
    cyFuture: A.cropYears(A.applyFuture(d.climate.data, sum, 2035), crops, soil.awcMm),
    autumn: A.autumnCheck(recent, crops),
  };
}

function renderAll() {
  const d = state.data, c = state.ctx;
  document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === state.unit));
  $('placeName').textContent = state.placeName || 'Your field';
  $('coords').textContent = `${areaTxt(d.areaHa)} · ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
  $('historyLabel').textContent = c.beginner ? 'Starting out' : `You grew: ${state.history.map(h => `${h.year} ${h.label}`).join(', ')}`;
  $('basics').hidden = !c.beginner;

  const currentPlan = c.rotations[c.currentName].plan;
  const insights = A.buildInsights({ sum: c.sum, recent: c.recent, field: c.field, soil: c.soil, terrain: c.terrain, cyNow: c.cy, cyFuture: c.cyFuture, crops: state.crops, currentPlan });
  $('insights').innerHTML = insights.map(x => `<div class="insight ${x.level}"><h3>${x.title}</h3><p>${x.text}</p><span class="src">Source: ${x.source}</span></div>`).join('');

  renderSatHistory();
  renderCharts();
  renderAdjust();
  renderOwnNumbers();
  renderStrategies();
}

function renderSatHistory() {
  const rows = A.satelliteHistory(state.ctx.field, state.ctx.beginner ? null : state.history, state.crops);
  const box = $('satHistory');
  box.hidden = !rows.length;
  if (!rows.length) return;
  const label = { autumn: 'Autumn-sown crop (green in March–April, like wheat, barley, rapeseed)', spring: 'Spring crop (bare in spring, like sunflower, corn)', bare: 'Mostly bare' };
  const mismatches = rows.filter(r => r.match === false);
  box.innerHTML = `<h2>What grew here: satellites vs your memory</h2>
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
      { label: 'Greenness', data: sent.map(r => r.ndvi), borderColor: '#1D9E75', backgroundColor: 'rgba(29,158,117,.12)', fill: true, pointRadius: 0, tension: 0.3 },
      { label: 'Moisture', data: sent.map(r => r.ndmi), borderColor: '#378ADD', pointRadius: 0, tension: 0.3, borderWidth: 1.5 },
    ] }, options: { scales: { x: { ticks: { autoSkip: false, maxRotation: 0, callback: yearTick } } } } });
    $('fieldChartNote').textContent = d.sentinel.backup ? 'Showing the last saved satellite data (live request failed).' : '';
  } else {
    charts.fieldChart?.destroy();
    $('fieldChartNote').textContent = `No satellite history available: ${plainError(d.sentinel.error)}.`;
  }
  if (c.recent) {
    drawChart('rainChart', { type: 'bar', data: { labels: c.recent.months.map(m => m.label), datasets: [
      { label: 'Rain this year', data: c.recent.months.map(m => r0(m.rain)), backgroundColor: '#378ADD' },
      { label: 'Normal year', data: c.recent.months.map(m => r0(m.normal)), type: 'line', borderColor: '#444441', pointRadius: 2 },
    ] } });
  }
  drawChart('tempChart', { type: 'line', data: { labels: c.sum.years, datasets: [
    { label: 'Avg temp', data: c.sum.yearlyTemp.map(t => +t.toFixed(1)), borderColor: '#D85A30', pointRadius: 0, tension: 0.3 },
  ] }, options: { plugins: { legend: { display: false } } } });
  const n = c.cy.years.length;
  const ranks = A.rankCrops(c.cy, state.crops).slice(0, 14);
  const okN = (cy, name) => cy.rows.filter(r => r.crop === name && r.ok).length;
  drawChart('cropChart', { type: 'bar', data: { labels: ranks.map(r => r.crop), datasets: [
    { label: `Good seasons (of ${n})`, data: ranks.map(r => okN(c.cy, r.crop)), backgroundColor: '#1D9E75' },
    { label: 'By 2035 (trend)', data: ranks.map(r => okN(c.cyFuture, r.crop)), backgroundColor: '#EF9F27' },
  ] }, options: { indexAxis: 'y', scales: { x: { max: n, ticks: { stepSize: 4 } } } } });
}

function renderAdjust() {
  $('adjust').innerHTML = Object.entries(A.PRIORITIES).map(([k, p]) =>
    `<label>${p.chip} <input type="range" min="0" max="10" value="${state.weights[k]}" data-w="${k}"><b>${state.weights[k]}</b></label>`).join('');
  document.querySelectorAll('[data-w]').forEach(s => s.addEventListener('input', () => {
    s.nextElementSibling.textContent = s.value;
    state.weights[s.dataset.w] = +s.value;
    renderStrategies();
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
    renderStrategies();
  }));
  $('resetOwn').addEventListener('click', () => { state.overrides = {}; renderOwnNumbers(); renderStrategies(); });
}

function renderStrategies() {
  const c = state.ctx, crops = effectiveCrops(), weights = state.weights;
  const ranked = A.scoreRotations({ rotations: c.rotations, crops, cy: c.cy, cyFuture: c.cyFuture, soil: c.soil, field: c.field, weights, known: c.known });
  const focus = document.querySelector('[name=mode]:checked').value === 'crop' ? $('focusCrop').value : null;
  const picks = A.pickStrategies(ranked, c.currentName, focus, c.currentLabel);
  const current = ranked.find(r => r.rotation === c.currentName);
  // the suggestion: an option that is clearly better for the farmer (see A.verdict), best one first
  const others = picks.filter(p => p.rotation !== c.currentName)
    .sort((a, b) => (A.verdict(b, current).key === 'better') - (A.verdict(a, current).key === 'better') || b.score - a.score);
  const best = others[0];
  // only suggest a change when it's clearly better, never keep a monoculture
  const mono = current.mains.every(m => m === current.mains[0]) && !crops.find(x => x.crop === current.mains[0]).perennial;
  const keep = !c.beginner && !mono && A.verdict(best, current).key !== 'better';
  const n = c.cy.years.length;

  // ---- answer card
  const ans = A.buildAnswer({ best, current, lastCrop: c.lastCrop, crops, cy: c.cy, autumn: c.autumn, money, beginner: c.beginner, keep });
  const eyebrow = c.beginner ? 'Our suggestion to start' : keep ? 'Your rotation already fits well' : mono ? `Growing only ${current.mains[0]} is costing you` : 'Our suggestion';
  $('answer').innerHTML = `<div class="eyebrow">${eyebrow}</div>
    <h2>${esc(ans.title)}</h2><p class="when">🗓️ ${esc(ans.when)}</p>
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

  // ---- compact strategy cards, details folded away
  const ctx = { crops, cy: c.cy, field: c.field, soil: c.soil, terrain: c.terrain, sum: c.sum, weights, known: c.known, beginner: c.beginner, money };
  const allNew = new Set();
  $('strategies').innerHTML = picks.map(p => {
    const e = A.explainStrategy(p, current, ctx);
    e.newCrops.forEach(x => allNew.add(x));
    const v = A.verdict(p, current);
    return `<div class="strategy ${p.rotation === c.currentName ? 'current' : ''}">
      <div class="head"><span class="kind">${p.label}</span>${v.key === 'now' ? '' : `<span class="chip ${v.key}">${v.text}</span>`}</div>
      <h3>${esc(p.rotation.replace(/^Your rotation: /, ''))}</h3>
      <div class="facts"><div class="fact"><span>Good seasons</span><b>${r0(p.risk)}%</b></div>
        <div class="fact"><span>Normal year</span><b>${money(p.profitNormal)}</b></div>
        <div class="fact"><span>Bad year</span><b>${money(p.profitBad)}</b></div></div>
      <p>${e.why}</p>
      <details><summary>Why, evidence and risks</summary>
        ${e.benefits.length ? `<h4>What changes</h4>${list(e.benefits)}` : ''}
        <h4>Evidence</h4>${list(e.evidence)}
        ${e.risks.length ? `<h4>Check locally</h4>${list(e.risks)}` : ''}
      </details></div>`;
  }).join('');
  $('gaps').innerHTML = A.infoGaps({ field: c.field, soil: c.soil, weights, newCrops: [...allNew] }).map(g => `<li>${g}</li>`).join('');

  $('ranking').innerHTML = '<tr><th>#</th><th>Rotation</th><th>Fit</th><th>Good seasons</th><th>Normal year</th><th>Bad year</th><th>Bare months</th></tr>' +
    ranked.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.rotation.replace(/^Your rotation: /, 'Yours: '))}</td><td><span class="chip ${A.verdict(r, current).key}">${A.verdict(r, current).text}</span></td>` +
      `<td>${r0(r.risk)}%</td><td>${money(r.profitNormal)}</td><td>${money(r.profitBad)}</td><td>${r.bare.toFixed(1)}</td></tr>`).join('');
}

// ================= START =================

async function init() {
  [state.crops, state.rotations] = await Promise.all(['crops', 'rotations'].map(f => fetch(`data/${f}.json`).then(r => r.json())));
  const mainCrops = state.crops.filter(c => c.crop !== 'Cover crop');
  $('cropList').innerHTML = mainCrops.map(c => `<option value="${c.crop}">${c.nameBg}</option><option value="${c.nameBg}">${c.crop}</option>`).join('');
  $('focusCrop').innerHTML = mainCrops.map(c => `<option value="${c.crop}">${c.crop} · ${c.nameBg}</option>`).join('');
  $('historyRows').innerHTML = HISTORY_YEARS.map(historyRow).join('');
  document.querySelectorAll('.history-row').forEach(row => row.querySelector('input').addEventListener('input', () => {
    row.querySelector('.resolved').innerHTML = ''; resolveRow(row); $('historyError').hidden = true;
  }));
  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { fillPreset(b.dataset.preset); $('historyError').hidden = true; }));
  renderPriorities();
  renderRecent();

  document.querySelectorAll('[name=situation]').forEach(r => r.addEventListener('change', () => {
    $('historyBox').hidden = document.querySelector('[name=situation]:checked').value !== 'farm';
  }));
  document.querySelectorAll('[name=mode]').forEach(r => r.addEventListener('change', () => {
    $('cropPick').hidden = document.querySelector('[name=mode]:checked').value !== 'crop';
  }));

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
  document.querySelectorAll('.unit-btn').forEach(b => b.addEventListener('click', () => setUnit(b.dataset.unit)));
  const backToStart = () => { $('results').hidden = true; $('progress').hidden = true; $('start').hidden = false; M.refresh(); };
  $('back').addEventListener('click', backToStart);
  $('progressBack').addEventListener('click', backToStart);

  await M.initMap(onFieldChange);
}

init();
