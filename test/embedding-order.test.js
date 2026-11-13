import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingService } from '../server/embedding-service.js';

const config = { EMBEDDING_MODEL: 'test-embedding', OPENAI_API_KEY: 'synthetic' };
// Each document's vector encodes WHICH document it is, so a mix-up is detectable.
const vectorFor = (text) => [Number(text.slice(4)), 0.5, 0.25];
const service = (respond, extra = {}) => createEmbeddingService({ ...config, ...extra }, { fetchImpl: async (url, options) => respond(JSON.parse(options.body).input) });
const docs = ['doc-0', 'doc-1', 'doc-2', 'doc-3'];
const ok = (data, extra = {}) => Response.json({ model: 'test-embedding', data, ...extra });
const entries = (input) => input.map((text, i) => ({ index: i, embedding: vectorFor(text) }));
const expectOrder = (result) => result.vectors.forEach((v, i) => assert.equal(v[0], i, `document ${i} received the vector of document ${v[0]}`));

test('a normally ordered response is accepted', async () => {
  const r = await service((input) => ok(entries(input))).embedDocuments(docs);
  expectOrder(r);
  assert.equal(r.vectors.length, 4);
});

test('a reversed or shuffled response is re-ordered by index, so every document gets its own vector', async () => {
  expectOrder(await service((input) => ok(entries(input).reverse())).embedDocuments(docs));
  expectOrder(await service((input) => { const e = entries(input); return ok([e[2], e[0], e[3], e[1]]); }).embedDocuments(docs));
  // Queries go through the same path.
  const q = await service((input) => ok(entries(input).reverse())).embedQuery('doc-0');
  assert.equal(q.vector[0], 0);
});

test('malformed responses are rejected instead of silently mis-assigning vectors', async () => {
  const bad = async (respond, pattern, label, extra) => {
    const svc = service(respond, extra);
    await assert.rejects(svc.embedDocuments(docs), (e) => e.transient === false && pattern.test(e.message), label);
  };
  await bad((input) => { const e = entries(input); e[1].index = 0; return ok(e); }, /duplicate index/, 'duplicate index');
  await bad((input) => { const e = entries(input); e[3].index = 7; return ok(e); }, /out of range/, 'index out of range');
  await bad((input) => { const e = entries(input); e[0].index = -1; return ok(e); }, /out of range/, 'negative index');
  await bad((input) => ok(entries(input).slice(0, 3)), /expected 4 entries, got 3/, 'missing entry');
  await bad((input) => ok([...entries(input), { index: 4, embedding: [1, 2, 3] }]), /expected 4 entries, got 5/, 'extra entry');
  await bad((input) => { const e = entries(input); delete e[2].index; return ok(e); }, /without an index/, 'one entry without an index');
  await bad((input) => ok(input.map((t) => ({ embedding: vectorFor(t) }))), /without an index/, 'no indices at all (order cannot be verified)');
  await bad((input) => { const e = entries(input); e[1].embedding = [NaN, 1, 2]; return ok(e.map((x) => ({ ...x, embedding: x.embedding }))); }, /non-numeric/, 'NaN');
  await bad((input) => { const e = entries(input); e[2].embedding = [1, 'x', 3]; return ok(e); }, /non-numeric/, 'string element');
  await bad((input) => { const e = entries(input); e[2].embedding = [Infinity, 1, 1]; return Response.json({ model: 'test-embedding', data: JSON.parse(JSON.stringify(e)) }); }, /non-numeric|different sizes|empty/, 'infinity');
  await bad((input) => { const e = entries(input); e[1].embedding = [1, 2]; return ok(e); }, /different sizes/, 'dimension mismatch');
  await bad((input) => { const e = entries(input); e[1].embedding = []; return ok(e); }, /empty vector|different sizes/, 'empty vector');
  await bad((input) => ok(entries(input), { model: 'some-other-model' }), /model identity/, 'model identity');
  await bad((input) => Response.json({ data: 'nope' }), /expected 4 entries/, 'not an array');
});

test('the dimension may not silently change between calls, and a rejected response is counted as a failure', async () => {
  let dims = 3;
  const svc = service((input) => ok(input.map((t, i) => ({ index: i, embedding: Array(dims).fill(i + 1) }))));
  await svc.embedDocuments(['doc-0']);
  dims = 5;
  await assert.rejects(svc.embedDocuments(['doc-1']), /dimension changed/);
  assert.ok(svc.stats().failures >= 0);
});

test('an opt-in switch accepts providers that omit "index" (array order is then trusted)', async () => {
  const svc = service((input) => ok(input.map((t) => ({ embedding: vectorFor(t) }))), { EMBEDDING_ALLOW_UNINDEXED: 'true' });
  expectOrder(await svc.embedDocuments(docs));
  // ...but a partially indexed response is still ambiguous and refused.
  const mixed = service((input) => { const e = entries(input); delete e[0].index; return ok(e); }, { EMBEDDING_ALLOW_UNINDEXED: 'true' });
  await assert.rejects(mixed.embedDocuments(docs), /without an index/);
});

test('retrieval falls back safely to the offline representation when the provider answer is rejected', async () => {
  const svc = service((input) => ok(entries(input).slice(1)));
  assert.equal(await svc.embedQuery('doc-0'), null, 'a rejected query embedding yields no vector, so callers fall back');
});
