import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, password, ISSUE } from './_helpers.js';
import { getBot } from '../server/chatbots.js';

/** Company with two repair services (A, B), one unrestricted specialist, and cases in both services. */
async function setup(t) {
  const w = await world(t);
  const botA = w.botOf(w.company);
  const template = getBot(w.db(), w.company, botA);
  delete template.id;
  const b = (await w.owner.api('company/chatbots', { ...template, name: 'Second repair service' })).data.chatbot;
  async function specialist(name, provider = 'repair') {
    const c = client(() => w.h);
    const invite = (await w.owner.api('company/invitations', { email: name + '@example.test', role: 'staff', provider })).data.url.split('invite=')[1];
    const r = await c.api('auth/register', { invitation: invite, name, email: name + '@example.test', password });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    c.id = r.data.profile.id;
    return c;
  }
  async function caseIn(botId, name) {
    const cust = await w.customer(name);
    await cust.api('auth/workspace', { companyId: w.company, chatbotId: botId });
    const ticket = await w.ticket(cust, ISSUE);
    const h = (await cust.api('handoff', { ticketId: ticket, summary: ISSUE, confirmed: true })).data;
    return { cust, ticket, handoff: h.id };
  }
  return { w, botA, botB: b.id, specialist, caseIn };
}

test('without any restriction a specialist keeps access to every service of their adapter (backward compatible)', async (t) => {
  const { w, botA, botB, specialist } = await setup(t);
  const s = await specialist('sam');
  for (const bot of [botA, botB]) assert.equal((await s.api('operator?chatbotId=' + encodeURIComponent(bot))).status, 200);
  const listed = (await s.api('auth/workspaces')).data.chatbots.map((x) => x.id);
  assert.ok(listed.includes(botA) && listed.includes(botB));
  void w;
});

test('a restricted specialist cannot open, list or switch into other services', async (t) => {
  const { w, botA, botB, specialist, caseIn } = await setup(t);
  const s = await specialist('sam');
  const inB = await caseIn(botB, 'bella');
  assert.equal((await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: [botA], confirmed: true })).status, 200);
  assert.equal((await s.api('operator?chatbotId=' + encodeURIComponent(botA))).status, 200);
  assert.equal((await s.api('operator?chatbotId=' + encodeURIComponent(botB))).status, 403);
  assert.equal((await s.api(`companies/${w.company}/intelligence?chatbotId=${encodeURIComponent(botB)}`)).status, 403);
  assert.equal((await s.api(`companies/${w.company}/intelligence?chatbotId=${encodeURIComponent(botA)}`)).status, 200);
  const listed = (await s.api('auth/workspaces')).data.chatbots.map((x) => x.id);
  assert.deepEqual(listed, [botA]);
  assert.equal((await s.api('auth/workspace', { companyId: w.company, chatbotId: botB })).status, 403);
  assert.equal((await s.api('auth/workspace', { companyId: w.company, chatbotId: botA })).status, 200);
  // Direct-ID attack: acting on service B's case through service A's operator context finds nothing.
  const attack = await s.api('operator/assign?chatbotId=' + encodeURIComponent(botA), { handoffId: inB.handoff, assignedTo: s.id, revision: 0, confirmed: true });
  assert.equal(attack.status, 404);
  assert.equal(w.h.store.data.handoffs.find((h) => h.id === inB.handoff).assignedTo, null);
  // The owner is never restricted.
  assert.equal((await w.owner.api('operator?chatbotId=' + encodeURIComponent(botB))).status, 200);
});

test('a restricted specialist cannot be assigned work in a service they cannot reach', async (t) => {
  const { w, botA, botB, specialist } = await setup(t);
  const s = await specialist('sam');
  await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: [botA], confirmed: true });
  const rosterB = (await w.owner.api('operator?chatbotId=' + encodeURIComponent(botB))).data.staff.map((x) => x.id);
  const rosterA = (await w.owner.api('operator?chatbotId=' + encodeURIComponent(botA))).data.staff.map((x) => x.id);
  assert.ok(!rosterB.includes(s.id), 'not offered for service B');
  assert.ok(rosterA.includes(s.id), 'still offered for service A');
});

test('narrowing access returns cases the specialist holds in a removed service to the queue, with an audit record', async (t) => {
  const { w, botA, botB, specialist, caseIn } = await setup(t);
  const s = await specialist('sam');
  const inA = await caseIn(botA, 'alice');
  const inB = await caseIn(botB, 'bella');
  for (const [c, bot] of [[inA, botA], [inB, botB]])
    assert.equal((await w.owner.api('operator/assign?chatbotId=' + encodeURIComponent(bot), { handoffId: c.handoff, assignedTo: s.id, revision: 0, confirmed: true })).status, 200);
  const r = await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: [botA], confirmed: true });
  assert.equal(r.data.releasedCases, 1);
  const cases = w.h.store.data.handoffs;
  assert.equal(cases.find((h) => h.id === inA.handoff).assignedTo, s.id, 'kept in the service they still reach');
  assert.equal(cases.find((h) => h.id === inB.handoff).assignedTo, null);
  assert.equal(cases.find((h) => h.id === inB.handoff).status, 'Queued');
  assert.ok(w.h.store.data.audit.some((a) => a.kind === 'staff_service_access_changed' && a.accountId === s.id));
});

test('null removes the restriction again', async (t) => {
  const { w, botA, botB, specialist } = await setup(t);
  const s = await specialist('sam');
  await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: [botA], confirmed: true });
  assert.equal((await s.api('operator?chatbotId=' + encodeURIComponent(botB))).status, 403);
  assert.equal((await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: null, confirmed: true })).status, 200);
  assert.equal((await s.api('operator?chatbotId=' + encodeURIComponent(botB))).status, 200);
  assert.equal((await w.owner.api('company/staff-access')).data.staff.find((x) => x.id === s.id).chatbotIds, null);
});

test('the access API validates its input and is owner-only and company-scoped', async (t) => {
  const { w, botA, botB, specialist } = await setup(t);
  const s = await specialist('sam');
  const itBot = Object.values((await w.owner.api('company/chatbots')).data.chatbots).find((b) => b.adapter === 'it').id;
  const set = (body, who = w.owner) => who.api('company/staff-access', { accountId: s.id, confirmed: true, ...body });
  assert.equal((await set({ confirmed: false, chatbotIds: [botA] })).status, 400, 'confirmation required');
  assert.equal((await set({ chatbotIds: [] })).status, 400, 'empty list is not “no access”');
  assert.equal((await set({ chatbotIds: 'x' })).status, 400);
  assert.equal((await set({ chatbotIds: [itBot] })).status, 400, 'a repair specialist cannot be given an IT service');
  assert.equal((await set({ chatbotIds: [w.botOf(w.companyB)] })).status, 404, 'another company’s service does not exist here');
  assert.equal((await set({ accountId: 'nope', chatbotIds: [botA] })).status, 404);
  assert.equal((await set({ chatbotIds: [botA] }, s)).status, 403, 'a specialist cannot change their own access');
  assert.equal((await set({ chatbotIds: [botA] }, w.other)).status, 404, 'another company’s owner cannot touch this specialist');
  const customer = await w.customer('carol');
  assert.equal((await set({ chatbotIds: [botA] }, customer)).status, 403);
  assert.equal((await customer.api('company/staff-access')).status, 403);
  assert.equal((await s.api('company/staff-access')).status, 403);
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM staff_chatbot_access').get().n, 0, 'nothing was stored by the rejected calls');
  assert.equal((await set({ chatbotIds: [botA, botB, botA] })).status, 200, 'duplicates are collapsed');
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM staff_chatbot_access').get().n, 2);
});

test('revoked staff and database constraints: access rows need a real membership and a real service', async (t) => {
  const { w, botA, specialist } = await setup(t);
  const s = await specialist('sam');
  assert.throws(() => w.db().prepare("INSERT INTO staff_chatbot_access VALUES(?,?,?,?,?)").run(w.company, 'ghost', botA, null, 't'), /FOREIGN KEY/);
  assert.throws(() => w.db().prepare("INSERT INTO staff_chatbot_access VALUES(?,?,?,?,?)").run(w.company, s.id, 'no-such-bot', null, 't'), /FOREIGN KEY/);
  await w.owner.api('company/staff-access', { accountId: s.id, chatbotIds: [botA], confirmed: true });
  assert.equal((await w.owner.api('company/revoke-membership', { id: s.id, confirmed: true })).status, 200);
  assert.equal((await s.api('operator')).status, 403, 'a revoked member is out regardless of access rows');
});
