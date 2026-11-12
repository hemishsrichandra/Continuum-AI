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

  /** Blank customer-authored content. `filter(conversation)` selects which conversations; memories follow `tickets`. */
  async function eraseContent({ scope, companyId, tickets = null, conversationFilter = () => true }) {
    const counts = { conversations: 0, rememberedContext: 0, caseFileCopies: 0, unlinkedKnowledge: 0 };
    const toInvalidate = [];
    const touched = new Set();
    store.update((data) => {
      const inScope = (ticketId) => !tickets || tickets.has(ticketId);
      for (const c of data.conversations) {
        if (c.scope !== scope || c.system || !inScope(c.ticketId) || !conversationFilter(c) || c.erasedAt) continue;
        c.message = REMOVED;
        c.response = { human: false, reply: REMOVED, model: 'removed', evidence: [], trace: {}, erased: true };
        c.erasedAt = new Date().toISOString();
        counts.conversations++;
        touched.add(c.ticketId);
      }
      for (const m of data.memories) {
        if (m.scope !== scope || !inScope(m.ticketId) || m.text === REMOVED) continue;
        toInvalidate.push({ id: m.id, ticketId: m.ticketId });
        m.text = REMOVED;
        m.invalidatedAt ||= new Date().toISOString();
        m.erasedAt = new Date().toISOString();
        counts.rememberedContext++;
        touched.add(m.ticketId);
      }
      // Specialist case files hold copies of the conversation and remembered context.
      for (const h of data.handoffs) {
        if (h.scope !== scope || !inScope(h.ticketId) || !h.context) continue;
        const had = (h.context.conversation?.length || 0) + (h.context.memories?.length || 0);
        if (!had) continue;
        h.context = { ...h.context, conversation: [], memories: [], erased: true };
        counts.caseFileCopies += had;
        touched.add(h.ticketId);
      }
    });
    // Best-effort removal from the remote memory service; the local record is already blanked and retired.
    for (const m of toInvalidate) await Promise.resolve(memory?.invalidate?.(scope, m.ticketId, m.id)).catch(() => {});
    if (touched.size)
      counts.unlinkedKnowledge = sql.prepare(`UPDATE memory_pool SET source_ticket_id=NULL WHERE company_id=? AND source_ticket_id IN (${[...touched].map(() => '?').join(',')})`).run(companyId, ...touched).changes;
    return counts;
  }

  async function erase(profile, db, { ticketId, confirmed }) {
    if (confirmed !== true) throw fault(400, 'Confirm that you want your conversation content removed. This cannot be undone.');
    const tickets = ticketId ? new Set([db.ticket(ticketId).id]) : null;
    const counts = await eraseContent({ scope: db.scope, companyId: profile.companyId, tickets });
    store.update((data) => data.audit.push({ id: randomUUID(), scope: db.scope, ticketId: ticketId || 'all', kind: 'privacy_erasure', counts, createdAt: new Date().toISOString() }));
    return {
      success: true,
      erased: counts,
      kept: ['Your service requests and their status', 'Appointments', 'Updates written by your specialist', 'Shared knowledge, which contains no personal details'],
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
  return { exportData, erase, sweep, policy };
}
