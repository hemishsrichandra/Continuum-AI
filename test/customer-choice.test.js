// The product default: suggestions are PRESENTED (at most three) and nothing counts as tried until the customer picks one.
// Covers each outcome, the specialist handoff brief, privacy, exhaustion and the permission boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';

// An import the owner approved: active, from a named source, and not customer-confirmed.
function imported(w, companyId, p, sourceId) {
  const row = w.seed(companyId, { ...p, origin: 'company_db_sync' });
  w.db().prepare("UPDATE memory_pool SET status='active',source_id=? WHERE id=?").run(sourceId, row.id);
  return row;
}
// The choose route stores the chosen suggestion in the conversation; this returns it together with the status.
async function chooseVia(cust, ticket, id) {
  const r = await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: id, confirmed: true });
  const messages = (await cust.api('conversation?ticketId=' + ticket)).data.messages ?? [];
  const last = messages.filter((m) => m.response?.attempt).at(-1)?.response;
  return { status: r.status, data: { ...r.data, ...last } };
}
async function setup(t, count = 3, config = {}) {
  const w = await world(t, { choose: true, config });
  const rows = FOUR.slice(0, count).map(([title, symptoms, step], i) => imported(w, w.company, { title, symptoms, steps: [step], sourceKey: 'c:' + i }, 'src-1'));
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  const shown = (await w.ask(cust, ticket, ISSUE)).data;
  const attempts = () => w.db().prepare("SELECT id,outcome,outcome_detail,memory_id,sequence FROM troubleshooting_attempts WHERE source='learned' ORDER BY sequence").all();
  const uses = () => w.db().prepare('SELECT COUNT(*) n FROM resolution_uses').get().n;
  const choose = (id) => chooseVia(cust, ticket, id);
  return { w, rows, cust, ticket, shown, attempts, uses, choose };
}

test('up to three eligible suggestions are shown as choices, with reasons and provenance, and NOTHING is recorded as tried', async (t) => {
  const { w, shown, attempts, uses } = await setup(t, 4);
  assert.equal(shown.workflow.stage, 'learned_choices');
  assert.equal(shown.choices.length, 3, 'at most three of the four eligible fixes');
  assert.equal(new Set(shown.choices.map((c) => c.id)).size, 3);
  for (const c of shown.choices) {
    assert.ok(c.title && c.advice && c.why && c.source.label, 'title, steps, why it matched and where it came from');
    assert.match(c.why, /Matched your description/);
    assert.equal(c.source.customerConfirmed, false, 'an imported fix is not presented as customer-confirmed');
  }
  assert.equal('attempt' in shown, false);
  assert.equal(attempts().length, 0, 'no attempt exists merely because suggestions were displayed');
  assert.equal(uses(), 0, 'no reuse record either');
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE reuse_failure_count>0 OR reuse_success_count>0").get().n, 0, 'no success or failure was counted for any fix');
  const shownEvent = w.db().prepare("SELECT detail_json FROM case_events WHERE kind='suggestions_shown'").get();
  assert.equal(JSON.parse(shownEvent.detail_json).count, 3, 'the display itself is auditable');
  // Asking again just shows the choices again; still nothing is tried.
  await w.ask((await w.customer('bob')), await w.ticket(await w.customer('bob2'), ISSUE), ISSUE);
  assert.equal(attempts().length, 0);
});

test('choosing one records exactly that suggestion; the others stay untried and can still be chosen; the outcome lands on the chosen one', async (t) => {
  const { w, cust, ticket, shown, attempts, choose } = await setup(t);
  const pick = shown.choices[1];
  assert.equal((await cust.api('troubleshooting/choose', { ticketId: ticket, resolutionId: pick.id })).status, 400, 'a choice must be confirmed');
  const r = await choose(pick.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(attempts().map((a) => [a.memory_id, a.outcome]), [[pick.id, 'pending']]);
  assert.equal(r.data.alternatives.length, 2, 'the two not chosen stay on offer');
  const worked = await cust.api('troubleshooting/outcome', { attemptId: r.data.attempt.id, outcome: 'worked', confirmed: true, memory: true });
  assert.equal(worked.status, 200, JSON.stringify(worked.data));
  const stat = (id) => w.db().prepare('SELECT reuse_success_count s, reuse_failure_count f FROM memory_pool WHERE id=?').get(id);
  assert.deepEqual({ ...stat(pick.id) }, { s: 1, f: 0 });
  for (const other of shown.choices.filter((c) => c.id !== pick.id)) assert.deepEqual({ ...stat(other.id) }, { s: 0, f: 0 }, 'a suggestion that was only displayed is untouched');
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId: r.data.attempt.id, outcome: 'worked', confirmed: true })).status, 200, 'a duplicate submission is harmless');
  assert.equal((await cust.api('troubleshooting/outcome', { attemptId: r.data.attempt.id, outcome: 'did_not_work', confirmed: true })).status, 409, 'a final outcome cannot be flipped');
  assert.equal(stat(pick.id).s, 1, 'and was counted once');
});

test('every outcome is distinct: only "did not work" is a failure; not applicable, unable to try and a specialist request are not', async (t) => {
  const failures = (w) => w.db().prepare("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE outcome='failed'").get().n;
  const memFail = (w) => w.db().prepare('SELECT SUM(reuse_failure_count) n FROM memory_pool').get().n;
  for (const [outcome, expectDetail] of [['not_applicable', 'not_applicable'], ['unable_to_try', 'unable_to_try'], ['human_requested', 'human_requested']]) {
    const s = await setup(t);
    const r = await s.choose(s.shown.choices[0].id);
    const out = await s.cust.api('troubleshooting/outcome', { attemptId: r.data.attempt.id, outcome, confirmed: true });
    assert.equal(out.status, 200, outcome + ' ' + JSON.stringify(out.data));
    assert.deepEqual([s.attempts()[0].outcome, s.attempts()[0].outcome_detail], ['skipped', expectDetail]);
    assert.equal(failures(s.w), 0, outcome + ' is not a failure');
    assert.equal(memFail(s.w) || 0, 0, outcome + ' does not count against the fix');
  }
  const s = await setup(t);
  const r = await s.choose(s.shown.choices[0].id);
  await s.cust.api('troubleshooting/outcome', { attemptId: r.data.attempt.id, outcome: 'did_not_work', confirmed: true, memory: true });
  assert.equal(failures(s.w), 1);
  assert.equal(memFail(s.w), 1);
});

test('a specialist handoff carries a concise, privacy-filtered brief: the open question, what was tried and how it went, and where each fix came from', async (t) => {
  const w = await world(t, { choose: true });
  FOUR.slice(0, 2).forEach(([title, symptoms, step], i) => imported(w, w.company, { title, symptoms, steps: [step], sourceKey: 'b:' + i }, 'src-9'));
  const cust = await w.customer('dana');
  const ticket = await w.ticket(cust, ISSUE + ' You can reach me at dana.private@example.com or +1 415 555 0134.');
  const shown = (await w.ask(cust, ticket, ISSUE)).data;
  assert.equal(shown.choices.length, 2);
  const first = await chooseVia(cust, ticket, shown.choices[0].id);
  await cust.api('troubleshooting/outcome', { attemptId: first.data.attempt.id, outcome: 'unable_to_try', confirmed: true });
  const again = (await w.ask(cust, ticket, 'The display still flickers after startup, is there another way to fix it?')).data;
  assert.equal(again.workflow.stage, 'learned_choices');
  assert.equal(again.choices.length, 1, 'the one already tried is not offered again');
  const second = await chooseVia(cust, ticket, again.choices[0].id);
  const done = await cust.api('troubleshooting/outcome', { attemptId: second.data.attempt.id, outcome: 'did_not_work', confirmed: true, memory: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const handoff = w.db().prepare("SELECT payload FROM records WHERE collection='handoffs'").all().map((r) => JSON.parse(r.payload))[0];
  assert.ok(handoff, 'the exhausted path opened a specialist case');
  const brief = handoff.brief;
  assert.ok(brief, 'the case carries a brief');
  assert.equal(brief.tried.length, 2);
  assert.deepEqual(brief.tried.map((x) => x.outcome), ['unable_to_try', 'did not work']);
  assert.equal(brief.counts.failed, 1, 'only the real failure is counted as one');
  assert.equal(brief.tried[0].provenance.origin, 'company_db_sync');
  assert.equal(brief.tried[0].provenance.sourceId, 'src-9');
  assert.equal(brief.tried[0].provenance.customerConfirmed, false);
  assert.match(brief.unresolvedQuestion, /flickers/);
  const text = JSON.stringify(brief);
  assert.ok(!/dana\.private@example\.com|555 0134/.test(text), 'personal contact details never reach the brief');
  assert.ok(text.length < 4000, 'concise');
  assert.equal((await cust.api('workspace')).data.tickets.find((x) => x.id === ticket || x.ticket_id === ticket) !== undefined, true);
  const status = await cust.api('status?ticketId=' + ticket);
  assert.equal(status.status, 200);
});

test('a reported safety concern escalates with a safety reason instead of suggesting a stored fix, and tenants never see each other’s suggestions', async (t) => {
  const w = await world(t, { choose: true });
  imported(w, w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 's:1' }, 'src-1');
  imported(w, w.companyB, { title: 'Other company secret fix', symptoms: FOUR[0][1], steps: ['Do something private to company B.'], sourceKey: 's:2' }, 'src-2');
  const cust = await w.customer('erin');
  const ticket = await w.ticket(cust, ISSUE + ' The laptop casing is also bulging.');
  const reply = (await w.ask(cust, ticket, ISSUE + ' The laptop casing is bulging.')).data;
  assert.notEqual(reply.workflow.stage, 'learned_choices', 'a bulging casing is a hazard: no stored fix is offered');
  assert.equal(reply.choices, undefined);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE source='learned'").get().n, 0);
  const handoff = w.db().prepare("SELECT payload FROM records WHERE collection='handoffs'").all().map((r) => JSON.parse(r.payload))[0];
  assert.ok(handoff?.brief, 'a specialist case was opened with a brief');
  assert.equal(handoff.brief.trigger, 'safety concern');
  const clean = await w.customer('frank');
  const t2 = await w.ticket(clean, ISSUE);
  const ok = (await w.ask(clean, t2, ISSUE)).data;
  assert.equal(ok.choices?.length, 1);
  assert.ok(!/company B/.test(JSON.stringify(ok)), 'another company’s knowledge is never offered');
});

test('only the customer who owns the request can choose; staff and other customers cannot', async (t) => {
  const { w, ticket, shown } = await setup(t);
  const mallory = await w.customer('mallory');
  const r = await mallory.api('troubleshooting/choose', { ticketId: ticket, resolutionId: shown.choices[0].id, confirmed: true });
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.equal((await w.owner.api('troubleshooting/choose', { ticketId: ticket, resolutionId: shown.choices[0].id, confirmed: true })).status, 403);
  const stale = await mallory.api('troubleshooting/outcome', { attemptId: 'nope', outcome: 'worked', confirmed: true });
  assert.ok([403, 404].includes(stale.status));
});

test('asking for a person after choosing a suggestion closes that attempt as "specialist requested", not as pending and not as a failure', async (t) => {
  const { w, cust, ticket, shown, attempts, choose } = await setup(t);
  await choose(shown.choices[0].id);
  assert.equal(attempts()[0].outcome, 'pending');
  const sent = await cust.api('handoff', { ticketId: ticket, summary: 'I would like to talk to a specialist about this.', confirmed: true });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.deepEqual([attempts()[0].outcome, attempts()[0].outcome_detail], ['skipped', 'human_requested']);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM troubleshooting_attempts WHERE outcome='failed'").get().n, 0);
  assert.equal(w.db().prepare('SELECT SUM(reuse_failure_count) n FROM memory_pool').get().n || 0, 0);
  const brief = w.db().prepare("SELECT payload FROM records WHERE collection='handoffs'").all().map((r) => JSON.parse(r.payload))[0].brief;
  assert.equal(brief.trigger, 'customer asked for a person');
  assert.equal(brief.tried[0].outcome, 'human_requested');
});
