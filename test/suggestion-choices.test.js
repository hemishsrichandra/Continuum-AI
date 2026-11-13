import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';

async function setup(t, count = 3) {
  const w = await world(t);
  const rows = FOUR.slice(0, count).map(([title, symptoms, step], i) => w.seed(w.company, { title, symptoms, steps: [step], sourceKey: 'c:' + i }));
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  const first = (await w.ask(cust, ticket, ISSUE)).data;
  const attempts = () => w.db().prepare("SELECT id,outcome,outcome_detail,memory_id,sequence FROM troubleshooting_attempts WHERE source='learned' ORDER BY sequence").all();
  return { w, rows, cust, ticket, first, attempts };
}

test('the best suggestion is shown together with the other eligible ones, as previews rather than attempts', async (t) => {
  const { first, attempts } = await setup(t);
  assert.equal(first.workflow.stage, 'learned_pending');
  assert.ok(first.attempt, 'the best-ranked suggestion is the first to try');
  assert.equal(first.alternatives.length, 2, 'up to three together: the best plus two more');
  assert.equal(new Set([first.learnedSource.id, ...first.alternatives.map((a) => a.id)]).size, 3, 'three distinct passports');
  for (const a of first.alternatives) { assert.ok(a.title && a.advice && a.why && a.source.label, 'title, steps, why it matched and provenance'); assert.equal('attempt' in a, false); }
  assert.equal(attempts().length, 1, 'only the shown-first suggestion is an attempt; the others are untried');
});

test('fewer than three qualify: no padding with weak matches', async (t) => {
  const two = await setup(t, 2);
  assert.equal(two.first.alternatives.length, 1);
  const one = await setup(t, 1);
  assert.equal(one.first.alternatives.length, 0);
});

test('choosing another suggestion sets the first aside (not failed), records one new attempt, and shows it in the conversation', async (t) => {
  const { w, cust, ticket, first, attempts } = await setup(t);
  const pick = first.alternatives[0];
  assert.equal((await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: pick.id })).status, 400, 'needs confirmation');
  const r = await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: pick.id, confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = attempts();
  assert.deepEqual(rows.map((a) => [a.outcome, a.outcome_detail]), [['skipped', 'set_aside'], ['pending', null]]);
  assert.equal(rows[1].memory_id, pick.id);
  const messages = (await cust.api('conversation?ticketId=' + ticket)).data.messages ?? [];
  assert.ok(JSON.stringify(messages).includes(pick.title), 'the chosen suggestion appears in the conversation');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE outcome='failed'").get().n, 0, 'nothing was counted as failed');
  assert.equal((await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: first.learnedSource.id, confirmed: true })).status, 409, 'the one set aside is not offered again');
  assert.equal((await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: 'nope', confirmed: true })).status, 409);
});

test('a stale or unsafe choice is rejected: a suggestion retired after it was shown cannot be chosen', async (t) => {
  const { w, cust, ticket, first } = await setup(t);
  const pick = first.alternatives[0];
  w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(pick.id);
  const r = await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: pick.id, confirmed: true });
  assert.equal(r.status, 409, JSON.stringify(r.data));
});

test('only the customer who owns the request can choose, and another customer cannot reach it', async (t) => {
  const { w, ticket, first } = await setup(t);
  const mallory = await w.customer('mallory');
  const r = await mallory.api('troubleshooting/choose', { ticketId: ticket, resolutionId: first.alternatives[0].id, confirmed: true });
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.equal((await w.owner.api('troubleshooting/choose', { ticketId: ticket, resolutionId: first.alternatives[0].id, confirmed: true })).status, 403, 'staff use the console');
});

test('the richer outcomes are distinct, never count as a failure, and are idempotent', async (t) => {
  const { w, cust, first, attempts } = await setup(t);
  const attemptId = first.attempt.id;
  const failures = () => w.db().prepare('SELECT reuse_failure_count f FROM memory_pool WHERE id=?').get(first.learnedSource.id).f;
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId, outcome: 'whatever', confirmed: true })).status, 400);
  const na = await cust.api('troubleshooting/outcome', { attemptId, outcome: 'not_applicable', confirmed: true });
  assert.equal(na.status, 200, JSON.stringify(na.data));
  assert.deepEqual([attempts()[0].outcome, attempts()[0].outcome_detail], ['skipped', 'not_applicable']);
  assert.equal(failures(), 0, 'not applicable to my device is a review signal, not a failed fix');
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId, outcome: 'not_applicable', confirmed: true })).status, 200, 'repeating the same answer is harmless');
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId, outcome: 'unable_to_try', confirmed: true })).status, 409, 'a different final answer is refused');
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId, outcome: 'worked', confirmed: true })).status, 409);
});

test('asking for a person creates exactly one case and still does not mark the fix failed', async (t) => {
  const { w, cust, first, attempts } = await setup(t);
  const attemptId = first.attempt.id;
  const a = await cust.api('troubleshooting/outcome', { attemptId, outcome: 'human_requested', confirmed: true });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  await cust.api('troubleshooting/outcome', { attemptId, outcome: 'human_requested', confirmed: true });
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM records WHERE collection='handoffs'").get().n, 1, 'one case, not two');
  assert.deepEqual([attempts()[0].outcome, attempts()[0].outcome_detail], ['skipped', 'human_requested']);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE outcome='failed'").get().n, 0);
});

test('worked and did-not-work through the new outcome field behave like the original buttons', async (t) => {
  const { cust, first, attempts } = await setup(t);
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId: first.attempt.id, outcome: 'did_not_work', confirmed: true, memory: true })).status, 200);
  assert.equal(attempts()[0].outcome, 'failed');
});
