import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/evaluate.js';
import { decide } from '../server/decisions.js';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';

test('ten distinct support issues improve with memory and reject incompatible, missing, unrelated, and failed fixes', async () => {
  const r = await evaluate();
  assert.equal(r.error, undefined);
  assert.equal(r.cases.length, 10);
  assert.deepEqual(
    r.cases.filter((c) => !c.passed),
    [],
  );
  assert.equal(r.counts.positiveQuestions, 20);
  assert.equal(r.counts.correctMemoryOn, 20);
  assert.equal(r.counts.correctMemoryOff, 0);
  assert.equal(r.counts.memoryOffWithheld, 20);
  assert.equal(r.counts.incorrectRecommendations, 0);
  assert.equal(r.counts.failedFixRepeated, 0);
});
test('natural actions are proposals; missing, hypothetical, and negated requests never fabricate details', async () => {
  const ticket = { id: 'owned-ticket', status: 'Open' },
    facts = [],
    learned = { facts: [] };
  const ask = (message) => decide({ message, ticket, facts, learned });
  assert.equal(
    (await ask('Please leave a note saying call before ordering parts.')).action.note,
    'call before ordering parts.',
  );
  assert.equal((await ask('Could you raise a ticket for the broken keyboard?')).action.kind, 'request');
  assert.equal((await ask('Please create a ticket')).mode, 'clarify');
  assert.equal((await ask('Do not book an appointment.')).action, null);
  assert.equal((await ask('What happens if I book an appointment?')).action, null);
  assert.equal((await ask('My device is broken and nothing helped.')).mode, 'handoff');
});
test('an ungrounded model action cannot add invented note text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ intent: 'note', confidence: 1, text: 'Invented instruction' }),
          },
        },
      ],
    }),
  );
  const d = await decide(
    {
      message: 'Could you help with a note?',
      ticket: { id: 'owned', status: 'Open' },
      facts: [],
      learned: { facts: [] },
    },
    { OPENAI_API_KEY: 'synthetic' },
  );
  assert.equal(d.action, null);
});
test('explicit human help remains available when model and memory services are unavailable', async (t) => {
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called++;
    throw new Error('Offline');
  });
  const h = createHandler({
    config: { ENABLE_DEMO_MODE: 'true', REQUIRE_LIVE_INTEGRATIONS: 'true' },
    service: {
      configured: true,
      list: () => [],
      recall: async () => {
        throw new Error('Offline');
      },
      remember: async () => 'pending',
    },
  });
  t.after(() => h.close());
  const token = (await invoke(h, 'session', { body: { profileId: 'alice', pin: '246810' } })).data.token;
  const r = await invoke(h, 'chat', {
    token,
    body: { message: 'Please get a human specialist to help me.' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.action.kind, 'handoff');
  assert.equal(r.data.model, 'Support workflow');
  assert.equal(called, 0);
});
