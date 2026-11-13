// Resolution Passport storage helpers (unified company memory pool).
//
// Takes an explicit better-sqlite3 handle; never opens a database itself. Used by
// Migration 5 (backfill), chatbot configuration (standard playbooks) and the
// memory-pool service. Tenant scope (company_id + chatbot_id) is mandatory on
// every read and write here.
import { createHash, randomUUID } from 'node:crypto';
import { tokens } from './context.js';
import {
  LOCAL_EMBEDDING_MODEL,
  localEmbedding,
  vectorToBlob,
  passportCompleteness,
  initialConfidence,
  authorReliability,
  diagnosticSimilarity,
} from './scoring.js';
import { conditionsFromText } from './applicability.js';
import { dangerousInstructions } from './privacy.js';
import { sanitizeForPublication, shapeEvidence, shapeProvenance } from './privacy-sanitizer.js';

export const ORIGINS = ['standard_playbook', 'company_db_sync', 'specialist_confirmed', 'auto_published_overdue'];
export const ORIGIN_LABELS = {
  standard_playbook: 'Standard playbook (company-configured)',
  company_db_sync: 'Imported from company database',
  specialist_confirmed: 'Specialist fix confirmed by a customer',
  auto_published_overdue: 'Specialist fix · UNCONFIRMED BY CUSTOMER (published after confirmation deadline)',
};

export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS company_data_sources (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL,
  name TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('sqlite','postgres','rest_api','csv_sync')),
  encrypted_connection_uri TEXT, field_mapping_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(field_mapping_json)),
  diagnostic_schema_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostic_schema_json)),
  declared_verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'configured',
  last_synced_at TEXT, last_sync_result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id));
CREATE INDEX IF NOT EXISTS data_source_company ON company_data_sources(company_id);
CREATE TABLE IF NOT EXISTS memory_pool (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL,
  parent_version_id TEXT REFERENCES memory_pool(id), lineage_id TEXT NOT NULL, version_number INTEGER NOT NULL DEFAULT 1 CHECK(version_number>=1),
  origin_type TEXT NOT NULL CHECK(origin_type IN ('standard_playbook','company_db_sync','specialist_confirmed','auto_published_overdue')),
  source_key TEXT NOT NULL, source_id TEXT, external_record_id TEXT, source_ticket_id TEXT, content_hash TEXT NOT NULL,
  title TEXT NOT NULL, symptoms_text TEXT NOT NULL, search_terms TEXT NOT NULL DEFAULT '',
  applicability_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(applicability_json)),
  safety_restrictions_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(safety_restrictions_json)),
  steps_json TEXT NOT NULL CHECK(json_valid(steps_json) AND json_type(steps_json)='array'),
  verification_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(verification_evidence_json)),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provenance_json)),
  embedding_blob BLOB, embedding_model TEXT,
  initial_confidence_score REAL NOT NULL CHECK(initial_confidence_score BETWEEN 0 AND 1),
  reuse_success_count INTEGER NOT NULL DEFAULT 0, reuse_failure_count INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','flagged_for_review','superseded','retired')),
  customer_confirmed INTEGER NOT NULL DEFAULT 0, risk_level TEXT NOT NULL DEFAULT 'standard' CHECK(risk_level IN ('standard','high')),
  locally_reviewed INTEGER NOT NULL DEFAULT 0, review_note TEXT, flagged_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id),
  UNIQUE(company_id,source_key,version_number));
CREATE INDEX IF NOT EXISTS memory_pool_scope ON memory_pool(company_id,chatbot_id,status);
CREATE INDEX IF NOT EXISTS memory_pool_lineage ON memory_pool(company_id,lineage_id,version_number);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_pool_fts USING fts5(memory_id UNINDEXED, company_id UNINDEXED, title, symptoms_text, steps_text, tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS memory_pool_fts_insert AFTER INSERT ON memory_pool BEGIN
  INSERT INTO memory_pool_fts(memory_id,company_id,title,symptoms_text,steps_text)
  VALUES(NEW.id,NEW.company_id,NEW.title,NEW.symptoms_text||' '||NEW.search_terms,(SELECT group_concat(value,' ') FROM json_each(NEW.steps_json)));
END;
CREATE TRIGGER IF NOT EXISTS memory_pool_fts_update AFTER UPDATE OF title,symptoms_text,search_terms,steps_json,company_id ON memory_pool BEGIN
  DELETE FROM memory_pool_fts WHERE memory_id=OLD.id;
  INSERT INTO memory_pool_fts(memory_id,company_id,title,symptoms_text,steps_text)
  VALUES(NEW.id,NEW.company_id,NEW.title,NEW.symptoms_text||' '||NEW.search_terms,(SELECT group_concat(value,' ') FROM json_each(NEW.steps_json)));
END;
CREATE TRIGGER IF NOT EXISTS memory_pool_fts_delete AFTER DELETE ON memory_pool BEGIN
  DELETE FROM memory_pool_fts WHERE memory_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS follow_through_tasks (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT, ticket_id TEXT NOT NULL,
  customer_id TEXT, handoff_id TEXT, proposal_id TEXT, memory_id TEXT, assigned_specialist_id TEXT,
  task_type TEXT NOT NULL CHECK(task_type IN ('customer_confirmation_wait','sla_escalation','failed_fix_review')),
  dedupe_key TEXT NOT NULL, initial_confidence_score REAL, deadline_at TEXT NOT NULL, follow_up_sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','auto_published','escalated')),
  outcome_json TEXT, processed_at TEXT, created_at TEXT NOT NULL, UNIQUE(company_id,dedupe_key));
CREATE INDEX IF NOT EXISTS follow_through_due ON follow_through_tasks(company_id,status,deadline_at);
CREATE INDEX IF NOT EXISTS follow_through_ready ON follow_through_tasks(status,deadline_at);
CREATE TABLE IF NOT EXISTS case_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT, ticket_id TEXT NOT NULL,
  customer_id TEXT, kind TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)), actor TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS case_event_ticket ON case_events(company_id,chatbot_id,ticket_id,created_at);
`;

/**
 * Verification belongs to ONE version of a passport. A revision starts unverified by customers even when its
 * parent was confirmed: the new instructions have not been tried and confirmed by anyone yet.
 */
export function verificationOf(row) {
  let evidence = {};
  try { evidence = JSON.parse(row.verification_evidence_json || '{}'); } catch { /* keep empty */ }
  if (row.customer_confirmed) return 'customer_confirmed';
  if (row.origin_type === 'auto_published_overdue') return 'unconfirmed_by_customer';
  if (row.origin_type === 'company_db_sync') {
    if (row.status === 'flagged_for_review' && !row.locally_reviewed) return 'import_pending_review';
    if (row.locally_reviewed) return 'imported_approved';
    return evidence.declaredVerified ? 'imported_declared_verified' : 'imported_unverified';
  }
  if (row.origin_type === 'standard_playbook') return 'company_configured';
  if (evidence.revisedFrom) return 'specialist_revised';
  return 'not_customer_confirmed';
}
/** Plain, customer-safe wording for each verification state. */
export const SOURCE_LABELS = {
  customer_confirmed: 'Learned from a customer-confirmed specialist resolution',
  unconfirmed_by_customer: 'Specialist fix · UNCONFIRMED BY CUSTOMER',
  imported_declared_verified: "Imported from your company's support knowledge base",
  imported_approved: "Imported from your company's support knowledge base",
  imported_unverified: "Imported from your company's support knowledge base",
  import_pending_review: 'Imported · waiting for approval',
  company_configured: 'Standard playbook',
  specialist_revised: 'Updated by a specialist · not yet confirmed by a customer',
  not_customer_confirmed: 'Specialist fix · not yet confirmed by a customer',
};

export const stepsList = (steps) =>
  (Array.isArray(steps) ? steps : [steps]).map((s) => String(s ?? '').trim()).filter(Boolean);
export const stepsText = (row) => stepsList(typeof row.steps_json === 'string' ? JSON.parse(row.steps_json) : row.steps).join(' ');
export function signatureOf(steps) {
  return stepsList(steps)
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Normalise loosely-shaped applicability / safety input to stored JSON shapes. */
export function normalizeApplicability(input = {}) {
  if (typeof input === 'string') input = { environmentText: input };
  const out = {};
  if (input.environmentText) out.environmentText = String(input.environmentText).slice(0, 500);
  if (Array.isArray(input.conditions))
    out.conditions = input.conditions
      .filter((c) => c && /^[a-z][a-z0-9_]{0,49}$/.test(String(c.key)) && ['in', 'not_in', 'range', 'eq', 'neq'].includes(c.op))
      .slice(0, 20)
      .map((c) => ({
        key: String(c.key),
        op: c.op === 'eq' ? 'in' : c.op === 'neq' ? 'not_in' : c.op,
        ...(Array.isArray(c.values) && { values: c.values.slice(0, 20).map((v) => String(v).toLowerCase().slice(0, 100)) }),
        ...(c.min !== undefined && { min: String(c.min) }),
        ...(c.max !== undefined && { max: String(c.max) }),
        required: c.required !== false,
      }));
  if (input.structured && typeof input.structured === 'object') {
    const list = (v) => (Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 100)).filter(Boolean) : []);
    const structured = { problemCategory: list(input.structured.problemCategory), productFamily: list(input.structured.productFamily), models: list(input.structured.models) };
    for (const k of Object.keys(structured)) if (!structured[k].length) delete structured[k];
    if (Object.keys(structured).length) out.structured = structured;
  }
  if (input.universal === true) out.universal = true;
  if (input.reviewed === true) out.reviewed = true;
  return out;
}
export function normalizeSafety(input = {}) {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { restrictions: [] };
    if (/^none(?: identified)?\.?$/i.test(text)) return { restrictions: [], noneIdentified: true };
    return { restrictions: text.split(/\n|;/).map((t) => t.trim()).filter(Boolean).slice(0, 10).map((t) => normalizeRestriction(t)) };
  }
  if (!input || typeof input !== 'object') return { restrictions: [] };
  return {
    restrictions: (Array.isArray(input.restrictions) ? input.restrictions : []).slice(0, 10).map((r) => normalizeRestriction(r)).filter(Boolean),
    ...(input.noneIdentified === true && { noneIdentified: true }),
    ...(input.reviewed === true && { reviewed: true }),
  };
}
/**
 * One safety restriction. The machine-readable parts are always DERIVED from the restriction text and merged with
 * anything the author supplied: an empty or incomplete `keywords` array can never switch a restriction off.
 * A restriction that cannot be evaluated by machine (no hazard word, no condition, no trigger clause) is flagged
 * `unevaluable`, and the compatibility gate treats it as ineligible until a specialist rewrites it.
 */
function normalizeRestriction(r) {
  const item = typeof r === 'string' ? { text: r } : r && typeof r === 'object' ? r : null;
  if (!item) return null;
  const text = String(item.text || '').slice(0, 300).trim();
  const supplied = (Array.isArray(item.keywords) ? item.keywords : []).filter((k) => typeof k === 'string' && k.trim()).map((k) => k.toLowerCase().trim().slice(0, 40));
  const keywords = [...new Set([...supplied, ...safetyKeywords(text)])].slice(0, 12);
  const conditions = Array.isArray(item.conditions) ? normalizeApplicability({ conditions: item.conditions }).conditions || [] : [];
  const terms = triggerTerms(text);
  const out = { text, keywords, ...(conditions.length && { conditions }), ...(terms.length && { terms }) };
  if (!text && !keywords.length && !conditions.length) return null;
  if (!keywords.length && !conditions.length && !terms.length) out.unevaluable = true;
  return out;
}
// "Do not use if the cable is frayed" -> the clause after the trigger word, reduced to its content terms. Used to
// block the fix when every term of the clause appears in what the customer described.
function triggerTerms(text) {
  const m = String(text || '').toLowerCase().match(/\b(?:if|when|while|during|unless|whenever|after|near|around|with)\b\s+(.{3,160})$/);
  if (!m) return [];
  return [...tokens(m[1])].filter((w) => w.length >= 3).slice(0, 6);
}
// Hazard words in a restriction become keywords that make the passport ineligible
// when a customer reports them ("Do not use if the battery is swollen").
function safetyKeywords(text) {
  return [...new Set(String(text || '').toLowerCase().match(/\b(?:swollen|swelling|hot|overheat\w*|smoke|smoking|burning|burnt|damaged|cracked|wet|water|liquid|damp|moist\w*|spill\w*|sparks?|leak\w*|bent|frayed|corrosion|corroded|exposed|melted|melting|sticky)\b/g) || [])];
}

/** Compute C_init for a passport. `facts` are the diagnostic facts of the source case. */
export function computeInitialConfidence({ title, applicability, safety, steps }, { facts = null, author = { kind: 'staff' } } = {}) {
  const completeness = passportCompleteness({ title, applicability, safety, steps });
  const conditions = [...(applicability.conditions || []), ...conditionsFromText(applicability.environmentText || '')];
  const diag = facts ? diagnosticSimilarity(conditions, facts) : { score: conditions.length ? 0.5 : 0.5, evaluation: null };
  const r = authorReliability(author);
  const c = initialConfidence({ passport: completeness.score, diag: diag.score, author: r.score });
  return { ...c, parts: completeness.parts, authorBasis: r.basis, diagEvaluation: diag.evaluation };
}

/**
 * Insert a Resolution Passport row. All callers pass explicit company/chatbot scope.
 * Returns the stored row (as read back).
 */
export function insertPassport(db, p) {
  const now = p.now || new Date().toISOString();
  let steps = stepsList(p.steps);
  let applicability = normalizeApplicability(p.applicability);
  let safety = normalizeSafety(p.safety);
  let title = p.title, symptoms = p.symptoms, sanitized = 0;
  // Privacy boundary: every shared passport (imports, revisions, auto-published and specialist fixes alike) is
  // inspected recursively, including nested applicability conditions and safety restrictions. Credential-shaped
  // content is rejected; personal data is replaced. Owner-configured standard playbooks are the company's own text.
  if (p.origin !== 'standard_playbook') {
    const fault = (message) => Object.assign(new Error(message), { status: 400 });
    const r = sanitizeForPublication({ title, symptoms, steps, applicability, safety }, { names: p.privateNames || [], fault });
    ({ title, symptoms, steps, applicability, safety } = r.value);
    sanitized = r.count;
  }
  // Receipts follow a strict schema too (see privacy-sanitizer.js): unknown keys are dropped, text is scrubbed, credentials rejected.
  const failReceipt = (message) => Object.assign(new Error(message), { status: 400 });
  const receipt = shapeEvidence(p.evidence || {}, { fault: failReceipt });
  const lineage = shapeProvenance({ ...(p.provenance || {}), ...(sanitized && { sanitized }) }, { fault: failReceipt });
  const receiptRedactions = receipt.count + lineage.count;
  const id = p.id || randomUUID();
  const searchable = `${title}\n${symptoms}`;
  const risks = dangerousInstructions(steps.join(' '));
  // Imported records are not customer-verified. Unless the owner declared the source verified (or a specialist has
  // already reviewed the record), an import waits for approval and is never recommended in the meantime.
  const awaitingApproval = p.origin === 'company_db_sync' && !p.evidence?.declaredVerified && !p.locallyReviewed && !p.status;
  const row = {
    id,
    company_id: p.companyId,
    chatbot_id: p.chatbotId,
    parent_version_id: p.parentVersionId || null,
    lineage_id: p.lineageId || id,
    version_number: p.versionNumber || 1,
    origin_type: p.origin,
    source_key: p.sourceKey,
    source_id: p.sourceId || null,
    external_record_id: p.externalRecordId || null,
    source_ticket_id: p.sourceTicketId || null,
    content_hash: hash({ t: title, s: symptoms, a: applicability, r: safety, steps }),
    title: String(title).slice(0, 200),
    symptoms_text: String(symptoms).slice(0, 2000),
    search_terms: [...tokens(searchable)].join(' '),
    applicability_json: JSON.stringify(applicability),
    safety_restrictions_json: JSON.stringify(safety),
    steps_json: JSON.stringify(steps),
    verification_evidence_json: JSON.stringify(receipt.value),
    provenance_json: JSON.stringify({ ...lineage.value, ...(receiptRedactions && { receiptRedactions }) }),
    embedding_blob: vectorToBlob(localEmbedding(searchable + '\n' + steps.join(' '))),
    embedding_model: LOCAL_EMBEDDING_MODEL,
    initial_confidence_score: p.initialConfidence,
    reuse_success_count: p.successes || 0,
    reuse_failure_count: p.failures || 0,
    consecutive_failures: p.consecutiveFailures || 0,
    status: p.status || ((risks.length && p.origin === 'company_db_sync') || awaitingApproval ? 'flagged_for_review' : 'active'),
    customer_confirmed: p.customerConfirmed ? 1 : 0,
    risk_level: risks.length || p.highRisk ? 'high' : 'standard',
    locally_reviewed: p.locallyReviewed ? 1 : 0,
    flagged_reason: risks.length && p.origin === 'company_db_sync' ? 'Imported instructions need review: ' + risks.join(', ') : awaitingApproval ? 'Imported from a company database and waiting for approval' : p.flaggedReason || null,
    created_at: now,
    updated_at: now,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO memory_pool(${columns.join(',')}) VALUES(${columns.map((c) => '@' + c).join(',')})`).run(row);
  const stored = db.prepare('SELECT * FROM memory_pool WHERE id=? AND company_id=?').get(id, p.companyId);
  if (db.prepare("SELECT 1 FROM pragma_table_info('memory_pool') WHERE name='facets_at'").get()) refreshFacets(db, stored);
  return stored;
}

/**
 * Equality facets (model, firmware, region ...) of a passport, stored in an indexed table. Text similarity cannot tell
 * apart fixes that differ only by device or version, so retrieval also asks "which fixes name THIS device?" here.
 * Facets only help find candidates; the compatibility gate still makes every decision.
 */
export function refreshFacets(db, row) {
  let applicability = {};
  try { applicability = JSON.parse(row.applicability_json || '{}'); } catch { /* none */ }
  const conditions = [...(applicability.conditions || []), ...conditionsFromText(applicability.environmentText || '')];
  db.prepare('DELETE FROM passport_facets WHERE memory_id=?').run(row.id);
  const insert = db.prepare('INSERT OR IGNORE INTO passport_facets(memory_id,company_id,chatbot_id,key,value) VALUES(?,?,?,?,?)');
  for (const c of conditions) {
    if (c.op !== 'in' || !Array.isArray(c.values)) continue;
    for (const v of c.values.slice(0, 20)) insert.run(row.id, row.company_id, row.chatbot_id, String(c.key).toLowerCase(), String(v).toLowerCase().slice(0, 100));
  }
  db.prepare('UPDATE memory_pool SET facets_at=? WHERE id=?').run(new Date().toISOString(), row.id);
}

/** Mirror a chatbot's standard playbooks into its memory pool (idempotent). */
export function syncPlaybooks(db, bot) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_pool'").get()) return;
  const keys = new Set();
  for (const pb of bot.playbooks || []) {
    const sourceKey = `playbook:${bot.id}:${pb.id}:v${pb.version}`;
    keys.add(sourceKey);
    if (db.prepare('SELECT 1 FROM memory_pool WHERE company_id=? AND source_key=?').get(bot.companyId, sourceKey)) {
      db.prepare("UPDATE memory_pool SET status='active',updated_at=? WHERE company_id=? AND chatbot_id=? AND source_key=? AND status='retired' AND origin_type='standard_playbook' AND json_extract(provenance_json,'$.retiredBy')='config'")
        .run(new Date().toISOString(), bot.companyId, bot.id, sourceKey);
      continue;
    }
    const applicability = pb.environment ? { environmentText: pb.environment } : { universal: true, reviewed: true };
    const safety = { restrictions: [], noneIdentified: true, reviewed: true };
    const symptoms = 'Topics: ' + pb.topics.join(', ');
    const c = computeInitialConfidence({ symptoms, applicability, safety, steps: [pb.steps] }, { author: { kind: 'standard_playbook' } });
    insertPassport(db, {
      companyId: bot.companyId,
      chatbotId: bot.id,
      origin: 'standard_playbook',
      sourceKey,
      title: 'Standard playbook: ' + pb.id.replaceAll('-', ' '),
      symptoms,
      applicability,
      safety,
      steps: [pb.steps],
      initialConfidence: c.score,
      evidence: { type: 'owner_configured_playbook', playbookId: pb.id, playbookVersion: pb.version },
      provenance: { cInit: c, origin: 'chatbot configuration' },
    });
  }
  // Playbooks removed from the configuration stop being reusable but keep history.
  for (const row of db.prepare("SELECT id,source_key FROM memory_pool WHERE company_id=? AND chatbot_id=? AND origin_type='standard_playbook' AND status='active'").all(bot.companyId, bot.id))
    if (!keys.has(row.source_key))
      db.prepare("UPDATE memory_pool SET status='retired',updated_at=?,provenance_json=json_set(provenance_json,'$.retiredBy','config') WHERE id=? AND company_id=?").run(new Date().toISOString(), row.id, bot.companyId);
}

/** Passport from a legacy/specialist resolution record (resolutions collection). */
export function passportFromResolution(r) {
  const safety = r.safety ? normalizeSafety(r.safety) : { restrictions: [] };
  return {
    title: r.title,
    symptoms: r.symptoms,
    applicability: r.applicability ? normalizeApplicability(r.applicability) : { environmentText: r.environment },
    safety,
    steps: [r.solution],
  };
}

/**
 * Migration 5 backfill: standard playbooks and published specialist resolutions.
 * Uses stable source keys so re-running is harmless.
 */
export function backfillV5(db, data, resolutionUses) {
  for (const row of db.prepare('SELECT config FROM chatbots').all()) syncPlaybooks(db, JSON.parse(row.config));
  for (const r of data.resolutions || []) {
    if (!r.companyId || !r.chatbotId) continue;
    const published = (!r.status || r.status === 'published') && r.allowMemoryPublication !== false && r.customerAccepted !== false;
    if (!published) continue;
    if (!db.prepare('SELECT 1 FROM chatbots WHERE company_id=? AND id=?').get(r.companyId, r.chatbotId)) continue;
    const sourceKey = 'resolution:' + r.id;
    if (db.prepare('SELECT 1 FROM memory_pool WHERE company_id=? AND source_key=?').get(r.companyId, sourceKey)) continue;
    const passport = passportFromResolution(r);
    const c = computeInitialConfidence(passport, { author: { kind: 'staff' } });
    const uses = resolutionUses.filter((u) => u.resolution_id === r.id && u.company_id === r.companyId);
    const ordered = uses.filter((u) => u.status !== 'pending').sort((a, b) => String(a.feedback_at).localeCompare(String(b.feedback_at)));
    let consecutive = 0;
    for (const u of ordered) consecutive = u.status === 'failed' ? consecutive + 1 : 0;
    const needsReview = Boolean(r.reviewRequestedAt && (r.reviewRevision || 0) > (r.reviewedRevision || 0));
    try {
    insertPassport(db, {
      id: r.id,
      companyId: r.companyId,
      chatbotId: r.chatbotId,
      origin: 'specialist_confirmed',
      sourceKey,
      sourceTicketId: data.handoffs?.find((h) => h.id === r.handoffId)?.ticketId || null,
      ...passport,
      initialConfidence: c.score,
      successes: uses.filter((u) => u.status === 'succeeded').length,
      failures: uses.filter((u) => u.status === 'failed').length,
      consecutiveFailures: consecutive,
      status: r.retiredAt ? 'retired' : needsReview ? 'flagged_for_review' : 'active',
      flaggedReason: needsReview ? 'Legacy failure report awaiting review (migrated)' : null,
      customerConfirmed: r.customerAccepted === true,
      evidence: { customerConfirmed: r.customerAccepted === true, confirmedAt: r.confirmedAt || null, handoffId: r.handoffId || null, proposalId: r.id, migratedFrom: 'resolutions' },
      provenance: { cInit: c, migratedAt: new Date().toISOString(), note: 'Backfilled by Migration 5 from a published specialist resolution.' },
      now: r.publishedAt || r.createdAt,
    });
    } catch (e) {
      if (e.status !== 400) throw e; // a legacy row that fails the privacy boundary stays out of shared memory
    }
  }
}
