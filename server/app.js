import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Store, fault, profiles, provider } from './providers.js';
import { compose, createMemory } from './memory.js';
import { field, flags, json, submission, summary, appointment } from './requests.js';
import { createLearning } from './learning.js';
import { createAuth } from './auth.js';
import { createIntegrations } from './integrations.js';
import { demoSlots, reserveDemo, manageDemo, timeZone } from './scheduling.js';

const day = 86400000;
function proposed(message, ticket, facts) {
  const recovery = facts.some((f) => f.kind === 'missed' || f.kind === 'failed') &&
    /still|again|missed|delay|failed|offline|vpn|try|troubleshoot/i.test(message);
  const note = message.match(/^(?:add (?:a )?note|note|requirement)\s*:\s*(.+)/is)?.[1];
  const request = message.match(/^(?:new request|open (?:a )?ticket)\s*:\s*(.+)/is)?.[1];
  const handoff = recovery || /escalat|human|manager|technician take over/i.test(message);
  if (note) return { kind: 'requirement', ticketId: ticket.id, note };
  if (request) return { kind: 'request', title: request.slice(0, 70), issueDesc: request };
  if (/\b(?:book|schedule)\b.*\b(?:appointment|slot|visit)\b/i.test(message)) return { kind: 'book', ticketId: ticket.id };
  if (handoff) return { kind: 'handoff', ticketId: ticket.id, summary: message };
  return null;
}

export function createHandler({ file, config = process.env, service } = {}) {
  config = { APP_URL: 'http://localhost:3000', ...config };
  const appUrl = new URL(config.APP_URL);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/' || config.NODE_ENV === 'production' && appUrl.protocol !== 'https:') throw new Error('APP_URL must be a site origin; production requires HTTPS.');
  config.APP_URL = appUrl.origin;
  const store = new Store(file);
  const delivery = createIntegrations(store, config);
  const auth = createAuth(store, config, delivery);
  if (config.ENABLE_OUTBOX_WORKER === 'true') delivery.start();
  const memory = service || createMemory(store, config);
  const learning = createLearning(store, memory);
  const pending = new Map();
  const limit = (key, count) => auth.rate(key, count);
  async function once(scope, operation, work) {
    const cached = store.operation(scope, operation.key, operation.fingerprint);
    if (cached) return cached;
    if (!operation.key) return work();
    const key = scope + ':' + operation.key;
    const inflight = pending.get(key);
    if (inflight) {
      if (inflight.fingerprint !== operation.fingerprint) throw fault(409, 'This submission is already processing different details.');
      return inflight.promise;
    }
    const promise = Promise.resolve().then(() => store.operation(scope, operation.key, operation.fingerprint) || work());
    pending.set(key, { fingerprint: operation.fingerprint, promise });
    try { return await promise; } finally { pending.delete(key); }
  }
  async function retain(item) {
    try { return await memory.remember(item); }
    catch (error) { console.warn('Memory retention deferred:', error.message); return 'pending'; }
  }
  const handler = async (req, res) => {
    const requestId = randomUUID();
    const write = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId,
        ...headers,
        ...(data.retryAfter && { 'Retry-After': String(data.retryAfter) }),
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const endpoint = req.method + ' ' + url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fault(403, 'Cross-site submissions are not allowed.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fault(403, 'Submit this request from the app.');
      }
      const session = auth.authenticate(req);
      auth.csrf(req, session);
      if (await auth.handle(req, endpoint, write, session)) return;
      if (endpoint === 'GET /api/health') return write(200, { status: 'ok', version: '3.0.0', storage: 'sqlite', mode: auth.demoEnabled ? 'demo' : 'standard' });
      if (endpoint === 'GET /api/profiles') return write(200, { profiles: auth.demoEnabled ? profiles : [], demo: auth.demoEnabled });
      if (endpoint === 'GET /api/demo-slots') return write(200, { slots: await delivery.available(session?.account_id, demoSlots(store)), timeZone, emailConfigured: delivery.emailConfigured });
      if (endpoint === 'POST /api/demo-bookings/manage') {
        limit('manage:' + req.socket.remoteAddress, 40);
        const body = await json(req); flags(body, ['cancel', 'confirmed']);
        return write(200, store.db.transaction(() => {
          const result = manageDemo(store, { ...body, id: field(body.id, 'reservation ID', 100), manageToken: field(body.manageToken, 'reservation token', 100) });
          if (body.cancel) {
            const booking = store.data.demoBookings.find((b) => b.id === result.id);
            const owner = booking.accountId ? store.db.prepare('SELECT * FROM accounts WHERE id=?').get(booking.accountId) : null;
            delivery.queueBooking(owner, booking, true, 'session');
          }
          const emailJob = store.data.outbox.find((j) => j.id === `session-${result.id}-${result.status === 'Cancelled' ? 'cancel' : 'book'}-email`);
          return { ...result, emailDelivery: emailJob?.status || 'not_configured' };
        }).immediate());
      }
      if (endpoint === 'POST /api/demo-bookings') {
        limit('booking:' + req.socket.remoteAddress, 12);
        const body = await json(req); flags(body);
        if (body.confirmed !== true) throw fault(400, 'Confirm the reservation before submitting.');
        const email = field(body.email, 'email', 200).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fault(400, 'Enter a valid email address.');
        const plan = field(body.plan, 'plan', 40);
        if (!['Starter', 'Growth', 'Enterprise', 'Just exploring'].includes(plan)) throw fault(400, 'Choose a valid plan.');
        const data = { accountId: session?.account_id || null, name: field(body.name, 'name', 100), email, plan, datetime: appointment(body.datetime), notes: body.notes ? field(body.notes, 'notes', 500) : '' };
        const operation = submission(req, body, endpoint);
        return write(201, await once('demo-booking', operation, async () => {
          if (!(await delivery.available(session?.account_id, [{ id: data.datetime }])).length) throw fault(409, 'Your calendar is busy at that time.');
          return store.db.transaction(() => {
          const result = reserveDemo(store, data, operation);
          const saved = store.data.demoBookings.find((b) => b.id === result.id);
          delivery.queueBooking(session?.account || null, saved, false, 'session');
          const response = { ...result, emailDelivery: delivery.emailConfigured ? 'queued' : 'not_configured' };
          if (operation.key) store.update((data) => { data.operations.find((o) => o.scope === 'demo-booking' && o.key === operation.key).response = response; });
          return response;
        }).immediate(); }));
      }
      if (!session) throw fault(401, 'Sign in to your Continuum account to continue.');
      limit(session.token_hash, 120);
      const { profile } = session;
      const staff = session.account_id && store.db.prepare('SELECT provider FROM staff_access WHERE account_id=?').get(session.account_id);
      if (url.pathname.startsWith('/api/operator')) {
        if (!staff) throw fault(403, 'This area requires explicitly provisioned support staff access.');
        const operator = { id: session.account_id, provider: staff.provider };
        if (endpoint === 'GET /api/operator') return write(200, { provider: staff.provider, cases: store.data.handoffs.filter((h) => h.scope.startsWith(staff.provider + ':')), resolutions: learning.list(staff.provider) });
        if (endpoint === 'POST /api/operator/resolve') return write(201, await learning.resolve(operator, await json(req)));
        if (endpoint === 'POST /api/operator/retire') return write(200, await learning.retire(operator, await json(req)));
      }

      const db = provider(store, profile);
      profile.ticketId ||= db.list()[0]?.id || null;
      if (await delivery.handle(req, endpoint, session, auth, write)) return;
      const requested = url.searchParams.get('ticketId') || profile.ticketId;
      const integration = { hindsight: memory.configured, model: Boolean(config.OPENAI_API_KEY), mode: profile.demo ? 'demo' : 'standard' };
      if (endpoint === 'GET /api/workspace') return write(200, { profile, tickets: db.list(), activity: db.history(), integration, staff: Boolean(staff), metrics: summary(store, db) });
      if (endpoint === 'GET /api/status') return write(200, { ...db.ticket(requested), ticketId: requested });
      if (endpoint === 'GET /api/analytics') return write(200, summary(store, db));
      if (endpoint === 'GET /api/conversation') {
        db.ticket(requested);
        return write(200, { messages: store.data.conversations.filter((c) => c.scope === db.scope && c.ticketId === requested && !c.archivedAt).slice(-100).map(({ scope, ...c }) => c) });
      }
      if (endpoint === 'POST /api/conversation/archive') {
        const body = await json(req); flags(body);
        if (body.confirmed !== true) throw fault(400, 'Confirm before starting a fresh conversation.');
        const ticketId = db.ticket(body.ticketId).id;
        store.update((data) => {
          for (const c of data.conversations) if (c.scope === db.scope && c.ticketId === ticketId && !c.archivedAt) c.archivedAt = new Date().toISOString();
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
        return write(200, { slots: await delivery.available(session.account_id, db.slots().filter((slot) => !from || slot.date >= from)), timeZone });
      }
      if (endpoint === 'GET /api/memory') {
        db.ticket(requested);
        const query = url.searchParams.get('query');
        return write(200, { ledger: memory.list(db.scope, requested), ...(query && await memory.recall(db.scope, requested, field(query, 'memory query', 500))) });
      }
      if (endpoint === 'POST /api/reflect') {
        limit(session.token_hash + ':ai', 20);
        const { ticketId } = await json(req);
        return write(200, await memory.reflect(db.scope, db.ticket(ticketId).id));
      }
      if (endpoint === 'PATCH /api/memory') {
        const { ticketId, id } = await json(req);
        return write(200, await memory.invalidate(db.scope, db.ticket(ticketId).id, field(id, 'memory ID', 120)));
      }
      if (endpoint === 'POST /api/chat') {
        const body = await json(req); flags(body);
        const ticket = db.ticket(body.ticketId);
        const message = field(body.message, 'message', 1400);
        const operation = submission(req, body, endpoint);
        return write(200, await once(db.scope, operation, async () => {
          limit(session.token_hash + ':ai', 20);
          const started = Date.now();
          const enabled = body.memory !== false;
          const recall = enabled ? await memory.recall(db.scope, ticket.id, message) : { source: 'Disabled', facts: [] };
          // A later resolution supersedes historical recovery signals.
          const lastResolved = recall.facts.findIndex((f) => f.kind === 'resolved');
          const facts = lastResolved >= 0 ? recall.facts.filter((f, i) => !['failed', 'missed'].includes(f.kind) || i < lastResolved) : recall.facts;
          const learned = enabled ? await learning.recall(profile.provider, message) : { source: 'Disabled', facts: [] };
          facts.push(...learned.facts);
          const action = ticket.status === 'Resolved' ? null : proposed(message, ticket, facts);
          const history = body.retain === false ? [] : store.data.conversations.filter((c) => c.scope === db.scope && c.ticketId === ticket.id && !c.archivedAt).slice(-4).map((c) => ({ question: c.message, answer: c.response.reply }));
          const response = await compose({ message, ticket, facts, kind: action?.kind, blocked: action?.kind === 'handoff', history }, config);
          let retained = null;
          if (enabled && body.retain !== false) {
            const preference = /(?:prefer|please|always|remember).*(?:call|email|text|contact|notify)/i.test(message);
            const failed = /(?:didn.t work|did not work|failed|didn.t fix)/i.test(message);
            const missed = /(?:missed|slipped).*(?:deadline|commitment|eta)|(?:deadline|commitment|eta).*(?:missed|slipped)/i.test(message);
            const kind = preference ? 'preference' : failed ? 'failed' : missed ? 'missed' : null;
            if (kind) retained = await retain({ id: randomUUID(), scope: db.scope, ticketId: ticket.id, kind, text: message, createdAt: new Date().toISOString() });
          }
          const id = randomUUID();
          const result = {
            ...response, id, ticket, action, retained,
            evidence: [{ id: ticket.id, type: 'provider', text: ticket.status }, ...facts.map((fact) => ({ id: fact.id, type: fact.kind === 'verified_resolution' ? learned.source : recall.source, text: fact.text, kind: fact.kind }))],
            trace: { knowledge: learned.source, learnedResolutions: learned.facts.length, memory: recall.source, recalled: facts.length, elapsedMs: Date.now() - started },
          };
          // Comparison requests never change history, analytics, or memory.
          if (body.retain !== false) return store.update((data) => {
            const existing = operation.key && data.operations.find((o) => o.scope === db.scope && o.key === operation.key);
            if (existing) { if (existing.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.'); return existing.response; }
            data.conversations.push({ id, scope: db.scope, ticketId: ticket.id, message, response: result, memory: enabled, createdAt: new Date().toISOString() });
            data.audit.push({ id, scope: db.scope, ticketId: ticket.id, kind: 'chat', createdAt: new Date().toISOString(), source: recall.source, model: response.model, elapsedMs: result.trace.elapsedMs });
            if (operation.key) data.operations.push({ scope: db.scope, ...operation, response: result });
            return result;
          });
          return result;
        }));
      }
      const actionRoutes = { '/api/request': 'request', '/api/requirement': 'requirement', '/api/book': 'book', '/api/book/cancel': 'cancel', '/api/handoff': 'handoff', '/api/outcome': 'outcome' };
      const kind = actionRoutes[url.pathname];
      if (req.method === 'POST' && kind) {
        const body = await json(req); flags(body);
        if (body.confirmed !== true) throw fault(400, 'Review the details and explicitly confirm before submitting.');
        const ticketId = kind === 'request' ? undefined : db.ticket(body.ticketId).id;
        const operation = submission(req, body, endpoint);
        return write(201, await once(db.scope, operation, async () => {
          let data;
          if (kind === 'request') data = { title: field(body.title, 'title', 100), issueDesc: field(body.issueDesc, 'description') };
          if (kind === 'requirement') data = { note: field(body.note, 'note') };
          if (kind === 'book') data = { datetime: appointment(body.datetime) };
          if (kind === 'cancel') data = { id: field(body.id, 'appointment ID', 100) };
          if (kind === 'handoff') data = { summary: field(body.summary, 'handoff summary', 1400), context: {
            ticket: db.ticket(ticketId),
            history: db.history().filter((item) => item.ticketId === ticketId).slice(0, 10).map(({ kind, createdAt }) => ({ kind, createdAt })),
            memories: body.memory === false ? [] : memory.list(db.scope, ticketId).filter((item) => !item.invalidatedAt).slice(0, 8),
          } };
          if (kind === 'outcome') {
            const outcome = field(body.outcome, 'outcome', 20);
            if (!['failed', 'resolved', 'missed'].includes(outcome)) throw fault(400, 'Select a valid outcome.');
            data = { outcome, note: field(body.note, 'outcome details') };
          }
          if (body.proposalId) {
            const proposalId = field(body.proposalId, 'proposal ID', 100);
            const exchange = store.data.conversations.find((c) => c.scope === db.scope && c.id === proposalId);
            if (!exchange || exchange.ticketId !== db.ticket(body.ticketId).id || exchange.response.action?.kind !== kind) throw fault(404, 'This proposed action was not found for this request.');
            if (exchange.response.action.completedAt) throw fault(409, 'This proposed action has already been confirmed.');
            operation.proposalId = proposalId;
          }
          if (kind === 'book' && !(await delivery.available(session.account_id, [{ id: data.datetime }])).length) throw fault(409, 'Your calendar is busy at that time. Choose another slot.');
          const result = store.db.transaction(() => {
            const saved = db.commit(kind, data, ticketId, operation);
            if (kind === 'book' || kind === 'cancel') {
              const booking = store.data.bookings.find((b) => b.id === (kind === 'cancel' ? saved.bookingId : saved.id));
              delivery.queueBooking(session.account, booking, kind === 'cancel');
            }
            return saved;
          }).immediate();
          const text = {
            request: 'A service request was opened: ' + data.title + '.',
            requirement: 'A confirmed requirement was added: ' + data.note,
            book: kind === 'book' ? 'A visit was booked for ' + new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(data.datetime)) + ' IST.' : '',
            cancel: kind === 'cancel' ? 'The visit on ' + new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(result.datetime)) + ' IST was cancelled.' : '',
            handoff: 'A human handoff was queued under ' + result.id + '.',
            outcome: data.note,
          }[kind];
          const retained = body.memory === false ? null : await retain({
            id: 'action-' + result.id, scope: db.scope, ticketId: result.ticketId,
            kind: kind === 'outcome' ? data.outcome : kind === 'requirement' && /call|prefer|email|notify/i.test(data.note) ? 'preference' : 'action',
            text, createdAt: result.createdAt,
          });
          const response = { success: true, ...result, retained, ...(kind === 'book' && { confirmedAt: result.createdAt }) };
          if (operation.key) store.update((data) => { data.operations.find((o) => o.scope === db.scope && o.key === operation.key).response = response; });
          return response;
        }));
      }
      throw fault(404, 'API route not found.');
    } catch (e) {
      if (!e.status) console.error('Request failed', requestId, e.message);
      if (!res.headersSent) write(e.status || 500, { error: e.status ? e.message : 'We couldn’t complete that request. Please try again.', code: e.status === 409 ? 'CONFLICT' : e.status === 429 ? 'RATE_LIMITED' : e.status === 401 ? 'SESSION_EXPIRED' : 'REQUEST_FAILED', requestId, ...(e.retryAfter && { retryAfter: e.retryAfter }) });
    }
  };
  handler.store = store;
  handler.delivery = delivery;
  handler.close = () => { delivery.close(); store.close(); };
  return handler;
}
export function createApi(options) {
  const handler = createHandler(options);
  const server = createServer(handler);
  server.on('close', handler.close);
  return server;
}
