import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Store, fault, profiles, provider } from './providers.js';
import { compose, createMemory } from './memory.js';

const day = 86400_000;
const write = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
function field(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fault(400, 'Enter a valid ' + name + ' (up to ' + max + ' characters).');
  return value.trim();
}
async function json(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fault(415, 'Send a JSON request.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16_384) throw fault(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw fault(400, 'The request body must be a JSON object.');
  }
}

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
  const store = new Store(file);
  const memory = service || createMemory(store, config);
  const sessions = new Map();
  const rate = new Map();
  const limit = (key, count) => {
    const now = Date.now();
    if (rate.size > 1000) for (const [k, v] of rate) if (v.until <= now) rate.delete(k);
    const previous = rate.get(key);
    const bucket = previous?.until > now ? previous : { until: now + 60_000, used: 0 };
    rate.set(key, bucket);
    if (++bucket.used > count) throw fault(429, 'Too many requests. Try again in a minute.');
  };
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const endpoint = req.method + ' ' + url.pathname;
      if (endpoint === 'GET /api/profiles') return write(res, 200, { profiles, demo: true });
      if (endpoint === 'POST /api/session') {
        limit('session:' + req.socket.remoteAddress, 60);
        const body = await json(req);
        const profile = profiles.find((p) => p.id === body.profileId);
        if (!profile || body.pin !== (config.DEMO_PIN || '246810')) throw fault(401, 'Choose a demo identity and enter its demo access code.');
        for (const [key, session] of sessions) if (session.until <= Date.now()) sessions.delete(key);
        const token = randomUUID();
        sessions.set(token, { profile, until: Date.now() + day });
        return write(res, 200, { token, profile });
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const session = sessions.get(token);
      if (!session || session.until <= Date.now()) throw fault(401, 'Verify a demo account to continue.');
      limit(token, 90);
      const { profile } = session;
      const db = provider(store, profile);
      const requested = url.searchParams.get('ticketId') || profile.ticketId;
      const integration = { hindsight: memory.configured, model: Boolean(config.OPENAI_API_KEY) };
      if (endpoint === 'GET /api/workspace') return write(res, 200, { profile, tickets: db.list(), activity: db.history(), integration });
      if (endpoint === 'GET /api/status') return write(res, 200, { ...db.ticket(requested), ticketId: requested });
      if (endpoint === 'GET /api/slots') {
        db.ticket(requested);
        const from = url.searchParams.get('from');
        return write(res, 200, { slots: db.slots().filter((slot) => !from || slot.date >= from), timeZone: 'Asia/Kolkata' });
      }
      if (endpoint === 'GET /api/memory') {
        db.ticket(requested);
        const query = url.searchParams.get('query');
        const ledger = memory.list(db.scope, requested);
        return write(res, 200, { ledger, ...(query && await memory.recall(db.scope, requested, field(query, 'memory query', 500))) });
      }
      if (endpoint === 'POST /api/reflect') {
        limit(token + ':ai', 15);
        const { ticketId } = await json(req);
        return write(res, 200, await memory.reflect(db.scope, db.ticket(ticketId).id));
      }
      if (endpoint === 'PATCH /api/memory') {
        const { ticketId, id } = await json(req);
        return write(res, 200, await memory.invalidate(db.scope, db.ticket(ticketId).id, field(id, 'memory ID', 120)));
      }
      if (endpoint === 'POST /api/chat') {
        limit(token + ':ai', 15);
        const body = await json(req);
        const ticket = db.ticket(body.ticketId);
        const message = field(body.message, 'message', 1400);
        const started = Date.now();
        const enabled = body.memory !== false;
        const recall = enabled ? await memory.recall(db.scope, ticket.id, message) : { source: 'Disabled', facts: [] };
        const action = proposed(message, ticket, recall.facts);
        const response = await compose({ message, ticket, facts: recall.facts, kind: action?.kind, blocked: action?.kind === 'handoff' }, config);
        let retained = null;
        if (enabled && body.retain !== false) {
          const preference = /(?:prefer|please|always|remember).*(?:call|email|text|contact|notify)/i.test(message);
          const failed = /(?:didn.t work|did not work|failed|didn.t fix)/i.test(message);
          const missed = /(?:missed|slipped).*(?:deadline|commitment|eta)|(?:deadline|commitment|eta).*(?:missed|slipped)/i.test(message);
          const kind = preference ? 'preference' : failed ? 'failed' : missed ? 'missed' : null;
          if (kind) retained = await memory.remember({ id: randomUUID(), scope: db.scope, ticketId: ticket.id, kind, text: message, createdAt: new Date().toISOString() });
          store.update((data) => data.audit.push({ id: randomUUID(), scope: db.scope, ticketId: ticket.id, kind: 'chat', createdAt: new Date().toISOString(), source: recall.source, model: response.model }));
        }
        return write(res, 200, {
          ...response, ticket, action, retained,
          evidence: [{ id: ticket.id, type: 'provider', text: ticket.status }, ...recall.facts.map((fact) => ({ id: fact.id, type: recall.source, text: fact.text, kind: fact.kind }))],
          trace: { memory: recall.source, recalled: recall.facts.length, elapsedMs: Date.now() - started },
        });
      }
      const actionRoutes = { '/api/request': 'request', '/api/requirement': 'requirement', '/api/book': 'book', '/api/handoff': 'handoff', '/api/outcome': 'outcome' };
      const kind = actionRoutes[url.pathname];
      if (req.method === 'POST' && kind) {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Review the details and explicitly confirm before submitting.');
        const ticketId = kind === 'request' ? undefined : db.ticket(body.ticketId).id;
        let data;
        if (kind === 'request') data = { title: field(body.title, 'title', 100), issueDesc: field(body.issueDesc, 'description') };
        if (kind === 'requirement') data = { note: field(body.note, 'note') };
        if (kind === 'book') data = { datetime: field(body.datetime, 'appointment time', 50) };
        if (kind === 'handoff') data = {
          summary: field(body.summary, 'handoff summary', 1400),
          context: { ticket: db.ticket(ticketId), history: db.history().filter((item) => item.ticketId === ticketId).slice(0, 5).map(({ kind, createdAt }) => ({ kind, createdAt })), memories: body.memory === false ? [] : memory.list(db.scope, ticketId).filter((item) => !item.invalidatedAt).slice(0, 5) },
        };
        if (kind === 'outcome') {
          const outcome = field(body.outcome, 'outcome', 20);
          if (!['failed', 'resolved', 'missed'].includes(outcome)) throw fault(400, 'Select a valid outcome.');
          const text = field(body.note, 'outcome details');
          if (body.memory === false) throw fault(400, 'Enable memory to retain a service outcome.');
          const id = randomUUID();
          const retained = await memory.remember({ id, scope: db.scope, ticketId, kind: outcome, text, createdAt: new Date().toISOString() });
          return write(res, 201, { success: true, ticketId, id, retained });
        }
        const result = db.commit(kind, data, ticketId);
        const actionText = {
          request: 'A service request was opened: ' + data.title + '.',
          requirement: 'A confirmed requirement was added: ' + data.note,
          book: 'The provider booked an appointment for ' + data.datetime + '.',
          handoff: 'A human handoff was queued under ' + result.id + '.',
        };
        let retained = null;
        if (body.memory !== false) retained = await memory.remember({
          id: randomUUID(), scope: db.scope, ticketId: result.ticketId,
          kind: kind === 'requirement' && /call|prefer|email|notify/i.test(data.note) ? 'preference' : 'action',
          text: actionText[kind], createdAt: result.createdAt,
        });
        return write(res, 201, { success: true, ...result, retained, ...(kind === 'book' && { confirmedAt: result.createdAt }) });
      }
      throw fault(404, 'API route not found.');
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) write(res, e.status || 500, { error: e.status ? e.message : 'Continuum could not complete that request.' });
    }
  };
}

export function createApi(options) {
  return createServer(createHandler(options));
}
