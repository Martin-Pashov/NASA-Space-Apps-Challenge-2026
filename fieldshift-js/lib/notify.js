// Alert delivery: SMS and automated voice calls through Twilio's REST API (plain fetch, no SDK).
// Without Twilio credentials everything runs as a DRY RUN: messages are appended to data/outbox.json.
// Nothing here throws to the caller.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { LEVELS, smsText, callScript } from '../public/alerts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = () => path.resolve(ROOT, process.env.FIELDSHIFT_DATA_DIR || 'data');
const outboxFile = () => path.join(dataDir(), 'outbox.json');
const MAX_OUTBOX = 500, MAX_SENT_IDS = 500;

// ---------- phone numbers ----------
// Accepts E.164 (+359888123456), 00359..., 359..., and Bulgarian local numbers (0888 123 456).
export function normalisePhone(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let p = String(raw).trim().replace(/[\s\-().\/]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (/^359\d{8,9}$/.test(p)) p = '+' + p;
  else if (/^0\d{8,9}$/.test(p)) p = '+359' + p.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(p)) return null;
  if (p.startsWith('+359') && !/^\+359\d{8,9}$/.test(p)) return null;
  return p;
}

// +359888123456 -> "+359 88*****56"
export function maskPhone(p) {
  if (!p) return '';
  const cc = p.startsWith('+359') ? '359' : p.slice(1, 3);
  const rest = p.slice(1 + cc.length);
  if (rest.length <= 4) return `+${cc} ${'*'.repeat(rest.length)}`;
  return `+${cc} ${rest.slice(0, 2)}${'*'.repeat(rest.length - 4)}${rest.slice(-2)}`;
}

// ---------- Twilio ----------
const twilio = () => {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
  return sid && token && from ? { sid, token, from } : null;
};

const xml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function twiml(script) {
  return `<Response><Say voice="alice" language="en-GB">${xml(script)}</Say><Pause length="1"/>`
    + `<Say voice="alice" language="en-GB">Again. ${xml(script)}</Say></Response>`;
}

function writeOutbox(entry) {
  try {
    const file = outboxFile();
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(list)) list = []; } catch { /* new file */ }
    list.push({ at: new Date().toISOString(), ...entry });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list.slice(-MAX_OUTBOX), null, 1));
  } catch (err) { console.warn('Outbox write failed ->', err.message); }
}

export function readOutbox() {
  try { return JSON.parse(fs.readFileSync(outboxFile(), 'utf8')); } catch { return []; }
}

async function twilioPost(kind, form) {
  const t = twilio();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.sid)}/${kind}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${t.sid}:${t.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: t.from, ...form }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${j.message ?? 'request failed'}`);
  return j;
}

async function deliver(channel, to, payload) {
  const phone = normalisePhone(to);
  if (!phone) return { channel, status: 'failed', error: 'invalid phone number' };
  if (!twilio()) {
    writeOutbox({ channel, to: phone, ...payload });
    return { channel, status: 'dry-run' };
  }
  try {
    const j = channel === 'sms'
      ? await twilioPost('Messages', { To: phone, Body: payload.body })
      : await twilioPost('Calls', { To: phone, Twiml: twiml(payload.script) });
    return { channel, status: j.status ?? 'queued', sid: j.sid };
  } catch (err) {
    return { channel, status: 'failed', error: err.message };
  }
}

export const sendSms = (to, body) => deliver('sms', to, { body });
export const makeCall = (to, script) => deliver('call', to, { script });

// ---------- dispatch ----------
// sub = { id, name, phone, minLevel, sentIds: [] }. Mutates sub.sentIds; the caller saves it.
export async function dispatch(alerts, sub) {
  const log = [];
  try {
    const min = LEVELS[sub?.minLevel]?.rank ?? LEVELS.warning.rank;
    sub.sentIds = Array.isArray(sub.sentIds) ? sub.sentIds : [];
    for (const a of alerts ?? []) {
      const lv = LEVELS[a?.level];
      if (!lv || lv.rank > min) continue;
      if (sub.sentIds.includes(a.id)) { log.push({ id: a.id, level: a.level, channel: 'all', status: 'duplicate-skipped' }); continue; }
      let delivered = false;
      for (const channel of lv.channels) {
        let r;
        if (channel === 'app') r = { channel, status: 'shown-in-app' };
        else if (channel === 'sms') r = await sendSms(sub.phone, smsText(a, sub.name));
        else if (channel === 'call') r = await makeCall(sub.phone, callScript(a, sub.name));
        else continue;
        if (channel !== 'app' && r.status !== 'failed') delivered = true;
        log.push({ id: a.id, level: a.level, ...r });
      }
      // in-app only alerts are "delivered" by being listed; phone alerts must reach the phone
      if (delivered || !lv.channels.some(c => c !== 'app')) sub.sentIds.push(a.id);
    }
    sub.sentIds = sub.sentIds.slice(-MAX_SENT_IDS);
  } catch (err) {
    log.push({ channel: 'all', status: 'failed', error: err.message });
  }
  return log;
}
