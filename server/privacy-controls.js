// Customer data controls and retention.
//
//  * export(): a customer can download their own data in the current workspace.
//  * erase(): a customer can have the CONTENT of their conversations, remembered context and the copies of
//    that content inside specialist case files removed. Operational case records (the request, its status,
//    appointments, specialist updates) are kept so work in progress is not broken, and published shared
//    knowledge is already de-identified; passports sourced from the erased ticket are unlinked from it.
//  * sweep(): optional, off-by-default retention for operational noise and archived conversations.
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';

const REMOVED = '[removed at the customer’s request]';
const days = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 0;
};

export function createPrivacyControls(store, memory, config = {}) {
  const sql = store.db;
  const policy = {
    archivedConversationDays: days(config.RETENTION_ARCHIVED_CONVERSATION_DAYS),
    followThroughDays: days(config.RETENTION_FOLLOW_THROUGH_DAYS),
    outboxDays: days(config.RETENTION_OUTBOX_DAYS),
  };
  const iso = (ms) => new Date(ms).toISOString();

  function exportData(profile, db) {
    const data = store.dataFor(profile.companyId);
    const own = (rows) => rows.filter((r) => r.scope === db.scope);
    return {
      exportedAt: new Date().toISOString(),
      note: 'Your own data in this company and service. Other people’s data and the company’s internal notes are not included.',
      account: { name: profile.name, email: profile.email },
      workspace: { company: profile.companyName, service: profile.chatbotName },
      requests: db.list().map(({ handoffs, ...t }) => ({ ...t, specialistCases: handoffs.map((h) => ({ id: h.id, status: h.status, createdAt: h.createdAt })) })),
      conversations: own(data.conversations).filter((c) => !c.system).map((c) => ({ id: c.id, ticketId: c.ticketId, createdAt: c.createdAt, archived: Boolean(c.archivedAt), message: c.message, reply: c.response?.reply })),
      rememberedContext: own(data.memories).map((m) => ({ id: m.id, ticketId: m.ticketId, kind: m.kind, text: m.text, createdAt: m.createdAt, retired: Boolean(m.invalidatedAt) })),
      troubleshooting: sql.prepare('SELECT ticket_id,source,sequence,outcome,created_at,outcome_at FROM troubleshooting_attempts WHERE company_id=? AND chatbot_id=? AND customer_id=? ORDER BY created_at').all(profile.companyId, profile.chatbotId, profile.id),
    };
  }

  // ----- durable erasure tasks: remote deletions are recorded, retried with backoff, idempotent and visible.
  const enqueue = (companyId, kind, target, payload) =>
    sql
      .prepare("INSERT INTO erasure_tasks(id,company_id,kind,target,payload_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(company_id,kind,target) DO UPDATE SET status=CASE WHEN status='done' THEN 'done' ELSE 'pending' END")
      .run(randomUUID(), companyId, kind, target, JSON.stringify(payload), iso(Date.now()));

  /** Run due erasure tasks. Safe to repeat or run concurrently: a task is claimed with a conditional update. */
  async function processTasks({ at = Date.now(), limit = 20 } = {}) {
    const out = { done: 0, failed: 0, retrying: 0 };
    const due = sql.prepare("SELECT * FROM erasure_tasks WHERE (status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT ?").all(at, at, limit);
    for (const task of due) {
      const claimed = sql.prepare("UPDATE erasure_tasks SET status='processing',lease_until=? WHERE id=? AND (status='pending' OR (status='processing' AND lease_until<?))").run(at + 120000, task.id, at);
      if (!claimed.changes) continue;
      try {
        const p = JSON.parse(task.payload_json || '{}');
        if (task.kind !== 'memory-invalidate') throw Object.assign(new Error('Unknown erasure task.'), { permanent: true });
        if (!memory?.invalidate) throw Object.assign(new Error('No memory service is configured to confirm this removal.'), { permanent: true });
        await memory.invalidate(p.scope, p.ticketId, p.memoryId);
        sql.prepare("UPDATE erasure_tasks SET status='done',attempts=attempts+1,lease_until=0,last_error=NULL,completed_at=? WHERE id=?").run(iso(at), task.id);
        out.done++;
      } catch (e) {
        const attempts = task.attempts + 1;
        const final = e.permanent || attempts >= 10;
        sql
          .prepare('UPDATE erasure_tasks SET status=?,attempts=?,next_attempt_at=?,lease_until=0,last_error=? WHERE id=?')
          .run(final ? 'failed' : 'pending', attempts, final ? 0 : at + Math.min(3600000, 30000 * 2 ** (attempts - 1)), String(e.message).slice(0, 200), task.id);
        out[final ? 'failed' : 'retrying']++;
      }
    }
    return out;
  }
  /** Erasure work for a company: counts and the tasks that still need attention. */
  function erasureStatus(companyId) {
    const counts = Object.fromEntries(sql.prepare('SELECT status,COUNT(*) AS n FROM erasure_tasks WHERE company_id=? GROUP BY status').all(companyId).map((r) => [r.status, r.n]));
    return {
      pending: (counts.pending || 0) + (counts.processing || 0),
      failed: counts.failed || 0,
      done: counts.done || 0,
      attention: sql.prepare("SELECT id,kind,attempts,last_error AS error,status FROM erasure_tasks WHERE company_id=? AND status IN ('pending','failed') AND attempts>0 ORDER BY created_at LIMIT 20").all(companyId),
    };
  }

  /** Blank customer-authored content. `filter(conversation)` selects which conversations; memories follow `tickets`. */
  async function eraseContent({ scope, companyId, tickets = null, conversationFilter = () => true, retireSharedKnowledge = false }) {
    const counts = { conversations: 0, rememberedContext: 0, caseFileCopies: 0, unlinkedKnowledge: 0, diagnosticContext: 0, operationResponses: 0, auditCopies: 0, specialistSummaries: 0, withdrawnKnowledge: 0, externalRemovals: 0 };
    const touched = new Set();
    const erased = [];
    const stamp = new Date().toISOString();
    store.update((data) => {
      const inScope = (ticketId) => !tickets || tickets.has(ticketId);
      for (const c of data.conversations) {
        if (c.scope !== scope || c.system || !inScope(c.ticketId) || !conversationFilter(c) || c.erasedAt) continue;
        c.message = REMOVED;
        c.response = { human: false, reply: REMOVED, model: 'removed', evidence: [], trace: {}, erased: true };
        c.erasedAt = stamp;
        counts.conversations++;
        touched.add(c.ticketId);
      }
      for (const m of data.memories) {
        if (m.scope !== scope || !inScope(m.ticketId) || m.text === REMOVED) continue;
        erased.push({ id: m.id, ticketId: m.ticketId });
        m.text = REMOVED;
        m.invalidatedAt ||= stamp;
        m.erasedAt = stamp;
        counts.rememberedContext++;
        touched.add(m.ticketId);
      }
      // Specialist case files hold copies of the conversation and remembered context.
      for (const h of data.handoffs) {
        if (h.scope !== scope || !inScope(h.ticketId)) continue;
        if (h.context && (h.context.conversation?.length || h.context.memories?.length)) {
          counts.caseFileCopies += (h.context.conversation?.length || 0) + (h.context.memories?.length || 0);
          h.context = { ...h.context, conversation: [], memories: [], erased: true };
          touched.add(h.ticketId);
        }
        // The customer-derived summary is blanked once the case is finished; an open case keeps it so the specialist
        // can complete the work, and the response says so.
        if (h.summary && h.summary !== REMOVED && ['Resolved', 'Closed'].includes(h.status)) {
          h.summary = REMOVED;
          counts.specialistSummaries++;
          touched.add(h.ticketId);
        }
      }
      // Copies written into the audit trail when a case was handed over.
      for (const a of data.audit) {
        if (a.scope !== scope || !inScope(a.ticketId) || a.erasedAt || !(a.context || a.summary)) continue;
        delete a.context;
        if (a.summary) a.summary = REMOVED;
        a.erasedAt = stamp;
        counts.auditCopies++;
        touched.add(a.ticketId);
      }
      // Cached responses of repeated submissions echo what the customer wrote.
      for (const o of data.operations) {
        if (o.scope !== scope || o.erasedAt || !o.response) continue;
        const text = JSON.stringify(o.response);
        if (tickets && ![...tickets].some((id) => text.includes(id))) continue;
        o.response = { erased: true };
        o.erasedAt = stamp;
        counts.operationResponses++;
      }
    });
    const ids = [...touched];
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      // Diagnostic context gathered during troubleshooting (device, version, answers) and its per-attempt copies.
      counts.diagnosticContext =
        sql.prepare(`UPDATE troubleshooting_context SET context='{}' WHERE company_id=? AND ticket_id IN (${marks}) AND context<>'{}'`).run(companyId, ...ids).changes +
        sql.prepare(`UPDATE troubleshooting_attempts SET context='{}' WHERE company_id=? AND ticket_id IN (${marks}) AND context<>'{}'`).run(companyId, ...ids).changes;
      // Shared knowledge is de-identified when published; the link back to the erased request is removed.
      counts.unlinkedKnowledge = sql.prepare(`UPDATE memory_pool SET source_ticket_id=NULL WHERE company_id=? AND source_ticket_id IN (${marks})`).run(companyId, ...ids).changes;
      // Optionally withdraw the fixes learned from these requests. Retiring removes them from search and, through the
      // durable indexing jobs, from the vector index as well.
      if (retireSharedKnowledge)
        counts.withdrawnKnowledge = sql
          .prepare(`UPDATE memory_pool SET status='retired',flagged_reason='Withdrawn at the customer’s request',updated_at=? WHERE company_id=? AND status IN ('active','flagged_for_review') AND json_extract(verification_evidence_json,'$.erasedSourceTicket') IN (${marks})`)
          .run(stamp, companyId, ...ids).changes;
    }
    // Remote memory service: recorded as durable tasks (idempotent per memory), never best-effort.
    for (const m of erased) enqueue(companyId, 'memory-invalidate', `${scope}:${m.ticketId}:${m.id}`, { scope, ticketId: m.ticketId, memoryId: m.id });
    counts.externalRemovals = erased.length;
    return counts;
  }

  async function erase(profile, db, { ticketId, confirmed, retireSharedKnowledge = false }) {
    if (confirmed !== true) throw fault(400, 'Confirm that you want your conversation content removed. This cannot be undone.');
    const tickets = ticketId ? new Set([db.ticket(ticketId).id]) : null;
    // Remember which fixes came from these requests BEFORE the link is removed, so they can be withdrawn on request.
    if (retireSharedKnowledge) {
      const own = tickets ? [...tickets] : db.list().map((t) => t.id);
      for (const id of own) sql.prepare("UPDATE memory_pool SET verification_evidence_json=json_set(verification_evidence_json,'$.erasedSourceTicket',source_ticket_id) WHERE company_id=? AND source_ticket_id=?").run(profile.companyId, id);
    }
    const counts = await eraseContent({ scope: db.scope, companyId: profile.companyId, tickets, retireSharedKnowledge: retireSharedKnowledge === true });
    // Try the remote removals now; whatever cannot complete stays as a visible, retried task.
    const run = await processTasks();
    const status = erasureStatus(profile.companyId);
    store.update((data) => data.audit.push({ id: randomUUID(), scope: db.scope, ticketId: ticketId || 'all', kind: 'privacy_erasure', counts, createdAt: new Date().toISOString() }));
    const open = store.data.handoffs.some((h) => h.scope === db.scope && (!tickets || tickets.has(h.ticketId)) && !['Resolved', 'Closed'].includes(h.status));
    return {
      success: true,
      erased: counts,
      external: { removed: run.done, pending: status.pending, failed: status.failed },
      kept: [
        'Your service requests and their status',
        'Appointments',
        'Updates written by your specialist',
        ...(open ? ['A short summary of any still-open case, so your specialist can finish it'] : []),
        'Shared knowledge, which contains no personal details' + (retireSharedKnowledge ? ' (fixes learned from these requests were withdrawn)' : ''),
      ],
      note: status.pending ? 'Some removals from connected services are still in progress and will be retried automatically.' : undefined,
    };
  }

  /** Apply the configured retention rules. Returns what was removed. Everything is off unless configured. */
  async function sweep(at = Date.now()) {
    const out = { archivedConversations: 0, followThroughTasks: 0, outboxJobs: 0 };
    if (policy.archivedConversationDays) {
      const cutoff = iso(at - policy.archivedConversationDays * 86400000);
      const scopes = new Set(store.data.conversations.filter((c) => c.archivedAt && c.archivedAt < cutoff && !c.erasedAt && !c.system).map((c) => c.scope));
      for (const scope of scopes) {
        const companyId = store.data.conversations.find((c) => c.scope === scope)?.scope.split(':')[0];
        const counts = await eraseContent({ scope, companyId, conversationFilter: (c) => Boolean(c.archivedAt && c.archivedAt < cutoff) });
        out.archivedConversations += counts.conversations;
      }
    }
    if (policy.followThroughDays)
      out.followThroughTasks = sql.prepare("DELETE FROM follow_through_tasks WHERE status IN ('completed','auto_published','escalated') AND COALESCE(processed_at,created_at)<?").run(iso(at - policy.followThroughDays * 86400000)).changes;
    if (policy.outboxDays) {
      const cutoff = at - policy.outboxDays * 86400000;
      store.update((data) => {
        const before = data.outbox.length;
        data.outbox = data.outbox.filter((j) => !(['delivered', 'failed', 'skipped'].includes(j.status) && Date.parse(j.deliveredAt || j.createdAt) < cutoff));
        out.outboxJobs = before - data.outbox.length;
      });
    }
    return out;
  }
  return { exportData, erase, sweep, policy, processTasks, erasureStatus };
}
