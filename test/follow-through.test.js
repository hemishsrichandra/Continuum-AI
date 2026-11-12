import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world, ISSUE } from './_helpers.js';

const HOUR = 3600000;
const GOOD = {
  title: 'Display flicker after startup', symptoms: 'Display flickers after startup on the laptop', environment: 'Model X firmware 4',
  solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.',
  safety: 'None identified', safetyReviewed: true,
};
/** Customer reports the issue; a specialist claims it and proposes a solution. */
async function propose(w, overrides = {}, name = 'alice') {
  const a = await w.customer(name);
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  assert.equal((await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true })).status, 200);
  const r = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, reviewedForPrivacy: true, confirmed: true, ...GOOD, ...overrides });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { a, ticketId, handoff, proposal: r.data };
}
const task = (w, proposalId) => w.db().prepare("SELECT * FROM follow_through_tasks WHERE dedupe_key=?").get('confirm:' + proposalId);
const pool = (w, id) => w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(id);

test('a proposal persists a confirmation wait with C_init and the default 24h deadline', async (t) => {
  const w = await world(t);
  const before = Date.now();
  const { proposal } = await propose(w);
  const k = task(w, proposal.id);
  assert.equal(k.status, 'pending');
  assert.equal(k.task_type, 'customer_confirmation_wait');
  assert.equal(k.initial_confidence_score, proposal.cInit.score);
  assert.ok(proposal.cInit.score >= 0.75, 'a complete, applicable proposal: ' + proposal.cInit.score);
  assert.ok(Math.abs(Date.parse(k.deadline_at) - (before + 24 * HOUR)) < 60000);
  assert.deepEqual(Object.keys(proposal.cInit.components).sort(), ['P_passport', 'R_author', 'S_diag']);
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE id=?').get(proposal.id).n, 0, 'nothing is published at proposal time');
});

test('the deadline is configurable', async (t) => {
  const w = await world(t, { config: { CONFIRMATION_DEADLINE_HOURS: '2' } });
  const before = Date.now();
  const { proposal } = await propose(w);
  assert.ok(Math.abs(Date.parse(task(w, proposal.id).deadline_at) - (before + 2 * HOUR)) < 60000);
});

test('explicit customer confirmation publishes immediately as customer-confirmed', async (t) => {
  const w = await world(t);
  const { a, proposal, ticketId } = await propose(w);
  assert.equal((await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true })).status, 200);
  const m = pool(w, proposal.id);
  assert.equal(m.origin_type, 'specialist_confirmed');
  assert.equal(m.customer_confirmed, 1);
  assert.equal(m.status, 'active');
  assert.equal(task(w, proposal.id).status, 'completed');
  assert.equal((await a.api('status?ticketId=' + ticketId)).data.status, 'Resolved');
  assert.deepEqual(w.h.followThrough.tick(Date.now() + 48 * HOUR), [], 'nothing left to do after the customer answered');
});

test('"Still need help" on a proposal is a failure, not approval, and never publishes', async (t) => {
  const w = await world(t);
  const { a, proposal } = await propose(w);
  assert.equal((await a.api('resolutions/confirm', { id: proposal.id, accepted: false, confirmed: true })).status, 200);
  assert.equal(pool(w, proposal.id), undefined);
  assert.deepEqual(w.h.followThrough.tick(Date.now() + 48 * HOUR), []);
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE origin_type IN (\'auto_published_overdue\',\'specialist_confirmed\')').get().n, 0);
});

test('overdue + no response + C_init >= 0.75: published as UNCONFIRMED, case stays open, never double-published', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-ft-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const w = await world(t, { file: join(dir, 'ft.sqlite') });
  const { a, proposal, ticketId, handoff } = await propose(w);
  assert.deepEqual(w.h.followThrough.tick(Date.now() + 23 * HOUR), [], 'before the deadline nothing happens');
  const late = Date.now() + 25 * HOUR;
  const first = w.h.followThrough.tick(late);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'auto_published');
  const m = pool(w, proposal.id);
  assert.equal(m.origin_type, 'auto_published_overdue');
  assert.equal(m.customer_confirmed, 0, 'never portrayed as customer-verified');
  assert.match(m.verification_evidence_json, /UNCONFIRMED BY CUSTOMER/);
  const provenance = JSON.parse(m.provenance_json);
  assert.equal(provenance.autoPublished.threshold, 0.75);
  assert.ok(provenance.cInit.components);
  // Repeated ticks, concurrent workers and restarts cannot duplicate the publication.
  assert.deepEqual(w.h.followThrough.tick(late + HOUR), []);
  w.restart();
  assert.deepEqual(w.h.followThrough.tick(late + 2 * HOUR), []);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_key=?").get('resolution:' + proposal.id).n, 1);
  // The unresolved ticket is NOT closed because an article was published.
  assert.notEqual((await a.api('status?ticketId=' + ticketId)).data.status, 'Resolved');
  const h = w.h.store.data.handoffs.find((x) => x.id === handoff.id);
  assert.notEqual(h.status, 'Resolved');
  assert.equal(h.followUpRequired, true);
  const intel = (await w.owner.api(`companies/${w.company}/intelligence`)).data;
  assert.equal(intel.knowledge.autoPublishedUnconfirmed, 1);
  assert.equal(intel.knowledge.customerConfirmedFixes, 0, 'does not count as a customer-confirmed fix');
  assert.equal(intel.resolutions.confirmedByCustomer, 0);
  // Another customer is told honestly where the fix came from.
  const b = await w.customer('bob');
  const shown = (await w.ask(b, await w.ticket(b, ISSUE), ISSUE)).data;
  assert.equal(shown.learnedSource.unconfirmed, true);
  assert.match(shown.learnedSource.label, /UNCONFIRMED BY CUSTOMER/);
  assert.equal(shown.evidence[0].passport.verification, 'unconfirmed_by_customer');
  // A later explicit confirmation by the original customer upgrades the same record.
  assert.equal((await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true })).status, 200);
  const upgraded = pool(w, proposal.id);
  assert.equal(upgraded.customer_confirmed, 1);
  assert.equal(upgraded.origin_type, 'specialist_confirmed');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_key=?").get('resolution:' + proposal.id).n, 1);
});

test('overdue with C_init < 0.75 is not published and is escalated for specialist follow-up', async (t) => {
  const w = await world(t);
  // Short steps and no safety review lower P_passport.
  const { proposal, handoff } = await propose(w, { solution: 'Restart it twice.', safety: '', safetyReviewed: false });
  assert.ok(proposal.cInit.score < 0.75, 'C_init ' + proposal.cInit.score);
  const res = w.h.followThrough.tick(Date.now() + 25 * HOUR);
  assert.equal(res[0].status, 'escalated');
  assert.match(res[0].blockers[0], /below 0.75/);
  assert.equal(pool(w, proposal.id), undefined);
  assert.equal(task(w, proposal.id).status, 'escalated');
  assert.equal(w.h.store.data.handoffs.find((x) => x.id === handoff.id).followUpRequired, true);
  const q = (await w.owner.api('operator')).data.followThrough.tasks.find((x) => x.proposalId === proposal.id);
  assert.match(q.nextStep, /contact the customer/i);
});

test('boundary: C_init exactly 0.75 qualifies, just below does not', async (t) => {
  const w = await world(t);
  const { proposal } = await propose(w);
  const base = { title: 'x', symptoms: 'y', environment: 'z', solution: 's', reviewedForPrivacy: true, redactions: 0, customerAccepted: undefined };
  assert.deepEqual(w.h.followThrough.autoPublishBlockers(base, 0.75), []);
  assert.match(w.h.followThrough.autoPublishBlockers(base, 0.7499)[0], /below/);
  assert.ok(proposal);
});

test('policy gates: high-risk, dangerous, unreviewed, PII-containing or contradicted proposals are never auto-published', async (t) => {
  const w = await world(t);
  const gate = (extra) => w.h.followThrough.autoPublishBlockers({ title: 't', symptoms: 's', environment: 'e', solution: 'Select the profile.', reviewedForPrivacy: true, redactions: 0, ...extra }, 0.99);
  assert.deepEqual(gate({}), []);
  assert.ok(gate({ riskLevel: 'high' }).length);
  assert.ok(gate({ safetyCritical: true }).length);
  assert.ok(gate({ solution: 'Open the battery and bypass the thermal fuse.' }).length);
  assert.ok(gate({ reviewedForPrivacy: false }).length);
  assert.ok(gate({ redactions: 2 }).length);
  assert.ok(gate({ solution: 'Email jane@corp.example the log.' }).length);
  assert.ok(gate({ customerAccepted: false }).length);
  // End to end: a high-risk proposal stays private and is escalated.
  const { proposal } = await propose(w, { riskLevel: 'high' });
  assert.equal(w.h.followThrough.tick(Date.now() + 25 * HOUR)[0].status, 'escalated');
  assert.equal(pool(w, proposal.id), undefined);
});

test('PII in a proposal is scrubbed server-side and blocks auto-publication', async (t) => {
  const w = await world(t);
  const { proposal } = await propose(w, { solution: 'Select the Standard profile. Call alice at 415 555 0100 if it persists, S/N ABC12345.', symptoms: 'Display flickers after startup for alice@example.test' });
  assert.doesNotMatch(JSON.stringify(proposal.passport), /alice@example|415 555|ABC12345/);
  assert.ok(proposal.redactions >= 3);
  assert.equal(w.h.followThrough.tick(Date.now() + 25 * HOUR)[0].status, 'escalated');
});

test('secrets in proposals are rejected outright', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const r = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, reviewedForPrivacy: true, confirmed: true, ...GOOD, solution: 'Use password: hunter2 to sign in and select the profile.' });
  assert.equal(r.status, 400);
});

test('preview returns the scrubbed passport and C_init without storing anything', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  const r = await w.owner.api('operator/preview-passport', { handoffId: handoff.id, ...GOOD, solution: GOOD.solution + ' Contact alice@example.test.' });
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.data.passport), /alice@example/);
  assert.ok(r.data.cInit.score > 0.7);
  assert.equal(w.h.store.data.resolutions.length, 0);
});

test('the worker tick runs follow-through from the integrations flush (not per web request)', async (t) => {
  const w = await world(t);
  const { proposal } = await propose(w);
  w.db().prepare("UPDATE follow_through_tasks SET deadline_at=? WHERE dedupe_key=?").run(new Date(Date.now() - HOUR).toISOString(), 'confirm:' + proposal.id);
  // Ordinary web traffic does not publish.
  await w.owner.api('operator');
  assert.equal(pool(w, proposal.id), undefined);
  await w.h.delivery.flush();
  assert.equal(pool(w, proposal.id).origin_type, 'auto_published_overdue');
});

test('SLA: unclaimed cases past the SLA become one escalation task and appear in the queue', async (t) => {
  const w = await world(t, { config: { CASE_SLA_HOURS: '1' } });
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId, summary: ISSUE, confirmed: true })).data;
  assert.deepEqual(w.h.followThrough.tick(Date.now() + 30 * 60000), []);
  const first = w.h.followThrough.tick(Date.now() + 2 * HOUR);
  assert.equal(first[0].status, 'sla_escalated');
  assert.deepEqual(w.h.followThrough.tick(Date.now() + 3 * HOUR), [], 'once only');
  const op = (await w.owner.api('operator')).data;
  assert.ok(op.followThrough.tasks.some((x) => x.type === 'sla_escalation' && x.handoffId === handoff.id));
  assert.ok(op.cases[0].timeline.some((e) => e.kind === 'sla_breached'));
  const intel = (await w.owner.api(`companies/${w.company}/intelligence`)).data;
  assert.equal(intel.followThrough.openCases, 1);
});

test('case timeline records every step from suggestion to resolution and is company-visible before escalation', async (t) => {
  const w = await world(t);
  w.seed(w.company, { title: 'Display flicker: adaptive refresh', symptoms: 'Display flickers after startup', steps: ['Disable adaptive refresh in Display settings and restart.'] });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  await w.ask(a, id, ISSUE);
  await w.ask(a, id, 'Still need help');
  const kinds = w.h.followThrough.timeline(w.company, w.botOf(w.company), id).map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 4), ['request_opened', 'suggestion_offered', 'suggestion_failed', 'escalated_to_specialist']);
  const op = (await w.owner.api('operator')).data;
  assert.equal(op.cases[0].timeline.length, kinds.length);
});
