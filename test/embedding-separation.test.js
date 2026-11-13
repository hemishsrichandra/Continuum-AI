// The chat/drafting model (e.g. Groq) and the neural embedding provider are configured independently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingService } from '../server/embedding-service.js';

const CHAT = { OPENAI_API_KEY: 'chat-key-synthetic', OPENAI_BASE_URL: 'https://chat.example.test/v1', OPENAI_MODEL: 'chat-model' };
const ok = (input) => Response.json({ model: 'text-embedding-3-small', data: input.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) });

test('embeddings use only EMBEDDING_* credentials and endpoint, never the chat ones', async () => {
  const seen = [];
  const svc = createEmbeddingService({ ...CHAT, EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'embed-key-synthetic', EMBEDDING_BASE_URL: 'https://embed.example.test/v1' }, {
    fetchImpl: async (url, o) => { seen.push({ url, auth: o.headers.Authorization, model: JSON.parse(o.body).model }); return ok(JSON.parse(o.body).input); },
  });
  assert.equal(svc.isRemote, true);
  assert.equal(svc.model, 'text-embedding-3-small', 'provider=openai defaults the model');
  await svc.embedDocuments(['printer shows paper jam']);
  await svc.embedQuery('paper keeps jamming');
  assert.ok(seen.length >= 2);
  for (const s of seen) {
    assert.equal(s.url, 'https://embed.example.test/v1/embeddings');
    assert.equal(s.auth, 'Bearer embed-key-synthetic');
    assert.doesNotMatch(JSON.stringify(s), /chat-key-synthetic|chat\.example/);
  }
});

test('a chat key alone never enables remote embeddings (offline fallback, nothing is sent)', async () => {
  let calls = 0;
  const svc = createEmbeddingService({ ...CHAT, EMBEDDING_PROVIDER: 'openai', EMBEDDING_MODEL: 'text-embedding-3-small' }, { fetchImpl: async () => { calls++; return ok([]); } });
  assert.equal(svc.isRemote, false);
  const q = await svc.embedQuery('screen flickers');
  assert.match(q.model, /^local:/);
  assert.equal(calls, 0);
});

test('changing the embedding model leaves the chat configuration untouched and uses its own default endpoint', async () => {
  const cfg = { ...CHAT, EMBEDDING_API_KEY: 'k', EMBEDDING_MODEL: 'text-embedding-3-large' };
  const before = JSON.stringify(CHAT);
  let url;
  const svc = createEmbeddingService(cfg, { fetchImpl: async (u, o) => { url = u; return ok(JSON.parse(o.body).input); } });
  await svc.embedQuery('battery drains fast');
  assert.equal(url, 'https://api.openai.com/v1/embeddings', 'EMBEDDING_BASE_URL default is OpenAI, not OPENAI_BASE_URL');
  assert.equal(JSON.stringify(CHAT), before);
});

test('embedding outage falls back without throwing', async () => {
  const svc = createEmbeddingService({ EMBEDDING_API_KEY: 'k', EMBEDDING_MODEL: 'm' }, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await svc.embedQuery('anything'), null);
});
