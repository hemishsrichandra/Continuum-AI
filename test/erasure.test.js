import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createFakeChroma } from './fake-chroma.js';

const PHONE = '415 555 0100';
const everywhere = (w) => JSON.stringify({ store: w.h.store.data, ctx: w.db().prepare('SELECT context FROM troubleshooting_context').all(), att: w.db().prepare('SELECT context,snapshot FROM troubleshooting_attempts').all() });

async function scene(t, { config = {}, vectorClient } = {}) {
  const w = await world(t, { config, vectorClient });
  const a = await w.customer('alice');
  const ta = await w.ticket(a, ISSUE);
  await w.ask(a, ta, `Please email me. My phone is ${PHONE}. Model X firmware 4.`);
  await w.ask(a, ta, ISSUE);
  return { w, a, ta };
}

// ---------------------------------------------------------------------------------------------- Test 17
test('erasure: the customer’s details are gone from every place the application claims to have erased', async (t) => {
  const { w, a, ta } = await scene(t);
  // A specialist hand-over copies the conversation into the case file and the audit trail.
  const handoff = (await a.api('handoff', { ticketId: ta, summary: `Display flickers; reach me on ${PHONE}`, confirmed: true })).data;
  assert.ok(everywhere(w).includes(PHONE), 'the data is stored before erasure');
  // Resolve the case so its summary is no longer needed to finish the work.
  w.h.store.update((d) => { d.handoffs.find((h) => h.id === handoff.id).status = 'Resolved'; });
  // Idempotent replays echo what the customer wrote.
  const key = { operationKey: 'op-123' };
  await w.ask(a, ta, `Remember my phone ${PHONE}`, key);

  const result = (await a.api('privacy/erase', { confirmed: true })).data;
  assert.equal(result.success, true);
  assert.ok(result.erased.conversations >= 2);
  assert.ok(result.erased.diagnosticContext >= 1 || result.erased.rememberedContext >= 1);
  const left = everywhere(w);
  assert.ok(!left.includes(PHONE), 'no copy of the phone number remains in conversations, case files, audit, operations or troubleshooting context');
  // The statement of what was kept is honest and non-empty.
  assert.ok(result.kept.some((k) => /requests/i.test(k)));
  assert.equal(result.external.failed, 0);
});

test('erasure keeps an open case’s summary so work can finish, and says so', async (t) => {
  const { w, a, ta } = await scene(t);
  await a.api('handoff', { ticketId: ta, summary: 'Display flickers after startup', confirmed: true });
  const before = w.h.store.data.handoffs.filter((h) => h.ticketId === ta).map((h) => h.summary);
  assert.ok(before.length >= 1);
  const result = (await a.api('privacy/erase', { confirmed: true })).data;
  assert.ok(result.kept.some((k) => /still-open case/.test(k)));
  assert.deepEqual(w.h.store.data.handoffs.filter((h) => h.ticketId === ta).map((h) => h.summary), before);
});

// ---------------------------------------------------------------------------------------------- Test 18
test('a failed remote deletion stays visible as a retryable task and completes once the service recovers', async (t) => {
  const { w, a, ta } = await scene(t);
  const calls = [];
  let down = true;
  w.h.memory.invalidate = async (...args) => { calls.push(args); if (down) throw new Error('remote memory service is down'); };
  const run = (await a.api('privacy/erase', { confirmed: true, ticketId: ta })).data;
  const tasks = w.db().prepare('SELECT * FROM erasure_tasks WHERE company_id=?').all(w.company);
  assert.ok(tasks.length >= 1, 'a durable task exists for each remote copy');
  assert.ok(run.external.pending >= 1 && run.external.failed === 0, 'the removal is pending, not silently dropped');
  assert.ok(tasks.every((x) => x.status === 'pending' && x.attempts >= 1 && /down/.test(x.last_error)));
  assert.match(run.note, /retried automatically/);
  assert.equal(w.h.privacy.erasureStatus(w.company).attention.length, tasks.length, 'visible to operators');
  // The local record is already blanked; only the remote copy is outstanding.
  assert.ok(w.h.store.data.memories.filter((m) => m.ticketId === ta).every((m) => m.text === '[removed at the customer’s request]'));
  // Idempotent: erasing again does not duplicate the tasks.
  await a.api('privacy/erase', { confirmed: true, ticketId: ta });
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM erasure_tasks WHERE company_id=?').get(w.company).n, tasks.length);
  // Before the backoff elapses nothing is retried; after it, the same tasks complete.
  const early = await w.h.privacy.processTasks({ at: Date.now() });
  assert.deepEqual(early, { done: 0, failed: 0, retrying: 0 });
  down = false;
  const retried = await w.h.privacy.processTasks({ at: Date.now() + 3 * 3600000 });
  assert.equal(retried.done, tasks.length);
  assert.equal(w.h.privacy.erasureStatus(w.company).pending, 0);
  assert.ok(calls.length > tasks.length, 'it was attempted again after failing');
  // A task that can never succeed is reported as failed instead of retrying forever.
  w.db().prepare("INSERT INTO erasure_tasks(id,company_id,kind,target,payload_json,created_at) VALUES('x',?,'mystery','t','{}',?)").run(w.company, new Date().toISOString());
  assert.equal((await w.h.privacy.processTasks()).failed, 1);
  assert.equal(w.h.privacy.erasureStatus(w.company).failed, 1);
});

// ---------------------------------------------------------------------------------------------- vectors
test('withdrawing fixes learned from erased requests removes them from search and the vector index', async (t) => {
  const fake = createFakeChroma();
  const { w, a, ta } = await scene(t, { config: { VECTOR_STORE: 'chroma', CHROMA_URL: 'http://chroma.test:8000' }, vectorClient: fake.client });
  const learned = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'erase:1' });
  w.db().prepare('UPDATE memory_pool SET source_ticket_id=? WHERE id=?').run(ta, learned.id);
  await w.h.vectorIndex.drain();
  assert.ok(fake.collection().rows.has(learned.id));
  // Default: shared (de-identified) knowledge stays, only the link to the request is removed.
  const plain = (await a.api('privacy/erase', { confirmed: true, ticketId: ta })).data;
  assert.equal(plain.erased.unlinkedKnowledge, 1);
  assert.equal(w.db().prepare('SELECT status FROM memory_pool WHERE id=?').get(learned.id).status, 'active');
  // Opt-in: withdraw what was learned from the request.
  w.db().prepare('UPDATE memory_pool SET source_ticket_id=? WHERE id=?').run(ta, learned.id);
  await a.api('conversation/archive', { ticketId: ta, confirmed: true }).catch(() => {});
  const ta2 = await w.ticket(a, ISSUE, 'Again');
  w.db().prepare('UPDATE memory_pool SET source_ticket_id=? WHERE id=?').run(ta2, learned.id);
  await w.ask(a, ta2, ISSUE);
  const withdrawn = (await a.api('privacy/erase', { confirmed: true, ticketId: ta2, retireSharedKnowledge: true })).data;
  assert.equal(withdrawn.erased.withdrawnKnowledge, 1, JSON.stringify(withdrawn.erased));
  assert.equal(w.db().prepare('SELECT status FROM memory_pool WHERE id=?').get(learned.id).status, 'retired');
  assert.equal((await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: ISSUE })).eligible.some((c) => c.id === learned.id), false);
  await w.h.vectorIndex.drain();
  assert.ok(!fake.collection().rows.has(learned.id), 'and from the vector index');
});
