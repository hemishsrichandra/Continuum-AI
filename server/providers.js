import { randomUUID } from 'node:crypto';
import { SqliteStore } from './database.js';

export const profiles = [
  { id: 'alice', name: 'Alice Morgan', initials: 'AM', provider: 'repair', label: 'Device Repair', scenario: 'Returning customer', ticketId: 'SR-2048', prompt: 'What is the status of my laptop repair?' },
  { id: 'bob', name: 'Bob Sharma', initials: 'BS', provider: 'repair', label: 'Device Repair', scenario: 'Failed fix recovery', ticketId: 'SR-2076', prompt: 'My phone is still offline. What should I try?' },
  { id: 'carol', name: 'Carol Rao', initials: 'CR', provider: 'it', label: 'IT Support', scenario: 'Missed commitments', ticketId: 'IT-512', prompt: 'My VPN is still down. What should I do?' },
];
const DAY = 86400000;
const isoDay = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const seed = (scope, ticketId, kind, text) => ({
  id: 'seed-' + scope + '-' + kind, scope, ticketId, kind, text, createdAt: new Date(Date.now() - 7 * DAY).toISOString(),
});
const initial = () => ({
  repair: [
    { ticket_id: 'SR-2048', customer_id: 'alice', device: 'MacBook Pro', issue: 'Display replacement', status: 'Waiting for part', eta_date: isoDay(6), assigned_to: 'Device repair team' },
    { ticket_id: 'SR-2076', customer_id: 'bob', device: 'Pixel 8', issue: 'Phone offline', status: 'Diagnostics in progress', eta_date: isoDay(2), assigned_to: 'Device repair team' },
  ],
  it: [{ id: 'IT-512', user_id: 'carol', problem: 'Corporate VPN unavailable', state: 'Investigating', priority: 'High', target_resolution: isoDay(1), owner: 'Network operations' }],
  schemaVersion: 2, requirements: [], bookings: [], handoffs: [], audit: [], conversations: [], operations: [], demoBookings: [],
  memories: [
    seed('repair:alice', 'SR-2048', 'preference', 'Alice requested a phone callback before approving any paid repairs.'),
    seed('repair:bob', 'SR-2076', 'failed', 'Bob rebooted the phone to restore network connectivity. The reboot failed and the phone remained offline.'),
    seed('it:carol', 'IT-512', 'missed', 'Two promised VPN restoration deadlines for IT-512 were missed. Carol needs an owner and a confirmed follow-up.'),
  ],
});
export class Store extends SqliteStore {
  constructor(file) { super({ file, seed: initial }); }
}
const adapters = {
  repair: {
    owns: (row, id) => row.customer_id === id,
    normalize: (r) => ({ id: r.ticket_id, title: r.device, issue: r.issue, status: r.status, eta: r.eta_date, assignedTo: r.assigned_to }),
    create: (id, customer, title, issue) => ({ ticket_id: id, customer_id: customer, device: title, issue, status: 'Received', eta_date: null, assigned_to: 'Device repair team' }),
    prefix: 'SR',
  },
  it: {
    owns: (row, id) => row.user_id === id,
    normalize: (r) => ({ id: r.id, title: r.problem, issue: r.details || r.problem, status: r.state, eta: r.target_resolution, assignedTo: r.owner, priority: r.priority }),
    create: (id, customer, title, issue) => ({ id, user_id: customer, problem: title, details: issue, state: 'Open', target_resolution: null, priority: 'Normal', owner: 'IT service desk' }),
    prefix: 'IT',
  },
};
export function fault(status, message) {
  return Object.assign(new Error(message), { status });
}
export function provider(store, profile) {
  const adapter = adapters[profile.provider];
  const scope = profile.provider + ':' + profile.id;
  const list = () => store.data[profile.provider].filter((row) => adapter.owns(row, profile.id)).map((row) => ({
    ...adapter.normalize(row), createdAt: row.createdAt || null, updatedAt: row.updatedAt || null,
    requirements: store.data.requirements.filter((item) => item.scope === scope && item.ticketId === adapter.normalize(row).id),
    appointments: store.data.bookings.filter((item) => item.scope === scope && item.ticketId === adapter.normalize(row).id),
    handoffs: store.data.handoffs.filter((item) => item.scope === scope && item.ticketId === adapter.normalize(row).id)
      .map(({ context, ...item }) => item),
  }));
  const ticket = (id = profile.ticketId) => {
    const result = list().find((item) => item.id === id);
    if (!result) throw fault(404, 'Service request was not found in this account.');
    return result;
  };
  const slots = () => {
    const nowInIndia = new Date(Date.now() + 330 * 60000);
    nowInIndia.setUTCHours(0, 0, 0, 0);
    return Array.from({ length: 5 }, (_, day) => {
      const date = new Date(+nowInIndia + (day + 1) * DAY).toISOString().slice(0, 10);
      return ['10:00', '11:30', '14:00', '16:30'].map((time) => ({ date, time, id: date + 'T' + time + ':00+05:30' }));
    }).flat().filter((slot) => !store.data.bookings.some((item) => item.provider === profile.provider && !item.cancelledAt && item.datetime === slot.id));
  };
  const commit = (kind, body, ticketId, operation) => {
    if (kind !== 'request') ticket(ticketId);
    const id = randomUUID().toUpperCase();
    return store.update((data) => {
      const existing = operation?.key && data.operations.find((o) => o.scope === scope && o.key === operation.key);
      if (existing) {
        if (existing.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.');
        return existing.response;
      }
      if (kind === 'book' && !slots().some((slot) => slot.id === body.datetime)) throw fault(409, 'That appointment is no longer available. Choose another slot.');
      if (kind === 'book' && data.bookings.some((b) => b.provider === profile.provider && !b.cancelledAt && b.datetime === body.datetime)) throw fault(409, 'That appointment is no longer available.');
      if (operation?.proposalId && data.conversations.find((c) => c.id === operation.proposalId && c.scope === scope)?.response.action.completedAt) throw fault(409, 'This action has already been confirmed.');
      const result = { id, ticketId, createdAt: new Date().toISOString() };
      if (kind === 'request') {
        result.ticketId = adapter.prefix + '-' + id;
        data[profile.provider].push({ ...adapter.create(result.ticketId, profile.id, body.title, body.issueDesc), createdAt: result.createdAt });
      } else if (kind === 'requirement') {
        result.note = body.note;
        data.requirements.push({ ...result, scope });
      } else if (kind === 'book') {
        result.datetime = body.datetime;
        data.bookings.push({ ...result, scope, provider: profile.provider });
      } else if (kind === 'cancel') {
        const booking = data.bookings.find((item) => item.id === body.id && item.scope === scope && item.ticketId === ticketId);
        if (!booking) throw fault(404, 'Appointment was not found in this account.');
        if (booking.cancelledAt) throw fault(409, 'This appointment is already cancelled.');
        if (new Date(booking.datetime) <= new Date()) throw fault(409, 'Past appointments cannot be cancelled.');
        booking.cancelledAt = result.createdAt;
        result.bookingId = booking.id;
        result.datetime = booking.datetime;
      } else if (kind === 'outcome') {
        const row = data[profile.provider].find((item) => adapter.owns(item, profile.id) && adapter.normalize(item).id === ticketId);
        const status = body.outcome === 'resolved' ? 'Resolved' : body.outcome === 'failed' ? 'Reopened' : 'Follow-up required';
        if (profile.provider === 'repair') row.status = status; else row.state = status;
        row.updatedAt = result.createdAt;
        result.outcome = body.outcome;
        result.note = body.note;
        result.status = status;
      } else {
        result.summary = body.summary;
        result.context = body.context;
        result.status = 'Queued';
        data.handoffs.push({ ...result, scope, customerId: profile.id });
      }
      data.audit.push({ scope, kind, ...result });
      if (operation?.proposalId) {
        const exchange = data.conversations.find((c) => c.scope === scope && c.id === operation.proposalId);
        exchange.response.action.completedAt = result.createdAt;
        exchange.response.action.resultId = result.id;
      }
      if (operation?.key) data.operations.push({ scope, ...operation, response: { success: true, ...result, retained: operation.memory ? 'pending' : null } });
      return result;
    });
  };
  const history = () => store.data.audit.filter((item) => item.scope === scope).slice(-100).reverse();
  return { scope, list, ticket, slots, commit, history };
}
