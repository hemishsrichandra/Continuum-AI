import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../server/providers.js';
import { createHandler } from '../server/app.js';
import { world, ISSUE } from './_helpers.js';

/** Turn a current database back into a v4 installation (drop every v5 structure). */
function downgradeToV4(file) {
  const db = new Database(file);
  db.exec(`
    DROP TRIGGER IF EXISTS memory_pool_fts_insert; DROP TRIGGER IF EXISTS memory_pool_fts_update; DROP TRIGGER IF EXISTS memory_pool_fts_delete;
    DROP TABLE memory_pool_fts; DROP TABLE memory_pool; DROP TABLE follow_through_tasks; DROP TABLE case_events; DROP TABLE company_data_sources;
    DROP TABLE troubleshooting_attempts;
    CREATE TABLE troubleshooting_attempts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL,
      customer_id TEXT NOT NULL, ticket_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('standard','learned')),
      fix_id TEXT NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), context TEXT NOT NULL CHECK(json_valid(context)),
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed','skipped')),
      exchange_id TEXT, use_id TEXT REFERENCES resolution_uses(id), handoff_id TEXT, created_at TEXT NOT NULL,outcome_at TEXT,
      FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id),
      UNIQUE(company_id,chatbot_id,customer_id,ticket_id,source));
    DELETE FROM schema_migrations WHERE version=5;
  `);
  db.close();
}

test('fresh database: Migration 5 creates every structure with indexes, FTS and the standard playbooks', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all().map((r) => r.name);
  for (const n of ['company_data_sources', 'memory_pool', 'memory_pool_fts', 'follow_through_tasks', 'case_events', 'follow_through_due', 'memory_pool_scope', 'memory_pool_fts_insert', 'memory_pool_fts_update', 'memory_pool_fts_delete'])
    assert.ok(names.includes(n), 'missing ' + n);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
  assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.ok(store.db.prepare("SELECT COUNT(*) n FROM memory_pool WHERE origin_type='standard_playbook'").get().n >= 3, 'standard playbooks join the unified pool');
  // Constraints: origin/status vocab, score range and tenant foreign key.
  const bad = (patch) => () => store.db.prepare(`INSERT INTO memory_pool(id,company_id,chatbot_id,lineage_id,origin_type,source_key,content_hash,title,symptoms_text,steps_json,initial_confidence_score,status,created_at,updated_at) VALUES('x','legacy','legacy:repair','x',?,?,?,?,?,'["s"]',?,?,'t','t')`).run(patch.origin ?? 'specialist_confirmed', 'k' + Math.random(), 'h', 't', 's', patch.score ?? 0.5, patch.status ?? 'active');
  assert.throws(bad({ origin: 'made_up' }));
  assert.throws(bad({ status: 'weird' }));
  assert.throws(bad({ score: 1.5 }));
  assert.throws(() => store.db.prepare("INSERT INTO memory_pool(id,company_id,chatbot_id,lineage_id,origin_type,source_key,content_hash,title,symptoms_text,steps_json,initial_confidence_score,created_at,updated_at) VALUES('y','no-such-company','nope','y','specialist_confirmed','k','h','t','s','[\"s\"]',0.5,'t','t')").run());
  assert.throws(() => store.db.prepare("INSERT INTO follow_through_tasks(id,company_id,ticket_id,task_type,dedupe_key,deadline_at,created_at) VALUES('a','legacy','t','bogus','d','x','x')").run());
});

test('v4 upgrade: data and authentication survive, history is backfilled with provenance, a backup is taken, and re-running is harmless', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-v5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'app.sqlite');
  const w = await world(t, { file });
  // Build a published specialist fix, a failed reuse and an unpublished proposal in the "old" system.
  const a = await w.customer('alice');
  const ticket = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId: ticket, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const proposal = (await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, title: 'Display flicker', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Open Display settings, pick the Standard profile and restart the laptop.', reviewedForPrivacy: true, confirmed: true })).data;
  await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true });
  const accountsBefore = w.db().prepare('SELECT id,email,password_hash FROM accounts ORDER BY id').all();
  const recordsBefore = JSON.stringify(w.h.store.data.conversations.length + ':' + w.h.store.data.handoffs.length);
  w.h.close();
  downgradeToV4(file);
  const upgraded = new Store(file);
  t.after(() => upgraded.close());
  assert.ok(existsSync(file + '.pre-v5.bak'), 'a backup copy exists before the upgrade');
  const backup = new Database(file + '.pre-v5.bak', { readonly: true });
  assert.equal(backup.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 0, 'the backup is the pre-upgrade state');
  backup.close();
  assert.deepEqual(upgraded.db.prepare('SELECT id,email,password_hash FROM accounts ORDER BY id').all(), accountsBefore);
  assert.equal(JSON.stringify(upgraded.data.conversations.length + ':' + upgraded.data.handoffs.length), recordsBefore);
  const back = upgraded.db.prepare("SELECT * FROM memory_pool WHERE source_key=?").get('resolution:' + proposal.id);
  assert.ok(back, 'the published specialist fix was backfilled');
  assert.equal(back.origin_type, 'specialist_confirmed');
  assert.equal(back.customer_confirmed, 1);
  assert.equal(back.company_id, w.company);
  assert.equal(back.chatbot_id, w.botOf(w.company));
  assert.equal(back.id, proposal.id);
  assert.equal(JSON.parse(back.provenance_json).note.includes('Migration 5'), true);
  assert.equal(upgraded.db.prepare("SELECT COUNT(*) n FROM memory_pool WHERE origin_type='standard_playbook' AND company_id=?").get(w.company).n >= 3, true);
  // FTS in sync after backfill.
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM memory_pool_fts').get().n, upgraded.db.prepare('SELECT COUNT(*) n FROM memory_pool').get().n);
  assert.equal(upgraded.db.prepare("SELECT memory_id FROM memory_pool_fts WHERE memory_pool_fts MATCH 'flickers'").all().some((r) => r.memory_id === proposal.id), true);
  // Re-running changes nothing.
  const count = () => upgraded.db.prepare('SELECT COUNT(*) n FROM memory_pool').get().n;
  const n = count();
  upgraded.migrateV5();
  upgraded.close();
  const again = new Store(file);
  t.after(() => again.close());
  assert.equal(again.db.prepare('SELECT COUNT(*) n FROM memory_pool').get().n, n);
  assert.equal(again.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
  assert.deepEqual(again.db.pragma('foreign_key_check'), []);
});

test('upgraded database serves the same customers: login and the learned fix still work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-v5b-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'app.sqlite');
  const w = await world(t, { file });
  const a = await w.customer('alice');
  const ticket = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId: ticket, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const p = (await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, title: 'Display flicker', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Open Display settings, pick the Standard profile and restart the laptop.', reviewedForPrivacy: true, confirmed: true })).data;
  await a.api('resolutions/confirm', { id: p.id, accepted: true, confirmed: true });
  w.h.close();
  downgradeToV4(file);
  const h = createHandler({ file, config: {} });
  t.after(() => h.close());
  const { invoke } = await import('../scripts/invoke.js');
  const login = await invoke(h, 'auth/login', { body: { email: 'bob@example.test', password: 'x'.repeat(16) } });
  assert.equal(login.status, 401, 'unknown account is rejected normally');
  const ok = await invoke(h, 'auth/login', { body: { email: 'alice@example.test', password: 'a fictional test passphrase 2026' } });
  assert.equal(ok.status, 200);
  const retrieved = await h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: ISSUE });
  assert.equal(retrieved.eligible[0]?.row.id, p.id);
});

test('unique stable source identity: the same source key and version cannot be inserted twice', async (t) => {
  const w = await world(t);
  w.seed(w.company, { title: 'X', symptoms: 'Display flickers after startup', steps: ['Open Display settings and restart.'], sourceKey: 'same' });
  assert.throws(() => w.seed(w.company, { title: 'Y', symptoms: 'Display flickers after startup', steps: ['Open Display settings and restart.'], sourceKey: 'same' }), /UNIQUE/);
  // The same key in another company is a different record.
  w.seed(w.companyB, { title: 'X', symptoms: 'Display flickers after startup', steps: ['Open Display settings and restart.'], sourceKey: 'same' });
});

test('restore drill: the pre-upgrade backup restores a working v4 database that upgrades again without loss', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'app.sqlite');
  const w = await world(t, { file });
  const a = await w.customer('alice');
  const ticket = await w.ticket(a, ISSUE);
  w.h.close();
  downgradeToV4(file);
  const upgraded = new Store(file);
  const before = JSON.stringify(upgraded.data.repair.map((r) => r.ticket_id));
  upgraded.db.prepare("INSERT INTO case_events(id,company_id,chatbot_id,ticket_id,kind,created_at) VALUES('e','legacy','legacy:repair','x','post_upgrade','t')").run();
  upgraded.close();
  assert.ok(existsSync(file + '.pre-v5.bak'));
  // Operator restores the backup while the app is stopped (remove WAL side files, copy the backup back).
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  copyFileSync(file + '.pre-v5.bak', file);
  const restored = new Database(file, { readonly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 0, 'restored file is the v4 state');
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='memory_pool'").get().n, 0);
  restored.close();
  const again = new Store(file);
  t.after(() => again.close());
  assert.equal(JSON.stringify(again.data.repair.map((r) => r.ticket_id)), before, 'the customer’s ticket survived restore and re-upgrade');
  assert.ok(again.data.repair.some((r) => r.ticket_id === ticket));
  assert.equal(again.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
  assert.equal(again.db.prepare("SELECT COUNT(*) n FROM case_events WHERE kind='post_upgrade'").get().n, 0, 'work done after the backup is not in the restored state');
  assert.equal(again.db.pragma('integrity_check', { simple: true }), 'ok');
});
