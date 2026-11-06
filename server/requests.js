import { createHash } from 'node:crypto';
import { fault } from './providers.js';

export function field(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fault(400, 'Enter a valid ' + name + ' (up to ' + max + ' characters).');
  return value.trim();
}
export function flags(body, names = ['memory', 'retain', 'confirmed']) {
  for (const name of names) if (body[name] !== undefined && typeof body[name] !== 'boolean') throw fault(400, name + ' must be true or false.');
}
export async function json(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fault(415, 'Send a JSON request.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw fault(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw fault(400, 'The request body must be a JSON object.'); }
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export function submission(req, body, endpoint) {
  const raw = req.headers['idempotency-key'];
  const key = raw === undefined ? null : field(raw, 'submission key', 120);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ endpoint, body }))).digest('hex');
  return { key, fingerprint, memory: body.memory !== false, createdAt: new Date().toISOString() };
}
export function summary(store, db) {
  const tickets = db.list();
  const activity = store.data.audit.filter((a) => a.scope === db.scope);
  const exchanges = store.data.conversations.filter((c) => c.scope === db.scope);
  const feedback = exchanges.filter((c) => c.rating);
  const times = exchanges.map((c) => c.response.trace?.elapsedMs).filter(Number.isFinite);
  return {
    open: tickets.filter((t) => t.status !== 'Resolved').length,
    resolved: tickets.filter((t) => t.status === 'Resolved').length,
    overdue: tickets.filter((t) => t.status !== 'Resolved' && t.eta && new Date(t.eta + 'T23:59:59+05:30') < new Date()).length,
    appointments: store.data.bookings.filter((b) => b.scope === db.scope && !b.cancelledAt && new Date(b.datetime) > new Date()).length,
    actions: activity.filter((a) => !['chat', 'invalidate', 'feedback', 'archive'].includes(a.kind)).length,
    conversations: exchanges.length,
    averageResponseMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    satisfaction: feedback.length ? Math.round(feedback.filter((f) => f.rating === 5).length / feedback.length * 100) : null,
    ratings: feedback.length,
  };
}

export function appointment(value) {
  const text = field(value, 'appointment time', 50), date = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/.test(text) || !Number.isFinite(+date) || new Date(+date + 330 * 60000).toISOString().slice(0, 16) !== text.slice(0, 16)) throw fault(400, 'Choose a valid appointment time from the available slots.');
  return text;
}
