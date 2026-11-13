import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from "node:net";
import { world } from './_helpers.js';
import { pinnedGet, resolveAllowed, resolvePostgresDestination } from '../server/net-guard.js';
import { assertSafeUrl, resolveDestination } from '../server/data-sources.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const privateDns = async () => [{ address: '10.0.0.5', family: 4 }];
const allowed = (...o) => new Set(o);
const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps' }, diagnostics: {} };

// ---------------------------------------------------------------------------------------------- Test 16: REST
test('REST: the connection is pinned to the validated address, so DNS rebinding cannot redirect it', async () => {
  // A resolver that is public the first time and private afterwards (classic rebinding).
  let calls = 0;
  const flip = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(resolveDestination('https://kb.example.test/x', { allowedOrigins: allowed('https://kb.example.test'), resolver: flip }), /Private and loopback/, 'a changed answer is validated again, never trusted');

  // The request itself never does its own lookup: whatever name the socket layer asks for, it gets the pinned address.
  let seen;
  const requestImpl = (options, onResponse) => {
    seen = options;
    const handlers = {};
    const req = { on: (e, f) => ((handlers[e] = f), req), end: () => queueMicrotask(() => {
      const res = { statusCode: 200, headers: {}, on: (e, f) => { if (e === 'data') f(Buffer.from('[]')); if (e === 'end') setTimeout(f, 0); return res; }, resume() {} };
      onResponse(res);
    }), destroy() {} };
    return req;
  };
  const url = new URL('https://kb.example.test/solutions?x=1');
  const out = await pinnedGet({ url, address: '93.184.216.34', family: 4, requestImpl });
  assert.equal(out.status, 200);
  assert.equal(seen.servername, 'kb.example.test', 'TLS still verifies the original host name');
  assert.equal(seen.headers.Host, 'kb.example.test');
  assert.equal(seen.path, '/solutions?x=1');
  let answered;
  seen.lookup('kb.example.test', {}, (e, address, family) => (answered = { address, family }));
  assert.deepEqual(answered, { address: '93.184.216.34', family: 4 });
  seen.lookup('anything.else', { all: true }, (e, list) => (answered = list));
  assert.deepEqual(answered, [{ address: '93.184.216.34', family: 4 }]);
});

test('REST: redirects, oversized responses, slow servers and private destinations are all refused', async (t) => {
  const net = await import('node:http');
  const server = net.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
    if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(3000)); return; }
    if (req.url === '/slow') return; // never answers
    res.writeHead(200); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = (p) => new URL('http://127.0.0.1:' + server.address().port + p);
  const get = (p, extra = {}) => pinnedGet({ url: url(p), address: '127.0.0.1', family: 4, ...extra });
  await assert.rejects(get('/redirect'), /redirects are not followed/);
  await assert.rejects(get('/big', { maxBytes: 1000 }), /too large/);
  await assert.rejects(get('/slow', { timeoutMs: 150 }), /timed out/);
  assert.equal((await get('/ok')).status, 200);
  // The destination rules.
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '[::1]', '192.168.0.9', '0.0.0.0'])
    await assert.rejects(resolveAllowed(host, {}), /Private and loopback/, host);
  await assert.rejects(resolveAllowed('kb.example.test', { resolver: privateDns }), /Private and loopback/);
  await assert.rejects(resolveAllowed('kb.example.test', { resolver: async () => { throw new Error('nx'); } }), /could not be resolved/);
  await assert.rejects(assertSafeUrl('http://kb.example.test/x', { allowedOrigins: allowed('http://kb.example.test'), resolver: publicDns }), /https/);
});

// ---------------------------------------------------------------------------------------------- Test 16 / 23: PostgreSQL
const pgOptions = (extra = {}) => ({ allowedHosts: allowed('db.example.test'), allowedPorts: allowed(5432), resolver: publicDns, ...extra });
test('PostgreSQL: only allowlisted hosts and ports, public addresses, TLS, and no smuggled connection options', async () => {
  const ok = await resolvePostgresDestination('postgres://reader:s3cret@db.example.test:5432/kb', pgOptions());
  assert.deepEqual({ host: ok.host, address: ok.address, port: ok.port, user: ok.user, database: ok.database, tls: ok.tls }, { host: 'db.example.test', address: '93.184.216.34', port: 5432, user: 'reader', database: 'kb', tls: true });
  const refuse = (uri, pattern, extra) => assert.rejects(resolvePostgresDestination(uri, pgOptions(extra)), pattern, uri);
  await refuse('postgres://u:p@other.example.test/kb', /DATA_SOURCE_POSTGRES_HOSTS/);
  await refuse('postgres://u:p@db.example.test:6543/kb', /DATA_SOURCE_POSTGRES_PORTS/);
  await refuse('postgres://u:p@db.example.test/kb?host=/var/run/postgresql', /not allowed/);
  await refuse('postgres://u:p@db.example.test/kb?options=-c%20role%3Dadmin', /not allowed/);
  await refuse('postgres://u:p@db.example.test/kb?sslmode=disable', /Encrypted/);
  await refuse('mysql://u:p@db.example.test/kb', /postgres:\/\//);
  await refuse('postgres://u:p@db.example.test/kb', /Private and loopback/, { resolver: privateDns });
  await refuse('postgres://u:p@127.0.0.1/kb', /DATA_SOURCE_POSTGRES_HOSTS/);
  await refuse('not a url', /valid PostgreSQL/);
  await refuse('postgres://u:p@10.0.0.5/kb', /Private and loopback/, { allowedHosts: allowed('10.0.0.5') });
  // Loopback is possible only when the server owner enabled development loopback explicitly.
  const dev = await resolvePostgresDestination('postgres://u:p@127.0.0.1:5432/kb?sslmode=disable', pgOptions({ allowedHosts: allowed('127.0.0.1'), allowLoopback: true }));
  assert.equal(dev.tls, false);
});

test('PostgreSQL connector: the real driver fails safely and never echoes credentials; read-only/TLS settings are applied', async (t) => {
  // A listener that accepts and immediately closes (not a database) plus a closed port.
  const closed = createServer((socket) => socket.destroy());
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  t.after(() => closed.close());
  const port = closed.address().port;
  const w = await world(t, { config: { DATA_SOURCE_POSTGRES_DRIVER: 'pg', DATA_SOURCE_POSTGRES_HOSTS: '127.0.0.1', DATA_SOURCE_POSTGRES_PORTS: String(port) + ',1', DATA_SOURCE_ALLOW_LOOPBACK: 'true' } });
  const bot = w.botOf(w.company);
  const save = (uri) => w.owner.api('company/data-sources', { confirmed: true, sourceType: 'postgres', chatbotId: bot, name: 'PG', fieldMapping: MAPPING, connection: { uri, table: 'kb' } });
  const created = await save(`postgres://reader:HUNTER2pass@127.0.0.1:${port}/kb?sslmode=disable`);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.source.availability.available, true);
  const sync = await w.owner.api(`company/data-sources/${created.data.source.id}/sync`, { confirmed: true });
  assert.equal(sync.status, 503);
  assert.ok(!JSON.stringify(sync.data).includes('HUNTER2pass'), 'credentials never appear in errors');
  assert.match(sync.data.error, /could not be reached|could not be read/);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE origin_type='company_db_sync'").get().n, 0);
  // Unlisted destinations are refused at save time.
  assert.equal((await save('postgres://reader:p@evil.example.test/kb')).status, 400);
  assert.equal((await save(`postgres://reader:p@127.0.0.1:2/kb?sslmode=disable`)).status, 400, 'port 2 is not allowlisted');
  // The settings handed to the driver: discrete fields, pinned address, read-only session, bounded waits.
  let options;
  class Client { constructor(o) { options = o; } on() {} async connect() {} async query() { return { rows: [] }; } async end() {} }
  const { createDataSources } = await import('../server/data-sources.js');
  const ds = createDataSources(w.h.store, w.h.delivery, { DATA_SOURCE_POSTGRES_HOSTS: 'db.example.test', DATA_SOURCE_POSTGRES_DRIVER: 'pg' }, { drivers: { postgres: { Client } }, resolver: publicDns });
  const row = { ...w.db().prepare('SELECT * FROM company_data_sources').get() };
  w.db().prepare('UPDATE company_data_sources SET encrypted_connection_uri=? WHERE id=?').run(w.h.delivery.seal({ uri: 'postgres://reader:pw@db.example.test/kb', table: 'kb' }, 'datasource:' + row.id), row.id);
  await ds.sync(w.company, row.id, 'test').catch(() => {});
  assert.equal(options.host, '93.184.216.34', 'connects to the validated address');
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.servername, 'db.example.test');
  assert.match(options.options, /default_transaction_read_only=on/);
  assert.ok(options.statement_timeout > 0 && options.connectionTimeoutMillis > 0);
  assert.equal(options.connectionString, undefined, 'the raw connection string is never handed to the driver');
});
