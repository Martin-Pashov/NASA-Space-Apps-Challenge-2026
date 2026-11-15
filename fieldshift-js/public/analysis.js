// FieldShift analysis engine. Turns raw satellite and climate data into:
//  1. hidden insights about the field (things a farmer can't see with the naked eye)
//  2. a 20-year stress test of every crop
//  3. scored rotation strategies with why / evidence / benefits / risks / gaps
// Runs in the browser, so changing priorities updates the results instantly.

const N_PRICE_EUR_KG = 1.0;      // rough nitrogen fertilizer price
const FAIL_YIELD_SHARE = 0.5;    // failed season = half the normal yield
const ENOUGH_WATER_SHARE = 0.75; // rain + soil water must cover 75% of crop need
const KEY_WATER_SHARE = 0.8;     // winter + spring rain below 80% of this field's normal = drought year
const COVER_WATER_USE_MM = 30;   // spring moisture a cover crop takes from the next crop
const SAME_CROP_PENALTY = 0.15;
// a crop after itself yields ~15% less and fails more often (diseases, pests)
const SWITCH_FACTOR = { easy: 1, medium: 0.95, hard: 0.82 }; // hard-to-adopt crops count less unless already grown
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Aug–Oct 2026", or "Dec 2025–Feb 2026" across a new year
const periodLabel = (a, b) => {
  if (!a || !b) return '';
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
  return ya === yb ? `${MONTHS[ma - 1]}–${MONTHS[mb - 1]} ${yb}` : `${MONTHS[ma - 1]} ${ya}–${MONTHS[mb - 1]} ${yb}`;
};

// [8,9,10,11,0,1] -> "Sep–Feb"; month indexes 0..11, wraps over the new year
function monthRanges(ms) {
  const set = new Set(ms);
  if (set.size === 12) return 'all year';
  const start = [...set].filter(m => !set.has((m + 11) % 12));
  return 'in ' + start.map(a => { let b = a; while (set.has((b + 1) % 12)) b = (b + 1) % 12; return a === b ? MONTHS[a] : `${MONTHS[a]}–${MONTHS[b]}`; }).join(' and ');
}

const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r0 = x => Math.round(x);
export const eur = x => (Math.round(x) < 0 ? '-€' : '€') + Math.abs(Math.round(x));
export const isAutumnSown = c => c.seasonStart > c.seasonEnd; // sown in autumn, harvested next summer
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
    return { key: k, label: `${MONTHS[m]} '${k.slice(2, 4)}`, rain: byMonth[k].rain, normal: sum.rainNormal[m],
      temp: mean(byMonth[k].temps), tempNormal: sum.tempNormal[m] };
  });
  const last3 = months.slice(-3);
  const r3 = last3.reduce((s, x) => s + x.rain, 0), n3 = last3.reduce((s, x) => s + x.normal, 0);
  const r12 = months.reduce((s, x) => s + x.rain, 0), n12 = months.reduce((s, x) => s + x.normal, 0);
  return {
    months,
    last3Pct: n3 ? (r3 / n3 - 1) * 100 : 0, last3Rain: r3, last3Normal: n3, last3Label: periodLabel(last3[0]?.key, last3.at(-1)?.key),
    last12Pct: n12 ? (r12 / n12 - 1) * 100 : 0,
    tempAnomaly: mean(months.map(x => x.temp - x.tempNormal)),
  };
}

// =============== 2. FIELD (Sentinel-2) ===============

// A 10-day period counts as bare soil when the soil index is high and there's little green cover.
// Thresholds calibrated on real Sentinel-2 data from Dobrudzha fields.
const isBare = r => r.bsi > 0.05 && r.ndvi < 0.25;

export function fieldSummary(rows) {
  if (!rows?.length) return null;
  rows = rows.map(r => ({ ...r, bare: isBare(r) ? 1 : 0 }));
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

  // moisture in the last ~3 months vs the same months in earlier years (same period as the rain card)
  let moistureRecent = null;
  const threeMonths = rows.filter(r => new Date(r.date) >= now - 92 * 864e5 && typeof r.ndmi === 'number');
  if (threeMonths.length >= 2 && earlier.length >= 12) {
    const base = m => mean(earlier.filter(r => month(r) === m && typeof r.ndmi === 'number').map(r => r.ndmi));
    moistureRecent = mean(threeMonths.map(r => r.ndmi - base(month(r))));
  }

  // what grew each year: autumn-sown crops are already green in March–April, spring crops are still bare
  const seasons = [];
  for (const y of [...new Set(rows.map(r => +r.date.slice(0, 4)))].sort()) {
    const inYear = rows.filter(r => +r.date.slice(0, 4) === y);
    const spring = inYear.filter(r => [3, 4].includes(month(r))).map(r => r.ndvi);
    const later = inYear.filter(r => month(r) >= 5 && month(r) <= 8).map(r => r.ndvi);
    if (!spring.length || !later.length) continue;
    const springGreen = Math.max(...spring), peak = Math.max(...later);
    let type = 'unclear';
    if (springGreen >= 0.45) type = 'autumn';
    else if (springGreen < 0.38 && peak >= 0.5) type = 'spring';
    else if (Math.max(springGreen, peak) < 0.35) type = 'bare';
    seasons.push({ year: y, type, springGreen, peak });
  }

  // peak greenness per year
  const peaks = {};
  for (const r of rows) { const y = r.date.slice(0, 4); peaks[y] = Math.max(peaks[y] ?? -1, r.ndvi); }
  const years = Object.keys(peaks).sort();
  const peakVals = years.map(y => peaks[y]);
  const thisPeak = peakVals.at(-1), prevPeak = mean(peakVals.slice(0, -1));

  return {
    bareDays, bareMonths, typicalBare, moistureChange, moistureRecent, seasons, years, peakVals,
    peakNdvi: mean(peakVals), peakChange: peakVals.length > 1 ? thisPeak - prevPeak : 0,
    ndviTrend: peakVals.length > 1 ? slope(years.map(Number), peakVals) * years.length : 0,
    observations: rows.length,
  };
}

// =============== 3. INSIGHTS (what the farmer can't see) ===============

// This year's autumn: did autumn-sown crops get enough rain at sowing time?
export function autumnCheck(recent, crops) {
  if (!recent) return [];
  const byKey = Object.fromEntries(recent.months.map(m => [m.key, m]));
  const out = [];
  for (const c of crops.filter(c => c.sowRainMm && c.sowRainMonths)) {
    // only this autumn: the latest year in the data, and only if all sowing months are complete
    const y = Math.max(...recent.months.map(m => +m.key.slice(0, 4)));
    if (!c.sowRainMonths.every(m => byKey[`${y}-${String(m).padStart(2, '0')}`])) continue;
    const ms = c.sowRainMonths.map(m => byKey[`${y}-${String(m).padStart(2, '0')}`]);
    const rain = ms.reduce((a, m) => a + m.rain, 0), normal = ms.reduce((a, m) => a + m.normal, 0);
    out.push({ crop: c.crop, year: y, months: c.sowRainMonths.map(m => MONTHS[m - 1]).join('–'), rain, normal,
      pct: normal ? (rain / normal - 1) * 100 : 0, dry: rain < c.sowRainMm || rain < 0.7 * normal });
  }
  return out;
}

export function buildInsights({ sum, recent, field, soil, terrain, cyNow, cyFuture, crops, currentPlan }) {
  const out = [];
  const add = (level, title, text, source) => out.push({ level, title, text, source });

  // water: rain and satellite moisture for the same period, in one card
  if (recent) {
    const p = recent.last3Pct, m = field?.moistureRecent;
    let sat = '';
    if (m != null) sat = m < -0.03 ? ' Satellites confirm it: your field is drier than usual for this time of year.'
      : m > 0.03 ? ' Satellites still see a bit more moisture in your field than usual, so earlier rain is still helping.'
      : ' Satellites see about normal moisture in your field for this time of year.';
    add(p < -25 ? 'bad' : p < -10 ? 'warn' : 'good', 'Water in the last 3 months',
      `${recent.last3Label}: ${r0(recent.last3Rain)} mm of rain, ${Math.abs(r0(p))}% ${p < 0 ? 'less' : 'more'} than normal (${r0(recent.last3Normal)} mm).` + sat,
      m != null ? 'NASA POWER rain + ESA Sentinel-2 moisture' : 'NASA POWER');
  }
  const dryAutumn = autumnCheck(recent, crops).filter(a => a.dry);
  if (dryAutumn.length) {
    const worst = dryAutumn.sort((a, b) => a.pct - b.pct)[0];
    add('warn', 'Dry sowing time this autumn',
      `${worst.months} ${worst.year} brought only ${r0(worst.rain)} mm of rain (${Math.abs(r0(worst.pct))}% below normal). ` +
      `Too dry at sowing time this autumn for: ${dryAutumn.map(a => `${a.crop} (${a.months})`).join(', ')}. These may come up unevenly. Check how they emerged.`, 'NASA POWER');
  }
  if (field?.bareDays != null) {
    add(field.bareDays > 150 ? 'bad' : field.bareDays > 90 ? 'warn' : 'good', 'Bare soil',
      `Your field had no plant cover for about ${field.bareDays} days in the last 12 months` +
      (field.bareMonths.length ? `, usually ${monthRanges(field.bareMonths)}.` : '.') +
      ' Bare soil loses water and topsoil to sun, wind and rain.', 'ESA Sentinel-2 (bare soil index + greenness)');
  }
  if (field && field.peakVals.length > 1) {
    const c = field.peakChange;
    add(c < -0.05 ? 'warn' : 'good', 'Crop growth this year',
      `Your crop's peak greenness this year was ${c < -0.05 ? 'lower' : c > 0.05 ? 'higher' : 'about the same'} compared with earlier years` +
      ` (${field.peakVals.at(-1).toFixed(2)} vs ${(field.peakVals.at(-1) - c).toFixed(2)} on a 0–1 scale).` +
      (c < -0.05 ? ' The crop was under more stress than usual.' : ''), 'ESA Sentinel-2 (greenness, NDVI)');
  }
  add(sum.droughtYearsRecent >= 3 ? 'bad' : sum.droughtYearsRecent >= 2 ? 'warn' : 'good', 'Dry summers',
    `${sum.droughtYearsRecent} of the last 10 summers had less than three quarters of the normal summer rain. Driest month on average: ${MONTHS[sum.driestMonth - 1]}.`,
    'NASA POWER, 25 years');
  add(sum.tempTrendDecade > 0.3 ? 'warn' : 'good', 'Getting warmer',
    `Here it is getting ${sum.tempTrendDecade >= 0 ? 'warmer' : 'cooler'} by about ${Math.abs(sum.tempTrendDecade).toFixed(1)} °C every 10 years` +
    `, and yearly rain is ${sum.rainTrendDecade >= 0 ? 'up' : 'down'} by about ${Math.abs(r0(sum.rainTrendDecade))} mm every 10 years.`, 'NASA POWER, 25 years');

  // how the current crops hold up now vs 2035
  const main = [...new Set(currentPlan.map(i => i.split('+').at(-1)))];
  const okCount = (cy, c) => cy.rows.filter(r => r.crop === c && r.ok).length, n = cyNow.years.length;
  for (const c of main) {
    const now = okCount(cyNow, c), fut = okCount(cyFuture, c);
    if (now < n * 0.75 || fut < now - 1) {
      add(fut < n * 0.6 ? 'bad' : 'warn', `${c}: looking ahead`,
        `${c} had a good season (enough water, no heat stress) in ${now} of the last ${n} years. If the warming trend continues, that would be about ${fut} of ${n} by 2035.`,
        'NASA POWER trend projection');
    }
  }
  if (terrain) {
    const s = terrain.slopePct;
    add(s > 6 ? 'bad' : s > 3 ? 'warn' : 'good', 'Slope and erosion',
      `Your field sits at ${r0(terrain.elevationM)} m with a slope of about ${s.toFixed(1)}%. ` +
      (s > 3 ? 'Heavy rain can wash away bare soil here, so keeping the ground covered matters.' : 'Mostly flat, so water erosion risk is low; wind can still blow away bare soil.'),
      'NASA SRTM elevation');
  }
  if (soil && !soil.isDefault) {
    add(soil.socGKg < 10 ? 'warn' : 'good', 'Soil',
      `${soil.texture} soil, organic carbon ${soil.socGKg.toFixed(1)} g/kg${soil.socGKg < 10 ? ' (low)' : ''}, pH ${soil.ph.toFixed(1)}. ` +
      `It can hold roughly ${soil.awcMm} mm of water for the crops' roots.`, 'ISRIC SoilGrids');
  }
  return out;
}

// Compare what the farmer entered with what the satellites saw each year
export function satelliteHistory(field, history, crops) {
  if (!field?.seasons?.length) return [];
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  return field.seasons.filter(s => s.type !== 'unclear').map(s => {
    const h = history?.find(x => x.year === s.year);
    const expected = h ? (isAutumnSown(crop[h.crop]) ? 'autumn' : 'spring') : null;
    return { year: s.year, saw: s.type, entered: h?.label ?? null, match: h ? expected === s.type : null };
  });
}

// =============== 4. STRESS TEST ===============

// baseClimate: what counts as a 'normal' year (today's climate, also for the 2035 outlook)
export function cropYears(climate, crops, awcMm, baseClimate = climate) {
  const rain = {}, temp = {};
  for (const r of climate) { (rain[r.year] ??= {})[r.month] = r.rainMm; (temp[r.year] ??= {})[r.month] = r.temp; }
  const complete = Object.keys(rain).map(Number).filter(y => Object.keys(rain[y]).length === 12);
  const years = complete.filter(y => complete.includes(y - 1)).sort((a, b) => a - b);

  // Water that actually reaches the crop when it matters: winter rain (Oct–Mar, refills the soil)
  // plus rain from April until the end of the crop's sensitive months. Rain after that (e.g. June
  // storms at wheat harvest) doesn't help. Checked against 2020 in Dobrudzha (wheat -68%, MZH report).
  const baseRain = {};
  for (const r of baseClimate) (baseRain[r.year] ??= {})[r.month] = r.rainMm;
  const keyWater = (c, y, src = rain) => {
    let w = 0;
    for (const m of [10, 11, 12]) w += src[y - 1][m];
    for (let m = 1; m <= Math.max(3, ...c.criticalMonths); m++) w += src[y][m];
    return w;
  };
  const median = a => { const s = [...a].sort((p, q) => p - q); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };

  const rows = [];
  for (const c of crops) {
    const normalKey = median(years.map(y => keyWater(c, y, baseRain)));
    for (const y of years) {
      let seasonRain = 0;
      for (const m of seasonMonths(c.seasonStart, c.seasonEnd)) {
        const yr = c.seasonStart > c.seasonEnd && m >= c.seasonStart ? y - 1 : y; // autumn-sown crops
        seasonRain += rain[yr][m];
      }
      const peakTemp = Math.max(...c.criticalMonths.map(m => temp[y][m]));
      // autumn-sown crops also need some rain at sowing to establish (e.g. rapeseed in Aug–Sep)
      const sowYear = isAutumnSown(c) ? y - 1 : y;
      const sowRain = c.sowRainMonths ? c.sowRainMonths.reduce((a, m) => a + rain[sowYear][m], 0) : null;
      const key = keyWater(c, y);
      const enoughTotal = seasonRain + awcMm >= ENOUGH_WATER_SHARE * c.waterNeedMm;
      const enoughKey = key >= KEY_WATER_SHARE * normalKey; // a drought year for THIS field
      rows.push({ crop: c.crop, year: y, seasonRain, peakTemp, sowRain, need: c.waterNeedMm, heatLimit: c.heatLimitC,
        keyWater: key, keyNormal: normalKey, keyMonths: `Oct–${MONTHS[Math.max(3, ...c.criticalMonths) - 1]}`,
        keyOk: enoughKey, waterOk: enoughTotal && enoughKey, heatOk: peakTemp <= c.heatLimitC,
        sowOk: !c.sowRainMm || sowRain >= c.sowRainMm, awcMm });
    }
  }
  rows.forEach(r => { r.ok = r.waterOk && r.heatOk && r.sowOk; });
  return { rows, years };
}

// Plan items can be "Crop" or "Cover crop+Crop" (cover crop over winter, then the main crop).
const split = item => { const p = item.split('+'); return { cover: p.length > 1 ? p[0] : null, main: p.at(-1) }; };

function itemOk(cy, item, year) {
  const { cover, main } = split(item);
  const r = cy.rows.find(x => x.crop === main && x.year === year);
  if (!r) return false;
  if (!cover) return r.ok;
  const waterOk = r.seasonRain - COVER_WATER_USE_MM + r.awcMm >= ENOUGH_WATER_SHARE * r.need && r.keyOk;
  return waterOk && r.heatOk && r.sowOk;
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

// All priorities the farmer can pick. Keys match the score fields on each rotation.
export const PRIORITIES = {
  water: { label: 'water fit', chip: 'Save moisture', hint: 'Crops that get by on the rain your field actually gets' },
  erosion: { label: 'erosion protection', chip: 'Stop erosion', hint: 'Keep the soil covered so wind and rain don\'t carry it away' },
  income: { label: 'income', chip: 'More income', hint: 'Higher typical profit per hectare' },
  soil: { label: 'soil health', chip: 'Healthier soil', hint: 'Legumes, cover crops and variety build organic matter' },
  risk: { label: 'harvest reliability', chip: 'Fewer bad years', hint: 'Crops that survived most of the past 25 years of weather' },
  cost: { label: 'low costs', chip: 'Lower costs', hint: 'Less money on fertilizer, seed and fuel' },
  labor: { label: 'less work', chip: '⏱️ Less work', hint: 'Crops that need less time and labour' },
  machinery: { label: 'fits your machinery', chip: 'My machinery', hint: 'Use the equipment you already have' },
  market: { label: 'easy to sell', chip: 'Easy to sell', hint: 'Crops with buyers nearby and a steady market' },
  forage: { label: 'animal feed', chip: 'Animal feed', hint: 'Grow feed or hay for your animals' },
  pests: { label: 'breaks pest cycles', chip: 'Break pests & diseases', hint: 'Alternate crop families so pests and diseases can\'t build up' },
  subsidies: { label: 'EU eco-scheme fit', chip: '🇪🇺 EU subsidies', hint: 'Diversification, legumes and winter cover often qualify for eco-schemes' },
};
const LABELS = Object.fromEntries(Object.entries(PRIORITIES).map(([k, v]) => [k, v.label]));

export function scoreRotations({ rotations, crops, cy, cyFuture, soil, field, weights, known = [] }) {
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  const results = Object.entries(rotations).map(([name, { plan, type, recommend = true }]) => {
    const items = plan.map(split);
    const mains = items.map(i => i.main);
    const unique = [...new Set(mains)];
    const covers = items.filter(i => i.cover).length;
    const everything = [...mains, ...items.filter(i => i.cover).map(i => i.cover)];

    // rotation effect: same crop after itself (not perennials) loses yield and reliability
    const afterItself = idx => mains[idx] === items.at(idx - 1).main && !crop[mains[idx]].perennial;
    const okShare = (data, item, idx) => mean(data.years.map(y => (itemOk(data, item, y) ? 1 : 0))) * (afterItself(idx) ? 1 - SAME_CROP_PENALTY : 1);
    const risk = mean(plan.map((it, idx) => okShare(cy, it, idx))) * 100;
    const riskFuture = mean(plan.map((it, idx) => okShare(cyFuture, it, idx))) * 100;

    const avgRain = c => mean(cy.rows.filter(r => r.crop === c).map(r => r.seasonRain));
    const water = mean(mains.map(c => Math.min(1, (avgRain(c) + soil.awcMm) / crop[c].waterNeedMm))) * 100;
    const waterDemand = mean(items.map(i => crop[i.main].waterNeedMm + (i.cover ? COVER_WATER_USE_MM : 0)));

    const bare = bareMonthsPerYear(plan, crop);
    const erosion = clamp(100 - bare / 6 * 100, 0, 100);

    const legumes = unique.filter(c => crop[c].legume);
    const repeats = mains.filter((c, i) => c === mains[(i + 1) % mains.length] && !crop[c].perennial).length;
    let soilScore = 40 + legumes.length * (soil.socGKg < 10 ? 18 : 12) + covers * 15 - repeats * 15
      + (unique.length >= 3 ? 10 : 0) + (mains.some(c => crop[c].perennial) ? 10 : 0);
    if (soil.ph < 6 && mains.some(c => c === 'Peas' || c === 'Alfalfa' || c === 'Lentil' || c === 'Chickpea')) soilScore -= 15;
    soilScore = clamp(soilScore, 0, 100);

    // profit per past year with that year's real weather; legumes and cover crops feed the next crop
    const nKg = items.reduce((s, i) => s + (crop[i.main].legume ? crop[i.main].nFixedKgHa : 0) + (i.cover ? crop[i.cover].nFixedKgHa : 0), 0);
    const yearly = cy.years.map(y => mean(plan.map((it, idx) => {
      const { cover, main } = items[idx], k = crop[main], prev = crop[items.at(idx - 1).main];
      const firstYear = k.perennial && idx === 0; // perennials: establishment year with little or no harvest
      const share = (itemOk(cy, it, y) ? 1 : FAIL_YIELD_SHARE) * (afterItself(idx) ? 1 - SAME_CROP_PENALTY : 1)
        * (firstYear ? (k.establishShare ?? 1) : 1);
      return k.yieldTHa * k.priceEurT * share - k.costEurHa
        - (cover ? crop[cover].costEurHa - crop[cover].nFixedKgHa * N_PRICE_EUR_KG : 0)
        + (prev.legume ? prev.nFixedKgHa * N_PRICE_EUR_KG : 0);
    })));
    const nSavedEur = nKg * N_PRICE_EUR_KG / plan.length;
    const spend = mean(items.map(i => crop[i.main].costEurHa + (i.cover ? crop[i.cover].costEurHa : 0))) - nSavedEur;

    const levels = ['easy', 'medium', 'hard'];
    const difficulty = everything.map(c => crop[c].switchDifficulty).reduce((a, b) => (levels.indexOf(b) > levels.indexOf(a) ? b : a), 'easy');

    // new priorities
    const labor = clamp(100 - (mean(everything.map(c => crop[c].laborLevel)) - 1) * 50, 0, 100);
    const machinery = mean(everything.map(c => (known.includes(c) ? 100 : { easy: 80, medium: 45, hard: 10 }[crop[c].switchDifficulty])));
    const market = mean(mains.map(c => (crop[c].marketEase - 1) * 50));
    const forage = mean(everything.map(c => crop[c].forageValue / 3 * 100));
    const groups = mains.map(c => crop[c].group);
    const groupChanges = groups.filter((g, i) => g !== groups[(i + 1) % groups.length] || g === 'perennial').length / groups.length;
    const breakers = mains.filter(c => crop[c].pestBreak).length / mains.length;
    const pests = clamp(10 + 20 * (new Set(groups).size - 1) + 40 * groupChanges + 20 * breakers, 0, 100);
    const subsidies = clamp((unique.length >= 3 ? 40 : unique.length === 2 ? 20 : 0) + (legumes.length ? 30 : 0) + (bare <= 2 ? 30 : bare <= 3.5 ? 15 : 0), 0, 100);

    return {
      rotation: name, plan, type, recommend, mains, unique, covers, legumes, groups,
      risk, riskFuture, water, waterDemand, bare, erosion, soil: soilScore, difficulty,
      labor, machinery, market, forage, pests, subsidies, spend, nSavedEur,
      profitBad: percentile(yearly, 10), profitNormal: percentile(yearly, 50), profitGood: percentile(yearly, 90),
    };
  });

  // income and cost are relative: best rotation = 100, worst = 0
  const norm = (vals, invert) => { const lo = Math.min(...vals), hi = Math.max(...vals); return v => (hi === lo ? 100 : ((invert ? hi - v : v - lo) / (hi - lo)) * 100); };
  const incomeOf = norm(results.map(r => r.profitNormal)), costOf = norm(results.map(r => r.spend), true);
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  for (const r of results) {
    r.income = incomeOf(r.profitNormal);
    r.cost = costOf(r.spend);
    const hardest = Math.min(...[...new Set(r.plan.flatMap(i => i.split('+')))].filter(c => !known.includes(c)).map(c => SWITCH_FACTOR[crop[c].switchDifficulty]), 1);
    r.score = Object.entries(weights).reduce((s, [k, w]) => s + (r[k] ?? 0) * w, 0) / wSum * hardest;
  }
  return results.sort((a, b) => b.score - a.score);
}

// =============== 5. STRATEGIES ===============

const TYPE_LABEL = {
  current: 'Your current rotation', reference: 'Typical rotation (reference)', moisture: 'Moisture-saving (cover crops)',
  drought: 'Drought-tolerant', nitrogen: 'Nitrogen-fixing (legumes)', diversified: 'Diversified', traditional: 'Traditional',
  forage: 'Forage and feed', income: 'High-value crops', perennial: 'Perennial crop', best: 'Best match for your priorities',
};

// Pick at least 3 strategies: current + moisture-saving + nitrogen-fixing + best overall.
export function pickStrategies(ranked, currentName, focusCrop, currentLabel = TYPE_LABEL.current) {
  // monocultures are only ever shown as a baseline, never recommended
  const pool = (focusCrop ? ranked.filter(r => r.mains.includes(focusCrop)) : ranked).filter(r => r.rotation !== currentName && r.recommend);
  const picked = [];
  const add = (r, label) => {
    if (!r || picked.some(p => p.rotation === r.rotation)) return;
    picked.push({ ...r, label: picked.some(p => p.label === label) ? 'Another option' : label });
  };
  add(ranked.find(r => r.rotation === currentName), currentLabel);
  const cur0 = ranked.find(r => r.rotation === currentName);
  const better = cur0 ? pool.filter(r => verdict(r, cur0).key === 'better') : [];
  add(better[0], TYPE_LABEL.best);
  add(better[1], TYPE_LABEL[better[1]?.type]);
  const saver = pool.find(r => r.type === 'moisture' || r.type === 'drought');
  add(saver, TYPE_LABEL[saver?.type]);
  add(pool.find(r => r.type === 'nitrogen'), TYPE_LABEL.nitrogen);
  const cur = ranked.find(r => r.rotation === currentName);
  add(pool[0], pool[0] && (!cur || verdict(pool[0], cur).key === 'better') ? TYPE_LABEL.best : TYPE_LABEL[pool[0]?.type]);
  // drop options we'd call worse: don't suggest something we advise against
  if (cur0) for (let i = picked.length - 1; i > 0; i--) if (verdict(picked[i], cur0).key === 'worse') picked.splice(i, 1);
  for (const r of pool) { if (picked.length >= 4) break; if (!cur0 || verdict(r, cur0).key !== 'worse') add(r, TYPE_LABEL[r.type]); }
  for (const r of ranked.filter(x => x.recommend)) { if (picked.length >= 3) break; add(r, TYPE_LABEL[r.type]); }
  return picked;
}

// Plain-language comparison with what the farmer does now
// Better = clearly better on what matters to the farmer, or more money AND more reliable at the same time.
export function verdict(s, current) {
  if (s.rotation === current.rotation) return { key: 'now', text: 'What you do now' };
  const d = s.score - current.score;
  const dNormal = s.profitNormal - current.profitNormal, dBad = s.profitBad - current.profitBad, dRisk = s.risk - current.risk;
  const dominates = dBad >= 50 && dNormal >= 0 && dRisk >= 0;   // €5/dka more in bad years, not worse otherwise
  const dominated = dNormal <= -50 && dBad <= 0 && dRisk <= 0;
  const tradeOff = dNormal <= -30 && dRisk < 0; // earns less AND fails more often: never call that better
  if ((d >= 3 && !tradeOff) || (dominates && d > -3)) return { key: 'better', text: 'Better for you' };
  if ((d <= -3 && !dominates) || dominated) return { key: 'worse', text: 'Worse for you' };
  if (dNormal <= -100 && dRisk > 0) return { key: 'similar', text: 'Safer, earns less' };
  if (dNormal >= 100 && dRisk < 0) return { key: 'similar', text: 'Earns more, riskier' };
  return { key: 'similar', text: 'About the same' };
}

// Why a crop failed the stress test, in words
function failCause(rows) {
  const dry = rows.filter(r => !r.waterOk).length, hot = rows.filter(r => !r.heatOk).length, sow = rows.filter(r => !r.sowOk).length;
  const top = Math.max(dry, hot, sow);
  return top === sow ? 'too little rain at sowing time' : top === dry ? 'too little rain while growing' : 'heat';
}

export function explainStrategy(s, current, ctx) {
  const { crops, cy, field, soil, terrain, sum, weights, known = [], beginner, money = x => `${eur(x)}/ha` } = ctx;
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  const isCurrent = s.rotation === current.rotation;
  const n = cy.years.length;
  const okCount = c => cy.rows.filter(r => r.crop === c && r.ok).length;
  const chosen = Object.entries(weights).filter(([, w]) => w >= 5).map(([k]) => k);
  const now = beginner ? 'the typical rotation' : 'what you do now';

  const keys = chosen.length ? chosen : Object.keys(LABELS);
  const gains = keys.map(k => [k, s[k] - current[k]]).filter(([, d]) => d >= 5).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const losses = keys.map(k => [k, current[k] - s[k]]).filter(([, d]) => d >= 5).sort((a, b) => b[1] - a[1]).slice(0, 1);
  const why = isCurrent
    ? (beginner ? 'The most common rotation in Bulgaria, shown for comparison.' : 'What you grow now, shown for comparison.')
    : (gains.length ? `Better than ${now} on ${gains.map(([k]) => LABELS[k]).join(' and ')}.` : `Close to ${now} on the things you care about.`) +
      (losses.length ? ` Weaker on ${LABELS[losses[0][0]]}.` : '');

  // one short evidence line instead of many
  const evidence = [`Good seasons in the last ${n} years: ${s.unique.map(c => `${c} ${okCount(c)}/${n}`).join(' · ')} (NASA POWER).`];
  if (field?.bareDays > 0 && !isCurrent && s.bare < current.bare) evidence.push(`Your field was bare ~${field.bareDays} days last year (Sentinel-2).`);
  if (soil && !soil.isDefault && !isCurrent && (s.legumes.length || s.covers) && soil.socGKg < 15) evidence.push(`Soil organic carbon is ${soil.socGKg.toFixed(1)} g/kg (SoilGrids).`);

  const benefits = [];
  if (!isCurrent) {
    const dP = s.profitNormal - current.profitNormal, dB = s.profitBad - current.profitBad;
    benefits.push(`Profit in a normal year: ${money(s.profitNormal)} (${dP >= 0 ? '+' : ''}${money(dP)} vs now). In a bad year: ${money(s.profitBad)} (${dB >= 0 ? '+' : ''}${money(dB)}).`);
    const dR = s.risk - current.risk;
    if (Math.abs(dR) >= 3) benefits.push(`Good seasons: ${r0(s.risk)}% vs ${r0(current.risk)}% now.`);
    const dBare = current.bare - s.bare;
    if (dBare >= 0.5) benefits.push(`Bare soil: ~${s.bare.toFixed(1)} instead of ~${current.bare.toFixed(1)} months a year${terrain?.slopePct > 3 ? ' (important on your slope)' : ''}.`);
    const dW = current.waterDemand - s.waterDemand;
    if (dW >= 20) benefits.push(`Needs ~${r0(dW)} mm less water per year.`);
    if (s.nSavedEur >= 5) benefits.push(`${s.covers ? 'Cover crops and legumes' : 'Legumes'} leave nitrogen in the soil: ~${money(s.nSavedEur)} less fertilizer per year.`);
    const on = k => chosen.includes(k);
    if (on('cost') && current.spend - s.spend >= 30) benefits.push(`Lower costs: about ${money(current.spend - s.spend)} less spent per year.`);
    if (on('labor') && s.labor - current.labor >= 10) benefits.push('Less work: these crops need less time and labour.');
    if (on('machinery')) {
      const needNew = s.unique.filter(c => !known.includes(c) && crop[c].switchDifficulty !== 'easy');
      benefits.push(needNew.length ? `Machinery: ${needNew.join(', ')} may need equipment you don't have yet.` : 'Machinery: works with standard grain equipment.');
    }
    if (on('market') && s.market - current.market >= 10) benefits.push('Easier to sell: crops with established buyers.');
    if (on('forage') && s.forage - current.forage >= 10) benefits.push(`Animal feed: ${s.unique.filter(c => crop[c].forageValue >= 2).join(', ') || 'some crops'} can be fed or sold as hay.`);
    if (on('pests') && s.pests - current.pests >= 10) benefits.push(`Breaks pest and disease cycles: ${new Set(s.groups).size} crop families, changing every season.`);
    if (on('subsidies') && s.subsidies - current.subsidies >= 10) benefits.push(`EU eco-schemes: ${[s.unique.length >= 3 && '3+ crops', s.legumes.length && 'nitrogen-fixing crops', s.bare <= 2 && 'soil covered most of the year'].filter(Boolean).join(', ')} often qualify for support.`);
  }

  const risks = [];
  const newCrops = [...s.unique, ...s.plan.filter(i => i.includes('+')).map(i => i.split('+')[0])]
    .filter((c, i, a) => a.indexOf(c) === i && !current.plan.join('+').includes(c) && !known.includes(c));
  for (const c of newCrops) risks.push(`${c}: ${crop[c].notes.replace(' (Estimated regional values.)', '')}`);
  for (const c of s.unique.filter(c => okCount(c) < n * 0.75)) {
    const bad = cy.rows.filter(r => r.crop === c && !r.ok);
    risks.push(`${c} had a bad season in ${bad.length} of ${n} years, mostly from ${failCause(bad)}.`);
  }
  const repeated = [...new Set(s.mains.filter((m, i) => m === s.mains[(i + 1) % s.mains.length] && !crop[m].perennial))];
  for (const m of repeated) risks.push(`${m} after ${m}: yields usually drop 10–20% and pests and diseases build up (already counted in the numbers).`);
  if (s.riskFuture < s.risk - 5) risks.push(`If warming continues, good seasons may drop to ~${r0(s.riskFuture)}% by 2035.`);
  if (soil.ph < 6 && s.unique.some(c => ['Peas', 'Alfalfa', 'Lentil', 'Chickpea'].includes(c))) risks.push(`Your soil is acidic (pH ${soil.ph.toFixed(1)}); some legumes may need liming.`);

  return { why, evidence, benefits, risks, newCrops };
}

// Everything the tool can't know, shown once
export function infoGaps({ field, soil, weights, newCrops = [] }) {
  const gaps = ['Yields, prices and crop water needs are regional estimates. Enter your own yields and prices for better numbers.',
    'Profit does not include EU area payments (they are the same whatever you grow).',
    'Assumes no irrigation.',
    'Weather is regional (NASA POWER, ~50 km grid), not a station on your field.'];
  if (!field) gaps.push('No satellite history of this field was available, so bare soil and moisture checks are missing.');
  if (soil?.isDefault) gaps.push('Soil data was unavailable; typical loam values were used.');
  if (newCrops.length) gaps.push(`Local buyers and machinery for ${newCrops.join(', ')} are not checked.`);
  if (weights?.subsidies >= 5) gaps.push('Eco-scheme rules change; check current requirements with the State Fund Agriculture (ДФЗ).');
  return gaps;
}

// "What should I do?" in one card: what to sow next, when, why, and the main risk
export function buildAnswer({ best, current, lastCrop, crops, cy, autumn = [], money = x => `${eur(x)}/ha`, today = new Date(), beginner, keep }) {
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  const plan = keep ? current.plan : best.plan;
  const item = nextCrop(plan, lastCrop, crops);
  const { cover, main } = split(item);
  const sowCrop = crop[cover || main];
  // next time the sowing month comes around
  const m = sowCrop.sowMonth, nowM = today.getMonth() + 1, thisYear = today.getFullYear();
  const justPassed = nowM > m && nowM - m <= 3; // e.g. October window, now November
  const when = cover ? `right after your next harvest (summer ${nowM <= 8 ? thisYear : thisYear + 1})`
    : justPassed ? `${sowCrop.sowWindow}. This year's window has just passed: if it's already sown, you're on track.`
    : `${sowCrop.sowWindow} ${nowM <= m ? thisYear : thisYear + 1}`;
  const title = cover ? `Next: a cover crop after harvest, then ${main}` : `Next season: sow ${main}`;

  const reasons = [];
  const target = keep ? current : best, n = cy.years.length;
  const ok = c => cy.rows.filter(r => r.crop === c && r.ok).length;
  reasons.push(`${main} had a good season in ${ok(main)} of the last ${n} years on this field's weather.`);
  // the portfolio effect: do the rotation's crops have bad years at the same time?
  const mains = [...new Set(target.plan.map(i => split(i).main))];
  if (mains.length >= 2) {
    const together = cy.years.filter(y => mains.every(c => !cy.rows.find(r => r.crop === c && r.year === y)?.ok));
    const names = mains.length > 2 ? `${mains.slice(0, -1).join(', ')} and ${mains.at(-1)}` : mains.join(' and ');
    reasons.push(together.length === 0
      ? `${names} never had a bad year at the same time in the last ${n} years, so one protects the other.`
      : `${names} had a bad year at the same time only ${together.length === 1 ? `once (${together[0]})` : `${together.length} times`} in ${n} years, so one protects the other.`);
  }
  if (!keep) {
    const dB = target.profitBad - current.profitBad, dP = target.profitNormal - current.profitNormal;
    if (dB > 5) reasons.push(`Earns more in bad years: ${money(target.profitBad)} instead of ${money(current.profitBad)}.`);
    else if (dP > 5) reasons.push(`Higher typical profit: ${money(target.profitNormal)} instead of ${money(current.profitNormal)}.`);
    if (current.bare - target.bare >= 0.5) reasons.push(`Soil stays covered longer: ~${target.bare.toFixed(1)} bare months a year instead of ~${current.bare.toFixed(1)}.`);
    if (target.nSavedEur >= 5) reasons.push(`Saves ~${money(target.nSavedEur)} in nitrogen fertilizer per year.`);
  }
  const how = cover
    ? `After harvesting, sow a cover crop mix (for example vetch + oats) as soon as possible. Work it into the soil in March, 3–4 weeks before sowing ${main} (${crop[main].sowWindow}).`
    : null;

  let risk = null;
  const dry = autumn.find(a => a.crop === main && a.dry);
  if (dry) risk = `${dry.months} ${dry.year} was ${Math.abs(r0(dry.pct))}% drier than normal: ${main} needs moisture at sowing. If it is dry again, wait for rain or choose a less sensitive crop.`;
  else {
    const bad = cy.rows.filter(r => r.crop === main && !r.ok);
    if (bad.length) risk = `In ${bad.length} of ${n} years ${main} struggled, mostly from ${failCause(bad)}.`;
  }
  // be upfront about what the farmer gives up
  let tradeOff = null;
  if (!keep && target.profitNormal - current.profitNormal < -50) tradeOff = `Trade-off: in a normal year it earns less than ${beginner ? 'the typical rotation' : 'now'} (${money(target.profitNormal)} instead of ${money(current.profitNormal)}).`;
  return { title, when, reasons: reasons.slice(0, 3), how, risk, tradeOff, rotation: target.rotation, keep, beginner };
}

// Wheat > Sunflower and Sunflower > Wheat are the same rotation
export function sameRotation(a, b) {
  if (a.length !== b.length) return false;
  return a.some((_, k) => a.every((x, i) => x === b[(i + k) % b.length]));
}

// =============== 6. PLANTING HISTORY ===============

export const GROUPS = { cereal: 'Cereal / grain', oilseed: 'Oilseed', legume: 'Legume (peas, beans…)', rowcrop: 'Row crop (corn, beet)', forage: 'Forage / hay', vegetable: 'Vegetable', spice: 'Herb / spice', other: 'Other' };
const GROUP_STAND_IN = { cereal: 'Wheat', oilseed: 'Sunflower', legume: 'Peas', rowcrop: 'Corn', forage: 'Alfalfa', vegetable: 'Potatoes', spice: 'Coriander', other: 'Buckwheat', perennial: 'Lavender' };
const KEYWORDS = [
  [/wheat|пшениц|spelt|лимец|einkorn/, 'cereal'], [/barley|ечемик|oat|овес|rye|ръж|tritic|тритик|millet|прос|sorghum|сорго|rice|ориз|grain|зърн/, 'cereal'],
  [/sunflower|слънчог|rapeseed|рапиц|canola|flax|лен|camelina|рижей|mustard|синап|safflower|шафран|oil|масл/, 'oilseed'],
  [/pea|грах|bean|боб|фасул|бакла|soy|соя|lentil|леща|chickpea|нахут|vetch|фий|lupin|лупин|clover|детелин/, 'legume'],
  [/corn|maize|царевиц|beet|цвекл/, 'rowcrop'], [/alfalfa|люцерн|hay|сено|grass|трев|forage|фураж/, 'forage'],
  [/potato|картоф|tomato|домат|pepper|пипер|onion|лук|cabbage|зеле|melon|диня|пъпеш|pumpkin|тикв|cucumber|краставиц|vegetable|зеленчук/, 'vegetable'],
  [/coriander|кориандър|fennel|копър|anise|анасон|mint|мента|herb|билк|spice/, 'spice'],
];

// Turns whatever the farmer typed into a crop the model knows.
// Returns { crop, known, group } - unknown crops get a stand-in from their group.
export function resolveCrop(text, crops, groupOverride) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const hit = crops.find(c => c.crop.toLowerCase() === t || c.nameBg?.toLowerCase() === t);
  if (hit) return { crop: hit.crop, known: true, group: hit.group, label: text.trim() };
  const partial = crops.find(c => c.crop !== 'Cover crop' && (t.includes(c.crop.toLowerCase()) || (c.nameBg && t.includes(c.nameBg.toLowerCase().slice(0, 5)))));
  if (partial && !groupOverride) return { crop: partial.crop, known: true, group: partial.group, label: text.trim() };
  const group = groupOverride || KEYWORDS.find(([re]) => re.test(t))?.[1] || null;
  return { crop: group ? GROUP_STAND_IN[group] : null, known: false, group, label: text.trim() };
}

// Shortest repeating pattern: [W,S,W,S,W] -> [W,S]
export function compressHistory(plan) {
  for (let p = 1; p < plan.length; p++) {
    if (plan.every((c, i) => i < p || c === plan[i - p])) return plan.slice(0, p);
  }
  return plan;
}

// What to plant next season: the first crop of the plan that isn't the same crop or family as last season.
export function nextCrop(plan, lastCrop, crops) {
  const crop = Object.fromEntries(crops.map(c => [c.crop, c]));
  if (!lastCrop) return plan[0];
  const lastGroup = crop[lastCrop]?.group;
  const ok = item => { const m = split(item).main; return m !== lastCrop && (crop[m].group !== lastGroup || crop[m].perennial); };
  return plan.find(ok) ?? plan.find(i => split(i).main !== lastCrop) ?? plan[0];
}

// "Can I grow X here?"
export function cropVerdict(cropName, cy, cyFuture, crops) {
  const c = crops.find(x => x.crop === cropName);
  const rows = cy.rows.filter(r => r.crop === cropName);
  const ok = rows.filter(r => r.ok).length, n = rows.length;
  const fut = cyFuture.rows.filter(r => r.crop === cropName && r.ok).length;
  const dry = rows.filter(r => !r.waterOk).length, hot = rows.filter(r => !r.heatOk).length, sow = rows.filter(r => !r.sowOk).length;
  const pct = ok / n * 100, pctF = fut / n * 100;
  const level = pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad';
  const verdict = level === 'good' ? `Yes, ${cropName} suits this field.` : level === 'warn' ? `${cropName} is possible, but risky in dry or hot years.` : `${cropName} is a high-risk choice here.`;

  const isWinter = x => x.seasonStart > x.seasonEnd; // autumn-sown vs spring-sown
  const alternatives = crops.filter(x => x.crop !== cropName && x.crop !== 'Cover crop' && isWinter(x) === isWinter(c))
    .map(x => ({ crop: x.crop, pct: cy.rows.filter(r => r.crop === x.crop && r.ok).length / n * 100 }))
    .filter(x => x.pct > pct + 10).sort((a, b) => b.pct - a.pct).slice(0, 2);

  return {
    level, verdict, pct, pctF,
    detail: `${cropName} had a good season (enough water, no heat stress) in ${ok} of the last ${n} years on this field's weather. ` +
      (n - ok ? `Problems: ${[sow && `${sow}× too dry at sowing`, dry && `${dry}× too dry while growing`, hot && `${hot}× heat in ${c.criticalMonths.map(m => MONTHS[m - 1]).join('–')}`].filter(Boolean).join(', ')}. ` : '') +
      `If the warming trend continues: about ${fut} of ${n} by 2035. Sowing time: ${c.sowWindow}.`,
    alternatives,
    note: c.notes.replace(' (Estimated regional values.)', ''),
  };
}

// Best main crops for this field (recommendation mode)
export function rankCrops(cy, crops) {
  const n = cy.years.length;
  return crops.filter(c => c.crop !== 'Cover crop' && !c.perennial).map(c => {
    const ok = cy.rows.filter(r => r.crop === c.crop && r.ok).length;
    const pct = ok / n * 100;
    const profit = c.yieldTHa * c.priceEurT * (pct / 100 + (1 - pct / 100) * FAIL_YIELD_SHARE) - c.costEurHa;
    return { crop: c.crop, pct, profit, legume: c.legume };
  }).sort((a, b) => b.pct * 2 + b.profit / 10 - (a.pct * 2 + a.profit / 10));
}
