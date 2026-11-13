// REST pagination styles, retries and rate limits, streamed CSV files, credential masking on edit, and tenant isolation of every source operation.
// Local HTTP servers and temporary files only; tokens and passwords below are dummy values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world } from './_helpers.js';
import { csvRecords, sliceString, buildPageQuery, linkHeaderNext, CsvParser } from '../server/source-adapters.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', updatedAt: 'updated_at' }, diagnostics: {} };
const rowOf = (i, extra = {}) => ({ id: 'R-' + String(i).padStart(5, '0'), title: `Fix number ${i} for device ${i}`, symptoms: `Symptom ${i} appears after update ${i}`, steps: `Open settings page ${i} then restart the device and check again.`, updated_at: '2026-03-01T00:00:00.000Z', ...extra });
const DATA = Array.from({ length: 95 }, (_, i) => rowOf(i + 1));

/** A local JSON API. `route(url, req, hits)` returns [status, body, headers] and every request is recorded. */
async function api(t, route) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });
    const [status = 200, body = {}, headers = {}] = route(url, req, hits) || [];
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, server };
}
async function restWorld(t, serverApi, connection, { config = {}, extra = {} } = {}) {
  const w = await world(t, { config: { DATA_SOURCE_ALLOWED_ORIGINS: serverApi.origin, DATA_SOURCE_ALLOW_LOOPBACK: 'true', DATA_SOURCE_RETRY_BASE_MS: '1', ...config } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: w.botOf(w.company), name: 'REST', fieldMapping: MAPPING, declaredVerified: true, authoritativeSnapshot: true, connection: { url: serverApi.origin + '/kb', recordsPath: 'data', ...connection }, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.source.id;
  const sync = (body = {}) => w.owner.api(`company/data-sources/${id}/sync`, { confirmed: true, ...body });
  const pool = (where = '1=1') => w.db().prepare(`SELECT * FROM memory_pool WHERE source_id=? AND ${where}`).all(id);
  const source = () => w.db().prepare('SELECT * FROM company_data_sources WHERE id=?').get(id);
  return { w, id, sync, pool, source };
}

test('REST offset paging reads every record and stops on the first empty page', async (t) => {
  const a = await api(t, (url) => { const o = Number(url.searchParams.get('offset') || 0), l = Number(url.searchParams.get('limit')); return [200, { data: DATA.slice(o, o + l) }]; });
  const s = await restWorld(t, a, { pagination: 'offset', pageSize: '40' });
  const r = await s.sync();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.result.inserted, 95);
  assert.deepEqual(a.hits.map((h) => h.query.offset), ['0', '40', '80', '95']);
});

test('REST cursor paging follows the cursor in the response, and a repeated cursor is an error, not an endless loop', async (t) => {
  const a = await api(t, (url) => {
    const c = url.searchParams.get('after');
    if (url.searchParams.get('loop')) return [200, { data: DATA.slice(0, 10), meta: { next: 'same' } }];
    const start = c ? Number(c) : 0;
    return [200, { data: DATA.slice(start, start + 30), meta: { next: start + 30 < DATA.length ? String(start + 30) : null } }];
  });
  const s = await restWorld(t, a, { pagination: 'cursor', cursorParam: 'after', nextCursorPath: 'meta.next', pageSize: '30' });
  const r = await s.sync();
  assert.equal(r.data.result.inserted, 95);
  assert.deepEqual(a.hits.map((h) => h.query.after ?? null), [null, '30', '60', '90'], 'the cursor, not a page number, drives the read');
  // A server that keeps handing back the same cursor.
  const looping = await api(t, () => [200, { data: DATA.slice(0, 10), meta: { next: 'same' } }]);
  const l = await restWorld(t, looping, { pagination: 'cursor', cursorParam: 'after', nextCursorPath: 'meta.next' });
  const failed = await l.sync();
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /same cursor twice/);
  assert.equal(l.source().status, 'error');
});

test('REST next-link paging (in the body or a Link header) follows only links that stay on the configured website', async (t) => {
  const a = await api(t, (url, req) => {
    const p = Number(url.searchParams.get('p') || 1);
    const next = p < 3 ? `${req.headers.host ? 'http://' + req.headers.host : ''}/kb?p=${p + 1}` : null;
    return [200, { data: DATA.slice((p - 1) * 40, p * 40), links: { next } }, next ? { link: `<${next}>; rel="next"` } : {}];
  });
  const body = await restWorld(t, a, { pagination: 'next_link', nextLinkPath: 'links.next' });
  assert.equal((await body.sync()).data.result.inserted, 95);
  assert.equal(a.hits.length, 3);
  const before = a.hits.length;
  const header = await restWorld(t, a, { pagination: 'next_link', nextLinkPath: 'header:link' });
  assert.equal((await header.sync()).data.result.inserted, 95);
  assert.equal(a.hits.length - before, 3);
  // A next link that points at another website is never requested.
  const elsewhere = await api(t, () => [200, { data: [] }]);
  const evil = await api(t, () => [200, { data: DATA.slice(0, 5), links: { next: elsewhere.origin + '/steal' } }]);
  const e = await restWorld(t, evil, { pagination: 'next_link', nextLinkPath: 'links.next' });
  const r = await e.sync();
  assert.equal(r.status, 502);
  assert.match(r.data.error, /different website/);
  assert.equal(elsewhere.hits.length, 0, 'the other website received no request');
  assert.equal(e.source().status, 'error');
  assert.equal(e.pool("status='retired'").length, 0);
  assert.deepEqual(linkHeaderNext('<https://x.test/a?p=2>; rel="next", <https://x.test/a?p=9>; rel="last"'), 'https://x.test/a?p=2');
});

test('rate limits and server errors are retried a bounded number of times, honouring Retry-After; an absurd wait stops the sync with a resumable error', async (t) => {
  let n = 0;
  const flaky = await api(t, () => (++n <= 2 ? [429, { error: 'slow down' }, { 'retry-after': '0' }] : [200, { data: DATA.slice(0, 10) }]));
  const ok = await restWorld(t, flaky, {});
  assert.equal((await ok.sync()).data.result.inserted, 10, 'two 429 answers, then success');
  assert.equal(flaky.hits.length, 3);
  const down = await api(t, () => [503, { error: 'down' }]);
  const d = await restWorld(t, down, {}, { config: { DATA_SOURCE_RETRIES: '3' } });
  const failed = await d.sync();
  assert.equal(failed.status, 503);
  assert.equal(down.hits.length, 3, 'exactly DATA_SOURCE_RETRIES attempts, never an unbounded loop');
  assert.match(failed.data.error, /after 3 attempts/);
  const limited = await api(t, () => [429, {}, { 'retry-after': '3600' }]);
  const l = await restWorld(t, limited, {}, { config: { DATA_SOURCE_MAX_RETRY_AFTER_MS: '1000' } });
  const refused = await l.sync();
  assert.equal(refused.status, 429);
  assert.match(refused.data.error, /limiting requests/);
  assert.equal(limited.hits.length, 1, 'a long Retry-After is reported, not slept through');
});

test('a REST sync that fails on page 3 resumes at page 3, not page 1, and an oversized response is refused', async (t) => {
  let broken = true;
  const a = await api(t, (url) => {
    const p = Number(url.searchParams.get('page'));
    if (p === 3 && broken) return [500, {}];
    return [200, { data: DATA.slice((p - 1) * 30, p * 30) }];
  });
  const s = await restWorld(t, a, { pagination: 'page', pageParam: 'page', pageSize: '30' }, { config: { DATA_SOURCE_RETRIES: '1' } });
  assert.equal((await s.sync()).status, 503);
  assert.equal(s.pool().length, 60, 'the two good pages were committed');
  assert.equal(s.pool("status='retired'").length, 0);
  broken = false;
  a.hits.length = 0;
  const r = (await s.sync()).data.result;
  assert.equal(r.resumedFrom, 60);
  assert.deepEqual(a.hits.map((h) => h.query.page), ['3', '4', '5'], 'pages 1 and 2 were not read again; the empty page 5 ends the read');
  assert.equal(s.pool().length, 95);
  const big = await api(t, () => [200, JSON.stringify({ data: [{ ...rowOf(1), steps: 'x'.repeat(200000) }] })]);
  const b = await restWorld(t, big, {}, { config: { DATA_SOURCE_MAX_RESPONSE_BYTES: '65536' } });
  const tooBig = await b.sync();
  assert.equal(tooBig.status, 413);
  assert.equal(b.pool().length, 0);
});

test('REST incremental sync sends the high-water mark in the API’s “modified since” parameter and says so', async (t) => {
  const stamp = (i) => `2026-03-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`;
  const rows = Array.from({ length: 60 }, (_, i) => rowOf(i + 1, { updated_at: stamp(i) }));
  const a = await api(t, (url) => { const since = url.searchParams.get('since'); return [200, { data: rows.filter((r) => !since || r.updated_at >= since) }]; });
  const s = await restWorld(t, a, { sinceParam: 'since' }, { extra: { incrementalEnabled: true } });
  const full = (await s.sync()).data.result;
  assert.equal(full.mode, 'full');
  assert.equal(a.hits[0].query.since, undefined);
  rows.push(rowOf(61, { updated_at: '2026-03-01T11:30:00.000Z' }));
  const inc = (await s.sync()).data.result;
  assert.equal(inc.mode, 'incremental');
  assert.ok(a.hits.at(-1).query.since >= '2026-03-01T10:5', 'the mark from the last full read was sent');
  assert.equal(inc.inserted, 1);
  assert.ok(inc.processed <= 3, `only rows at or after the mark were read (${inc.processed})`);
  // Without the parameter the same API can only be a full read, and says so.
  const plain = await restWorld(t, a, {});
  await plain.sync();
  const view = (await plain.w.owner.api('company/data-sources')).data.sources[0];
  assert.equal(view.incremental.supported, false);
  assert.match(view.incremental.reason, /modified since/);
});

// --------------------------------------------------------------------------- CSV
test('the CSV parser is incremental: any chunking gives the same rows, line numbers are tracked, and malformed input is explained', async () => {
  const text = '﻿id,title,notes\r\nA-1,"Hello, world","line1\nline2"\r\nA-2,"say ""hi""",x\r\n\r\nA-3,short\r\nA-4,a,b,c\r\n';
  const whole = [];
  for await (const r of csvRecords(sliceString(text, 1000))) whole.push({ ...r, line: r.__line, issue: r.__issue });
  for (const size of [1, 2, 3, 7]) {
    const got = [];
    for await (const r of csvRecords(sliceString(text, size))) got.push({ ...r, line: r.__line, issue: r.__issue });
    assert.deepEqual(got, whole, `chunk size ${size}`);
  }
  assert.equal(whole[0].notes, 'line1\nline2');
  assert.equal(whole[1].title, 'say "hi"');
  assert.match(whole[2].issue, /line 6 has 2 columns but the header has 3/);
  assert.match(whole[3].issue, /line 7 has 4 columns/);
  await assert.rejects(async () => { for await (const r of csvRecords(sliceString('a,b\n1,"open\n2,3\n'))) void r; }, /unterminated quoted field starting on line 2/);
  await assert.rejects(async () => { for await (const r of csvRecords(sliceString('a,a\n1,2'))) void r; }, /must be unique/);
  await assert.rejects(async () => { for await (const r of csvRecords(sliceString('a,b\n1,2'), { requiredColumns: ['a', 'zed'] })) void r; }, /Columns not found in the CSV: zed/);
  await assert.rejects(async () => { for await (const r of csvRecords(sliceString('a\n1\n2\n3\n'), { maxRows: 2 })) void r; }, /more than 2 data rows/);
  assert.equal(new CsvParser().push('x,y\n').length, 1);
});

async function csvFileWorld(t, content, { config = {}, mapping = MAPPING } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-csv-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = join(dir, 'kb.csv');
  await writeFile(file, content);
  const w = await world(t, { config: { DATA_SOURCE_CSV_DIRS: dir, DATA_SOURCE_BATCH_SIZE: '100', ...config } });
  const created = await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_file', chatbotId: w.botOf(w.company), name: 'Big CSV', fieldMapping: mapping, declaredVerified: true, authoritativeSnapshot: true, connection: { path: file } });
  const id = created.data.source?.id;
  const sync = (body = {}) => w.owner.api(`company/data-sources/${id}/sync`, { confirmed: true, ...body });
  const pool = (where = '1=1') => w.db().prepare(`SELECT * FROM memory_pool WHERE source_id=? AND ${where}`).all(id);
  return { w, dir, file, created, id, sync, pool };
}
const csvLine = (i) => `R-${i},"Fix ${i}, with a comma","Symptom ${i}\nspans two lines","Open page ${i} then restart.",2026-03-01T00:00:00Z`;

test('a CSV file source is streamed from disk in bounded batches, resumes across runs and accounts for every row', async (t) => {
  const N = 3500;
  const body = '﻿id,title,symptoms,steps,updated_at\r\n' + Array.from({ length: N }, (_, i) => csvLine(i + 1)).join('\r\n') + '\r\n';
  const s = await csvFileWorld(t, body, { config: { DATA_SOURCE_MAX_RECORDS: '1000' } });
  assert.equal(s.created.status, 201, JSON.stringify(s.created.data));
  const runs = [];
  for (let i = 0; i < 8; i++) { const r = await s.sync(); assert.equal(r.status, 200, JSON.stringify(r.data)); runs.push(r.data.result); if (!r.data.result.deferred) break; }
  assert.equal(runs.length, 4);
  assert.equal(runs.reduce((n, r) => n + r.inserted, 0), N);
  assert.ok(runs.every((r) => r.maxBatchRows <= 100));
  assert.equal(s.pool().length, N);
  assert.equal(new Set(s.pool().map((r) => r.external_record_id)).size, N);
  assert.equal(runs.at(-1).mode, 'full');
  assert.equal(runs.at(-1).snapshot, 'complete');
  assert.equal(s.created.data.source.connection.summary.file, 'kb.csv', 'only the file name is shown');
  assert.ok(!JSON.stringify(s.created.data).includes(s.dir), 'the server path is not echoed');
});

test('CSV problems are reported explicitly: malformed rows, a missing column, invalid encoding, the row limit and paths outside the allowed folders', async (t) => {
  const bad = await csvFileWorld(t, 'id,title,symptoms,steps,updated_at\nR-1,Good,Symptom one appears,Do the thing then restart.,2026-03-01\nR-2,Short row\nR-3,Good three,Symptom three,Step three restart now.,2026-03-01\n');
  const preview = (await bad.w.owner.api(`company/data-sources/${bad.id}/preview`, {})).data;
  assert.equal(preview.total, 3);
  assert.equal(preview.invalid, 1);
  assert.match(preview.sample.find((x) => x.externalId === 'R-2').issues.join(' '), /malformed row: line 3 has 2 columns but the header has 5/);
  const run = (await bad.sync()).data.result;
  assert.equal(run.invalid, 1);
  assert.equal(run.inserted, 2, 'the good rows are imported; the bad one is counted, not silently dropped');
  const missing = await csvFileWorld(t, 'id,title,symptoms\nR-1,a,b\n');
  const r = await missing.sync();
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Columns not found in the CSV: steps, updated_at/);
  const latin = await csvFileWorld(t, Buffer.concat([Buffer.from('id,title,symptoms,steps,updated_at\nR-1,Caf'), Buffer.from([0xe9]), Buffer.from(',s,steps here now,2026\n')]));
  const enc = await latin.sync();
  assert.equal(enc.status, 400);
  assert.match(enc.data.error, /not valid UTF-8/);
  const utf16 = await csvFileWorld(t, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('id,title,symptoms,steps,updated_at\nR-1,Cafe,A symptom appears,Do the step then restart,2026\n', 'utf16le')]));
  assert.equal((await utf16.sync()).data.result.inserted, 1, 'UTF-16 with a byte-order mark is understood');
  const many = await csvFileWorld(t, 'id,title,symptoms,steps,updated_at\n' + Array.from({ length: 150 }, (_, i) => `R-${i},t,s,steps here now,2026`).join('\n'), { config: { DATA_SOURCE_CSV_MAX_ROWS: '100' } });
  const limited = await many.sync();
  assert.equal(limited.status, 413);
  assert.match(limited.data.error, /more than 100 data rows/);
  assert.equal(many.pool().length, 100, 'rows read before the limit stay committed and the limit is reported, never silent');
  const outside = await bad.w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_file', chatbotId: bad.w.botOf(bad.w.company), name: 'x', fieldMapping: MAPPING, connection: { path: join(tmpdir(), 'other.csv') } });
  assert.equal(outside.status, 400);
  assert.match(outside.data.error, /not found|not in a directory/);
});

// --------------------------------------------------------------------------- SQL builder
test('page queries are keyset-ordered, bound and identifier-validated for every dialect', () => {
  const base = { schema: 'kb', table: 'solutions', columns: ['id', 'title', 'updated_at'], idColumn: 'id', updatedColumn: 'updated_at', limit: 25 };
  const inc = buildPageQuery('postgres', { ...base, mode: 'incremental', since: { t: 's', v: '2026-01-01' } });
  assert.equal(inc.text, 'SELECT "id","title","updated_at" FROM "kb"."solutions" WHERE "updated_at" >= $1 ORDER BY "updated_at","id" LIMIT 25');
  const page = buildPageQuery('mysql', { ...base, mode: 'incremental', after: { u: { t: 's', v: '2026-01-01' }, id: { t: 's', v: 'A9' } } });
  assert.equal(page.text, 'SELECT `id`,`title`,`updated_at` FROM `kb`.`solutions` WHERE (`updated_at` > ? OR (`updated_at` = ? AND `id` > ?)) ORDER BY `updated_at`,`id` LIMIT 25');
  assert.deepEqual(page.params, ['2026-01-01', '2026-01-01', 'A9']);
  assert.throws(() => buildPageQuery('sqlite', { ...base, table: 'x"; DROP TABLE y;--' }), /plain identifiers/);
  assert.throws(() => buildPageQuery('sqlite', { ...base, columns: ['id', 'a b'] }), /plain identifiers/);
  assert.throws(() => buildPageQuery('oracle', base), /Unsupported/);
  assert.throws(() => buildPageQuery('sqlite', { ...base, limit: 'DROP' }), /batch size/);
});

// --------------------------------------------------------------------------- masking and isolation
test('editing a source never reveals stored credentials, keeps them when left blank, and a changed connection restarts saved progress', async (t) => {
  const a = await api(t, (url, req) => [200, { data: DATA.slice(0, 20) }]);
  const s = await restWorld(t, a, { token: 'dummy-token-1234' });
  const list = async () => (await s.w.owner.api('company/data-sources')).data;
  const view = (await list()).sources[0];
  const dump = JSON.stringify(await list());
  assert.ok(!dump.includes('dummy-token-1234'), 'the token is never returned');
  assert.deepEqual(view.connection.secretsSet, { url: true, token: true });
  assert.equal(view.connection.summary.endpoint, a.origin + '/kb');
  assert.equal(view.connection.settings.recordsPath, 'data');
  // Change a mapping and a non-secret setting without sending any secret: the token keeps working.
  const edited = await s.w.owner.api('company/data-sources', { confirmed: true, id: s.id, name: 'Renamed', fieldMapping: { fields: { ...MAPPING.fields, title: 'symptoms' }, diagnostics: {} }, connection: { token: '', url: '', recordsPath: 'data', pageSize: '' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.ok(!JSON.stringify(edited.data).includes('dummy-token-1234'));
  assert.equal(edited.data.source.name, 'Renamed');
  assert.equal(edited.data.source.fieldMapping.fields.title, 'symptoms');
  a.hits.length = 0;
  assert.equal((await s.sync()).status, 200);
  assert.equal(a.hits[0].auth, 'Bearer dummy-token-1234', 'a blank secret field kept the stored token');
  // A new token replaces it; the old one is gone from the stored record and never echoed.
  await s.w.owner.api('company/data-sources', { confirmed: true, id: s.id, connection: { token: 'dummy-token-5678' } });
  a.hits.length = 0;
  await s.sync();
  assert.equal(a.hits[0].auth, 'Bearer dummy-token-5678');
  assert.ok(!JSON.stringify(s.w.db().prepare('SELECT * FROM company_data_sources').all()).includes('dummy-token'), 'credentials are stored encrypted');
  // Saved progress and the high-water mark belong to one connection and one mapping: editing either starts clean.
  s.w.db().prepare("UPDATE company_data_sources SET status='deferred',sync_checkpoint_json='{\"mode\":\"full\",\"scan\":9,\"pos\":{\"page\":2},\"processed\":5,\"scanProcessed\":5,\"scanInvalid\":0}',high_water_json='{\"t\":\"s\",\"v\":\"x\"}' WHERE id=?").run(s.id);
  await s.w.owner.api('company/data-sources', { confirmed: true, id: s.id, fieldMapping: { fields: { ...MAPPING.fields, steps: 'symptoms' }, diagnostics: {} } });
  const row = s.source();
  assert.equal(row.sync_checkpoint_json, null);
  assert.equal(row.high_water_json, null);
  assert.equal(row.status, 'configured');
  // Settings that do not belong to this kind of source are refused, not stored.
  const stray = await s.w.owner.api('company/data-sources', { confirmed: true, id: s.id, connection: { uri: 'postgres://x' } });
  assert.equal(stray.status, 400);
  assert.match(stray.data.error, /not a setting of this kind of source/);
  // Errors from the source never echo the connection.
  const dead = await api(t, () => [500, { error: 'dummy-token-9999 leaked' }]);
  const d = await restWorld(t, dead, { token: 'dummy-token-9999' }, { config: { DATA_SOURCE_RETRIES: '1' } });
  const failed = await d.sync();
  assert.ok(!JSON.stringify(failed.data).includes('dummy-token-9999'));
  assert.ok(!JSON.stringify((await d.w.owner.api('company/data-sources')).data).includes('dummy-token-9999'));
});

test('every source operation is tenant-isolated and owner-only', async (t) => {
  const a = await api(t, () => [200, { data: DATA.slice(0, 5) }]);
  const s = await restWorld(t, a, { token: 'dummy-token-1111' });
  const customer = await s.w.customer('casey');
  const stranger = s.w.other;
  const ops = [
    ['POST', `company/data-sources/${s.id}/sync`, { confirmed: true }],
    ['POST', `company/data-sources/${s.id}/preview`, {}],
    ['POST', `company/data-sources/${s.id}/test`, {}],
    ['POST', `company/data-sources/${s.id}/pause`, { confirmed: true }],
    ['POST', `company/data-sources/${s.id}/resume`, { confirmed: true }],
    ['POST', `company/data-sources/${s.id}/cancel`, { confirmed: true }],
    ['GET', `company/data-sources/${s.id}/runs`, undefined],
    ['POST', 'company/data-sources', { confirmed: true, id: s.id, name: 'hijack', fieldMapping: MAPPING }],
  ];
  for (const [, route, body] of ops) {
    const other = await stranger.api(route, body);
    assert.equal(other.status, 404, `another company cannot reach ${route}: ${other.status}`);
    const cust = await customer.api(route, body);
    assert.ok([403, 404].includes(cust.status), `a customer cannot use ${route}: ${cust.status}`);
  }
  assert.equal((await stranger.api('company/data-sources')).data.sources.length, 0, 'the other company sees none of this company’s sources');
  assert.equal(s.source().name, 'REST', 'nothing was changed');
  assert.equal((await stranger.api(`company/knowledge-lifecycle/history?memoryId=${encodeURIComponent('x')}`)).status, 404);
  // An unsafe URL is refused at save time for every company.
  const unsafe = await s.w.owner.api('company/data-sources', { confirmed: true, sourceType: 'rest_api', chatbotId: s.w.botOf(s.w.company), name: 'x', fieldMapping: MAPPING, connection: { url: 'http://169.254.169.254/latest/meta-data' } });
  assert.equal(unsafe.status, 400);
});
