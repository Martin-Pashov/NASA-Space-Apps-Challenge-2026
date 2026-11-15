// FieldShift alert engine: weather hazards, crop stress seen from satellites, and pest risk.
// Pure ESM (no DOM, no Node APIs), shared by the browser and the server.
// Alert = { id, level, type, title, text, action, when, source, channels, date }
//   `date` (YYYY-MM-DD) is an extra field used for sorting; `id` is stable for the same event.

export const LEVELS = {
  urgent:  { rank: 0, label: 'URGENT',         labelBg: 'СПЕШНО',          channels: ['call', 'sms', 'app'] },
  warning: { rank: 1, label: 'WARNING',        labelBg: 'ПРЕДУПРЕЖДЕНИЕ',  channels: ['sms', 'app'] },
  advice:  { rank: 2, label: 'RECOMMENDATION', labelBg: 'ПРЕПОРЪКА',       channels: ['app'] },
  info:    { rank: 3, label: 'INFO',           labelBg: 'ИНФОРМАЦИЯ',      channels: ['app'] },
};

export function channelsFor(level) {
  return [...(LEVELS[level]?.channels ?? ['app'])];
}

// ---------- dates ----------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
const localYmd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNum = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 864e5;
const monthOf = ymd => +ymd.slice(5, 7);
const addDays = (ymd, n) => new Date((dayNum(ymd) + n) * 864e5).toISOString().slice(0, 10);
export function fmtDay(ymd) {
  const d = new Date(dayNum(ymd) * 864e5);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
function isoWeek(ymd) {
  const d = new Date(dayNum(ymd) * 864e5);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}w${pad(Math.ceil(((d - y0) / 864e5 + 1) / 7))}`;
}

const num = x => typeof x === 'number' && Number.isFinite(x);
const sum = a => a.reduce((s, x) => s + (num(x) ? x : 0), 0);
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = x => Math.round(x * 10) / 10;
const unwrap = x => (x && !Array.isArray(x) && 'data' in x && ('ok' in x) ? (x.ok ? x.data : null) : x);

function make(level, type, id, title, text, action, date, when, source) {
  return { id, level, type, title, text, action, when, source, channels: channelsFor(level), date };
}

// Forecast days from today on (Open-Meteo dates are local dates).
function upcoming(forecast, now) {
  const today = localYmd(now);
  return (unwrap(forecast)?.days ?? []).filter(d => d?.date && d.date >= today);
}

// ================= WEATHER =================
const SRC_WX = 'Open-Meteo forecast';

export function weatherAlerts(forecast, { now = new Date(), recent = null } = {}) {
  const days = upcoming(forecast, now);
  if (!days.length) return [];
  const today = localYmd(now);
  const inDays = d => dayNum(d.date) - dayNum(today);
  const out = [];

  // --- hail / thunderstorm (WMO weather codes 95, 96, 99) ---
  for (const d of days) {
    if (d.code === 96 || d.code === 99) {
      const level = inDays(d) <= 3 ? 'urgent' : 'warning';
      out.push(make(level, 'hail', `hail-${d.date}`, 'Hail likely',
        `Thunderstorm with hail is forecast for ${fmtDay(d.date)}. Hail can shred leaves, break stems and knock off flowers or grain.`,
        'Move machinery inside, check your hail insurance. Photograph the field before and after the storm for a claim.',
        d.date, fmtDay(d.date), SRC_WX));
    } else if (d.code === 95) {
      out.push(make('advice', 'storm', `storm-${d.date}`, 'Thunderstorm expected',
        `Thunderstorms are forecast for ${fmtDay(d.date)} with possible strong gusts and local downpours.`,
        'Finish spraying and fertilising before the storm, and secure loose equipment.',
        d.date, fmtDay(d.date), SRC_WX));
    }
  }

  // --- flood / heavy rain ---
  const rain = d => (num(d.rainMm) ? d.rainMm : 0);
  let flood = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (rain(d) >= 50) { flood = { level: 'urgent', day: d, mm: rain(d), multi: false }; break; }
    const win = days.slice(i, i + 3);
    if (win.length === 3 && dayNum(win[2].date) - dayNum(win[0].date) === 2 && sum(win.map(rain)) >= 80) {
      const peak = win.reduce((a, b) => (rain(b) > rain(a) ? b : a));
      flood = { level: 'urgent', day: peak, mm: sum(win.map(rain)), multi: true, from: win[0], to: win[2] };
      break;
    }
  }
  if (!flood) {
    const d = days.find(x => rain(x) >= 30);
    if (d) flood = { level: 'warning', day: d, mm: rain(d), multi: false };
  }
  if (flood) {
    const when = flood.multi ? `${fmtDay(flood.from.date)} - ${fmtDay(flood.to.date)}` : fmtDay(flood.day.date);
    out.push(make(flood.level, 'flood', `flood-${flood.day.date}`,
      flood.level === 'urgent' ? 'Flooding risk' : 'Heavy rain',
      `About ${Math.round(flood.mm)} mm of rain is forecast ${flood.multi ? 'over 3 days' : 'in one day'} (${when}). Water may stand in low parts of the field and wash soil away on slopes.`,
      'Clear drainage ditches and outlets now. Do not drive on wet soil (it compacts). Delay spraying and fertilising until after the rain so it is not washed off.',
      flood.day.date, when, SRC_WX));
  }

  // --- frost ---
  const springFrost = days.filter(d => [3, 4, 5].includes(monthOf(d.date)) && num(d.tMin) && d.tMin <= 0);
  if (springFrost.length) {
    const d = springFrost.reduce((a, b) => (b.tMin < a.tMin ? b : a));
    const level = d.tMin <= -2 ? 'urgent' : 'warning';
    out.push(make(level, 'frost', `frost-${d.date}`, 'Spring frost',
      `Frost down to ${r1(d.tMin)} °C is forecast for ${fmtDay(d.date)}. Emerging crops and flowering rapeseed, orchards and vineyards can be damaged.`,
      'Do not spray or fertilise just before the frost. In orchards and vineyards prepare frost protection (sprinklers, fans). Check the crop 3-5 days after for damage.',
      d.date, fmtDay(d.date), SRC_WX));
  }
  const winterKill = days.filter(d => [12, 1, 2].includes(monthOf(d.date)) && num(d.tMin) && d.tMin <= -18);
  if (winterKill.length) {
    const d = winterKill.reduce((a, b) => (b.tMin < a.tMin ? b : a));
    out.push(make('warning', 'frost', `frost-${d.date}`, 'Severe cold',
      `Temperatures down to ${r1(d.tMin)} °C are forecast for ${fmtDay(d.date)}. Without snow cover, winter wheat, barley and rapeseed can be killed.`,
      'Check whether the field has snow cover. After the cold spell, dig up a few plants and check the crowns are white and firm (alive).',
      d.date, fmtDay(d.date), SRC_WX));
  }

  // --- heat ---
  const summer = days.filter(d => [5, 6, 7, 8].includes(monthOf(d.date)) && num(d.tMax));
  const hot38 = summer.filter(d => d.tMax >= 38);
  const hot35 = summer.filter(d => d.tMax >= 35);
  if (hot38.length) {
    const d = hot38.reduce((a, b) => (b.tMax > a.tMax ? b : a));
    out.push(make('urgent', 'heat', `heat-${d.date}`, 'Extreme heat',
      `Up to ${Math.round(d.tMax)} °C is forecast for ${fmtDay(d.date)}. Heat during flowering or grain filling cuts yield sharply.`,
      'Irrigate before the heat if you can (early morning). Do not spray in the heat of the day. Plan to harvest ripe cereals early.',
      d.date, fmtDay(d.date), SRC_WX));
  } else if (hot35.length >= 2) {
    const d = hot35[0];
    out.push(make('warning', 'heat', `heat-${d.date}`, 'Heat wave',
      `${hot35.length} days at 35 °C or more are forecast, starting ${fmtDay(d.date)}. Flowering and grain filling are at risk.`,
      'Irrigate early in the morning if possible, spray only in the evening, and check crops for wilting.',
      d.date, `from ${fmtDay(d.date)}`, SRC_WX));
  }

  // --- drought (next 14 days) ---
  const m = monthOf(today);
  const next14 = days.filter(d => inDays(d) < 14);
  if (next14.length >= 7) {
    const rain14 = sum(next14.map(rain)), et14 = sum(next14.map(d => d.et0Mm));
    const until = fmtDay(next14.at(-1).date);
    const n = next14.length; // 10 days when the app trims the forecast to its reliable part
    if (m >= 4 && m <= 9 && rain14 < 5 && et14 > 45 * n / 14) {
      const dryBefore = num(recent?.last3Pct) && recent.last3Pct < -25;
      const level = dryBefore ? 'urgent' : 'warning';
      out.push(make(level, 'drought', `drought-${today.slice(0, 7)}`, dryBefore ? 'Drought getting worse' : 'Dry spell ahead',
        `Only ${r1(rain14)} mm of rain is expected in the next ${n} days while crops lose about ${Math.round(et14)} mm of water.`
          + (dryBefore ? ` The last 3 months were already ${Math.round(-recent.last3Pct)}% drier than normal.` : ''),
        'Irrigate the most valuable crops first, avoid tillage that dries the soil, and delay nitrogen top-dressing until rain is forecast.',
        today, `next ${n} days`, SRC_WX));
    } else if (m >= 8 && m <= 10 && rain14 < 10) {
      out.push(make('info', 'drought', `drought-sowing-${today.slice(0, 7)}`, 'Dry soil for autumn sowing',
        `Only ${r1(rain14)} mm of rain is expected until ${until}. Autumn crops (wheat, barley, rapeseed) may not germinate evenly if sown into dry soil.`,
        'Check soil moisture at sowing depth before sowing. Sow a bit deeper into moist soil and roll after sowing, or wait for rain.',
        today, `next ${n} days`, SRC_WX));
    }
  }

  // --- wind ---
  const gusty = days.filter(d => num(d.gustKmh) && d.gustKmh >= 70);
  if (gusty.length) {
    const d = gusty.reduce((a, b) => (b.gustKmh > a.gustKmh ? b : a));
    const level = d.gustKmh >= 90 ? 'urgent' : 'warning';
    out.push(make(level, 'wind', `wind-${d.date}`, 'Strong wind',
      `Gusts up to ${Math.round(d.gustKmh)} km/h are forecast for ${fmtDay(d.date)}. Tall crops can be flattened (lodging) and spray drifts.`,
      'Do not spray that day. Secure machinery, covers and greenhouses. Check tall cereals and corn for lodging afterwards.',
      d.date, fmtDay(d.date), SRC_WX));
  }
  return out;
}

// ================= SATELLITE (Sentinel-2) =================
const SRC_SAT = 'ESA Sentinel-2 NDVI/NDMI';
const HARVEST = [
  { re: /wheat|barley|triticale|oat|rye|rapeseed|canola|pea|chickpea|lentil|vetch|coriander|lavender|пшеница|ечемик|тритикале|овес|ръж|рапица|грах|нахут|леща/i, months: [6, 7] },
  { re: /sunflower|corn|maize|soy|sorghum|millet|bean|слънчоглед|царевица|соя|сорго|просо|боб/i, months: [8, 9, 10] },
  { re: /sugar beet|potato|захарно цвекло|картоф/i, months: [8, 9, 10] },
];
function harvestCrop(crops, month) {
  for (const c of crops ?? []) {
    const name = typeof c === 'string' ? c : c?.crop ?? c?.name ?? '';
    if (HARVEST.some(h => h.re.test(name) && h.months.includes(month))) return name;
  }
  return null;
}

export function vegetationAlerts(sentinelRows, { now = new Date(), crops = [] } = {}) {
  const rows = (unwrap(sentinelRows) ?? []).filter(r => r?.date && num(r.ndvi));
  const today = localYmd(now), month = monthOf(today);
  if (month < 3 || month > 10 || rows.length < 2) return [];
  const t = dayNum(today);
  const recentRows = rows.filter(r => r.date <= today && t - dayNum(r.date) <= 35);
  if (!recentRows.length) return [];
  const cur = recentRows.reduce((a, b) => (b.date > a.date ? b : a));
  const year = +cur.date.slice(0, 4);
  const harvest = harvestCrop(crops, month);
  const out = [];

  // baseline: same calendar window (+-15 days) in earlier years
  const curDoy = dayNum(cur.date) - dayNum(`${year}-01-01`);
  const base = rows.filter(r => {
    const y = +r.date.slice(0, 4);
    if (y >= year) return false;
    const doy = dayNum(r.date) - dayNum(`${y}-01-01`);
    return Math.abs(doy - curDoy) <= 15;
  });
  const medOf = k => { const v = base.map(r => r[k]).filter(num); return v.length ? median(v) : null; };
  const bNdvi = base.length >= 2 ? medOf('ndvi') : null;
  let main = null;
  if (bNdvi != null) {
    const drop = bNdvi - cur.ndvi;
    if (drop >= 0.12) {
      let level = drop >= 0.20 ? 'urgent' : 'warning';
      const bNdmi = medOf('ndmi'), bStd = medOf('ndviStd');
      const ndmiDrop = bNdmi != null && num(cur.ndmi) ? bNdmi - cur.ndmi : null;
      const stdRise = bStd != null && num(cur.ndviStd) ? cur.ndviStd - bStd : null;
      let type, title, text, action;
      const pct = `NDVI ${cur.ndvi.toFixed(2)} vs usual ${bNdvi.toFixed(2)} for this time of year`;
      if (ndmiDrop != null && ndmiDrop >= 0.08) {
        type = 'drought'; title = 'Crop is short of water';
        text = `Satellite shows the crop is less green and drier than in past years (${pct}). The crop is short of water.`;
        action = 'Irrigate if you can, avoid tillage and nitrogen top-dressing until rain, and check the driest parts of the field.';
      } else if (stdRise != null && stdRise >= 0.05) {
        type = 'vegetation'; title = 'Patchy crop damage';
        text = `Satellite shows patchy damage: possible pests or disease. Parts of the field are much less green than others (${pct}).`;
        action = 'Walk the field within 2-3 days, check the worst patches; if pests are confirmed, treat quickly with a product registered for the crop to stop the spread.';
      } else {
        type = 'nutrient'; title = 'Crop looks pale';
        text = `Satellite shows the whole field is evenly less green than usual (${pct}): uniform pale crop, possible nitrogen shortage.`;
        action = 'Check leaf colour (yellowing of older leaves means nitrogen shortage). A leaf or soil test confirms it; top-dress nitrogen if needed.';
      }
      if (harvest) {
        level = 'info';
        title = 'Green cover dropped (maybe harvest)';
        text = `Satellite shows much less green cover (${pct}). This may simply be the ${harvest.toLowerCase()} harvest.`;
        action = 'Nothing to do if the field was harvested. If not, walk the field and check the crop.';
      }
      main = make(level, type, `${type}-sat-${cur.date}`, title, text, action, cur.date, `seen ${fmtDay(cur.date)}`, SRC_SAT);
      out.push(main);
    }
  }

  // sudden drop between two clear observations <= 20 days apart
  const prev = rows.filter(r => r.date < cur.date).reduce((a, b) => (!a || b.date > a.date ? b : a), null);
  if (!harvest && prev && dayNum(cur.date) - dayNum(prev.date) <= 20 && prev.ndvi - cur.ndvi >= 0.12
      && !(main && LEVELS[main.level].rank <= LEVELS.warning.rank)) {
    out.push(make('warning', 'vegetation', `vegetation-sudden-${cur.date}`, 'Sudden drop in green cover',
      `Satellite shows green cover fell from ${prev.ndvi.toFixed(2)} to ${cur.ndvi.toFixed(2)} (NDVI) in ${dayNum(cur.date) - dayNum(prev.date)} days. This can mean hail, pests, disease, lodging or mowing.`,
      'Walk the field within 2-3 days and check the worst parts. If pests or disease are confirmed, treat quickly with a product registered for the crop.',
      cur.date, `seen ${fmtDay(cur.date)}`, SRC_SAT));
  }
  return out;
}

// ================= PESTS & DISEASES =================
const SRC_PEST = 'FieldShift pest model + Open-Meteo';

function findCrop(pestsDb, crop) {
  const all = pestsDb?.crops ?? {};
  if (all[crop]) return all[crop];
  const k = Object.keys(all).find(x => x.toLowerCase() === String(crop).toLowerCase());
  return k ? all[k] : null;
}

export function pestAlerts(forecast, cropNames, pestsDb, { now = new Date() } = {}) {
  const days = upcoming(forecast, now).slice(0, 7);
  if (days.length < 3 || !pestsDb?.crops) return [];
  const today = localYmd(now);
  const months = new Set([monthOf(today), ...upcoming(forecast, now).map(d => monthOf(d.date))]);
  const tMean = days.map(d => (num(d.tMean) ? d.tMean : (d.tMax + d.tMin) / 2)).filter(num);
  if (!tMean.length) return [];
  const avgT = sum(tMean) / tMean.length;
  const rainyDays = days.filter(d => num(d.rainMm) && d.rainMm >= 1).length;
  const rain7 = sum(days.map(d => d.rainMm));
  const week = isoWeek(today);
  const out = [];

  for (const crop of [...new Set(cropNames ?? [])]) {
    const entry = findCrop(pestsDb, crop);
    const hits = [];
    for (const p of entry?.pests ?? []) {
      const risk = p?.risk;
      if (!risk || !Array.isArray(p.months) || !p.months.some(mm => months.has(mm))) continue;
      if (num(risk.tMinC) && avgT < risk.tMinC) continue;
      if (num(risk.tMaxC) && avgT > risk.tMaxC) continue;
      if (risk.humid && rainyDays < (risk.rainDaysMin ?? 3)) continue;
      if (risk.dry && !(rain7 < 5)) continue;
      hits.push(p);
    }
    hits.sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
    for (const p of hits.slice(0, 3)) {
      const level = p.severity >= 3 ? 'warning' : 'advice';
      const type = p.type === 'disease' ? 'disease' : 'pest';
      const name = p.name ?? p.id;
      const why = [`average ${r1(avgT)} °C`];
      if (p.risk.humid) why.push(`${rainyDays} rainy days`);
      if (p.risk.dry) why.push('dry');
      out.push(make(level, type, `${type}-${p.id ?? name}-${String(crop).toLowerCase().replace(/\W+/g, '_')}-${week}`,
        `${name} risk on ${crop}`,
        `Weather in the next 7 days (${why.join(', ')}) favours ${name}${p.nameBg ? ` (${p.nameBg})` : ''}${p.latin ? `, ${p.latin}` : ''} on ${crop}.`
          + (p.signs ? ` Signs: ${p.signs}` : ''),
        [p.scout, p.action].filter(Boolean).join(' '),
        days[0].date, 'next 7 days', SRC_PEST));
    }
  }
  return out;
}

// ================= MERGE =================
export function buildAlerts({ forecast, sentinel, crops = [], pests = null, recent = null, now = new Date() } = {}) {
  const names = (crops ?? []).map(c => (typeof c === 'string' ? c : c?.crop ?? c?.name)).filter(Boolean);
  const all = [
    ...safe(() => weatherAlerts(forecast, { now, recent })),
    ...safe(() => vegetationAlerts(sentinel, { now, crops: names })),
    ...(pests ? safe(() => pestAlerts(forecast, names, pests, { now })) : []),
  ];
  const byId = new Map();
  for (const a of all) {
    const old = byId.get(a.id);
    if (!old || LEVELS[a.level].rank < LEVELS[old.level].rank) byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) => LEVELS[a.level].rank - LEVELS[b.level].rank || String(a.date).localeCompare(String(b.date)));
}
function safe(fn) { try { return fn() ?? []; } catch (err) { console.warn('alert rule failed', err); return []; } }

// ================= MESSAGE TEXT =================
// Bulgarian Cyrillic -> Latin (official streamlined system), so names fit GSM-7.
const BG = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
const REPL = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '°': '', '≥': '>=', '≤': '<=', '±': '+-', '€': 'EUR', '\n': ' ' };

export function toGsm(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const lower = ch.toLowerCase();
    if (BG[lower] != null) { const t = BG[lower]; out += ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1); continue; }
    if (REPL[ch] != null) { out += REPL[ch]; continue; }
    out += ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  }
  // keep a safe subset of the GSM-7 basic alphabet (no extension chars, they cost 2)
  return out.replace(/[^A-Za-z0-9 .,:;!?'"()+\-/%&#@*=<>]/g, '').replace(/\s+/g, ' ').trim();
}

function fit(s, max) {
  if (s.length <= max) return s;
  if (max <= 3) return '';
  const cut = s.slice(0, max - 3);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '') + '...';
}

export function smsText(alert, fieldName) {
  const label = LEVELS[alert?.level]?.label ?? 'INFO';
  const field = fit(toGsm(fieldName) || 'your field', 30);
  const tail = ' Reply STOP to end';
  let head = `FieldShift ${label}: ${toGsm(alert?.title)} ${toGsm(alert?.when)} at ${field}.`.replace(/\s+/g, ' ');
  head = fit(head, 160 - tail.length - 1);
  const room = 160 - head.length - tail.length - 1;
  // as many whole sentences of the action as fit; cut the first one only if it alone is too long
  const sentences = (toGsm(alert?.action).match(/[^.!?]+[.!?]*/g) ?? []).map(x => x.trim()).filter(Boolean);
  let action = '';
  for (const sn of sentences) {
    const next = action ? `${action} ${sn}` : sn;
    if (next.length > room) break;
    action = next;
  }
  if (!action && sentences.length) action = fit(sentences[0], room);
  if (action && !/[.!?]$/.test(action)) action += action.length < room ? '.' : '';
  const msg = (action ? `${head} ${action}${tail}` : `${head}${tail}`).replace(/\s+/g, ' ');
  return msg.length <= 160 ? msg : msg.slice(0, 160);
}

// Short spoken text for an automated voice call (English).
export function callScript(alert, fieldName) {
  const label = (LEVELS[alert?.level]?.label ?? 'info').toLowerCase();
  const field = toGsm(fieldName) || 'your field';
  const speak = s => toGsm(s).replace(/km\/h/g, 'kilometres per hour').replace(/\bmm\b/g, 'millimetres').replace(/(\d) C\b/g, '$1 degrees')
    .replace(/\bNDVI\b/g, 'vegetation index').replace(/(\d)-(\d)/g, '$1 to $2');
  return [
    `Hello. This is FieldShift with ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label} alert for ${field}.`,
    `${speak(alert?.title)}, ${speak(alert?.when)}.`,
    speak(alert?.text),
    `What to do: ${speak(alert?.action)}`,
    'Details are in the FieldShift app. Goodbye.',
  ].join(' ');
}
