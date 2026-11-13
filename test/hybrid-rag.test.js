import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createFakeChroma } from './fake-chroma.js';
import { createEmbeddingService } from '../server/embedding-service.js';
import { createVectorIndex } from '../server/vector-index.js';
import { sanitizeDeep, forExternalService } from '../server/privacy-sanitizer.js';

const CHROMA = { VECTOR_STORE: 'chroma', CHROMA_URL: 'http://chroma.test:8000' };
const bot = (w, c = w.company) => w.botOf(c);
const ask = (w, text, c = w.company, extra = {}) => w.h.memoryPool.retrieve({ companyId: c, chatbotId: bot(w, c), text, ...extra });
const chromaWorld = async (t, config = {}) => {
  const fake = createFakeChroma();
  const w = await world(t, { config: { ...CHROMA, ...config }, vectorClient: fake.client });
  return { w, fake };
};
const seedFlicker = (w, c = w.company, i = 0, extra = {}) => w.seed(c, { title: FOUR[i][0], symptoms: FOUR[i][1], steps: [FOUR[i][2]], sourceKey: 'k:' + c + i, ...extra });
const stored = (w, id) => JSON.stringify(w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(id), (k, v) => (k === 'embedding_blob' ? undefined : v));

// ---------------------------------------------------------------------------------------------- Test 1
test('safety: a "do not use if wet" restriction with an EMPTY keywords array still blocks the fix', async (t) => {
  const w = await world(t);
  const row = seedFlicker(w, w.company, 0, { safety: { restrictions: [{ text: 'Do not use if the device is wet', keywords: [] }], reviewed: true } });
  assert.equal((await ask(w, ISSUE)).eligible.length, 1, 'a dry device may receive the fix');
  const wet = await ask(w, ISSUE + ' My device is wet.');
  assert.equal(wet.eligible.length, 0);
  assert.ok(wet.rejected.some((r) => r.status === 'safety_conflict'));
  // A legacy row stored before normalisation (raw restriction, empty keywords) is blocked as well.
  w.db().prepare('UPDATE memory_pool SET safety_restrictions_json=? WHERE id=?').run(JSON.stringify({ restrictions: [{ text: 'Do not use if the device is wet', keywords: [] }] }), row.id);
  assert.equal((await ask(w, ISSUE + ' The laptop is wet from a spill.')).eligible.length, 0);
  // A restriction nobody can evaluate by machine blocks the fix until a specialist rewrites it.
  const vague = seedFlicker(w, w.company, 1, { safety: { restrictions: [{ text: 'Ask the vendor first', keywords: [] }] } });
  assert.ok(vague);
  const out = await ask(w, 'Display flickers after startup and flashes on Model X firmware 4.');
  assert.ok(!out.eligible.some((c) => c.id === vague.id));
});

// ---------------------------------------------------------------------------------------------- Test 2
test('privacy: nested personal data in conditions, safety, steps and revisions never reaches shared knowledge', async (t) => {
  const w = await world(t);
  const row = w.h.memoryPool.insert({
    companyId: w.company, chatbotId: bot(w), origin: 'specialist_confirmed', sourceKey: 'pii:1',
    title: 'Flicker for jane.doe@example.com', symptoms: 'Display flickers; call +91 98765 43210 or +44 20 7946 0958',
    applicability: { environmentText: 'Model X firmware 4', conditions: [{ key: 'region', op: 'in', values: ['bob@example.com', 'eu'], required: true }] },
    safety: { restrictions: [{ text: 'Do not use if wet. Contact support at +1 (415) 555-0132', keywords: ['wet'] }], reviewed: true },
    steps: ['Open settings, then visit 12 Park Road, Mumbai. Serial: SN-4455-AB-9981.'], initialConfidence: 0.8,
  });
  const dump = stored(w, row.id);
  for (const secret of ['jane.doe@example.com', 'bob@example.com', '98765', '7946', '555-0132', '12 Park Road', 'SN-4455'])
    assert.ok(!dump.includes(secret), secret + ' must not be stored');
  const fts = JSON.stringify(w.db().prepare('SELECT * FROM memory_pool_fts WHERE memory_id=?').all(row.id));
  assert.ok(!/jane\.doe|98765|Park Road/.test(fts), 'the search index holds none of it');
  // Revisions go through the same boundary.
  const revised = w.h.memoryPool.insert({
    companyId: w.company, chatbotId: bot(w), origin: 'specialist_confirmed', sourceKey: 'pii:1', parentVersionId: row.id, lineageId: row.lineage_id, versionNumber: 2,
    title: 'Flicker v2', symptoms: 'Display flickers', applicability: { environmentText: 'Model X firmware 4' }, safety: { restrictions: [], noneIdentified: true, reviewed: true },
    steps: ['Ask Priya Sharma, phone 98765 43210, to reset the display.'], initialConfidence: 0.8,
  });
  assert.ok(!stored(w, revised.id).includes('98765'));
  // Credential-shaped content is rejected, not published.
  assert.throws(() => w.h.memoryPool.insert({ companyId: w.company, chatbotId: bot(w), origin: 'specialist_confirmed', sourceKey: 'pii:2', title: 't title', symptoms: 'display flickers', applicability: { environmentText: 'Model X' }, safety: { restrictions: [] }, steps: ['Use api_key = sk-abcdef0123456789 to log in.'], initialConfidence: 0.8 }), /credentials/i);
  // The sanitiser itself: keys that name personal data are redacted whatever the value looks like.
  const r = sanitizeDeep({ customer_email: 'x@y.com', device: { model: 'X1', owner: { phone: '9876543210' } }, note: 'fine' });
  assert.equal(r.value.customer_email, '[redacted email]');
  assert.equal(r.value.device.model, 'X1');
  assert.equal(r.value.device.owner.phone, '[redacted phone]');
});

// ---------------------------------------------------------------------------------------------- Test 3
test('privacy: raw customer details are never sent to an external embedding provider', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    bodies.push(String(options.body));
    return Response.json({ data: JSON.parse(options.body).input.map((_, i) => ({ index: i, embedding: [1, 0, 0] })) });
  });
  const w = await world(t, { config: { OPENAI_API_KEY: 'synthetic', EMBEDDING_MODEL: 'test-embedding' } });
  seedFlicker(w);
  await ask(w, 'My name is Rahul Verma, email rahul.verma@example.com, phone +91 98765 43210. The display flickers after startup. Model X firmware 4.');
  assert.ok(bodies.length > 0);
  for (const b of bodies) assert.ok(!/rahul|verma|example\.com|98765/i.test(b), 'no personal data in: ' + b.slice(0, 120));
  const before = bodies.length;
  const out = await ask(w, 'my password: hunter2hunter2 and the display flickers');
  assert.equal(bodies.length, before, 'a credential-like query is not sent at all');
  assert.equal(out.backend, 'local-hashed-concepts-v2', 'it falls back to the offline representation');
  assert.equal(forExternalService('token sk-live-aaaaaaaaaaaaaaaa').ok, false);
});

// ---------------------------------------------------------------------------------------------- Test 9, 10
test('hybrid: wording that shares no words is found through the vector index, and the index follows SQLite', async (t) => {
  const { w, fake } = await chromaWorld(t);
  const a = seedFlicker(w, w.company, 0);
  w.seed(w.company, { title: 'Invoice export', symptoms: 'Cannot export invoice to PDF', steps: ['Open Billing, choose Export, pick PDF and retry.'], sourceKey: 'inv', environment: 'Model X firmware 4' });
  const early = await ask(w, 'The panel keeps blinking whenever the laptop boots. Model X firmware 4.');
  assert.deepEqual(early.eligible.map((c) => c.id), [a.id], 'knowledge the index has not caught up with is still found');
  assert.ok(early.candidates.unindexed >= 1);
  const idx = await w.h.vectorIndex.drain();
  assert.equal(idx.indexed, w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE status='active'").get().n);
  const paraphrase = await ask(w, 'The panel keeps blinking whenever the laptop boots. Model X firmware 4.');
  assert.equal(paraphrase.source, 'chroma');
  assert.deepEqual(paraphrase.eligible.map((c) => c.id), [a.id]);
  assert.ok(paraphrase.candidates.semantic > 0);

  // create / update / retire / delete are all reflected in the index.
  const collection = fake.collection();
  assert.ok(collection.rows.has(a.id));
  w.db().prepare('UPDATE memory_pool SET steps_json=? WHERE id=?').run(JSON.stringify(['Install the approved display driver 4.2.']), a.id);
  const r1 = await w.h.vectorIndex.drain();
  assert.equal(r1.indexed, 1, 'changed content is embedded again');
  w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(a.id);
  assert.equal((await ask(w, ISSUE)).eligible.length, 0, 'retired knowledge is not recommended even before the index catches up');
  assert.ok(collection.rows.has(a.id), 'the stale vector is still there');
  await w.h.vectorIndex.drain();
  assert.ok(!collection.rows.has(a.id), 'and is removed once the worker runs');
  w.db().prepare("UPDATE memory_pool SET status='active' WHERE id=?").run(a.id);
  await w.h.vectorIndex.drain();
  assert.ok(collection.rows.has(a.id));
  w.db().prepare('DELETE FROM memory_pool WHERE id=?').run(a.id);
  await w.h.vectorIndex.drain();
  assert.ok(!collection.rows.has(a.id));
});

// ---------------------------------------------------------------------------------------------- Test 11, 12
test('isolation: the vector index can never widen what a company or service may recommend', async (t) => {
  const { w, fake } = await chromaWorld(t);
  const a = seedFlicker(w, w.company, 0);
  const b = seedFlicker(w, w.companyB, 0);
  const itBot = w.seed(w.company, { title: 'IT only display', symptoms: 'Display flickers after startup', steps: ['IT desk steps for display flicker on startup.'], chatbotId: w.botOf(w.company, 'it'), sourceKey: 'it:1' });
  await w.h.vectorIndex.drain();
  assert.deepEqual((await ask(w, ISSUE)).eligible.map((c) => c.id), [a.id]);
  assert.deepEqual((await ask(w, ISSUE, w.companyB)).eligible.map((c) => c.id), [b.id]);
  // Even if the vector store ignored its filter and returned everything, SQLite re-validates every candidate.
  fake.state.ignoreWhere = true;
  const hostile = await ask(w, ISSUE);
  assert.deepEqual(hostile.eligible.map((c) => c.id), [a.id]);
  assert.ok(![...hostile.rejected].some((r) => [b.id, itBot.id].includes(r.id)), 'foreign ids are dropped before scoring');
});

// ---------------------------------------------------------------------------------------------- Test 13
test('compatibility: a semantically identical fix for another firmware is not recommended', async (t) => {
  const { w } = await chromaWorld(t);
  seedFlicker(w, w.company, 0, { environment: 'Model X firmware 4' });
  await w.h.vectorIndex.drain();
  assert.equal((await ask(w, 'The display flickers after startup on Model X firmware 5.')).eligible.length, 0);
  assert.equal((await ask(w, 'The display flickers after startup on Model X firmware 4.')).eligible.length, 1);
  const unknown = await ask(w, 'The display flickers after startup.');
  assert.equal(unknown.eligible.length, 0, 'unknown mandatory facts are asked about, not assumed');
});

// ---------------------------------------------------------------------------------------------- Test 14
test('outage: SQLite-only fallback keeps answering, jobs are retried, and indexing recovers', async (t) => {
  const { w, fake } = await chromaWorld(t);
  const a = seedFlicker(w);
  fake.state.down = true;
  const failed = await w.h.vectorIndex.drain();
  assert.ok(failed.failed >= 1 && !failed.indexed);
  const pending = w.h.vectorIndex.summary();
  assert.ok(pending.pending >= 1, 'the SQLite change is committed and the job waits');
  const out = await ask(w, ISSUE);
  assert.equal(out.source, 'sqlite');
  assert.deepEqual(out.eligible.map((c) => c.id), [a.id]);
  assert.equal(w.db().prepare("SELECT status FROM memory_pool WHERE id=?").get(a.id).status, 'active');
  assert.equal(w.h.vectorIndex.summary().indexed, 0, 'nothing is reported as indexed while the store is down');
  fake.state.down = false;
  const later = Date.now() + 3 * 3600000; // past the retry backoff and the circuit breaker
  const recovered = await w.h.vectorIndex.drain({ at: later });
  assert.ok(recovered.indexed >= 1);
  assert.ok(fake.collection().rows.has(a.id));
});

// ---------------------------------------------------------------------------------------------- Test 15
test('indexing is idempotent: repeats never create duplicates or re-embed unchanged knowledge', async (t) => {
  const { w, fake } = await chromaWorld(t);
  const a = seedFlicker(w);
  await w.h.vectorIndex.drain();
  const embedded = w.h.embedding.stats().textsEmbedded;
  const upserts = fake.state.upserts;
  w.db().prepare("UPDATE vector_index_state SET status='pending',next_attempt_at=0 WHERE memory_id=?").run(a.id);
  const again = await w.h.vectorIndex.drain();
  assert.equal(again.unchanged, 1);
  assert.equal(w.h.embedding.stats().textsEmbedded, embedded, 'unchanged content is not embedded again');
  assert.equal(fake.state.upserts, upserts);
  w.h.vectorIndex.reindexKnowledge();
  await w.h.vectorIndex.drain();
  await w.h.vectorIndex.drain();
  assert.equal(fake.collection().rows.size, w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE status='active'").get().n, 'one vector per active passport');
  // Reconciliation removes vectors that SQLite does not consider recommendable and re-queues what is missing.
  fake.collection().rows.set('ghost', { vector: [1, 0], meta: { company_id: w.company, chatbot_id: bot(w) } });
  fake.collection().rows.delete(a.id);
  const rec = await w.h.vectorIndex.reconcileVectorIndex();
  assert.equal(rec.removedOrphans, 1);
  assert.ok(rec.queuedMissing >= 1);
  await w.h.vectorIndex.drain();
  assert.ok(fake.collection().rows.has(a.id) && !fake.collection().rows.has('ghost'));
});

// ---------------------------------------------------------------------------------------------- model change
test('a new embedding model gets its own collection; vectors of different models are never mixed', async (t) => {
  const { w, fake } = await chromaWorld(t);
  seedFlicker(w);
  await w.h.vectorIndex.drain();
  assert.equal(fake.state.collections.size, 1);
  const next = createEmbeddingService({ EMBEDDING_MODEL: 'next-model', OPENAI_API_KEY: 'k' }, { fetchImpl: async (u, o) => Response.json({ data: JSON.parse(o.body).input.map((_, i) => ({ index: i, embedding: [0.2, 0.9, 0.1, 0.4] })) }) });
  const upgraded = createVectorIndex(w.h.store, { vectors: w.h.vectors, embedding: next });
  assert.ok(upgraded.markStale() >= 1, 'vectors made by the old model are stale');
  const r = await upgraded.drain();
  assert.ok(r.indexed >= 1);
  assert.equal(fake.state.collections.size, 2, 'the new model lives in a separate collection');
  assert.ok(upgraded.summary().stale === 0);
});

// ---------------------------------------------------------------------------------------------- Test 20
test('worker isolation: a stuck data-source task does not stop email, indexing or follow-through lanes', async (t) => {
  const w = await world(t);
  const ran = [];
  let release;
  const stuck = new Promise((resolve) => { release = resolve; });
  w.h.delivery.register(() => stuck, { name: 'slow-database-sync', timeoutMs: 50 });
  w.h.delivery.register(() => { ran.push('notifications'); }, { name: 'notifications', timeoutMs: 1000 });
  const started = Date.now();
  await w.h.delivery.flush();
  assert.ok(Date.now() - started < 1500, 'flush does not wait for the stuck lane beyond its timeout');
  assert.deepEqual(ran, ['notifications']);
  const lanes = Object.fromEntries(w.h.delivery.lanes().map((l) => [l.name, l]));
  assert.equal(lanes['slow-database-sync'].running, true);
  assert.equal(lanes['notifications'].running, false);
  await w.h.delivery.flush();
  assert.deepEqual(ran, ['notifications', 'notifications'], 'other lanes keep running while one is stuck');
  release();
});
