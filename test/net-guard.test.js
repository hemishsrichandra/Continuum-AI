import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, resolveAllowed, resolvePostgresDestination } from '../server/net-guard.js';
import { assertSafeUrl } from '../server/data-sources.js';

const BLOCKED = [
  // IPv4
  '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9', '192.88.99.1',
  // IPv6 basics, compressed and expanded
  '::', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', 'fe80::1', 'fe90::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '100::1', '2001:db8::1', '2001::1',
  // IPv4-mapped IPv6: dotted, hexadecimal, expanded
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:ac10:1', '::ffff:c0a8:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:a9fe:a9fe', '::FFFF:A9FE:A9FE',
  // deprecated IPv4-compatible, NAT64 and 6to4 carrying private IPv4
  '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1', '2002:c0a8:101::1',
  // zone identifiers and brackets
  'fe80::1%eth0', '[::1]', '[::ffff:7f00:1]',
  // not an address
  'localhost', '', 'not-an-ip', '1.2.3', '256.1.1.1', '1::2::3',
];
const ALLOWED = ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '[2606:4700:4700::1111]'];

test('every spelling of a private, loopback, link-local or metadata address is refused', () => {
  for (const address of BLOCKED) assert.equal(isPrivateAddress(address), true, 'must be blocked: ' + JSON.stringify(address));
});

test('public addresses, including public IPv4 carried inside IPv6, are still allowed', () => {
  for (const address of ALLOWED) assert.equal(isPrivateAddress(address), false, 'must be allowed: ' + address);
});

test('DNS answers are validated address by address; one private answer refuses the host', async () => {
  const answers = (...list) => async () => list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  for (const bad of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe90::1', '2002:7f00:1::1', '64:ff9b::7f00:1', '10.1.2.3'])
    await assert.rejects(resolveAllowed('kb.example.test', { resolver: answers(bad) }), /Private and loopback/, bad);
  await assert.rejects(resolveAllowed('kb.example.test', { resolver: answers('93.184.216.34', '::ffff:7f00:1') }), /Private and loopback/, 'a mixed answer is refused');
  const ok = await resolveAllowed('kb.example.test', { resolver: answers('93.184.216.34', '2606:4700:4700::1111') });
  assert.deepEqual(ok.map((a) => a.address), ['93.184.216.34', '2606:4700:4700::1111']);
});

test('URLs written with private IP literals are refused however they are spelled', async () => {
  const origins = (...o) => new Set(o);
  for (const host of ['[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[0:0:0:0:0:ffff:7f00:1]', '[fe90::1]', '[64:ff9b::7f00:1]', '[2002:7f00:1::1]', '127.0.0.1', '0x7f.0.0.1', '2130706433', '017700000001', '169.254.169.254'])
    await assert.rejects(assertSafeUrl(`https://${host}/x`, { allowedOrigins: origins(new URL(`https://${host}`).origin), resolver: async () => [{ address: '93.184.216.34', family: 4 }] }), /Private and loopback/, host);
  await assert.doesNotReject(assertSafeUrl('https://kb.example.test/x', { allowedOrigins: origins('https://kb.example.test'), resolver: async () => [{ address: '93.184.216.34', family: 4 }] }));
});

test('PostgreSQL destinations get the same address rules (literal host and DNS answer)', async () => {
  const base = (extra = {}) => ({ allowedHosts: new Set(['db.example.test', '[::ffff:7f00:1]', '::ffff:7f00:1']), allowedPorts: new Set([5432]), resolver: async () => [{ address: '93.184.216.34', family: 4 }], ...extra });
  await assert.rejects(resolvePostgresDestination('postgres://u:p@[::ffff:7f00:1]:5432/kb', base()), /Private and loopback|not allowed|DATA_SOURCE/);
  await assert.rejects(resolvePostgresDestination('postgres://u:p@db.example.test/kb', base({ resolver: async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }] })), /Private and loopback/);
  await assert.rejects(resolvePostgresDestination('postgres://u:p@db.example.test/kb', base({ resolver: async () => [{ address: '2002:7f00:1::1', family: 6 }] })), /Private and loopback/);
  const ok = await resolvePostgresDestination('postgres://u:p@db.example.test/kb', base());
  assert.equal(ok.address, '93.184.216.34');
});
