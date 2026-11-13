// Company-side routes: Resolution Intelligence, owner system status, and the specialist/owner operator console.
import { botId, getBot } from '../chatbots.js';
import { randomUUID } from 'node:crypto';
import { fault, provider } from '../providers.js';
import { field, json, submission } from '../requests.js';
import { intelligenceFor } from '../intelligence.js';

export function createCompanyRoutes(services) {
  const { store, companies, providerActions, memoryPool, vectorIndex, followThrough, reuse, learning, troubleshooting, systemHealth, limit } = services;
  return async function companyRoutes(context) {
    const { req, url, endpoint, session, profile, selectedBot, staff, write } = context;
    const intel = url.pathname.match(/^\/api\/companies\/([^/]+)\/intelligence$/);
    if (intel) {
      if (req.method !== 'GET') throw fault(405, 'Use GET.');
      // The company is taken from the authenticated membership; the path value only has to agree with it.
      if (!staff || decodeURIComponent(intel[1]) !== profile.companyId)
        throw fault(403, 'Resolution Intelligence is available to staff of your own company.');
      let scopeBot = url.searchParams.get('chatbotId') || (staff.role === 'owner' ? null : botId(profile));
      if (scopeBot) {
        const bot = getBot(store.db, profile.companyId, scopeBot);
        if (!companies.mayUseBot(staff, bot)) throw fault(403, 'This service is not available to your membership.');
      }
      return write(200, intelligenceFor(store, profile.companyId, { slaHours: followThrough.slaHours, chatbotId: scopeBot }));
    }
    if (url.pathname === '/api/company/system-health') {
      if (!staff || staff.role !== 'owner') throw fault(403, 'System status is available to company owners.');
      if (req.method === 'POST') {
        limit(session.token_hash + ':health-retry', 6);
        vectorIndex.retryFailed({ companyId: profile.companyId });
        await vectorIndex.drain().catch(() => {});
      } else if (req.method !== 'GET') throw fault(405, 'Use GET or POST.');
      return write(200, await systemHealth(profile.companyId));
    }
    if (url.pathname.startsWith('/api/operator')) {
      if (!staff) throw fault(403, 'This area requires explicitly provisioned support staff access.');
      const selectedProvider = url.searchParams.get('provider');
      if (selectedProvider && !['repair', 'it'].includes(selectedProvider))
        throw fault(400, 'Choose a valid schema adapter.');
      if (selectedProvider && selectedProvider !== staff.provider && staff.role !== 'owner')
        throw fault(403, 'This service workspace requires owner access.');
      const operatorBot = url.searchParams.get('chatbotId')
        ? getBot(store.db,profile.companyId,url.searchParams.get('chatbotId'))
        : selectedProvider ? getBot(store.db,profile.companyId,profile.companyId+':'+selectedProvider) : selectedBot;
      if (!operatorBot.active || !companies.mayUseBot(staff, operatorBot))
        throw fault(403,'This service queue is not available to your membership.');
      const operator = { ...staff, provider: operatorBot.adapter, chatbotId: operatorBot.id };
      const scopedData = store.dataFor(operator.companyId);
      if (endpoint === 'GET /api/operator')
        return write(200, {
          chatbot: operatorBot,
          companyId: operator.companyId,
          provider: operator.provider,
          self: operator.id,
          role: operator.role,
          staff: companies.roster(operator),
          cases: scopedData.handoffs
            .filter(
              (h) =>
                h.companyId === operator.companyId &&
                h.chatbotId === operator.chatbotId &&
                (h.provider || h.scope.split(':')[1]) === operator.provider,
            )
            .map((h) => ({
              ...h,
              context: {
                ...h.context,
                ticket: provider(store, {
                  companyId: operator.companyId,
                  provider: operator.provider,
                  chatbotId: operator.chatbotId,
                  id: h.customerId,
                }).ticket(h.ticketId),
              },
              attempts: troubleshooting.attempts({...operator,id:h.customerId},{id:h.ticketId}),
              timeline: followThrough.timeline(operator.companyId, operator.chatbotId, h.ticketId),
              conversation: scopedData.conversations
                .filter((c) => c.scope === h.scope && c.ticketId === h.ticketId && !c.archivedAt)
                .slice(-50),
            })),
          resolutions: learning.list(operator.companyId, operator.provider, operator.chatbotId),
          // Every customer request stays visible to the company team even before escalation.
          requests: (() => {
            const open = new Set(scopedData.handoffs.filter((h) => h.companyId === operator.companyId && h.chatbotId === operator.chatbotId && !['Resolved', 'Closed'].includes(h.status)).map((h) => h.ticketId));
            return scopedData[operator.provider]
              .filter((r) => r.companyId === operator.companyId && r.chatbotId === operator.chatbotId)
              .map((r) => ({ r, ticketId: r.ticket_id || r.id, customerId: r.customer_id || r.user_id }))
              .filter(({ r, ticketId }) => !open.has(ticketId) && !['Resolved'].includes(r.status || r.state))
              .sort((a, b) => String(b.r.createdAt || '').localeCompare(String(a.r.createdAt || '')))
              .slice(0, 100)
              .map(({ r, ticketId, customerId }) => ({
                ticketId,
                title: r.device || r.problem,
                issue: r.issue || r.details,
                status: r.status || r.state,
                createdAt: r.createdAt || null,
                customer: store.db.prepare('SELECT name FROM accounts WHERE id=?').get(customerId)?.name || 'Customer',
                attempts: store.db.prepare('SELECT source,sequence,outcome FROM troubleshooting_attempts WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=? ORDER BY created_at').all(operator.companyId, operator.chatbotId, customerId, ticketId),
                timeline: followThrough.timeline(operator.companyId, operator.chatbotId, ticketId),
              }));
          })(),
          passports: memoryPool.list(operator.companyId, operator.chatbotId),
          followThrough: followThrough.queue(operator.companyId, [operator.chatbotId]),
        });
      if (endpoint === 'POST /api/operator/preview-passport') {
        // Server-side scrub + C_init preview; nothing is stored.
        const body = await json(req);
        return write(200, learning.preview(operator, body));
      }
      if (endpoint === 'POST /api/operator/revise') {
        const body = await json(req);
        const result = memoryPool.revise(operator, field(body.id, 'resolution ID', 100), body);
        store.update((data) => data.audit.push({ id: randomUUID(), scope: `company:${operator.companyId}`, kind: 'resolution_revised', resolutionId: body.id, newVersionId: result.id, version: result.version, authorId: operator.id, createdAt: new Date().toISOString() }));
        return write(201, result);
      }
      if (
        ['POST /api/operator/resolve', 'POST /api/operator/assign', 'POST /api/operator/progress'].includes(
          endpoint,
        )
      ) {
        const body = await json(req),
          op = submission(req, body, endpoint),
          method = endpoint.split('/').at(-1);
        if (method === 'progress')
          return write(
            200,
            store.db
              .transaction(() => {
                const result = learning.progress(operator, body, op);
                const h = store.dataFor(operator.companyId).handoffs.find(
                  (h) => h.id === body.handoffId && h.companyId === operator.companyId,
                );
                result.providerDelivery = providerActions.enqueue(
                  { id: h.customerId, companyId: operator.companyId, provider: operator.provider },
                  'progress',
                  h.id + ':' + result.revision,
                  h.ticketId,
                  { status: body.status, eta: body.eta, note: body.note },
                );
                return result;
              })
              .immediate(),
          );
        return write(method === 'resolve' ? 201 : 200, await learning[method](operator, body, op));
      }
      if (endpoint === 'POST /api/operator/flag')
        return write(200, learning.flag(operator, await json(req)));
      if (endpoint === 'POST /api/operator/retire')
        return write(200, await learning.retire(operator, await json(req)));
      if (endpoint === 'POST /api/operator/review-resolution') {
        const body = await json(req),
          result = reuse.review(operator, body);
        if (result.retired) await learning.retire(operator, { id: body.id, confirmed: true });
        return write(200, result);
      }
    }

  };
}
