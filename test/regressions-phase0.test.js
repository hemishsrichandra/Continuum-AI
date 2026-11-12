import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibility } from '../server/context.js';
import { customerAdvice } from '../server/customer-advice.js';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';

test('negated device/model mentions are never treated as compatible', () => {
  const r = compatibility('Model X firmware 4', 'My device is not Model X, it is firmware 4');
  assert.equal(r.compatible, false);
  assert.ok(r.conflicts.length);
  assert.equal(compatibility('Model X firmware 4', 'I do not have a Model X. Firmware 4').compatible, false);
  assert.equal(compatibility('Model X firmware 4', 'Model Y on firmware 4').compatible, false);
  assert.equal(compatibility('Model X firmware 4', 'Model X on firmware 4').compatible, true);
});

test('Android / iOS versions and explicit ranges are enforced', () => {
  assert.equal(compatibility('Android 13', 'Pixel phone on Android 12').compatible, false);
  assert.equal(compatibility('Android 13', 'Pixel phone on Android 13.1').compatible, true);
  assert.equal(compatibility('Android 12 or later', 'phone on Android 11').compatible, false);
  assert.equal(compatibility('Android 12 or later', 'phone on Android 14').compatible, true);
  assert.equal(compatibility('Android 10-12', 'phone on Android 13').compatible, false);
  assert.equal(compatibility('Android 10-12', 'phone on Android 11').compatible, true);
  const ios = compatibility('Android 12+', 'iPhone on iOS 17');
  assert.equal(ios.compatible, false);
  assert.ok(ios.conflicts.length, 'a different OS family is a conflict, not merely unknown');
  const unknown = compatibility('Android 13', 'my phone');
  assert.equal(unknown.compatible, false);
  assert.ok(unknown.missing.length && !unknown.conflicts.length, 'unknown version means clarify, not compatible');
});

test('customer advice keeps fictional/simulation qualifiers and safety warnings', () => {
  assert.equal(customerAdvice('Fictional demo only: select the training profile.'), 'Fictional demo only: select the training profile.');
  assert.match(customerAdvice('Fictional ChargeDemo test solution: reconnect. Stop if hot.'), /^Fictional ChargeDemo test solution: .*Stop if hot\.$/);
  assert.equal(customerAdvice('Specialist solution: reconnect the cable.'), 'Reconnect the cable.');
});

test('staff and owners cannot use the customer appointment cancellation endpoint', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  let cookie = '', csrf = '';
  const api = async (route, body) => {
    const r = await invoke(h, route, { body, headers: { cookie, 'x-csrf-token': csrf } });
    if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
    if (r.data.csrfToken) csrf = r.data.csrfToken;
    return r;
  };
  assert.equal((await api('auth/register', { createCompany: true, companyName: 'Guard Co', name: 'Owner', email: 'guard-owner@example.test', password: 'a very long test passphrase 2026', provider: 'repair' })).status, 201);
  const r = await api('book/cancel', { ticketId: 'SR-X', id: 'x', confirmed: true });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Customer accounts/);
});
