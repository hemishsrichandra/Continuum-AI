import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createFakeChroma } from './fake-chroma.js';
import { createVectorIndex } from '../server/vector-index.js';

const CHROMA = { VECTOR_STORE: 'chroma', CHROMA_URL: 'http://chroma.test:8000' };
async function setup(t) {
  const fake = createFakeChroma();
  const w = await world(t, { config: CHROMA, vectorClient: fake.client });
  const row = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'ix:1' });
  await w.h.vectorIndex.drain();
  const state = () => w.db().prepare('SELECT * FROM vector_index_state WHERE memory_id=?').get(row.id);
  const vector = () => fake.collection().rows.get(row.id);
  const requeue = () => w.db().prepare("UPDATE vector_index_state SET status='pending',indexed_hash=NULL,next_attempt_at=0 WHERE memory_id=?").run(row.id);
  // An embedder that waits for a gate (a slow provider), sharing the model identity of the real one.
  const slow = () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const embedding = { ...w.h.embedding, modelId: w.h.embedding.modelId, embedDocuments: async (texts) => { await gate; return w.h.embedding.embedDocuments(texts); } };
    return { index: createVectorIndex(w.h.store, { vectors: w.h.vectors, embedding }), release };
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  return { w, fake, row, state, vector, requeue, slow, tick };
}

// ---------------------------------------------------------------------------------------------- F3
test('F3: a worker that was slow cannot mark a retired passport indexed or write its vector', async (t) => {
  const { w, row, state, vector, requeue, slow, tick } = await setup(t);
  requeue();
  const a = slow();
  const running = a.index.processPending();
  await tick();
  w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(row.id); // retired while the old worker is embedding
  a.release();
  const result = await running;
  assert.equal(result.indexed, 0);
  assert.equal(result.stale, 1);
  assert.equal(state().status, 'pending', 'the newer pending state is not overwritten');
  assert.ok(vector(), 'the earlier vector is still there until the newer job removes it');
  await w.h.vectorIndex.drain();
  assert.equal(state().status, 'absent');
  assert.equal(vector(), undefined, 'final index state matches SQLite (retired = absent)');
});

test('F3: a revision made during embedding wins; the stale document is never written', async (t) => {
  const { w, row, state, vector, requeue, slow, tick } = await setup(t);
  const before = vector().meta.doc_hash;
  requeue();
  const a = slow();
  const running = a.index.processPending();
  await tick();
  w.db().prepare('UPDATE memory_pool SET steps_json=? WHERE id=?').run(JSON.stringify(['Install the approved display driver 4.2 and restart.']), row.id);
  a.release();
  await running;
  assert.equal(state().status, 'pending');
  assert.equal(vector().meta.doc_hash, before, 'the stale worker did not overwrite the vector');
  await w.h.vectorIndex.drain();
  assert.equal(state().status, 'indexed');
  const fresh = w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(row.id);
  assert.equal(vector().meta.doc_hash, w.h.vectorIndex.hashOf(fresh), 'the index holds the CURRENT document');
  assert.equal(state().indexed_hash, w.h.vectorIndex.hashOf(fresh));
});

test('F3: two workers, expired lease and a restart: only the current claim can finish', async (t) => {
  const { w, row, state, vector, requeue, slow, tick } = await setup(t);
  requeue();
  // Worker A claims and stalls (a crashed or very slow process). Its lease then expires and worker B takes over and finishes.
  const a = slow();
  const stalled = a.index.processPending({ at: Date.now() });
  await tick();
  assert.equal(state().status, 'processing');
  const early = await w.h.vectorIndex.processPending({ at: Date.now() + 1000 });
  assert.equal(early.indexed + early.unchanged + early.removed, 0, 'the lease is still valid: nobody else may claim it');
  const takeover = await w.h.vectorIndex.drain({ at: Date.now() + 3 * 60000 });
  assert.equal(takeover.indexed, 1);
  assert.equal(state().status, 'indexed');
  // A wakes up much later: its claim is gone, so it writes nothing and changes nothing.
  a.release();
  const late = await stalled;
  assert.equal(late.indexed, 0);
  assert.equal(late.stale, 1);
  assert.equal(state().status, 'indexed');
  assert.ok(vector());
});

test('F3: duplicate delivery - two workers draining at once produce exactly one vector and one consistent state', async (t) => {
  const { w, fake, row, state, vector, requeue } = await setup(t);
  requeue();
  const other = createVectorIndex(w.h.store, { vectors: w.h.vectors, embedding: w.h.embedding });
  const [r1, r2] = await Promise.all([w.h.vectorIndex.drain(), other.drain()]);
  assert.equal(r1.indexed + r2.indexed, 1, 'only one of them did the work');
  assert.equal(state().status, 'indexed');
  assert.equal([...fake.collection().rows.keys()].filter((id) => id === row.id).length, 1);
  assert.ok(vector());
});

test('F3: a stale write that DID reach the store is repaired by the next worker', async (t) => {
  const { w, fake, row, state, vector, requeue } = await setup(t);
  // The old worker's upsert is delayed in the network. Meanwhile the passport is retired and a newer worker removes and settles it.
  requeue();
  const newer = createVectorIndex(w.h.store, { vectors: w.h.vectors, embedding: w.h.embedding });
  let injected = false;
  fake.state.beforeUpsert = async () => {
    if (injected) return;
    injected = true;
    w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(row.id);
    fake.collection().rows.delete(row.id);
    await newer.drain(); // the newer job finishes first: state is 'absent'
  };
  const first = await w.h.vectorIndex.processPending();
  assert.equal(first.indexed, 0);
  assert.ok(first.stale >= 1);
  assert.ok(vector(), 'the late stale write landed after the newer job finished');
  assert.equal(state().status, 'pending', 'but the job was put back in the queue instead of trusting the stale result');
  fake.state.beforeUpsert = null;
  await w.h.vectorIndex.drain();
  assert.equal(state().status, 'absent');
  assert.equal(vector(), undefined, 'repaired: the retired passport has no vector');
});

test('F3: a transient failure retries with the same claim rules and never leaves a false "indexed"', async (t) => {
  const { w, fake, row, state, vector, requeue } = await setup(t);
  requeue();
  fake.state.down = true;
  const failed = await w.h.vectorIndex.drain();
  assert.ok(failed.failed >= 1);
  assert.equal(state().status, 'pending');
  assert.equal(state().attempts, 1);
  fake.state.down = false;
  await w.h.vectorIndex.drain({ at: Date.now() + 3600000 });
  assert.equal(state().status, 'indexed');
  assert.ok(vector());
});

// ---------------------------------------------------------------------------------------------- F4
test('F4: an applicability-only change (even by direct SQL) queues reindexing and refreshes the index and device facets', async (t) => {
  const { w, row, state, vector } = await setup(t);
  const generation = state().generation;
  const hashBefore = vector().meta.doc_hash;
  w.db().prepare('UPDATE memory_pool SET applicability_json=? WHERE id=?').run(JSON.stringify({ environmentText: 'Model Z firmware 9' }), row.id);
  assert.equal(state().status, 'pending');
  assert.ok(state().generation > generation, 'the generation moved');
  assert.equal(w.db().prepare('SELECT facets_at FROM memory_pool WHERE id=?').get(row.id).facets_at, null, 'device facets are marked stale');
  await w.h.vectorIndex.drain();
  assert.equal(state().status, 'indexed');
  assert.equal(vector().meta.doc_hash, hashBefore, 'applicability is separate metadata: the embedded text (title, issue, steps) is unchanged, so nothing is needlessly re-embedded');
  // Retrieval uses the new applicability; facets are rebuilt on demand.
  const ask = (text) => w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text });
  assert.equal((await ask('The display flickers after startup on Model Z firmware 9.')).eligible.length, 1);
  assert.equal((await ask('The display flickers after startup on Model X firmware 4.')).eligible.length, 0, 'the old device no longer matches');
  assert.ok(w.db().prepare('SELECT facets_at FROM memory_pool WHERE id=?').get(row.id).facets_at);
  assert.deepEqual(w.db().prepare("SELECT key,value FROM passport_facets WHERE memory_id=? ORDER BY key").all(row.id), [{ key: 'firmware', value: '9' }, { key: 'model', value: 'z' }]);
});

test('F4: safety-only, trust/publication-only and metadata-only changes are each noticed', async (t) => {
  const { w, row, state, vector } = await setup(t);
  const queued = () => ['pending', 'processing'].includes(state().status);
  const settle = async () => w.h.vectorIndex.drain();
  // Safety restrictions only.
  w.db().prepare('UPDATE memory_pool SET safety_restrictions_json=? WHERE id=?').run(JSON.stringify({ restrictions: [{ text: 'Do not use if wet', keywords: ['wet'] }] }), row.id);
  assert.ok(queued(), 'safety-only edit queues a job');
  const safety = await settle();
  assert.equal(safety.unchanged, 1, 'it re-verifies without re-embedding because the embedded text did not change');
  // Verification flags only.
  w.db().prepare('UPDATE memory_pool SET customer_confirmed=0 WHERE id=?').run(row.id);
  assert.ok(queued());
  await settle();
  w.db().prepare('UPDATE memory_pool SET locally_reviewed=1 WHERE id=?').run(row.id);
  assert.ok(queued());
  await settle();
  // Origin (metadata the vector search filters on) only.
  const hash = vector().meta.doc_hash;
  w.db().prepare("UPDATE memory_pool SET origin_type='auto_published_overdue' WHERE id=?").run(row.id);
  assert.ok(queued());
  await settle();
  assert.notEqual(vector().meta.doc_hash, hash, 'origin is part of the document hash, so the stored metadata is refreshed');
  assert.equal(vector().meta.origin, 'auto_published_overdue');
  // Version only.
  w.db().prepare('UPDATE memory_pool SET version_number=2 WHERE id=?').run(row.id);
  assert.ok(queued());
  await settle();
  assert.equal(vector().meta.version, 2);
  // Publication state: flagged -> removed, active again -> back.
  w.db().prepare("UPDATE memory_pool SET status='flagged_for_review' WHERE id=?").run(row.id);
  await settle();
  assert.equal(vector(), undefined);
  w.db().prepare("UPDATE memory_pool SET status='active' WHERE id=?").run(row.id);
  await settle();
  assert.ok(vector());
  // Columns that do not affect the index do NOT queue work.
  w.db().prepare('UPDATE memory_pool SET reuse_success_count=reuse_success_count+1 WHERE id=?').run(row.id);
  assert.equal(state().status, 'indexed', 'outcome counters never trigger reindexing');
});

test('F4: reconciliation compares document hashes, not just ids', async (t) => {
  const { w, fake, row, state, vector } = await setup(t);
  // A vector whose stored hash no longer matches SQLite (as after a change made while the worker was down).
  vector().meta.doc_hash = 'stale-hash';
  const result = await w.h.vectorIndex.reconcileVectorIndex();
  assert.ok(result.queuedOutdated >= 1);
  assert.equal(state().status, 'pending');
  await w.h.vectorIndex.drain();
  const current = w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(row.id);
  assert.equal(vector().meta.doc_hash, w.h.vectorIndex.hashOf(current));
  // Nothing outdated remains.
  assert.equal((await w.h.vectorIndex.reconcileVectorIndex()).queuedOutdated, 0);
  void fake; void ISSUE;
});

test('F4: normal application workflows (revise, retire) keep the index consistent and tenant-scoped', async (t) => {
  const { w, fake, row, vector } = await setup(t);
  const other = w.seed(w.companyB, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'ix:b' });
  await w.h.vectorIndex.drain();
  const v2 = w.h.memoryPool.revise({ companyId: w.company, chatbotId: w.botOf(w.company), id: 'staff-1' }, row.id, {
    title: 'Display flicker: new driver', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Install the approved driver 4.2 and restart the laptop.', confirmed: true, reviewedForPrivacy: true, version: 1,
  });
  await w.h.vectorIndex.drain();
  assert.equal(vector(), undefined, 'the superseded version is gone');
  assert.ok(fake.collection().rows.has(v2.id));
  assert.equal(fake.collection().rows.get(v2.id).meta.company_id, w.company);
  assert.equal(fake.collection().rows.get(other.id).meta.company_id, w.companyB, 'the other company is untouched');
});
