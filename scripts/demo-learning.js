// Reproducible smoke run of the isolated Interactive Learning Demo (no server, no database, no network).
//   npm run demo:learning            run the scripted scenario and assert the causal chain
//   npm run demo:learning -- --serve open the interactive demo at /demo
import assert from 'node:assert/strict';
import * as demo from '../server/demo-learning.js';

if (process.argv.includes('--serve')) {
  process.env.DATABASE_FILE ||= ':memory:';
  await import('../server/start.js');
  console.log('Interactive Learning Demo: http://localhost:' + (process.env.FRONTEND_PORT || 3000) + '/demo');
} else {
  const state = demo.getSession(demo.createSession());
  assert.equal(state.learned.length, 0, 'a new demo starts with learned memory 0');
  const a = demo.createIssue(state, { user: 'A', ...demo.SCRIPT.userA });
  assert.equal(a.attempt.source, 'standard');
  demo.feedback(state, { caseId: a.case.id, worked: false, confirmed: true });
  assert.equal(state.cases[0].status, 'queued');
  demo.propose(state, { caseId: a.case.id, ...demo.SCRIPT.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true });
  assert.equal(state.learned.length, 0, 'a proposal is not learned memory');
  demo.confirm(state, { caseId: a.case.id, accepted: true, confirmed: true });
  assert.equal(state.learned.length, 1);
  const b = demo.createIssue(state, { user: 'B', ...demo.SCRIPT.userB });
  assert.equal(b.attempt.source, 'learned');
  demo.feedback(state, { caseId: b.case.id, worked: true, confirmed: true });
  for (const e of state.events) console.log(String(e.id).padStart(2), `[memory ${e.learnedCount}]`, e.who.padEnd(15), e.detail);
  console.log('\n' + demo.view(state).summary.line);
  demo.reset(state);
  assert.equal(state.learned.length, 0);
  assert.equal(demo.createIssue(state, { user: 'B', ...demo.SCRIPT.userB }).attempt.source, 'standard');
  console.log('After reset: learned memory 0 and User B no longer receives A’s fix.');
}
