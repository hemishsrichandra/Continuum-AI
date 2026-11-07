import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHandler } from '../server/app.js';
import { Store, provider, profiles } from '../server/providers.js';
import { invoke } from '../scripts/invoke.js';

const password = 'a memorable continuum passphrase 42';
const config = { APP_URL: 'https://continuum.example', INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
function setup(t, options = {}) {
  const handler = createHandler({ ...options, config: { ...config, ...options.config } }); t.after(() => handler.close());
  return { handler, api: (route, args) => invoke(handler, route, args) };
}
function browser(api) {
  let cookie = '', csrf = '';
  return { get cookie() { return cookie; }, get csrf() { return csrf; }, async call(route, { body, method, noCsrf = false, headers = {} } = {}) {
    const result = await api(route, { body, method, headers: { ...(cookie && { cookie }), ...(csrf && !noCsrf && { 'x-csrf-token': csrf }), ...headers } });
    if (result.headers?.['Set-Cookie']) cookie = result.headers['Set-Cookie'].split(';')[0];
    if (result.data.csrfToken) csrf = result.data.csrfToken;
    return result;
  } };
}
const register = (client, email = 'alex@example.test') => client.call('auth/register', { body: { createCompany:true, companyName:'Test company', name: 'Alex Morgan', email, password, provider: 'repair' } });

async function registerCustomer(client, api, email = 'alex@example.test') {
  const owner = browser(api);
  await register(owner, 'owner-' + email);
  const code = (await owner.call('company/customer-code', {body:{confirmed:true}})).data.code;
  return client.call('auth/register', {body:{companyCode:code,name:'Alex Morgan',email,password,provider:'repair'}});
}

test('personal accounts use hashed passwords, HttpOnly cookies, CSRF, and isolated empty workspaces', async (t) => {
  const { api, handler } = setup(t); const client = browser(api);
  assert.equal((await client.call('auth/register', { body: { name: 'A', email: 'a@example.test', password: 'short', provider: 'repair' } })).status, 400);
  const signup = await registerCustomer(client, api); assert.equal(signup.status, 201);
  assert.match(signup.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/); assert.ok(!signup.data.token);
  const account = handler.store.db.prepare('SELECT * FROM accounts WHERE email=?').get('alex@example.test');
  assert.match(account.password_hash, /^scrypt:131072:8:1:/); assert.ok(!account.password_hash.includes(password));
  const session = handler.store.db.prepare('SELECT * FROM sessions WHERE account_id=?').get(account.id);
  assert.equal(session.token_hash, createHash('sha256').update(client.cookie.split('=')[1]).digest('hex'));
  const workspace = await client.call('workspace'); assert.deepEqual(workspace.data.tickets, []); assert.equal(workspace.data.profile.demo, false);
  const body = { title: 'Personal request', issueDesc: 'My own service record', confirmed: true };
  assert.equal((await client.call('request', { body, noCsrf: true })).status, 403);
  assert.equal((await client.call('request', { body })).status, 201);
  assert.equal((await client.call('request', { body, headers: { 'x-csrf-token': '💡'.repeat(client.csrf.length / 2) } })).status, 403);
  const second = browser(api); await registerCustomer(second, api, 'other@example.test');
  assert.deepEqual((await second.call('workspace')).data.tickets, []);
  const own = (await client.call('workspace')).data.tickets[0].id;
  assert.equal((await second.call('status?ticketId=' + own)).status, 404);
  assert.equal((await api('workspace', { token: client.cookie.split('=')[1] })).status, 401);
  assert.equal((await api('session', { body: { profileId: 'alice', pin: '246810' } })).status, 404);
});

test('database sessions survive restart and can be revoked across all devices', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-auth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.sqlite'); const first = setup(t, { file }); const client = browser(first.api); await register(client);
  const second = setup(t, { file });
  const persisted = await second.api('auth/session', { headers: { cookie: client.cookie } }); assert.equal(persisted.status, 200);
  const device = browser(second.api); assert.equal((await device.call('auth/login', { body: { email: 'alex@example.test', password } })).status, 200);
  assert.equal((await device.call('auth/sessions')).data.sessions.length, 2);
  assert.equal((await device.call('auth/logout-all', { body: {} })).status, 200);
  assert.equal((await client.call('workspace')).status, 401);
  assert.equal((await device.call('workspace')).status, 401);
});

test('verification and reset links are encrypted in the queue, expire, and are single-use', async (t) => {
  const emails = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); assert.ok(options.headers['Idempotency-Key']); emails.push(JSON.parse(options.body)); return Response.json({ id: 'email-' + emails.length }); });
  const { api, handler } = setup(t, { config: { NODE_ENV: 'production', RESEND_API_KEY: 'test-key', EMAIL_FROM: 'Continuum <no-reply@example.test>', REQUIRE_EMAIL_VERIFICATION: 'true' } });
  const signup = await register(browser(api)); assert.equal(signup.status, 202); assert.equal(signup.headers['Set-Cookie'], undefined);
  assert.equal((await api('auth/login', { body: { email: 'alex@example.test', password } })).status, 403);
  const duplicate = await register(browser(api)); assert.equal(duplicate.status, signup.status); assert.equal(duplicate.data.message, signup.data.message);
  assert.equal(handler.store.data.outbox.length, 1);
  const queued = handler.store.data.outbox[0]; assert.equal(queued.type, 'email'); assert.ok(!queued.payload.includes('alex@example.test')); assert.ok(!queued.payload.includes('#verify='));
  await handler.delivery.flush(); assert.equal(emails.length, 1); assert.equal(handler.store.data.outbox[0].payload, null);
  const link = emails[0].text.match(/https:\/\/\S+/)[0], token = new URL(link).hash.slice('#verify='.length);
  assert.equal((await api('auth/verify', { body: { token } })).status, 200);
  assert.equal((await api('auth/verify', { body: { token } })).status, 400);
  const client = browser(api); assert.equal((await client.call('auth/login', { body: { email: 'alex@example.test', password } })).status, 200);
  assert.match(client.cookie, /^__Host-continuum=/);
  const known = await api('auth/forgot', { body: { email: 'alex@example.test' } });
  const unknown = await api('auth/forgot', { body: { email: 'missing@example.test' } });
  assert.equal(known.status, unknown.status); assert.equal(known.data.message, unknown.data.message);
  await handler.delivery.flush(); const reset = new URL(emails.at(-1).text.match(/https:\/\/\S+/)[0]).hash.slice('#reset='.length);
  const next = 'a different long passphrase 97';
  assert.equal((await api('auth/reset', { body: { token: reset, password: next } })).status, 200);
  assert.equal((await api('auth/reset', { body: { token: reset, password: next } })).status, 400);
  assert.equal((await client.call('workspace')).status, 401);
  assert.equal((await api('auth/login', { body: { email: 'alex@example.test', password } })).status, 401);
  assert.equal((await api('auth/login', { body: { email: 'alex@example.test', password: next } })).status, 200);
  await api('auth/forgot', { body: { email: 'alex@example.test' } });
  const pendingReset = handler.store.data.outbox.at(-1);
  const privateReset = new URL(handler.delivery.unseal(pendingReset.payload, pendingReset.id).text.match(/https:\/\/\S+/)[0]).hash.slice('#reset='.length);
  handler.store.db.prepare("UPDATE auth_tokens SET expires_at=0 WHERE purpose='reset'").run();
  assert.equal((await api('auth/reset', { body: { token: privateReset, password: next } })).status, 400);
  const sentCount = emails.length; await handler.delivery.flush(); assert.equal(emails.length, sentCount);
  assert.equal(handler.store.data.outbox.at(-1).status, 'skipped');
});

test('production disables demo access and requires HTTPS and verified email', async (t) => {
  assert.throws(() => createHandler({ config: { NODE_ENV: 'production', APP_URL: 'http://example.test' } }), /HTTPS/);
  const { api } = setup(t, { config: { NODE_ENV: 'production', ENABLE_DEMO_MODE: 'true' } });
  assert.equal((await api('auth/config')).data.demoEnabled, false);
  assert.deepEqual((await api('profiles')).data.profiles, []);
  assert.equal((await api('session', { body: { profileId: 'alice', pin: '246810' } })).status, 404);
  assert.equal((await register(browser(api))).status, 503);
});

test('persistent throttling survives handlers and password change revokes sessions', async (t) => {
  const { api, handler } = setup(t); const client = browser(api); await register(client);
  assert.equal((await client.call('auth/change-password', { body: { currentPassword: 'wrong', password: 'another strong passphrase 59' } })).status, 400);
  assert.equal((await client.call('auth/change-password', { body: { currentPassword: password, password: 'another strong passphrase 59' } })).status, 200);
  assert.equal((await client.call('workspace')).status, 401);
  const failure = await api('auth/login', { body: { email: 'alex@example.test', password: 'wrong' } }); assert.equal(failure.status, 401);
  handler.store.db.prepare("UPDATE rate_limits SET used=20 WHERE key LIKE 'login-ip:%'").run();
  const limited = await api('auth/login', { body: { email: 'alex@example.test', password } }); assert.equal(limited.status, 429); assert.ok(limited.headers['Retry-After']);
});

test('two independent SQLite connections cannot double-book or lose updates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-sql-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'records.sqlite'); const a = new Store(file), b = new Store(file); t.after(() => { a.close(); b.close(); });
  const first = provider(a, profiles[0]), second = provider(b, profiles[1]); const datetime = first.slots()[0].id;
  first.commit('book', { datetime }, 'SR-2048');
  assert.throws(() => second.commit('book', { datetime }, 'SR-2076'), /no longer available/);
  a.update((d) => d.requirements.push({ id: 'a', scope: 'repair:alice', ticketId: 'SR-2048', note: 'A' }));
  b.update((d) => d.requirements.push({ id: 'b', scope: 'repair:bob', ticketId: 'SR-2076', note: 'B' }));
  assert.equal(a.data.requirements.length, 2);
  assert.equal(a.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal((await readFile(file)).subarray(0, 15).toString(), 'SQLite format 3');
});

test('Google consent uses PKCE and session-bound state; calendar availability, retries, and cancellation use real API contracts', async (t) => {
  let busyTime, event, inserts = 0, deletes = 0, availabilityError = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const data = new URLSearchParams(options.body);
      if (data.get('grant_type') === 'authorization_code') { assert.ok(data.get('code_verifier')); return Response.json({ refresh_token: 'private-refresh-token', access_token: 'initial-access' }); }
      assert.equal(data.get('refresh_token'), 'private-refresh-token'); return Response.json({ access_token: 'test-access' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      assert.equal(options.headers.Authorization, 'Bearer test-access');
      return Response.json({ calendars: { primary: availabilityError ? { errors: [{ reason: 'internalError' }] } : { busy: busyTime ? [{ start: busyTime, end: new Date(+new Date(busyTime) + 1800000).toISOString() }] : [] } } });
    }
    assert.match(url, /^https:\/\/www.googleapis.com\/calendar\/v3\/calendars\/primary\/events/);
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    if (options.method === 'POST') { event = JSON.parse(options.body); inserts++; return inserts === 1 ? Response.json({ error: 'temporary' }, { status: 503 }) : Response.json({}, { status: 409 }); }
    if (options.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    if (url.includes('/events?')) return Response.json({ items: busyTime ? [{ start: { dateTime: busyTime }, end: { dateTime: new Date(+new Date(busyTime) + 1800000).toISOString() } }] : [] });
    return Response.json(event);
  });
  const { api, handler } = setup(t, { config: { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' } });
  const client = browser(api); await registerCustomer(client, api);
  const connect = await client.call('integrations/google/connect', { body: {} }); const url = new URL(connect.data.url);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state'); const callback = 'integrations/google/callback?state=' + state + '&code=test-code';
  assert.equal((await client.call(callback)).status, 303); assert.equal((await client.call(callback)).status, 400);
  const encrypted = handler.store.db.prepare('SELECT encrypted_token FROM connections').get().encrypted_token;
  assert.ok(!encrypted.includes('private-refresh-token'));
  await client.call('request', { body: { title: 'Calendar request', issueDesc: 'Visit needed', confirmed: true } });
  const slots = (await client.call('slots')).data.slots; busyTime = slots[0].id;
  assert.ok(!(await client.call('slots')).data.slots.some((s) => s.id === busyTime));
  availabilityError = true; assert.equal((await client.call('slots')).status, 503); availabilityError = false;
  assert.equal((await client.call('book', { body: { datetime: 'not-a-time', confirmed: true } })).status, 400);
  assert.equal((await client.call('book', { body: { datetime: busyTime, confirmed: true } })).status, 409);
  const booked = await client.call('book', { body: { datetime: slots[1].id, confirmed: true } }); assert.equal(booked.status, 201);
  await handler.delivery.flush(); assert.equal(handler.store.data.outbox[0].status, 'pending');
  handler.store.update((data) => { data.outbox[0].nextAttemptAt = 0; });
  await handler.delivery.flush(); assert.equal(handler.store.data.outbox[0].status, 'delivered'); assert.equal(inserts, 2);
  assert.match(event.id, /^[0-9a-f]{64}$/);
  assert.equal((await client.call('book/cancel', { body: { id: booked.data.id, confirmed: true } })).status, 201);
  await handler.delivery.flush(); assert.equal(deletes, 1);
  assert.equal((await client.call('integrations/google', { method: 'DELETE' })).status, 200);
  assert.equal((await client.call('integrations/status')).data.google.connected, false);
});

test('real-account cookies cannot be reused as demo bearer tokens when demos are enabled', async (t) => {
  const { api } = setup(t, { config: { ENABLE_DEMO_MODE: 'true' } }); const client = browser(api); await register(client);
  assert.equal((await api('workspace', { token: client.cookie.split('=')[1] })).status, 401);
  const demo = await api('session', { body: { profileId: 'alice', pin: '246810' } });
  assert.equal(demo.status, 200); assert.equal((await api('workspace', { token: demo.data.token })).data.profile.demo, true);
});

test('concurrent handlers sharing SQLite replay one durable chat exchange', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-chat-race-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let waiting = 0, release; const barrier = new Promise((resolve) => { release = resolve; });
  const service = { configured: false, list: () => [], recall: async () => { if (++waiting === 2) release(); await barrier; return { facts: [], source: 'test' }; }, remember: async () => 'local' };
  const options = { file: join(directory, 'state.sqlite'), service, config: { ENABLE_DEMO_MODE: 'true' } };
  const a = setup(t, options), b = setup(t, options);
  const token = (await a.api('session', { body: { profileId: 'alice', pin: '246810' } })).data.token;
  const args = { token, headers: { 'idempotency-key': 'shared-chat' }, body: { message: 'What is my service status?' } };
  const [first, second] = await Promise.all([a.api('chat', args), b.api('chat', args)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.data.id, second.data.id);
  assert.equal((await a.api('conversation', { token })).data.messages.length, 1);
});

test('parallel delivery workers preserve reservation/cancellation ordering', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-outbox-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let enter, release; const entered = new Promise((r) => { enter = r; }), held = new Promise((r) => { release = r; }); const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails'); const email = JSON.parse(options.body); sent.push(email.subject);
    if (email.subject.endsWith('reserved')) { enter(); await held; }
    return Response.json({ id: 'mail-' + sent.length });
  });
  const options = { file: join(directory, 'queue.sqlite'), config: { RESEND_API_KEY: 'test-key', EMAIL_FROM: 'Continuum <no-reply@example.test>' } };
  const a = setup(t, options), b = setup(t, options);
  const slot = (await a.api('demo-slots')).data.slots[0];
  const reservation = await a.api('demo-bookings', { body: { name: 'Queue test', email: 'queue@example.test', plan: 'Growth', datetime: slot.id, confirmed: true } });
  const firstWorker = a.handler.delivery.flush(); await entered;
  await b.api('demo-bookings/manage', { body: { id: reservation.data.id, manageToken: reservation.data.manageToken, cancel: true, confirmed: true } });
  await b.handler.delivery.flush(); assert.equal(sent.length, 1);
  release(); await firstWorker; await b.handler.delivery.flush();
  assert.equal(sent.length, 2); assert.match(sent[0], /reserved$/); assert.match(sent[1], /cancelled$/);
});
