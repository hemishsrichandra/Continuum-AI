// Customer-side routes: confirmations, troubleshooting outcomes, workspace, privacy, conversation, memory and chat.
import { botId } from '../chatbots.js';
import { customerAdvice } from '../customer-advice.js';
import { randomUUID } from 'node:crypto';
import { fault, provider } from '../providers.js';
import { compose } from '../memory.js';
import { field, flags, json, submission, summary } from '../requests.js';
import { timeZone } from '../scheduling.js';
import { extractFacts, preferenceTicket } from '../facts.js';
import { safeHistory, modelTicket } from '../context.js';
import { needsReview } from '../reuse.js';
import { decide } from '../decisions.js';
import { requestReference } from '../request-reference.js';

export function createCustomerRoutes(services) {
  const { store, delivery, memory, providerActions, reuse, learning, troubleshooting, privacy, config, limit, once, retain } = services;
  return async function customerRoutes(context) {
    const { req, url, endpoint, session, profile, selectedBot, staff, write, db, requested, integration } = context;
    if (endpoint === 'POST /api/resolutions/confirm')
      return write(200, await learning.confirm(profile, await json(req)));
    if (endpoint === 'POST /api/resolutions/defer')
      return write(200, learning.defer(profile, await json(req)));
    if (endpoint === 'POST /api/troubleshooting/outcome')
      return write(200, await troubleshooting.feedback(profile, await json(req)));
    if (endpoint === 'POST /api/troubleshooting/choose') {
      const out = await troubleshooting.choose(profile, await json(req));
      const ticket = db.ticket(out.attempt.ticket_id);
      const at = new Date().toISOString();
      const response = { id: out.id, reply: out.reply, model: 'Company memory', ticket, action: null, decision: { mode: 'recommend', action: null }, evidence: out.evidence, learnedSource: out.learnedSource, alternatives: out.alternatives, attempt: out.attempt, resolutionUse: out.resolutionUse, retained: null, trace: { knowledge: 'Company memory', memory: 'Operational workflow', recalled: 1, learnedResolutions: 1, elapsedMs: 0 }, workflow: out.workflow };
      store.updateFor(profile.companyId, (data) => { data.conversations.push({ id: out.id, scope: db.scope, ticketId: ticket.id, message: 'I’ll try: ' + out.title, response, memory: true, createdAt: at }); });
      return write(200, { success: true, id: out.id });
    }
    if (endpoint === 'POST /api/resolutions/outcome') {
      const body = await json(req);
      body.allowHandoff=selectedBot.allowedActions.includes('handoff');
      const a = store.db.prepare('SELECT id FROM troubleshooting_attempts WHERE use_id=? AND company_id=? AND chatbot_id=? AND customer_id=?').get(body.useId,profile.companyId,botId(profile),profile.id);
      return write(200, a ? await troubleshooting.feedback(profile,{...body,attemptId:a.id}) : await reuse.feedback(profile,body));
    }
    if (endpoint === 'GET /api/workspace')
      return write(200, {
        profile,
        chatbot: selectedBot,
        tickets: db.list(),
        activity: db.history(),
        integration,
        staff: Boolean(staff),
        canSync: Boolean(
          session.account_id &&
          store.db
            .prepare(
              'SELECT 1 FROM provider_connections p JOIN external_customers e ON e.company_id=p.company_id WHERE e.account_id=? AND p.company_id=?',
            )
            .get(session.account_id, profile.companyId),
        ),
        metrics: summary(store, db),
        providerDeliveries: providerActions.list(profile),
      });
    if (endpoint === 'GET /api/privacy/export') return write(200, privacy.exportData(profile, db));
    if (endpoint === 'POST /api/privacy/erase') {
      const body = await json(req);
      return write(200, await privacy.erase(profile, db, { ticketId: body.ticketId === undefined ? undefined : field(body.ticketId, 'request ID', 100), confirmed: body.confirmed, retireSharedKnowledge: body.retireSharedKnowledge === true }));
    }
    if (endpoint === 'GET /api/status') return write(200, { ...db.ticket(requested), ticketId: requested });
    if (endpoint === 'GET /api/analytics') return write(200, summary(store, db));
    if (endpoint === 'GET /api/conversation') {
      db.ticket(requested);
      return write(200, {
        messages: store.dataFor(profile.companyId).conversations
          .filter((c) => c.scope === db.scope && c.ticketId === requested && !c.archivedAt)
          .slice(-100)
          .map(({ scope, ...c }) => ({
            ...c,
            response: {
              ...c.response,
              ...(!c.response.human && c.response.evidence?.some(e=>['verified_resolution','company_memory'].includes(e.kind)) && {reply:customerAdvice(c.response.reply)}),
              ...(c.response.attempt && {attempt: troubleshooting.attempts(profile,{id:requested}).find(a=>a.id===c.response.attempt.id)}),
              ...(c.response.resolutionUse && {
                resolutionUse: reuse.current(db.scope, c.response.resolutionUse.id),
              }),
            },
          })),
      });
    }
    if (endpoint === 'POST /api/conversation/archive') {
      const body = await json(req);
      flags(body);
      if (body.confirmed !== true) throw fault(400, 'Confirm before starting a fresh conversation.');
      const ticketId = db.ticket(body.ticketId).id;
      store.update((data) => {
        for (const c of data.conversations)
          if (c.scope === db.scope && c.ticketId === ticketId && !c.archivedAt)
            c.archivedAt = new Date().toISOString();
      });
      return write(200, { success: true });
    }
    if (endpoint === 'POST /api/feedback') {
      const body = await json(req);
      if (![1, 5].includes(body.rating)) throw fault(400, 'Choose helpful or needs improvement.');
      const id = field(body.id, 'message ID', 100);
      store.update((data) => {
        const exchange = data.conversations.find((c) => c.id === id && c.scope === db.scope);
        if (!exchange) throw fault(404, 'Conversation was not found in this account.');
        exchange.rating = body.rating;
      });
      return write(200, { success: true, rating: body.rating });
    }
    if (endpoint === 'GET /api/slots') {
      db.ticket(requested);
      const from = url.searchParams.get('from');
      if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw fault(400, 'Use a date in YYYY-MM-DD format.');
      return write(200, {
        slots: await delivery.available(
          session.account_id,
          db.slots().filter((slot) => !from || slot.date >= from),
        ),
        timeZone,
      });
    }
    if (endpoint === 'GET /api/memory') {
      db.ticket(requested);
      const query = url.searchParams.get('query');
      return write(200, {
        ledger: memory.list(db.scope, requested),
        ...(query && (await memory.recall(db.scope, requested, field(query, 'memory query', 500)))),
      });
    }
    if (endpoint === 'POST /api/reflect') {
      limit(session.token_hash + ':ai', 20);
      const { ticketId } = await json(req);
      return write(200, await memory.reflect(db.scope, db.ticket(ticketId).id, db.ticket(ticketId)));
    }
    if (endpoint === 'PATCH /api/memory') {
      const { ticketId, id } = await json(req);
      return write(
        200,
        await memory.invalidate(db.scope, db.ticket(ticketId).id, field(id, 'memory ID', 120)),
      );
    }
    if (endpoint === 'POST /api/chat') {
      const body = await json(req);
      flags(body);
      const ticket = db.ticket(body.ticketId);
      const message = field(body.message, 'message', 1400);
      const operation = submission(req, body, endpoint);
      return write(
        200,
        await once(db.scope, operation, async () => {
          limit(session.token_hash + ':ai', 20);
          const started = Date.now();
          const enabled = body.memory !== false;
          const statedFacts = extractFacts(message);
          const saveResponse = (result) => {
            if (body.retain === false) return result;
            return store.updateFor(profile.companyId, (data) => {
              const existing = operation.key && data.operations.find((o) => o.scope === db.scope && o.key === operation.key);
              if (existing) {
                if (existing.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.');
                return existing.response;
              }
              result.resolutionUse ||= reuse.record(profile, ticket, result, result.id, new Date().toISOString());
              data.conversations.push({id:result.id,scope:db.scope,ticketId:ticket.id,message,response:result,memory:enabled,createdAt:new Date().toISOString()});
              data.audit.push({id:result.id,scope:db.scope,ticketId:ticket.id,kind:'chat',createdAt:new Date().toISOString(),source:result.trace.memory,model:result.model,elapsedMs:result.trace.elapsedMs});
              if (operation.key) data.operations.push({scope:db.scope,...operation,response:result});
              return result;
            });
          };
          const reference = requestReference(message, db.list(), ticket.id);
          if (reference) return saveResponse({
            id:randomUUID(), reply:reference.question, model:'Request navigation', ticket,
            action:null, decision:{mode:'clarify',reason:'request_selection',action:null},
            requestChoices:reference.choices, evidence:[], retained:null,
            trace:{knowledge:'Disabled',memory:'Not recalled for request selection',recalled:0,learnedResolutions:0,elapsedMs:Date.now()-started},
          });
          const requestedDecision = await decide(
            { message, ticket, facts: [], learned: { facts: [] } },
            config,
          );
          if(requestedDecision.action?.kind==='handoff' && !selectedBot.allowedActions.includes('handoff'))
            return saveResponse({id:randomUUID(),reply:'For human support, '+selectedBot.escalationRules.supportRoute,model:'Support workflow',ticket,action:null,decision:{mode:'inform',action:null},evidence:[],retained:null,workflow:{stage:'support_route'},trace:{knowledge:'Disabled',memory:'Not recalled',recalled:0,learnedResolutions:0,elapsedMs:Date.now()-started}});
          const informational = /\b(?:password|api[ _-]?key|access[ _-]?token)\s*[:=]|\bsk-[\w-]+|\bgsk_[\w-]+/i.test(message) || statedFacts.some(f=>f.kind==='preference') || /\b(?:status|eta|progress|prefer|contact|remember|what (?:did|have)|why|explain)\b/i.test(message) && !/^(?:it worked|still need help)/i.test(message);
          const legacyFailureProposal = statedFacts.some(f=>f.kind==='failed') && troubleshooting.attempts(profile,ticket).some(a=>a.source==='learned' && a.outcome==='pending') && !/^(?:still need help|it (?:did not|didn't) work|that (?:did not|didn't) work|the fix failed|still not working)[.!\s]*$/i.test(message);
          const explicitAction = legacyFailureProposal || requestedDecision.mode === 'action' || requestedDecision.reason === 'customer_request';
          if (!explicitAction && !informational && !['clarify','inform'].includes(requestedDecision.mode)) {
            const result = await troubleshooting.process(profile,ticket,message,body.context,enabled,randomUUID(),body.retain === false);
            if (result.action && !selectedBot.allowedActions.includes(result.action.kind)) result.action=null;
            return saveResponse(result);
          }
          const reportedUse = extractFacts(message).some((f) => f.kind === 'failed')
            ? store.db
                .prepare(
                  "SELECT id FROM resolution_uses WHERE scope=? AND ticket_id=? AND status IN ('pending','succeeded') ORDER BY created_at DESC LIMIT 1",
                )
                .get(db.scope, ticket.id)
            : null;
          const direct =
            requestedDecision.mode === 'action' ||
            requestedDecision.reason === 'customer_request' ||
            ['clarify', 'waiting'].includes(requestedDecision.mode) ||
            Boolean(reportedUse);
          const recall = enabled
            ? direct
              ? {
                  source: 'Saved service history',
                  facts: memory.list(db.scope, ticket.id).filter((f) => !f.invalidatedAt),
                }
              : await memory.recall(db.scope, ticket.id, message)
            : { source: 'Disabled', facts: [] };
          // A later resolution supersedes historical recovery signals.
          const ledger = store.dataFor(profile.companyId).memories.filter(
            (m) => m.scope === db.scope && m.ticketId === ticket.id && !m.invalidatedAt,
          );
          const resolvedIndex = ledger.findLastIndex((m) => m.kind === 'resolved');
          const superseded = new Set(
            ledger
              .slice(0, resolvedIndex + 1)
              .filter((m) => ['failed', 'missed'].includes(m.kind))
              .map((m) => m.id),
          );
          const statedPreferences = statedFacts.filter(f => f.kind === 'preference');
          const facts = recall.facts.filter((f) => {
            if (superseded.has(f.id)) return false;
            const saved = store.dataFor(profile.companyId).memories.find(m => m.id === f.id);
            return !statedPreferences.some(p => f.kind === 'preference' &&
              (saved?.category || 'contact') === p.category);
          });
          // The latest instruction is part of this message even before it is
          // retained. Never answer with the preference it replaces.
          facts.unshift(...statedPreferences.map((f, i) => ({
            ...f, id:'current-message-' + i, source:'Current message',
          })));
          // Verified recommendations are only retrieved through the durable workflow above.
          const learned = { source: 'Disabled', facts: [] };
          facts.push(...learned.facts);
          const decision = direct ? requestedDecision : await decide({ message, ticket, facts, learned });
          const action = decision.action;
          if (action && !selectedBot.allowedActions.includes(action.kind)) throw fault(403,'This service does not permit that action.');
          if (reportedUse && action?.kind === 'handoff') action.failedUseId = reportedUse.id;
          const history = body.retain === false ? [] : safeHistory(store, db.scope, ticket.id, enabled, statedPreferences);
          const response = await compose(
            {
              message,
              ticket: modelTicket(ticket),
              facts,
              kind: action?.kind,
              blocked: action?.kind === 'handoff',
              history,
              clarification: learned.clarification,
              decision,
            },
            config,
          );
          if (
            learned.facts.some((f) => {
              const r = store.dataFor(profile.companyId).resolutions.find((r) => r.id === f.resolutionId);
              return !r || r.retiredAt || needsReview(r);
            })
          )
            throw fault(409, 'A referenced resolution was retired while answering. Please ask again.');
          let retained = null;
          if (enabled && body.retain !== false) {
            for (const fact of statedFacts)
              retained = await retain({
                id: randomUUID(),
                scope: db.scope,
                ticketId: fact.customerWide ? preferenceTicket : ticket.id,
                sourceTicketId: ticket.id,
                ...fact,
                createdAt: new Date().toISOString(),
              });
          }
          const id = randomUUID();
          const result = {
            ...response,
            id,
            ticket,
            action,
            retained,
            decision,
            evidence: [
              { id: ticket.id, type: 'provider', text: ticket.status },
              ...facts.map((fact) => ({
                id: fact.id,
                resolutionId: fact.resolutionId,
                type: fact.source || (fact.kind === 'verified_resolution' ? learned.source : recall.source),
                text: fact.text,
                kind: fact.kind,
              })),
            ],
            trace: {
              knowledge: learned.source,
              learnedResolutions: learned.facts.length,
              memory: recall.source,
              recalled: facts.length,
              elapsedMs: Date.now() - started,
            },
          };
          // Comparison requests never change history, analytics, or memory.
          return saveResponse(result);
        }),
      );
    }
  };
}
