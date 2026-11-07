import { botId, privateScope, defaultBotId } from './chatbots.js';
import { randomUUID } from 'node:crypto';
import { field } from './requests.js';
import { fault } from './providers.js';
import { resolutionSignature } from './context.js';

export const needsReview = (r) =>
  Boolean(r.reviewRequestedAt && (r.reviewRevision || 0) > (r.reviewedRevision || 0));

export function failedResolutions(store, companyId, provider, customerId, chatbotId = defaultBotId(companyId,provider)) {
  const ids = new Set(
    store.db
      .prepare(
        "SELECT resolution_id FROM resolution_uses WHERE company_id=? AND provider=? AND customer_id=? AND chatbot_id=? AND status='failed'",
      )
      .all(companyId, provider, customerId, chatbotId)
      .map((r) => r.resolution_id),
  );
  const signatures = new Set(
    store.data.resolutions
      .filter((r) => r.companyId === companyId && r.provider === provider && (r.chatbotId || defaultBotId(companyId,provider)) === chatbotId && ids.has(r.id))
      .map(resolutionSignature),
  );
  return { ids, signatures };
}

export function createReuse(store, memory, providerActions) {
  const sql = store.db;
  const publicUse = (row) =>
    row
      ? { id: row.id, status: row.status, resolutionId: row.resolution_id, handoffId: row.handoff_id }
      : null;
  return {
    record(profile, ticket, response, exchangeId, now) {
      if (response.decision?.mode !== 'recommend') return null;
      const evidence = response.evidence.find((e) => e.kind === 'verified_resolution');
      if (!evidence) return null;
      const resolution = store.data.resolutions.find(
        (r) => r.id === evidence.resolutionId && r.companyId === profile.companyId && r.chatbotId === botId(profile),
      );
      if (!resolution || resolution.retiredAt || needsReview(resolution))
        throw fault(409, 'This fix changed while answering. Ask again for the current guidance.');
      if (
        failedResolutions(store, profile.companyId, profile.provider, profile.id, botId(profile)).signatures.has(
          resolutionSignature(resolution),
        )
      )
        throw fault(
          409,
          'These steps already failed in this environment. Ask for a revised specialist solution.',
        );
      const scope = privateScope(profile);
      sql
        .prepare(
          `INSERT INTO resolution_uses(id,company_id,provider,customer_id,scope,ticket_id,resolution_id,exchange_id,environment,created_at,chatbot_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,provider,customer_id,ticket_id,resolution_id) DO NOTHING`,
        )
        .run(
          randomUUID(),
          profile.companyId,
          profile.provider,
          profile.id,
          scope,
          ticket.id,
          evidence.resolutionId,
          exchangeId,
          JSON.stringify({ title: ticket.title, issue: ticket.issue }),
          now,
          botId(profile),
        );
      const use = sql
        .prepare('SELECT * FROM resolution_uses WHERE scope=? AND ticket_id=? AND resolution_id=?')
        .get(scope, ticket.id, evidence.resolutionId);
      if (use.status === 'failed')
        throw fault(409, 'This fix was already unsuccessful. Ask again for specialist help.');
      return publicUse(use);
    },
    current(scope, id) {
      return publicUse(sql.prepare('SELECT * FROM resolution_uses WHERE id=? AND scope=?').get(id, scope));
    },
    stats(companyId, provider, resolutionId) {
      const rows = sql
        .prepare(
          'SELECT status,COUNT(*) AS count FROM resolution_uses WHERE company_id=? AND provider=? AND resolution_id=? GROUP BY status',
        )
        .all(companyId, provider, resolutionId);
      return Object.fromEntries(
        ['pending', 'succeeded', 'failed'].map((status) => [
          status,
          rows.find((r) => r.status === status)?.count || 0,
        ]),
      );
    },
    feedback(profile, body) {
      if (body.confirmed !== true || typeof body.worked !== 'boolean')
        throw fault(400, 'Confirm whether this fix worked.');
      const id = field(body.useId, 'recommendation ID', 100);
      const scope = privateScope(profile);
      let retained;
      const result = store.update((data) => {
        const use = sql.prepare('SELECT * FROM resolution_uses WHERE id=? AND scope=?').get(id, scope);
        const r =
          use &&
          data.resolutions.find(
            (r) =>
              r.id === use.resolution_id &&
              r.companyId === profile.companyId &&
              r.chatbotId === botId(profile) &&
              r.provider === profile.provider,
          );
        if (!use || !r) throw fault(404, 'Recommendation not found in your account.');
        if (body.ticketId && use.ticket_id !== body.ticketId)
          throw fault(400, 'This recommendation belongs to another request.');
        const target = body.worked ? 'succeeded' : 'failed';
        if (use.status === target) return { success: true, ...publicUse(use) };
        if (use.status !== 'pending')
          throw fault(
            409,
            'This attempt already has a final outcome. Create a new request if the issue returns.',
          );
        const row = data[profile.provider].find(
          (row) =>
            row.companyId === profile.companyId &&
            row.chatbotId === botId(profile) &&
            (row.customer_id || row.user_id) === profile.id &&
            (row.ticket_id || row.id) === use.ticket_id,
        );
        if (!row) throw fault(404, 'Service request not found.');
        const now = new Date().toISOString();
        const note = body.note
          ? field(body.note, 'outcome note', 1000)
          : body.worked
            ? 'Customer confirmed the recommended fix worked.'
            : use.status === 'succeeded'
              ? 'The issue returned after the recommended fix.'
              : 'The recommended fix did not resolve the issue.';
        row[profile.provider === 'repair' ? 'status' : 'state'] = body.worked ? 'Resolved' : 'Reopened';
        row.updatedAt = now;
        let handoffId = null;
        if (!body.worked && body.allowHandoff !== false) {
          let h = data.handoffs.find(
            (h) =>
              h.scope === scope && h.ticketId === use.ticket_id && !['Resolved', 'Closed'].includes(h.status),
          );
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
                ticket: {
                  id: use.ticket_id,
                  title: row.device || row.problem,
                  issue: row.issue || row.details,
                  status: 'Reopened',
                },
                conversation: data.conversations
                  .filter((c) => c.scope === scope && c.ticketId === use.ticket_id && !c.archivedAt)
                  .slice(-50)
                  .map((c) => ({ question: c.message, answer: c.response.reply, createdAt: c.createdAt })),
                memories: body.memory === false ? [] : data.memories
                  .filter((m) => m.scope === scope && m.ticketId === use.ticket_id && !m.invalidatedAt)
                  .map(({ text, kind }) => ({ text, kind })),
              },
            };
            data.handoffs.push(h);
          }
          h.troubleshooting ||= [];
          h.troubleshooting.push({
            id: randomUUID(),
            resolutionId: r.id,
            step: r.solution,
            outcome: 'failed',
            note,
            authorId: profile.id,
            createdAt: now,
          });
          h.revision = (h.revision || 0) + 1;
          handoffId = h.id;
        }
        if(!body.worked) {
          r.reviewRequestedAt = now;
          r.reviewRevision = (r.reviewRevision || 0) + 1;
        }
        retained = {
          id: randomUUID(),
          scope,
          ticketId: use.ticket_id,
          kind: body.worked ? 'resolved' : 'failed',
          resolutionId: r.id,
          text: body.worked ? note : `${note} The reviewed ${r.title} fix was unsuccessful for this request.`,
          createdAt: now,
        };
        if (body.memory !== false) data.memories.push(retained);
        data.audit.push({
          id: randomUUID(),
          scope,
          ticketId: use.ticket_id,
          kind: 'resolution_outcome',
          resolutionId: r.id,
          note,
          createdAt: now,
        });
        providerActions?.enqueue(profile, 'outcome', use.id + ':' + target, use.ticket_id, {
          outcome: body.worked ? 'resolved' : 'failed',
          note,
        });
        if (handoffId)
          providerActions?.enqueue(profile, 'handoff', handoffId, use.ticket_id, {
            summary: note,
            attemptedResolution: { id: r.id, steps: r.solution },
          });
        sql
          .prepare('UPDATE resolution_uses SET status=?,note=?,handoff_id=?,feedback_at=? WHERE id=?')
          .run(target, note, handoffId, now, id);
        return { success: true, id, status: target, resolutionId: r.id, handoffId };
      });
      if (retained && body.memory !== false) return Promise.resolve(memory.remember(retained)).catch(()=>{}).then(()=>result);
      return Promise.resolve(result);
    },
    review(staff, body) {
      if (body.confirmed !== true || !['keep', 'retire'].includes(body.decision))
        throw fault(400, 'Confirm the review decision.');
      const note = field(body.note, 'review explanation', 1000);
      return store.update((data) => {
        const r = data.resolutions.find(
          (r) => r.id === body.id && r.companyId === staff.companyId && r.provider === staff.provider && r.chatbotId === botId(staff),
        );
        if (!r) throw fault(404, 'Resolution not found.');
        if (body.reviewRevision !== (r.reviewRevision || 0))
          throw fault(409, 'Another failure report arrived. Refresh before completing the review.');
        if (!needsReview(r)) throw fault(409, 'This resolution no longer needs review.');
        r.reviewedRevision = r.reviewRevision;
        r.reviewedAt = new Date().toISOString();
        r.reviewNote = note;
        if (body.decision === 'retire') r.retiredAt = r.reviewedAt;
        data.audit.push({
          id: randomUUID(),
          scope: `company:${staff.companyId}`,
          kind: 'resolution_review',
          resolutionId: r.id,
          note,
          decision: body.decision,
          authorId: staff.id,
          createdAt: r.reviewedAt,
        });
        return { success: true, retired: Boolean(r.retiredAt) };
      });
    },
  };
}
