import * as A from './analysis.js';

const $ = id => document.getElementById(id);
const r0 = x => Math.round(x);
const FIELD_BOX = 0.003; // must match the Sentinel box size on the server
const state = { crops: [], rotations: {}, loc: null, data: null, weights: null };
const charts = {};

// ================= START PAGE =================

let map, marker, box;
function initMap() {
  map = L.map('map').setView([43.6, 27.9], 9); // Dobrudzha
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, attribution: 'Imagery © Esri' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  satellite.addTo(map);
  L.control.layers({ Satellite: satellite, Map: streets }).addTo(map);
  map.on('click', e => setLocation(e.latlng.lat, e.latlng.lng));
}

async function setLocation(lat, lon, name) {
  state.loc = { lat, lon, name: name || '' };
  marker?.remove(); box?.remove();
  marker = L.marker([lat, lon]).addTo(map);
  box = L.rectangle([[lat - FIELD_BOX, lon - FIELD_BOX], [lat + FIELD_BOX, lon + FIELD_BOX]], { color: '#1d9e75', weight: 2 }).addTo(map);
  if (map.getZoom() < 13) map.setView([lat, lon], 14);
  $('analyze').disabled = false;
  $('picked').textContent = `📍 Field selected: ${lat.toFixed(4)}, ${lon.toFixed(4)}${name ? ' · ' + name : ''} (the green box is the area the satellites analyse)`;
  if (!name) {
    try {
      const r = await (await fetch(`/api/reverse?lat=${lat}&lon=${lon}`)).json();
      if (r.name && state.loc.lat === lat) { state.loc.name = r.name; $('picked').textContent = `📍 Field selected: ${r.name} (${lat.toFixed(4)}, ${lon.toFixed(4)})`; }
    } catch { /* name is optional */ }
  }
}

async function search(e) {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchResults').innerHTML = '<li>Searching…</li>';
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);
    $('searchResults').innerHTML = list.length ? '' : '<li>No results. Try a nearby town, or click on the map.</li>';
    for (const r of list) {
      const li = document.createElement('li');
      li.textContent = r.name;
      li.onclick = () => { map.setView([r.lat, r.lon], 14); $('searchResults').innerHTML = ''; setLocation(r.lat, r.lon, r.name.split(',').slice(0, 2).join(',')); };
      $('searchResults').append(li);
    }
  } catch (err) {
    $('searchResults').innerHTML = `<li>Search failed (${err.message}). Click on the map instead.</li>`;
  }
}

function priorityWeights() {
  const chosen = [...document.querySelectorAll('#priorities input:checked')].map(i => i.value);
  return Object.fromEntries(['water', 'erosion', 'income', 'soil', 'risk'].map(k => [k, chosen.length ? (chosen.includes(k) ? 10 : 3) : 5]));
}

async function analyze() {
  const { lat, lon } = state.loc;
  $('analyze').disabled = true;
  const steps = ['Reading 25 years of NASA climate data…', 'Scanning your field with Sentinel-2 (5 years, every 10 days)…',
    'Checking soil and slope…', 'Stress-testing crops against every past season…'];
  let i = 0;
  $('status').textContent = steps[0];
  const timer = setInterval(() => { i = Math.min(i + 1, steps.length - 1); $('status').textContent = steps[i]; }, 4000);
  try {
    const res = await fetch(`/api/analyze?lat=${lat}&lon=${lon}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.data = data;
    state.weights = priorityWeights();
    document.querySelectorAll('[data-w]').forEach(s => { s.value = state.weights[s.dataset.w]; s.nextElementSibling.textContent = s.value; });
    $('start').hidden = true; $('results').hidden = false; window.scrollTo(0, 0);
    renderAll();
  } catch (err) {
    $('status').textContent = `Something went wrong: ${err.message}`;
  } finally {
    clearInterval(timer);
    $('analyze').disabled = false;
    if (!$('status').textContent.startsWith('Something')) $('status').textContent = '';
  }
}

// ================= RESULTS =================

function drawChart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), { ...config, options: { responsive: true, maintainAspectRatio: false, animation: false, ...config.options } });
}

const list = items => `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`;

function renderAll() {
  const d = state.data, crops = state.crops;
  const sum = A.climateSummary(d.climate.data);
  const recent = d.recent.ok ? A.recentVsNormal(d.recent.data, sum) : null;
  const field = d.sentinel.ok ? A.fieldSummary(d.sentinel.data) : null;
  const soil = d.soil.data, terrain = d.terrain.ok ? d.terrain.data : null;
  const cy = A.cropYears(d.climate.data, crops, soil.awcMm);
  const cyFuture = A.cropYears(A.applyFuture(d.climate.data, sum, 2035), crops, soil.awcMm);
  const currentName = $('current').value;
  const currentPlan = state.rotations[currentName].plan;
  Object.assign(state, { sum, recent, field, soil, terrain, cy, cyFuture });

  $('placeName').textContent = state.loc.name || 'Your field';
  $('coords').textContent = `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;

  // insights
  const insights = A.buildInsights({ sum, recent, field, soil, terrain, cyNow: cy, cyFuture, crops, currentPlan });
  $('insights').innerHTML = insights.map(x => `<div class="insight ${x.level}"><h3>${x.title}</h3><p>${x.text}</p><span class="src">Source: ${x.source}</span></div>`).join('');

  // charts
  const sent = d.sentinel.ok ? d.sentinel.data : [];
  if (sent.length) {
    drawChart('fieldChart', { type: 'line', data: { labels: sent.map(r => r.date), datasets: [
      { label: 'Greenness (NDVI)', data: sent.map(r => r.ndvi), borderColor: '#1D9E75', pointRadius: 0, tension: 0.3 },
      { label: 'Moisture (NDMI)', data: sent.map(r => r.ndmi), borderColor: '#378ADD', pointRadius: 0, tension: 0.3 },
    ] }, options: { scales: { x: { ticks: { maxTicksLimit: 8 } } } } });
    $('fieldNote').textContent = d.sentinel.backup ? 'Showing the last saved satellite data (live request failed).' : '';
  } else {
    charts.fieldChart?.destroy();
    $('fieldNote').textContent = `No satellite history available: ${d.sentinel.error ?? 'no data'}`;
  }
  if (recent) {
    drawChart('rainChart', { type: 'bar', data: { labels: recent.months.map(m => m.label), datasets: [
      { label: 'Rain this year', data: recent.months.map(m => r0(m.rain)), backgroundColor: '#378ADD' },
      { label: 'Normal (25-yr avg)', data: recent.months.map(m => r0(m.normal)), type: 'line', borderColor: '#444441', pointRadius: 2 },
    ] } });
  }
  drawChart('tempChart', { type: 'line', data: { labels: sum.years, datasets: [
    { label: 'Avg temp', data: sum.yearlyTemp.map(t => +t.toFixed(1)), borderColor: '#D85A30', pointRadius: 0, tension: 0.3 },
  ] }, options: { plugins: { legend: { display: false } } } });
  const ranks = A.rankCrops(cy, crops);
  const futPct = c => cyFuture.rows.filter(r => r.crop === c && r.ok).length / cy.years.length * 100;
  drawChart('cropChart', { type: 'bar', data: { labels: ranks.map(r => r.crop), datasets: [
    { label: 'Past seasons OK', data: ranks.map(r => r0(r.pct)), backgroundColor: '#1D9E75' },
    { label: '2035 trend', data: ranks.map(r => r0(futPct(r.crop))), backgroundColor: '#EF9F27' },
  ] }, options: { scales: { y: { max: 100 } } } });

  renderVerdict(ranks);
  renderStrategies();
}

function renderVerdict(ranks) {
  const mode = document.querySelector('[name=mode]:checked').value;
  const box = $('verdictBox');
  box.hidden = false;
  if (mode === 'crop') {
    const v = A.cropVerdict($('focusCrop').value, state.cy, state.cyFuture, state.crops);
    box.className = v.level;
    box.innerHTML = `<h2>${v.verdict}</h2><p>${v.detail}</p><p>${v.note}</p>` +
      (v.alternatives.length ? `<p><b>More reliable alternatives here:</b> ${v.alternatives.map(a => `${a.crop} (${r0(a.pct)}% of seasons OK)`).join(', ')}.</p>` : '');
  } else {
    box.className = '';
    box.innerHTML = '<h2>Most reliable crops for this field</h2><p class="muted">Share of the past seasons with enough water and no heat stress, and the expected profit including bad years (NASA POWER stress test).</p>' +
      '<div class="table-wrap"><table><tr><th>Crop</th><th>Seasons OK</th><th>By 2035 (trend)</th><th>Expected profit</th></tr>' +
      ranks.slice(0, 6).map(r => `<tr><td>${r.crop}${r.legume ? ' 🌱' : ''}</td><td>${r0(r.pct)}%</td>` +
        `<td>${r0(state.cyFuture.rows.filter(x => x.crop === r.crop && x.ok).length / state.cy.years.length * 100)}%</td><td>${A.eur(r.profit)}/ha</td></tr>`).join('') +
      '</table></div><p class="muted">🌱 = fixes nitrogen</p>';
  }
}

function renderStrategies() {
  const { crops, cy, cyFuture, soil, field, weights } = state;
  const ranked = A.scoreRotations({ rotations: state.rotations, crops, cy, cyFuture, soil, field, weights });
  const currentName = $('current').value;
  const focus = document.querySelector('[name=mode]:checked').value === 'crop' ? $('focusCrop').value : null;
  const picks = A.pickStrategies(ranked, currentName, focus);
  const current = ranked.find(r => r.rotation === currentName);
  const best = picks.filter(p => p.rotation !== currentName).sort((a, b) => b.score - a.score)[0];

  // action
  const item = best.plan.find(i => !current.plan.includes(i)) ?? best.plan[0];
  const next = item.includes('+') ? `a cover crop right after harvest, then ${item.split('+')[1]} in spring` : item;
  $('action').innerHTML = best.score > current.score + 2
    ? `<b>Our suggestion:</b> move from <b>${currentName}</b> to <b>${best.rotation}</b>. Next season, start with <b>${next}</b>. ` +
      `Score ${r0(best.score)} vs ${r0(current.score)} for what matters to you.`
    : `<b>Your current rotation (${currentName}) already fits your priorities well.</b> The options below show what you could gain or lose by changing.`;

  // comparison table: one column per strategy
  const rows = [
    ['Match with your priorities (0–100)', p => r0(p.score), 'max'],
    ['Harvest success, past 25 years', p => `${r0(p.risk)}%`, 'max', p => p.risk],
    ['Harvest success, 2035 trend', p => `${r0(p.riskFuture)}%`, 'max', p => p.riskFuture],
    ['Water demand (mm/yr)', p => r0(p.waterDemand), 'min', p => p.waterDemand],
    ['Bare soil (months/yr)', p => p.bare.toFixed(1), 'min', p => p.bare],
    ['Typical profit (€/ha/yr)', p => A.eur(p.profitNormal), 'max', p => p.profitNormal],
    ['Bad-year profit (€/ha/yr)', p => A.eur(p.profitBad), 'max', p => p.profitBad],
    ['Fertilizer saved (€/ha/yr)', p => A.eur(p.nSavedEur), 'max', p => p.nSavedEur],
    ['Switching effort', p => p.difficulty, null],
  ];
  $('compare').innerHTML = `<tr><th></th>${picks.map(p => `<th>${p.label}<br><b style="color:var(--text)">${p.rotation}</b></th>`).join('')}</tr>` +
    rows.map(([label, fmt, dir, val]) => {
      const v = val ?? (p => p.score);
      const target = dir ? (dir === 'max' ? Math.max(...picks.map(v)) : Math.min(...picks.map(v))) : null;
      return `<tr><td>${label}</td>${picks.map(p => `<td class="${dir && v(p) === target ? 'best' : ''}">${fmt(p)}</td>`).join('')}</tr>`;
    }).join('');

  // strategy cards
  const ctx = { crops, cy, field, soil, terrain: state.terrain, sum: state.sum, weights };
  $('strategies').innerHTML = picks.map(p => {
    const e = A.explainStrategy(p, current, ctx);
    return `<div class="strategy ${p.rotation === currentName ? 'current' : ''}">
      <span class="score">${r0(p.score)}</span><span class="kind">${p.label}</span>
      <h3>${p.rotation}</h3><p>${e.why}</p>
      <h4>Benefits</h4>${list(e.benefits)}
      <h4>Evidence</h4>${list(e.evidence)}
      <h4>Risks to check locally</h4>${list(e.risks)}
      <h4>Information gaps</h4>${list(e.gaps)}</div>`;
  }).join('');

  $('ranking').innerHTML = '<tr><th>#</th><th>Rotation</th><th>Score</th><th>Moisture</th><th>Erosion</th><th>Income</th><th>Soil</th><th>Reliability</th><th>Typical profit</th></tr>' +
    ranked.map((r, i) => `<tr><td>${i + 1}</td><td>${r.rotation}</td><td>${r0(r.score)}</td><td>${r0(r.water)}</td><td>${r0(r.erosion)}</td>` +
      `<td>${r0(r.income)}</td><td>${r0(r.soil)}</td><td>${r0(r.risk)}</td><td>${A.eur(r.profitNormal)}/ha</td></tr>`).join('');
}

// ================= START =================

async function init() {
  [state.crops, state.rotations] = await Promise.all(['crops', 'rotations'].map(f => fetch(`data/${f}.json`).then(r => r.json())));
  $('focusCrop').innerHTML = state.crops.filter(c => c.crop !== 'Cover crop').map(c => `<option>${c.crop}</option>`).join('');
  $('current').innerHTML = Object.entries(state.rotations).map(([n, r]) => `<option${n === 'Wheat > Sunflower' ? ' selected' : ''}>${n}</option>`).join('');

  initMap();
  $('searchForm').addEventListener('submit', search);
  document.querySelectorAll('[name=mode]').forEach(r => r.addEventListener('change', () => { $('cropPick').hidden = r.value !== 'crop' || !r.checked; }));
  $('analyze').addEventListener('click', analyze);
  $('back').addEventListener('click', () => { $('results').hidden = true; $('start').hidden = false; map.invalidateSize(); });
  document.querySelectorAll('[data-w]').forEach(s => s.addEventListener('input', () => {
    s.nextElementSibling.textContent = s.value;
    state.weights[s.dataset.w] = +s.value;
    renderStrategies();
  }));
}

init();
