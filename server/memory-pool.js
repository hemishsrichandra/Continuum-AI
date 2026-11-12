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
import { insertPassport, ORIGINS, ORIGIN_LABELS, signatureOf, stepsList, computeInitialConfidence, normalizeApplicability, normalizeSafety } from './passports.js';
import { containsSecret, scrubPII } from './privacy.js';

const now = () => new Date().toISOString();
const parse = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

export function passportView(row, { internal = true } = {}) {
  if (!row) return null;
  const evidence = parse(row.verification_evidence_json, {});
  const provenance = parse(row.provenance_json, {});
  const unconfirmed = row.origin_type === 'auto_published_overdue' && !row.customer_confirmed;
  return {
    id: row.id,
    title: row.title,
    symptoms: row.symptoms_text,
    applicability: parse(row.applicability_json, {}),
    safety: parse(row.safety_restrictions_json, {}),
    steps: parse(row.steps_json, []),
    origin: row.origin_type,
    originLabel: ORIGIN_LABELS[row.origin_type],
    verification: row.customer_confirmed
      ? 'customer_confirmed'
      : unconfirmed
        ? 'unconfirmed_by_customer'
        : row.origin_type === 'company_db_sync'
          ? evidence.declaredVerified ? 'imported_declared_verified' : 'imported_unverified'
          : row.origin_type === 'standard_playbook'
            ? 'company_configured'
            : 'not_customer_confirmed',
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
    reviewNote: row.review_note,
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

export function createMemoryPool(store, config = {}) {
  const sql = store.db;
  const remoteModel = config.EMBEDDING_MODEL && config.OPENAI_API_KEY ? config.EMBEDDING_MODEL : null;
  const remoteCache = new Map();
  let remoteDown = 0;

  async function remoteEmbed(texts) {
    if (!remoteModel || Date.now() < remoteDown) return null;
    const missing = texts.filter((t) => !remoteCache.has(t));
    try {
      if (missing.length) {
        const r = await fetch((config.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/embeddings', {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.OPENAI_API_KEY },
          body: JSON.stringify({ model: remoteModel, input: missing }),
        });
        if (!r.ok) throw new Error('Embedding HTTP ' + r.status);
        const body = await r.json();
        missing.forEach((t, i) => {
          const v = body.data?.[i]?.embedding;
          if (!Array.isArray(v)) throw new Error('Invalid embedding response');
          if (remoteCache.size > 2000) remoteCache.clear();
          remoteCache.set(t, Float32Array.from(v));
        });
      }
      return texts.map((t) => remoteCache.get(t));
    } catch (e) {
      // Fall back to the offline representation for 5 minutes; never fail the request.
      remoteDown = Date.now() + 300000;
      console.warn('Embedding backend unavailable; using local fallback:', e.message);
      return null;
    }
  }
  const docText = (row) => `${row.title}\n${row.symptoms_text}\n${stepsList(parse(row.steps_json, [])).join(' ')}`;

  function scoped(companyId, chatbotId, id) {
    return sql.prepare('SELECT * FROM memory_pool WHERE id=? AND company_id=? AND chatbot_id=?').get(id, companyId, chatbotId);
  }

  /**
   * Hybrid retrieval for one company + chatbot. Returns at most three eligible,
   * distinct suggestions plus withheld (unknown applicability) candidates and the
   * internal evidence for each decision.
   */
  async function retrieve({ companyId, chatbotId, text, factsText, fields = {}, excludeIds = new Set(), excludeSignatures = new Set(), allowedOrigins = ORIGINS, limit = THRESHOLDS.maxSuggestions }) {
    if (!companyId || !chatbotId) throw fault(403, 'A company and service scope is required.');
    const origins = allowedOrigins.filter((o) => ORIGINS.includes(o));
    if (!origins.length) return { eligible: [], withheld: [], rejected: [], backend: 'none' };
    // 1. SQL prefilter (hard tenant, service, status and source gates).
    const rows = sql
      .prepare(
        `SELECT * FROM memory_pool WHERE company_id=? AND chatbot_id=? AND status='active' AND origin_type IN (${origins.map(() => '?').join(',')})`,
      )
      .all(companyId, chatbotId, ...origins)
      .filter((r) => !excludeIds.has(r.id) && !excludeSignatures.has(signatureOf(parse(r.steps_json, []))));
    if (!rows.length) return { eligible: [], withheld: [], rejected: [], backend: LOCAL_EMBEDDING_MODEL };
    const queryTokens = tokens(text);
    // 2a. FTS5 BM25 lexical retrieval, joined back to the scoped table.
    const raw = new Map();
    if (queryTokens.size) {
      const match = [...queryTokens].map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
      for (const r of sql
        .prepare(
          `SELECT f.memory_id AS id, bm25(memory_pool_fts, 0.0, 0.0, 2.0, 2.0, 0.5) AS score FROM memory_pool_fts f
           JOIN memory_pool m ON m.id=f.memory_id AND m.company_id=f.company_id
           WHERE memory_pool_fts MATCH ? AND m.company_id=? AND m.chatbot_id=? AND m.status='active'`,
        )
        .all(match, companyId, chatbotId))
        raw.set(r.id, -r.score);
    }
    const rawBest = Math.max(0, ...[...raw.values()]);
    // 2b. Embeddings: configured remote backend where available, else local.
    let backend = LOCAL_EMBEDDING_MODEL;
    let qVec = localEmbedding(text);
    // Rows embedded by an older local model version are re-embedded once and stored again.
    const refresh = sql.prepare('UPDATE memory_pool SET embedding_blob=?,embedding_model=? WHERE id=? AND company_id=?');
    let vectors = rows.map((r) => {
      if (r.embedding_model === LOCAL_EMBEDDING_MODEL && r.embedding_blob) {
        const stored = blobToVector(r.embedding_blob);
        // A stored vector of the wrong dimension is corrupt or from another model: never compare it.
        if (stored && stored.length === EMBEDDING_DIMENSIONS) return stored;
      }
      const v = localEmbedding(docText(r));
      if (!r.embedding_model || r.embedding_model.startsWith('local-hashed-concepts')) refresh.run(vectorToBlob(v), LOCAL_EMBEDDING_MODEL, r.id, companyId);
      return v;
    });
    const remote = await remoteEmbed([text, ...rows.map(docText)]);
    if (remote) {
      // A remote result is only usable if every vector has the same dimension as the query vector.
      const dimension = remote[0]?.length;
      if (dimension && remote.every((v) => v?.length === dimension)) {
        backend = remoteModel;
        [qVec, ...vectors] = remote;
      } else console.warn('Embedding dimensions were inconsistent; using the local representation.');
    }
    // `text` drives similarity; `factsText` (default: text) drives compatibility and safety, so a
    // short follow-up message can be matched on its own while still honouring the ticket's device facts.
    const gateText = factsText ?? text;
    const facts = customerFacts(gateText, fields);
    const scoredRows = rows.map((r, i) => {
      const cos = cosine(qVec, vectors[i]);
      const bm = normBm25({ raw: raw.has(r.id) ? raw.get(r.id) : null, rawBest, queryTokens, docTokens: tokens(r.title + ' ' + r.symptoms_text) });
      const hybrid = hybridScore(cos, bm);
      const gate = compatibilityGate({ applicability: parse(r.applicability_json, {}), safety: parse(r.safety_restrictions_json, {}), facts, text: gateText, fields });
      const w = reliability(r.initial_confidence_score, r.reuse_success_count, r.reuse_failure_count);
      const final = gate.eligible ? finalScore(hybrid, gate.compat, w) : 0;
      return {
        id: r.id,
        row: r,
        signature: signatureOf(parse(r.steps_json, [])),
        eligible: gate.eligible,
        gate,
        hybrid,
        finalScore: final,
        breakdown: { cosine: cos === null ? null : Math.round(cos * 10000) / 10000, normBm25: bm, S_hybrid: hybrid, S_compat: gate.compat, W_reliability: w, S_final: final, C_init: r.initial_confidence_score },
      };
    });
    const eligible = rankCandidates(scoredRows, limit);
    // Relevant candidates whose required facts are unknown: ask, never assume.
    const withheld = scoredRows
      .filter((c) => c.gate.status === 'unknown' && finalScore(c.hybrid, 1, c.breakdown.W_reliability) >= THRESHOLDS.retrieval)
      .map((c) => ({ id: c.id, title: c.row.title, missing: c.gate.reasons }));
    const rejected = scoredRows.filter((c) => !eligible.includes(c)).map((c) => ({ id: c.id, status: c.gate.status, reasons: c.gate.reasons, S_final: c.finalScore }));
    return { eligible, withheld, rejected, backend };
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
    const passport = screen({
      title: field(input.title, 'title', 100),
      symptoms: field(input.symptoms, 'symptoms', 1000),
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
    return sql.transaction(() => {
      const r = scoped(staff.companyId, staff.chatbotId, memoryId);
      if (!r) throw fault(404, 'Resolution not found.');
      if (r.status !== 'flagged_for_review') throw fault(409, 'This resolution no longer needs review.');
      if (reviewRevision !== undefined && reviewRevision !== r.reuse_failure_count) throw fault(409, 'Another failure report arrived. Refresh before completing the review.');
      sql.prepare('UPDATE memory_pool SET status=?,consecutive_failures=CASE WHEN ?=\'keep\' THEN 0 ELSE consecutive_failures END,locally_reviewed=1,review_note=?,flagged_reason=CASE WHEN ?=\'keep\' THEN NULL ELSE flagged_reason END,updated_at=? WHERE id=? AND company_id=?')
        .run(decision === 'keep' ? 'active' : 'retired', decision, note.trim(), decision, now(), r.id, staff.companyId);
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
    retrieve,
    recordOutcome,
    revise,
    review,
    screen,
    specialistHistory,
    get: (companyId, chatbotId, id) => scoped(companyId, chatbotId, id),
    list(companyId, chatbotId, { history = true } = {}) {
      return sql
        .prepare(`SELECT * FROM memory_pool WHERE company_id=? AND chatbot_id=? ${history ? '' : "AND status IN ('active','flagged_for_review')"} ORDER BY lineage_id, version_number DESC`)
        .all(companyId, chatbotId)
        .map((r) => passportView(r));
    },
    insert: (p) => insertPassport(sql, p),
  };
}
