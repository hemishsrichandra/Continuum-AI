import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createFakeChroma } from './fake-chroma.js';

const CHROMA = { VECTOR_STORE: 'chroma', CHROMA_URL: 'http://chroma.test:8000' };

test('system status: owners see plain-language health; nothing leaks across companies or to non-owners', async (t) => {
  const fake = createFakeChroma();
  const w = await world(t, { config: CHROMA, vectorClient: fake.client });
  const c = await w.customer('alice');
  assert.equal((await c.api('company/system-health')).status, 403, 'customers cannot read it');
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'h:1' });
  w.seed(w.companyB, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'h:2' });
  const before = (await w.owner.api('company/system-health')).data;
  assert.equal(before.summary.search.state, 'updating');
  assert.ok(before.summary.search.pending >= 1);
  await w.h.vectorIndex.drain();
  const ready = (await w.owner.api('company/system-health')).data;
  assert.equal(ready.summary.search.state, 'ready');
  assert.equal(ready.summary.tasks.state, 'ok');
  assert.ok(!JSON.stringify(ready).includes('chroma.test'), 'the vector database address is never exposed');
  // Company B's counts are its own.
  const other = (await w.other.api('company/system-health')).data;
  assert.equal(other.details.knowledge.indexed + other.details.knowledge.pending > 0, true);
  // An outage is reported plainly, with a retry that works once the index is back.
  fake.state.down = true;
  w.db().prepare("UPDATE memory_pool SET title='Display flicker changed' WHERE company_id=? AND source_key='h:1'").run(w.company);
  await w.h.vectorIndex.drain();
  const down = (await w.owner.api('company/system-health')).data;
  assert.equal(down.summary.search.state, 'limited');
  fake.state.down = false;
  w.db().prepare("UPDATE vector_index_state SET status='failed',attempts=8,last_error='x' WHERE company_id=?").run(w.company);
  const failed = (await w.owner.api('company/system-health')).data;
  assert.equal(failed.summary.tasks.state, 'attention');
  assert.equal((await w.other.api('company/system-health')).data.details.knowledge.failed, 0, 'company A’s failures are not shown to company B');
  const retried = (await w.owner.api('company/system-health', {})).data;
  assert.equal(retried.details.knowledge.failed, 0, 'retrying re-queues failed work');
});

test('without a vector index the status says "basic mode" instead of failing', async (t) => {
  const w = await world(t);
  const h = (await w.owner.api('company/system-health')).data;
  assert.equal(h.summary.search.state, 'basic');
  assert.equal(h.details.vectorIndex.configured, false);
  assert.equal(h.details.embedding.neural, false);
  void ISSUE;
});
