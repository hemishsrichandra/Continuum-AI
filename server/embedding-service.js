// Embedding service: one consistent model for documents and queries.
//
//  * provider "openai" (any OpenAI-compatible /embeddings endpoint) or "local" (the offline hashed-concept
//    representation, which is lexical-conceptual and NOT a neural model; it is labelled as such everywhere)
//  * every text is passed through the privacy boundary before it can leave the server; a credential-like text is
//    never sent
//  * vectors from different models are never mixed: callers get the model id with every vector and the vector
//    store keeps one collection per model
//  * only queries are embedded at request time (bounded LRU cache with a TTL); documents are embedded by the
//    indexing worker, in batches, and only when their content changed
//  * a failing provider opens a short circuit breaker so requests fall back quickly instead of waiting on timeouts
import { createHash } from 'node:crypto';
import { LOCAL_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, localEmbedding } from './scoring.js';
import { forExternalService } from './privacy-sanitizer.js';

const BATCH = 64;
const err = (message, { transient = true } = {}) => Object.assign(new Error(message), { transient });

export function createEmbeddingService(config = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const wantsRemote = config.EMBEDDING_PROVIDER ? config.EMBEDDING_PROVIDER !== 'local' : Boolean(config.EMBEDDING_MODEL);
  const remote = wantsRemote && Boolean(config.EMBEDDING_MODEL && config.OPENAI_API_KEY);
  const provider = remote ? 'openai' : 'local';
  const model = remote ? config.EMBEDDING_MODEL : LOCAL_EMBEDDING_MODEL;
  const baseUrl = (config.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const timeoutMs = Number(config.EMBEDDING_TIMEOUT_MS) > 0 ? Number(config.EMBEDDING_TIMEOUT_MS) : 10000;
  const cacheSize = Number(config.QUERY_EMBEDDING_CACHE) > 0 ? Number(config.QUERY_EMBEDDING_CACHE) : 500;
  const cacheTtl = 10 * 60 * 1000;
  // Some OpenAI-compatible servers omit "index"; accepting that means trusting array order, so it is opt-in.
  const allowUnindexed = config.EMBEDDING_ALLOW_UNINDEXED === 'true';
  let dimensions = remote ? Number(config.EMBEDDING_DIMENSIONS) || null : EMBEDDING_DIMENSIONS;
  let downUntil = 0;
  let lastError = null;
  const cache = new Map();
  const stats = { apiCalls: 0, textsEmbedded: 0, queryCacheHits: 0, queryCacheMisses: 0, failures: 0 };

  const modelId = () => `${provider}:${model}`;
  const key = (text) => createHash('sha256').update(model + '\u0000' + text).digest('hex');

  /**
   * Map the provider's answer back onto the batch that was sent. A response is only used if it is complete and unambiguous: exactly one entry
   * per input, each carrying a unique in-range "index" (entries may arrive in ANY order and are re-ordered by that index), every vector a
   * non-empty array of finite numbers, all of the same size, and a model name that matches the one requested. Anything else is rejected
   * (non-transient) so that no document is ever stored with another document's vector.
   */
  function orderedVectors(body, count) {
    const reject = (why) => {
      stats.failures++;
      throw err('Embedding provider returned an invalid response (' + why + ').', { transient: false });
    };
    const items = Array.isArray(body?.data) ? body.data : [];
    if (items.length !== count) reject('expected ' + count + ' entries, got ' + items.length);
    if (typeof body.model === 'string' && body.model && !(body.model.includes(model) || model.includes(body.model))) reject('model identity mismatch');
    const ordered = new Array(count);
    const withIndex = items.filter((d) => d && d.index !== undefined).length;
    if (withIndex === 0 && allowUnindexed) items.forEach((d, i) => { ordered[i] = d?.embedding; });
    else {
      if (withIndex !== count) reject('entries without an index');
      for (const d of items) {
        const i = d.index;
        if (!Number.isInteger(i) || i < 0 || i >= count) reject('index out of range');
        if (ordered[i] !== undefined) reject('duplicate index');
        ordered[i] = d.embedding;
      }
    }
    for (let i = 0; i < count; i++) if (ordered[i] === undefined) reject('missing index ' + i);
    const size = Array.isArray(ordered[0]) ? ordered[0].length : 0;
    for (const v of ordered) {
      if (!Array.isArray(v) || !v.length) reject('empty vector');
      if (v.length !== size) reject('vectors of different sizes');
      if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) reject('non-numeric values');
    }
    return ordered;
  }

  async function callRemote(texts) {
    if (now() < downUntil) throw err('Embedding provider is temporarily unavailable.');
    let response;
    stats.apiCalls++;
    try {
      response = await fetchImpl(baseUrl + '/embeddings', {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.OPENAI_API_KEY },
        body: JSON.stringify({ model, input: texts, ...(Number(config.EMBEDDING_DIMENSIONS) > 0 && { dimensions: Number(config.EMBEDDING_DIMENSIONS) }) }),
      });
    } catch {
      stats.failures++;
      downUntil = now() + 60000;
      lastError = 'Embedding provider could not be reached.';
      throw err(lastError);
    }
    if (!response.ok) {
      stats.failures++;
      const transient = response.status === 429 || response.status >= 500;
      if (transient) downUntil = now() + 60000;
      lastError = 'Embedding provider returned HTTP ' + response.status + '.';
      throw err(lastError, { transient });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      stats.failures++;
      throw err('Embedding provider returned an invalid response.');
    }
    const vectors = orderedVectors(body, texts.length);
    const size = vectors[0].length;
    if (dimensions && dimensions !== size) throw err(`Embedding dimension changed from ${dimensions} to ${size}; rebuild the index for the new model.`, { transient: false });
    dimensions = size;
    lastError = null;
    stats.textsEmbedded += texts.length;
    return vectors.map((v) => Float32Array.from(v));
  }

  /** Embed document texts (batched). Returns { model, vectors } in input order; throws with `.transient` set. */
  async function embedDocuments(texts) {
    if (!remote) {
      stats.textsEmbedded += texts.length;
      return { model: modelId(), vectors: texts.map((t) => localEmbedding(String(t))) };
    }
    const prepared = texts.map((t) => {
      const safe = forExternalService(t);
      if (!safe.ok) throw err('A document contains credential-like content and was not sent to the embedding provider.', { transient: false });
      return safe.text;
    });
    const vectors = [];
    for (let i = 0; i < prepared.length; i += BATCH) vectors.push(...(await callRemote(prepared.slice(i, i + BATCH))));
    return { model: modelId(), vectors };
  }

  /** Embed one customer query. Returns { model, vector } or null when the provider cannot be used. */
  async function embedQuery(text) {
    if (!remote) return { model: modelId(), vector: localEmbedding(String(text)) };
    const safe = forExternalService(text);
    if (!safe.ok || !safe.text.trim()) return null;
    const k = key(safe.text);
    const hit = cache.get(k);
    if (hit && hit.expires > now()) {
      stats.queryCacheHits++;
      cache.delete(k);
      cache.set(k, hit); // refresh LRU position
      return { model: modelId(), vector: hit.vector };
    }
    stats.queryCacheMisses++;
    try {
      const [vector] = await callRemote([safe.text]);
      cache.set(k, { vector, expires: now() + cacheTtl });
      while (cache.size > cacheSize) cache.delete(cache.keys().next().value); // evict only the least recently used
      return { model: modelId(), vector };
    } catch {
      return null;
    }
  }

  return {
    provider,
    model,
    modelId,
    isRemote: remote,
    get dimensions() {
      return dimensions;
    },
    embedDocuments,
    embedQuery,
    stats: () => ({ ...stats, cachedQueries: cache.size }),
    health: () => ({ provider, model, dimensions, remote, ok: !remote || now() >= downUntil, lastError, neural: remote }),
  };
}
