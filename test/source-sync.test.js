// Resumable, bounded, incremental sync: checkpoints, failures, cancellation, leases, scheduler fairness and large imports.
// Every database here is a local temporary SQLite file or an injected mock driver; no network and no real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { world } from './_helpers.js';
import { createDataSources } from '../server/data-sources.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', updatedAt: 'updated_at' }, diagnostics: {} };
const rowOf = (i, extra = {}) => ({ id: 'K-' + String(i).padStart(6, '0'), title: `Fix number ${i} for device ${i}`, symptoms: `Symptom ${i} appears after update ${i}`, steps: `Open settings page ${i} then restart the device and check again.`, updated_at: '2026-01-01T00:00:00.000Z', ...extra });

async function sqliteWorld(t, { rows = 0, config = {}, make = rowOf } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = join(dir, 'kb.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE solutions(id TEXT PRIMARY KEY, title TEXT, symptoms TEXT, steps TEXT, updated_at TEXT)');
  const insert = db.prepare('INSERT INTO solutions VALUES(@id,@title,@symptoms,@steps,@updated_at)');
  db.transaction(() => { for (let i = 1; i <= rows; i++) insert.run(make(i)); })();
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const w = await world(t, { config: { DATA_SOURCE_SQLITE_DIRS: dir, DATA_SOURCE_BATCH_SIZE: '50', ...config } });
  const bot = w.botOf(w.company);
  const save = (body = {}) => w.owner.api('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: bot, name: 'KB', fieldMapping: MAPPING, connection: { path: file, table: 'solutions' }, declaredVerified: true, ...body });
  const created = (await save({ authoritativeSnapshot: true })).data.source;
  const sync = async (body = {}) => w.owner.api(`company/data-sources/${created.id}/sync`, { confirmed: true, ...body });
  const pool = (where = '1=1', ...args) => w.db().prepare(`SELECT * FROM memory_pool WHERE source_id=? AND ${where}`).all(created.id, ...args);
  const source = () => w.db().prepare('SELECT * FROM company_data_sources WHERE id=?').get(created.id);
  return { w, db, dir, file, bot, save, created, sync, pool, source, id: created.id };
}

test('a large import is bounded per batch, resumes across runs, and accounts for every record', async (t) => {
  // 6,000 rows, 50 per batch, 1,000 per run: six resumed runs. The ledger must add up exactly.
  const s = await sqliteWorld(t, { rows: 6000, config: { DATA_SOURCE_MAX_RECORDS: '1000' } });
  const before = process.memoryUsage().heapUsed;
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const r = await s.sync();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    runs.push(r.data.result);
    if (!r.data.result.deferred) break;
    assert.equal(s.source().status, 'deferred');
    assert.ok(s.source().sync_checkpoint_json, 'progress is stored durably between runs');
    assert.equal(s.source().last_synced_at, null, 'a partial run is not a completed sync');
  }
  assert.equal(runs.length, 6, 'six bounded runs, no run silently truncated');
  assert.ok(runs.slice(0, -1).every((r) => r.deferred && r.processed === 1000 && /Nothing was dropped/.test(r.warning)));
  assert.ok(runs.every((r) => r.maxBatchRows <= 50), 'no step ever held more than one batch of rows');
  assert.equal(runs.reduce((n, r) => n + r.inserted, 0), 6000, 'inserted across runs equals the source');
  assert.equal(runs.reduce((n, r) => n + r.duplicates + r.invalid, 0), 0);
  assert.equal(s.pool().length, 6000);
  assert.equal(new Set(s.pool().map((r) => r.external_record_id)).size, 6000, 'no duplicates');
  assert.equal(s.source().status, 'ok');
  assert.equal(s.source().sync_checkpoint_json, null, 'the checkpoint is cleared when the scan finishes');
  assert.ok(runs.at(-1).snapshot === 'complete');
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;
  assert.ok(grew < 400, `heap grew ${grew.toFixed(0)} MB; sync memory must not scale with the number of records`);
  const runsApi = (await s.w.owner.api(`company/data-sources/${s.id}/runs`)).data.runs;
  assert.equal(runsApi.length, 6);
  assert.equal(runsApi[0].status, 'completed');
  assert.equal(runsApi.filter((r) => r.resumed).length, 5, 'five of the six runs resumed an earlier one');
});

// A tiny in-memory PostgreSQL that understands the keyset pages this application issues, and can be told to fail.
function fakePg(rows, { failOnCall = null } = {}) {
  const state = { calls: 0, queries: [], rows };
  class Client {
    async connect() {}
    async end() {}
    async query(text, params = []) {
      state.calls++;
      state.queries.push({ text, params });
      if (state.calls === failOnCall) throw new Error('connection reset by peer');
      const limit = Number(/LIMIT (\d+)/.exec(text)[1]);
      const after = params[0];
      return { rows: state.rows.filter((r) => after === undefined || r.id > after).sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, limit) };
    }
  }
  return { state, drivers: { postgres: { Client } } };
}
const PG = { DATA_SOURCE_POSTGRES_DRIVER: 'pg', DATA_SOURCE_POSTGRES_HOSTS: '93.184.216.34', DATA_SOURCE_BATCH_SIZE: '50', DATA_SOURCE_RETRY_BASE_MS: '1' };

test('a failure mid-scan keeps committed progress, never retires anything, is reported as an error, and the retry resumes without duplicates', async (t) => {
  const w = await world(t, { config: PG });
  const source = (await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'postgres', chatbotId: w.botOf(w.company), name: 'PG', authoritativeSnapshot: true, declaredVerified: true, fieldMapping: MAPPING, connection: { uri: 'postgres://u:p@93.184.216.34/kb', table: 'solutions' } })).data.source;
  const all = Array.from({ length: 200 }, (_, i) => rowOf(i + 1));
  const good = fakePg(all);
  const ds = (fake) => createDataSources(w.h.store, w.h.delivery, PG, { drivers: fake.drivers, sleepFn: async () => {} });
  const count = (where = '1=1') => w.db().prepare(`SELECT COUNT(*) n FROM memory_pool WHERE source_id=? AND ${where}`).get(source.id).n;
  assert.equal((await ds(good).sync(w.company, source.id, 't')).inserted, 200);
  const row = () => w.db().prepare('SELECT * FROM company_data_sources WHERE id=?').get(source.id);
  const completedAt = row().last_synced_at;
  // The source loses two records, then the database drops the connection on its third page.
  const remaining = all.filter((r) => !['K-000010', 'K-000020'].includes(r.id));
  const flaky = fakePg(remaining, { failOnCall: 3 });
  await assert.rejects(ds(flaky).sync(w.company, source.id, 't'), /query failed/);
  assert.equal(row().status, 'error');
  assert.ok(row().last_error);
  assert.equal(row().last_synced_at, completedAt, 'the failed run did not change when the source last completed');
  assert.equal(count("status='retired'"), 0, 'a failed run retires nothing, even though two records are really gone');
  assert.equal(JSON.parse(row().sync_checkpoint_json).scanProcessed, 100, 'two committed batches are kept');
  const shown = (await w.owner.api('company/data-sources')).data.sources[0];
  assert.equal(shown.freshness.state, 'error');
  assert.equal(shown.consecutiveFailures, 1);
  assert.equal(shown.recentRuns[0].status, 'failed');
  // Retrying resumes after the committed pages, finishes the scan, and only now reconciles.
  const retried = fakePg(remaining);
  const result = await ds(retried).sync(w.company, source.id, 't');
  assert.equal(result.resumedFrom, 100);
  assert.equal(result.processed, 98, 'only what was left of the table was read');
  assert.equal(result.snapshot, 'complete');
  assert.equal(result.retiredFromSource, 2);
  assert.equal(count(), 200, 'no record lost or duplicated');
  assert.equal(row().status, 'ok');
  assert.equal(row().consecutive_failures, 0);
  assert.equal(retried.state.queries[0].params[0], 'K-000102', 'the resumed read starts after the last committed id (a keyset, not an offset)');
});

test('MySQL/MariaDB and SQL Server sources use their own dialects, read-only sessions and the same checkpoints (mock drivers)', async (t) => {
  const CFG = { DATA_SOURCE_MYSQL_DRIVER: 'mysql2', DATA_SOURCE_MYSQL_HOSTS: '93.184.216.34', DATA_SOURCE_MSSQL_DRIVER: 'mssql', DATA_SOURCE_MSSQL_HOSTS: '93.184.216.34', DATA_SOURCE_BATCH_SIZE: '50' };
  const w = await world(t, { config: CFG });
  const bot = w.botOf(w.company);
  const all = Array.from({ length: 120 }, (_, i) => rowOf(i + 1));
  const log = { mysql: [], mssql: [] };
  const mysql = {
    createConnection: async (options) => {
      log.mysql.push(['connect', options.host, options.ssl?.servername]);
      return {
        async query(arg) {
          if (typeof arg === 'string') { log.mysql.push(['session', arg]); return [[]]; }
          log.mysql.push(['select', arg.sql, arg.values]);
          const after = arg.values[0];
          return [all.filter((r) => after === undefined || r.id > after).slice(0, 50)];
        },
        async end() {},
      };
    },
  };
  const mssql = {
    ConnectionPool: class {
      constructor(o) { log.mssql.push(['pool', o.server, o.options.readOnlyIntent, o.options.encrypt, o.options.trustServerCertificate]); }
      async connect() {}
      request() {
        const bound = [];
        return {
          input: (n, v) => bound.push([n, v]),
          query: async (text) => { log.mssql.push(['select', text, bound.map((b) => b[1])]); const after = bound[0]?.[1]; return { recordset: all.filter((r) => after === undefined || r.id > after).slice(0, 50) }; },
        };
      }
      async close() {}
    },
  };
  const mk = async (sourceType, uri) => (await w.owner.api('company/data-sources', { confirmed: true, sourceType, chatbotId: bot, name: sourceType, declaredVerified: true, fieldMapping: MAPPING, connection: { uri, table: 'solutions', schema: 'kb' } })).data.source;
  const my = await mk('mysql', 'mysql://reader:pw@93.184.216.34/kb');
  const ms = await mk('mssql', 'sqlserver://reader:pw@93.184.216.34/kb');
  assert.ok(my && ms, 'both source types can be saved');
  const ds = createDataSources(w.h.store, w.h.delivery, CFG, { drivers: { mysql, mssql }, sleepFn: async () => {} });
  assert.equal((await ds.sync(w.company, my.id, 't')).inserted, 120);
  assert.equal((await ds.sync(w.company, ms.id, 't')).processed, 120);
  assert.deepEqual(log.mysql[0].slice(0, 2), ['connect', '93.184.216.34']);
  assert.deepEqual(log.mysql[1], ['session', 'SET SESSION TRANSACTION READ ONLY'], 'the MySQL session is read-only before anything is read');
  const sel = log.mysql.filter((x) => x[0] === 'select');
  assert.equal(sel[0][1], 'SELECT `id`,`title`,`symptoms`,`steps`,`updated_at` FROM `kb`.`solutions` ORDER BY `id` LIMIT 50');
  assert.equal(sel[1][1], 'SELECT `id`,`title`,`symptoms`,`steps`,`updated_at` FROM `kb`.`solutions` WHERE `id` > ? ORDER BY `id` LIMIT 50');
  assert.deepEqual(sel[1][2], ['K-000050'], 'values are bound, never inlined');
  assert.deepEqual(log.mssql[0].slice(2), [true, true, false], 'SQL Server: read-only intent, TLS on, certificate verified');
  const ssel = log.mssql.filter((x) => x[0] === 'select');
  assert.equal(ssel[0][1], 'SELECT TOP (50) [id],[title],[symptoms],[steps],[updated_at] FROM [kb].[solutions] ORDER BY [id]');
  assert.equal(ssel[1][1], 'SELECT TOP (50) [id],[title],[symptoms],[steps],[updated_at] FROM [kb].[solutions] WHERE [id] > @p1 ORDER BY [id]');
  // A host that the server owner has not allowed is refused at save time.
  const refused = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'mysql', chatbotId: bot, name: 'x', fieldMapping: MAPPING, connection: { uri: 'mysql://u:p@203.0.113.9/kb', table: 'solutions' } });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /DATA_SOURCE_MYSQL_HOSTS/);
});

test('without an installed driver or an allowed host, MySQL and SQL Server are reported as configuration-required, never faked', async (t) => {
  const w = await world(t, {});
  const list = (await w.owner.api('company/data-sources')).data;
  assert.equal(list.availability.mysql.available, false);
  assert.match(list.availability.mysql.reason, /mysql2/);
  assert.equal(list.availability.mssql.available, false);
  assert.match(list.availability.mssql.reason, /mssql/);
});

test('a scan paused and resumed any number of times retires withdrawn records only once it reaches the end', async (t) => {
  const s = await sqliteWorld(t, { rows: 300, config: { DATA_SOURCE_MAX_RECORDS: '100' } });
  for (let i = 0; i < 6; i++) { const r = (await s.sync()).data.result; if (!r.deferred) break; }
  assert.equal(s.pool().length, 300);
  s.db.prepare("DELETE FROM solutions WHERE id IN ('K-000005','K-000150','K-000299')").run();
  const first = (await s.sync()).data.result;
  assert.equal(first.deferred, true);
  assert.equal(s.pool("status='retired'").length, 0, 'a paused scan has not seen the whole source and retires nothing');
  const second = (await s.sync()).data.result;
  assert.equal(second.deferred, true);
  assert.equal(s.pool("status='retired'").length, 0);
  const third = (await s.sync()).data.result;
  assert.equal(third.deferred, undefined);
  assert.equal(third.snapshot, 'complete');
  assert.equal(third.retiredFromSource, 3, 'the scan that reached the end across three runs reconciles');
  assert.deepEqual(s.pool("status='retired'").map((r) => r.external_record_id).sort(), ['K-000005', 'K-000150', 'K-000299']);
  const events = s.w.db().prepare("SELECT kind FROM knowledge_events WHERE source_id=? AND kind='withdrawn'").all(s.id);
  assert.equal(events.length, 3, 'each withdrawal is in the audit trail');
});

test('incremental sync reads only changed rows from a durable high-water mark, handling ties, late arrivals and updates', async (t) => {
  const s = await sqliteWorld(t, { rows: 120, make: (i) => rowOf(i, { updated_at: `2026-02-01T10:${String(i % 60).padStart(2, '0')}:00.000Z` }) });
  assert.equal((await s.save({ id: s.id, incrementalEnabled: true })).status, 200);
  const first = (await s.sync()).data.result;
  assert.equal(first.mode, 'full');
  assert.match(first.modeReason, /No high-water mark/);
  assert.ok(JSON.parse(s.source().high_water_json).v.startsWith('2026-02-01T10:59'), 'the full read seeds the high-water mark');
  // Nothing changed: an incremental run re-reads only the rows at the mark (ties), changes nothing.
  const quiet = (await s.sync()).data.result;
  assert.equal(quiet.mode, 'incremental');
  assert.ok(quiet.processed <= 5, `only the tie at the mark is re-read, not the table (read ${quiet.processed})`);
  assert.equal(quiet.inserted + quiet.updated, 0);
  assert.equal(quiet.snapshot, 'incremental');
  // An update, a brand new row, and a late arrival that shares the high-water timestamp but sorts before the last id.
  s.db.prepare("UPDATE solutions SET steps='Replace the cable, then restart the device twice.', updated_at='2026-02-01T11:30:00.000Z' WHERE id='K-000007'").run();
  s.db.prepare('INSERT INTO solutions VALUES(?,?,?,?,?)').run('K-000500', 'Brand new fix', 'A brand new symptom appears', 'Do the new thing then restart the device.', '2026-02-01T11:31:00.000Z');
  s.db.prepare('INSERT INTO solutions VALUES(?,?,?,?,?)').run('K-000001a', 'Late arrival fix', 'A late symptom appears', 'Do the late thing then restart the device.', '2026-02-01T10:59:00.000Z');
  const inc = (await s.sync()).data.result;
  assert.equal(inc.mode, 'incremental');
  assert.equal(inc.inserted, 2, 'the new row and the late arrival tied with the mark are both picked up');
  assert.equal(inc.updated, 1);
  assert.ok(inc.processed < 20, 'still a handful of rows, not the table');
  assert.match(JSON.parse(s.source().high_water_json).v, /11:31/);
  assert.equal(s.pool("status='retired'").length, 0, 'an incremental run never retires (it cannot see deletions)');
  // A full re-sync on request is a full scan and says so.
  s.db.prepare("DELETE FROM solutions WHERE id='K-000002'").run();
  const full = (await s.sync({ mode: 'full' })).data.result;
  assert.equal(full.mode, 'full');
  assert.equal(full.retiredFromSource, 1);
});

test('without a reliable change signal a sync is labelled full and incremental cannot be requested', async (t) => {
  const s = await sqliteWorld(t, { rows: 10 });
  await s.save({ id: s.id, incrementalEnabled: true, fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} } });
  const r = (await s.sync()).data.result;
  assert.equal(r.mode, 'full');
  assert.match(r.modeReason, /Map the “Last updated” column/);
  const refused = await s.sync({ mode: 'incremental' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /not available/);
  const view = (await s.w.owner.api('company/data-sources')).data.sources[0];
  assert.equal(view.incremental.supported, false);
});

test('cancel stops at a batch boundary and discards progress; pause keeps it; neither completes or retires', async (t) => {
  const s = await sqliteWorld(t, { rows: 400 });
  // Stop the run from inside the first batch by queueing the request as soon as the first checkpoint lands.
  const watch = setInterval(() => { if (s.source().sync_checkpoint_json) s.w.db().prepare("UPDATE company_data_sources SET stop_request='cancel' WHERE id=?").run(s.id); }, 1);
  const r = (await s.sync()).data.result;
  clearInterval(watch);
  assert.equal(r.cancelled, true);
  assert.ok(r.processed < 400, 'it stopped part-way');
  assert.equal(s.source().status, 'cancelled');
  assert.equal(s.source().sync_checkpoint_json, null, 'cancel abandons saved progress');
  assert.equal(s.source().last_synced_at, null, 'a cancelled run is not a completed sync');
  assert.equal(s.pool("status='retired'").length, 0);
  // Pausing a source that is idle keeps its state; it cannot sync until resumed.
  const paused = await s.w.owner.api(`company/data-sources/${s.id}/pause`, { confirmed: true });
  assert.equal(paused.status, 200);
  assert.equal((await s.sync()).status, 409);
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/resume`, { confirmed: true })).status, 200);
  const done = (await s.sync()).data.result;
  assert.equal(done.snapshot, 'complete');
  assert.equal(s.pool().length, 400);
});

test('one run per source at a time: an overlapping or replayed sync is refused, and a crashed run is resumed after its lease expires', async (t) => {
  const s = await sqliteWorld(t, { rows: 120 });
  const first = s.sync();
  const overlap = await s.sync();
  assert.equal(overlap.status, 409);
  assert.match(overlap.data.error, /already running/);
  assert.equal((await first).status, 200);
  // Replaying the whole job is idempotent: nothing is duplicated.
  const replay = (await s.sync()).data.result;
  assert.equal(replay.inserted, 0);
  assert.equal(replay.unchanged, 120);
  assert.equal(s.pool().length, 120);
  // A worker that died mid-run leaves status=syncing with an expired lease and a checkpoint: the next run resumes from it.
  s.w.db().prepare("UPDATE company_data_sources SET status='syncing',lease_until=1,sync_checkpoint_json=? WHERE id=?").run(JSON.stringify({ mode: 'full', scan: 99, pos: { after: { id: { t: 's', v: 'K-000060' } } }, processed: 60, scanProcessed: 60, scanInvalid: 0, hw: null }), s.id);
  const resumed = (await s.sync()).data.result;
  assert.equal(resumed.resumedFrom, 60);
  assert.equal(resumed.processed, 60, 'only the rest of the table was read');
  assert.equal(s.source().status, 'ok');
});

test('the scheduler is fair across companies, bounded in concurrency, backs off failures, and never runs what an owner did not schedule', async (t) => {
  const s = await sqliteWorld(t, { rows: 20, config: { DATA_SOURCE_SCHEDULER_PER_TICK: '3', DATA_SOURCE_SCHEDULER_CONCURRENCY: '2' } });
  assert.deepEqual(await s.w.h.dataSources.runDue(Date.now() + 99 * 3600000), [], 'a source with no interval is manual only');
  const HOUR = 3600000;
  // Company A gets three scheduled sources, company B one: B must not be starved by A's backlog.
  const mk = (client, company, name) => client.api('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: company + ':repair', name, fieldMapping: MAPPING, connection: { path: s.file, table: 'solutions' }, syncIntervalHours: 1 });
  const a1 = (await mk(s.w.owner, s.w.company, 'A1')).data.source, a2 = (await mk(s.w.owner, s.w.company, 'A2')).data.source, a3 = (await mk(s.w.owner, s.w.company, 'A3')).data.source;
  const b1 = await mk(s.w.other, s.w.companyB, 'B1');
  assert.equal(b1.status, 201);
  void a1; void a2; void a3;
  const tick = await s.w.h.dataSources.runDue(Date.now() + 2 * HOUR);
  assert.equal(tick.length, 3, 'the per-tick cap bounds the work');
  assert.ok(tick.some((r) => r.companyId === s.w.companyB), 'company B ran in the same tick as company A');
  assert.ok(tick.every((r) => r.status === 'ok'));
  // A failing source backs off but is retried before its full interval; the failure is recorded and visible.
  const broken = (await mk(s.w.owner, s.w.company, 'Broken')).data.source;
  s.w.db().prepare("UPDATE company_data_sources SET encrypted_connection_uri=(SELECT encrypted_connection_uri FROM company_data_sources WHERE id=?) , next_sync_at=? WHERE id=?").run(broken.id, new Date(Date.now() - 1000).toISOString(), broken.id);
  const bad = await s.w.owner.api('company/data-sources', { confirmed: true, id: broken.id, connection: { table: 'missing_table' } });
  assert.equal(bad.status, 200);
  s.w.db().prepare('UPDATE company_data_sources SET next_sync_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), broken.id);
  const failed = (await s.w.h.dataSources.runDue(Date.now())).find((r) => r.id === broken.id);
  assert.equal(failed.status, 'error');
  assert.ok(failed.retryInMinutes <= 60, 'retried within the interval, not skipped for a whole interval');
  const view = (await s.w.owner.api('company/data-sources')).data.sources.find((x) => x.id === broken.id);
  assert.equal(view.freshness.state, 'error');
  assert.ok(view.consecutiveFailures >= 1);
});
