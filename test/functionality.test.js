import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHandler } from '../server/app.js';
import { Store } from '../server/providers.js';
import { invoke } from '../scripts/invoke.js';

function setup(options = {}) {
  const handler = createHandler({ ...options, config: { ENABLE_DEMO_MODE: 'true', ...options?.config } });
  const api = (path, args) => invoke(handler, path, args);
  const login = async (profileId = 'alice') => (await api('session', { body: { profileId, pin: '246810' } })).data.token;
  return { api, login };
}
const submission = (key) => ({ 'idempotency-key': key });

test('action retries are atomic, concurrent-safe, and persist across restarts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supportly-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  const { api, login } = setup({ file }); const token = await login();
  const args = { token, headers: submission('create-request-1'), body: { title: 'Trackpad', issueDesc: 'Trackpad will not click', confirmed: true } };
  const [first, second] = await Promise.all([api('request', args), api('request', args)]);
  assert.equal(first.status, 201); assert.deepEqual(first.data, second.data);
  assert.equal((await api('workspace', { token })).data.tickets.length, 2);
  const restarted = setup({ file }); const later = await restarted.login();
  const replay = await restarted.api('request', { ...args, token: later });
  assert.equal(replay.data.ticketId, first.data.ticketId);
  assert.equal((await restarted.api('workspace', { token: later })).data.tickets.length, 2);
  assert.equal((await restarted.api('request', { ...args, token: later, body: { ...args.body, title: 'Different request' } })).status, 409);
});

test('chat survives restart; retries do not duplicate it; comparison leaves no history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supportly-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true })); const file = join(directory, 'state.json');
  const { api, login } = setup({ file }); const token = await login();
  const options = { token, headers: submission('chat-once'), body: { message: 'Please email before replacing parts.', memory: false } };
  const [a, b] = await Promise.all([api('chat', options), api('chat', options)]);
  assert.equal(a.status, 200); assert.equal(a.data.id, b.data.id);
  assert.equal((await api('memory', { token })).data.ledger.length, 1);
  assert.equal((await api('conversation', { token })).data.messages.length, 1);
  const before = (await api('analytics', { token })).data;
  await api('chat', { token, body: { message: 'Current status?', retain: false } });
  assert.deepEqual((await api('analytics', { token })).data, before);
  const restarted = setup({ file }); const later = await restarted.login();
  assert.equal((await restarted.api('conversation', { token: later })).data.messages[0].response.id, a.data.id);
  assert.equal((await api('conversation/archive', { token, body: { confirmed: false } })).status, 400);
  assert.equal((await api('conversation/archive', { token, body: { confirmed: true } })).status, 200);
  assert.equal((await api('conversation', { token })).data.messages.length, 0);
});

test('outcomes update both provider schemas without requiring memory', async () => {
  const { api, login } = setup();
  for (const name of ['alice', 'carol']) {
    const token = await login(name);
    const resolved = await api('outcome', { token, body: { outcome: 'resolved', note: 'Service is working again.', confirmed: true, memory: false } });
    assert.equal(resolved.status, 201); assert.equal(resolved.data.status, 'Resolved');
    assert.equal((await api('status', { token })).data.status, 'Resolved');
    assert.equal((await api('analytics', { token })).data.resolved, 1);
    assert.equal((await api('memory', { token })).data.ledger.length, 1);
    const reopened = await api('outcome', { token, body: { outcome: 'failed', note: 'The issue returned.', confirmed: true } });
    assert.equal(reopened.data.status, 'Reopened');
    assert.equal((await api('analytics', { token })).data.open, 1);
  }
});

test('appointments can be cancelled only by their owner and cancellation releases the slot', async () => {
  const { api, login } = setup(); const alice = await login(), bob = await login('bob');
  const slot = (await api('slots', { token: alice })).data.slots[0];
  const booked = await api('book', { token: alice, body: { datetime: slot.id, confirmed: true } });
  assert.equal(booked.status, 201);
  const body = { id: booked.data.id, confirmed: true };
  assert.equal((await api('book/cancel', { token: bob, body })).status, 404);
  assert.equal((await api('book/cancel', { token: alice, body: { ...body, confirmed: false } })).status, 400);
  const cancel = { token: alice, body, headers: submission('cancel-visit') };
  assert.equal((await api('book/cancel', cancel)).status, 201);
  assert.equal((await api('book/cancel', cancel)).status, 201);
  assert.ok((await api('slots', { token: bob })).data.slots.some((s) => s.id === slot.id));
  const t = (await api('status', { token: alice })).data;
  assert.ok(t.appointments[0].cancelledAt);
  assert.equal((await api('analytics', { token: alice })).data.appointments, 0);
});

test('public reservations enforce capacity, input validation, replay, and private management', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supportly-calendar-'));
  t.after(() => rm(directory, { recursive: true, force: true })); const file = join(directory, 'state.json');
  const { api } = setup({ file });
  const { slots } = (await api('demo-slots')).data; assert.ok(slots.length > 0);
  const body = { name: 'Demo tester', email: 'demo@example.com', plan: 'Growth', datetime: slots[0].id, confirmed: true };
  assert.equal((await api('demo-bookings', { body: { ...body, email: 'invalid' } })).status, 400);
  assert.equal((await api('demo-bookings', { body: { ...body, confirmed: false } })).status, 400);
  const options = { body, headers: submission('reserve-slot') };
  const [a, b] = await Promise.all([api('demo-bookings', options), api('demo-bookings', options)]);
  assert.equal(a.status, 201); assert.equal(a.data.id, b.data.id);
  assert.equal((await api('demo-bookings', { body: { ...body, email: 'other@example.com' } })).status, 409);
  assert.ok(!(await api('demo-slots')).data.slots.some((s) => s.id === slots[0].id));
  const restarted = setup({ file }); const replay = await restarted.api('demo-bookings', options);
  assert.equal(replay.data.id, a.data.id); assert.ok(!('email' in replay.data));
  assert.equal((await api('demo-bookings/manage', { body: { id: a.data.id, manageToken: 'wrong' } })).status, 404);
  const manage = { id: a.data.id, manageToken: a.data.manageToken, cancel: true, confirmed: true };
  assert.equal((await api('demo-bookings/manage', { body: manage })).data.status, 'Cancelled');
  assert.equal((await api('demo-bookings/manage', { body: manage })).data.status, 'Cancelled');
  assert.ok((await api('demo-slots')).data.slots.some((s) => s.id === slots[0].id));
});

test('feedback is account-scoped and changing a rating does not inflate its count', async () => {
  const { api, login } = setup(); const token = await login(), other = await login('bob');
  const chat = await api('chat', { token, body: { message: 'How is my repair?' } });
  const body = { id: chat.data.id, rating: 5 };
  assert.equal((await api('feedback', { token: other, body })).status, 404);
  assert.equal((await api('feedback', { token, body: { ...body, rating: 4 } })).status, 400);
  await api('feedback', { token, body });
  assert.equal((await api('analytics', { token })).data.satisfaction, 100);
  await api('feedback', { token, body: { ...body, rating: 1 } });
  const stats = (await api('analytics', { token })).data;
  assert.equal(stats.ratings, 1); assert.equal(stats.satisfaction, 0);
  assert.equal((await api('conversation', { token: other })).data.messages.length, 0);
});

test('notes and handoffs are visible only within the owning account', async () => {
  const { api, login } = setup(); const token = await login(), other = await login('bob');
  await api('requirement', { token, body: { note: 'Call first.', confirmed: true } });
  await api('handoff', { token, body: { summary: 'Need a specialist.', confirmed: true } });
  const own = (await api('status', { token })).data;
  assert.equal(own.requirements[0].note, 'Call first.'); assert.equal(own.handoffs[0].status, 'Queued');
  assert.equal((await api('status?ticketId=SR-2048', { token: other })).status, 404);
  assert.equal((await api('status', { token: other })).data.requirements.length, 0);
});

test('memory avoids duplicate preferences and later resolution suppresses failed-fix recovery', async () => {
  const { api, login } = setup(); const token = await login('bob');
  for (let i = 0; i < 2; i++) await api('chat', { token, body: { message: 'Please email me before replacing parts.' } });
  assert.equal((await api('memory', { token })).data.ledger.filter((m) => m.kind === 'preference').length, 1);
  await api('outcome', { token, body: { outcome: 'resolved', note: 'Connectivity restored.', confirmed: true } });
  const response = await api('chat', { token, body: { message: 'What should I try for my phone?', retain: false } });
  assert.equal(response.data.action, null); assert.match(response.data.reply, /resolved/);
  assert.ok(!response.data.evidence.some((e) => e.kind === 'failed'));
});

test('revoked sessions, malformed flags, cross-site requests and invalid dates are rejected', async () => {
  const { api, login } = setup(); const token = await login();
  assert.equal((await api('chat', { token, body: { message: 'hello', memory: 'false' } })).status, 400);
  assert.equal((await api('slots?from=invalid', { token })).status, 400);
  assert.equal((await api('request', { token, body: { confirmed: true, title: 'X', issueDesc: 'Y' }, headers: { origin: 'https://evil.example', host: 'localhost' } })).status, 403);
  assert.equal((await api('chat', { token, body: { message: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await api('session', { token, method: 'DELETE' })).status, 200);
  const denied = await api('workspace', { token });
  assert.equal(denied.status, 401); assert.ok(denied.data.requestId); assert.equal(denied.data.code, 'SESSION_EXPIRED');
  assert.equal((await api('health')).data.status, 'ok');
});

test('legacy data migrates without resetting records; invalid stores fail explicitly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supportly-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true })); const file = join(directory, 'state.json');
  const old = new Store().data;
  delete old.operations; delete old.conversations; delete old.demoBookings;
  old.repair[0].status = 'Custom persisted status'; await writeFile(file, JSON.stringify(old));
  const next = new Store(file);
  assert.equal(next.data.repair[0].status, 'Custom persisted status'); assert.deepEqual(next.data.conversations, []);
  // Migration is one-time: later JSON changes cannot replace database records.
  await writeFile(file, JSON.stringify({ memories: [] }));
  assert.equal(new Store(file).data.repair[0].status, 'Custom persisted status');
  const invalid = join(directory, 'invalid.json');
  await writeFile(invalid, JSON.stringify({ memories: [] }));
  assert.throws(() => new Store(invalid), /Invalid data store/);
});

test('a memory outage cannot roll back a committed provider action or duplicate it on retry', async () => {
  const service = { configured: true, remember: async () => { throw new Error('Offline'); }, list: () => [] };
  const { api, login } = setup({ service }); const token = await login();
  const options = { token, body: { title: 'Battery', issueDesc: 'Battery replacement.', confirmed: true }, headers: submission('committed-offline') };
  const response = await api('request', options);
  assert.equal(response.status, 201); assert.equal(response.data.retained, 'pending');
  assert.equal((await api('request', options)).data.ticketId, response.data.ticketId);
  assert.equal((await api('workspace', { token })).data.tickets.length, 2);
});

test('retiring an already retired memory is safe to retry without another audit event', async () => {
  const { api, login } = setup(); const token = await login();
  const id = (await api('memory', { token })).data.ledger[0].id;
  const options = { token, method: 'PATCH', body: { id } };
  assert.equal((await api('memory', options)).status, 200);
  assert.equal((await api('memory', options)).status, 200);
  const events = (await api('workspace', { token })).data.activity.filter((a) => a.kind === 'invalidate');
  assert.equal(events.length, 1);
});

test('calendar exports convert IST to UTC and preserve a stable booking identifier', async (t) => {
  const { calendarLink } = await import('../web/client.js'); let content;
  t.mock.method(URL, 'createObjectURL', (blob) => { content = blob; return 'blob:calendar-test'; });
  assert.equal(calendarLink({ id: 'visit-123', datetime: '2026-11-09T10:00:00+05:30' }), 'blob:calendar-test');
  const text = await content.text();
  assert.match(text, /DTSTART:20261109T043000Z/);
  assert.match(text, /DTEND:20261109T050000Z/);
  assert.match(text, /UID:visit-123@supportly.local/);
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
});

test('a chat proposal can only be confirmed once, even with a new submission key', async () => {
  const { api, login } = setup(); const token = await login();
  const chat = await api('chat', { token, body: { message: 'note: Please call before repair.' } });
  const options = { token, headers: submission('proposal-first'), body: { note: 'Please call before repair.', proposalId: chat.data.id, confirmed: true } };
  assert.equal((await api('requirement', options)).status, 201);
  assert.equal((await api('requirement', options)).status, 201);
  assert.equal((await api('requirement', { ...options, headers: submission('proposal-second') })).status, 409);
  const messages = (await api('conversation', { token })).data.messages;
  assert.ok(messages[0].response.action.completedAt);
  assert.equal((await api('status', { token })).data.requirements.length, 1);
});
