import { botId, privateScope, defaultBotId } from './chatbots.js';
import { randomUUID } from 'node:crypto';
import { field } from './requests.js';
import { fault } from './providers.js';
import { resolutionSignature } from './context.js';
import { signatureOf, stepsText } from './passports.js';

// Legacy (pre-Migration 5) review flag on resolution records. Retrieval now uses
// memory_pool.status; a single failure no longer locks a fix out globally.
export const needsReview = (r) =>
  Boolean(r.reviewRequestedAt && (r.reviewRevision || 0) > (r.reviewedRevision || 0));

/** Fixes this customer already reported as failed: never offered to them again. */
export function failedResolutions(store, companyId, provider, customerId, chatbotId = defaultBotId(companyId, provider)) {
  const ids = new Set(
    store.db
      .prepare("SELECT resolution_id FROM resolution_uses WHERE company_id=? AND customer_id=? AND chatbot_id=? AND status='failed'")
      .all(companyId, customerId, chatbotId)
      .map((r) => r.resolution_id),
  );
  for (const a of store.db
    .prepare("SELECT memory_id FROM troubleshooting_attempts WHERE company_id=? AND chatbot_id=? AND customer_id=? AND source='learned' AND outcome='failed' AND memory_id IS NOT NULL")
    .all(companyId, chatbotId, customerId))
    ids.add(a.memory_id);
  const signatures = new Set();
  if (ids.size) {
    for (const r of store.db.prepare(`SELECT steps_json FROM memory_pool WHERE company_id=? AND chatbot_id=? AND id IN (${[...ids].map(() => '?').join(',')})`).all(companyId, chatbotId, ...ids))
      signatures.add(signatureOf(JSON.parse(r.steps_json)));
    for (const r of store.dataFor(companyId).resolutions.filter((r) => r.companyId === companyId && (r.chatbotId || defaultBotId(companyId, provider)) === chatbotId && ids.has(r.id))) {
      signatures.add(resolutionSignature(r));
      signatures.add(signatureOf([r.solution]));
    }
  }
  return { ids, signatures };
}

export function createReuse(store, memory, providerActions, memoryPool) {
  const sql = store.db;
  const publicUse = (row) =>
    row ? { id: row.id, status: row.status, resolutionId: row.resolution_id, handoffId: row.handoff_id } : null;
  function insertUse(profile, ticket, memoryId, exchangeId, now) {
    const scope = privateScope(profile);
    sql
      .prepare(
        `INSERT INTO resolution_uses(id,company_id,provider,customer_id,scope,ticket_id,resolution_id,exchange_id,environment,created_at,chatbot_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,provider,customer_id,ticket_id,resolution_id) DO NOTHING`,
      )
      .run(randomUUID(), profile.companyId, profile.provider, profile.id, scope, ticket.id, memoryId, exchangeId, JSON.stringify({ title: ticket.title, issue: ticket.issue }), now, botId(profile));
    const use = sql.prepare('SELECT * FROM resolution_uses WHERE scope=? AND ticket_id=? AND resolution_id=?').get(scope, ticket.id, memoryId);
    if (use.status === 'failed') throw fault(409, 'This fix was already unsuccessful. Ask again for specialist help.');
    return publicUse(use);
  }
  return {
    /** Record that a company-memory passport was shown to this customer. */
    recordMemory(profile, ticket, memoryRow, exchangeId, now) {
      const current = memoryPool.get(profile.companyId, botId(profile), memoryRow.id);
      if (!current || current.status !== 'active') throw fault(409, 'This fix changed while answering. Ask again for the current guidance.');
      if (failedResolutions(store, profile.companyId, profile.provider, profile.id, botId(profile)).signatures.has(signatureOf(JSON.parse(current.steps_json))))
        throw fault(409, 'These steps already failed for you. Ask for a revised specialist solution.');
      return insertUse(profile, ticket, current.id, exchangeId, now);
    },
    // Legacy hook used when saving a chat response: new recommendations already
    // carry their use record, so this only resolves evidence for older clients.
    record(profile, ticket, response, exchangeId, now) {
      if (response.decision?.mode !== 'recommend') return null;
      const evidence = response.evidence?.find((e) => ['verified_resolution', 'company_memory'].includes(e.kind));
      if (!evidence) return null;
      const row = memoryPool.get(profile.companyId, botId(profile), evidence.resolutionId);
      if (!row) throw fault(409, 'This fix changed while answering. Ask again for the current guidance.');
      return this.recordMemory(profile, ticket, row, exchangeId, now);
    },
    current(scope, id) {
      return publicUse(sql.prepare('SELECT * FROM resolution_uses WHERE id=? AND scope=?').get(id, scope));
    },
    stats(companyId, provider, resolutionId) {
      const rows = sql
        .prepare('SELECT status,COUNT(*) AS count FROM resolution_uses WHERE company_id=? AND resolution_id=? GROUP BY status')
        .all(companyId, resolutionId);
      return Object.fromEntries(['pending', 'succeeded', 'failed'].map((status) => [status, rows.find((r) => r.status === status)?.count || 0]));
    },
    feedback(profile, body) {
      if (body.confirmed !== true || typeof body.worked !== 'boolean') throw fault(400, 'Confirm whether this fix worked.');
      const id = field(body.useId, 'recommendation ID', 100);
      const scope = privateScope(profile);
      let retained;
      const result = store.updateFor(profile.companyId, (data) => {
        const use = sql.prepare('SELECT * FROM resolution_uses WHERE id=? AND scope=?').get(id, scope);
        const r = use && memoryPool.get(profile.companyId, botId(profile), use.resolution_id);
        if (!use || !r) throw fault(404, 'Recommendation not found in your account.');
        if (body.ticketId && use.ticket_id !== body.ticketId) throw fault(400, 'This recommendation belongs to another request.');
        const target = body.worked ? 'succeeded' : 'failed';
        if (use.status === target) return { success: true, ...publicUse(use) };
        if (use.status !== 'pending') throw fault(409, 'This attempt already has a final outcome. Create a new request if the issue returns.');
        const row = data[profile.provider].find(
          (row) =>
            row.companyId === profile.companyId &&
            row.chatbotId === botId(profile) &&
            (row.customer_id || row.user_id) === profile.id &&
            (row.ticket_id || row.id) === use.ticket_id,
        );
        if (!row) throw fault(404, 'Service request not found.');
        const now = new Date().toISOString();
        const steps = stepsText(r);
        const note = body.note
          ? field(body.note, 'outcome note', 1000)
          : body.worked
            ? 'Customer confirmed the recommended fix worked.'
            : 'The recommended fix did not resolve the issue.';
        if (body.worked) row[profile.provider === 'repair' ? 'status' : 'state'] = 'Resolved';
        else if (body.allowHandoff !== false) row[profile.provider === 'repair' ? 'status' : 'state'] = 'Reopened';
        row.updatedAt = now;
        let handoffId = null;
        if (!body.worked && body.allowHandoff !== false) {
          let h = data.handoffs.find((h) => h.scope === scope && h.ticketId === use.ticket_id && !['Resolved', 'Closed'].includes(h.status));
          if (!h) {
            h = {
              id: randomUUID(),
              scope,
              companyId: profile.companyId,
              provider: profile.provider,
              chatbotId: botId(profile),
              customerId: profile.id,
              ticketId: use.ticket_id,
              status: 'Queued',
              assignedTo: null,
              revision: 0,
              troubleshooting: [],
              summary: note,
              createdAt: now,
              context: {
                ticket: { id: use.ticket_id, title: row.device || row.problem, issue: row.issue || row.details, status: 'Reopened' },
                conversation: data.conversations
                  .filter((c) => c.scope === scope && c.ticketId === use.ticket_id && !c.archivedAt)
                  .slice(-50)
                  .map((c) => ({ question: c.message, answer: c.response.reply, createdAt: c.createdAt })),
                memories: body.memory === false ? [] : data.memories.filter((m) => m.scope === scope && m.ticketId === use.ticket_id && !m.invalidatedAt).map(({ text, kind }) => ({ text, kind })),
              },
            };
            data.handoffs.push(h);
          }
          h.troubleshooting ||= [];
          h.troubleshooting.push({ id: randomUUID(), resolutionId: r.id, step: steps, outcome: 'failed', note, authorId: profile.id, createdAt: now });
          h.revision = (h.revision || 0) + 1;
          handoffId = h.id;
        }
        retained = {
          id: randomUUID(),
          scope,
          ticketId: use.ticket_id,
          kind: body.worked ? 'resolved' : 'failed',
          resolutionId: r.id,
          text: body.worked ? note : `${note} The ${r.title} fix was unsuccessful for this request.`,
          createdAt: now,
        };
        if (body.memory !== false) data.memories.push(retained);
        data.audit.push({ id: randomUUID(), scope, ticketId: use.ticket_id, kind: 'resolution_outcome', resolutionId: r.id, note, createdAt: now });
        providerActions?.enqueue(profile, 'outcome', use.id + ':' + target, use.ticket_id, { outcome: body.worked ? 'resolved' : 'failed', note });
        if (handoffId)
          providerActions?.enqueue(profile, 'handoff', handoffId, use.ticket_id, { summary: note, attemptedResolution: { id: r.id, steps } });
        sql.prepare('UPDATE resolution_uses SET status=?,note=?,handoff_id=?,feedback_at=? WHERE id=?').run(target, note, handoffId, now, id);
        // Per-passport self-correction (2 consecutive failures or W < 0.55 flags review).
        const outcome = memoryPool.recordOutcome({ companyId: profile.companyId, chatbotId: botId(profile), memoryId: r.id, worked: body.worked, safetyIncident: body.safetyIncident === true, ticketId: use.ticket_id });
        return { success: true, id, status: target, resolutionId: r.id, handoffId, review: outcome };
      });
      if (retained && body.memory !== false) return Promise.resolve(memory.remember(retained)).catch(() => {}).then(() => result);
      return Promise.resolve(result);
    },
    review(staff, body) {
      const result = memoryPool.review({ ...staff, chatbotId: botId(staff) }, body.id, body);
      store.update((data) => {
        const legacy = data.resolutions.find((r) => r.id === body.id && r.companyId === staff.companyId);
        if (legacy) {
          legacy.reviewedRevision = legacy.reviewRevision;
          legacy.reviewedAt = new Date().toISOString();
          if (body.decision === 'retire') legacy.retiredAt ||= legacy.reviewedAt;
        }
        data.audit.push({ id: randomUUID(), scope: `company:${staff.companyId}`, kind: 'resolution_review', resolutionId: body.id, note: body.note, decision: body.decision, authorId: staff.id, createdAt: new Date().toISOString() });
      });
      return { success: true, retired: result.status === 'retired', passport: result };
    },
  };
}
