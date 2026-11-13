import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './_helpers.js';
import { demoSignInHints } from '../server/auth.js';

const HINTS = JSON.stringify([{ email: 'owner-a@example.test', name: 'Alex Owner', role: 'owner', company: 'Fictional Company A' }, { email: 'one@example.test', name: 'Customer One', role: 'whatever', company: 'A' }]);

test('demo sign-in hints are off by default', async (t) => {
  const w = await world(t);
  const config = (await w.owner.api('auth/config')).data;
  assert.equal(config.demoAccounts, undefined);
  assert.equal(config.demoPassword, undefined);
});

test('demo sign-in hints list accounts only when explicitly enabled, and only as owner or customer', async (t) => {
  const w = await world(t, { config: { DEMO_SIGNIN_HINTS: HINTS, DEMO_SIGNIN_PASSWORD: 'fictional', NODE_ENV: 'test' } });
  const config = (await w.owner.api('auth/config')).data;
  assert.deepEqual(config.demoAccounts.map((a) => a.role), ['owner', 'customer'], 'unknown roles fall back to customer');
  assert.equal(config.demoPassword, 'fictional');
});

test('demo sign-in hints ignore malformed input', async (t) => {
  const bad = await world(t, { config: { DEMO_SIGNIN_HINTS: '{not json', NODE_ENV: 'test' } });
  assert.equal((await bad.owner.api('auth/config')).data.demoAccounts, undefined);
  const notList = await world(t, { config: { DEMO_SIGNIN_HINTS: '{"email":"x"}', NODE_ENV: 'test' } });
  assert.equal((await notList.owner.api('auth/config')).data.demoAccounts, undefined);
});

test('demo sign-in hints are never produced in production, whatever else is set', () => {
  assert.equal(demoSignInHints({ NODE_ENV: 'production', DEMO_SIGNIN_HINTS: HINTS, DEMO_SIGNIN_PASSWORD: 'fictional' }), null);
  assert.equal(demoSignInHints({ NODE_ENV: 'test', DEMO_SIGNIN_HINTS: HINTS, DEMO_SIGNIN_PASSWORD: 'fictional' }).accounts.length, 2);
  assert.equal(demoSignInHints({ NODE_ENV: 'test' }), null);
  assert.equal(demoSignInHints({ DEMO_SIGNIN_HINTS: HINTS, DEMO_SIGNIN_PASSWORD: 'fictional' }), null, 'a missing NODE_ENV is not enough');
  assert.equal(demoSignInHints({ NODE_ENV: 'staging', DEMO_SIGNIN_HINTS: HINTS }), null, 'only development and test qualify');
});
