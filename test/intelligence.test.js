import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';

const get = (c, company, query = '') => c.api(`companies/${company}/intelligence${query}`);

test('intelligence is limited to staff of the same company; tenant comes from the session', async (t) => {
  const w = await world(t);
  const c = await w.customer('alice');
  assert.equal((await get(c, w.company)).status, 403, 'customers cannot read it');
  assert.equal((await get(w.other, w.company)).status, 403, 'another company owner cannot read it');
  assert.equal((await get(w.owner, w.companyB)).status, 403, 'nor can the owner read another company by ID');
  assert.equal((await get(w.owner, 'legacy')).status, 403);
  assert.equal((await w.owner.api(`companies/${w.company}/intelligence`, {})).status, 405, 'read-only');
  assert.equal((await get(w.owner, w.company)).status, 200);
});

test('empty state is explicit and sensible', async (t) => {
  const w = await world(t);
  const r = (await get(w.owner, w.company)).data;
  assert.equal(r.empty, true);
  assert.equal(r.knowledge.customerConfirmedFixes, 0);
  assert.equal(r.knowledge.standardPlaybooks >= 3, true);
  assert.equal(r.responseTimes.meanFirstSpecialistResponseMs, null);
  assert.deepEqual(r.responseTimes.samples, { firstResponse: 0, confirmedResolution: 0 });
});

test('aggregates are company-scoped, keep confirmed and unconfirmed apart, and do not double count imports or playbooks', async (t) => {
  const w = await world(t);
  // Company A: one confirmed (via the real flow), one auto-published, one imported.
  const a = await w.customer('alice');
  const ticket = await w.ticket(a, ISSUE);
  const handoff = (await a.api('handoff', { ticketId: ticket, summary: ISSUE, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const p = (await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, title: 'Display flicker', symptoms: 'Display flickers after startup on the laptop', environment: 'Model X firmware 4', solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.', safety: 'None identified', safetyReviewed: true, reviewedForPrivacy: true, confirmed: true })).data;
  await a.api('resolutions/confirm', { id: p.id, accepted: true, confirmed: true });
  w.seed(w.company, { title: 'Imported fix', symptoms: 'Wifi drops at night', steps: ['Reboot the router and wait two minutes.'], origin: 'company_db_sync', sourceKey: 'imp' });
  w.seed(w.company, { title: 'Overdue fix', symptoms: 'Printer paper jam message', steps: ['Open the rear door and clear the paper path.'], origin: 'auto_published_overdue', sourceKey: 'auto' });
  w.db().prepare("UPDATE memory_pool SET customer_confirmed=0 WHERE source_key='auto'").run();
  // Company B has data that must never leak into A's numbers.
  w.seed(w.companyB, { title: 'B fix', symptoms: 'Display flickers after startup', steps: ['B steps for the flicker.'] });
  // Reuse: B-customer of company A succeeds with the confirmed fix.
  const b = await w.customer('bob');
  const tb = await w.ticket(b, ISSUE);
  const shown = (await w.ask(b, tb, ISSUE)).data;
  assert.equal(shown.attempt.source, 'learned');
  await w.ask(b, tb, 'It worked');
  const r = (await get(w.owner, w.company)).data;
  assert.equal(r.empty, false);
  assert.equal(r.knowledge.customerConfirmedFixes, 1, 'only the customer-confirmed specialist fix');
  assert.equal(r.knowledge.autoPublishedUnconfirmed, 1, 'reported separately');
  assert.equal(r.knowledge.importedRecords, 1);
  assert.equal(r.reuse.memorySucceeded, 1);
  assert.equal(r.reuse.memorySucceededBySource.specialistConfirmed, 1);
  assert.equal(r.reuse.memorySucceededBySource.imported, 0, 'imports are not counted as learned successes');
  assert.equal(r.resolutions.confirmedByCustomer, 1);
  assert.equal(r.reuse.standardSucceeded, 0);
  assert.ok(r.responseTimes.meanFirstSpecialistResponseMs !== null);
  assert.equal(r.responseTimes.samples.confirmedResolution, 1);
  const other = (await get(w.other, w.companyB)).data;
  assert.equal(other.knowledge.customerConfirmedFixes, 1, 'B has its own seeded confirmed fix');
  assert.equal(other.reuse.memorySucceeded, 0);
  assert.equal(other.resolutions.confirmedByCustomer, 0);
});

test('review flags, pending deadlines and SLA breaches are reported', async (t) => {
  const w = await world(t, { config: { CASE_SLA_HOURS: '1' } });
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const [a, b] = [await w.customer('alice'), await w.customer('bob')];
  for (const c of [a, b]) {
    const id = await w.ticket(c, ISSUE);
    const shown = (await w.ask(c, id, ISSUE)).data;
    await c.api('troubleshooting/outcome', { attemptId: shown.attempt.id, worked: false, confirmed: true });
  }
  w.db().prepare("UPDATE memory_pool SET created_at=created_at WHERE id=?").run(fix.id);
  const r = (await get(w.owner, w.company)).data;
  assert.equal(r.knowledge.flaggedForReview, 1);
  assert.equal(r.followThrough.pendingFixReviews, 1);
  assert.equal(r.reuse.memoryFailed, 2);
  const slaNow = Date.now() + 2 * 3600000;
  const later = (await import('../server/intelligence.js')).intelligenceFor(w.h.store, w.company, { at: slaNow, slaHours: 1 });
  assert.equal(later.followThrough.slaBreaches, 2, 'two cases queued past the 1h SLA');
  assert.equal(later.followThrough.openCases, 2);
});

test('self-service: only an explicit "It worked" without a specialist counts as solved; top fixes show their track record', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const [a, b, c] = [await w.customer('alice'), await w.customer('bob'), await w.customer('cara')];
  const shown = {};
  for (const [name, cust] of [['a', a], ['b', b], ['c', c]]) {
    const id = await w.ticket(cust, ISSUE);
    shown[name] = { id, attempt: (await w.ask(cust, id, ISSUE)).data.attempt };
    assert.ok(shown[name].attempt, 'a fix was suggested');
  }
  await a.api('troubleshooting/outcome', { attemptId: shown.a.attempt.id, worked: true, confirmed: true });
  await b.api('troubleshooting/outcome', { attemptId: shown.b.attempt.id, worked: false, confirmed: true });
  await b.api('handoff', { ticketId: shown.b.id, summary: ISSUE, confirmed: true });
  // cara never answers: silence is not success.
  const r = (await get(w.owner, w.company)).data;
  assert.deepEqual(r.selfService, { requestsWithSuggestions: 3, solvedWithoutSpecialist: 1, solvedAfterSpecialist: 1, deflectionRate: 0.333 });
  assert.equal(shown.a.attempt.source, 'learned');
  assert.equal(r.topFixes[0].id, fix.id);
  assert.equal(r.topFixes[0].successes, 1);
  const other = (await get(w.other, w.companyB)).data;
  assert.equal(other.selfService.requestsWithSuggestions, 0, 'company-scoped');
  assert.equal(other.selfService.deflectionRate, null);
});
