// ChromaDB vector store: a rebuildable semantic index, never a source of truth.
//
// SQLite decides what is recommendable. This module only stores vectors and returns candidate ids, so it
//  * keeps ONE collection per embedding model (vectors of different models are never compared)
//  * always filters by company and service, and the caller re-validates every returned id against SQLite
//  * is reached only through this file; nothing else in the app talks to ChromaDB, and credentials stay on the
//    server
//  * fails closed and fast: after a failure a short circuit breaker makes callers fall back to SQLite retrieval
//    instead of waiting on timeouts
//  * connects only to the URL the operator configured (CHROMA_URL); with none configured it stays disabled
import { createHash } from 'node:crypto';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'model';
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(label + ' timed out.'), { transient: true })), ms).unref())]);

export function createVectorStore(config = {}, { client: injected = null, now = Date.now } = {}) {
  const wanted = (config.VECTOR_STORE || (config.CHROMA_URL ? 'chroma' : 'none')).toLowerCase();
  const url = config.CHROMA_URL || '';
  const enabled = wanted === 'chroma' && Boolean(url || injected);
  const namespace = slug(config.VECTOR_NAMESPACE || 'continuum');
  const timeoutMs = Number(config.CHROMA_TIMEOUT_MS) > 0 ? Number(config.CHROMA_TIMEOUT_MS) : 5000;
  const topK = Number(config.VECTOR_TOP_K) > 0 ? Math.min(200, Number(config.VECTOR_TOP_K)) : 20;
  let client = injected;
  let downUntil = 0;
  let lastError = null;
  let lastOkAt = null;
  const collections = new Map();

  async function connect() {
    if (client) return client;
    const { ChromaClient } = await import('chromadb');
    const parsed = new URL(url);
    client = new ChromaClient({
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      ssl: parsed.protocol === 'https:',
      ...(config.CHROMA_TENANT && { tenant: config.CHROMA_TENANT }),
      ...(config.CHROMA_DATABASE && { database: config.CHROMA_DATABASE }),
      ...(config.CHROMA_TOKEN && { headers: { Authorization: 'Bearer ' + config.CHROMA_TOKEN } }),
    });
    return client;
  }
  const fail = (e) => {
    lastError = e?.transient === false ? e.message : 'The vector index is not reachable.';
    if (e?.transient !== false) downUntil = now() + 15000;
    return e;
  };
  const ok = () => {
    lastError = null;
    lastOkAt = new Date(now()).toISOString();
    downUntil = 0;
  };
  const available = () => enabled && now() >= downUntil;

  /** Collection for one embedding model. Created on first use with cosine distance. */
  async function collectionFor(modelId, dimensions) {
    if (!enabled) throw Object.assign(new Error('The vector index is not configured.'), { transient: false });
    const name = `${namespace}_knowledge_${slug(modelId)}_${createHash('sha256').update(modelId).digest('hex').slice(0, 8)}`;
    const cached = collections.get(name);
    if (cached) return cached;
    try {
      const c = await withTimeout(connect(), timeoutMs, 'Vector index connection');
      const collection = await withTimeout(
        c.getOrCreateCollection({ name, embeddingFunction: null, configuration: { hnsw: { space: 'cosine' } }, metadata: { model: modelId, ...(dimensions && { dimensions }) } }),
        timeoutMs,
        'Vector index',
      );
      const known = Number(collection.metadata?.dimensions);
      if (known && dimensions && known !== dimensions)
        throw Object.assign(new Error(`The vector index holds ${known}-dimension vectors; rebuild it for this model.`), { transient: false });
      collections.set(name, collection);
      ok();
      return collection;
    } catch (e) {
      throw fail(e);
    }
  }

  async function initializeVectorStore(modelId, dimensions) {
    const c = await collectionFor(modelId, dimensions);
    return { name: c.name, count: await withTimeout(c.count(), timeoutMs, 'Vector index') };
  }

  /** Insert or replace vectors. Idempotent: the id is the Resolution Passport id, so a retry never duplicates. */
  async function upsertKnowledgeVectors(modelId, items) {
    if (!items.length) return 0;
    const collection = await collectionFor(modelId, items[0].vector.length);
    try {
      await withTimeout(
        collection.upsert({
          ids: items.map((i) => i.id),
          embeddings: items.map((i) => Array.from(i.vector)),
          metadatas: items.map((i) => ({ company_id: i.companyId, chatbot_id: i.chatbotId, origin: i.origin || '', version: i.version || 1, content_hash: i.contentHash || '', doc_hash: i.docHash || '', model: modelId })),
        }),
        timeoutMs * 3,
        'Vector index',
      );
      ok();
      return items.length;
    } catch (e) {
      throw fail(e);
    }
  }
  const upsertKnowledgeVector = (modelId, item) => upsertKnowledgeVectors(modelId, [item]);

  /**
   * Nearest vectors for one company + service. `ids` restricts the search to specific candidates (used to score
   * lexical hits). Returns [{ id, distance, similarity }] best first, or null when the index is unavailable.
   */
  async function searchKnowledgeVectors({ modelId, vector, companyId, chatbotId, limit = topK, ids = null }) {
    if (!available()) return null;
    if (!companyId || !chatbotId) throw new Error('A company and service scope is required.');
    try {
      const collection = await collectionFor(modelId, vector.length);
      const result = await withTimeout(
        collection.query({
          queryEmbeddings: [Array.from(vector)],
          nResults: Math.max(1, limit),
          where: { $and: [{ company_id: companyId }, { chatbot_id: chatbotId }] },
          ...(ids && { ids }),
          include: ['distances'],
        }),
        timeoutMs,
        'Vector search',
      );
      ok();
      const found = result.ids?.[0] || [];
      const distances = result.distances?.[0] || [];
      return found.map((id, i) => ({ id, distance: distances[i], similarity: 1 - Number(distances[i] ?? 1) }));
    } catch (e) {
      fail(e);
      return null;
    }
  }

  async function deleteKnowledgeVectors(modelId, ids) {
    if (!ids.length) return 0;
    const collection = await collectionFor(modelId, null);
    try {
      await withTimeout(collection.delete({ ids }), timeoutMs * 3, 'Vector index');
      ok();
      return ids.length;
    } catch (e) {
      throw fail(e);
    }
  }
  const deleteKnowledgeVector = (modelId, id) => deleteKnowledgeVectors(modelId, [id]);

  /** Which of these ids are present in the index (used to verify deletions and reconcile). */
  async function presentIds(modelId, ids) {
    if (!ids.length) return new Set();
    const collection = await collectionFor(modelId, null);
    try {
      const result = await withTimeout(collection.get({ ids, include: [] }), timeoutMs, 'Vector index');
      ok();
      return new Set(result.ids || []);
    } catch (e) {
      throw fail(e);
    }
  }
  /** Every id in the model's collection, paged. Used by reconciliation. */
  async function listIds(modelId) {
    const collection = await collectionFor(modelId, null);
    const out = [];
    try {
      for (let offset = 0; ; offset += 500) {
        const page = await withTimeout(collection.get({ limit: 500, offset, include: [] }), timeoutMs, 'Vector index');
        out.push(...(page.ids || []));
        if ((page.ids || []).length < 500) break;
      }
      ok();
      return out;
    } catch (e) {
      throw fail(e);
    }
  }

  /** Every entry (id and metadata) in the model's collection, paged. Reconciliation compares the stored document hash. */
  async function listEntries(modelId) {
    const collection = await collectionFor(modelId, null);
    const out = [];
    try {
      for (let offset = 0; ; offset += 500) {
        const page = await withTimeout(collection.get({ limit: 500, offset, include: ['metadatas'] }), timeoutMs, 'Vector index');
        (page.ids || []).forEach((id, i) => out.push({ id, metadata: page.metadatas?.[i] || {} }));
        if ((page.ids || []).length < 500) break;
      }
      ok();
      return out;
    } catch (e) {
      throw fail(e);
    }
  }

  async function getVectorStoreHealth({ probe = false, modelId = null } = {}) {
    if (!enabled) return { enabled: false, ok: false, reason: 'not configured' };
    if (probe) {
      try {
        const c = await withTimeout(connect(), timeoutMs, 'Vector index connection');
        await withTimeout(c.heartbeat(), timeoutMs, 'Vector index');
        ok();
      } catch (e) {
        fail(e);
      }
    }
    let count = null;
    if (modelId && lastError === null) count = await collectionFor(modelId, null).then((c) => c.count()).catch(() => null);
    return { enabled: true, ok: lastError === null && now() >= downUntil, error: lastError, lastOkAt, topK, ...(count !== null && { count }) };
  }

  return {
    enabled,
    topK,
    available,
    initializeVectorStore,
    upsertKnowledgeVector,
    upsertKnowledgeVectors,
    searchKnowledgeVectors,
    deleteKnowledgeVector,
    deleteKnowledgeVectors,
    presentIds,
    listIds,
    listEntries,
    getVectorStoreHealth,
    close: () => collections.clear(),
  };
}
