// Unified company memory: hybrid lexical + semantic retrieval over Resolution
// Passports, outcome tracking, self-correction and versioning.
//
// Every query is scoped by company_id AND chatbot_id taken from the authorised
// profile. FTS5 rows are always joined back to memory_pool with that scope; the
// FTS index is never treated as a security boundary.
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { tokens } from './context.js';
import { customerFacts } from './applicability.js';
import {
  THRESHOLDS,
  LOCAL_EMBEDDING_MODEL,
  localEmbedding,
  EMBEDDING_DIMENSIONS,
  blobToVector,
  vectorToBlob,
  cosine,
  normBm25,
  hybridScore,
  reliability,
  finalScore,
  compatibilityGate,
  rankCandidates,
  needsReviewFlag,
} from './scoring.js';
import { insertPassport, ORIGINS, ORIGIN_LABELS, verificationOf, SOURCE_LABELS, refreshFacets, signatureOf, stepsList, computeInitialConfidence, normalizeApplicability, normalizeSafety } from './passports.js';
import { containsSecret, scrubPII } from './privacy.js';
import { createEmbeddingService } from './embedding-service.js';
import { createVectorStore } from './vector-store.js';
import { documentText } from './vector-index.js';
import { safeReceipt, sanitizeText } from './privacy-sanitizer.js';
import { reviewStatusOf } from './knowledge-lifecycle.js';

const now = () => new Date().toISOString();
const parse = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

// Why a customer said a suggested fix did not help. A near-miss lowers that fix's rank ONLY for customers in a similar situation
// (the same device or version facts); how much depends on the reason. "could_not_do_step" says little about the fix itself.
export const NEAR_MISS_REASONS = Object.freeze({
  no_change: 0.04,
  different_problem: 0.08,
  made_worse: 0.1,
  could_not_do_step: 0.01,
  unspecified: 0.03,
});
const NEAR_MISS_CAP = 0.12;
export const factPairs = (facts = {}) => Object.entries(facts).flatMap(([key, f]) => (f.values || []).slice(0, 5).map((v) => key + ':' + v)).sort();

export function passportView(row, { internal = true } = {}) {
  if (!row) return null;
  // Re-applied on read: rows stored before the receipt policy existed can never re-expose raw values.
  const evidence = safeReceipt('evidence', row.verification_evidence_json);
  const provenance = safeReceipt('provenance', row.provenance_json);
  const unconfirmed = row.origin_type === 'auto_published_overdue' && !row.customer_confirmed;
  return {
    id: row.id,
    title: row.title,
    symptoms: row.symptoms_text,
    applicability: parse(row.applicability_json, {}),
    safety: parse(row.safety_restrictions_json, {}),
    steps: parse(row.steps_json, []),
    origin: row.origin_type,
    originLabel: row.origin_type === 'specialist_confirmed' && !row.customer_confirmed ? SOURCE_LABELS[verificationOf(row)] : ORIGIN_LABELS[row.origin_type],
    verification: verificationOf(row),
    revisedFrom: evidence.revisedFrom || null,
    sourceStatus: row.source_status || 'present',
    // Lifecycle: what a reviewer needs to judge this record without reading its source system.
    reviewStatus: reviewStatusOf(row),
    verificationBasis: verificationOf(row),
    lastSeenAt: row.last_seen_at || null,
    sourceVersion: row.source_version || null,
    retirementReason: row.status === 'retired' ? row.flagged_reason || (row.source_status === 'withdrawn' ? 'Withdrawn from the source' : 'Retired by a reviewer') : null,
    structured: parse(row.applicability_json, {}).structured || null,
    customerConfirmed: Boolean(row.customer_confirmed),
    unconfirmed,
    version: row.version_number,
    parentVersionId: row.parent_version_id,
    lineageId: row.lineage_id,
    status: row.status,
    riskLevel: row.risk_level,
    initialConfidence: row.initial_confidence_score,
    reliability: reliability(row.initial_confidence_score, row.reuse_success_count, row.reuse_failure_count),
    successes: row.reuse_success_count,
    failures: row.reuse_failure_count,
    consecutiveFailures: row.consecutive_failures,
    flaggedReason: row.flagged_reason,
    reviewNote: row.review_note ? sanitizeText(row.review_note).text : row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(internal && {
      sourceKey: row.source_key,
      sourceId: row.source_id,
      externalRecordId: row.external_record_id,
      sourceTicketId: row.source_ticket_id,
      evidence,
      provenance,
    }),
  };
}

export function createMemoryPool(store, config = {}, { embedding = createEmbeddingService(config), vectors = createVectorStore(config) } = {}) {
  const sql = store.db;
  const positive = (v, fallback) => (Number(v) > 0 ? Math.min(500, Math.floor(Number(v))) : fallback);
  const lexicalTopK = positive(config.LEXICAL_TOP_K, 20);
  const vectorTopK = positive(config.VECTOR_TOP_K, 20);
  // Without a vector index, pools up to this size are compared in full (stored vectors, no re-embedding); larger
  // pools are narrowed to the lexical candidates so a request never scans an unbounded table.
  const scanLimit = positive(config.SQLITE_SCAN_LIMIT, 300);
  // Upper bound when retrieval widens itself (see retrieve).
  const candidateCap = Math.max(lexicalTopK, vectorTopK, positive(config.CANDIDATE_CAP, 400));

  function scoped(companyId, chatbotId, id) {
    return sql.prepare('SELECT * FROM memory_pool WHERE id=? AND company_id=? AND chatbot_id=?').get(id, companyId, chatbotId);
  }

  /** Stored vectors for these rows under the current model; missing ones are embedded once and persisted. */
  async function rowVectors(rows, modelId, { localOnly = false } = {}) {
    const out = new Map();
    const missing = [];
    for (const r of rows) {
      const stored = r.embedding_model === modelId && r.embedding_blob ? blobToVector(r.embedding_blob) : null;
      // A stored vector of the wrong dimension is corrupt or from another model: never compare it.
      if (stored && stored.length && (modelId !== LOCAL_EMBEDDING_MODEL || stored.length === EMBEDDING_DIMENSIONS)) out.set(r.id, stored);
      else missing.push(r);
    }
    if (!missing.length) return out;
    const persist = sql.prepare('UPDATE memory_pool SET embedding_blob=?,embedding_model=? WHERE id=? AND company_id=?');
    if (localOnly || modelId === LOCAL_EMBEDDING_MODEL) {
      for (const r of missing) {
        const v = localEmbedding(documentText(r));
        out.set(r.id, v);
        persist.run(vectorToBlob(v), LOCAL_EMBEDDING_MODEL, r.id, r.company_id);
      }
      return out;
    }
    const { vectors: embedded, model } = await embedding.embedDocuments(missing.map(documentText));
    missing.forEach((r, i) => {
      out.set(r.id, embedded[i]);
      persist.run(vectorToBlob(embedded[i]), model.replace(/^openai:/, ''), r.id, r.company_id);
    });
    return out;
  }

  /**
   * Hybrid retrieval for one company + chatbot. Returns at most three eligible, distinct suggestions plus
   * withheld (unknown applicability) candidates and the internal evidence for each decision.
   *
   * Candidates come from two bounded branches - SQLite FTS5 (top-K lexical) and the vector index (top-K semantic) -
   * and are merged. Every candidate is then re-read from SQLite with the tenant, service, status and origin gates
   * applied, so the vector index can never widen what is recommendable. Safety and compatibility gates run before
   * ranking and cannot be overridden by similarity.
   */
  async function retrieve(args) {
    let result = await retrieveOnce(args, lexicalTopK, vectorTopK);
    // Near-identical fixes that differ only by device or version are not separable by text similarity, so a fixed
    // top-K can fill up with relevant-but-incompatible candidates. When that happens (and only then) look further.
    let lk = lexicalTopK, vk = vectorTopK;
    for (const factor of [4, 16]) {
      if (!result.widen) break;
      const nextL = Math.min(candidateCap, lexicalTopK * factor), nextV = Math.min(candidateCap, vectorTopK * factor);
      if (nextL === lk && nextV === vk) break;
      [lk, vk] = [nextL, nextV];
      result = await retrieveOnce(args, lk, vk);
      result.widened = { lexical: lk, semantic: vk };
    }
    delete result.widen;
    return result;
  }

  async function retrieveOnce({ companyId, chatbotId, text, factsText, fields = {}, excludeIds = new Set(), excludeSignatures = new Set(), allowedOrigins = ORIGINS, limit = THRESHOLDS.maxSuggestions }, lexicalTopK, vectorTopK) {
    if (!companyId || !chatbotId) throw fault(403, 'A company and service scope is required.');
    const origins = allowedOrigins.filter((o) => ORIGINS.includes(o));
    if (!origins.length) return { eligible: [], withheld: [], rejected: [], backend: 'none' };
    const originSql = origins.map(() => '?').join(',');
    // Device facets invalidated by an applicability edit (any code path, including direct SQL) are rebuilt before they are used.
    for (const stale of sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND facets_at IS NULL LIMIT 200').all(companyId)) refreshFacets(sql, stale);
    const poolSize = sql.prepare(`SELECT COUNT(*) AS n FROM memory_pool WHERE company_id=? AND chatbot_id=? AND status='active' AND origin_type IN (${originSql})`).get(companyId, chatbotId, ...origins).n;
    if (!poolSize) return { eligible: [], withheld: [], rejected: [], backend: embedding.model };
    const queryTokens = tokens(text);

    // Branch 1: SQLite FTS5 BM25, top-K, joined back to the scoped table.
    const raw = new Map();
    if (queryTokens.size) {
      const match = [...queryTokens].map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
      for (const r of sql
        .prepare(
          `SELECT f.memory_id AS id, bm25(memory_pool_fts, 0.0, 0.0, 2.0, 2.0, 0.5) AS score FROM memory_pool_fts f
           JOIN memory_pool m ON m.id=f.memory_id AND m.company_id=f.company_id
           WHERE memory_pool_fts MATCH ? AND m.company_id=? AND m.chatbot_id=? AND m.status='active' AND m.origin_type IN (${originSql})
           ORDER BY score LIMIT ?`,
        )
        .all(match, companyId, chatbotId, ...origins, lexicalTopK))
        raw.set(r.id, -r.score);
    }
    const rawBest = Math.max(0, ...[...raw.values()]);

    // Branch 2: semantic candidates from the vector index (when configured and reachable).
    const query = await embedding.embedQuery(text);
    const cosines = new Map();
    let source = 'sqlite';
    if (query && vectors.available()) {
      const hits = await vectors.searchKnowledgeVectors({ modelId: query.model, vector: query.vector, companyId, chatbotId, limit: vectorTopK });
      if (hits) {
        source = 'chroma';
        for (const h of hits) cosines.set(h.id, h.similarity);
      }
    }

    // Branch 3: fixes that name THIS device or version (indexed equality facets). Text similarity cannot separate fixes
    // that differ only by model or firmware, so without this a pool full of near-duplicates hides the right one.
    const gateFacts = customerFacts(factsText ?? text, fields);
    const facetPairs = Object.entries(gateFacts).flatMap(([key, f]) => f.values.slice(0, 5).map((v) => [key, v]));
    const facetHits = new Map();
    if (facetPairs.length) {
      const where = facetPairs.map(() => '(f.key=? AND f.value=?)').join(' OR ');
      for (const r of sql
        .prepare(
          `SELECT f.memory_id AS id, COUNT(*) AS hits FROM passport_facets f JOIN memory_pool m ON m.id=f.memory_id
           WHERE f.company_id=? AND f.chatbot_id=? AND m.status='active' AND m.origin_type IN (${originSql}) AND (${where})
           GROUP BY f.memory_id ORDER BY hits DESC LIMIT ?`,
        )
        .all(companyId, chatbotId, ...origins, ...facetPairs.flat(), Math.max(lexicalTopK, 50)))
        facetHits.set(r.id, r.hits);
    }
    // Candidate ids: union of the branches. Without the vector index a small pool is compared in full.
    const ids = new Set([...raw.keys(), ...cosines.keys(), ...facetHits.keys()]);
    // Knowledge the index has not caught up with yet (new, edited or re-queued) is still covered semantically from
    // SQLite, so a lagging or rebuilding index never hides recent knowledge.
    const unindexed = new Set();
    if (source === 'chroma')
      for (const r of sql
        .prepare(`SELECT m.id FROM memory_pool m LEFT JOIN vector_index_state v ON v.memory_id=m.id WHERE m.company_id=? AND m.chatbot_id=? AND m.status='active' AND m.origin_type IN (${originSql}) AND (v.status IS NULL OR v.status<>'indexed') ORDER BY m.updated_at DESC LIMIT ?`)
        .all(companyId, chatbotId, ...origins, scanLimit)) {
        unindexed.add(r.id);
        ids.add(r.id);
      }
    if (source === 'sqlite' && poolSize <= scanLimit)
      for (const r of sql.prepare(`SELECT id FROM memory_pool WHERE company_id=? AND chatbot_id=? AND status='active' AND origin_type IN (${originSql})`).all(companyId, chatbotId, ...origins)) ids.add(r.id);

    // Authoritative lookup: tenant, service, status and origin are enforced here, whatever the index returned.
    const rows = [];
    const wanted = [...ids];
    for (let i = 0; i < wanted.length; i += 200) {
      const chunk = wanted.slice(i, i + 200);
      rows.push(...sql
        .prepare(`SELECT * FROM memory_pool WHERE +company_id=? AND +chatbot_id=? AND +status='active' AND +origin_type IN (${originSql}) AND id IN (${chunk.map(() => '?').join(',')})`)
        .all(companyId, chatbotId, ...origins, ...chunk)
        .filter((r) => !excludeIds.has(r.id) && !excludeSignatures.has(signatureOf(parse(r.steps_json, [])))));
    }
    if (!rows.length) return { eligible: [], withheld: [], rejected: [], backend: embedding.model, source };

    // Candidates found by device facets or by the vector index may not be in the keyword top-K. Give them their real
    // keyword score (same query, same index) so they are compared fairly with the lexical hits.
    const unscoredLexical = queryTokens.size ? rows.filter((r) => !raw.has(r.id)).map((r) => r.id) : [];
    if (unscoredLexical.length) {
      const match = [...queryTokens].map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
      for (let i = 0; i < unscoredLexical.length; i += 200) {
        const chunk = unscoredLexical.slice(i, i + 200);
        for (const r of sql
          .prepare(`SELECT memory_id AS id, bm25(memory_pool_fts, 0.0, 0.0, 2.0, 2.0, 0.5) AS score FROM memory_pool_fts WHERE memory_pool_fts MATCH ? AND memory_id IN (${chunk.map(() => '?').join(',')})`)
          .all(match, ...chunk))
          raw.set(r.id, -r.score);
      }
    }
    const rawBestAll = Math.max(rawBest, 0, ...[...raw.values()]);

    // Cosine for candidates the vector index did not score (lexical-only hits), within the same embedding space.
    let backend = embedding.model;
    if (source === 'chroma') {
      const lagging = rows.filter((r) => unindexed.has(r.id));
      if (lagging.length) {
        try {
          const own = await rowVectors(lagging, embedding.isRemote ? embedding.model : LOCAL_EMBEDDING_MODEL);
          for (const r of lagging) if (own.get(r.id)?.length === query.vector.length) cosines.set(r.id, cosine(query.vector, own.get(r.id)));
        } catch { /* the worker will index these; until then they rely on the lexical branch */ }
      }
      const unscored = rows.filter((r) => !cosines.has(r.id) && !unindexed.has(r.id)).map((r) => r.id);
      if (unscored.length) {
        const more = await vectors.searchKnowledgeVectors({ modelId: query.model, vector: query.vector, companyId, chatbotId, limit: unscored.length, ids: unscored });
        if (more) for (const h of more) cosines.set(h.id, h.similarity);
      }
    } else {
      // SQLite semantic fallback: stored vectors (embedded once, persisted), query embedded now.
      let qVec = query?.vector;
      let model = query ? embedding.modelId() : LOCAL_EMBEDDING_MODEL;
      let stored;
      try {
        stored = query ? await rowVectors(rows, embedding.isRemote ? embedding.model : LOCAL_EMBEDDING_MODEL) : null;
        // A remote result is only usable when every vector has the query's dimension.
        if (stored && ![...stored.values()].every((v) => v?.length === qVec.length)) throw new Error('Embedding dimensions were inconsistent.');
      } catch (e) {
        console.warn('Embedding backend unavailable; using local fallback:', e.message);
        stored = null;
      }
      if (!stored) {
        qVec = localEmbedding(text);
        model = LOCAL_EMBEDDING_MODEL;
        stored = await rowVectors(rows, LOCAL_EMBEDDING_MODEL, { localOnly: true });
      }
      backend = model === LOCAL_EMBEDDING_MODEL ? LOCAL_EMBEDDING_MODEL : embedding.model;
      for (const r of rows) cosines.set(r.id, cosine(qVec, stored.get(r.id)));
    }

    // `text` drives similarity; `factsText` (default: text) drives compatibility and safety, so a
    // short follow-up message can be matched on its own while still honouring the ticket's device facts.
    const gateText = factsText ?? text;
    const facts = customerFacts(gateText, fields);
    const nearMisses = nearMissesFor(companyId, rows.map((r) => r.id));
    const stated = new Set(factPairs(facts));
    const scoredRows = rows.map((r) => {
      const cos = cosines.has(r.id) ? cosines.get(r.id) : null;
      const bm = normBm25({ raw: raw.has(r.id) ? raw.get(r.id) : null, rawBest: rawBestAll, queryTokens, docTokens: tokens(r.title + ' ' + r.symptoms_text) });
      const hybrid = hybridScore(cos, bm);
      const gate = compatibilityGate({ applicability: parse(r.applicability_json, {}), safety: parse(r.safety_restrictions_json, {}), facts, text: gateText, fields });
      const w = reliability(r.initial_confidence_score, r.reuse_success_count, r.reuse_failure_count);
      // A partly confirmed generic environment needs a strong enough semantic match; mandatory conditions never reach this branch.
      const usable = gate.eligible && (!gate.partial || hybrid >= THRESHOLDS.partialHybrid);
      const penalty = usable ? nearMissPenalty(nearMisses.get(r.id), stated) : 0;
      const final = usable ? Math.max(0, Math.round((finalScore(hybrid, gate.compat, w) - penalty) * 1e4) / 1e4) : 0;
      return {
        id: r.id,
        row: r,
        signature: signatureOf(parse(r.steps_json, [])),
        eligible: usable,
        gate,
        hybrid,
        finalScore: final,
        breakdown: { cosine: cos === null || cos === undefined ? null : Math.round(cos * 10000) / 10000, normBm25: bm, S_hybrid: hybrid, S_compat: gate.compat, W_reliability: w, S_final: final, C_init: r.initial_confidence_score, ...(penalty && { nearMissPenalty: penalty }) },
      };
    });
    const eligible = rankCandidates(scoredRows, limit);
    // Relevant candidates whose required facts are unknown: ask, never assume.
    const withheld = scoredRows
      .filter((c) => c.gate.status === 'unknown' && finalScore(c.hybrid, 1, c.breakdown.W_reliability) >= THRESHOLDS.retrieval)
      .map((c) => ({ id: c.id, title: c.row.title, missing: c.gate.reasons }));
    const rejected = scoredRows.filter((c) => !eligible.includes(c)).map((c) => ({ id: c.id, status: c.gate.status, reasons: c.gate.reasons, S_final: c.finalScore }));
    // Another, wider pass is worthwhile only if this one was full AND turned away relevant fixes on compatibility.
    const saturated = raw.size >= lexicalTopK || facetHits.size >= Math.max(lexicalTopK, 50) || (source === 'chroma' && cosines.size >= vectorTopK);
    const turnedAwayRelevant = scoredRows.some((c) => !c.eligible && ['conflict', 'unknown'].includes(c.gate.status) && finalScore(c.hybrid, 1, c.breakdown.W_reliability) >= THRESHOLDS.retrieval);
    const widen = eligible.length === 0 && saturated && turnedAwayRelevant && rows.length < poolSize;
    return { widen, eligible, withheld, rejected, backend, source, candidates: { lexical: raw.size, facets: facetHits.size, semantic: source === 'chroma' ? cosines.size : 0, unindexed: unindexed.size, merged: rows.length, poolSize } };
  }

  /** Near-miss rows for these fixes, grouped by fix. Only reasons and device/version facts: no customer identity. */
  function nearMissesFor(companyId, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      for (const r of sql.prepare(`SELECT memory_id, reason, facts_json FROM fix_near_misses WHERE company_id=? AND memory_id IN (${chunk.map(() => '?').join(',')})`).all(companyId, ...chunk)) {
        if (!out.has(r.memory_id)) out.set(r.memory_id, []);
        out.get(r.memory_id).push({ reason: r.reason, facts: parse(r.facts_json, []) });
      }
    }
    return out;
  }
  /**
   * Sum of the weights of earlier failures in a similar situation, capped. A failure is similar when, for every kind of fact both
   * sides state (model, firmware, OS ...), at least one value is shared; a failure on firmware 5 says nothing about firmware 4.
   * When the two sides share no kind of fact (or one side stated none) the failure counts half.
   */
  function nearMissPenalty(list, stated) {
    if (!list?.length) return 0;
    const byKey = (pairs) => pairs.reduce((m, p) => { const i = p.indexOf(':'); (m[p.slice(0, i)] ||= new Set()).add(p.slice(i + 1)); return m; }, {});
    const now = byKey([...stated]);
    let total = 0;
    for (const m of list) {
      const weight = NEAR_MISS_REASONS[m.reason] ?? NEAR_MISS_REASONS.unspecified;
      const then = byKey(m.facts);
      const common = Object.keys(then).filter((k) => now[k]);
      const similarity = !common.length ? 0.5 : common.every((k) => [...then[k]].some((v) => now[k].has(v))) ? 1 : 0;
      total += weight * similarity;
    }
    return Math.round(Math.min(NEAR_MISS_CAP, total) * 1e4) / 1e4;
  }
  /** Remember why a fix failed and in which situation. Idempotent per ticket; the note is sanitized and never holds a secret. */
  function recordNearMiss({ companyId, chatbotId, memoryId, ticketId = null, reason = 'unspecified', detail = '', factsText = '' }) {
    if (!scoped(companyId, chatbotId, memoryId)) return null;
    const kind = Object.hasOwn(NEAR_MISS_REASONS, reason) ? reason : 'unspecified';
    const note = typeof detail === 'string' && detail.trim() ? sanitizeText(detail.trim().slice(0, 300)) : null;
    if (note?.secret) throw fault(400, 'Remove credentials, tokens and keys from your note.');
    const pairs = factPairs(customerFacts(String(factsText || '')));
    sql.prepare(`INSERT INTO fix_near_misses(id,company_id,chatbot_id,memory_id,ticket_id,reason,detail,facts_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company_id,memory_id,ticket_id) DO UPDATE SET reason=excluded.reason, detail=excluded.detail, facts_json=excluded.facts_json`)
      .run(randomUUID(), companyId, chatbotId, memoryId, ticketId || 'unknown', kind, note?.text ?? null, JSON.stringify(pairs), now());
    return { reason: kind, facts: pairs };
  }

  /** Record a reuse outcome; flags for review at 2 consecutive failures or W < 0.55. */
  function recordOutcome({ companyId, chatbotId, memoryId, worked, safetyIncident = false, ticketId = null }) {
    return sql.transaction(() => {
      const r = scoped(companyId, chatbotId, memoryId);
      if (!r) return null;
      const successes = r.reuse_success_count + (worked ? 1 : 0);
      const failures = r.reuse_failure_count + (worked ? 0 : 1);
      const consecutive = worked ? 0 : r.consecutive_failures + 1;
      const check = needsReviewFlag({ consecutiveFailures: consecutive, cInit: r.initial_confidence_score, successes, failures });
      let status = r.status, reason = r.flagged_reason;
      if (safetyIncident) {
        status = 'flagged_for_review';
        reason = 'Quarantined after a reported safety incident';
      } else if (!worked && r.status === 'active' && check.flag) {
        status = 'flagged_for_review';
        reason = consecutive >= THRESHOLDS.consecutiveFailures ? `${consecutive} consecutive failures` : `Reliability ${check.reliability} below ${THRESHOLDS.reliabilityFlag}`;
      }
      sql.prepare('UPDATE memory_pool SET reuse_success_count=?,reuse_failure_count=?,consecutive_failures=?,status=?,flagged_reason=?,risk_level=CASE WHEN ? THEN \'high\' ELSE risk_level END,updated_at=? WHERE id=? AND company_id=?')
        .run(successes, failures, consecutive, status, reason, safetyIncident ? 1 : 0, now(), r.id, companyId);
      if (status === 'flagged_for_review' && r.status !== 'flagged_for_review') {
        sql.prepare(`INSERT INTO follow_through_tasks(id,company_id,chatbot_id,ticket_id,memory_id,task_type,dedupe_key,initial_confidence_score,deadline_at,status,created_at)
          VALUES(?,?,?,?,?,'failed_fix_review',?,?,?,'pending',?) ON CONFLICT(company_id,dedupe_key) DO UPDATE SET status='pending',deadline_at=excluded.deadline_at`)
          .run(randomUUID(), companyId, chatbotId, ticketId || r.source_ticket_id || 'knowledge', r.id, 'review:' + r.id + ':' + failures, r.initial_confidence_score, new Date(Date.now() + 24 * 3600000).toISOString(), now());
      }
      return { status, reliability: check.reliability, consecutiveFailures: consecutive, flagged: status === 'flagged_for_review' };
    }).immediate();
  }

  function screen(passport, names = []) {
    const all = [passport.title, passport.symptoms, passport.applicability?.environmentText, ...stepsList(passport.steps)].join('\n');
    if (containsSecret(all)) throw fault(400, 'Remove credentials and secrets from shared knowledge.');
    const clean = (t) => scrubPII(t, { names }).text;
    return {
      ...passport,
      title: clean(passport.title),
      symptoms: clean(passport.symptoms),
      steps: stepsList(passport.steps).map(clean),
      applicability: { ...passport.applicability, ...(passport.applicability?.environmentText && { environmentText: clean(passport.applicability.environmentText) }) },
      redactions: scrubPII(all, { names }).count,
    };
  }

  /** Publish a revised version: new row with parent link, previous row superseded atomically. */
  function revise(staff, memoryId, input) {
    const field = (v, name, max) => {
      if (typeof v !== 'string' || !v.trim() || v.length > max) throw fault(400, 'Enter a valid ' + name + '.');
      return v.trim();
    };
    if (input.confirmed !== true || input.reviewedForPrivacy !== true) throw fault(400, 'Confirm the revision and review it for private information.');
    // The searchable problem text of a revision is the previous version's (the customer's original issue); it is never typed.
    const prior = scoped(staff.companyId, staff.chatbotId, memoryId);
    if (!prior) throw fault(404, 'Resolution not found in this company and service.');
    const passport = screen({
      title: field(input.title, 'title', 100),
      symptoms: prior.symptoms_text,
      applicability: normalizeApplicability(input.applicability || { environmentText: field(input.environment, 'applicable environment', 500) }),
      safety: normalizeSafety(input.safety ?? ''),
      steps: [field(input.solution, 'solution steps', 2000)],
    });
    return sql.transaction(() => {
      const old = scoped(staff.companyId, staff.chatbotId, memoryId);
      if (!old) throw fault(404, 'Resolution not found in this company and service.');
      if (!['active', 'flagged_for_review'].includes(old.status)) throw fault(409, 'Only the current version can be revised.');
      if (input.version !== undefined && input.version !== old.version_number) throw fault(409, 'A newer version exists. Refresh before revising.');
      const c = computeInitialConfidence(passport, { author: { kind: 'staff', ...specialistHistory(staff.companyId, staff.id) } });
      const row = insertPassport(sql, {
        companyId: staff.companyId,
        chatbotId: staff.chatbotId,
        origin: old.origin_type === 'standard_playbook' ? 'specialist_confirmed' : old.origin_type,
        sourceKey: old.source_key,
        sourceId: old.source_id,
        externalRecordId: old.external_record_id,
        sourceTicketId: old.source_ticket_id,
        parentVersionId: old.id,
        lineageId: old.lineage_id,
        versionNumber: old.version_number + 1,
        ...passport,
        initialConfidence: c.score,
        customerConfirmed: false,
        locallyReviewed: true,
        evidence: { revisedFrom: old.id, previousVersion: old.version_number, revisedBy: staff.id, reviewNote: input.note || null, customerConfirmed: false },
        provenance: { cInit: c, revisedAt: now(), redactions: passport.redactions },
      });
      sql.prepare("UPDATE memory_pool SET status='superseded',updated_at=? WHERE id=? AND company_id=?").run(now(), old.id, staff.companyId);
      sql.prepare("UPDATE follow_through_tasks SET status='completed',processed_at=?,outcome_json=? WHERE company_id=? AND memory_id=? AND task_type='failed_fix_review' AND status='pending'")
        .run(now(), JSON.stringify({ decision: 'revised', newVersion: row.id }), staff.companyId, old.id);
      return passportView(row);
    }).immediate();
  }

  function review(staff, memoryId, { decision, note, confirmed, reviewRevision }) {
    if (confirmed !== true || !['keep', 'retire'].includes(decision)) throw fault(400, 'Confirm the review decision.');
    if (typeof note !== 'string' || !note.trim() || note.length > 1000) throw fault(400, 'Explain the review decision.');
    const cleanNote = sanitizeText(note.trim());
    if (cleanNote.secret) throw fault(400, 'Remove credentials, tokens and keys from review notes.');
    return sql.transaction(() => {
      const r = scoped(staff.companyId, staff.chatbotId, memoryId);
      if (!r) throw fault(404, 'Resolution not found.');
      if (r.status !== 'flagged_for_review') throw fault(409, 'This resolution no longer needs review.');
      if (reviewRevision !== undefined && reviewRevision !== r.reuse_failure_count) throw fault(409, 'Another failure report arrived. Refresh before completing the review.');
      sql.prepare('UPDATE memory_pool SET status=?,consecutive_failures=CASE WHEN ?=\'keep\' THEN 0 ELSE consecutive_failures END,locally_reviewed=1,review_note=?,flagged_reason=CASE WHEN ?=\'keep\' THEN NULL ELSE flagged_reason END,updated_at=? WHERE id=? AND company_id=?')
        .run(decision === 'keep' ? 'active' : 'retired', decision, cleanNote.text, decision, now(), r.id, staff.companyId);
      sql.prepare("UPDATE follow_through_tasks SET status='completed',processed_at=?,outcome_json=? WHERE company_id=? AND memory_id=? AND task_type='failed_fix_review' AND status='pending'")
        .run(now(), JSON.stringify({ decision, note }), staff.companyId, r.id);
      return passportView(scoped(staff.companyId, staff.chatbotId, r.id));
    }).immediate();
  }

  function specialistHistory(companyId, specialistId) {
    const rows = store.dataFor(companyId).resolutions.filter((r) => r.companyId === companyId && r.authorId === specialistId && typeof r.customerAccepted === 'boolean');
    return { accepted: rows.filter((r) => r.customerAccepted).length, rejected: rows.filter((r) => !r.customerAccepted).length };
  }

  return {
    embedding,
    vectors,
    retrieve,
    recordOutcome,
    recordNearMiss,
    revise,
    review,
    screen,
    specialistHistory,
    get: (companyId, chatbotId, id) => scoped(companyId, chatbotId, id),
    list(companyId, chatbotId, { history = true } = {}) {
      return sql
        .prepare(`SELECT m.*, v.status AS index_state FROM memory_pool m LEFT JOIN vector_index_state v ON v.memory_id=m.id WHERE m.company_id=? AND m.chatbot_id=? ${history ? '' : "AND m.status IN ('active','flagged_for_review')"} ORDER BY m.lineage_id, m.version_number DESC`)
        .all(companyId, chatbotId)
        .map((r) => {
          const view = passportView(r);
          // Only meaningful for knowledge that is meant to be searchable and only when a vector index is in use.
          if (vectors.enabled && r.status === 'active') view.searchStatus = r.index_state === 'indexed' ? 'ready' : r.index_state === 'failed' ? 'needs_attention' : 'updating';
          return view;
        });
    },
    insert: (p) => insertPassport(sql, p),
  };
}
