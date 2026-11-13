import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { world, ISSUE } from './_helpers.js';
import { parseCsv, assertSafeUrl, isPrivateAddress, validateMapping, mapRecord, createDataSources } from '../server/data-sources.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'applies_to', safety: 'safety' }, diagnostics: {} };
const CSV = `id,title,symptoms,steps,applies_to,safety
K-1,Display flicker after startup,Display flickers after startup,"Open Display settings, select the Standard profile and restart.",Model X firmware 4,None identified
K-2,VPN drops after sign-in,VPN disconnects after sign-in,Reinstall the approved VPN client and reconnect once.,Windows 11,None identified
`;
async function setup(t, config = {}) {
  const w = await world(t, { config });
  const bot = w.botOf(w.company);
  const save = (body) => w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: bot, name: 'Knowledge base', fieldMapping: MAPPING, connection: { csv: CSV }, ...body });
  return { w, bot, save };
}
const pool = (w, where = '1=1') => w.db().prepare(`SELECT * FROM memory_pool WHERE ${where}`).all();

test('CSV parser handles quotes, embedded commas/newlines, BOM and rejects malformed input', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\n'), [{ a: 'x, y', b: 'line1\nline2' }]);
  assert.throws(() => parseCsv('a,b\n"open'), /unterminated/);
  assert.throws(() => parseCsv('a,a\n1,2'), /must be unique/);
  // Odd headers from real exports are renamed to safe identifiers (CSV columns are only ever object keys, never SQL).
  assert.deepEqual(Object.keys(parseCsv('a;drop,b\n1,2')[0]), ['a_drop', 'b']);
  assert.throws(() => parseCsv(''), /empty/);
});

test('field mapping validation rejects missing, unknown and injection-shaped mappings', () => {
  assert.throws(() => validateMapping({ fields: { title: 't' } }), /required field/);
  assert.throws(() => validateMapping({ fields: { ...MAPPING.fields, bogus: 'x' } }), /Unknown passport field/);
  assert.throws(() => validateMapping({ fields: { ...MAPPING.fields, title: 'title; DROP TABLE users' } }), /plain column/);
  assert.throws(() => validateMapping({ fields: { ...MAPPING.fields, title: '../etc' } }), /plain column/);
  assert.throws(() => validateMapping({ ...MAPPING, diagnostics: { region: 'r' } }, [{ key: 'os' }]), /not in this service/);
  assert.deepEqual(validateMapping(MAPPING).fields.title, 'title');
});

test('owner configures a CSV source, previews (dry run) and syncs into their own company pool only', async (t) => {
  const { w, bot, save } = await setup(t);
  const created = await save({ declaredVerified: true });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const source = created.data.source;
  assert.equal(source.hasConnection, true);
  assert.equal(JSON.stringify(created.data).includes('Display flicker'), false, 'connection content is never returned');
  const before = pool(w, "origin_type='company_db_sync'").length;
  const preview = (await w.owner.api(`company/data-sources/${source.id}/preview`, {})).data;
  assert.equal(preview.total, 2);
  assert.equal(preview.valid, 2);
  assert.ok(preview.sample[0].cInit > 0.5);
  assert.equal(pool(w, "origin_type='company_db_sync'").length, before, 'a dry run writes nothing');
  const sync = await w.owner.api(`company/data-sources/${source.id}/sync`, { confirmed: true });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.result.inserted, 2);
  const rows = pool(w, "origin_type='company_db_sync'");
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.company_id, w.company);
    assert.equal(r.chatbot_id, bot);
    assert.equal(r.customer_confirmed, 0, 'imported records are not customer-confirmed');
    assert.equal(r.status, 'active');
    assert.match(r.source_key, new RegExp('^import:' + source.id + ':K-'));
    assert.equal(JSON.parse(r.verification_evidence_json).declaredVerified, true);
  }
  assert.equal(pool(w, `company_id='${w.companyB}' AND origin_type='company_db_sync'`).length, 0);
  const listed = (await w.owner.api('company/data-sources')).data;
  assert.equal(listed.sources[0].status, 'ok');
  assert.equal(listed.sources[0].lastSyncResult.inserted, 2);
  assert.ok(listed.sources[0].lastSyncedAt);
  assert.equal(listed.availability.postgres.available, false);
});

test('unverified imports do not receive the 0.85 verified-author default', async (t) => {
  const { w, save } = await setup(t);
  const verified = (await save({ declaredVerified: true })).data.source;
  const unverified = (await save({ name: 'Other', declaredVerified: false })).data.source;
  const v = (await w.owner.api(`company/data-sources/${verified.id}/preview`, {})).data.sample[0].cInit;
  const u = (await w.owner.api(`company/data-sources/${unverified.id}/preview`, {})).data.sample[0].cInit;
  assert.ok(v > u, `${v} > ${u}`);
});

test('re-sync is idempotent, updates unreviewed records and never overwrites local review, revision or failure data', async (t) => {
  const { w, save } = await setup(t);
  const source = (await save({ declaredVerified: true })).data.source;
  const run = async () => (await w.owner.api(`company/data-sources/${source.id}/sync`, { confirmed: true })).data.result;
  assert.equal((await run()).inserted, 2);
  const again = await run();
  assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 2]);
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 2);
  // A reviewer revises K-1 locally; the source later changes both records.
  const k1 = pool(w, "source_key LIKE '%:K-1'")[0];
  const revised = await w.owner.api('operator/revise', { id: k1.id, title: 'Reviewed: display flicker', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Locally reviewed steps: switch to the Fixed 60 Hz mode and restart.', reviewedForPrivacy: true, confirmed: true, version: 1 });
  assert.equal(revised.status, 201, JSON.stringify(revised.data));
  const changed = CSV.replace('select the Standard profile', 'select the Compatibility profile').replace('Reinstall the approved VPN client', 'Repair the approved VPN client');
  await w.owner.api('company/data-sources', { confirmed: true, id: source.id, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'Knowledge base', fieldMapping: MAPPING, connection: { csv: changed }, declaredVerified: true });
  const third = await run();
  assert.equal(third.skippedLocallyReviewed, 1, 'the locally revised lineage is untouched');
  assert.equal(third.updated, 1, 'the untouched record picks up the source change');
  assert.equal(pool(w, `id='${k1.id}'`)[0].status, 'superseded');
  const latest = pool(w, "source_key LIKE '%:K-1' ORDER BY version_number DESC")[0];
  assert.equal(latest.version_number, 2);
  assert.match(latest.steps_json, /Fixed 60 Hz/);
  assert.equal(pool(w, "source_key LIKE '%:K-1'").length, 2, 'no duplicate rows were created');
  const k2 = pool(w, "source_key LIKE '%:K-2'")[0];
  assert.match(k2.steps_json, /Repair the approved VPN client/);
  // Failure metrics and flags also pin a record.
  w.db().prepare("UPDATE memory_pool SET reuse_failure_count=1 WHERE id=?").run(k2.id);
  await w.owner.api('company/data-sources', { confirmed: true, id: source.id, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'Knowledge base', fieldMapping: MAPPING, connection: { csv: CSV }, declaredVerified: true });
  const fourth = await run();
  assert.equal(fourth.skippedLocallyReviewed, 2);
  assert.match(pool(w, `id='${k2.id}'`)[0].steps_json, /Repair the approved VPN client/);
  assert.equal(pool(w, `id='${k2.id}'`)[0].reuse_failure_count, 1);
});

test('invalid rows, duplicates, secrets, personal data and dangerous instructions are handled safely', async (t) => {
  const { w, save } = await setup(t);
  const csv = `id,title,symptoms,steps,applies_to,safety
D-1,Good record,Display flickers after startup,Open Display settings and select the Standard profile then restart.,Model X firmware 4,None identified
D-1,Duplicate id,Display flickers after startup,Different steps for the duplicate record here.,Model X firmware 4,None identified
,No id,Missing id here,Some steps that are long enough to count.,Model X,None identified
D-3,Has secret,Login problem,Sign in with password: hunter2 and continue.,Model X,None identified
D-4,Has PII,Display flickers after startup,Email jane@corp.example or call +1 415 555 0100 then select the Standard profile.,Model X firmware 4,None identified
D-5,Risky,Battery drains,Open the battery and bypass the thermal fuse to reset it.,Model X firmware 4,None identified
`;
  const source = (await save({ connection: { csv }, declaredVerified: true })).data.source;
  const preview = (await w.owner.api(`company/data-sources/${source.id}/preview`, {})).data;
  assert.equal(preview.total, 6);
  assert.equal(preview.invalid, 3, 'duplicate, missing id, secret');
  assert.equal(preview.flaggedForReview, 1);
  assert.equal(preview.withRedactions, 1);
  const result = (await w.owner.api(`company/data-sources/${source.id}/sync`, { confirmed: true })).data.result;
  assert.deepEqual([result.inserted, result.invalid, result.duplicates, result.flaggedForReview], [3, 2, 1, 1]);
  const rows = pool(w, "origin_type='company_db_sync'");
  assert.doesNotMatch(JSON.stringify(rows), /jane@corp|415 555|hunter2/);
  const risky = rows.find((r) => r.source_key.endsWith(':D-5'));
  assert.equal(risky.status, 'flagged_for_review');
  assert.equal(risky.risk_level, 'high');
  // Flagged records are never recommended.
  const out = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'Battery drains. Model X firmware 4', allowedOrigins: ['company_db_sync'] });
  assert.deepEqual(out.eligible, []);
});

test('connection secrets are encrypted at rest and never returned or echoed in errors', async (t) => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { w, save } = await setup(t, { DATA_SOURCE_ALLOWED_ORIGINS: origin, DATA_SOURCE_ALLOW_LOOPBACK: 'true' });
  const token = 'tok-SUPER-SECRET-123';
  const rest = await save({ sourceType: 'rest_api', name: 'REST', connection: { url: origin + '/solutions', token } });
  assert.equal(rest.status, 201, JSON.stringify(rest.data));
  const row = w.db().prepare('SELECT * FROM company_data_sources WHERE id=?').get(rest.data.source.id);
  assert.ok(!row.encrypted_connection_uri.includes(token));
  assert.ok(!row.encrypted_connection_uri.includes('127.0.0.1'));
  assert.ok(!JSON.stringify((await w.owner.api('company/data-sources')).data).includes(token));
  assert.equal((await w.owner.api(`company/data-sources/${rest.data.source.id}/preview`, {})).status, 200);
  assert.equal(seen[0], 'Bearer ' + token, 'the secret is used server-side only');
  await new Promise((r) => server.close(r));
  const sync = await w.owner.api(`company/data-sources/${rest.data.source.id}/sync`, { confirmed: true });
  assert.ok(sync.status >= 400);
  assert.ok(!JSON.stringify(sync.data).includes(token));
  const status = (await w.owner.api('company/data-sources')).data.sources.find((s) => s.id === rest.data.source.id);
  assert.equal(status.status, 'error');
  assert.ok(!JSON.stringify(status).includes(token));
});

test('tenant isolation: another company cannot read, preview, sync, delete or attach to a source', async (t) => {
  const { w, save } = await setup(t);
  const source = (await save({})).data.source;
  assert.equal((await w.other.api('company/data-sources')).data.sources.length, 0);
  for (const [route, body] of [[`company/data-sources/${source.id}/preview`, {}], [`company/data-sources/${source.id}/sync`, { confirmed: true }]])
    assert.equal((await w.other.api(route, body)).status, 404);
  assert.equal((await w.other.api(`company/data-sources/${source.id}`, undefined, {}).catch(() => ({ status: 0 }))).status === 200, false);
  const hijack = await w.other.api('company/data-sources', { confirmed: true, id: source.id, sourceType: 'csv_sync', chatbotId: w.botOf(w.companyB), name: 'x', fieldMapping: MAPPING, connection: { csv: CSV } });
  assert.ok([404, 409].includes(hijack.status), 'status ' + hijack.status);
  const crossBot = await w.other.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'x', fieldMapping: MAPPING, connection: { csv: CSV } });
  assert.equal(crossBot.status, 404, 'a chatbot from another company is not selectable');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM company_data_sources WHERE company_id=?").get(w.companyB).n, 0);
  // Customers and staff cannot manage sources.
  const c = await w.customer('alice');
  assert.equal((await c.api('company/data-sources')).status, 403);
});

test('SQLite adapter: allowlisted directory only, read-only, identifiers validated, injection and traversal blocked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-ds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'allowed'));
  await mkdir(join(dir, 'secret'));
  const file = join(dir, 'allowed', 'kb.sqlite');
  const db = new Database(file);
  db.exec("CREATE TABLE kb(id TEXT, title TEXT, symptoms TEXT, steps TEXT, env TEXT, region TEXT); INSERT INTO kb VALUES('1','Display flicker','Display flickers after startup','Open Display settings and pick the Standard profile then restart.','Model X firmware 4','eu');");
  db.close();
  const outside = new Database(join(dir, 'secret', 'other.sqlite'));
  outside.exec("CREATE TABLE kb(id TEXT, title TEXT, symptoms TEXT, steps TEXT)"); outside.close();
  // Creating symlinks needs Developer Mode or elevation on Windows; without it this traversal case cannot be set up.
  try { await symlink(join(dir, 'secret', 'other.sqlite'), join(dir, 'allowed', 'link.sqlite')); }
  catch (e) { if (e.code === 'EPERM' && process.platform === 'win32') return t.skip('symlinks are not permitted for this Windows user'); throw e; }
  const mapping = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'env' }, diagnostics: {} };
  const { w, save } = await setup(t, { DATA_SOURCE_SQLITE_DIRS: join(dir, 'allowed') });
  const ok = await save({ sourceType: 'sqlite', name: 'SQLite', fieldMapping: mapping, connection: { path: file, table: 'kb' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await w.owner.api(`company/data-sources/${ok.data.source.id}/sync`, { confirmed: true })).data.result.inserted, 1);
  const bad = (body) => save({ sourceType: 'sqlite', name: 'Bad', fieldMapping: mapping, connection: body });
  assert.equal((await bad({ path: join(dir, 'secret', 'other.sqlite'), table: 'kb' })).status, 400, 'outside the allowlist');
  assert.equal((await bad({ path: join(dir, 'allowed', 'link.sqlite'), table: 'kb' })).status, 400, 'symlink escape');
  assert.equal((await bad({ path: join(dir, 'allowed', '..', 'secret', 'other.sqlite'), table: 'kb' })).status, 400, 'traversal');
  assert.equal((await bad({ path: file, table: 'kb; DROP TABLE kb' })).status, 400, 'table injection');
  const injected = await save({ sourceType: 'sqlite', name: 'Inj', fieldMapping: { ...mapping, fields: { ...mapping.fields, title: 'title; DROP TABLE kb' } }, connection: { path: file, table: 'kb' } });
  assert.equal(injected.status, 400, 'column injection');
  const missingCol = await save({ sourceType: 'sqlite', name: 'Missing', fieldMapping: { ...mapping, fields: { ...mapping.fields, title: 'nope' } }, connection: { path: file, table: 'kb' } });
  const syncMissing = await w.owner.api(`company/data-sources/${missingCol.data.source.id}/sync`, { confirmed: true });
  assert.equal(syncMissing.status, 400);
  assert.match(syncMissing.data.error, /Columns not found/);
  assert.equal(new Database(file, { readonly: true }).prepare('SELECT COUNT(*) n FROM kb').get().n, 1, 'source data untouched');
});

test('SQLite and REST sources report configuration-required when the server owner has not enabled them', async (t) => {
  const { w, save } = await setup(t);
  const sqlite = await save({ sourceType: 'sqlite', name: 'S', fieldMapping: MAPPING, connection: { path: '/tmp/x.sqlite', table: 'kb' } });
  assert.equal(sqlite.status, 201);
  assert.match(sqlite.data.source.availability.reason, /configuration-required/);
  const sync = await w.owner.api(`company/data-sources/${sqlite.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.status, 503);
  assert.match(sync.data.error, /configuration-required/);
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 0, 'no fake success');
  assert.equal((await save({ sourceType: 'rest_api', name: 'R', connection: { url: 'https://kb.example.test/x' } })).status, 400);
  const pg = await save({ sourceType: 'postgres', name: 'P', connection: { uri: 'postgres://u:p@db/x', table: 'kb' } });
  assert.equal(pg.status, 201);
  assert.match(pg.data.source.availability.reason, /unavailable/);
  assert.equal((await w.owner.api(`company/data-sources/${pg.data.source.id}/sync`, { confirmed: true })).status, 503);
});

test('REST adapter reads a real local JSON endpoint; SSRF targets are rejected', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { items: [{ id: 'r1', name: 'Display flicker', problem: 'Display flickers after startup', fix: 'Open Display settings and pick the Standard profile then restart.', env: 'Model X firmware 4' }] } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { w, save } = await setup(t, { DATA_SOURCE_ALLOWED_ORIGINS: origin, DATA_SOURCE_ALLOW_LOOPBACK: 'true' });
  const mapping = { fields: { externalId: 'id', title: 'name', symptoms: 'problem', steps: 'fix', applicability: 'env' }, diagnostics: {} };
  const ok = await save({ sourceType: 'rest_api', name: 'REST', fieldMapping: mapping, connection: { url: origin + '/solutions', recordsPath: 'data.items' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const sync = await w.owner.api(`company/data-sources/${ok.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.data.result.inserted, 1, JSON.stringify(sync.data));
  const redirect = await save({ sourceType: 'rest_api', name: 'Redirect', fieldMapping: mapping, connection: { url: origin + '/redirect' } });
  assert.equal((await w.owner.api(`company/data-sources/${redirect.data.source.id}/sync`, { confirmed: true })).status, 503, 'redirects are not followed');
  // Without loopback permission the same origin is refused outright.
  const strict = await setup(t, { DATA_SOURCE_ALLOWED_ORIGINS: origin });
  assert.equal((await strict.save({ sourceType: 'rest_api', name: 'x', fieldMapping: mapping, connection: { url: origin + '/solutions' } })).status, 400);
});

test('assertSafeUrl blocks private, loopback, metadata, credentialed and non-https targets', async () => {
  const allowed = (...o) => new Set(o);
  const publicDns = async () => [{ address: '93.184.216.34' }];
  const privateDns = async () => [{ address: '10.0.0.5' }];
  await assert.doesNotReject(assertSafeUrl('https://kb.example.test/x', { allowedOrigins: allowed('https://kb.example.test'), resolver: publicDns }));
  for (const [url, why] of [
    ['http://kb.example.test/x', 'http'], ['https://user:pw@kb.example.test/x', 'credentials'], ['https://other.example.test/x', 'not allowlisted'],
    ['https://127.0.0.1/x', 'loopback'], ['https://169.254.169.254/latest/meta-data', 'metadata'], ['https://[::1]/x', 'ipv6 loopback'],
    ['https://10.1.2.3/x', 'private'], ['file:///etc/passwd', 'file'], ['not a url', 'garbage'],
  ]) await assert.rejects(assertSafeUrl(url, { allowedOrigins: allowed('https://kb.example.test', 'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://10.1.2.3'), resolver: publicDns }), undefined, why);
  await assert.rejects(assertSafeUrl('https://kb.example.test/x', { allowedOrigins: allowed('https://kb.example.test'), resolver: privateDns }), /Private and loopback/, 'DNS resolving to a private address');
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('PostgreSQL adapter runs only with a driver and uses quoted identifiers (mock driver)', async (t) => {
  const { w, save } = await setup(t, { DATA_SOURCE_POSTGRES_DRIVER: 'pg', DATA_SOURCE_POSTGRES_HOSTS: '93.184.216.34' });
  const queries = [];
  class Client {
    constructor(options) { this.options = options; }
    async connect() {}
    async query(q) { queries.push(q); return { rows: [{ id: 'p1', title: 'Display flicker', symptoms: 'Display flickers after startup', steps: 'Open Display settings and pick the Standard profile then restart.' }] }; }
    async end() {}
  }
  const pg = await save({ sourceType: 'postgres', name: 'PG', fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} }, connection: { uri: 'postgres://user:pw@93.184.216.34/kb', table: 'solutions', schema: 'public' } });
  const ds = createDataSources(w.h.store, w.h.dataSources.__delivery || w.h.delivery, { DATA_SOURCE_POSTGRES_DRIVER: 'pg', DATA_SOURCE_POSTGRES_HOSTS: '93.184.216.34' }, { drivers: { postgres: { Client } } });
  const result = await ds.sync(w.company, pg.data.source.id, 'test');
  assert.equal(result.inserted, 1);
  assert.match(queries[0], /^SELECT "id","title","symptoms","steps" FROM "public"\."solutions" ORDER BY "id" LIMIT \d+ OFFSET 0$/);
  const evil = await save({ sourceType: 'postgres', name: 'Evil', fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} }, connection: { uri: 'postgres://u:p@93.184.216.34/kb', table: 'solutions"; DROP TABLE x;--' } });
  await assert.rejects(ds.sync(w.company, evil.data.source.id, 'test'), /plain table/);
});

test('diagnostic fields: mapped columns become applicability conditions and gate retrieval', async (t) => {
  const { w, bot } = await setup(t);
  const cfg = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.id === bot);
  const schema = [
    { key: 'device', label: 'your device model', required: true, help: 'For example: Acme Router R2' },
    { key: 'region', label: 'your region', required: true, options: ['eu', 'us'] },
  ];
  const saved = await w.owner.api('company/chatbots', { ...cfg, diagnosticSchema: schema, playbooks: [] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.chatbot.requiredContext, ['device', 'region']);
  const csv = 'id,title,symptoms,steps,device,region\nR-1,Router drops Wi-Fi,Router drops the Wi-Fi connection every hour,Update the router firmware to the latest approved release then reboot it.,r2,eu\n';
  const mapping = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: { device: 'device', region: 'region' } };
  const source = (await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: bot, name: 'Diagnostics', fieldMapping: mapping, connection: { csv }, declaredVerified: true })).data.source;
  assert.equal((await w.owner.api(`company/data-sources/${source.id}/sync`, { confirmed: true })).data.result.inserted, 1);
  const a = await w.customer('alice');
  const id = await w.ticket(a, 'My router drops the Wi-Fi connection every hour', 'Router wifi');
  const ask = (message, context) => a.api('chat', { ticketId: id, message, context });
  const need = (await ask('My router drops the Wi-Fi connection every hour')).data;
  assert.equal(need.workflow.stage, 'context');
  assert.match(need.reply, /your device model, your region/);
  assert.match(need.reply, /Acme Router R2/, 'the example comes from the schema help text');
  assert.deepEqual(need.workflow.fields.map((f) => f.key), ['device', 'region']);
  const wrong = (await ask('Router wifi drops', { device: 'r2', region: 'us' })).data;
  assert.equal(wrong.trace.learnedResolutions, 0, 'region conflict');
  const t2 = await w.ticket(a, 'Router drops Wi-Fi every hour', 'Router wifi again');
  const right = (await a.api('chat', { ticketId: t2, message: 'Router drops Wi-Fi every hour', context: { device: 'r2', region: 'eu' } })).data;
  assert.ok(right.attempt, JSON.stringify(right));
  assert.equal(right.attempt.source, 'learned');
  assert.equal(right.learnedSource.origin, 'company_db_sync');
  assert.match(right.learnedSource.label, /Imported from your company/);
  assert.equal(right.learnedSource.customerConfirmed, false);
  void ISSUE; void writeFile;
});

// --------------------------------------------------------------------------- scheduled sync
const HOUR = 3600000;
const csvOf = (steps) => `id,title,symptoms,steps,applies_to\nK-1,Display flicker,Display flickers after startup,${steps},Model X firmware 4\n`;

test('scheduled sync: due sources run on the worker tick exactly once per interval; manual-only sources never run', async (t) => {
  const { w, save } = await setup(t);
  const scheduled = (await save({ syncIntervalHours: 2, connection: { csv: csvOf('Open Display settings and pick the Standard profile then restart.') } })).data.source;
  const manual = (await save({ name: 'Manual', connection: { csv: CSV } })).data.source;
  assert.equal(scheduled.syncIntervalHours, 2);
  assert.ok(Date.parse(scheduled.nextSyncAt) > Date.now() + 1.9 * HOUR);
  assert.equal(manual.syncIntervalHours, null);
  assert.deepEqual(await w.h.dataSources.runDue(Date.now() + HOUR), [], 'not due yet');
  const first = await w.h.dataSources.runDue(Date.now() + 3 * HOUR);
  assert.deepEqual(first.map((r) => [r.id, r.status, r.inserted]), [[scheduled.id, 'ok', 1]]);
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 1, 'only the scheduled source imported');
  assert.deepEqual(await w.h.dataSources.runDue(Date.now() + 3 * HOUR), [], 'the same tick again does nothing');
  assert.deepEqual(await w.h.dataSources.runDue(Date.now() + 4 * HOUR), [], 'still inside the next interval');
  const next = await w.h.dataSources.runDue(Date.now() + 6 * HOUR);
  assert.equal(next.length, 1);
  assert.deepEqual([next[0].inserted, next[0].updated], [0, 0], 'a re-run of unchanged data changes nothing');
  const shown = (await w.owner.api('company/data-sources')).data.sources.find((s) => s.id === scheduled.id);
  assert.ok(shown.lastSyncedAt && shown.nextSyncAt);
});

test('scheduled sync picks up source changes, keeps local review decisions, and records failures without stopping', async (t) => {
  const { w, save } = await setup(t);
  const src = (await save({ syncIntervalHours: 1, declaredVerified: true, connection: { csv: csvOf('Open Display settings and pick the Standard profile then restart.') } })).data.source;
  await w.h.dataSources.runDue(Date.now() + 2 * HOUR);
  const row = pool(w, "source_key LIKE '%:K-1'")[0];
  // A reviewer revises the record, then the source changes.
  const revised = await w.owner.api('operator/revise', { id: row.id, title: 'Reviewed', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Reviewed steps: select Fixed 60 Hz mode and restart the laptop.', reviewedForPrivacy: true, confirmed: true, version: 1 });
  assert.equal(revised.status, 201);
  await w.owner.api('company/data-sources', { confirmed: true, id: src.id, sourceType: 'csv_sync', chatbotId: w.botOf(w.company), name: 'Knowledge base', fieldMapping: MAPPING, connection: { csv: csvOf('Upstream changed these steps entirely and completely.') }, declaredVerified: true });
  const run = await w.h.dataSources.runDue(Date.now() + 4 * HOUR);
  assert.equal(run[0].status, 'ok');
  assert.match(pool(w, "source_key LIKE '%:K-1' ORDER BY version_number DESC")[0].steps_json, /Fixed 60 Hz/, 'the reviewer’s version still wins');
  const result = JSON.parse(w.db().prepare('SELECT last_sync_result_json r FROM company_data_sources WHERE id=?').get(src.id).r);
  assert.equal(result.skippedLocallyReviewed, 1);
  // A failing source: recorded as an error, other sources still run, and the schedule moves on.
  const broken = (await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: w.botOf(w.company), name: 'Broken', fieldMapping: MAPPING, connection: { path: '/tmp/none.sqlite', table: 'kb' }, syncIntervalHours: 1 })).data.source;
  const later = await w.h.dataSources.runDue(Date.now() + 8 * HOUR);
  assert.deepEqual(later.map((r) => r.status).sort(), ['error', 'ok']);
  const status = (await w.owner.api('company/data-sources')).data.sources.find((s) => s.id === broken.id);
  assert.equal(status.status, 'error');
  assert.ok(Date.parse(status.nextSyncAt) > Date.now() + 8 * HOUR, 'the next attempt waits for the next interval');
});

test('scheduled sync: concurrent workers cannot run the same source twice', async (t) => {
  const { w, save } = await setup(t);
  await save({ syncIntervalHours: 1, connection: { csv: csvOf('Open Display settings and pick the Standard profile then restart.') } });
  const at = Date.now() + 3 * HOUR;
  const results = await Promise.all([w.h.dataSources.runDue(at), w.h.dataSources.runDue(at), w.h.dataSources.runDue(at)]);
  assert.equal(results.flat().length, 1, 'exactly one worker claimed it');
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 1);
});

test('sync interval validation, clearing, and company isolation of schedules', async (t) => {
  const { w, save } = await setup(t);
  for (const bad of [0, 721, 1.5, '2', -1]) assert.equal((await save({ syncIntervalHours: bad })).status, 400, String(bad));
  const src = (await save({ syncIntervalHours: 3 })).data.source;
  assert.equal((await save({ id: src.id, syncIntervalHours: null })).data.source.syncIntervalHours, null, 'null clears the schedule');
  assert.equal(w.db().prepare('SELECT next_sync_at n FROM company_data_sources WHERE id=?').get(src.id).n, null);
  assert.deepEqual(await w.h.dataSources.runDue(Date.now() + 100 * HOUR), []);
  // Changing only the name keeps an existing schedule untouched.
  const s2 = (await save({ name: 'Other', syncIntervalHours: 5 })).data.source;
  const before = w.db().prepare('SELECT next_sync_at n FROM company_data_sources WHERE id=?').get(s2.id).n;
  await save({ id: s2.id, name: 'Renamed', syncIntervalHours: 5 });
  assert.equal(w.db().prepare('SELECT next_sync_at n FROM company_data_sources WHERE id=?').get(s2.id).n, before);
  // Another company's owner cannot schedule or alter this source.
  const hijack = await w.other.api('company/data-sources', { confirmed: true, id: s2.id, sourceType: 'csv_sync', chatbotId: w.botOf(w.companyB), name: 'x', fieldMapping: MAPPING, connection: { csv: CSV }, syncIntervalHours: 1 });
  assert.ok([404, 409].includes(hijack.status), 'status ' + hijack.status);
  assert.equal(w.db().prepare('SELECT sync_interval_hours n FROM company_data_sources WHERE id=?').get(s2.id).n, 5);
});

test('the worker flush runs scheduled syncs (not web requests)', async (t) => {
  const { w, save } = await setup(t);
  const src = (await save({ syncIntervalHours: 1, connection: { csv: csvOf('Open Display settings and pick the Standard profile then restart.') } })).data.source;
  w.db().prepare('UPDATE company_data_sources SET next_sync_at=? WHERE id=?').run(new Date(Date.now() - HOUR).toISOString(), src.id);
  await w.owner.api('company/data-sources');
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 0, 'ordinary traffic does not sync');
  await w.h.delivery.flush();
  assert.equal(pool(w, "origin_type='company_db_sync'").length, 1);
});
