import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'supportly-http-'));
const server = spawn(process.execPath, ['server/start.js'], { env: { ...process.env, NODE_ENV: 'test', APP_URL: 'http://localhost:3000', REQUIRE_EMAIL_VERIFICATION: 'false', ENABLE_OUTBOX_WORKER: 'false', RESEND_API_KEY: '', EMAIL_FROM: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', INTEGRATION_ENCRYPTION_KEY: '', DATABASE_FILE: join(directory, 'test.sqlite'), ENABLE_DEMO_MODE: 'true', FRONTEND_PORT: '0', API_PORT: '0', DATA_FILE: join(directory, 'test.json'), HINDSIGHT_BASE_URL: '', OPENAI_API_KEY: '', REQUIRE_LIVE_INTEGRATIONS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start within 10 seconds.')), 10000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
    server.stderr.on('data', (chunk) => { clearTimeout(timer); reject(new Error(chunk.toString())); });
    server.stdout.on('data', (chunk) => { const match = chunk.toString().match(/Continuum: (http:\/\/localhost:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  for (const route of ['/', '/about', '/services', '/pricing', '/book-a-session', '/style-guide', '/desk', '/desk/', '/pages.js', '/client.js', '/auth-ui.js', '/ui.js', '/styles.css']) {
    const response = await fetch(base + route); assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-security-policy'));
  }
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await (await fetch(base + '/', { method: 'HEAD' })).text()).length, 0);
  const health = await fetch(base + '/api/health'); assert.equal((await health.json()).status, 'ok');
  const sessionResponse = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'alice', pin: '246810' }) });
  const { token } = await sessionResponse.json(); assert.ok(token);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const invalid = await fetch(base + '/api/chat', { method: 'POST', headers, body: '{invalid' }); assert.equal(invalid.status, 400);
  const oversized = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(18000) }) }); assert.equal(oversized.status, 413);
  const opts = { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'http-create' }, body: JSON.stringify({ title: 'HTTP validation', issueDesc: 'Isolated test fixture', confirmed: true }) };
  const first = await (await fetch(base + '/api/request', opts)).json();
  const replay = await (await fetch(base + '/api/request', opts)).json(); assert.equal(first.ticketId, replay.ticketId);
  const workspace = await (await fetch(base + '/api/workspace', { headers })).json(); assert.equal(workspace.tickets.length, 2);
  const registration = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HTTP test account', email: 'http-test@example.test', password: 'a long isolated test passphrase 43', provider: 'repair' }) });
  assert.equal(registration.status, 201); assert.match(registration.headers.get('set-cookie'), /HttpOnly/);
  const cookie = registration.headers.get('set-cookie').split(';')[0], account = await registration.json(); assert.ok(!account.token);
  const accountHeaders = { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': account.csrfToken };
  assert.equal((await (await fetch(base + '/api/workspace', { headers: accountHeaders })).json()).tickets.length, 0);
  assert.equal((await fetch(base + '/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body })).status, 403);
  assert.equal((await fetch(base + '/api/request', { method: 'POST', headers: accountHeaders, body: opts.body })).status, 201);
  assert.equal((await fetch(base + '/api/status?ticketId=' + first.ticketId, { headers: accountHeaders })).status, 404);
  assert.equal((await fetch(base + '/api/session', { method: 'DELETE', headers: accountHeaders })).status, 200);
  assert.equal((await fetch(base + '/api/workspace', { headers: { Cookie: cookie } })).status, 401);
  console.log('HTTP checks passed: pages/assets, SQLite, real cookie authentication, CSRF, account isolation, sign-out, validation, proxy, and safe replay.');
} finally {
  if (server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await rm(directory, { recursive: true, force: true });
}
