import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as demo from '../server/demo-learning.js';

const session = () => demo.getSession(demo.createSession());
const SPEC = { ...demo.SCRIPT.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true };

/** A user's case goes to the specialist and that SAME user confirms the specialist's fix. */
function teach(state, user, description = demo.SCRIPT.userA.description, device = demo.SCRIPT.userA.device) {
  const c = demo.createIssue(state, { user, description, device }).case;
  demo.feedback(state, { caseId: c.id, worked: false, confirmed: true });
  demo.propose(state, { caseId: c.id, ...SPEC });
  demo.confirm(state, { caseId: c.id, accepted: true, confirmed: true });
  return c;
}

test('attribution: a fix confirmed by User B is never credited to User A', () => {
  const state = session();
  teach(state, 'B');
  const learned = state.learned[0];
  assert.equal(learned.originUser, 'B');
  assert.equal(learned.confirmationUser, 'B');
  assert.equal(learned.verificationStatus, 'customer_confirmed');
  assert.ok(learned.sourceCaseId && learned.confirmationTime);
  const view = demo.view(state);
  assert.match(view.learned[0].provenance, /User B/);
  assert.doesNotMatch(JSON.stringify(view.learned), /User A/);
  assert.equal(view.summary.userATaught, false);
  assert.match(view.summary.line, /User B taught Continuum → verified demo memory created → waiting for User A/);

  // User A now meets a similar problem and receives User B's fix, labelled as User B's.
  const a = demo.createIssue(state, { user: 'A', ...demo.SCRIPT.userB });
  assert.equal(a.attempt.source, 'learned');
  assert.match(a.attempt.label, /User B/);
  assert.doesNotMatch(a.attempt.label + JSON.stringify(a.attempt.explanation?.why), /User A/);
  demo.feedback(state, { caseId: a.case.id, worked: true, confirmed: true });
  const events = demo.view(state).events;
  assert.ok(events.some((e) => e.kind === 'learned_suggestion_shown' && /learned from User B/.test(e.detail)));
  const benefit = events.find((e) => e.kind === 'user_b_benefited');
  assert.deepEqual([benefit.teacher, benefit.beneficiary], ['B', 'A']);
  assert.match(benefit.detail, /learned from User B resolved User A’s issue/);
  assert.match(demo.view(state).summary.line, /User B taught Continuum → verified demo memory created → User A benefited/);
  // Every timeline sentence that names a teacher matches the stored record.
  for (const e of events) if (/learned from User (A|B)/.test(e.detail)) assert.match(e.detail, /learned from User B/);
});

test('attribution: a user who reuses their own fix is not counted as "someone else benefited"', () => {
  const state = session();
  teach(state, 'A');
  const again = demo.createIssue(state, { user: 'A', ...demo.SCRIPT.userB });
  assert.match(again.attempt.label, /your earlier confirmed resolution/);
  demo.feedback(state, { caseId: again.case.id, worked: true, confirmed: true });
  assert.equal(demo.view(state).summary.userBBenefited, false);
});

test('the guided User A -> specialist -> User B scenario still works and credits User A', () => {
  const state = session();
  const { b } = demo.runGuided(state);
  assert.equal(state.learned.length, 1);
  assert.equal(state.learned[0].originUser, 'A');
  assert.equal(b.status, 'resolved');
  const view = demo.view(state);
  assert.equal(view.summary.userATaught, true);
  assert.equal(view.summary.userBBenefited, true);
  assert.match(view.summary.line, /User A taught Continuum → verified demo memory created → User B benefited/);
  assert.match(view.learned[0].provenance, /User A/);
});

test('nothing is claimed as learned before a customer confirms: a rejected proposal teaches nobody', () => {
  const state = session();
  const c = demo.createIssue(state, { user: 'A', ...demo.SCRIPT.userA }).case;
  demo.feedback(state, { caseId: c.id, worked: false, confirmed: true });
  demo.propose(state, { caseId: c.id, ...SPEC });
  demo.confirm(state, { caseId: c.id, accepted: false, confirmed: true });
  assert.equal(state.learned.length, 0);
  assert.equal(demo.view(state).summary.verifiedMemoryCreated, false);
  assert.ok(!demo.view(state).events.some((e) => e.kind === 'memory_learned'));
});

// ---------------------------------------------------------------------------------------------- Test 22
test('sessions: resets and reads never cross sessions, and ids cannot be guessed', () => {
  const one = session();
  const two = session();
  teach(one, 'A');
  teach(two, 'B');
  assert.notEqual(one.id, two.id);
  assert.ok(one.id.length >= 32);
  demo.reset(one);
  assert.equal(one.learned.length, 0);
  assert.equal(two.learned.length, 1, 'another judge’s session is untouched by this reset');
  assert.equal(two.learned[0].originUser, 'B');
  assert.throws(() => demo.getSession('A'.repeat(32)), /expired or was reset/);
  assert.throws(() => demo.getSession('../../etc/passwd'), /Missing or invalid/);
  assert.equal(demo.getSession(two.id).learned.length, 1);
  demo.destroySession(one.id);
  assert.throws(() => demo.getSession(one.id), /expired or was reset/);
  assert.equal(demo.getSession(two.id).learned.length, 1);
});

test('sessions: a full demo refuses new sessions instead of silently evicting an active one', () => {
  const first = session();
  teach(first, 'A');
  const ids = [first.id];
  while (demo.sessionCount() < demo.MAX_SESSIONS) ids.push(demo.createSession());
  assert.throws(() => demo.createSession(), (e) => e.status === 503 && /busy/.test(e.message));
  assert.equal(demo.getSession(first.id).learned.length, 1, 'the oldest active session survived');
  demo.destroySession(ids.at(-1));
  assert.doesNotThrow(() => demo.createSession(), 'a freed slot is reusable');
  for (const id of ids) demo.destroySession(id);
});

test('sessions: expiry is applied consistently and a restart is explained clearly', () => {
  const state = session();
  state.lastSeen = Date.now() - demo.DEMO_TTL_MS - 1000;
  assert.throws(() => demo.getSession(state.id), /expired or was reset. Start a new one/);
  assert.equal(demo.getSession(demo.createSession()).learned.length, 0);
});
