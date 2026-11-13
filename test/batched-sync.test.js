import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { world } from './_helpers.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'env' }, diagnostics: {} };

/** A synthetic SQLite knowledge base with `n` distinct records. */
async function setup(t, n, config = {}, { authoritative = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'kb.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE kb(id TEXT, title TEXT, symptoms TEXT, steps TEXT, env TEXT)');
  const ins = db.prepare('INSERT INTO kb VALUES(?,?,?,?,?)');
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(String(i).padStart(6, '0'), `Fix ${i} for gadget ${i}`, `Gadget ${i} shows error code E${i}`, `Open the gadget ${i} menu, choose reset profile ${i} and restart the device.`, 'Model X firmware 4'); })();
  db.close();
  const w = await world(t, { config: { DATA_SOURCE_SQLITE_DIRS: dir, ...config } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: w.botOf(w.company), name: 'Big KB', fieldMapping: MAPPING, connection: { path: file, table: 'kb' }, declaredVerified: true, authoritativeSnapshot: authoritative });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.source.id;
  const sync = async () => (await w.owner.api(`company/data-sources/${id}/sync`, { confirmed: true }));
  const view = async () => (await w.owner.api('company/data-sources')).data.sources.find((s) => s.id === id);
  return { w, id, file, sync, view, count: () => w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_id=? AND origin_type='company_db_sync'").get(id).n };
}

test('a source larger than the old 2,000-record cap syncs completely, in batches, with nothing dropped', async (t) => {
  const s = await setup(t, 2600, { DATA_SOURCE_BATCH_SIZE: '500' });
  const r = await s.sync();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.result.inserted, 2600);
  assert.equal(r.data.result.batches, 6, '2,600 rows in batches of 500');
  assert.equal(s.count(), 2600, 'every record is in the pool');
  assert.equal((await s.view()).status, 'ok');
  // A record from the last page is as retrievable as one from the first.
  const hit = await s.w.h.memoryPool.retrieve({ companyId: s.w.company, chatbotId: s.w.botOf(s.w.company), text: 'Gadget 2599 shows error code E2599 on Model X firmware 4' });
  assert.ok(hit.eligible.some((c) => /Fix 2599/.test(c.row.title)), JSON.stringify(hit.rejected?.slice(0, 2)));
});

test('syncing again is idempotent: nothing is duplicated and nothing changes', async (t) => {
  const s = await setup(t, 1200, { DATA_SOURCE_BATCH_SIZE: '400' });
  await s.sync();
  const again = (await s.sync()).data.result;
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 1200);
  assert.equal(s.count(), 1200);
});

test('the per-run limit pauses the import without dropping anything, shows it, and the next run resumes', async (t) => {
  const s = await setup(t, 1500, { DATA_SOURCE_BATCH_SIZE: '100', DATA_SOURCE_MAX_RECORDS: '700' });
  const first = (await s.sync()).data.result;
  assert.equal(first.deferred, true);
  assert.equal(first.processed, 700);
  assert.match(first.warning, /Nothing was dropped: run the sync again to continue from record 700/);
  assert.equal(s.count(), 700);
  const mid = await s.view();
  assert.equal(mid.status, 'deferred');
  assert.equal(mid.resumable, true);
  const second = (await s.sync()).data.result;
  assert.equal(second.resumedFrom, 700);
  assert.ok(second.deferred, 'still more than 700 left: pauses again');
  const third = (await s.sync()).data.result;
  assert.ok(!third.deferred, 'the last run finishes');
  assert.equal(s.count(), 1500, 'every record arrived across the runs');
  assert.equal((await s.view()).status, 'ok');
  assert.match(third.warning, /resumed import finished/i);
});

test('a paused or resumed run never retires records, even for an authoritative snapshot; one full run does', async (t) => {
  const s = await setup(t, 300, { DATA_SOURCE_BATCH_SIZE: '100' }, { authoritative: true });
  assert.equal((await s.sync()).data.result.snapshot, 'complete');
  const db = new Database(s.file);
  db.exec("DELETE FROM kb WHERE id < '000100'");
  db.close();
  const full = (await s.sync()).data.result;
  assert.equal(full.retiredFromSource, 100, 'a complete uninterrupted snapshot withdraws what the source dropped');
  // Now a source that pauses part-way: the records missing from the part it has not read yet are not touched.
  const p = await setup(t, 300, { DATA_SOURCE_BATCH_SIZE: '100', DATA_SOURCE_MAX_RECORDS: '100' }, { authoritative: true });
  const paused = (await p.sync()).data.result;
  assert.equal(paused.deferred, true);
  assert.equal(paused.retiredFromSource, undefined);
  assert.equal(p.w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_id=? AND status='retired'").get(p.id).n, 0);
});

test('two syncs at once: the second is refused instead of racing', async (t) => {
  const s = await setup(t, 1500, { DATA_SOURCE_BATCH_SIZE: '100' });
  const [a, b] = await Promise.all([s.sync(), s.sync()]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.data, b.data]));
  assert.equal(s.count(), 1500);
});

test('preview reads only the first part and says so; it changes nothing', async (t) => {
  const s = await setup(t, 2600, { DATA_SOURCE_BATCH_SIZE: '500' });
  const r = await s.w.owner.api(`company/data-sources/${s.id}/preview`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.truncated, true);
  assert.ok(r.data.total >= 2000 && r.data.total < 2600);
  assert.equal(s.count(), 0, 'a preview never writes');
});

test('a source error part-way leaves the records already imported and reports the failure', async (t) => {
  const s = await setup(t, 400, { DATA_SOURCE_BATCH_SIZE: '100' });
  const db = new Database(s.file);
  db.exec("INSERT INTO kb VALUES('000999','Bad row',NULL,NULL,NULL)");
  db.close();
  const r = await s.sync();
  assert.equal(r.status, 200, 'a bad row is counted as invalid, not a failure of the whole run');
  assert.equal(r.data.result.invalid, 1);
  assert.equal(r.data.result.inserted, 400);
});
