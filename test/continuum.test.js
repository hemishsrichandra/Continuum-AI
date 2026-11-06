import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';

function start(options) {
  const handler = createHandler({ config: {}, ...options });
  const api = (route, args) => invoke(handler, route, args);
  const login = async (profileId) => (await api('session', { body: { profileId, pin: '246810' } })).data;
  return { api, login };
}

test('same provider record, three different reasons to recall memory', async () => {
  const { api, login } = start();
  const cases = [
    ['alice', 'preference', 'callback', null],
    ['bob', 'failed', 'earlier fix failed|human handoff', 'handoff'],
    ['carol', 'missed', 'human handoff', 'handoff'],
  ];
  for (const [profileId, kind, pattern, action] of cases) {
    const { token, profile } = await login(profileId);
    const ask = async (memory) => (await api('chat', { token, body: { message: profile.prompt, memory, retain: false } })).data;
    const off = await ask(false);
    const on = await ask(true);
    assert.deepEqual(on.ticket, off.ticket);
    assert.equal(off.trace.recalled, 0);
    assert.equal(off.action, null);
    assert.equal(on.trace.recalled, 1);
    assert.equal(on.evidence[1].kind, kind);
    assert.match(on.reply, new RegExp(pattern, 'i'));
    assert.equal(on.action?.kind ?? null, action);
    if (profileId === 'bob') assert.match(off.reply, /try restarting/);
  }
});

test('confirmed actions survive restart, isolate accounts and reject a slot collision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, 'demo.json');
  const { api, login } = start({ file });
  const { token, profile } = await login('alice');
  const { token: other } = await login('bob');
  const ticketId = profile.ticketId;
  assert.equal((await api('workspace')).status, 401);
  assert.equal((await api('status?ticketId=' + ticketId, { token: other })).status, 404);
  assert.equal((await api('requirement', { token, body: { ticketId, note: 'Call first' } })).status, 400);
  const post = (path, fields) => api(path, { token, body: { ticketId, confirmed: true, ...fields } });
  const request = await post('request', { title: 'Keyboard', issueDesc: 'A key sticks.' });
  assert.equal(request.status, 201);
  assert.equal((await post('requirement', { note: 'Call before replacing the keyboard.' })).status, 201);
  const { data: { slots } } = await api('slots', { token });
  const bookings = await Promise.all([post('book', { datetime: slots[0].id }), post('book', { datetime: slots[0].id })]);
  assert.deepEqual(bookings.map((result) => result.status).sort(), [201, 409]);
  const handoff = await post('handoff', { summary: 'Follow up on the repair' });
  assert.equal(handoff.data.status, 'Queued');
  assert.equal(handoff.data.context.ticket.id, ticketId);
  assert.ok(handoff.data.context.memories.length > 0);
  const restarted = start({ file });
  const session = await restarted.login('alice');
  const workspace = await restarted.api('workspace', { token: session.token });
  assert.ok(workspace.data.tickets.some((ticket) => ticket.id === request.data.ticketId));
  assert.equal(workspace.data.activity.filter((entry) => entry.kind === 'book').length, 1);
});

test('a fresh session recalls a newly retained preference until it is retired', async () => {
  const { api, login } = start();
  const { token } = await login('alice');
  const message = 'Please email me before ordering a replacement screen.';
  const remembered = await api('chat', { token, body: { message } });
  assert.equal(remembered.data.retained, 'local');
  const later = await login('alice');
  const recall = async () => (await api('memory?query=replacement+screen', { token: later.token })).data;
  const before = await recall();
  const item = before.ledger.find((memory) => memory.text === message);
  assert.ok(before.facts.some((fact) => fact.id === item.id));
  assert.equal((await api('memory', { token: later.token, method: 'PATCH', body: { id: item.id } })).status, 200);
  const after = await recall();
  assert.ok(after.ledger.find((memory) => memory.id === item.id).invalidatedAt);
  assert.ok(!after.facts.some((fact) => fact.id === item.id));
});

test('live mode uses the Hindsight and model REST contracts', async (t) => {
  const documents = new Map();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ pathname, method: options.method });
    if (pathname === '/v1/chat/completions') {
      assert.equal(options.headers.Authorization, 'Bearer model-key');
      const context = JSON.parse(body.messages[1].content);
      assert.equal(context.liveTicket.id, 'SR-2048');
      return Response.json({ choices: [{ message: { content: 'Provider update from the test model.' } }] });
    }
    assert.equal(options.headers.Authorization, 'Bearer hindsight-key');
    assert.match(pathname, /^\/v1\/default\/banks\/test-repair-alice/);
    if (options.method === 'PUT') return Response.json({});
    if (pathname.endsWith('/memories') && options.method === 'POST') {
      for (const item of body.items) {
        assert.deepEqual(item.tags, ['ticket:SR-2048']);
        documents.set(item.document_id, { id: item.document_id + '-fact', document_id: item.document_id, text: item.content, state: 'valid' });
      }
      return Response.json({});
    }
    if (pathname.endsWith('/memories/recall')) {
      assert.deepEqual(body.tags, ['ticket:SR-2048']);
      return Response.json({ results: [...documents.values()].filter((item) => item.state === 'valid') });
    }
    if (pathname.endsWith('/reflect')) {
      assert.equal(body.tags_match, 'all_strict');
      return Response.json({ text: 'Scoped reflection.' });
    }
    if (pathname.endsWith('/memories/list')) {
      const item = documents.get(searchParams.get('document_id'));
      return Response.json({ items: [item], total: 1 });
    }
    if (options.method === 'PATCH') {
      assert.equal(body.state, 'invalidated');
      const fact = [...documents.values()].find((item) => pathname.endsWith('/' + encodeURIComponent(item.id)));
      fact.state = 'invalidated';
      return Response.json(fact);
    }
    assert.fail('Unexpected path ' + pathname);
  });
  const { api, login } = start({ config: {
    HINDSIGHT_BASE_URL: 'https://hindsight.example',
    HINDSIGHT_API_KEY: 'hindsight-key',
    HINDSIGHT_BANK_PREFIX: 'test',
    OPENAI_API_KEY: 'model-key',
    REQUIRE_LIVE_INTEGRATIONS: 'true',
  } });
  const { token, profile } = await login('alice');
  const off = await api('chat', { token, body: { message: profile.prompt, memory: false } });
  assert.equal(off.data.trace.memory, 'Disabled');
  assert.equal(calls.length, 1);
  const on = await api('chat', { token, body: { message: profile.prompt } });
  assert.equal(on.data.trace.memory, 'Hindsight');
  assert.equal(on.data.evidence[1].kind, 'preference');
  const reflected = await api('reflect', { token, body: { ticketId: profile.ticketId } });
  assert.equal(reflected.data.text, 'Scoped reflection.');
  const id = [...documents.keys()][0];
  assert.equal((await api('memory', { token, method: 'PATCH', body: { id } })).status, 200);
  const { data } = await api('memory?query=callback', { token });
  assert.equal(data.facts.length, 0);
});
