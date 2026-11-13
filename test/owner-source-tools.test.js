import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { world } from './_helpers.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'env' }, diagnostics: {} };
const row = (i) => ({ id: 'r' + String(i).padStart(4, '0'), title: `Fix ${i} for gadget ${i}`, symptoms: `Gadget ${i} shows error E${i}`, steps: `Open the gadget ${i} menu and choose reset ${i}, then restart.`, env: 'Model X firmware 4' });

async function sqliteSource(t, n = 30) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'kb.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE kb(id TEXT, title TEXT, symptoms TEXT, steps TEXT, env TEXT)');
  const ins = db.prepare('INSERT INTO kb VALUES(?,?,?,?,?)');
  for (let i = 0; i < n; i++) { const r = row(i); ins.run(r.id, r.title, r.symptoms, r.steps, r.env); }
  db.close();
  const w = await world(t, { config: { DATA_SOURCE_SQLITE_DIRS: dir } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: w.botOf(w.company), name: 'KB', fieldMapping: MAPPING, connection: { path: file, table: 'kb' }, declaredVerified: true, syncIntervalHours: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { w, file, id: created.data.source.id, count: () => w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_id=?").get(created.data.source.id).n };
}

test('connection test: reads one small batch, changes nothing, and never echoes the connection', async (t) => {
  const s = await sqliteSource(t);
  const r = await s.w.owner.api(`company/data-sources/${s.id}/test`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.firstBatchRows, 30);
  assert.deepEqual(r.data.columns.sort(), ['env', 'id', 'steps', 'symptoms', 'title']);
  assert.ok(!JSON.stringify(r.data).includes(s.file), 'the file path is not echoed');
  assert.equal(s.count(), 0, 'a test saves nothing');
  const view = (await s.w.owner.api('company/data-sources')).data.sources.find((x) => x.id === s.id);
  assert.equal(view.lastSyncedAt, null, 'and does not look like a sync');
});

test('connection test: owner only, company-scoped, and failures are reported without secrets', async (t) => {
  const s = await sqliteSource(t);
  const cust = await s.w.customer('alice');
  assert.equal((await cust.api(`company/data-sources/${s.id}/test`, {})).status, 403);
  assert.equal((await s.w.other.api(`company/data-sources/${s.id}/test`, {})).status, 404);
  new Database(s.file).exec('DROP TABLE kb'); // the source breaks
  const broken = await s.w.owner.api(`company/data-sources/${s.id}/test`, {});
  assert.ok(broken.status >= 400, String(broken.status));
  assert.ok(!JSON.stringify(broken.data).includes(s.file));
});

test('pause and resume: a paused source does not sync, by hand or on its schedule, and resumes cleanly', async (t) => {
  const s = await sqliteSource(t);
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/pause`, {})).status, 400, 'needs confirmation');
  const paused = await s.w.owner.api(`company/data-sources/${s.id}/pause`, { confirmed: true });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.source.paused, true);
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/sync`, { confirmed: true })).status, 409);
  assert.deepEqual(await s.w.h.dataSources.runDue(Date.now() + 3 * 3600000), [], 'the schedule skips it');
  assert.equal(s.count(), 0);
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/resume`, { confirmed: true })).data.source.paused, false);
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/resume`, { confirmed: true })).status, 409, 'not paused any more');
  assert.equal((await s.w.owner.api(`company/data-sources/${s.id}/sync`, { confirmed: true })).status, 200);
  assert.equal(s.count(), 30);
  const cust = await s.w.customer('bob');
  assert.equal((await cust.api(`company/data-sources/${s.id}/pause`, { confirmed: true })).status, 403);
});

/** A tiny page-numbered JSON API: GET /kb?page=N&limit=M returns M records of `total`, then an empty list. */
async function pagedApi(total, seen) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const page = Number(u.searchParams.get('page')), size = Number(u.searchParams.get('limit')) || 25;
    seen.push([page, size, req.headers.authorization]);
    const list = []; for (let i = (page - 1) * size; i < Math.min(total, page * size); i++) list.push(row(i));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: list }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

test('REST sources can be paged by page number: every page is read, the host never changes, the token stays server-side', async (t) => {
  const seen = [];
  const { server, origin } = await pagedApi(130, seen);
  t.after(() => new Promise((r) => server.close(r)));
  const w = await world(t, { config: { DATA_SOURCE_ALLOWED_ORIGINS: origin, DATA_SOURCE_ALLOW_LOOPBACK: 'true' } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: w.botOf(w.company), name: 'Paged', fieldMapping: MAPPING, connection: { url: origin + '/kb', recordsPath: 'data', pageParam: 'page', pageSize: '50', token: 'tok-secret' }, declaredVerified: true });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const r = await w.owner.api(`company/data-sources/${created.data.source.id}/sync`, { confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.result.inserted, 130, 'all 130 records across three pages');
  assert.deepEqual(seen.map((x) => x[0]), [1, 2, 3, 4], 'pages 1 to 3, then the empty page that ends it');
  assert.ok(seen.every((x) => x[1] === 50 && x[2] === 'Bearer tok-secret'));
  assert.ok(!JSON.stringify(r.data).includes('tok-secret'));
});

test('a REST source that hits the per-run limit pauses and resumes at the right page', async (t) => {
  const seen = [];
  const { server, origin } = await pagedApi(300, seen);
  t.after(() => new Promise((r) => server.close(r)));
  const w = await world(t, { config: { DATA_SOURCE_ALLOWED_ORIGINS: origin, DATA_SOURCE_ALLOW_LOOPBACK: 'true', DATA_SOURCE_MAX_RECORDS: '100' } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: w.botOf(w.company), name: 'Paged', fieldMapping: MAPPING, connection: { url: origin + '/kb', recordsPath: 'data', pageParam: 'page', pageSize: '50' }, declaredVerified: true });
  const id = created.data.source.id;
  const sync = () => w.owner.api(`company/data-sources/${id}/sync`, { confirmed: true });
  const first = (await sync()).data.result;
  assert.equal(first.deferred, true);
  assert.equal(first.processed, 100);
  seen.length = 0;
  const second = (await sync()).data.result;
  assert.equal(second.resumedFrom, 100);
  assert.equal(seen[0][0], 3, 'resumed at page 3, not page 1');
  assert.ok(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE source_id=?').get(id).n >= 200);
});
