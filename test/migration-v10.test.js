import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../server/providers.js';
import { world, ISSUE, FOUR } from './_helpers.js';

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('migration 10 on a populated older database: columns are added, data survives, re-opening is harmless', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-m10-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'app.sqlite');
  const w = await world(t, { file });
  // Real data: knowledge, a customer, a request and a conversation with a recorded attempt.
  FOUR.slice(0, 2).forEach(([title, symptoms, step], i) => w.seed(w.company, { title, symptoms, steps: [step], sourceKey: 'm:' + i }));
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  await w.ask(cust, ticket, ISSUE);
  const before = { pool: w.db().prepare('SELECT COUNT(*) n FROM memory_pool').get().n, attempts: w.db().prepare('SELECT COUNT(*) n FROM troubleshooting_attempts').get().n, accounts: w.db().prepare('SELECT COUNT(*) n FROM accounts').get().n };
  assert.ok(before.pool >= 2 && before.attempts >= 1);
  w.h.close();

  // Make it look like a version-9 installation: neither new column exists.
  const old = new Database(file);
  old.exec('ALTER TABLE troubleshooting_attempts DROP COLUMN outcome_detail; ALTER TABLE company_data_sources DROP COLUMN sync_cursor;');
  assert.ok(!cols(old, 'troubleshooting_attempts').includes('outcome_detail'));
  old.close();

  const upgraded = new Store(file);
  t.after(() => upgraded.close());
  assert.ok(cols(upgraded.db, 'troubleshooting_attempts').includes('outcome_detail'));
  assert.ok(cols(upgraded.db, 'company_data_sources').includes('sync_cursor'));
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM memory_pool').get().n, before.pool, 'knowledge survived');
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM troubleshooting_attempts').get().n, before.attempts, 'attempts survived');
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, before.accounts, 'accounts survived');
  assert.deepEqual(upgraded.db.pragma('foreign_key_check'), []);
  assert.equal(upgraded.db.pragma('integrity_check', { simple: true }), 'ok');
  // The new column is usable on old rows (null) and for the new outcomes.
  upgraded.db.prepare("UPDATE troubleshooting_attempts SET outcome='skipped',outcome_detail='not_applicable' WHERE rowid=(SELECT MIN(rowid) FROM troubleshooting_attempts)").run();
  upgraded.close();

  const again = new Store(file); // re-running every migration must change nothing
  t.after(() => again.close());
  assert.equal(again.db.prepare("SELECT outcome_detail d FROM troubleshooting_attempts WHERE outcome='skipped' LIMIT 1").get().d, 'not_applicable');
  assert.equal(again.db.prepare('SELECT COUNT(*) n FROM memory_pool').get().n, before.pool);
});
