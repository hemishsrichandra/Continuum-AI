import { botId, getBot } from './chatbots.js';
import {customerAdvice} from './customer-advice.js';
import { createTroubleshooting } from './troubleshooting.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Store, fault, profiles, provider } from './providers.js';
import { compose, createMemory } from './memory.js';
import { field, flags, json, submission, summary, appointment } from './requests.js';
import { createLearning } from './learning.js';
import { createAuth } from './auth.js';
import { createIntegrations } from './integrations.js';
import { demoSlots, reserveDemo, manageDemo, timeZone } from './scheduling.js';
import { createCompanies } from './companies.js';
import { extractFacts, preferenceTicket } from './facts.js';
import { safeHistory, modelTicket } from './context.js';
import { createConnector } from './connector.js';
import { createReuse, needsReview } from './reuse.js';
import { decide } from './decisions.js';
import { createProviderActions } from './provider-actions.js';
import { requestReference } from './request-reference.js';

export function createHandler({ file, config = process.env, service } = {}) {
  config = { APP_URL: 'http://localhost:3000', ...config };
  const appUrl = new URL(config.APP_URL);
  if (
    !['http:', 'https:'].includes(appUrl.protocol) ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== '/' ||
    (config.NODE_ENV === 'production' && appUrl.protocol !== 'https:')
  )
    throw new Error('APP_URL must be a site origin; production requires HTTPS.');
  config.APP_URL = appUrl.origin;
  const store = new Store(file);
  const delivery = createIntegrations(store, config);
  const companies = createCompanies(store, config);
  const connector = createConnector(store, delivery, config);
  const auth = createAuth(store, config, delivery, companies);
  if (config.ENABLE_OUTBOX_WORKER === 'true') delivery.start();
  const memory = service || createMemory(store, config);
  const providerActions = createProviderActions(store, delivery, config);
  const reuse = createReuse(store, memory, providerActions);
  const learning = createLearning(store, memory, companies, config, reuse, providerActions);
  const troubleshooting = createTroubleshooting(store, learning, reuse, providerActions);
  if (config.ENABLE_OUTBOX_WORKER === 'true') providerActions.start();
  if (config.ENABLE_OUTBOX_WORKER === 'true') memory.start?.();
  const pending = new Map();
  const limit = (key, count) => auth.rate(key, count);
  async function once(scope, operation, work) {
    const cached = store.operation(scope, operation.key, operation.fingerprint);
    if (cached) return cached;
    if (!operation.key) return work();
    const key = scope + ':' + operation.key;
    const inflight = pending.get(key);
    if (inflight) {
      if (inflight.fingerprint !== operation.fingerprint)
        throw fault(409, 'This submission is already processing different details.');
      return inflight.promise;
    }
    const promise = Promise.resolve().then(
      () => store.operation(scope, operation.key, operation.fingerprint) || work(),
    );
    pending.set(key, { fingerprint: operation.fingerprint, promise });
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  }
  async function retain(item) {
    try {
      return await memory.remember(item);
    } catch (error) {
      console.warn('Memory retention deferred:', error.message);
      return 'pending';
    }
  }
  const handler = async (req, res) => {
    const requestId = randomUUID();
    const write = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-ID': requestId,
        ...headers,
        ...(data.retryAfter && { 'Retry-After': String(data.retryAfter) }),
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const endpoint = req.method + ' ' + url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site')
          throw fault(403, 'Cross-site submissions are not allowed.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          throw fault(403, 'Submit this request from the app.');
      }
      const session = auth.authenticate(req);
      auth.csrf(req, session);
      if (await auth.handle(req, endpoint, write, session)) return;
      if (endpoint === 'GET /api/health')
        return write(200, {
          status: 'ok',
          version: '3.0.0',
          storage: 'sqlite',
          mode: auth.demoEnabled ? 'demo' : 'standard',
        });
      if (endpoint === 'GET /api/profiles')
        return write(200, { profiles: auth.demoEnabled ? profiles : [], demo: auth.demoEnabled });
      if (endpoint === 'GET /api/demo-slots')
        return write(200, {
          slots: await delivery.available(session?.account_id, demoSlots(store)),
          timeZone,
          emailConfigured: delivery.emailConfigured,
        });
      if (endpoint === 'POST /api/demo-bookings/manage') {
        limit('manage:' + req.socket.remoteAddress, 40);
        const body = await json(req);
        flags(body, ['cancel', 'confirmed']);
        return write(
          200,
          store.db
            .transaction(() => {
              const result = manageDemo(store, {
                ...body,
                id: field(body.id, 'reservation ID', 100),
                manageToken: field(body.manageToken, 'reservation token', 100),
              });
              if (body.cancel) {
                const booking = store.data.demoBookings.find((b) => b.id === result.id);
                const owner = booking.accountId
                  ? store.db.prepare('SELECT * FROM accounts WHERE id=?').get(booking.accountId)
                  : null;
                delivery.queueBooking(owner, booking, true, 'session');
              }
              const emailJob = store.data.outbox.find(
                (j) =>
                  j.id === `session-${result.id}-${result.status === 'Cancelled' ? 'cancel' : 'book'}-email`,
              );
              return { ...result, emailDelivery: emailJob?.status || 'not_configured' };
            })
            .immediate(),
        );
      }
      if (endpoint === 'POST /api/demo-bookings') {
        limit('booking:' + req.socket.remoteAddress, 12);
        const body = await json(req);
        flags(body);
        if (body.confirmed !== true) throw fault(400, 'Confirm the reservation before submitting.');
        const email = field(body.email, 'email', 200).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fault(400, 'Enter a valid email address.');
        const plan = field(body.plan, 'plan', 40);
        if (!['Starter', 'Growth', 'Enterprise', 'Just exploring'].includes(plan))
          throw fault(400, 'Choose a valid plan.');
        const data = {
          accountId: session?.account_id || null,
          name: field(body.name, 'name', 100),
          email,
          plan,
          datetime: appointment(body.datetime),
          notes: body.notes ? field(body.notes, 'notes', 500) : '',
        };
        const operation = submission(req, body, endpoint);
        return write(
          201,
          await once('demo-booking', operation, async () => {
            if (!(await delivery.available(session?.account_id, [{ id: data.datetime }])).length)
              throw fault(409, 'Your calendar is busy at that time.');
            return store.db
              .transaction(() => {
                const result = reserveDemo(store, data, operation);
                const saved = store.data.demoBookings.find((b) => b.id === result.id);
                delivery.queueBooking(session?.account || null, saved, false, 'session');
                const response = {
                  ...result,
                  emailDelivery: delivery.emailConfigured ? 'queued' : 'not_configured',
                };
                if (operation.key)
                  store.update((data) => {
                    data.operations.find(
                      (o) => o.scope === 'demo-booking' && o.key === operation.key,
                    ).response = response;
                  });
                return response;
              })
              .immediate();
          }),
        );
      }
      if (!session) throw fault(401, 'Sign in to your Continuum account to continue.');
      limit(session.token_hash, 120);
      const { profile } = session;
      const selectedBot = getBot(store.db, profile.companyId, botId(profile));
      if (!selectedBot.active && !(profile.role === 'owner' && url.pathname.startsWith('/api/company')))
        throw fault(403, 'This service is inactive. Select another workspace.');
      if (req.headers['x-workspace'] && req.headers['x-workspace'] !== profile.companyId + '|' + botId(profile))
        throw fault(409, 'Your workspace changed. Reload before submitting.');
      const customerRoutes = new Set([
        '/api/workspace', '/api/status', '/api/analytics', '/api/conversation',
        '/api/conversation/archive', '/api/feedback', '/api/slots', '/api/memory',
        '/api/reflect', '/api/chat', '/api/request', '/api/requirement', '/api/book',
        '/api/cancel', '/api/book/cancel', '/api/handoff', '/api/outcome', '/api/resolutions/confirm',
        '/api/resolutions/outcome', '/api/connector/sync', '/api/troubleshooting/outcome',
      ]);
      if (['owner', 'staff'].includes(profile.role) && customerRoutes.has(url.pathname))
        throw fault(403, 'Customer accounts handle personal requests and confirmations. Use the company dashboard or specialist console.');
      if (endpoint.includes('/connector')) {
        limit(session.token_hash + ':connector', 10);
        if (await connector.handle(req, endpoint, session, write)) return;
      }
      if (await companies.handle(req, endpoint, session, write)) return;
      const staff = companies.staff(profile);
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
        if (!operatorBot.active || (staff.role !== 'owner' && operatorBot.adapter !== staff.provider))
          throw fault(403,'This service queue is not available to your membership.');
        const operator = { ...staff, provider: operatorBot.adapter, chatbotId: operatorBot.id };
        if (endpoint === 'GET /api/operator')
          return write(200, {
            chatbot: operatorBot,
            companyId: operator.companyId,
            provider: operator.provider,
            self: operator.id,
            role: operator.role,
            staff: companies.roster(operator),
            cases: store.data.handoffs
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
                conversation: store.data.conversations
                  .filter((c) => c.scope === h.scope && c.ticketId === h.ticketId && !c.archivedAt)
                  .slice(-50),
              })),
            resolutions: learning.list(operator.companyId, operator.provider, operator.chatbotId),
          });
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
                  const h = store.data.handoffs.find(
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
        if (endpoint === 'POST /api/operator/retire')
          return write(200, await learning.retire(operator, await json(req)));
        if (endpoint === 'POST /api/operator/review-resolution') {
          const body = await json(req),
            result = reuse.review(operator, body);
          if (result.retired) await learning.retire(operator, { id: body.id, confirmed: true });
          return write(200, result);
        }
      }

      const db = provider(store, profile);
      profile.ticketId ||= db.list()[0]?.id || null;
      if (await delivery.handle(req, endpoint, session, auth, write)) return;
      const requested = url.searchParams.get('ticketId') || profile.ticketId;
      const integration = {
        hindsight: memory.configured,
        model: Boolean(config.OPENAI_API_KEY),
        mode: profile.demo ? 'demo' : 'standard',
      };
      if (endpoint === 'POST /api/resolutions/confirm')
        return write(200, await learning.confirm(profile, await json(req)));
      if (endpoint === 'POST /api/troubleshooting/outcome')
        return write(200, await troubleshooting.feedback(profile, await json(req)));
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
      if (endpoint === 'GET /api/status') return write(200, { ...db.ticket(requested), ticketId: requested });
      if (endpoint === 'GET /api/analytics') return write(200, summary(store, db));
      if (endpoint === 'GET /api/conversation') {
        db.ticket(requested);
        return write(200, {
          messages: store.data.conversations
            .filter((c) => c.scope === db.scope && c.ticketId === requested && !c.archivedAt)
            .slice(-100)
            .map(({ scope, ...c }) => ({
              ...c,
              response: {
                ...c.response,
                ...(!c.response.human && c.response.evidence?.some(e=>e.kind==='verified_resolution') && {reply:customerAdvice(c.response.reply)}),
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
              return store.update((data) => {
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
            const ledger = store.data.memories.filter(
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
              const saved = store.data.memories.find(m => m.id === f.id);
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
                const r = store.data.resolutions.find((r) => r.id === f.resolutionId);
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
      const actionRoutes = {
        '/api/request': 'request',
        '/api/requirement': 'requirement',
        '/api/book': 'book',
        '/api/book/cancel': 'cancel',
        '/api/handoff': 'handoff',
        '/api/outcome': 'outcome',
      };
      const kind = actionRoutes[url.pathname];
      if (req.method === 'POST' && kind) {
        if (!selectedBot.allowedActions.includes(kind)) throw fault(403,'This service does not permit that action.');
        const body = await json(req);
        flags(body);
        if (body.confirmed !== true)
          throw fault(400, 'Review the details and explicitly confirm before submitting.');
        const ticketId = kind === 'request' ? undefined : db.ticket(body.ticketId).id;
        const operation = submission(req, body, endpoint);
        return write(
          201,
          await once(db.scope, operation, async () => {
            let data;
            if (kind === 'request')
              data = {
                title: field(body.title, 'title', 100),
                issueDesc: field(body.issueDesc, 'description'),
              };
            if (kind === 'requirement') data = { note: field(body.note, 'note') };
            if (kind === 'book') data = { datetime: appointment(body.datetime) };
            if (kind === 'cancel') data = { id: field(body.id, 'appointment ID', 100) };
            if (kind === 'handoff')
              data = {
                summary: field(body.summary, 'handoff summary', 1400),
                context: {
                  ticket: db.ticket(ticketId),
                  history: db
                    .history()
                    .filter((item) => item.ticketId === ticketId)
                    .slice(0, 10)
                    .map(({ kind, createdAt }) => ({ kind, createdAt })),
                  memories:
                    body.memory === false
                      ? []
                      : memory
                          .list(db.scope, ticketId)
                          .filter((item) => !item.invalidatedAt)
                          .slice(0, 8),
                  conversation: store.data.conversations
                    .filter((c) => c.scope === db.scope && c.ticketId === ticketId && !c.archivedAt)
                    .slice(-50)
                    .map((c) => ({ question: c.message, answer: c.response.reply, createdAt: c.createdAt })),
                },
              };
            if (kind === 'outcome') {
              if(troubleshooting.attempts(profile,{id:ticketId}).some(a=>a.outcome==='pending'))
                throw fault(409,'Use It worked or Still need help on the pending fix so its outcome is recorded correctly.');
              if (db.ticket(ticketId).handoffs.some((h) => h.status === 'Awaiting confirmation'))
                throw fault(409, 'Confirm or reject the pending specialist solution before recording another outcome.');
              const outcome = field(body.outcome, 'outcome', 20);
              if (!['failed', 'resolved', 'missed'].includes(outcome))
                throw fault(400, 'Select a valid outcome.');
              data = { outcome, note: field(body.note, 'outcome details') };
            }
            if (body.proposalId) {
              const proposalId = field(body.proposalId, 'proposal ID', 100);
              const exchange = store.data.conversations.find(
                (c) => c.scope === db.scope && c.id === proposalId,
              );
              if (
                !exchange ||
                exchange.ticketId !== db.ticket(body.ticketId).id ||
                exchange.response.action?.kind !== kind
              )
                throw fault(404, 'This proposed action was not found for this request.');
              if (exchange.response.action.completedAt)
                throw fault(409, 'This proposed action has already been confirmed.');
              if (
                exchange.response.action.failedUseId &&
                exchange.response.action.failedUseId !== body.failedUseId
              )
                throw fault(400, 'Confirm the failed recommendation shown in this proposal.');
              operation.proposalId = proposalId;
            }
            if (kind === 'handoff' && body.failedUseId) {
              const attempt=store.db.prepare('SELECT id FROM troubleshooting_attempts WHERE use_id=? AND company_id=? AND chatbot_id=? AND customer_id=?').get(body.failedUseId,profile.companyId,botId(profile),profile.id);
              const feedback = {
                useId: body.failedUseId,
                ticketId,
                worked: false,
                confirmed: true,
                note: data.summary,
                memory: body.memory,
              };
              const reviewed = attempt ? await troubleshooting.feedback(profile,{...feedback,attemptId:attempt.id}) : await reuse.feedback(profile,feedback);
              const saved = {
                success: true,
                id: reviewed.handoffId,
                ticketId,
                createdAt: new Date().toISOString(),
              };
              return store.update((data) => {
                if (operation.proposalId) {
                  const c = data.conversations.find(
                    (c) => c.id === operation.proposalId && c.scope === db.scope,
                  );
                  c.response.action.completedAt = saved.createdAt;
                  c.response.action.resultId = saved.id;
                }
                if (operation.key) data.operations.push({ scope: db.scope, ...operation, response: saved });
                return saved;
              });
            }
            if (
              kind === 'book' &&
              !(await delivery.available(session.account_id, [{ id: data.datetime }])).length
            )
              throw fault(409, 'Your calendar is busy at that time. Choose another slot.');
            const result = store.db
              .transaction(() => {
                const saved = db.commit(kind, data, ticketId, operation);
                if (kind === 'book' || kind === 'cancel') {
                  const booking = store.data.bookings.find(
                    (b) => b.id === (kind === 'cancel' ? saved.bookingId : saved.id),
                  );
                  delivery.queueBooking(session.account, booking, kind === 'cancel');
                }
                const providerDelivery = providerActions.enqueue(
                  profile,
                  kind,
                  saved.id,
                  saved.ticketId,
                  data,
                );
                return { ...saved, providerDelivery };
              })
              .immediate();
            const text = {
              request: 'A service request was opened: ' + data.title + '.',
              requirement: 'A confirmed requirement was added: ' + data.note,
              book:
                kind === 'book'
                  ? 'A visit was booked for ' +
                    new Intl.DateTimeFormat('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone,
                    }).format(new Date(data.datetime)) +
                    ' IST.'
                  : '',
              cancel:
                kind === 'cancel'
                  ? 'The visit on ' +
                    new Intl.DateTimeFormat('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone,
                    }).format(new Date(result.datetime)) +
                    ' IST was cancelled.'
                  : '',
              handoff: 'A human handoff was queued under ' + result.id + '.',
              outcome: data.note,
            }[kind];
            const retained =
              body.memory === false
                ? null
                : await retain({
                    id: 'action-' + result.id,
                    scope: db.scope,
                    ticketId: result.ticketId,
                    kind:
                      kind === 'outcome'
                        ? data.outcome
                        : kind === 'requirement' && /call|prefer|email|notify/i.test(data.note)
                          ? 'preference'
                          : 'action',
                    text,
                    createdAt: result.createdAt,
                  });
            const response = {
              success: true,
              ...result,
              retained,
              ...(kind === 'book' && { confirmedAt: result.createdAt }),
            };
            if (operation.key)
              store.update((data) => {
                data.operations.find((o) => o.scope === db.scope && o.key === operation.key).response =
                  response;
              });
            return response;
          }),
        );
      }
      throw fault(404, 'API route not found.');
    } catch (e) {
      if (!e.status) console.error('Request failed', requestId, e.message);
      if (!res.headersSent)
        write(e.status || 500, {
          error: e.status ? e.message : 'We couldn’t complete that request. Please try again.',
          code:
            e.status === 409
              ? 'CONFLICT'
              : e.status === 429
                ? 'RATE_LIMITED'
                : e.status === 401
                  ? 'SESSION_EXPIRED'
                  : 'REQUEST_FAILED',
          requestId,
          ...(e.retryAfter && { retryAfter: e.retryAfter }),
        });
    }
  };
  handler.store = store;
  handler.delivery = delivery;
  handler.providerActions = providerActions;
  handler.close = () => {
    memory.close?.();
    providerActions.close();
    delivery.close();
    store.close();
  };
  return handler;
}
export function createApi(options) {
  const handler = createHandler(options);
  const server = createServer(handler);
  server.on('close', handler.close);
  return server;
}
