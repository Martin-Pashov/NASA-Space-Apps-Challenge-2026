import { offline, json, realFetch, DATA } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalisePhone, maskPhone, sendSms, makeCall, dispatch, readOutbox, twiml } from '../lib/notify.js';

const outbox = path.join(DATA, 'outbox.json');
test.beforeEach(() => { fs.rmSync(outbox, { force: true }); offline(); });
test.after(() => { globalThis.fetch = realFetch; });

test('phone normalisation and masking', () => {
  assert.equal(normalisePhone('0888123456'), '+359888123456');
  assert.equal(normalisePhone('0888 123 456'), '+359888123456');
  assert.equal(normalisePhone('+359 88 812 3456'), '+359888123456');
  assert.equal(normalisePhone('00359888123456'), '+359888123456');
  assert.equal(normalisePhone('359888123456'), '+359888123456');
  assert.equal(normalisePhone('+31612345678'), '+31612345678');
  for (const bad of ['', '12345', 'hello', '+359 12', '+0123456789', null, undefined, '08881234567890']) assert.equal(normalisePhone(bad), null, String(bad));
  assert.equal(maskPhone('+359888123456'), '+359 88*****56');
});

test('dry run writes the outbox and never throws', async () => {
  const r = await sendSms('0888123456', 'FieldShift WARNING: test');
  assert.deepEqual(r, { channel: 'sms', status: 'dry-run' });
  const c = await makeCall('+359888123456', 'Hello <farmer> & co');
  assert.equal(c.status, 'dry-run');
  const box = readOutbox();
  assert.equal(box.length, 2);
  assert.equal(box[0].to, '+359888123456'); assert.equal(box[0].body, 'FieldShift WARNING: test');
  assert.equal(box[1].channel, 'call');
  assert.deepEqual(await sendSms('nonsense', 'x'), { channel: 'sms', status: 'failed', error: 'invalid phone number' });
});

test('TwiML is XML-escaped and repeats the message', () => {
  const x = twiml('Rain & hail <today> "now"');
  assert.match(x, /^<Response><Say[^>]*>Rain &amp; hail &lt;today&gt; &quot;now&quot;<\/Say><Pause length="1"\/><Say[^>]*>Again\. Rain &amp; hail/);
  assert.ok(!x.includes('<today>'));
});

const alert = (id, level) => ({ id, level, type: 'hail', title: 'Hail likely', text: 't', action: 'Move machinery inside.', when: 'Tue 18 Nov', source: 's', channels: [] });

test('dispatch follows channels, min level and de-duplicates', async () => {
  const sub = { id: 's1', name: 'Field Dobrich', phone: '+359888123456', minLevel: 'warning', sentIds: [] };
  const alerts = [alert('hail-1', 'urgent'), alert('wind-1', 'warning'), alert('storm-1', 'advice')];
  const log = await dispatch(alerts, sub);
  assert.deepEqual(log.map(l => `${l.id}:${l.channel}:${l.status}`), [
    'hail-1:call:dry-run', 'hail-1:sms:dry-run', 'hail-1:app:shown-in-app', 'wind-1:sms:dry-run', 'wind-1:app:shown-in-app',
  ]);
  assert.deepEqual(sub.sentIds, ['hail-1', 'wind-1']);
  assert.equal(readOutbox().length, 3);
  const again = await dispatch(alerts, sub);
  assert.deepEqual(again.map(l => l.status), ['duplicate-skipped', 'duplicate-skipped']);
  assert.equal(readOutbox().length, 3);
  // urgent-only subscriber
  const log2 = await dispatch(alerts, { phone: '0888123456', name: 'x', minLevel: 'urgent' });
  assert.equal(new Set(log2.map(l => l.id)).size, 1);
});

test('Twilio requests use Basic auth and form bodies; failures are reported, not thrown', async () => {
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111' });
  const calls = [];
  offline((u, opts) => {
    calls.push({ u, opts, body: new URLSearchParams(opts.body.toString()) });
    return u.endsWith('/Calls.json') ? json({ message: 'nope' }, 401) : json({ sid: 'SM1', status: 'queued' }, 201);
  });
  try {
    const s = await sendSms('0888123456', 'Hello');
    assert.deepEqual(s, { channel: 'sms', status: 'queued', sid: 'SM1' });
    assert.equal(calls[0].u, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('AC123:tok').toString('base64'));
    assert.equal(calls[0].body.get('To'), '+359888123456');
    assert.equal(calls[0].body.get('From'), '+15550001111');
    assert.equal(calls[0].body.get('Body'), 'Hello');
    const c = await makeCall('+359888123456', 'Frost & hail');
    assert.equal(c.status, 'failed'); assert.match(c.error, /401/);
    assert.match(calls[1].body.get('Twiml'), /Frost &amp; hail/);
    offline(); // network down
    assert.equal((await sendSms('0888123456', 'x')).status, 'failed');
    assert.equal(readOutbox().length, 0);
  } finally {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) delete process.env[k];
  }
});
