// Follow-through: case timeline, customer-confirmation deadlines, overdue
// publication and SLA escalation. The tick runs from the integrations worker
// (never per web request) and is transactional and idempotent: each task is
// claimed with a conditional UPDATE, and memory publication uses a unique
// (company_id, source_key, version_number) key, so retries or concurrent workers
// cannot publish twice.
import { randomUUID } from 'node:crypto';
import { THRESHOLDS } from './scoring.js';
import { insertPassport, passportFromResolution, stepsList } from './passports.js';
import { containsPII, containsSecret, dangerousInstructions } from './privacy.js';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const hours = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 24 * 90 ? n : fallback;
};

export function createFollowThrough(store, { delivery, config = {} } = {}) {
  const sql = store.db;
  const confirmationHours = hours(config.CONFIRMATION_DEADLINE_HOURS, 24);
  const slaHours = hours(config.CASE_SLA_HOURS, 8);

  function log({ companyId, chatbotId = null, ticketId, customerId = null, kind, detail = {}, actor = null, at = iso() }) {
    if (!companyId || !ticketId) return;
    sql.prepare('INSERT INTO case_events(id,company_id,chatbot_id,ticket_id,customer_id,kind,detail_json,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), companyId, chatbotId, ticketId, customerId, kind, JSON.stringify(detail), actor, at);
  }
  function timeline(companyId, chatbotId, ticketId) {
    return sql
      .prepare('SELECT kind,detail_json,actor,created_at FROM case_events WHERE company_id=? AND chatbot_id=? AND ticket_id=? ORDER BY created_at,rowid')
      .all(companyId, chatbotId, ticketId)
      .map((e) => ({ kind: e.kind, detail: JSON.parse(e.detail_json), actor: e.actor, at: e.created_at }));
  }

  /** Persist a confirmation wait at proposal time. Idempotent per proposal. */
  function scheduleConfirmation({ companyId, chatbotId, ticketId, customerId, handoffId, proposalId, specialistId, cInit, customerEmail }) {
    const deadline = iso(Date.now() + confirmationHours * 3600000);
    sql.prepare(`INSERT INTO follow_through_tasks(id,company_id,chatbot_id,ticket_id,customer_id,handoff_id,proposal_id,assigned_specialist_id,task_type,dedupe_key,initial_confidence_score,deadline_at,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,'customer_confirmation_wait',?,?,?,'pending',?) ON CONFLICT(company_id,dedupe_key) DO NOTHING`)
      .run(randomUUID(), companyId, chatbotId, ticketId, customerId, handoffId, proposalId, specialistId, 'confirm:' + proposalId, cInit, deadline, iso());
    // Follow-up only where email delivery is actually configured.
    if (delivery?.emailConfigured && customerEmail) {
      const queued = delivery.queueEmail({
        id: 'confirm-' + proposalId,
        scope: 'account:' + customerId,
        to: customerEmail,
        subject: 'Did the proposed fix work?',
        text: `A specialist proposed a solution for your request ${ticketId}. Open your Continuum workspace and choose "It worked" or "Still need help". If we do not hear from you by ${deadline}, your request stays open.`,
        expiresAt: Date.parse(deadline),
      });
      if (queued) sql.prepare("UPDATE follow_through_tasks SET follow_up_sent_at=? WHERE company_id=? AND dedupe_key=?").run(iso(), companyId, 'confirm:' + proposalId);
    }
    return sql.prepare('SELECT deadline_at FROM follow_through_tasks WHERE company_id=? AND dedupe_key=?').get(companyId, 'confirm:' + proposalId)?.deadline_at || deadline;
  }
  function completeConfirmation(companyId, proposalId, outcome) {
    sql.prepare("UPDATE follow_through_tasks SET status='completed',processed_at=?,outcome_json=? WHERE company_id=? AND dedupe_key=? AND status='pending'")
      .run(iso(), JSON.stringify(outcome), companyId, 'confirm:' + proposalId);
  }

  /** Policy gate for publishing without explicit customer confirmation. */
  function autoPublishBlockers(r, cInit) {
    const text = [r.title, r.symptoms, r.environment, r.solution].join('\n');
    const blockers = [];
    if (!(cInit >= THRESHOLDS.autoPublish)) blockers.push(`C_init ${cInit} below ${THRESHOLDS.autoPublish}`);
    if (dangerousInstructions(text).length) blockers.push('high-risk instructions: ' + dangerousInstructions(text).join(', '));
    if (r.riskLevel === 'high') blockers.push('specialist marked high risk');
    if (r.safetyCritical) blockers.push('safety-critical');
    if (!r.reviewedForPrivacy) blockers.push('not reviewed for privacy');
    if (r.redactions > 0) blockers.push('personal data was redacted; a specialist must confirm the scrubbed text still makes sense');
    if (containsSecret(text) || containsPII(text)) blockers.push('contains private data');
    if (r.customerAccepted === false) blockers.push('customer contradicted the fix');
    return blockers;
  }

  /** Process due tasks. Safe to run repeatedly and concurrently. */
  function tick(at = Date.now()) {
    const due = sql
      .prepare("SELECT * FROM follow_through_tasks WHERE status='pending' AND task_type='customer_confirmation_wait' AND deadline_at<=? ORDER BY deadline_at LIMIT 50")
      .all(iso(at));
    const results = [];
    for (const task of due) {
      const result = sql.transaction(() => {
        const current = sql.prepare("SELECT status FROM follow_through_tasks WHERE id=?").get(task.id);
        if (current?.status !== 'pending') return null;
        const data = store.data;
        const r = data.resolutions.find((x) => x.id === task.proposal_id && x.companyId === task.company_id);
        // The customer answered (or the proposal is gone): nothing to publish.
        if (!r || r.status !== 'pending_confirmation') {
          sql.prepare("UPDATE follow_through_tasks SET status='completed',processed_at=?,outcome_json=? WHERE id=? AND status='pending'").run(iso(at), JSON.stringify({ reason: 'customer responded or proposal closed' }), task.id);
          return { id: task.id, status: 'completed' };
        }
        const blockers = autoPublishBlockers(r, task.initial_confidence_score);
        if (blockers.length) {
          const claimed = sql.prepare("UPDATE follow_through_tasks SET status='escalated',processed_at=?,outcome_json=? WHERE id=? AND status='pending'").run(iso(at), JSON.stringify({ blockers }), task.id);
          if (!claimed.changes) return null;
          store.update((d) => {
            const h = d.handoffs.find((x) => x.id === r.handoffId && x.companyId === task.company_id);
            if (h) {
              h.followUpRequired = true;
              h.followUpReason = 'Customer did not confirm by the deadline; specialist follow-up needed.';
              h.revision = (h.revision || 0) + 1;
            }
            d.audit.push({ id: randomUUID(), scope: `company:${task.company_id}`, ticketId: task.ticket_id, kind: 'confirmation_overdue_escalated', note: blockers.join('; '), createdAt: iso(at) });
          });
          log({ companyId: task.company_id, chatbotId: task.chatbot_id, ticketId: task.ticket_id, customerId: task.customer_id, kind: 'confirmation_overdue_escalated', detail: { blockers }, actor: 'follow-through worker', at: iso(at) });
          return { id: task.id, status: 'escalated', blockers };
        }
        const claimed = sql.prepare("UPDATE follow_through_tasks SET status='auto_published',processed_at=? WHERE id=? AND status='pending'").run(iso(at), task.id);
        if (!claimed.changes) return null;
        const sourceKey = 'resolution:' + r.id;
        let memory = sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND source_key=? AND version_number=1').get(task.company_id, sourceKey);
        if (!memory) {
          const passport = r.passport || passportFromResolution(r);
          memory = insertPassport(sql, {
            id: r.id,
            companyId: task.company_id,
            chatbotId: r.chatbotId,
            origin: 'auto_published_overdue',
            sourceKey,
            sourceTicketId: task.ticket_id,
            title: passport.title,
            symptoms: passport.symptoms,
            applicability: passport.applicability,
            safety: passport.safety,
            steps: stepsList(passport.steps),
            initialConfidence: task.initial_confidence_score,
            customerConfirmed: false,
            evidence: { customerConfirmed: false, label: 'UNCONFIRMED BY CUSTOMER', deadlineAt: task.deadline_at, publishedAt: iso(at), proposalId: r.id, handoffId: r.handoffId },
            provenance: { cInit: r.cInit || { score: task.initial_confidence_score }, autoPublished: { at: iso(at), threshold: THRESHOLDS.autoPublish, policy: 'no explicit customer response before deadline' } },
            now: iso(at),
          });
        }
        sql.prepare("UPDATE follow_through_tasks SET memory_id=?,outcome_json=? WHERE id=?").run(memory.id, JSON.stringify({ memoryId: memory.id, cInit: task.initial_confidence_score }), task.id);
        store.update((d) => {
          const x = d.resolutions.find((y) => y.id === r.id);
          // The proposal still awaits the customer: the case is NOT resolved.
          x.autoPublishedAt = iso(at);
          x.sync = 'auto-published (unconfirmed by customer)';
          const h = d.handoffs.find((y) => y.id === r.handoffId && y.companyId === task.company_id);
          if (h) {
            h.followUpRequired = true;
            h.followUpReason = 'Published as UNCONFIRMED after the deadline; the customer has still not confirmed.';
            h.revision = (h.revision || 0) + 1;
          }
          d.audit.push({ id: randomUUID(), scope: `company:${task.company_id}`, ticketId: task.ticket_id, kind: 'auto_published_overdue', resolutionId: r.id, note: 'Published as UNCONFIRMED BY CUSTOMER after the confirmation deadline.', createdAt: iso(at) });
        });
        log({ companyId: task.company_id, chatbotId: task.chatbot_id, ticketId: task.ticket_id, customerId: task.customer_id, kind: 'auto_published_overdue', detail: { memoryId: memory.id, cInit: task.initial_confidence_score, label: 'UNCONFIRMED BY CUSTOMER' }, actor: 'follow-through worker', at: iso(at) });
        return { id: task.id, status: 'auto_published', memoryId: memory.id };
      }).immediate();
      if (result) results.push(result);
    }
    // SLA: queued cases nobody has claimed become explicit escalation tasks.
    for (const h of store.data.handoffs.filter((h) => h.status === 'Queued' && !h.assignedTo && h.createdAt && Date.parse(h.createdAt) + slaHours * 3600000 <= at)) {
      const inserted = sql.prepare(`INSERT INTO follow_through_tasks(id,company_id,chatbot_id,ticket_id,customer_id,handoff_id,task_type,dedupe_key,deadline_at,status,created_at)
        VALUES(?,?,?,?,?,?,'sla_escalation',?,?,'escalated',?) ON CONFLICT(company_id,dedupe_key) DO NOTHING`)
        .run(randomUUID(), h.companyId, h.chatbotId, h.ticketId, h.customerId, h.id, 'sla:' + h.id, iso(Date.parse(h.createdAt) + slaHours * 3600000), iso(at));
      if (inserted.changes) {
        log({ companyId: h.companyId, chatbotId: h.chatbotId, ticketId: h.ticketId, customerId: h.customerId, kind: 'sla_breached', detail: { slaHours }, actor: 'follow-through worker', at: iso(at) });
        results.push({ handoffId: h.id, status: 'sla_escalated' });
      }
    }
    return results;
  }

  /** Staff-facing queue for a company (and optionally one service). */
  function queue(companyId, chatbotIds, at = Date.now()) {
    const list = sql
      .prepare(`SELECT * FROM follow_through_tasks WHERE company_id=? AND chatbot_id IN (${chatbotIds.map(() => '?').join(',') || "''"}) ORDER BY deadline_at`)
      .all(companyId, ...chatbotIds)
      .map((t) => ({
        id: t.id,
        type: t.task_type,
        ticketId: t.ticket_id,
        handoffId: t.handoff_id,
        proposalId: t.proposal_id,
        memoryId: t.memory_id,
        status: t.status,
        deadlineAt: t.deadline_at,
        overdue: t.status === 'pending' && Date.parse(t.deadline_at) <= at,
        initialConfidence: t.initial_confidence_score,
        followUpSentAt: t.follow_up_sent_at,
        outcome: t.outcome_json ? JSON.parse(t.outcome_json) : null,
        nextStep:
          t.task_type === 'customer_confirmation_wait'
            ? t.status === 'pending'
              ? 'Waiting for the customer to choose “It worked” or “Still need help”.'
              : t.status === 'escalated'
                ? 'Deadline passed without confirmation and auto-publication is not allowed: contact the customer.'
                : t.status === 'auto_published'
                  ? 'Published as UNCONFIRMED. Keep following up; the request remains open.'
                  : 'Closed by the customer response.'
            : t.task_type === 'sla_escalation'
              ? 'Unclaimed past the SLA: claim or assign this case.'
              : t.status === 'pending' ? 'Review the flagged fix: keep, retire or publish a revised version.' : 'Reviewed.',
      }));
    return { slaHours, confirmationHours, tasks: list };
  }

  return {
    log,
    timeline,
    scheduleConfirmation,
    completeConfirmation,
    autoPublishBlockers,
    tick,
    queue,
    confirmationHours,
    slaHours,
  };
}
