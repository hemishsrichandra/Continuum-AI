// Follow-through: case timeline, customer-confirmation deadlines, overdue
// publication and SLA escalation. The tick runs from the integrations worker
// (never per web request) and is transactional and idempotent: each task is
// claimed with a conditional UPDATE, and memory publication uses a unique
// (company_id, source_key, version_number) key, so retries or concurrent workers
// cannot publish twice.
import { randomUUID } from 'node:crypto';
import { THRESHOLDS } from './scoring.js';
import { insertPassport, passportFromResolution, normalizeSafety, stepsList } from './passports.js';
import { sanitizeDeep } from './privacy-sanitizer.js';
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
  // Milestone deadlines for assigned cases (hours). Assignment is slaHours above.
  const policy = {
    firstResponseHours: hours(config.SLA_FIRST_RESPONSE_HOURS, 4),
    inactivityHours: hours(config.SLA_INACTIVITY_HOURS, 24),
    followUpHours: hours(config.SLA_FOLLOW_UP_HOURS, 24),
    resolutionHours: hours(config.SLA_RESOLUTION_HOURS, 72),
  };
  const STAFF_ACTIONS = new Set(['assignment', 'progress', 'solution_proposed', 'resolution_revised', 'resolution_review']);

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
  /**
   * The customer asked for more time to try a specialist's fix. Only the explicit request moves the deadline, and only
   * while the wait is still pending; silence still never counts as success.
   */
  function deferConfirmation(companyId, proposalId, extraHours = confirmationHours, at = Date.now()) {
    const task = sql.prepare("SELECT id,deadline_at FROM follow_through_tasks WHERE company_id=? AND dedupe_key=? AND status='pending'").get(companyId, 'confirm:' + proposalId);
    if (!task) return null;
    const next = iso(Math.max(Date.parse(task.deadline_at), at) + extraHours * 3600000);
    const moved = sql.prepare("UPDATE follow_through_tasks SET deadline_at=? WHERE id=? AND status='pending'").run(next, task.id);
    return moved.changes ? next : null;
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
    // Trust policy: a high confidence score does not show that the fix worked, so anything unresolved blocks it.
    // (Applies to stored proposals, which carry their structured passport.)
    if (r.passport) {
      const passport = r.passport;
      const safety = normalizeSafety(passport.safety);
      if (safety.restrictions.some((x) => x.unevaluable) && !safety.reviewed) blockers.push('a safety restriction cannot be evaluated automatically');
      if (!safety.restrictions.length && !(safety.noneIdentified && safety.reviewed)) blockers.push('safety restrictions were not reviewed');
      const applicability = passport.applicability || {};
      if (!(applicability.conditions?.length || String(applicability.environmentText || '').trim() || (applicability.universal && applicability.reviewed))) blockers.push('mandatory diagnostic information (applicability) is missing');
      if (sanitizeDeep(passport).secret) blockers.push('contains credential-like content');
    }
    if (r.status && r.status !== 'pending_confirmation') blockers.push('the proposal is no longer waiting for the customer');
    return [...new Set(blockers)];
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
        const stored = sql.prepare("SELECT payload FROM records WHERE collection='resolutions' AND json_extract(payload,'$.companyId')=? AND json_extract(payload,'$.id')=?").get(task.company_id, task.proposal_id);
        const r = stored ? JSON.parse(stored.payload) : null;
        // The customer answered (or the proposal is gone): nothing to publish.
        if (!r || r.status !== 'pending_confirmation') {
          sql.prepare("UPDATE follow_through_tasks SET status='completed',processed_at=?,outcome_json=? WHERE id=? AND status='pending'").run(iso(at), JSON.stringify({ reason: 'customer responded or proposal closed' }), task.id);
          return { id: task.id, status: 'completed' };
        }
        const blockers = autoPublishBlockers(r, task.initial_confidence_score);
        if (blockers.length) {
          const claimed = sql.prepare("UPDATE follow_through_tasks SET status='escalated',processed_at=?,outcome_json=? WHERE id=? AND status='pending'").run(iso(at), JSON.stringify({ blockers }), task.id);
          if (!claimed.changes) return null;
          store.updateFor(task.company_id, (d) => {
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
        store.updateFor(task.company_id, (d) => {
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
    // Read only open handoffs, rather than deserializing every collection for every tenant each tick.
    const handoffs = sql.prepare("SELECT payload FROM records WHERE collection='handoffs' AND json_extract(payload,'$.status') NOT IN ('Resolved','Closed') ORDER BY position").all().map((r) => JSON.parse(r.payload));
    for (const h of handoffs.filter((h) => h.status === 'Queued' && !h.assignedTo && h.createdAt && Date.parse(h.createdAt) + slaHours * 3600000 <= at)) {
      const inserted = sql.prepare(`INSERT INTO follow_through_tasks(id,company_id,chatbot_id,ticket_id,customer_id,handoff_id,task_type,dedupe_key,deadline_at,status,created_at)
        VALUES(?,?,?,?,?,?,'sla_escalation',?,?,'escalated',?) ON CONFLICT(company_id,dedupe_key) DO NOTHING`)
        .run(randomUUID(), h.companyId, h.chatbotId, h.ticketId, h.customerId, h.id, 'sla:' + h.id, iso(Date.parse(h.createdAt) + slaHours * 3600000), iso(at));
      if (inserted.changes) {
        log({ companyId: h.companyId, chatbotId: h.chatbotId, ticketId: h.ticketId, customerId: h.customerId, kind: 'sla_breached', detail: { slaHours }, actor: 'follow-through worker', at: iso(at) });
        results.push({ handoffId: h.id, status: 'sla_escalated' });
      }
    }
    results.push(...slaMilestones(at, handoffs));
    return results;
  }

  /**
   * SLA milestones for cases that ARE assigned but not progressing. Each (case, milestone) escalates once: the
   * escalation history lives in sla_events, so a case that was already escalated is never escalated again for the
   * same reason, and a case waiting on the customer is never blamed on the specialist.
   *   first_response   assigned, but the specialist has done nothing since
   *   specialist_inactive   no specialist activity for the inactivity window (one escalation per quiet period)
   *   follow_up        the customer needs a follow-up and nobody has acted on it
   *   resolution       open past the final-resolution deadline
   */
  function slaMilestones(at, handoffs) {
    const out = [];
    const open = handoffs.filter((h) => h.createdAt && h.assignedTo);
    if (!open.length) return out;
    const assignedAt = new Map();
    const lastStaff = new Map();
    for (const h of open) {
      // record_scope covers this exact scope/ticket lookup; identical ticket IDs in other tenants cannot contribute.
      const activity = sql.prepare("SELECT payload FROM records WHERE collection='audit' AND json_extract(payload,'$.scope')=? AND json_extract(payload,'$.ticketId')=?").all(h.scope, h.ticketId);
      for (const row of activity) {
        const a = JSON.parse(row.payload);
        if (!a.createdAt || !STAFF_ACTIONS.has(a.kind)) continue;
        const t = Date.parse(a.createdAt);
        if (a.kind === 'assignment') assignedAt.set(h.id, Math.max(assignedAt.get(h.id) || 0, t));
        lastStaff.set(h.id, Math.max(lastStaff.get(h.id) || 0, t));
      }
    }
    // The ball is in the customer's court while a proposal is unanswered, even after it was auto-published as unconfirmed.
    const waitingOnCustomer = new Set([
      ...sql.prepare("SELECT handoff_id FROM follow_through_tasks WHERE status='pending' AND task_type='customer_confirmation_wait'").all().map((r) => r.handoff_id),
      ...[...new Set(open.map((h) => h.companyId))].flatMap((companyId) => sql.prepare("SELECT json_extract(payload,'$.handoffId') AS id FROM records WHERE collection='resolutions' AND json_extract(payload,'$.companyId')=? AND json_extract(payload,'$.status')='pending_confirmation'").all(companyId).map((r) => r.id)),
    ]);
    const H = 3600000;
    const raise = (h, milestone, dueMs, message) => {
      const inserted = sql
        .prepare('INSERT OR IGNORE INTO sla_events(id,company_id,chatbot_id,handoff_id,ticket_id,milestone,due_at,escalated_at,detail_json) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), h.companyId, h.chatbotId, h.id, h.ticketId, milestone, iso(dueMs), iso(at), JSON.stringify({ message }));
      if (!inserted.changes) return;
      sql
        .prepare(`INSERT INTO follow_through_tasks(id,company_id,chatbot_id,ticket_id,customer_id,handoff_id,task_type,dedupe_key,deadline_at,status,outcome_json,created_at)
          VALUES(?,?,?,?,?,?,'sla_escalation',?,?,'escalated',?,?) ON CONFLICT(company_id,dedupe_key) DO NOTHING`)
        .run(randomUUID(), h.companyId, h.chatbotId, h.ticketId, h.customerId, h.id, 'sla:' + milestone + ':' + h.id, iso(dueMs), JSON.stringify({ milestone, message }), iso(at));
      log({ companyId: h.companyId, chatbotId: h.chatbotId, ticketId: h.ticketId, customerId: h.customerId, kind: 'sla_breached', detail: { milestone, message }, actor: 'follow-through worker', at: iso(at) });
      out.push({ handoffId: h.id, status: 'sla_escalated', milestone });
    };
    for (const h of open) {
      const created = Date.parse(h.createdAt);
      const assigned = assignedAt.get(h.id) || created;
      const last = lastStaff.get(h.id) || assigned;
      const customerTurn = waitingOnCustomer.has(h.id);
      if (!customerTurn && last <= assigned && assigned + policy.firstResponseHours * H <= at)
        raise(h, 'first_response', assigned + policy.firstResponseHours * H, 'Assigned but no specialist response yet.');
      if (!customerTurn && last > assigned && last + policy.inactivityHours * H <= at)
        raise(h, 'specialist_inactive:' + last, last + policy.inactivityHours * H, 'No specialist activity for a while.');
      if (h.followUpRequired && !customerTurn) {
        const since = Math.max(Date.parse(h.updatedAt || '') || 0, assigned);
        if (last <= since && since + policy.followUpHours * H <= at) raise(h, 'follow_up', since + policy.followUpHours * H, 'The customer needs a follow-up.');
      }
      if (created + policy.resolutionHours * H <= at) raise(h, 'resolution', created + policy.resolutionHours * H, 'Open past the resolution deadline.');
    }
    return out;
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
              ? (t.outcome_json && JSON.parse(t.outcome_json).message) || 'Unclaimed past the SLA: claim or assign this case.'
              : t.status === 'pending' ? 'Review the flagged fix: keep, retire or publish a revised version.' : 'Reviewed.',
      }));
    return { slaHours, confirmationHours, policy, tasks: list };
  }

  return {
    log,
    timeline,
    scheduleConfirmation,
    deferConfirmation,
    completeConfirmation,
    autoPublishBlockers,
    tick,
    queue,
    confirmationHours,
    slaHours,
  };
}
