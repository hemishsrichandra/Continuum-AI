// Durable SQLite -> ChromaDB indexing.
//
// SQLite and ChromaDB cannot share a transaction, so indexing is a persistent desired-state loop:
//  * triggers on memory_pool (migration 7) mark a memory "pending" whenever it is created, edited, superseded,
//    retired, flagged or deleted - from any code path
//  * the worker reads the AUTHORITATIVE row and makes the index match it: only 'active' knowledge is indexed;
//    everything else (flagged, superseded, retired, deleted) is removed from the index
//  * upserts use the passport id, so a retried or duplicated job can never create a second vector
//  * unchanged content is not embedded again (content hash + model id are recorded per memory)
//  * a failing ChromaDB or embedding provider leaves the SQLite change committed and the job retrying with
//    backoff; nothing is reported as indexed until the vector store acknowledged it
//  * a model change makes every vector stale and re-queues it into that model's own collection
import { createHash } from 'node:crypto';
import { stepsList } from './passports.js';

const parse = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const MAX_ATTEMPTS = 8;
const LEASE_MS = 120000;
const backoff = (attempts) => Math.min(3600000, 30000 * 2 ** Math.max(0, attempts - 1));
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** The text that represents a passport in the semantic index. */
export const documentText = (row) => {
  const applies = parse(row.applicability_json, {});
  const where = [applies.environmentText, ...(applies.conditions || []).map((c) => (c.values || []).join(' '))].filter(Boolean).join('; ');
  return `${row.title}\n${row.symptoms_text}\n${stepsList(parse(row.steps_json, [])).join(' ')}${where ? '\nApplies to: ' + where : ''}`;
};

export function createVectorIndex(store, { vectors, embedding }) {
  const sql = store.db;
  const hashOf = (row) => createHash('sha256').update(embedding.modelId() + '\u0000' + documentText(row)).digest('hex');

  function claim(limit, at) {
    return sql
      .transaction(() => {
        const rows = sql
          .prepare("SELECT memory_id,indexed_hash,indexed_model,attempts,status FROM vector_index_state WHERE (status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<?) ORDER BY updated_at LIMIT ?")
          .all(at, at, limit);
        const take = sql.prepare("UPDATE vector_index_state SET status='processing',lease_until=? WHERE memory_id=? AND (status='pending' OR (status='processing' AND lease_until<?))");
        return rows.filter((r) => take.run(at + LEASE_MS, r.memory_id, at).changes);
      })
      .immediate();
  }
  const done = (id, status, fields = {}) =>
    sql
      .prepare('UPDATE vector_index_state SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=?,indexed_hash=?,indexed_model=?,indexed_at=? WHERE memory_id=?')
      .run(status, fields.attempts ?? 0, fields.next ?? 0, fields.error ?? null, fields.hash ?? null, fields.model ?? null, fields.indexedAt ?? null, id);
  const retryLater = (state, error, at, { permanent = false } = {}) => {
    const attempts = state.attempts + 1;
    const final = permanent || attempts >= MAX_ATTEMPTS;
    sql
      .prepare('UPDATE vector_index_state SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=? WHERE memory_id=?')
      .run(final ? 'failed' : 'pending', attempts, final ? 0 : at + backoff(attempts), String(error).slice(0, 300), state.memory_id);
  };

  /** One pass: claim a batch and make ChromaDB match SQLite for it. Safe to run concurrently. */
  async function processPending({ limit = 50, at = Date.now() } = {}) {
    if (!vectors.enabled) return { skipped: 'vector store not configured', indexed: 0, removed: 0, unchanged: 0, failed: 0 };
    const states = claim(limit, at);
    const out = { indexed: 0, removed: 0, unchanged: 0, failed: 0 };
    if (!states.length) return out;
    const modelId = embedding.modelId();
    const rows = new Map();
    for (let i = 0; i < states.length; i += 200) {
      const ids = states.slice(i, i + 200).map((s) => s.memory_id);
      for (const r of sql.prepare(`SELECT * FROM memory_pool WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) rows.set(r.id, r);
    }
    const toRemove = [];
    const toIndex = [];
    for (const s of states) {
      const row = rows.get(s.memory_id);
      if (!row || row.status !== 'active') toRemove.push(s);
      else if (s.indexed_hash && s.indexed_model === modelId && s.indexed_hash === hashOf(row)) {
        done(s.memory_id, 'indexed', { hash: s.indexed_hash, model: modelId, indexedAt: iso(at) });
        out.unchanged++;
      } else toIndex.push({ state: s, row });
    }
    // Removals: from the collection of the model that holds the vector (the current one when unknown).
    const byModel = new Map();
    for (const s of toRemove) byModel.set(s.indexed_model || modelId, [...(byModel.get(s.indexed_model || modelId) || []), s]);
    for (const [model, list] of byModel) {
      try {
        await vectors.deleteKnowledgeVectors(model, list.map((s) => s.memory_id));
        for (const s of list) done(s.memory_id, 'absent', { indexedAt: iso(at) });
        out.removed += list.length;
      } catch (e) {
        for (const s of list) retryLater(s, e.message, at);
        out.failed += list.length;
      }
    }
    if (toIndex.length) {
      try {
        const { vectors: embedded, model } = await embedding.embedDocuments(toIndex.map((x) => documentText(x.row)));
        await vectors.upsertKnowledgeVectors(
          model,
          toIndex.map((x, i) => ({ id: x.row.id, vector: embedded[i], companyId: x.row.company_id, chatbotId: x.row.chatbot_id, origin: x.row.origin_type, version: x.row.version_number, contentHash: x.row.content_hash })),
        );
        for (const x of toIndex) {
          done(x.state.memory_id, 'indexed', { hash: hashOf(x.row), model, indexedAt: iso(at) });
          // A model change leaves the old vector in the old model's collection: remove it (best effort).
          if (x.state.indexed_model && x.state.indexed_model !== model) vectors.deleteKnowledgeVectors(x.state.indexed_model, [x.row.id]).catch(() => {});
        }
        out.indexed += toIndex.length;
      } catch (e) {
        for (const x of toIndex) retryLater(x.state, e.message, at, { permanent: e.transient === false });
        out.failed += toIndex.length;
      }
    }
    return out;
  }

  /** Process until nothing is due (bounded), for the worker and for tests. */
  async function drain({ at = Date.now(), maxBatches = 20 } = {}) {
    const total = { indexed: 0, removed: 0, unchanged: 0, failed: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const r = await processPending({ at });
      if (r.skipped) return { ...total, skipped: r.skipped };
      for (const k of Object.keys(total)) total[k] += r[k];
      if (!r.indexed && !r.removed && !r.unchanged && !r.failed) break;
    }
    return total;
  }

  /** Queue everything for re-embedding (after a model change or index loss). Optionally for one company. */
  function reindexKnowledge({ companyId = null } = {}) {
    const q = `UPDATE vector_index_state SET status='pending',indexed_hash=NULL,attempts=0,next_attempt_at=0,last_error=NULL,updated_at=? ${companyId ? 'WHERE company_id=?' : ''}`;
    return sql.prepare(q).run(...(companyId ? [iso(), companyId] : [iso()])).changes;
  }
  /** Vectors made by a different model than the current one are stale: queue them for the current model. */
  function markStale() {
    return sql
      .prepare("UPDATE vector_index_state SET status='pending',attempts=0,next_attempt_at=0,updated_at=? WHERE status IN ('indexed','absent') AND indexed_model IS NOT NULL AND indexed_model<>?")
      .run(iso(), embedding.modelId()).changes;
  }
  /** Failed jobs stay visible until someone retries them. */
  function retryFailed({ companyId = null } = {}) {
    return sql
      .prepare(`UPDATE vector_index_state SET status='pending',attempts=0,next_attempt_at=0,last_error=NULL,updated_at=? WHERE status='failed' ${companyId ? 'AND company_id=?' : ''}`)
      .run(...(companyId ? [iso(), companyId] : [iso()])).changes;
  }

  /**
   * Compare the index with SQLite: delete vectors that should not exist (retired, superseded, deleted or foreign)
   * and queue active knowledge that is missing. Returns what it changed.
   */
  async function reconcileVectorIndex() {
    if (!vectors.enabled) return { skipped: 'vector store not configured' };
    const modelId = embedding.modelId();
    const inIndex = await vectors.listIds(modelId);
    const active = new Set(sql.prepare("SELECT id FROM memory_pool WHERE status='active'").all().map((r) => r.id));
    const orphans = inIndex.filter((id) => !active.has(id));
    if (orphans.length) await vectors.deleteKnowledgeVectors(modelId, orphans);
    const present = new Set(inIndex);
    const missing = [...active].filter((id) => !present.has(id));
    const queue = sql.prepare("UPDATE vector_index_state SET status='pending',indexed_hash=NULL,attempts=0,next_attempt_at=0,updated_at=? WHERE memory_id=?");
    sql.transaction(() => missing.forEach((id) => queue.run(iso(), id)))();
    return { inIndex: inIndex.length, removedOrphans: orphans.length, queuedMissing: missing.length };
  }

  function summary() {
    const counts = Object.fromEntries(sql.prepare('SELECT status,COUNT(*) AS n FROM vector_index_state GROUP BY status').all().map((r) => [r.status, r.n]));
    const oldest = sql.prepare("SELECT MIN(updated_at) AS t FROM vector_index_state WHERE status='pending'").get()?.t;
    const stale = sql.prepare("SELECT COUNT(*) AS n FROM vector_index_state WHERE indexed_model IS NOT NULL AND indexed_model<>? AND status<>'absent'").get(embedding.modelId()).n;
    return {
      indexed: counts.indexed || 0,
      pending: (counts.pending || 0) + (counts.processing || 0),
      failed: counts.failed || 0,
      stale,
      oldestPendingSeconds: oldest ? Math.max(0, Math.round((Date.now() - Date.parse(oldest)) / 1000)) : 0,
      failedJobs: sql.prepare("SELECT memory_id AS id,company_id AS companyId,attempts,last_error AS error FROM vector_index_state WHERE status='failed' LIMIT 20").all(),
    };
  }
  async function health({ probe = false } = {}) {
    return {
      sqlite: { ok: Boolean(sql.prepare('SELECT 1 AS x').get()) },
      vectorStore: await vectors.getVectorStoreHealth({ probe, modelId: embedding.modelId() }),
      embedding: embedding.health(),
      index: summary(),
    };
  }

  /** What one company needs to know, in plain terms. Nothing here reveals another company's data. */
  function companyHealth(companyId) {
    const counts = Object.fromEntries(sql.prepare('SELECT status,COUNT(*) AS n FROM vector_index_state WHERE company_id=? GROUP BY status').all(companyId).map((r) => [r.status, r.n]));
    const failedJobs = sql.prepare("SELECT memory_id AS id,attempts,last_error AS error FROM vector_index_state WHERE company_id=? AND status='failed' LIMIT 20").all(companyId);
    return { indexed: counts.indexed || 0, pending: (counts.pending || 0) + (counts.processing || 0), failed: counts.failed || 0, failedJobs };
  }
  return { processPending, drain, reindexKnowledge, markStale, retryFailed, reconcileVectorIndex, summary, companyHealth, health, hashOf };
}
