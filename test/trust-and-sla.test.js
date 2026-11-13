import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE } from './_helpers.js';
import { verificationOf } from '../server/passports.js';

const HOUR = 3600000;
const GOOD = {
  title: 'Display flicker after startup', symptoms: 'Display flickers after startup on the laptop', environment: 'Model X firmware 4',
  solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.', safety: 'None identified', safetyReviewed: true,
};
async function propose(w, overrides = {}, name = 'alice') {
  const a = await w.customer(name);
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const r = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, reviewedForPrivacy: true, confirmed: true, ...GOOD, ...overrides });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { a, ticketId, handoff, proposal: r.data, me };
}
const pool = (w, id) => w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(id);
const reject = (a, id) => a.api('resolutions/confirm', { id, accepted: false, confirmed: true });

// ---------------------------------------------------------------------------------------------- Test 19
test('race: a customer rejection and the overdue-publication worker can never leave a rejected fix recommendable', async (t) => {
  // (a) the customer answers first, then the worker runs.
  const wa = await world(t);
  const one = await propose(wa);
  assert.equal((await reject(one.a, one.proposal.id)).status, 200);
  const late = Date.now() + 25 * HOUR;
  assert.deepEqual(wa.h.followThrough.tick(late).filter((r) => r.status !== 'sla_escalated'), []);
  assert.equal(pool(wa, one.proposal.id), undefined, 'nothing is published for a rejected proposal');

  // (b) the worker publishes first (the customer had not answered), then the customer says it did not work.
  const wb = await world(t);
  const two = await propose(wb);
  assert.equal(wb.h.followThrough.tick(late)[0].status, 'auto_published');
  assert.equal(pool(wb, two.proposal.id).status, 'active');
  assert.equal((await reject(two.a, two.proposal.id)).status, 200);
  const after = pool(wb, two.proposal.id);
  assert.notEqual(after.status, 'active', 'the rejected fix is withdrawn from recommendation');
  assert.equal(after.customer_confirmed, 0);
  assert.equal((await wb.h.memoryPool.retrieve({ companyId: wb.company, chatbotId: wb.botOf(wb.company), text: ISSUE })).eligible.length, 0);

  // (c) both at the same moment, many times: whatever the interleaving, the invariant holds.
  for (let i = 0; i < 6; i++) {
    const w = await world(t);
    const p = await propose(w);
    await Promise.all([reject(p.a, p.proposal.id), Promise.resolve().then(() => w.h.followThrough.tick(late))]);
    const row = pool(w, p.proposal.id);
    assert.ok(!row || (row.status !== 'active' && row.customer_confirmed === 0), `iteration ${i}: ${JSON.stringify(row && { status: row.status, c: row.customer_confirmed })}`);
    const task = w.db().prepare("SELECT status FROM follow_through_tasks WHERE dedupe_key=?").get('confirm:' + p.proposal.id);
    assert.ok(['completed', 'auto_published'].includes(task.status));
    assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE source_key=?').get('resolution:' + p.proposal.id).n, row ? 1 : 0, 'never published twice');
  }
});

test('trust: unconfirmed, unreviewed or unresolved proposals are never auto-published and are never labelled verified', async (t) => {
  const w = await world(t);
  const unreviewedSafety = await propose(w, { safetyReviewed: false }, 'bob');
  const res = w.h.followThrough.tick(Date.now() + 25 * HOUR).filter((r) => r.status !== 'sla_escalated');
  assert.equal(res[0].status, 'escalated');
  assert.ok(res[0].blockers.some((b) => /safety restrictions were not reviewed/.test(b)), JSON.stringify(res));
  assert.equal(pool(w, unreviewedSafety.proposal.id), undefined);
  // A published-but-unconfirmed fix keeps its own label and never reads as customer verified.
  const w2 = await world(t);
  const ok = await propose(w2);
  w2.h.followThrough.tick(Date.now() + 25 * HOUR);
  const row = pool(w2, ok.proposal.id);
  assert.equal(verificationOf(row), 'unconfirmed_by_customer');
  assert.equal(row.customer_confirmed, 0);
  assert.equal((await w2.owner.api('operator')).data.passports.find((p) => p.id === row.id).verification, 'unconfirmed_by_customer');
  // The original ticket is not marked resolved just because its fix became reusable.
  const status = (await ok.a.api('status?ticketId=' + ok.ticketId)).data.status;
  assert.notEqual(status, 'Resolved');
  // Once the customer does confirm, that version (and only then) becomes customer-verified.
  assert.equal((await ok.a.api('resolutions/confirm', { id: ok.proposal.id, accepted: true, confirmed: true })).status, 200);
  assert.equal(verificationOf(pool(w2, ok.proposal.id)), 'customer_confirmed');
});

// ---------------------------------------------------------------------------------------------- Test 21
test('SLA: assigned cases that are not progressing escalate once per reason, and cases waiting on the customer do not', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const h = w.h.store.data.handoffs.find((x) => x.id === handoff.id);
  const milestones = (res) => res.filter((r) => r.status === 'sla_escalated').map((r) => r.milestone.split(':')[0]);
  const t0 = Date.now();

  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 2 * HOUR)), [], 'inside the first-response window');
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 5 * HOUR)), ['first_response'], 'assigned but nothing has happened');
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 6 * HOUR)), [], 'a case already escalated for this reason is not escalated again');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM sla_events WHERE handoff_id=? AND milestone='first_response'").get(handoff.id).n, 1);

  // The specialist acts; a later quiet period is a new, separate escalation.
  const act = (ms) => w.h.store.update((d) => d.audit.push({ id: 'p' + ms, scope: h.scope, ticketId, kind: 'progress', createdAt: new Date(ms).toISOString() }));
  act(t0 + 7 * HOUR);
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 20 * HOUR)), [], 'recent activity');
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 32 * HOUR)), ['specialist_inactive']);
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 33 * HOUR)), [], 'once for this quiet period');
  act(t0 + 34 * HOUR);
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 60 * HOUR)), ['specialist_inactive'], 'a new quiet period escalates again');

  // Final-resolution deadline.
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 73 * HOUR)), ['resolution']);
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 80 * HOUR)).includes('resolution'), false);
  // Each escalation is visible to the team and in the case timeline.
  const queue = w.h.followThrough.queue(w.company, [w.botOf(w.company)], t0 + 80 * HOUR);
  assert.ok(queue.tasks.filter((x) => x.type === 'sla_escalation').length >= 4);
  assert.ok(queue.tasks.every((x) => x.type !== 'sla_escalation' || x.nextStep));
  assert.ok(w.h.followThrough.timeline(w.company, w.botOf(w.company), ticketId).some((e) => e.kind === 'sla_breached' && e.detail.milestone));
  assert.equal(queue.policy.firstResponseHours, 4);
  // A resolved case is never escalated.
  w.h.store.update((d) => { d.handoffs.find((x) => x.id === handoff.id).status = 'Resolved'; });
  assert.deepEqual(milestones(w.h.followThrough.tick(t0 + 400 * HOUR)), []);
});

test('SLA: a case waiting for the customer to confirm a proposal is not blamed on the specialist', async (t) => {
  const w = await world(t);
  const p = await propose(w);
  const milestones = (res) => res.filter((r) => r.status === 'sla_escalated').map((r) => r.milestone.split(':')[0]);
  assert.deepEqual(milestones(w.h.followThrough.tick(Date.now() + 30 * HOUR)), []);
  void p;
});

test('SLA policy is configurable per deployment', async (t) => {
  const w = await world(t, { config: { SLA_FIRST_RESPONSE_HOURS: '1', SLA_INACTIVITY_HOURS: '2', SLA_RESOLUTION_HOURS: '10', SLA_FOLLOW_UP_HOURS: '3' } });
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const res = w.h.followThrough.tick(Date.now() + 90 * 60000).filter((r) => r.status === 'sla_escalated');
  assert.deepEqual(res.map((r) => r.milestone), ['first_response']);
  assert.deepEqual(w.h.followThrough.queue(w.company, [w.botOf(w.company)]).policy, { firstResponseHours: 1, inactivityHours: 2, followUpHours: 3, resolutionHours: 10 });
});
