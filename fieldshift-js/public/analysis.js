// FieldShift analysis engine. Turns raw satellite and climate data into:
//  1. hidden insights about the field (things a farmer can't see with the naked eye)
//  2. a 20-year stress test of every crop
//  3. scored rotation strategies with why / evidence / benefits / risks / gaps
// Runs in the browser, so changing priorities updates the results instantly.

const N_PRICE_EUR_KG = 1.0;      // rough nitrogen fertilizer price
const FAIL_YIELD_SHARE = 0.5;    // failed season = half the normal yield
const ENOUGH_WATER_SHARE = 0.75; // rain + soil water must cover 75% of crop need
const COVER_WATER_USE_MM = 30;   // spring moisture a cover crop takes from the next crop
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r0 = x => Math.round(x);
export const eur = x => (x < 0 ? '-€' : '€') + Math.abs(Math.round(x));
const slope = (xs, ys) => {
  const mx = mean(xs), my = mean(ys);
  let n = 0, d = 0;
  xs.forEach((x, i) => { n += (x - mx) * (ys[i] - my); d += (x - mx) ** 2; });
  return d ? n / d : 0;
};
const percentile = (v, p) => {
  const s = [...v].sort((a, b) => a - b), i = (s.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const seasonMonths = (start, end) => {
  const m = [];
  for (let i = start; ; i = i % 12 + 1) { m.push(i); if (i === end) break; }
  return m;
};

// =============== 1. CLIMATE ===============

export function climateSummary(climate) {
  const byYear = {};
  for (const r of climate) {
    const y = (byYear[r.year] ??= { temps: [], rain: 0, season: 0, n: 0 });
    y.temps.push(r.temp); y.rain += r.rainMm; y.n++;
    if (r.month >= 4 && r.month <= 9) y.season += r.rainMm;
  }
  const years = Object.keys(byYear).map(Number).filter(y => byYear[y].n === 12).sort((a, b) => a - b);
  const yearlyTemp = years.map(y => mean(byYear[y].temps));
  const yearlyRain = years.map(y => byYear[y].rain);
  const seasonRain = years.map(y => byYear[y].season);
  const avgSeason = mean(seasonRain);
  const rainNormal = MONTHS.map((_, m) => mean(climate.filter(r => r.month === m + 1).map(r => r.rainMm)));
  const tempNormal = MONTHS.map((_, m) => mean(climate.filter(r => r.month === m + 1).map(r => r.temp)));
  const recentYears = years.slice(-10);
  return {
    years, yearlyTemp, yearlyRain, rainNormal, tempNormal,
    rainYear: mean(yearlyRain), rainSeason: avgSeason, temp: mean(yearlyTemp),
    tempTrendDecade: slope(years, yearlyTemp) * 10,
    rainTrendDecade: slope(years, yearlyRain) * 10,
    droughtYears: years.filter((y, i) => seasonRain[i] < 0.75 * avgSeason),
    droughtYearsRecent: recentYears.filter(y => byYear[y].season < 0.75 * avgSeason).length,
    firstYear: years[0], lastYear: years.at(-1),
    driestMonth: rainNormal.indexOf(Math.min(...rainNormal)) + 1,
  };
}

export function applyFuture(climate, sum, targetYear = 2035) {
  const ahead = targetYear - sum.lastYear;
  const shift = sum.tempTrendDecade / 10 * ahead;
  const factor = Math.max(0.3, 1 + sum.rainTrendDecade / 10 * ahead / sum.rainYear);
  return climate.map(r => ({ ...r, temp: r.temp + shift, rainMm: r.rainMm * factor }));
}

// Last 12 months of daily NASA POWER data vs the 25-year monthly normal.
export function recentVsNormal(recent, sum) {
  if (!recent?.length) return null;
  const byMonth = {};
  for (const d of recent) {
    const k = d.date.slice(0, 7);
    (byMonth[k] ??= { rain: 0, days: 0, temps: [] });
    byMonth[k].rain += d.rainMm; byMonth[k].days++; byMonth[k].temps.push(d.temp);
  }
  const months = Object.keys(byMonth).sort().filter(k => byMonth[k].days >= 25).slice(-12).map(k => {
    const m = +k.slice(5) - 1;
    return { key: k, label: `${MONTHS[m]} ${k.slice(2, 4)}`, rain: byMonth[k].rain, normal: sum.rainNormal[m],
      temp: mean(byMonth[k].temps), tempNormal: sum.tempNormal[m] };
  });
  const last3 = months.slice(-3);
  const r3 = last3.reduce((s, x) => s + x.rain, 0), n3 = last3.reduce((s, x) => s + x.normal, 0);
  const r12 = months.reduce((s, x) => s + x.rain, 0), n12 = months.reduce((s, x) => s + x.normal, 0);
  return {
    months,
    last3Pct: n3 ? (r3 / n3 - 1) * 100 : 0, last3Rain: r3, last3Normal: n3, last3Label: `${last3[0]?.label}–${last3.at(-1)?.label}`,
    last12Pct: n12 ? (r12 / n12 - 1) * 100 : 0,
    tempAnomaly: mean(months.map(x => x.temp - x.tempNormal)),
  };
}

// =============== 2. FIELD (Sentinel-2) ===============

export function fieldSummary(rows) {
  if (!rows?.length) return null;
  const now = Date.now(), yearAgo = now - 365 * 864e5;
  const last = rows.filter(r => new Date(r.date) >= yearAgo);
  const earlier = rows.filter(r => new Date(r.date) < yearAgo);
  const month = r => +r.date.slice(5, 7);

  // bare soil in the last 12 months (scaled for cloudy gaps)
  const bareDays = last.length >= 6 ? r0(mean(last.map(r => r.bare)) * 365) : null;

  // months that are usually bare, across all years
  const typicalBare = MONTHS.map((_, m) => {
    const inMonth = rows.filter(r => month(r) === m + 1);
    return inMonth.length ? mean(inMonth.map(r => r.bare)) : 0;
  });
  const bareMonths = typicalBare.map((v, i) => (v >= 0.5 ? i : -1)).filter(i => i >= 0);

  // moisture (NDMI) of the last 12 months vs the same months in earlier years
  let moistureChange = null;
  const valid = last.filter(r => typeof r.ndmi === 'number');
  if (valid.length >= 6 && earlier.length >= 12) {
    const base = MONTHS.map((_, m) => {
      const v = earlier.filter(r => month(r) === m + 1 && typeof r.ndmi === 'number').map(r => r.ndmi);
      return v.length ? mean(v) : null;
    });
    const pairs = valid.filter(r => base[month(r) - 1] != null);
    const recentMean = mean(pairs.map(r => r.ndmi)), baseMean = mean(pairs.map(r => base[month(r) - 1]));
    const points = recentMean - baseMean;
    moistureChange = { points, pct: Math.abs(baseMean) > 0.05 ? points / Math.abs(baseMean) * 100 : null };
  }

  // peak greenness per year
  const peaks = {};
  for (const r of rows) { const y = r.date.slice(0, 4); peaks[y] = Math.max(peaks[y] ?? -1, r.ndvi); }
  const years = Object.keys(peaks).sort();
  const peakVals = years.map(y => peaks[y]);
  const thisPeak = peakVals.at(-1), prevPeak = mean(peakVals.slice(0, -1));

  return {
    bareDays, bareMonths, typicalBare, moistureChange, years, peakVals,
    peakNdvi: mean(peakVals), peakChange: peakVals.length > 1 ? thisPeak - prevPeak : 0,
    ndviTrend: peakVals.length > 1 ? slope(years.map(Number), peakVals) * years.length : 0,
    observations: rows.length,
  };
}

// =============== 3. INSIGHTS (what the farmer can't see) ===============

export function buildInsights({ sum, recent, field, soil, terrain, cyNow, cyFuture, crops, currentPlan }) {
  const out = [];
  const add = (level, title, text, source) => out.push({ level, title, text, source });

  if (recent) {
    const p = recent.last3Pct;
    add(p < -25 ? 'bad' : p < -10 ? 'warn' : 'good', 'Recent rain vs normal',
      `The last 3 months (${recent.last3Label}) brought ${r0(recent.last3Rain)} mm of rain, ` +
      `${Math.abs(r0(p))}% ${p < 0 ? 'below' : 'above'} the 25-year normal of ${r0(recent.last3Normal)} mm.` +
      (p < -25 ? ' Soils are likely starting drier than usual.' : ''), 'NASA POWER');
  }
  if (field?.bareDays != null) {
    add(field.bareDays > 150 ? 'bad' : field.bareDays > 90 ? 'warn' : 'good', 'Bare soil',
      `Your field was without plant cover for about ${field.bareDays} days in the last 12 months` +
      (field.bareMonths.length ? `, usually in ${field.bareMonths.map(m => MONTHS[m]).join(', ')}.` : '.') +
      ' Bare soil loses moisture and topsoil to wind and rain.', 'ESA Sentinel-2 (Bare Soil Index + NDVI)');
  }
  if (field?.moistureChange) {
    const { pct, points } = field.moistureChange;
    const txt = pct != null ? `${Math.abs(r0(pct))}% ${pct < 0 ? 'lower' : 'higher'}` : `${Math.abs(points).toFixed(2)} index points ${points < 0 ? 'lower' : 'higher'}`;
    add(points < -0.03 ? 'bad' : points < 0 ? 'warn' : 'good', 'Field moisture',
      `The moisture index of your field over the last 12 months was ${txt} than in the same months of previous years.`,
      'ESA Sentinel-2 (Moisture Index, NDMI)');
  }
  if (field && field.peakVals.length > 1) {
    const c = field.peakChange;
    add(c < -0.05 ? 'warn' : 'good', 'Crop vigor',
      `This year's peak greenness (NDVI ${field.peakVals.at(-1).toFixed(2)}) was ${c < 0 ? 'lower' : 'higher'} than the average of earlier years (${(field.peakVals.at(-1) - c).toFixed(2)}).` +
      (c < -0.05 ? ' The crop was under more stress than usual.' : ''), 'ESA Sentinel-2 (NDVI)');
  }
  add(sum.droughtYearsRecent >= 3 ? 'bad' : sum.droughtYearsRecent >= 2 ? 'warn' : 'good', 'Drought frequency',
    `${sum.droughtYearsRecent} of the last 10 summers had less than 75% of normal growing-season rain. Driest month on average: ${MONTHS[sum.driestMonth - 1]}.`,
    'NASA POWER, 25 years');
  add(sum.tempTrendDecade > 0.3 ? 'warn' : 'good', 'Warming trend',
    `Average temperature here is changing by ${sum.tempTrendDecade >= 0 ? '+' : ''}${sum.tempTrendDecade.toFixed(2)} °C per decade` +
    ` and yearly rain by ${sum.rainTrendDecade >= 0 ? '+' : ''}${r0(sum.rainTrendDecade)} mm per decade.`, 'NASA POWER, 25 years');

  // how the current crops hold up now vs 2035
  const main = [...new Set(currentPlan.map(i => i.split('+').at(-1)))];
  const okRate = (cy, c) => mean(cy.rows.filter(r => r.crop === c).map(r => (r.ok ? 1 : 0))) * 100;
  for (const c of main) {
    const now = okRate(cyNow, c), fut = okRate(cyFuture, c);
    if (now < 75 || fut < now - 5) {
      add(fut < 60 ? 'bad' : 'warn', `${c}: future outlook`,
        `${c} had enough water and no heat stress in ${r0(now)}% of past seasons. If current trends continue, that drops to about ${r0(fut)}% by 2035.`,
        'NASA POWER trend projection');
    }
  }
  if (terrain) {
    const s = terrain.slopePct;
    add(s > 6 ? 'bad' : s > 3 ? 'warn' : 'good', 'Slope and erosion',
      `Your field sits at ${r0(terrain.elevationM)} m with a slope of about ${s.toFixed(1)}%. ` +
      (s > 3 ? 'Rain can wash away bare soil here, so keeping the ground covered matters.' : 'Mostly flat, so water erosion risk is low; wind erosion on bare soil is still possible.'),
      'NASA SRTM elevation');
  }
  if (soil && !soil.isDefault) {
    add(soil.socGKg < 10 ? 'warn' : 'good', 'Soil',
      `${soil.texture} soil, organic carbon ${soil.socGKg.toFixed(1)} g/kg${soil.socGKg < 10 ? ' (low)' : ''}, pH ${soil.ph.toFixed(1)}. ` +
      `It can store roughly ${soil.awcMm} mm of water for crops.`, 'ISRIC SoilGrids');
  }
  return out;
}

// =============== 4. STRESS TEST ===============

export function cropYears(climate, crops, awcMm) {
  const rain = {}, temp = {};
  for (const r of climate) { (rain[r.year] ??= {})[r.month] = r.rainMm; (temp[r.year] ??= {})[r.month] = r.temp; }
  const complete = Object.keys(rain).map(Number).filter(y => Object.keys(rain[y]).length === 12);
  const years = complete.filter(y => complete.includes(y - 1)).sort((a, b) => a - b);

  const rows = [];
  for (const c of crops) {
    for (const y of years) {
      let seasonRain = 0;
      for (const m of seasonMonths(c.seasonStart, c.seasonEnd)) {
        const yr = c.seasonStart > c.seasonEnd && m >= c.seasonStart ? y - 1 : y; // autumn-sown crops
        seasonRain += rain[yr][m];
      }
      const peakTemp = Math.max(...c.criticalMonths.map(m => temp[y][m]));
      rows.push({ crop: c.crop, year: y, seasonRain, peakTemp, need: c.waterNeedMm, heatLimit: c.heatLimitC,
        waterOk: seasonRain + awcMm >= ENOUGH_WATER_SHARE * c.waterNeedMm, heatOk: peakTemp <= c.heatLimitC, awcMm });
    }
  }
  rows.forEach(r => { r.ok = r.waterOk && r.heatOk; });
  return { rows, years };
}

// Plan items can be "Crop" or "Cover crop+Crop" (cover crop over winter, then the main crop).
const split = item => { const p = item.split('+'); return { cover: p.length > 1 ? p[0] : null, main: p.at(-1) }; };

function itemOk(cy, item, year) {
  const { cover, main } = split(item);
  const r = cy.rows.find(x => x.crop === main && x.year === year);
  if (!r) return false;
  if (!cover) return r.ok;
  const waterOk = r.seasonRain - COVER_WATER_USE_MM + r.awcMm >= ENOUGH_WATER_SHARE * r.need;
  return waterOk && r.heatOk;
}

// bare months per year: gaps between one crop's harvest and the next sowing (rotation repeats)
function bareMonthsPerYear(plan, crop) {
  let gaps = 0;
  plan.forEach((item, i) => {
    const cur = split(item), nxt = split(plan[(i + 1) % plan.length]);
    if (cur.main === nxt.main && crop[cur.main].perennial) return;
    const harvest = crop[cur.main].seasonEnd;
    const sow = nxt.cover ? crop[nxt.cover].seasonStart : crop[nxt.main].seasonStart;
    gaps += ((sow - harvest - 1) % 12 + 12) % 12;
  });
  return gaps / plan.length;
}

export function scoreRotations({ rotations, crops, cy, cyFuture, soil, field, weights }) {
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  const results = Object.entries(rotations).map(([name, { plan, type }]) => {
    const items = plan.map(split);
    const mains = items.map(i => i.main);
    const unique = [...new Set(mains)];
    const covers = items.filter(i => i.cover).length;

    const okShare = (data, item) => mean(data.years.map(y => (itemOk(data, item, y) ? 1 : 0)));
    const risk = mean(plan.map(it => okShare(cy, it))) * 100;
    const riskFuture = mean(plan.map(it => okShare(cyFuture, it))) * 100;

    const avgRain = c => mean(cy.rows.filter(r => r.crop === c).map(r => r.seasonRain));
    const water = mean(mains.map(c => Math.min(1, (avgRain(c) + soil.awcMm) / crop[c].waterNeedMm))) * 100;
    const waterDemand = mean(items.map(i => crop[i.main].waterNeedMm + (i.cover ? COVER_WATER_USE_MM : 0)));

    const bare = bareMonthsPerYear(plan, crop);
    const erosion = clamp(100 - bare / 6 * 100, 0, 100);

    const legumes = unique.filter(c => crop[c].legume);
    const repeats = mains.filter((c, i) => c === mains[(i + 1) % mains.length] && !crop[c].perennial).length;
    let soilScore = 40 + legumes.length * (soil.socGKg < 10 ? 18 : 12) + covers * 15 - repeats * 15
      + (unique.length >= 3 ? 10 : 0) + (mains.some(c => crop[c].perennial) ? 10 : 0);
    if (soil.ph < 6 && mains.some(c => c === 'Peas' || c === 'Alfalfa')) soilScore -= 15;
    soilScore = clamp(soilScore, 0, 100);

    // profit per past year with that year's real weather; legumes and cover crops feed the next crop
    const nKg = items.reduce((s, i) => s + (crop[i.main].legume ? crop[i.main].nFixedKgHa : 0) + (i.cover ? crop[i.cover].nFixedKgHa : 0), 0);
    const yearly = cy.years.map(y => mean(plan.map((it, idx) => {
      const { cover, main } = items[idx], k = crop[main], prev = crop[items.at(idx - 1).main];
      const share = itemOk(cy, it, y) ? 1 : FAIL_YIELD_SHARE;
      return k.yieldTHa * k.priceEurT * share - k.costEurHa
        - (cover ? crop[cover].costEurHa - crop[cover].nFixedKgHa * N_PRICE_EUR_KG : 0)
        + (prev.legume ? prev.nFixedKgHa * N_PRICE_EUR_KG : 0);
    })));

    const levels = ['easy', 'medium', 'hard'];
    const difficulty = [...unique, ...items.filter(i => i.cover).map(i => i.cover)]
      .map(c => crop[c].switchDifficulty).reduce((a, b) => (levels.indexOf(b) > levels.indexOf(a) ? b : a), 'easy');

    return {
      rotation: name, plan, type, mains, unique, covers, legumes,
      risk, riskFuture, water, waterDemand, bare, erosion, soil: soilScore, difficulty,
      nSavedEur: nKg * N_PRICE_EUR_KG / plan.length,
      profitBad: percentile(yearly, 10), profitNormal: percentile(yearly, 50), profitGood: percentile(yearly, 90),
    };
  });

  const p = results.map(r => r.profitNormal), lo = Math.min(...p), hi = Math.max(...p);
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  for (const r of results) {
    r.income = hi === lo ? 100 : (r.profitNormal - lo) / (hi - lo) * 100;
    r.score = Object.entries(weights).reduce((s, [k, w]) => s + r[k] * w, 0) / wSum;
  }
  return results.sort((a, b) => b.score - a.score);
}

// =============== 5. STRATEGIES ===============

const TYPE_LABEL = {
  current: 'Your current rotation', moisture: 'Moisture-saving (cover crops)', drought: 'Drought-tolerant',
  nitrogen: 'Nitrogen-fixing (legumes)', diversified: 'Diversified', traditional: 'Traditional', best: 'Best match for your priorities',
};

// Pick at least 3 strategies: current + moisture-saving + nitrogen-fixing + best overall.
export function pickStrategies(ranked, currentName, focusCrop) {
  const pool = focusCrop ? ranked.filter(r => r.mains.includes(focusCrop)) : ranked;
  const picked = [];
  const add = (r, label) => { if (r && !picked.some(p => p.rotation === r.rotation)) picked.push({ ...r, label }); };
  add(ranked.find(r => r.rotation === currentName), TYPE_LABEL.current);
  add(pool.find(r => r.type === 'moisture' || r.type === 'drought'), TYPE_LABEL.moisture);
  add(pool.find(r => r.type === 'nitrogen'), TYPE_LABEL.nitrogen);
  add(pool[0], TYPE_LABEL.best);
  for (const r of pool) { if (picked.length >= 4) break; add(r, TYPE_LABEL[r.type]); }
  for (const r of ranked) { if (picked.length >= 3) break; add(r, TYPE_LABEL[r.type]); }
  return picked;
}

const LABELS = { water: 'water fit', erosion: 'erosion protection', income: 'income', soil: 'soil health', risk: 'harvest reliability' };

export function explainStrategy(s, current, ctx) {
  const { crops, cy, field, soil, terrain, sum, weights } = ctx;
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  const isCurrent = s.rotation === current.rotation;
  const okCount = c => cy.rows.filter(r => r.crop === c && r.ok).length;

  // why: strongest points on the farmer's top priorities
  const topPriorities = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  const diffs = Object.keys(LABELS).map(k => [k, s[k] - current[k]]).sort((a, b) => b[1] - a[1]);
  const [strongK, strongD] = diffs[0];
  const why = isCurrent
    ? 'This is what you grow now, shown as the baseline for comparison.'
    : `Matches your priorities with a score of ${r0(s.score)} (your current rotation: ${r0(current.score)}). ` +
      (strongD >= 5 ? `Biggest gain: ${LABELS[strongK]} (${r0(s[strongK])} vs ${r0(current[strongK])}).` : 'Similar to your current rotation on most points.');

  const evidence = [];
  for (const c of s.unique) evidence.push(`${c} had enough water and no heat stress in ${okCount(c)} of ${cy.years.length} past seasons (NASA POWER).`);
  if (field?.bareDays != null && (isCurrent || s.bare < current.bare)) evidence.push(`Your field was bare ~${field.bareDays} days in the last year (Sentinel-2).`);
  if (soil && !soil.isDefault && (isCurrent || s.legumes.length || s.covers)) evidence.push(`Soil organic carbon ${soil.socGKg.toFixed(1)} g/kg${soil.socGKg < 10 ? ' (low)' : ''}, ${soil.texture.toLowerCase()} texture (SoilGrids).`);
  if (sum.droughtYearsRecent >= 2) evidence.push(`${sum.droughtYearsRecent} of the last 10 summers were dry (NASA POWER).`);

  const benefits = [];
  if (!isCurrent) {
    const dW = current.waterDemand - s.waterDemand;
    if (Math.abs(dW) >= 20) benefits.push(`${dW > 0 ? 'Uses' : 'Needs'} ~${Math.abs(r0(dW))} mm ${dW > 0 ? 'less' : 'more'} water per year than your current rotation.`);
    const dB = current.bare - s.bare;
    if (dB >= 0.5) {
      const pct = current.bare > 0 ? r0(dB / current.bare * 100) : 0;
      benefits.push(`Bare soil drops from ~${current.bare.toFixed(1)} to ~${s.bare.toFixed(1)} months per year (about ${pct}% less exposure to erosion${terrain?.slopePct > 3 ? ', important on your slope' : ''}).`);
    }
    if (s.nSavedEur >= 5) benefits.push(`${s.covers ? 'Cover crops' : 'Legumes'} save roughly ${eur(s.nSavedEur)}/ha per year in nitrogen fertilizer.`);
    const dR = s.risk - current.risk;
    if (Math.abs(dR) >= 3) benefits.push(`Harvest success ${r0(s.risk)}% vs ${r0(current.risk)}% now${dR < 0 ? ' (lower, see risks)' : ''}.`);
    const dP = s.profitNormal - current.profitNormal;
    benefits.push(`Typical profit ${eur(s.profitNormal)}/ha/yr vs ${eur(current.profitNormal)} now (${dP >= 0 ? '+' : ''}${eur(dP)}); in a bad year ${eur(s.profitBad)} vs ${eur(current.profitBad)}.`);
    if (s.soil - current.soil >= 10) benefits.push(`Builds soil health: score ${r0(s.soil)} vs ${r0(current.soil)}.`);
  } else {
    benefits.push(`Bare soil ~${s.bare.toFixed(1)} months/yr, harvest success ${r0(s.risk)}%, typical profit ${eur(s.profitNormal)}/ha/yr.`);
  }

  const risks = [];
  const newCrops = [...s.unique, ...s.plan.filter(i => i.includes('+')).map(i => i.split('+')[0])]
    .filter((c, i, a) => a.indexOf(c) === i && !current.plan.join('+').includes(c));
  for (const c of newCrops) risks.push(`${c}: ${crop[c].notes}`);
  const weak = s.unique.filter(c => okCount(c) < cy.years.length * 0.7);
  for (const c of weak) {
    const rows = cy.rows.filter(r => r.crop === c && !r.ok);
    const dry = rows.filter(r => !r.waterOk).length, hot = rows.filter(r => !r.heatOk).length;
    risks.push(`${c} failed the stress test in ${rows.length} of ${cy.years.length} seasons, mostly from ${dry >= hot ? 'too little rain' : 'heat'} in ${crop[c].criticalMonths.map(m => MONTHS[m - 1]).join('–')}.`);
  }
  if (s.riskFuture < s.risk - 5) risks.push(`If warming continues, harvest success may fall to ~${r0(s.riskFuture)}% by 2035.`);
  if (soil.ph < 6 && s.unique.some(c => c === 'Peas' || c === 'Alfalfa')) risks.push(`Your soil is acidic (pH ${soil.ph.toFixed(1)}); peas and alfalfa may need liming.`);
  if (!risks.length) risks.push('No major risks found in the data. Still check with a local agronomist.');

  const gaps = ['Crop water needs, yields and prices are regional estimates, not your farm records.',
    'Assumes rain-fed farming; irrigation would change the water results.'];
  if (!field) gaps.push('No satellite history of the field was available, so bare-soil and moisture checks are missing.');
  if (soil.isDefault) gaps.push('Soil data was unavailable; typical loam values were used.');
  if (newCrops.length) gaps.push(`Local market and equipment for ${newCrops.join(', ')} are not checked by the tool.`);

  return { why, evidence, benefits, risks, gaps };
}

// "Can I grow X here?"
export function cropVerdict(cropName, cy, cyFuture, crops) {
  const c = crops.find(x => x.crop === cropName);
  const rows = cy.rows.filter(r => r.crop === cropName);
  const ok = rows.filter(r => r.ok).length, n = rows.length;
  const fut = cyFuture.rows.filter(r => r.crop === cropName && r.ok).length;
  const dry = rows.filter(r => !r.waterOk).length, hot = rows.filter(r => !r.heatOk).length;
  const pct = ok / n * 100, pctF = fut / n * 100;
  const level = pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad';
  const verdict = level === 'good' ? `Yes, ${cropName} suits this field.` : level === 'warn' ? `${cropName} is possible, but risky in dry or hot years.` : `${cropName} is a high-risk choice here.`;

  const isWinter = x => x.seasonStart > x.seasonEnd; // autumn-sown vs spring-sown
  const alternatives = crops.filter(x => x.crop !== cropName && x.crop !== 'Cover crop' && isWinter(x) === isWinter(c))
    .map(x => ({ crop: x.crop, pct: cy.rows.filter(r => r.crop === x.crop && r.ok).length / n * 100 }))
    .filter(x => x.pct > pct + 10).sort((a, b) => b.pct - a.pct).slice(0, 2);

  return {
    level, verdict, pct, pctF,
    detail: `In the last ${n} seasons, ${cropName} had enough water and no heat stress in ${ok}. ` +
      (n - ok ? `Problems: ${dry} dry seasons, ${hot} with heat stress in ${c.criticalMonths.map(m => MONTHS[m - 1]).join('–')}. ` : '') +
      `By 2035, if trends continue: about ${Math.round(pctF)}% of seasons OK.`,
    alternatives,
    note: c.notes,
  };
}

// Best main crops for this field (recommendation mode)
export function rankCrops(cy, crops) {
  const n = cy.years.length;
  return crops.filter(c => c.crop !== 'Cover crop').map(c => {
    const ok = cy.rows.filter(r => r.crop === c.crop && r.ok).length;
    const pct = ok / n * 100;
    const profit = c.yieldTHa * c.priceEurT * (pct / 100 + (1 - pct / 100) * FAIL_YIELD_SHARE) - c.costEurHa;
    return { crop: c.crop, pct, profit, legume: c.legume };
  }).sort((a, b) => b.pct * 2 + b.profit / 10 - (a.pct * 2 + a.profit / 10));
}
