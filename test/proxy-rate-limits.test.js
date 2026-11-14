import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function server(t, trusted = '') {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-proxy-test-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/start.js', import.meta.url))], {
    cwd: dir, env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: join(dir, 'test.sqlite'), FRONTEND_PORT: '0', API_PORT: '0',
      TRUSTED_PROXY_IPS: trusted, HOST: '127.0.0.1', ENABLE_OUTBOX_WORKER: 'false', REQUIRE_EMAIL_VERIFICATION: 'false',
      OPENAI_API_KEY: '', HINDSIGHT_BASE_URL: '', RESEND_API_KEY: '', EMAIL_FROM: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await rm(dir, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + output)), 10000);
    child.stderr.on('data', (c) => { output += c; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + output)); });
    child.stdout.on('data', (c) => {
      output += c;
      const m = output.match(/Continuum: (http:\/\/localhost:\d+) \| API: (http:\/\/localhost:\d+)/);
      if (m) { clearTimeout(timer); resolve({ publicUrl: m[1], apiUrl: m[2] }); }
    });
  });
}
async function attempt(url, headers = {}, kind = 'register', email = 'nonexistent@example.test') {
  const r = await fetch(url + '/api/auth/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(kind === 'login' ? { email, password: 'a fictional invalid passphrase' } : {}) });
  await r.text();
  return r.status;
}

test('the real proxy keeps trusted clients separate and direct API callers cannot forge internal identity', async (t) => {
  const app = await server(t, '127.0.0.1');
  for (let i = 0; i < 5; i++) assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.1' }), 400);
  assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.1' }), 429);
  assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.2' }), 400);
  for (let i = 0; i < 5; i++) assert.equal(await attempt(app.apiUrl, { 'x-continuum-client-address': '203.0.113.' + i, 'x-continuum-proxy-token': 'forged' }), 400);
  assert.equal(await attempt(app.apiUrl, { 'x-continuum-client-address': '203.0.113.99' }), 429);
  // Separate account names isolate the IP budget from the additional per-account limit.
  for (let i = 0; i < 15; i++) assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.3' }, 'login', 'missing' + i + '@example.test'), 401);
  assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.3' }, 'login', 'another@example.test'), 429);
  assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.4' }, 'login', 'another@example.test'), 401);
});

test('the public listener overwrites forged identity headers and ignores untrusted forwarding', async (t) => {
  const app = await server(t);
  for (let i = 0; i < 5; i++) assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.' + i, 'x-continuum-client-address': '203.0.113.' + i }), 400);
  assert.equal(await attempt(app.publicUrl, { 'x-forwarded-for': '198.51.100.99', 'x-continuum-client-address': '203.0.113.99' }), 429);
});
