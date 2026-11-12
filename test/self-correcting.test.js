import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';

async function fail(w, customer, ticket, message = ISSUE) {
  const shown = (await w.ask(customer, ticket, message)).data;
  assert.equal(shown.attempt?.source, 'learned', 'a learned fix is offered');
  await customer.api('troubleshooting/outcome', { attemptId: shown.attempt.id, worked: false, confirmed: true });
  return shown;
}
const row = (w, id) => w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(id);

test('a single ordinary failure neither flags nor globally blocks a safe fix', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice'), b = await w.customer('bob');
  await fail(w, a, await w.ticket(a, ISSUE));
  const after = row(w, fix.id);
  assert.equal(after.status, 'active');
  assert.equal(after.reuse_failure_count, 1);
  assert.equal(after.consecutive_failures, 1);
  const shownToB = (await w.ask(b, await w.ticket(b, ISSUE), ISSUE)).data;
  assert.equal(shownToB.attempt.memory_id, fix.id, 'another customer can still receive it');
});

test('the customer who failed a fix never receives it again, on any ticket', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice');
  await fail(w, a, await w.ticket(a, ISSUE));
  const second = await w.ticket(a, ISSUE);
  const again = (await w.ask(a, second, ISSUE)).data;
  assert.notEqual(again.attempt?.memory_id, fix.id);
  assert.equal(again.trace.learnedResolutions, 0);
});

test('two consecutive failures flag the fix for review and create a review task', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice'), b = await w.customer('bob'), c = await w.customer('carol');
  await fail(w, a, await w.ticket(a, ISSUE));
  await fail(w, b, await w.ticket(b, ISSUE));
  const flagged = row(w, fix.id);
  assert.equal(flagged.status, 'flagged_for_review');
  assert.equal(flagged.consecutive_failures, 2);
  assert.match(flagged.flagged_reason, /consecutive/);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM follow_through_tasks WHERE memory_id=? AND task_type='failed_fix_review' AND status='pending'").get(fix.id).n, 1);
  const cShown = (await w.ask(c, await w.ticket(c, ISSUE), ISSUE)).data;
  assert.notEqual(cShown.attempt?.memory_id, fix.id, 'flagged fixes are not offered');
  const lib = (await w.owner.api('operator')).data;
  assert.equal(lib.passports.find((p) => p.id === fix.id).status, 'flagged_for_review');
  assert.equal(lib.followThrough.tasks.filter((x) => x.type === 'failed_fix_review' && x.status === 'pending').length, 1);
});

test('a success between failures resets the consecutive counter', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const [a, b, c] = [await w.customer('alice'), await w.customer('bob'), await w.customer('carol')];
  await fail(w, a, await w.ticket(a, ISSUE));
  const tb = await w.ticket(b, ISSUE);
  assert.equal((await w.ask(b, tb, ISSUE)).data.attempt.memory_id, fix.id);
  await w.ask(b, tb, 'It worked');
  assert.equal(row(w, fix.id).consecutive_failures, 0);
  await fail(w, c, await w.ticket(c, ISSUE));
  const r = row(w, fix.id);
  assert.equal(r.status, 'active');
  assert.equal(r.reuse_success_count, 1);
  assert.equal(r.reuse_failure_count, 2);
});

test('low reliability (W < 0.55) flags after a failure even without consecutive failures', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], cInit: 0.7 });
  const a = await w.customer('alice');
  await fail(w, a, await w.ticket(a, ISSUE));
  assert.equal(row(w, fix.id).status, 'flagged_for_review', 'W = 1.4/3 = 0.467');
});

test('a reported safety incident quarantines immediately', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const shown = (await w.ask(a, id, ISSUE)).data;
  await a.api('troubleshooting/outcome', { attemptId: shown.attempt.id, worked: false, confirmed: true, safetyIncident: true });
  const r = row(w, fix.id);
  assert.equal(r.status, 'flagged_for_review');
  assert.equal(r.risk_level, 'high');
  assert.match(r.flagged_reason, /safety/i);
});

test('versioning: revised passport links to its parent, supersedes it atomically and keeps history', async (t) => {
  const w = await world(t);
  const v1 = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const [a, b, c] = [await w.customer('alice'), await w.customer('bob'), await w.customer('carol')];
  await fail(w, a, await w.ticket(a, ISSUE));
  await fail(w, b, await w.ticket(b, ISSUE));
  assert.equal(row(w, v1.id).status, 'flagged_for_review');
  const body = { id: v1.id, title: 'Display flicker: adaptive refresh (revised)', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Disable adaptive refresh in Display settings, then install firmware 4.1 and restart.', note: 'Added firmware step', reviewedForPrivacy: true, confirmed: true, version: 1 };
  assert.equal((await w.owner.api('operator/revise', { ...body, confirmed: false })).status, 400);
  assert.equal((await w.other.api('operator/revise', body)).status, 404, 'another company cannot revise it');
  const revised = await w.owner.api('operator/revise', body);
  assert.equal(revised.status, 201, JSON.stringify(revised.data));
  assert.equal(revised.data.version, 2);
  assert.equal(revised.data.parentVersionId, v1.id);
  assert.equal(revised.data.lineageId, v1.id);
  assert.equal(revised.data.customerConfirmed, false, 'a revision is not customer-confirmed until a customer confirms it');
  const old = row(w, v1.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.reuse_failure_count, 2, 'history and metrics are preserved on the old version');
  assert.equal(old.steps_json, JSON.stringify([FOUR[0][2]]), 'the old version is never mutated');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM follow_through_tasks WHERE memory_id=? AND status='pending'").get(v1.id).n, 0);
  assert.equal((await w.owner.api('operator/revise', body)).status, 409, 'a superseded version cannot be revised again');
  const lib = (await w.owner.api('operator')).data.passports.filter((p) => p.lineageId === v1.id);
  assert.deepEqual(lib.map((p) => [p.version, p.status]), [[2, 'active'], [1, 'superseded']]);
  // New customers get the revised version; those who failed v1 may receive a *different* revision
  // but never the same failed steps again.
  const cShown = (await w.ask(c, await w.ticket(c, ISSUE), ISSUE)).data;
  assert.equal(cShown.attempt.memory_id, revised.data.id);
  const aShown = (await w.ask(a, await w.ticket(a, ISSUE), ISSUE)).data;
  assert.equal(aShown.attempt?.memory_id, revised.data.id, 'different steps are a genuinely new suggestion');
  // Reverting to the failed text is itself a new version, and still never repeats for the customer who failed it.
  const reverted = await w.owner.api('operator/revise', { ...body, id: revised.data.id, version: 2, solution: FOUR[0][2] });
  assert.equal(reverted.data.version, 3);
  const bShown = (await w.ask(b, await w.ticket(b, ISSUE), ISSUE)).data;
  assert.notEqual(bShown.attempt?.memory_id, reverted.data.id);
});

test('review decisions require the flagged state and the latest failure count', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const [a, b] = [await w.customer('alice'), await w.customer('bob')];
  await fail(w, a, await w.ticket(a, ISSUE));
  const review = (body) => w.owner.api('operator/review-resolution', { id: fix.id, note: 'Checked.', confirmed: true, ...body });
  assert.equal((await review({ decision: 'keep', reviewRevision: 1 })).status, 409, 'not flagged yet');
  await fail(w, b, await w.ticket(b, ISSUE));
  assert.equal((await review({ decision: 'keep', reviewRevision: 1 })).status, 409, 'stale failure count');
  assert.equal((await review({ decision: 'keep', reviewRevision: 2 })).status, 200);
  const kept = row(w, fix.id);
  assert.equal(kept.status, 'active');
  assert.equal(kept.consecutive_failures, 0);
  assert.equal(kept.locally_reviewed, 1);
});
