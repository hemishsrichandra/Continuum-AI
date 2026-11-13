import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE } from './_helpers.js';

const HOUR = 3600000;
const GOOD = {
  title: 'Display flicker after startup', symptoms: 'Display flickers after startup on the laptop', environment: 'Model X firmware 4',
  solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.',
  safety: 'None identified', safetyReviewed: true,
};
async function propose(w, name = 'alice') {
  const a = await w.customer(name);
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  assert.equal((await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true })).status, 200);
  const r = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, reviewedForPrivacy: true, confirmed: true, ...GOOD });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { a, ticketId, handoff, proposal: r.data };
}
const task = (w, id) => w.db().prepare('SELECT * FROM follow_through_tasks WHERE dedupe_key=?').get('confirm:' + id);

test('a customer can ask for more time: the deadline moves, twice at most, and silence is still not success', async (t) => {
  const w = await world(t);
  const { a, proposal, ticketId } = await propose(w);
  const first = Date.parse(task(w, proposal.id).deadline_at);

  assert.equal((await a.api('resolutions/defer', { id: proposal.id })).status, 400, 'needs an explicit confirmation');
  const one = await a.api('resolutions/defer', { id: proposal.id, confirmed: true });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.data.deferrals, 1);
  const second = Date.parse(task(w, proposal.id).deadline_at);
  assert.ok(Math.abs(second - (first + 24 * HOUR)) < 5000, 'a day later than before');
  assert.equal((await a.api('resolutions/defer', { id: proposal.id, confirmed: true })).data.deferrals, 2);
  assert.equal((await a.api('resolutions/defer', { id: proposal.id, confirmed: true })).status, 409, 'only twice');
  assert.equal(Date.parse(task(w, proposal.id).deadline_at) - first, 48 * HOUR, 'at most two extra days in total');

  // Past the original deadline nothing happens while the customer is still within the extended window.
  assert.deepEqual(w.h.followThrough.tick(first + 2 * HOUR), [], 'the extended wait has not expired');
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE id=?').get(proposal.id).n, 0, 'nothing was published');
  // The customer still sees the proposal as waiting on them, with the new deadline.
  const ticket = (await a.api('status?ticketId=' + ticketId)).data;
  assert.equal(ticket.status !== 'Resolved', true);
  // Answering afterwards still works and finishes the wait.
  assert.equal((await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true })).status, 200);
  assert.equal(task(w, proposal.id).status, 'completed');
  assert.equal((await a.api('resolutions/defer', { id: proposal.id, confirmed: true })).status, 409, 'cannot defer an answered solution');
});

test('after the extended deadline the usual rules apply again', async (t) => {
  const w = await world(t);
  const { a, proposal } = await propose(w);
  await a.api('resolutions/defer', { id: proposal.id, confirmed: true });
  const extended = Date.parse(task(w, proposal.id).deadline_at);
  const outcome = w.h.followThrough.tick(extended + 1000);
  assert.equal(outcome.length, 1, 'now the wait is due');
  assert.ok(['auto_published', 'escalated'].includes(outcome[0].status));
});

test('deferring: only the customer who owns the case, never staff, never another company', async (t) => {
  const w = await world(t);
  const { a, proposal } = await propose(w);
  const mallory = await w.customer('mallory');
  assert.equal((await mallory.api('resolutions/defer', { id: proposal.id, confirmed: true })).status, 404, 'another customer cannot touch it');
  assert.equal((await w.owner.api('resolutions/defer', { id: proposal.id, confirmed: true })).status, 403, 'staff handle cases in the console');
  assert.equal((await w.other.api('resolutions/defer', { id: proposal.id, confirmed: true })).status, 403);
  assert.equal(Date.parse(task(w, proposal.id).deadline_at) > 0, true);
  assert.equal((await a.api('resolutions/defer', { id: 'nope', confirmed: true })).status, 404);
});

test('a specialist can flag a case urgent and ask the owner to review; only an owner closes the review', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const caseOf = async () => (await w.owner.api('operator')).data.cases.find((c) => c.id === handoff.id);
  const rev = async () => (await caseOf()).revision || 0;
  const rowPriority = () => w.h.store.dataFor(w.company).repair.find((r) => (r.ticket_id || r.id) === ticketId).priority;

  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), urgent: true })).status, 400, 'needs confirmation');
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), confirmed: true })).status, 400, 'needs something to flag');
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: 99, urgent: true, confirmed: true })).status, 409, 'stale revision');
  assert.equal((await a.api('operator/flag', { handoffId: handoff.id, revision: 0, urgent: true, confirmed: true })).status, 403, 'customers cannot');

  const urgent = await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), urgent: true, confirmed: true });
  assert.equal(urgent.status, 200, JSON.stringify(urgent.data));
  assert.equal(urgent.data.urgent, true);
  assert.equal(rowPriority(), 'Urgent', 'the request itself shows the priority');

  const note = 'Customer says the laptop is needed for tomorrow\'s exam.';
  const review = await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: true, note, confirmed: true });
  assert.equal(review.status, 200);
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: true, confirmed: true })).status, 409, 'already requested');
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: false, urgent: false, confirmed: true })).status, 200, 'an owner clears both');
  const cleared = await caseOf();
  assert.equal(cleared.urgent, false);
  assert.equal(cleared.ownerReview, undefined);
  assert.notEqual(rowPriority(), 'Urgent', 'priority goes back to what it was before');
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: false, confirmed: true })).status, 409, 'nothing to close');
  assert.deepEqual((await caseOf()).timeline.map((e) => e.kind).filter((k) => /urgent|owner_review/.test(k)), ['flagged_urgent', 'owner_review_requested', 'urgent_cleared', 'owner_review_closed']);
});

test('the owner-review note and flags never reach the customer, and secrets are refused', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const rev = async () => (await w.owner.api('operator')).data.cases.find((c) => c.id === handoff.id).revision || 0;
  assert.equal((await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: true, note: 'api_key = sk-abcdef0123456789', confirmed: true })).status, 400);
  await w.owner.api('operator/flag', { handoffId: handoff.id, revision: await rev(), ownerReview: true, urgent: true, note: 'Internal: escalate to legal.', confirmed: true });
  const seen = JSON.stringify((await a.api('status?ticketId=' + ticketId)).data) + JSON.stringify((await a.api('workspace')).data);
  assert.ok(!seen.includes('escalate to legal'), 'internal note leaked');
  assert.ok(!/ownerReview|urgentBy|priorityBefore/.test(seen), 'internal flag fields leaked');
});
