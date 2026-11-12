import { botId, defaultBotId, knowledgeScope, privateScope } from './chatbots.js';
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { field } from './requests.js';
import { customerFacts } from './applicability.js';
import { containsSecret, scrubPII } from './privacy.js';
import { computeInitialConfidence, insertPassport, normalizeApplicability, normalizeSafety, passportFromResolution } from './passports.js';
import { passportView } from './memory-pool.js';

const needsReviewLegacy = (r) => Boolean(r.reviewRequestedAt && (r.reviewRevision || 0) > (r.reviewedRevision || 0));

export function createLearning(store, memory, companies, config = {}, reuse, providerActions, { memoryPool, followThrough } = {}) {
  const scope = (companyId, provider, chatbotId = defaultBotId(companyId,provider)) => knowledgeScope(companyId,chatbotId);
  function caseFor(data, staff, id, revision) {
    const h = data.handoffs.find(
      (h) =>
        h.id === id &&
        h.companyId === staff.companyId &&
        h.chatbotId === botId(staff) &&
        (h.provider || h.scope.split(':')[1]) === staff.provider,
    );
    if (!h) throw fault(404, 'Case not found in your company and service workspace.');
    if (revision !== (h.revision || 0)) throw fault(409, 'This case changed. Refresh before saving.');
    if (h.assignedTo && h.assignedTo !== staff.id && staff.role !== 'owner')
      throw fault(403, 'Only the assigned specialist or owner can update this case.');
    return h;
  }
  function rowFor(data, h, provider) {
    const row = data[provider].find(
      (r) => r.companyId === h.companyId && r.chatbotId === h.chatbotId && (r.ticket_id || r.id) === h.ticketId,
    );
    if (!row) throw fault(404, 'Request not found.');
    return row;
  }
  function setStatus(row, provider, value, now) {
    row[provider === 'repair' ? 'status' : 'state'] = value;
    row.updatedAt = now;
  }
  function event(data, h, kind, note, now) {
    data.audit.push({ id: randomUUID(), scope: h.scope, ticketId: h.ticketId, kind, note, createdAt: now });
  }
  function followup(data, h, text, now, resolutionId) {
    data.conversations.push({
      id: randomUUID(),
      scope: h.scope,
      ticketId: h.ticketId,
      system: true,
      message: '[Specialist update]',
      createdAt: now,
      response: {
        human: true,
        resolutionId,
        reply: text,
        model: 'Human specialist',
        evidence: [],
        trace: { memory: 'Human specialist', recalled: 0 },
      },
    });
  }
  function change(staff, operation, work) {
    const key = `operator:${staff.companyId}:${staff.id}`;
    return store.update((data) => {
      const previous =
        operation?.key && data.operations.find((o) => o.scope === key && o.key === operation.key);
      if (previous) {
        if (previous.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.');
        return previous.response;
      }
      const result = work(data);
      if (operation?.key) data.operations.push({ scope: key, ...operation, response: result });
      return result;
    });
  }
  async function publish(item) {
    const sync = await memory.remember({
      id: item.memoryId,
      scope: scope(item.companyId, item.provider, item.chatbotId),
      ticketId: 'knowledge',
      kind: 'verified_resolution',
      resolutionId: item.id,
      text: `Human-verified resolution: ${item.title}\nApplicable environment: ${item.environment}\nMatching symptoms: ${item.symptoms}\nVerified steps: ${item.solution}`,
      createdAt: item.publishedAt || item.createdAt,
    });
    store.update((data) => {
      data.resolutions.find((r) => r.id === item.id).sync = sync;
    });
    return sync;
  }
  function caseFacts(h) {
    const row = store.db.prepare('SELECT context FROM troubleshooting_context WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').get(h.companyId, h.chatbotId, h.customerId, h.ticketId);
    const context = row ? JSON.parse(row.context) : {};
    const t = h.context?.ticket || {};
    return customerFacts([t.title, t.issue, h.summary, ...Object.values(context)].join('\n'), context);
  }
  function draftPassport(staff, body) {
    const title = field(body.title, 'title', 100),
      symptoms = field(body.symptoms, 'symptoms', 1000),
      environment = field(body.environment, 'product and versions', 500),
      solution = field(body.solution, 'solution steps', 2000);
    const safetyText = typeof body.safety === 'string' ? body.safety.slice(0, 1000) : '';
    if (body.riskLevel !== undefined && !['standard', 'high'].includes(body.riskLevel)) throw fault(400, 'Choose a valid risk level.');
    const all = [title, symptoms, environment, solution, safetyText].join('\n');
    if (containsSecret(all)) throw fault(400, 'Remove identifying information and credentials from shared knowledge.');
    const h = store.data.handoffs.find((x) => x.id === body.handoffId && x.companyId === staff.companyId && x.chatbotId === botId(staff));
    const customer = h && store.db.prepare('SELECT name,email FROM accounts WHERE id=?').get(h.customerId);
    const names = customer ? [customer.name, customer.email] : [];
    const clean = (t) => scrubPII(t, { names }).text;
    const redactions = scrubPII(all, { names }).count;
    const safety = normalizeSafety(safetyText);
    if (safety.noneIdentified) safety.reviewed = body.safetyReviewed === true;
    const applicability = normalizeApplicability({ ...(body.applicability || {}), environmentText: clean(environment) });
    const passport = { title: clean(title), symptoms: clean(symptoms), applicability, safety, steps: [clean(solution)] };
    const cInit = computeInitialConfidence(passport, {
      facts: h ? caseFacts(h) : null,
      author: { kind: 'staff', ...(memoryPool ? memoryPool.specialistHistory(staff.companyId, staff.id) : {}) },
    });
    return { passport, cInit, redactions, riskLevel: body.riskLevel || 'standard' };
  }
  /** Explicit customer outcome on a proposal updates the unified pool. */
  function publishToPool(r, h, accepted, now) {
    const sql = store.db;
    const existing = sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND source_key=? ORDER BY version_number DESC LIMIT 1').get(r.companyId, 'resolution:' + r.id);
    if (existing) {
      // An overdue auto-published version now receives an explicit customer answer.
      if (accepted && r.allowMemoryPublication)
        sql.prepare("UPDATE memory_pool SET origin_type='specialist_confirmed',customer_confirmed=1,verification_evidence_json=json_set(verification_evidence_json,'$.customerConfirmed',json('true'),'$.confirmedAt',?,'$.label','Confirmed by the original customer after auto-publication'),updated_at=? WHERE id=? AND company_id=?")
          .run(now, now, existing.id, r.companyId);
      else if (!accepted)
        sql.prepare("UPDATE memory_pool SET status=CASE WHEN status='active' THEN 'flagged_for_review' ELSE status END,flagged_reason='The original customer reported this fix did not work',reuse_failure_count=reuse_failure_count+1,consecutive_failures=consecutive_failures+1,updated_at=? WHERE id=? AND company_id=?")
          .run(now, existing.id, r.companyId);
      return;
    }
    if (!accepted || !r.allowMemoryPublication) return;
    const passport = r.passport || passportFromResolution(r);
    const cInit = r.cInit || computeInitialConfidence(passport, { author: { kind: 'staff' } });
    insertPassport(sql, {
      id: r.id,
      companyId: r.companyId,
      chatbotId: r.chatbotId,
      origin: 'specialist_confirmed',
      sourceKey: 'resolution:' + r.id,
      sourceTicketId: h.ticketId,
      ...passport,
      initialConfidence: cInit.score,
      customerConfirmed: true,
      highRisk: r.riskLevel === 'high',
      evidence: { customerConfirmed: true, confirmedAt: now, proposalId: r.id, handoffId: h.id, label: 'Confirmed by the original customer' },
      provenance: { cInit, redactions: r.redactions || 0, authorRole: 'specialist' },
      now,
    });
  }
  return {
    list(companyId, provider, chatbotId = defaultBotId(companyId,provider)) {
      const data = store.data;
      return data.resolutions
        .filter((r) => r.companyId === companyId && r.chatbotId === chatbotId)
        .map(({ authorId, ...r }) => {
          const m = data.memories.find((m) => m.id === r.memoryId);
          const row = memoryPool?.get(companyId, chatbotId, r.id);
          return {
            ...r,
            environment: r.environment,
            passport: row ? passportView(row) : null,
            reviewRequired: row ? row.status === 'flagged_for_review' : needsReviewLegacy(r),
            reuse: reuse?.stats(companyId, provider, r.id) || { pending: 0, succeeded: 0, failed: 0 },
            sync: r.retiredAt
              ? m?.syncPending
                ? 'retirement pending'
                : 'retired'
              : m?.syncedTo
                ? 'synced'
                : r.sync,
          };
        });
    },
    assign(staff, body, operation) {
      if (body.confirmed !== true) throw fault(400, 'Confirm the assignment.');
      return change(staff, operation, (data) => {
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (h.status === 'Resolved') throw fault(409, 'This case is resolved.');
        const target = field(body.assignedTo, 'specialist', 100);
        if (target !== staff.id && staff.role !== 'owner')
          throw fault(403, 'Only the owner can assign another specialist.');
        if (!companies.roster(staff).some((a) => a.id === target))
          throw fault(400, 'Choose a specialist in this company and service workspace.');
        h.assignedTo = target;
        const assignedRow = rowFor(data, h, staff.provider);
        assignedRow[staff.provider === 'repair' ? 'assigned_to' : 'owner'] =
          companies.roster(staff).find((a) => a.id === target).name;
        h.status = 'In progress';
        h.revision = (h.revision || 0) + 1;
        const now = new Date().toISOString();
        setStatus(rowFor(data, h, staff.provider), staff.provider, h.status, now);
        event(data, h, 'assignment', 'A specialist was assigned.', now);
        return { success: true, revision: h.revision };
      });
    },
    progress(staff, body, operation) {
      if (body.confirmed !== true) throw fault(400, 'Confirm the progress update.');
      const note = field(body.note, 'customer-visible update', 2000);
      if (!['In progress', 'Waiting for parts', 'Awaiting customer'].includes(body.status))
        throw fault(400, 'Choose a valid status.');
      if (
        body.eta &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(body.eta) ||
          !Number.isFinite(+new Date(body.eta)) ||
          new Date(body.eta).toISOString().slice(0, 10) !== body.eta)
      )
        throw fault(400, 'Enter a valid ETA date.');
      if (body.stepOutcome && !['attempted', 'failed', 'succeeded'].includes(body.stepOutcome))
        throw fault(400, 'Choose a valid step outcome.');
      if (body.priority && !['Normal', 'High', 'Urgent'].includes(body.priority))
        throw fault(400, 'Choose a valid priority.');
      return change(staff, operation, (data) => {
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (!h.assignedTo || ['Resolved', 'Awaiting confirmation'].includes(h.status))
          throw fault(409, 'Claim an active case before updating it.');
        const now = new Date().toISOString(),
          row = rowFor(data, h, staff.provider);
        h.status = body.status;
        h.revision++;
        h.updatedAt = now;
        setStatus(row, staff.provider, body.status, now);
        if (body.eta !== undefined)
          row[staff.provider === 'repair' ? 'eta_date' : 'target_resolution'] = body.eta || null;
        if (body.priority) row.priority = body.priority;
        row[staff.provider === 'repair' ? 'assigned_to' : 'owner'] =
          companies.roster(staff).find((a) => a.id === h.assignedTo)?.name || 'Service team';
        h.troubleshooting ||= [];
        if (body.step) {
          const step = field(body.step, 'troubleshooting step', 1000);
          h.troubleshooting.push({
            id: randomUUID(),
            step,
            outcome: body.stepOutcome || 'attempted',
            authorId: staff.id,
            createdAt: now,
          });
          if (body.stepOutcome === 'failed')
            data.memories.push({
              id: randomUUID(),
              scope: h.scope,
              ticketId: h.ticketId,
              kind: 'failed',
              text: 'Specialist step failed: ' + step,
              createdAt: now,
            });
        }
        followup(data, h, note, now);
        event(data, h, 'progress', note, now);
        return { success: true, revision: h.revision };
      });
    },
    /** Build (but do not save) the scrubbed passport and its C_init for preview. */
    preview(staff, body) {
      return draftPassport(staff, body);
    },
    async resolve(staff, body, operation) {
      if (body.confirmed !== true || body.reviewedForPrivacy !== true)
        throw fault(400, 'Confirm the solution and review reusable content for private data.');
      const draft = draftPassport(staff, body);
      let operationReplay = true;
      const proposed = change(staff, operation, (data) => {
        operationReplay = false;
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (
          !h.assignedTo ||
          h.status === 'Resolved' ||
          data.resolutions.some((r) => r.id === h.resolutionId && r.status !== 'rejected')
        )
          throw fault(409, 'Claim the case and wait for the current solution to be reviewed.');
        const now = new Date().toISOString(),
          r = {
            id: randomUUID(),
            companyId: staff.companyId,
            provider: staff.provider,
            chatbotId: botId(staff),
            title: draft.passport.title,
            symptoms: draft.passport.symptoms,
            environment: draft.passport.applicability.environmentText || '',
            applicability: draft.passport.applicability,
            safety: draft.passport.safety,
            solution: draft.passport.steps[0],
            passport: draft.passport,
            riskLevel: draft.riskLevel,
            reviewedForPrivacy: true,
            redactions: draft.redactions,
            cInit: draft.cInit,
            authorId: staff.id,
            handoffId: h.id,
            handoffCustomerId: h.customerId,
            ticketId: h.ticketId,
            createdAt: now,
            status: 'pending_confirmation',
            sync: 'awaiting customer',
          };
        r.memoryId = 'resolution-' + r.id;
        h.resolutionId = r.id;
        h.status = 'Awaiting confirmation';
        h.followUpRequired = false;
        h.revision++;
        setStatus(rowFor(data, h, staff.provider), staff.provider, h.status, now);
        data.resolutions.push(r);
        followup(data, h, r.solution, now, r.id);
        event(data, h, 'solution_proposed', 'A specialist proposed a solution for customer confirmation.', now);
        return { ...r };
      });
      // Outside the record transaction: email queueing writes its own records.
      const customer = store.db.prepare('SELECT email FROM accounts WHERE id=?').get(proposed.handoffCustomerId || '');
      proposed.confirmationDeadline = followThrough?.scheduleConfirmation({
        companyId: staff.companyId, chatbotId: botId(staff), ticketId: proposed.ticketId, customerId: proposed.handoffCustomerId,
        handoffId: proposed.handoffId, proposalId: proposed.id, specialistId: staff.id, cInit: proposed.cInit.score, customerEmail: customer?.email,
      });
      if (proposed.confirmationDeadline && !operationReplay)
        followThrough?.log({ companyId: staff.companyId, chatbotId: botId(staff), ticketId: proposed.ticketId, customerId: proposed.handoffCustomerId, kind: 'solution_proposed', detail: { proposalId: proposed.id, cInit: proposed.cInit.score, deadline: proposed.confirmationDeadline, redactions: proposed.redactions }, actor: staff.id });
      return proposed;
    },
    async confirm(profile, body) {
      if (body.confirmed !== true || typeof body.accepted !== 'boolean')
        throw fault(400, 'Confirm whether the solution worked.');
      const result = store.update((data) => {
        const r = data.resolutions.find((r) => r.id === body.id && r.companyId === profile.companyId);
        const h =
          r &&
          data.handoffs.find(
            (h) =>
              h.id === r.handoffId && h.scope === privateScope(profile),
          );
        if (!r || !h) throw fault(404, 'Solution not found in your account.');
        if (r.status !== 'pending_confirmation') {
          if (r.customerAccepted === body.accepted) return { ...r };
          throw fault(409, 'This solution was already reviewed.');
        }
        const now = new Date().toISOString();
        r.customerAccepted = body.accepted;
        // Explicit API opt-out is still honoured; the customer UI no longer shows a toggle.
        r.allowMemoryPublication = body.memory !== false;
        r.confirmedAt = now;
        r.status = body.accepted ? r.allowMemoryPublication ? 'published' : 'confirmed_private' : 'rejected';
        r.publishedAt = body.accepted && r.allowMemoryPublication ? now : null;
        r.sync = body.accepted && r.allowMemoryPublication ? 'pending' : 'not published';
        h.status = body.accepted ? 'Resolved' : 'In progress';
        h.followUpRequired = !body.accepted;
        h.revision++;
        setStatus(
          rowFor(data, h, profile.provider),
          profile.provider,
          body.accepted ? 'Resolved' : 'Reopened',
          now,
        );
        const note = body.note
          ? field(body.note, 'outcome note', 1000)
          : body.accepted
            ? 'Customer confirmed the specialist solution worked.'
            : 'Customer reported the specialist solution did not work.';
        if (body.memory !== false) data.memories.push({
          id: randomUUID(),
          scope: h.scope,
          ticketId: h.ticketId,
          kind: body.accepted ? 'resolved' : 'failed',
          resolutionId: r.id,
          text: note,
          createdAt: now,
        });
        event(data, h, 'customer_confirmation', note, now);
        providerActions?.enqueue(profile, 'outcome', r.id, h.ticketId, {
          outcome: body.accepted ? 'resolved' : 'failed',
          note,
        });
        if (memoryPool) publishToPool(r, h, body.accepted, now);
        followThrough?.completeConfirmation(profile.companyId, r.id, { accepted: body.accepted, at: now });
        followThrough?.log({ companyId: profile.companyId, chatbotId: r.chatbotId, ticketId: h.ticketId, customerId: profile.id, kind: body.accepted ? 'customer_confirmed' : 'customer_rejected', detail: { proposalId: r.id, published: r.status === 'published' }, actor: 'customer', at: now });
        return { ...r };
      });
      const sync = result.status === 'published' && result.allowMemoryPublication !== false && !result.retiredAt ? await publish(result) : result.sync;
      return { success: true, status: result.status, sync };
    },
    async retire(staff, body) {
      if (body.confirmed !== true) throw fault(400, 'Confirm retiring this resolution.');
      const row = memoryPool?.get(staff.companyId, botId(staff), body.id);
      const item = store.data.resolutions.find(
        (r) => r.id === body.id && r.companyId === staff.companyId && r.chatbotId === botId(staff),
      );
      if (!item && !row) throw fault(404, 'Resolution not found.');
      if (row) store.db.prepare("UPDATE memory_pool SET status='retired',updated_at=? WHERE id=? AND company_id=? AND chatbot_id=? AND status IN ('active','flagged_for_review')").run(new Date().toISOString(), row.id, staff.companyId, botId(staff));
      if (item) {
        store.update((data) => {
          data.resolutions.find((r) => r.id === item.id).retiredAt ||= new Date().toISOString();
        });
        if (store.data.memories.some((m) => m.id === item.memoryId))
          await memory.invalidate(scope(staff.companyId, staff.provider, botId(staff)), 'knowledge', item.memoryId);
      }
      return { success: true };
    },
  };
}
