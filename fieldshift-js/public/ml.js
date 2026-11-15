// FieldShift season-risk model.
// Question: "Given the weather of this season SO FAR (plus the 7-day forecast), how likely is a good
// harvest next season for each crop?"
//
// Method: analog-year k-nearest neighbours (a classic, explainable ML method in climatology).
//  1. For every past season (24 years of NASA POWER data) we build the same features we can measure
//     today: rain and temperature from August up to the current month, and the current month's rain.
//  2. The label is what really happened that season for the crop (the full-season stress test).
//  3. We find the k past seasons that looked most like this one so far, and count how many of them
//     ended well. Closer analogs count more.
//  4. Leave-one-out validation: each past year is predicted from the others, so we can show how
//     often the model was right, compared with simply using the long-term average.
// Runs in the browser in a few milliseconds.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const SETTINGS = { k: 13, prior: 3 }; // prior = how many 'average seasons' are mixed in (shrinkage)
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; };

// months of the season window that are already known: August of the previous year up to "now".
// Returns [{y: offset (0 = sowing year, 1 = harvest year), m}]
function windowMonths(nowMonth) {
  const out = [];
  if (nowMonth >= 8) { for (let m = 8; m < nowMonth; m++) out.push({ y: 0, m }); }
  else {
    for (let m = 8; m <= 12; m++) out.push({ y: 0, m });
    for (let m = 1; m < nowMonth; m++) out.push({ y: 1, m });
  }
  return out; // complete months only; the current month is a separate feature
}

// Monthly totals of the current season from daily data (NASA POWER daily) + forecast
function currentSeasonMonthly(recent, forecast) {
  const by = {};
  for (const d of recent ?? []) {
    const k = d.date.slice(0, 7);
    (by[k] ??= { rain: 0, temps: [], days: 0, fc: 0 });
    by[k].rain += d.rainMm; by[k].temps.push(d.temp); by[k].days++;
  }
  for (const d of (forecast?.days ?? []).slice(0, 7)) {
    const k = d.date.slice(0, 7);
    if (recent?.some(r => r.date === d.date)) continue;
    (by[k] ??= { rain: 0, temps: [], days: 0, fc: 0 });
    by[k].rain += d.rainMm ?? 0; if (d.tMean != null) by[k].temps.push(d.tMean); by[k].days++; by[k].fc++;
  }
  return by;
}

/**
 * @param climate  NASA POWER monthly rows [{year, month, temp, rainMm}]
 * @param cy       stress test from analysis.cropYears: { rows:[{crop, year, ok}], years }
 * @param crops    crop list (crops.json)
 * @param recent   NASA POWER daily rows of the last 12 months (may be null)
 * @param forecast { days:[{date, tMean, rainMm}] } (may be null)
 */
export function predictSeason({ climate, cy, crops, recent, forecast, today = new Date() }) {
  const nowM = today.getMonth() + 1, nowY = today.getFullYear();
  const harvestYear = nowM >= 8 ? nowY + 1 : nowY;
  const win = windowMonths(nowM);
  const rain = {}, temp = {};
  for (const r of climate) { (rain[r.year] ??= {})[r.month] = r.rainMm; (temp[r.year] ??= {})[r.month] = r.temp; }

  // Features (the same for past seasons and this one):
  //  sowing   = rain in Aug–Sep before sowing (seedbed moisture for autumn crops)
  //  recharge = rain from October until now (refills the soil for next spring and summer)
  //  temp     = average temperature of the known months
  const isSowing = o => o.y === 0 && o.m <= 9;
  const sowWin = win.filter(isSowing), rechWin = win.filter(o => !isSowing(o));

  // the same features for this season, from daily NASA POWER data (+ forecast for this month)
  const by = currentSeasonMonthly(recent, forecast);
  const sowY = harvestYear - 1;
  const yOf = o => (o.y === 0 ? sowY : harvestYear);
  const key = o => `${yOf(o)}-${String(o.m).padStart(2, '0')}`;
  const daysIn = (y, m) => new Date(y, m, 0).getDate();
  const full = o => by[key(o)].rain * daysIn(yOf(o), o.m) / by[key(o)].days;
  const known = win.every(o => by[key(o)] && by[key(o)].days >= daysIn(yOf(o), o.m) - 6);
  const cur = by[`${nowY}-${String(nowM).padStart(2, '0')}`];
  // this month counts once at least 20 of its days are measured or forecast; scaled to a full month
  const curRain = cur && cur.days >= 20 ? cur.rain * daysIn(nowY, nowM) / cur.days : null;
  const useCur = curRain != null;
  const usedForecast = useCur && cur.fc > 0;
  const nowFeat = known ? {
    sowing: sowWin.reduce((s, o) => s + full(o), 0),
    recharge: rechWin.reduce((s, o) => s + full(o), 0) + (useCur ? curRain : 0),
    temp: win.length ? mean(win.map(o => mean(by[key(o)].temps))) : 0,
  } : null;

  const pastFeatures = H => {
    const yr = o => (o.y === 0 ? H - 1 : H);
    if (win.some(o => rain[yr(o)]?.[o.m] == null)) return null;
    const curYear = nowM >= 8 ? H - 1 : H;
    if (useCur && rain[curYear]?.[nowM] == null) return null;
    return {
      sowing: sowWin.reduce((s, o) => s + rain[yr(o)][o.m], 0),
      recharge: rechWin.reduce((s, o) => s + rain[yr(o)][o.m], 0) + (useCur ? rain[curYear][nowM] : 0),
      temp: win.length ? mean(win.map(o => temp[yr(o)][o.m])) : 0,
    };
  };

  const years = cy.years.filter(y => pastFeatures(y));
  const feats = Object.fromEntries(years.map(y => [y, pastFeatures(y)]));
  const names = [sowWin.length && 'sowing', (rechWin.length || useCur) && 'recharge', win.length && 'temp'].filter(Boolean);
  if (!nowFeat || years.length < 12 || !names.length) {
    return { ok: false, reason: !nowFeat ? 'Not enough recent weather data for this season yet.' : 'Not enough past seasons to learn from.' };
  }
  const stats = Object.fromEntries(names.map(n => { const v = years.map(y => feats[y][n]); return [n, { m: mean(v), s: sd(v) }]; }));
  const z = f => names.map(n => (f[n] - stats[n].m) / stats[n].s);
  const Z = Object.fromEntries(years.map(y => [y, z(feats[y])]));
  const zNow = z(nowFeat);
  const label = (crop, y) => cy.rows.find(r => r.crop === crop && r.year === y)?.ok;
  const knn = makeKnn(Z, label); // weighted kNN: closer seasons count more

  const list = crops.filter(c => c.crop !== 'Cover crop');
  const evaluation = looEval(years, Z, list, label, knn);
  const perCrop = list.map(c => {
    const base = mean(years.map(y => (label(c.crop, y) ? 1 : 0)));
    const { p, near } = knn(c.crop, zNow, years);
    const risk = Math.round((1 - p) * 100);
    return { crop: c.crop, p, base, risk, level: risk >= 60 ? 'high' : risk >= 30 ? 'medium' : 'low', analogs: near, shift: p - base };
  });

  const pct = nm => { const v = Math.round((nowFeat[nm] / stats[nm].m - 1) * 100); return `${v >= 0 ? '+' : ''}${v}%`; };
  const span = ws => (!ws.length ? '' : ws.length === 1 ? MONTHS[ws[0].m - 1] : `${MONTHS[ws[0].m - 1]}–${MONTHS[ws.at(-1).m - 1]}`);
  const rechLabel = [span(rechWin), useCur ? MONTHS[nowM - 1] + (usedForecast ? ' incl. 7-day forecast' : '') : ''].filter(Boolean).join(' + ');
  const describe = {
    sowing: `Rain before sowing (${span(sowWin)}): ${Math.round(nowFeat.sowing)} mm (${pct('sowing')} vs the average season)`,
    recharge: `Rain refilling the soil (${rechLabel}): ${Math.round(nowFeat.recharge)} mm (${pct('recharge')})`,
    temp: `Temperature (${span(win)}): ${nowFeat.temp.toFixed(1)} °C (${nowFeat.temp - stats.temp.m >= 0 ? '+' : ''}${(nowFeat.temp - stats.temp.m).toFixed(1)} °C vs average)`,
  };
  return {
    ok: true, harvestYear, usedForecast, k: SETTINGS.k, nYears: years.length,
    features: names.map(nm => describe[nm]),
    perCrop: perCrop.sort((a, b) => a.risk - b.risk),
    byCrop: Object.fromEntries(perCrop.map(x => [x.crop, x])),
    eval: evaluation,
    backtest: backtestByMonth({ climate, cy, crops }),
  };
}

// Leave-one-out: predict every past season from all the other seasons
function looEval(years, Z, list, label, knn) {
  let hits = 0, baseHits = 0, brier = 0, brierClim = 0, n = 0;
  for (const c of list) {
    for (const y of years) {
      const rest = years.filter(x => x !== y);
      const { p } = knn(c.crop, Z[y], rest);
      const truth = label(c.crop, y) ? 1 : 0;
      const baseLoo = mean(rest.map(x => (label(c.crop, x) ? 1 : 0)));
      hits += (p >= 0.5 ? 1 : 0) === truth; baseHits += (baseLoo >= 0.5 ? 1 : 0) === truth;
      brier += (p - truth) ** 2; brierClim += (baseLoo - truth) ** 2; n++;
    }
  }
  return {
    accuracy: hits / n, baseAccuracy: baseHits / n,
    brier: brier / n, brierClim: brierClim / n,
    skill: brierClim ? 1 - brier / brierClim : 0, // > 0 = better than the long-term average
    tests: n,
  };
}

// Retrospective: how good would the model have been at different points of the season?
// Uses only the 24 past seasons (no live data), so it can be checked by anyone.
export function backtestByMonth({ climate, cy, crops, months = [10, 12, 2, 4, 6] }) {
  const rain = {}, temp = {};
  for (const r of climate) { (rain[r.year] ??= {})[r.month] = r.rainMm; (temp[r.year] ??= {})[r.month] = r.temp; }
  const label = (crop, y) => cy.rows.find(r => r.crop === crop && r.year === y)?.ok;
  const list = crops.filter(c => c.crop !== 'Cover crop');
  return months.map(nowM => {
    const win = windowMonths(nowM);
    const feat = H => {
      const yr = o => (o.y === 0 ? H - 1 : H);
      const curYear = nowM >= 8 ? H - 1 : H;
      if (win.some(o => rain[yr(o)]?.[o.m] == null) || rain[curYear]?.[nowM] == null) return null;
      const sowing = win.filter(o => o.y === 0 && o.m <= 9).reduce((s, o) => s + rain[yr(o)][o.m], 0);
      const recharge = win.filter(o => !(o.y === 0 && o.m <= 9)).reduce((s, o) => s + rain[yr(o)][o.m], 0) + rain[curYear][nowM];
      return [sowing, recharge, win.length ? mean(win.map(o => temp[yr(o)][o.m])) : 0];
    };
    const years = cy.years.filter(feat);
    const raw = Object.fromEntries(years.map(y => [y, feat(y)]));
    const cols = [0, 1, 2].map(i => ({ m: mean(years.map(y => raw[y][i])), s: sd(years.map(y => raw[y][i])) }));
    const Z = Object.fromEntries(years.map(y => [y, raw[y].map((v, i) => (v - cols[i].m) / cols[i].s)]));
    const knn = makeKnn(Z, label);
    return { month: MONTHS[nowM - 1], ...looEval(years, Z, list, label, knn) };
  });
}

function makeKnn(Z, label) {
  const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
  return (crop, target, pool) => {
    const near = pool.map(y => ({ year: y, d: dist(target, Z[y]) })).sort((a, b) => a.d - b.d).slice(0, SETTINGS.k);
    const w = near.map(n => 1 / (0.25 + n.d));
    const base = mean(pool.map(y => (label(crop, y) ? 1 : 0)));
    const wSum = w.reduce((a, b) => a + b, 0), wMean = wSum / w.length;
    const p = (near.reduce((s, n, i) => s + (label(crop, n.year) ? w[i] : 0), 0) + SETTINGS.prior * wMean * base) / (wSum + SETTINGS.prior * wMean);
    return { p, near: near.map(n => ({ year: n.year, ok: !!label(crop, n.year), similarity: Math.round(100 / (1 + n.d)) })) };
  };
}

// One 0–100 risk score for the coming season of a crop: model risk, nudged by active alerts.
export function riskScore(pred, crop, alerts = []) {
  const m = pred?.ok ? pred.byCrop[crop] : null;
  let score = m ? m.risk : null;
  if (score == null) return null;
  // only hazards that can change the season's outcome, and only a little: the model already holds most of the signal
  const bump = { urgent: 8, warning: 4, advice: 1, info: 0 };
  for (const a of alerts.filter(x => ['drought', 'frost', 'heat', 'flood', 'hail', 'vegetation'].includes(x.type))) score += bump[a.level] ?? 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', model: m };
}
