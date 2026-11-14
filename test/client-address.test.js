import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, clientAddress, setClientAddress, publicClientAddress, trustedProxies } from '../server/client-address.js';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';
import { createPublicRoutes } from '../server/routes/public.js';

const req = (peer, forwarded, extra = {}) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded, ...extra } });

test('untrusted sockets cannot select an address with forwarded or internal headers', () => {
  const r = req('198.51.100.1', '203.0.113.9', { 'x-continuum-client-address': '203.0.113.8' });
  assert.equal(publicClientAddress(r), '198.51.100.1');
  assert.equal(clientAddress(r), '198.51.100.1');
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeAddress('fe80::1%en0'), null);
  assert.equal(normalizeAddress('not-an-ip'), null);
});

test('only explicitly trusted hops are removed from the right of the proxy chain', () => {
  const trusted = trustedProxies('127.0.0.1, ::ffff:192.0.2.1, ::1');
  assert.equal(publicClientAddress(req('127.0.0.1', '203.0.113.9, 198.51.100.1, 192.0.2.1'), trusted), '198.51.100.1');
  assert.equal(publicClientAddress(req('::1', '2001:db8::1'), trusted), '2001:db8::1');
  for (const bad of ['unknown', '198.51.100.1, bad', '', '198.51.100.1:1234'])
    assert.equal(publicClientAddress(req('127.0.0.1', bad), trusted), '127.0.0.1');
  assert.throws(() => trustedProxies('127.0.0.1, *'), /literal IP/);
});

test('authentication uses the verified request address, while direct API headers cannot forge it', async (t) => {
  const h = createHandler({ file: ':memory:', config: { NODE_ENV: 'test' } });
  t.after(() => h.close());
  // Invalid bodies consume the IP budget without expensive password hashes or stored accounts.
  const call = (address, headers = {}) => invoke((r, s) => {
    if (address) setClientAddress(r, address);
    return h(r, s);
  }, 'auth/register', { body: {}, headers });
  for (let i = 0; i < 5; i++) assert.equal((await call('198.51.100.1')).status, 400);
  assert.equal((await call('198.51.100.1')).status, 429);
  assert.equal((await call('198.51.100.2')).status, 400, 'another client keeps its own allowance');
  for (let i = 0; i < 5; i++) await call(null, { 'x-continuum-client-address': '203.0.113.' + i });
  assert.equal((await call(null, { 'x-forwarded-for': '203.0.113.99' })).status, 429, 'direct API callers cannot choose a bucket');
});

test('public booking and management limits use the same verified client identity', async () => {
  const keys = [];
  const routes = createPublicRoutes({ limit: (key) => { keys.push(key); throw new Error('limit reached'); } });
  const r = req('127.0.0.1');
  setClientAddress(r, '198.51.100.3');
  for (const endpoint of ['POST /api/demo-bookings', 'POST /api/demo-bookings/manage'])
    await assert.rejects(routes({ req: r, endpoint }), /limit reached/);
  assert.deepEqual(keys, ['booking:198.51.100.3', 'manage:198.51.100.3']);
});
