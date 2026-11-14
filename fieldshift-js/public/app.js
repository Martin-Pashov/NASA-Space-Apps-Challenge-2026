import * as A from './analysis.js';
import * as M from './map.js';

const $ = id => document.getElementById(id);
const r0 = x => Math.round(x);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const YEAR = new Date().getFullYear();
const HISTORY_YEARS = [YEAR - 4, YEAR - 3, YEAR - 2, YEAR - 1, YEAR];
const REFERENCE_ROTATION = 'Wheat > Sunflower';
const state = { crops: [], rotations: {}, field: null, placeName: '', data: null, weights: null, ctx: null };
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
    `<span class="recent-item"><button class="go-recent" data-i="${i}" title="${esc(new Date(r.date).toLocaleDateString())}">📍 ${esc(r.name)} · ${r.areaHa.toFixed(1)} ha</button>` +
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
  $('fieldMeta').textContent = `${field.areaHa.toFixed(1)} ha · ${field.center.lat.toFixed(4)}, ${field.center.lon.toFixed(4)}`;
  if (field.note) $('fieldNote').textContent = field.note;
  if (field.areaHa > 2000) $('fieldNote').textContent = 'This area is too large (max 2000 ha). Please draw your field smaller.';
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
  return Object.fromEntries(Object.keys(A.PRIORITIES).map(k => [k, chosen.length ? (chosen.includes(k) ? 10 : 1) : 5]));
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
  $('progressField').textContent = `${state.placeName || 'Your field'} · ${state.field.areaHa.toFixed(1)} ha`;
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

// ================= RESULTS =================

function drawChart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), { ...config, options: { responsive: true, maintainAspectRatio: false, animation: false, ...config.options } });
}
const list = items => `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`;

// Heavy calculations that don't depend on the priority sliders
function prepare() {
  const d = state.data, crops = state.crops;
  const sum = A.climateSummary(d.climate.data);
  const soil = d.soil.data;
  const beginner = state.situation === 'new';
  const rotations = { ...state.rotations };
  let currentName, currentLabel, lastCrop = null, known = [];
  if (beginner) {
    currentName = REFERENCE_ROTATION; currentLabel = 'Typical rotation (reference)';
  } else {
    const plan = A.compressHistory(state.history.map(h => h.crop));
    currentName = `Your rotation: ${plan.join(' > ')}`;
    currentLabel = 'Your current rotation';
    rotations[currentName] = { plan, type: 'current' };
    lastCrop = state.history.at(-1).crop;
    known = [...new Set(state.history.map(h => h.crop))];
  }
  state.ctx = {
    sum, soil, beginner, rotations, currentName, currentLabel, lastCrop, known,
    recent: d.recent.ok ? A.recentVsNormal(d.recent.data, sum) : null,
    field: d.sentinel.ok ? A.fieldSummary(d.sentinel.data) : null,
    terrain: d.terrain.ok ? d.terrain.data : null,
    cy: A.cropYears(d.climate.data, crops, soil.awcMm),
    cyFuture: A.cropYears(A.applyFuture(d.climate.data, sum, 2035), crops, soil.awcMm),
  };
}

function renderAll() {
  const d = state.data, crops = state.crops, c = state.ctx;
  $('placeName').textContent = state.placeName || 'Your field';
  $('coords').textContent = `${d.areaHa.toFixed(1)} ha · ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
  $('historyLabel').textContent = c.beginner ? 'Starting out' : `History: ${state.history.map(h => `${h.year} ${h.label}`).join(', ')}`;
  $('basics').hidden = !c.beginner;

  const currentPlan = c.rotations[c.currentName].plan;
  const insights = A.buildInsights({ sum: c.sum, recent: c.recent, field: c.field, soil: c.soil, terrain: c.terrain, cyNow: c.cy, cyFuture: c.cyFuture, crops, currentPlan });
  $('insights').innerHTML = insights.map(x => `<div class="insight ${x.level}"><h3>${x.title}</h3><p>${x.text}</p><span class="src">Source: ${x.source}</span></div>`).join('');

  const sent = d.sentinel.ok ? d.sentinel.data : [];
  if (sent.length) {
    drawChart('fieldChart', { type: 'line', data: { labels: sent.map(r => r.date), datasets: [
      { label: 'Greenness (NDVI)', data: sent.map(r => r.ndvi), borderColor: '#1D9E75', pointRadius: 0, tension: 0.3 },
      { label: 'Moisture (NDMI)', data: sent.map(r => r.ndmi), borderColor: '#378ADD', pointRadius: 0, tension: 0.3 },
    ] }, options: { scales: { x: { ticks: { maxTicksLimit: 8 } } } } });
    $('fieldChartNote').textContent = d.sentinel.backup ? 'Showing the last saved satellite data (live request failed).' : '';
  } else {
    charts.fieldChart?.destroy();
    $('fieldChartNote').textContent = `No satellite history available: ${plainError(d.sentinel.error)}.`;
  }
  if (c.recent) {
    drawChart('rainChart', { type: 'bar', data: { labels: c.recent.months.map(m => m.label), datasets: [
      { label: 'Rain this year', data: c.recent.months.map(m => r0(m.rain)), backgroundColor: '#378ADD' },
      { label: 'Normal (25-yr avg)', data: c.recent.months.map(m => r0(m.normal)), type: 'line', borderColor: '#444441', pointRadius: 2 },
    ] } });
  }
  drawChart('tempChart', { type: 'line', data: { labels: c.sum.years, datasets: [
    { label: 'Avg temp', data: c.sum.yearlyTemp.map(t => +t.toFixed(1)), borderColor: '#D85A30', pointRadius: 0, tension: 0.3 },
  ] }, options: { plugins: { legend: { display: false } } } });
  const ranks = A.rankCrops(c.cy, crops);
  const futPct = name => c.cyFuture.rows.filter(r => r.crop === name && r.ok).length / c.cy.years.length * 100;
  drawChart('cropChart', { type: 'bar', data: { labels: ranks.map(r => r.crop), datasets: [
    { label: 'Past seasons OK', data: ranks.map(r => r0(r.pct)), backgroundColor: '#1D9E75' },
    { label: '2035 trend', data: ranks.map(r => r0(futPct(r.crop))), backgroundColor: '#EF9F27' },
  ] }, options: { scales: { y: { max: 100 }, x: { ticks: { autoSkip: false, maxRotation: 60, font: { size: 10 } } } } } });

  renderVerdict(ranks, futPct);
  renderAdjust();
  renderStrategies();
}

function renderVerdict(ranks, futPct) {
  const mode = document.querySelector('[name=mode]:checked').value, box = $('verdictBox'), c = state.ctx;
  box.hidden = false;
  if (mode === 'crop') {
    const v = A.cropVerdict($('focusCrop').value, c.cy, c.cyFuture, state.crops);
    box.className = `card ${v.level}`;
    box.innerHTML = `<h2>${v.verdict}</h2><p>${v.detail}</p><p>${v.note}</p>` +
      (v.alternatives.length ? `<p><b>More reliable alternatives here:</b> ${v.alternatives.map(a => `${a.crop} (${r0(a.pct)}% of seasons OK)`).join(', ')}.</p>` : '');
  } else {
    box.className = 'card';
    box.innerHTML = '<h2>Most reliable crops for this field</h2><p class="muted">Share of past seasons with enough water and no heat stress, and the expected profit including bad years (NASA POWER stress test).</p>' +
      '<div class="table-wrap"><table><tr><th>Crop</th><th>Seasons OK</th><th>By 2035 (trend)</th><th>Expected profit</th></tr>' +
      ranks.slice(0, 8).map(r => `<tr><td>${r.crop}${r.legume ? ' 🌱' : ''}</td><td>${r0(r.pct)}%</td><td>${r0(futPct(r.crop))}%</td><td>${A.eur(r.profit)}/ha</td></tr>`).join('') +
      '</table></div><p class="muted">🌱 = fixes nitrogen</p>';
  }
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

function renderStrategies() {
  const c = state.ctx, crops = state.crops, weights = state.weights;
  const ranked = A.scoreRotations({ rotations: c.rotations, crops, cy: c.cy, cyFuture: c.cyFuture, soil: c.soil, field: c.field, weights, known: c.known });
  const focus = document.querySelector('[name=mode]:checked').value === 'crop' ? $('focusCrop').value : null;
  const picks = A.pickStrategies(ranked, c.currentName, focus, c.currentLabel);
  const current = ranked.find(r => r.rotation === c.currentName);
  const best = picks.filter(p => p.rotation !== c.currentName).sort((a, b) => b.score - a.score)[0];

  const next = A.nextCrop(best.plan, c.lastCrop, crops);
  const nextText = next.includes('+') ? `a cover crop right after harvest, then ${next.split('+')[1]} in spring` : next;
  if (c.beginner) {
    $('action').innerHTML = `<b>Our suggestion for a start:</b> <b>${esc(best.rotation)}</b>. Begin with <b>${esc(nextText)}</b>. ` +
      `It matches your priorities with a score of ${r0(best.score)} (typical rotation: ${r0(current.score)}).`;
  } else if (current.mains.every(m => m === current.mains[0]) && !state.crops.find(x => x.crop === current.mains[0]).perennial) {
    $('action').innerHTML = `<b>Growing ${esc(current.mains[0])} year after year lowers yields and builds up pests and diseases.</b> ` +
      `A better option for your priorities: <b>${esc(best.rotation)}</b>. After your ${esc(c.lastCrop)}, plant <b>${esc(nextText)}</b> next season.`;
  } else if (best.score > current.score + 2) {
    $('action').innerHTML = `<b>Our suggestion:</b> move to <b>${esc(best.rotation)}</b>. After your ${esc(c.lastCrop)}, plant <b>${esc(nextText)}</b> next season. ` +
      `Score ${r0(best.score)} vs ${r0(current.score)} for your current rotation.`;
  } else {
    $('action').innerHTML = `<b>Your current rotation already fits your priorities well.</b> The options below show what you could gain or lose by changing.`;
  }

  const chosen = Object.entries(weights).filter(([, w]) => w >= 5).map(([k]) => k);
  const extraRows = chosen.filter(k => ['cost', 'labor', 'machinery', 'market', 'forage', 'pests', 'subsidies'].includes(k))
    .map(k => [`${A.PRIORITIES[k].chip} (0–100)`, p => r0(p[k]), 'max', p => p[k]]);
  const rows = [
    ['Match with your priorities (0–100)', p => r0(p.score), 'max', p => p.score],
    ['Harvest success, past 25 years', p => `${r0(p.risk)}%`, 'max', p => p.risk],
    ['Harvest success, 2035 trend', p => `${r0(p.riskFuture)}%`, 'max', p => p.riskFuture],
    ['Water demand (mm/yr)', p => r0(p.waterDemand), 'min', p => p.waterDemand],
    ['Bare soil (months/yr)', p => p.bare.toFixed(1), 'min', p => p.bare],
    ['Typical profit (€/ha/yr)', p => A.eur(p.profitNormal), 'max', p => p.profitNormal],
    ['Bad-year profit (€/ha/yr)', p => A.eur(p.profitBad), 'max', p => p.profitBad],
    ['Fertilizer saved (€/ha/yr)', p => A.eur(p.nSavedEur), 'max', p => p.nSavedEur],
    ...extraRows,
    ['Switching effort', p => p.difficulty, null],
  ];
  $('compare').innerHTML = `<tr><th></th>${picks.map(p => `<th>${p.label}<br><b style="color:var(--text)">${esc(p.rotation)}</b></th>`).join('')}</tr>` +
    rows.map(([label, fmt, dir, val]) => {
      const target = dir ? (dir === 'max' ? Math.max(...picks.map(val)) : Math.min(...picks.map(val))) : null;
      return `<tr><td>${label}</td>${picks.map(p => `<td class="${dir && val(p) === target ? 'best' : ''}">${fmt(p)}</td>`).join('')}</tr>`;
    }).join('');

  const ctx = { crops, cy: c.cy, field: c.field, soil: c.soil, terrain: c.terrain, sum: c.sum, weights, known: c.known, beginner: c.beginner };
  $('strategies').innerHTML = picks.map(p => {
    const e = A.explainStrategy(p, current, ctx);
    return `<div class="strategy ${p.rotation === c.currentName ? 'current' : ''}">
      <span class="score">${r0(p.score)}</span><span class="kind">${p.label}</span>
      <h3>${esc(p.rotation)}</h3><p>${e.why}</p>
      <h4>Benefits</h4>${list(e.benefits)}
      <h4>Evidence</h4>${list(e.evidence)}
      <h4>Risks to check locally</h4>${list(e.risks)}
      <h4>Information gaps</h4>${list(e.gaps)}</div>`;
  }).join('');

  $('ranking').innerHTML = '<tr><th>#</th><th>Rotation</th><th>Score</th><th>Moisture</th><th>Erosion</th><th>Income</th><th>Soil</th><th>Reliability</th><th>Costs</th><th>Pests</th><th>Typical profit</th></tr>' +
    ranked.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.rotation)}</td><td>${r0(r.score)}</td><td>${r0(r.water)}</td><td>${r0(r.erosion)}</td>` +
      `<td>${r0(r.income)}</td><td>${r0(r.soil)}</td><td>${r0(r.risk)}</td><td>${r0(r.cost)}</td><td>${r0(r.pests)}</td><td>${A.eur(r.profitNormal)}/ha</td></tr>`).join('');
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
  const backToStart = () => { $('results').hidden = true; $('progress').hidden = true; $('start').hidden = false; M.refresh(); };
  $('back').addEventListener('click', backToStart);
  $('progressBack').addEventListener('click', backToStart);

  await M.initMap(onFieldChange);
}

init();
