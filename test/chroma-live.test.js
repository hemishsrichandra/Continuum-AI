// Exercises the REAL ChromaDB server (not a test double). Skipped, and reported as skipped, when no server is
// reachable at CHROMA_URL (default http://127.0.0.1:8000). Start one with: docker compose up -d chroma
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createVectorStore } from '../server/vector-store.js';

const URL_ = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const reachable = await fetch(URL_ + '/api/v2/heartbeat', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const live = { skip: reachable ? false : `ChromaDB is not reachable at ${URL_}` };

test('live ChromaDB: indexing, filtered semantic search, tenant isolation, retirement and persistence', live, async (t) => {
  const namespace = 'itest_' + randomUUID().slice(0, 8);
  const config = { VECTOR_STORE: 'chroma', CHROMA_URL: URL_, VECTOR_NAMESPACE: namespace };
  const w = await world(t, { config });
  const a = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'live:a' });
  const b = w.seed(w.companyB, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'live:b' });
  w.seed(w.company, { title: 'Invoice export', symptoms: 'Cannot export invoice to PDF', steps: ['Open Billing, choose Export, pick PDF and retry.'], sourceKey: 'live:inv' });
  const drained = await w.h.vectorIndex.drain();
  assert.ok(drained.indexed >= 3, JSON.stringify(drained));
  t.after(async () => {
    const { ChromaClient } = await import('chromadb');
    const u = new URL(URL_);
    const client = new ChromaClient({ host: u.hostname, port: Number(u.port) || 80, ssl: false });
    for (const c of await client.listCollections()) if (String(c.name).startsWith(namespace)) await client.deleteCollection({ name: c.name });
  });

  const near = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'The panel keeps blinking whenever the laptop boots. Model X firmware 4.' });
  assert.equal(near.source, 'chroma');
  assert.deepEqual(near.eligible.map((c) => c.id), [a.id]);
  const other = await w.h.memoryPool.retrieve({ companyId: w.companyB, chatbotId: w.botOf(w.companyB), text: ISSUE });
  assert.deepEqual(other.eligible.map((c) => c.id), [b.id], 'company B only ever sees its own knowledge');

  // The ids-restricted query used to score lexical-only hits works against the real server.
  const q = w.h.embedding;
  const { model, vector } = await q.embedQuery(ISSUE);
  const only = await w.h.vectors.searchKnowledgeVectors({ modelId: model, vector, companyId: w.company, chatbotId: w.botOf(w.company), limit: 5, ids: [a.id] });
  assert.deepEqual(only.map((h) => h.id), [a.id]);
  assert.ok(only[0].similarity > 0.3 && only[0].similarity <= 1, "similarity " + only[0].similarity);

  // Retirement removes the vector, and a brand-new client (as after a server restart) still sees the persisted index.
  w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(a.id);
  await w.h.vectorIndex.drain();
  const fresh = createVectorStore(config);
  const present = await fresh.presentIds(model, [a.id, b.id]);
  assert.ok(!present.has(a.id) && present.has(b.id));
  const health = await w.h.vectorIndex.health({ probe: true });
  assert.equal(health.vectorStore.ok, true);
  assert.equal(health.index.failed, 0);
});
