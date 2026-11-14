import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE } from './_helpers.js';

test('overdue publication uses scoped writes and never loads the complete records store', async (t) => {
  const w = await world(t);
  const customer = await w.customer('scopecheck');
  const ticketId = await w.ticket(customer, ISSUE);
  const handoff = (await customer.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const owner = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: owner, revision: 0, confirmed: true });
  const proposal = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, title: 'Display flicker after startup',
    environment: 'Model X firmware 4', solution: 'Disable Adaptive Refresh in Display Settings and restart the laptop.',
    safety: 'None identified', safetyReviewed: true, reviewedForPrivacy: true, confirmed: true });
  assert.equal(proposal.status, 201);
  const store = w.h.store;
  Object.defineProperty(store, 'data', { configurable: true, get() { throw new Error('full store read'); } });
  const update = store.update;
  store.update = function (change, options) {
    assert.equal(options?.companyId, w.company, 'worker updates only the due task company');
    return update.call(this, change, options);
  };
  t.after(() => { delete store.data; store.update = update; });
  const result = w.h.followThrough.tick(Date.now() + 25 * 3600000);
  assert.ok(result.some((r) => r.status === 'auto_published'));
  const memory = w.db().prepare('SELECT customer_confirmed,origin_type FROM memory_pool WHERE id=?').get(proposal.data.id);
  assert.equal(memory.customer_confirmed, 0);
  assert.equal(memory.origin_type, 'auto_published_overdue');
});

test('another tenant with the same ticket ID cannot supply specialist activity for an SLA', async (t) => {
  const w = await world(t);
  const now = Date.now();
  w.h.store.update((data) => {
    data.handoffs.push({ id: 'local-handoff', companyId: w.company, chatbotId: w.botOf(w.company), scope: w.company + ':repair:local',
      ticketId: 'shared-ticket-id', status: 'In progress', assignedTo: 'local-staff', createdAt: new Date(now - 6 * 3600000).toISOString() });
    data.audit.push({ id: 'foreign-assignment', scope: w.companyB + ':repair:foreign', ticketId: 'shared-ticket-id', kind: 'assignment', createdAt: new Date(now).toISOString() });
  });
  const result = w.h.followThrough.tick(now);
  assert.ok(result.some((r) => r.handoffId === 'local-handoff' && r.milestone === 'first_response'));
});
