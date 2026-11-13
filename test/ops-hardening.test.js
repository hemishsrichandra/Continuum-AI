import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { world } from './_helpers.js';
import { rotate } from '../scripts/rotate-integration-key.js';
import { reconcileJobs } from '../server/system-health.js';

test('key rotation re-encrypts every sealed value, is all-or-nothing, and a dry run changes nothing', async (t) => {
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const w = await world(t, { config: { INTEGRATION_ENCRYPTION_KEY: oldKey.toString('base64') } });
  const delivery = w.h.delivery ?? null;
  const sealOld = (value, ctx) => w.h.store && (delivery ? delivery.seal(value, ctx) : null);
  assert.ok(delivery, 'the handler exposes its integrations service for tests');
  const sql = w.db();
  sql.prepare('INSERT INTO provider_connections(company_id,base_url,encrypted_token,mapping,writes_enabled,capabilities) VALUES(?,?,?,?,?,?)')
    .run(w.company, 'https://tickets.example.test', sealOld({ token: 'tok-1' }, 'provider:' + w.company), '{}', 0, '{}');
  const before = sql.prepare('SELECT encrypted_token FROM provider_connections').get().encrypted_token;
  const dry = rotate(sql, oldKey, newKey, { apply: false });
  assert.equal(dry.counts['Ticket-system connections'], 1);
  assert.equal(sql.prepare('SELECT encrypted_token FROM provider_connections').get().encrypted_token, before, 'a dry run changes nothing');
  assert.throws(() => rotate(sql, randomBytes(32), newKey, { apply: true }), /old key/);
  assert.equal(sql.prepare('SELECT encrypted_token FROM provider_connections').get().encrypted_token, before, 'a wrong old key changes nothing');
  rotate(sql, oldKey, newKey, { apply: true });
  const after = sql.prepare('SELECT encrypted_token FROM provider_connections').get().encrypted_token;
  assert.notEqual(after, before);
  assert.deepEqual(rotate(sql, newKey, newKey).counts['Ticket-system connections'], 1, 'readable with the new key');
  assert.throws(() => rotate(sql, oldKey, newKey), /old key/, 'no longer readable with the old key');
});

test('job reconciliation counts failed, overdue and abandoned provider jobs for one company only', async (t) => {
  const w = await world(t);
  const sql = w.db();
  const now = Date.now();
  const add = (company, status, { next = now, lease = 0 } = {}) => sql.prepare(`INSERT INTO provider_jobs(id,company_id,account_id,provider,ticket_id,action_id,kind,customer_id,payload,config_revision,status,next_attempt,lease_until,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), company, 'a', 'repair', 't', randomUUID(), 'outcome', 'c', 'x', 1, status, next, lease, new Date().toISOString());
  add(w.company, 'failed');
  add(w.company, 'pending', { next: now - 3600000 });
  add(w.company, 'pending', { next: now + 60000 });
  add(w.company, 'processing', { lease: now - 120000 });
  add(w.companyB, 'failed');
  const r = reconcileJobs(w.h.store, w.company, { at: now });
  assert.deepEqual([r.failed, r.overdue, r.abandoned, r.pending, r.needsAttention], [1, 1, 1, 2, 3]);
  assert.ok(r.oldestOverdueMinutes >= 59);
  const health = (await w.owner.api('company/system-health')).data;
  assert.equal(health.summary.syncedUpdates.state, 'attention');
  assert.equal(JSON.stringify(health).includes(w.companyB), false);
});
