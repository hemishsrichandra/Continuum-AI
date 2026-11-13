// Durable SQLite -> ChromaDB indexing.
//
// SQLite and ChromaDB cannot share a transaction, so indexing is a persistent desired-state loop with explicit concurrency control:
//  * triggers on memory_pool (migration 9) mark a memory "pending" and BUMP ITS GENERATION whenever anything that affects the index
//    changes (content, applicability, safety restrictions, status, origin, version, tenant or service) - from any code path
//  * a worker CLAIMS a job with a lease and a unique token, remembering the generation it claimed
//  * every state transition a worker makes is conditional on "still my token AND still that generation", so a worker that was slow,
//    crashed, or was overtaken can never mark a newer change as done or overwrite a newer pending/removal request
//  * after the slow step (embedding) the worker re-reads the authoritative row and skips the write if the generation moved
//  * if a stale write nevertheless reached ChromaDB, completion fails and the job is re-queued so the next worker repairs it
//  * upserts use the passport id and a per-document hash, so duplicates and retries are idempotent; unchanged content is not embedded again
//  * only 'active' knowledge is indexed; anything else (flagged, superseded, retired, deleted) is removed
import { createHash, randomUUID } from 'node:crypto';
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
  // Everything that determines what is stored in the index for a passport: the embedded text AND the metadata filters run on.
  const hashOf = (row) =>
    createHash('sha256').update([embedding.modelId(), documentText(row), row.origin_type, row.version_number, row.company_id, row.chatbot_id].join('\u0000')).digest('hex');

  function claim(limit, at) {
    return sql
      .transaction(() => {
        const rows = sql
          .prepare("SELECT memory_id,indexed_hash,indexed_model,attempts,status,generation FROM vector_index_state WHERE (status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<?) ORDER BY updated_at LIMIT ?")
          .all(at, at, limit);
        const take = sql.prepare("UPDATE vector_index_state SET status='processing',lease_until=?,claim_token=?,claimed_generation=generation WHERE memory_id=? AND (status='pending' OR (status='processing' AND lease_until<?))");
        return rows.filter((r) => {
          r.token = randomUUID();
          return take.run(at + LEASE_MS, r.token, r.memory_id, at).changes > 0;
        });
      })
      .immediate();
  }
  // A transition succeeds only for the claim (token) and generation this worker actually took. Returns whether it did.
  const settle = (state, status, fields = {}) =>
    sql
      .prepare('UPDATE vector_index_state SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=?,indexed_hash=?,indexed_model=?,indexed_at=?,claim_token=NULL WHERE memory_id=? AND claim_token=? AND generation=?')
      .run(status, fields.attempts ?? 0, fields.next ?? 0, fields.error ?? null, fields.hash ?? null, fields.model ?? null, fields.indexedAt ?? null, state.memory_id, state.token, state.generation).changes > 0;
  // We wrote to the vector store but a newer change arrived meanwhile. If a newer job already finished, our write may have landed after
  // its result, so put the memory back in the queue and let the next worker re-verify it from SQLite.
  const requeueIfSettled = (state) =>
    sql.prepare("UPDATE vector_index_state SET status='pending',indexed_hash=NULL,attempts=0,next_attempt_at=0,claim_token=NULL,updated_at=? WHERE memory_id=? AND status IN ('indexed','absent') AND generation<>?").run(iso(), state.memory_id, state.generation);
  const retryLater = (state, error, at, { permanent = false } = {}) => {
    const attempts = state.attempts + 1;
    const final = permanent || attempts >= MAX_ATTEMPTS;
    sql
      .prepare('UPDATE vector_index_state SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=?,claim_token=NULL WHERE memory_id=? AND claim_token=? AND generation=?')
      .run(final ? 'failed' : 'pending', attempts, final ? 0 : at + backoff(attempts), String(error).slice(0, 300), state.memory_id, state.token, state.generation);
  };
  /** Is this claim still the current word on the memory? (read after any slow step) */
  const stillCurrent = (state) => Boolean(sql.prepare('SELECT 1 FROM vector_index_state WHERE memory_id=? AND claim_token=? AND generation=?').get(state.memory_id, state.token, state.generation));

  /** One pass: claim a batch and make ChromaDB match SQLite for it. Safe to run concurrently, in several processes. */
  async function processPending({ limit = 50, at = Date.now() } = {}) {
    if (!vectors.enabled) return { skipped: 'vector store not configured', indexed: 0, removed: 0, unchanged: 0, failed: 0, stale: 0 };
    const states = claim(limit, at);
    const out = { indexed: 0, removed: 0, unchanged: 0, failed: 0, stale: 0 };
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
        if (settle(s, 'indexed', { hash: s.indexed_hash, model: modelId, indexedAt: iso(at) })) out.unchanged++;
        else out.stale++;
      } else toIndex.push({ state: s, row });
    }
    // Removals: from the collection of the model that holds the vector (the current one when unknown).
    const byModel = new Map();
    for (const s of toRemove) byModel.set(s.indexed_model || modelId, [...(byModel.get(s.indexed_model || modelId) || []), s]);
    for (const [model, list] of byModel) {
      try {
        await vectors.deleteKnowledgeVectors(model, list.map((s) => s.memory_id));
        for (const s of list) {
          if (settle(s, 'absent', { indexedAt: iso(at) })) out.removed++;
          else { out.stale++; requeueIfSettled(s); }
        }
      } catch (e) {
        for (const s of list) retryLater(s, e.message, at);
        out.failed += list.length;
      }
    }
    if (toIndex.length) {
      try {
        const { vectors: embedded, model } = await embedding.embedDocuments(toIndex.map((x) => documentText(x.row)));
        // The embedding call can take long. Re-read the authoritative rows now: anything that changed or lost its claim in the meantime
        // is NOT written (the newer pending job will handle it).
        const fresh = [];
        toIndex.forEach((x, i) => {
          const row = sql.prepare('SELECT * FROM memory_pool WHERE id=?').get(x.row.id);
          if (row && row.status === 'active' && stillCurrent(x.state) && hashOf(row) === hashOf(x.row)) fresh.push({ ...x, row, vector: embedded[i] });
          else out.stale++;
        });
        if (fresh.length) {
          await vectors.upsertKnowledgeVectors(
            model,
            fresh.map((x) => ({ id: x.row.id, vector: x.vector, companyId: x.row.company_id, chatbotId: x.row.chatbot_id, origin: x.row.origin_type, version: x.row.version_number, contentHash: x.row.content_hash, docHash: hashOf(x.row) })),
          );
          for (const x of fresh) {
            if (settle(x.state, 'indexed', { hash: hashOf(x.row), model, indexedAt: iso(at) })) {
              out.indexed++;
              // A model change leaves the old vector in the old model's collection: remove it (best effort).
              if (x.state.indexed_model && x.state.indexed_model !== model) vectors.deleteKnowledgeVectors(x.state.indexed_model, [x.row.id]).catch(() => {});
            } else { out.stale++; requeueIfSettled(x.state); }
          }
        }
      } catch (e) {
        for (const x of toIndex) retryLater(x.state, e.message, at, { permanent: e.transient === false });
        out.failed += toIndex.length;
      }
    }
    return out;
  }

  /** Process until nothing is due (bounded), for the worker and for tests. */
  async function drain({ at = Date.now(), maxBatches = 20 } = {}) {
    const total = { indexed: 0, removed: 0, unchanged: 0, failed: 0, stale: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const r = await processPending({ at });
      if (r.skipped) return { ...total, skipped: r.skipped };
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
      if (!r.indexed && !r.removed && !r.unchanged && !r.failed && !r.stale) break;
    }
    return total;
  }

  /** Queue everything for re-embedding (after a model change or index loss). Optionally for one company. */
  function reindexKnowledge({ companyId = null } = {}) {
    const q = `UPDATE vector_index_state SET status='pending',indexed_hash=NULL,attempts=0,next_attempt_at=0,last_error=NULL,generation=generation+1,claim_token=NULL,updated_at=? ${companyId ? 'WHERE company_id=?' : ''}`;
    return sql.prepare(q).run(...(companyId ? [iso(), companyId] : [iso()])).changes;
  }
  /** Vectors made by a different model than the current one are stale: queue them for the current model. */
  function markStale() {
    return sql
      .prepare("UPDATE vector_index_state SET status='pending',attempts=0,next_attempt_at=0,generation=generation+1,claim_token=NULL,updated_at=? WHERE status IN ('indexed','absent') AND indexed_model IS NOT NULL AND indexed_model<>?")
      .run(iso(), embedding.modelId()).changes;
  }
  /** Failed jobs stay visible until someone retries them. */
  function retryFailed({ companyId = null } = {}) {
    return sql
      .prepare(`UPDATE vector_index_state SET status='pending',attempts=0,next_attempt_at=0,last_error=NULL,generation=generation+1,claim_token=NULL,updated_at=? WHERE status='failed' ${companyId ? 'AND company_id=?' : ''}`)
      .run(...(companyId ? [iso(), companyId] : [iso()])).changes;
  }

  /**
   * Compare the index with SQLite: delete vectors that should not exist (retired, superseded, deleted or foreign), queue active knowledge that
   * is missing, and queue vectors whose stored document hash no longer matches what SQLite would index now (content, applicability,
   * origin, version or tenant changed). Returns what it changed.
   */
  async function reconcileVectorIndex() {
    if (!vectors.enabled) return { skipped: 'vector store not configured' };
    const modelId = embedding.modelId();
    const entries = await vectors.listEntries(modelId);
    const active = new Map(sql.prepare("SELECT * FROM memory_pool WHERE status='active'").all().map((r) => [r.id, r]));
    const orphans = entries.filter((e) => !active.has(e.id)).map((e) => e.id);
    if (orphans.length) await vectors.deleteKnowledgeVectors(modelId, orphans);
    const present = new Map(entries.map((e) => [e.id, e.metadata || {}]));
    const missing = [];
    const outdated = [];
    for (const [id, row] of active) {
      if (!present.has(id)) missing.push(id);
      else if (present.get(id).doc_hash !== hashOf(row)) outdated.push(id);
    }
    const queue = sql.prepare("UPDATE vector_index_state SET status='pending',indexed_hash=NULL,attempts=0,next_attempt_at=0,generation=generation+1,claim_token=NULL,updated_at=? WHERE memory_id=?");
    sql.transaction(() => [...missing, ...outdated].forEach((id) => queue.run(iso(), id)))();
    return { inIndex: entries.length, removedOrphans: orphans.length, queuedMissing: missing.length, queuedOutdated: outdated.length };
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
