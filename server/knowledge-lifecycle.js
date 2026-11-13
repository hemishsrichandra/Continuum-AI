// Knowledge lifecycle: an append-only audit trail, cross-source conflict detection, staleness and revalidation reporting.
//
// Principles (covered by test/lifecycle.test.js):
//  * every status change that matters (imported, updated, flagged, approved, retired, withdrawn, reappeared, conflict opened or resolved)
//    is one row in knowledge_events. The table is append-only (database triggers) and holds ids, statuses and reasons, never record text
//  * two live records from different places that describe the same problem with different, overlapping fixes are a CONFLICT. The
//    unreviewed import side is quarantined (flagged for review) and an owner decides; nothing here ever picks a winner by itself
//  * "stale" means "was absent from a COMPLETE sync for longer than the source's policy". A paused, failed or partial sync never
//    advances that clock, so it can never make knowledge stale. Nothing is deleted automatically: the owner decides
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { tokens } from './context.js';
import { signatureOf } from './passports.js';
import { sanitizeText } from './privacy-sanitizer.js';

const now = () => new Date().toISOString();
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const DAY = 86400000;

/** Order-insensitive key of what a record is about (its title's content words). Identical problems share a key. */
export const problemKey = (title) => [...tokens(String(title || ''))].sort().join('|').slice(0, 300);

/** Review state a person can act on, derived from the stored status, never stored separately. */
export function reviewStatusOf(row) {
  if (row.status === 'retired') return 'retired';
  if (row.status === 'superseded') return 'superseded';
  if (row.status === 'flagged_for_review') return row.locally_reviewed ? 'needs_re_review' : row.origin_type === 'company_db_sync' ? 'pending_review' : 'flagged';
  if (row.origin_type === 'company_db_sync') return row.locally_reviewed ? 'approved' : 'active_without_review';
  return row.locally_reviewed || row.customer_confirmed ? 'approved' : 'active_without_review';
}

export function recordKnowledgeEvent(sql, { companyId, chatbotId = null, memoryId = null, sourceId = null, kind, actor = null, detail = {} }) {
  const clean = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (typeof v === 'string') clean[k] = sanitizeText(v).text.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) clean[k] = v;
    else if (Array.isArray(v)) clean[k] = v.slice(0, 10).map((x) => (typeof x === 'string' ? sanitizeText(x).text.slice(0, 120) : x));
  }
  sql.prepare('INSERT INTO knowledge_events(id,company_id,chatbot_id,memory_id,source_id,kind,actor,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), companyId, chatbotId, memoryId, sourceId, kind, actor, JSON.stringify(clean), now());
}

/** Two applicability blocks can apply to one customer unless some shared key has disjoint required values. */
export function applicabilityOverlaps(a = {}, b = {}) {
  const index = (x) => new Map((Array.isArray(x.conditions) ? x.conditions : []).filter((c) => c.op === 'in' && c.required !== false && Array.isArray(c.values) && c.values.length).map((c) => [String(c.key).toLowerCase(), new Set(c.values.map((v) => String(v).toLowerCase()))]));
  const A = index(a), B = index(b);
  for (const [key, values] of A) {
    const other = B.get(key);
    if (other && ![...values].some((v) => other.has(v))) return false;
  }
  return true;
}
const stepOverlap = (a, b) => {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(x.size, y.size);
};

export function createKnowledgeLifecycle(store) {
  const sql = store.db;
  const owner = (session) => {
    if (!session.account_id || session.profile.role !== 'owner') throw fault(403, 'Only the company owner can review knowledge conflicts and history.');
    return session.profile;
  };

  /** Give every record of this service a problem key (idempotent, bounded per call). */
  function fillKeys(companyId, chatbotId) {
    const set = sql.prepare('UPDATE memory_pool SET problem_key=? WHERE id=? AND company_id=?');
    for (const r of sql.prepare("SELECT id,title FROM memory_pool WHERE company_id=? AND chatbot_id=? AND problem_key IS NULL AND status IN ('active','flagged_for_review') LIMIT 2000").all(companyId, chatbotId)) set.run(problemKey(r.title), r.id, companyId);
  }

  /**
   * Compare the given (new or changed) records with every other live record of the same service. A pair is a conflict when the problem
   * is the same, the fixes genuinely differ (not a rewording), the applicability overlaps, and the two come from different places
   * (different sources, or a source and a specialist/playbook). Returns the conflicts opened by this call.
   */
  function detectConflicts(companyId, ids, actor = 'system') {
    const opened = [];
    for (const id of ids) {
      const a = sql.prepare("SELECT * FROM memory_pool WHERE id=? AND company_id=? AND status IN ('active','flagged_for_review')").get(id, companyId);
      if (!a) continue;
      const key = problemKey(a.title);
      sql.prepare('UPDATE memory_pool SET problem_key=? WHERE id=? AND company_id=?').run(key, a.id, companyId);
      if (!key) continue;
      fillKeys(companyId, a.chatbot_id);
      for (const b of sql.prepare("SELECT * FROM memory_pool WHERE company_id=? AND chatbot_id=? AND problem_key=? AND id<>? AND status IN ('active','flagged_for_review') AND lineage_id<>?").all(companyId, a.chatbot_id, key, a.id, a.lineage_id)) {
        if ((a.source_id || a.origin_type) === (b.source_id || b.origin_type)) continue; // same place: that is an update, not a conflict
        const sa = signatureOf(parse(a.steps_json, [])), sb = signatureOf(parse(b.steps_json, []));
        if (sa === sb || stepOverlap(sa, sb) >= 0.6) continue;
        if (!applicabilityOverlaps(parse(a.applicability_json, {}), parse(b.applicability_json, {}))) continue;
        const [first, second] = a.id < b.id ? [a, b] : [b, a];
        const exists = sql.prepare('SELECT id,status FROM knowledge_conflicts WHERE company_id=? AND memory_a=? AND memory_b=?').get(companyId, first.id, second.id);
        if (exists) continue; // an owner decision on this exact pair stands until one of the records changes version
        const conflictId = randomUUID();
        sql.prepare('INSERT INTO knowledge_conflicts(id,company_id,chatbot_id,memory_a,memory_b,kind,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(conflictId, companyId, a.chatbot_id, first.id, second.id, 'different_fix_for_same_problem', 'Two sources describe the same problem with different fixes that can apply to the same customer.', now());
        for (const r of [a, b]) {
          // Only unreviewed imports are quarantined; a specialist-confirmed or approved record keeps serving customers until the owner decides.
          if (r.origin_type === 'company_db_sync' && !r.locally_reviewed && r.status === 'active') {
            sql.prepare("UPDATE memory_pool SET status='flagged_for_review',flagged_reason=?,updated_at=? WHERE id=? AND company_id=? AND status='active'")
              .run('Conflicts with another source: an owner must choose (conflict ' + conflictId.slice(0, 8) + ')', now(), r.id, companyId);
          }
          recordKnowledgeEvent(sql, { companyId, chatbotId: r.chatbot_id, memoryId: r.id, sourceId: r.source_id, kind: 'conflict_opened', actor, detail: { conflictId, otherMemoryId: r.id === a.id ? b.id : a.id } });
        }
        opened.push(conflictId);
      }
    }
    return opened;
  }

  const conflictView = (c) => {
    const view = (id) => {
      const r = sql.prepare('SELECT id,title,origin_type,source_id,status,customer_confirmed,locally_reviewed,version_number FROM memory_pool WHERE id=? AND company_id=?').get(id, c.company_id);
      return r && { id: r.id, title: r.title, origin: r.origin_type, sourceId: r.source_id, status: r.status, version: r.version_number, reviewStatus: reviewStatusOf({ ...r, status: r.status }) };
    };
    return { id: c.id, chatbotId: c.chatbot_id, kind: c.kind, reason: c.reason, status: c.status, resolution: c.resolution, createdAt: c.created_at, resolvedAt: c.resolved_at, a: view(c.memory_a), b: view(c.memory_b) };
  };
  const conflicts = (companyId, { status = 'open' } = {}) =>
    sql.prepare('SELECT * FROM knowledge_conflicts WHERE company_id=? AND status=? ORDER BY created_at DESC LIMIT 200').all(companyId, status).map(conflictView);

  function resolveConflict(profile, { conflictId, decision, note, confirmed }) {
    if (confirmed !== true) throw fault(400, 'Confirm this decision.');
    if (!['keep_first', 'keep_second', 'keep_both', 'retire_both'].includes(decision)) throw fault(400, 'Choose which record to keep.');
    const clean = sanitizeText(String(note || '').trim());
    if (!clean.text || clean.secret || clean.text.length > 1000) throw fault(400, 'Explain the decision (no credentials).');
    return sql.transaction(() => {
      const c = sql.prepare('SELECT * FROM knowledge_conflicts WHERE id=? AND company_id=?').get(String(conflictId || ''), profile.companyId);
      if (!c) throw fault(404, 'Conflict not found in this company.');
      if (c.status !== 'open') throw fault(409, 'This conflict was already resolved.');
      const retire = (id) => {
        sql.prepare("UPDATE memory_pool SET status='retired',flagged_reason=?,updated_at=? WHERE id=? AND company_id=? AND status IN ('active','flagged_for_review')").run('Retired by owner decision on a source conflict', now(), id, profile.companyId);
      };
      const release = (id) => {
        // The owner reviewed both sides: the quarantine ends and the record is marked reviewed.
        sql.prepare("UPDATE memory_pool SET status='active',locally_reviewed=1,flagged_reason=NULL,review_note=?,updated_at=? WHERE id=? AND company_id=? AND status='flagged_for_review'").run(clean.text, now(), id, profile.companyId);
      };
      if (decision === 'keep_first') { release(c.memory_a); retire(c.memory_b); }
      else if (decision === 'keep_second') { release(c.memory_b); retire(c.memory_a); }
      else if (decision === 'keep_both') { release(c.memory_a); release(c.memory_b); }
      else { retire(c.memory_a); retire(c.memory_b); }
      sql.prepare("UPDATE knowledge_conflicts SET status='resolved',resolution=?,note=?,resolved_at=?,resolved_by=? WHERE id=?").run(decision, clean.text, now(), profile.id, c.id);
      for (const id of [c.memory_a, c.memory_b]) recordKnowledgeEvent(sql, { companyId: profile.companyId, chatbotId: c.chatbot_id, memoryId: id, kind: 'conflict_resolved', actor: profile.id, detail: { conflictId: c.id, decision } });
      return conflictView(sql.prepare('SELECT * FROM knowledge_conflicts WHERE id=?').get(c.id));
    }).immediate();
  }

  /**
   * Knowledge that deserves a fresh look under each source's own policy. A record counts as stale only when a COMPLETE sync of its source
   * finished and the record had not been seen for longer than the source's `stale_after_days`. Reported, never changed or deleted.
   */
  function staleReport(companyId, at = Date.now()) {
    const out = [];
    for (const s of sql.prepare('SELECT id,name,stale_after_days,last_complete_sync_at,status FROM company_data_sources WHERE company_id=? AND stale_after_days IS NOT NULL').all(companyId)) {
      const complete = Date.parse(s.last_complete_sync_at || '');
      if (!Number.isFinite(complete)) continue; // never completed: nothing can be called stale yet
      const cutoff = new Date(complete - s.stale_after_days * DAY).toISOString();
      for (const r of sql.prepare("SELECT id,title,last_seen_at,source_status FROM memory_pool WHERE company_id=? AND source_id=? AND origin_type='company_db_sync' AND status IN ('active','flagged_for_review') AND last_seen_at IS NOT NULL AND last_seen_at<?").all(companyId, s.id, cutoff))
        out.push({ memoryId: r.id, title: r.title, sourceId: s.id, sourceName: s.name, lastSeenAt: r.last_seen_at, daysUnseen: Math.floor((complete - Date.parse(r.last_seen_at)) / DAY), reason: `Not present in the source for ${Math.floor((complete - Date.parse(r.last_seen_at)) / DAY)} days as of its last complete sync.` });
    }
    return out.slice(0, 200);
  }

  const history = (companyId, memoryId) =>
    sql.prepare('SELECT id,kind,actor,source_id AS sourceId,detail_json,created_at AS at FROM knowledge_events WHERE company_id=? AND memory_id=? ORDER BY created_at, rowid LIMIT 200').all(companyId, memoryId)
      .map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, sourceId: e.sourceId, detail: parse(e.detail_json, {}), at: e.at }));

  async function handle(req, endpoint, session, send, { json }) {
    if (!endpoint.includes('/api/company/knowledge-lifecycle')) return false;
    const profile = owner(session);
    const url = new URL(req.url, 'http://local');
    if (endpoint.startsWith('GET /api/company/knowledge-lifecycle/overview')) {
      send(200, {
        conflicts: conflicts(profile.companyId),
        stale: staleReport(profile.companyId),
        pendingReview: sql.prepare("SELECT COUNT(*) n FROM memory_pool WHERE company_id=? AND status='flagged_for_review' AND locally_reviewed=0 AND origin_type='company_db_sync'").get(profile.companyId).n,
        recent: sql.prepare('SELECT kind,memory_id AS memoryId,source_id AS sourceId,actor,created_at AS at FROM knowledge_events WHERE company_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30').all(profile.companyId),
      });
      return true;
    }
    if (endpoint.startsWith('GET /api/company/knowledge-lifecycle/history')) {
      const memoryId = String(url.searchParams.get('memoryId') || '');
      if (!sql.prepare('SELECT 1 FROM memory_pool WHERE id=? AND company_id=?').get(memoryId, profile.companyId)) throw fault(404, 'Knowledge record not found in this company.');
      send(200, { memoryId, events: history(profile.companyId, memoryId) });
      return true;
    }
    if (endpoint === 'POST /api/company/knowledge-lifecycle/conflicts/resolve') {
      send(200, { conflict: resolveConflict(profile, await json(req)) });
      return true;
    }
    throw fault(404, 'Knowledge lifecycle route not found.');
  }
  return { detectConflicts, conflicts, resolveConflict, staleReport, history, handle, event: (e) => recordKnowledgeEvent(sql, e) };
}
