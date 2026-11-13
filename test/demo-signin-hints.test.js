import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './_helpers.js';

const HINTS = JSON.stringify([{ email: 'owner-a@example.test', name: 'Alex Owner', role: 'owner', company: 'Fictional Company A' }, { email: 'one@example.test', name: 'Customer One', role: 'whatever', company: 'A' }]);

test('demo sign-in hints are off by default', async (t) => {
  const w = await world(t);
  const config = (await w.owner.api('auth/config')).data;
  assert.equal(config.demoAccounts, undefined);
  assert.equal(config.demoPassword, undefined);
});

test('demo sign-in hints list accounts only when explicitly enabled, and only as owner or customer', async (t) => {
  const w = await world(t, { config: { DEMO_SIGNIN_HINTS: HINTS, DEMO_SIGNIN_PASSWORD: 'fictional' } });
  const config = (await w.owner.api('auth/config')).data;
  assert.deepEqual(config.demoAccounts.map((a) => a.role), ['owner', 'customer'], 'unknown roles fall back to customer');
  assert.equal(config.demoPassword, 'fictional');
});

test('demo sign-in hints ignore malformed input', async (t) => {
  const bad = await world(t, { config: { DEMO_SIGNIN_HINTS: '{not json' } });
  assert.equal((await bad.owner.api('auth/config')).data.demoAccounts, undefined);
  const notList = await world(t, { config: { DEMO_SIGNIN_HINTS: '{"email":"x"}' } });
  assert.equal((await notList.owner.api('auth/config')).data.demoAccounts, undefined);
});
