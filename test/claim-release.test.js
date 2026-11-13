import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, password, ISSUE } from './_helpers.js';

async function setup(t) {
  const w = await world(t);
  async function specialist(name) {
    const c = client(() => w.h);
    const invite = (await w.owner.api('company/invitations', { email: name + '@example.test', role: 'staff', provider: 'repair' })).data.url.split('invite=')[1];
    const r = await c.api('auth/register', { invitation: invite, name, email: name + '@example.test', password });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    c.id = r.data.profile.id;
    return c;
  }
  const sam = await specialist('sam'), kim = await specialist('kim');
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  const h = (await cust.api('handoff', { ticketId: ticket, summary: ISSUE, confirmed: true })).data;
  const state = async (who = w.owner) => (await who.api('operator')).data.cases.find((c) => c.id === h.id);
  const assign = async (who, assignedTo, revision) => who.api('operator/assign', { handoffId: h.id, assignedTo, revision: revision ?? (await state(who)).revision ?? 0, confirmed: true });
  return { w, sam, kim, cust, h, state, assign };
}

test('a specialist claims an unassigned case in one step, and the claim is recorded', async (t) => {
  const { sam, state, assign } = await setup(t);
  const r = await assign(sam, sam.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = await state(sam);
  assert.equal(c.assignedTo, sam.id);
  assert.equal(c.status, 'In progress');
});

test('two specialists claiming at the same moment: exactly one wins, the other gets a conflict', async (t) => {
  const { sam, kim, state } = await setup(t);
  const revision = (await state(sam)).revision || 0;
  const body = (who) => ({ handoffId: undefined, assignedTo: who.id, revision, confirmed: true });
  const caseId = (await state(sam)).id;
  const [a, b] = await Promise.all([sam.api('operator/assign', { ...body(sam), handoffId: caseId }), kim.api('operator/assign', { ...body(kim), handoffId: caseId })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.data, b.data]));
  const holder = (await state(sam)).assignedTo;
  assert.ok([sam.id, kim.id].includes(holder));
});

test('a specialist cannot claim, release or reassign a case that belongs to someone else', async (t) => {
  const { sam, kim, state, assign } = await setup(t);
  await assign(sam, sam.id);
  const rev = (await state(sam)).revision;
  assert.equal((await kim.api('operator/assign', { handoffId: (await state(sam)).id, assignedTo: kim.id, revision: rev, confirmed: true })).status, 403, 'no stealing a claimed case');
  assert.equal((await kim.api('operator/assign', { handoffId: (await state(sam)).id, assignedTo: '', revision: rev, confirmed: true })).status, 403, 'no releasing someone else’s case');
  assert.equal((await sam.api('operator/assign', { handoffId: (await state(sam)).id, assignedTo: kim.id, revision: rev, confirmed: true })).status, 403, 'a specialist cannot hand a case to another specialist');
  assert.equal((await state(sam)).assignedTo, sam.id, 'nothing changed');
});

test('release to queue: the assignee returns the case, it becomes claimable again, and a stale revision is rejected', async (t) => {
  const { sam, kim, state, assign } = await setup(t);
  await assign(sam, sam.id);
  const before = (await state(sam)).revision;
  assert.equal((await sam.api('operator/assign', { handoffId: (await state(sam)).id, assignedTo: '', revision: before - 1, confirmed: true })).status, 409, 'stale revision');
  const released = await assign(sam, '');
  assert.equal(released.status, 200, JSON.stringify(released.data));
  assert.equal(released.data.released, true);
  const c = await state(sam);
  assert.equal(c.assignedTo, null);
  assert.equal(c.status, 'Queued');
  assert.equal((await assign(sam, '')).status, 409, 'nothing left to release');
  assert.equal((await assign(kim, kim.id)).status, 200, 'another specialist can now claim it');
});

test('the owner can release or reassign any case; customers and other companies cannot touch it', async (t) => {
  const { w, sam, kim, cust, state, assign } = await setup(t);
  await assign(sam, sam.id);
  const r = await assign(w.owner, kim.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await state()).assignedTo, kim.id);
  assert.equal((await assign(w.owner, '')).status, 200, 'owner release');
  assert.equal((await cust.api('operator/assign', { handoffId: (await state()).id, assignedTo: '', revision: 0, confirmed: true })).status, 403);
  assert.equal((await w.other.api('operator/assign', { handoffId: (await state()).id, assignedTo: '', revision: 0, confirmed: true })).status, 404);
  assert.equal((await w.owner.api('operator/assign', { handoffId: (await state()).id, assignedTo: 'nobody', revision: (await state()).revision, confirmed: true })).status, 400, 'the owner can only pick active staff of this company');
});

test('a case waiting for the customer cannot be claimed, released or reassigned', async (t) => {
  const { w, cust, h, sam, state, assign } = await setup(t);
  await assign(w.owner, (await w.owner.api('auth/session')).data.profile.id);
  const rev = (await state()).revision;
  const GOOD = { title: 'Display flicker after startup', environment: 'Model X firmware 4', solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.', safety: 'None identified', safetyReviewed: true, reviewedForPrivacy: true, confirmed: true };
  assert.equal((await w.owner.api('operator/resolve', { handoffId: h.id, revision: rev, ...GOOD })).status, 201);
  assert.equal((await state()).status, 'Awaiting confirmation');
  assert.equal((await w.owner.api('operator/assign', { handoffId: h.id, assignedTo: sam.id, revision: (await state()).revision, confirmed: true })).status, 409);
  assert.equal((await w.owner.api('operator/assign', { handoffId: h.id, assignedTo: '', revision: (await state()).revision, confirmed: true })).status, 409);
  void cust;
});
