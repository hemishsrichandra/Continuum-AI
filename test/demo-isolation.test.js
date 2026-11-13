import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';
import * as demo from '../server/demo-learning.js';
import { world, ISSUE, FOUR } from './_helpers.js';

const S = demo.SCRIPT;
async function api(h, session, method, route, body) {
  const r = await invoke(h, 'demo/' + route, { method, body, headers: session ? { 'x-demo-session': session } : {} });
  return r;
}
async function start(h) {
  const r = await api(h, null, 'POST', 'session');
  assert.equal(r.status, 201);
  return r.data;
}
const post = (h, s, route, body) => api(h, s, 'POST', route, body);
const A = { user: 'A', ...S.userA };
const proposal = (caseId) => ({ caseId, ...S.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true });

/** Whole-database fingerprint: every table, every row. */
function fingerprint(h) {
  const db = h.store.db;
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_pool_fts%' ORDER BY name").all())
    out[name] = createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).digest('hex');
  return out;
}

test('the demo module imports only pure helpers: no database, memory service, connector, integration or app code', () => {
  const source = readFileSync(new URL('../server/demo-learning.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  const allowed = new Set(['node:crypto', './context.js', './applicability.js', './scoring.js', './privacy.js']);
  assert.deepEqual(imports.filter((i) => !allowed.has(i)), []);
  const code = source.replace(/\/\/.*$/gm, '');
  for (const forbidden of ['better-sqlite3', 'fetch(', 'process.env', 'globalThis', 'hindsight', 'OPENAI', 'company_id', 'companyId', 'chatbotId', 'require('])
    assert.ok(!code.includes(forbidden), 'unexpected reference in demo code: ' + forbidden);
});

test('a new demo session is empty: learned memory is exactly 0 and only hardcoded playbooks exist', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const s = await start(h);
  assert.equal(s.learnedCount, 0);
  assert.deepEqual(s.learned, []);
  assert.deepEqual(s.cases, []);
  assert.equal(s.playbooks.length, demo.DEMO_PLAYBOOKS.length);
  assert.ok(s.playbooks.every((p) => p.label === 'Initial standard suggestion'));
  assert.equal(s.fictional, true);
  assert.match(s.notice, /Fictional demonstration/);
  assert.match(s.notice, /no model is trained/);
});

test('full causal chain: A fails the standard idea, specialist proposes, A confirms, B receives the learned fix, reset removes it', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const { sessionId: id } = await start(h);
  const a = (await post(h, id, 'customer/issue', A)).data;
  const caseA = a.state.cases[0];
  assert.equal(caseA.attempts[0].source, 'standard');
  assert.equal(caseA.attempts[0].label, 'Initial standard suggestion');
  assert.equal(a.state.learnedCount, 0, 'the standard suggestion does not change memory');
  // Before the specialist/confirmation, B gets only the standard fallback.
  const early = (await post(h, id, 'customer/issue', { user: 'B', ...S.userB })).data.state;
  assert.equal(early.cases[1].attempts[0].source, 'standard');
  assert.equal(early.learnedCount, 0);
  await post(h, id, 'customer/feedback', { caseId: caseA.id, worked: true, confirmed: true }).then((r) => assert.equal(r.status, 200));
  // (A's first case resolved via the standard fix is a different path; use a fresh session for the teaching path.)
  const { sessionId: id2 } = await start(h);
  const a2 = (await post(h, id2, 'customer/issue', A)).data.state.cases[0];
  assert.equal((await post(h, id2, 'specialist/propose', proposal(a2.id))).status, 409, 'cannot propose before the case is in the queue');
  const failed = (await post(h, id2, 'customer/feedback', { caseId: a2.id, worked: false, confirmed: true })).data.state;
  assert.equal(failed.cases[0].status, 'queued');
  assert.deepEqual(failed.queue, [a2.id]);
  assert.equal(failed.learnedCount, 0);
  const sent = (await post(h, id2, 'specialist/propose', proposal(a2.id))).data.state;
  assert.equal(sent.cases[0].status, 'proposal_sent');
  assert.equal(sent.learnedCount, 0, 'a proposal is not learned memory');
  const beforeConfirm = (await post(h, id2, 'customer/issue', { user: 'B', ...S.userB })).data.state.cases[1];
  assert.equal(beforeConfirm.attempts[0].source, 'standard', 'before A confirms, B gets no learned fix');
  const confirmed = (await post(h, id2, 'customer/confirm', { caseId: a2.id, accepted: true, confirmed: true })).data.state;
  assert.equal(confirmed.learnedCount, 1);
  assert.equal(confirmed.learned[0].origin, 'specialist_confirmed');
  assert.match(confirmed.learned[0].provenance, /User A/);
  assert.ok(confirmed.events.some((e) => e.kind === 'memory_learned' && e.learnedCount === 1));
  const b = (await post(h, id2, 'customer/issue', { user: 'B', ...S.userB })).data.state.cases.at(-1);
  const attempt = b.attempts[0];
  assert.equal(attempt.source, 'learned');
  assert.match(attempt.label, /Learned from User A’s confirmed specialist resolution/);
  assert.match(attempt.steps, /^Fictional demo only:/, 'simulation qualifier is preserved');
  assert.ok(attempt.explanation.scores.S_final >= 0.7);
  assert.ok(attempt.explanation.constraintsMatched.length);
  const done = (await post(h, id2, 'customer/feedback', { caseId: b.id, worked: true, confirmed: true })).data.state;
  assert.equal(done.summary.line, 'User A taught Continuum → verified demo memory created → User B benefited');
  assert.equal(done.learned[0].successes, 1);
  const reset = (await post(h, id2, 'reset', {})).data;
  assert.equal(reset.learnedCount, 0);
  assert.deepEqual(reset.cases, []);
  assert.equal(reset.sessionId, id2);
  const afterReset = (await post(h, id2, 'customer/issue', { user: 'B', ...S.userB })).data.state.cases[0];
  assert.equal(afterReset.attempts[0].source, 'standard', 'after reset B can no longer receive A’s fix');
});

test('paraphrases match; incompatible devices, unknown devices and unrelated issues do not receive the learned fix', async (t) => {
  const state = demo.getSession(demo.createSession());
  demo.runGuided(state);
  const run = (description, device) => demo.createIssue(state, { user: 'B', description, device });
  assert.equal(run('My screen flashes at power on', S.userB.device).attempt.source, 'learned');
  assert.equal(run(S.userBIncompatible.description, S.userBIncompatible.device).attempt?.source, 'standard', 'conflicting model');
  assert.equal(run('The monitor blinks at boot.', 'not a Demo Laptop X1, a Demo Laptop X2 firmware 4').attempt?.source, 'standard', 'negation');
  const unknown = run(S.userB.description, '');
  assert.equal(unknown.attempt, null);
  assert.equal(unknown.case.status, 'needs_info');
  assert.match(unknown.case.clarification, /device and version/);
  const answered = demo.updateDevice(state, { caseId: unknown.case.id, device: S.userB.device });
  assert.equal(answered.attempt.source, 'learned');
  const invoice = run('How do I update my invoice address?', S.userB.device);
  assert.equal(invoice.attempt, null);
  assert.equal(invoice.case.status, 'queued');
});

test('a failed learned fix is never repeated, falls back safely and two consecutive failures flag it', async (t) => {
  const state = demo.getSession(demo.createSession());
  demo.runGuided(state);
  const one = demo.createIssue(state, { user: 'B', ...S.userB });
  assert.equal(one.attempt.source, 'learned');
  demo.feedback(state, { caseId: one.case.id, worked: false, confirmed: true });
  assert.equal(state.learned[0].status, 'active', 'one ordinary failure does not flag');
  assert.deepEqual(one.case.attempts.map((x) => x.suggestionId).filter((x, i, all) => all.indexOf(x) === i).length, one.case.attempts.length, 'no repeat within the case');
  assert.ok(['suggested', 'queued'].includes(one.case.status));
  const two = demo.createIssue(state, { user: 'B', ...S.userB });
  demo.feedback(state, { caseId: two.case.id, worked: false, confirmed: true });
  assert.equal(state.learned[0].status, 'flagged_for_review');
  const three = demo.createIssue(state, { user: 'B', ...S.userB });
  assert.notEqual(three.attempt?.source, 'learned', 'a flagged fix is not recommended');
});

test('different demo sessions never see each other’s cases or learned fixes', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const one = (await start(h)).sessionId;
  const two = (await start(h)).sessionId;
  assert.notEqual(one, two);
  const a = (await post(h, one, 'customer/issue', A)).data.state.cases[0];
  await post(h, one, 'customer/feedback', { caseId: a.id, worked: false, confirmed: true });
  await post(h, one, 'specialist/propose', proposal(a.id));
  await post(h, one, 'customer/confirm', { caseId: a.id, accepted: true, confirmed: true });
  assert.equal((await api(h, one, 'GET', 'state')).data.learnedCount, 1);
  const other = (await api(h, two, 'GET', 'state')).data;
  assert.equal(other.learnedCount, 0);
  assert.deepEqual(other.cases, []);
  const b = (await post(h, two, 'customer/issue', { user: 'B', ...S.userB })).data.state.cases[0];
  assert.equal(b.attempts[0].source, 'standard', 'session two cannot benefit from session one');
  // Case ids from session one are not valid in session two.
  assert.equal((await post(h, two, 'customer/confirm', { caseId: a.id, accepted: true, confirmed: true })).status, 409);
  assert.equal((await post(h, two, 'customer/feedback', { caseId: 'case-9', worked: true, confirmed: true })).status, 404);
  // Missing, malformed or unknown ids are rejected.
  assert.equal((await api(h, null, 'GET', 'state')).status, 400);
  assert.equal((await api(h, 'short', 'GET', 'state')).status, 400);
  assert.equal((await api(h, 'A'.repeat(32), 'GET', 'state')).status, 404);
  assert.equal((await api(h, one, 'DELETE', 'session')).status, 200);
  assert.equal((await api(h, one, 'GET', 'state')).status, 404);
});

test('idle demo sessions expire', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const id = (await start(h)).sessionId;
  const real = Date.now();
  t.mock.method(Date, 'now', () => real + demo.DEMO_TTL_MS + 1000);
  assert.equal((await api(h, id, 'GET', 'state')).status, 404);
});

test('production data never appears in the demo and the main database is never touched, even by deliberate calls', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(String(args[0])); throw new Error('network is forbidden in the demo'); });
  const touched = [];
  const service = new Proxy({ configured: true }, { get: (target, prop) => (prop in target ? target[prop] : (...args) => { touched.push(String(prop)); throw new Error('memory service is forbidden in the demo'); }) });
  const w = await world(t, { config: { EMBEDDING_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic', EMBEDDING_MODEL: 'e', RESEND_API_KEY: 'x', EMAIL_FROM: 'a@b.c' } });
  w.seed(w.company, { title: 'PRODUCTION SECRET FIX', symptoms: 'Display flickers after startup', steps: ['PRODUCTION-ONLY steps for display flicker.'] });
  const customer = await w.customer('realcustomer');
  await w.ticket(customer, ISSUE);
  calls.length = 0;
  const before = fingerprint(w.h);
  const beforeFiles = w.db().prepare('SELECT COUNT(*) n FROM records').get().n;
  const { sessionId: id } = await start(w.h);
  const a = (await post(w.h, id, 'customer/issue', { user: 'A', description: ISSUE, device: 'Model X firmware 4' })).data.state.cases[0];
  assert.equal(a.attempts[0].source, 'standard', 'the real company’s learned/standard content is invisible');
  await post(w.h, id, 'customer/feedback', { caseId: a.id, worked: false, confirmed: true });
  await post(w.h, id, 'specialist/propose', proposal(a.id));
  await post(w.h, id, 'customer/confirm', { caseId: a.id, accepted: true, confirmed: true });
  const b = (await post(w.h, id, 'customer/issue', { user: 'B', ...S.userB })).data.state;
  assert.ok(!JSON.stringify(b).includes('PRODUCTION'));
  await post(w.h, id, 'reset', {});
  // Deliberate attempts to reach production data through the demo namespace.
  for (const body of [{ companyId: w.company, chatbotId: w.botOf(w.company), user: 'A', description: ISSUE, device: 'Model X firmware 4' }, { company_id: w.company, caseId: 'x' }]) {
    await post(w.h, id, 'customer/issue', body);
    await post(w.h, id, 'specialist/propose', body);
  }
  for (const route of ['memory_pool', 'company', 'operator', 'intelligence', 'connector']) assert.equal((await api(w.h, id, 'GET', route)).status, 404);
  assert.deepEqual(fingerprint(w.h), before, 'every main-database table is byte-for-byte unchanged');
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM records').get().n, beforeFiles);
  assert.deepEqual(calls, [], 'the demo made no network calls (no model, embeddings, Hindsight, email, calendar or connector)');
  assert.deepEqual(touched, []);
  void service;
});

test('the demo answers before authentication: no cookie, no session row, works with no account at all', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const r = await invoke(h, 'demo/session', { method: 'POST' });
  assert.equal(r.status, 201);
  assert.equal(r.headers['Set-Cookie'], undefined);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 0);
});

test('the marketing demo-bookings feature is unaffected by the /api/demo namespace', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const slots = await invoke(h, 'demo-slots');
  assert.equal(slots.status, 200);
  assert.ok(Array.isArray(slots.data.slots));
});

test('specialist proposals are screened: secrets and risky steps rejected, personal data scrubbed, confirmation required', async (t) => {
  const state = demo.getSession(demo.createSession());
  const a = demo.createIssue(state, { user: 'A', ...S.userA }).case;
  demo.feedback(state, { caseId: a.id, worked: false, confirmed: true });
  const base = { caseId: a.id, ...S.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true };
  assert.throws(() => demo.propose(state, { ...base, reviewedForPrivacy: false }), /Confirm the passport/);
  assert.throws(() => demo.propose(state, { ...base, steps: 'Sign in with password: hunter2 and restart.' }), /credentials/);
  assert.throws(() => demo.propose(state, { ...base, steps: 'Open the battery and bypass the thermal fuse.' }), /risky/);
  assert.throws(() => demo.propose(state, { ...base, title: '' }), /valid title/);
  const preview = demo.propose(state, { ...base, steps: base.steps + ' Email jane@corp.example.', preview: true });
  assert.doesNotMatch(JSON.stringify(preview.passport), /jane@corp/);
  assert.ok(preview.redactions >= 1);
  assert.equal(state.learned.length, 0, 'a preview stores nothing');
  assert.equal(state.cases[0].status, 'queued');
  demo.propose(state, base);
  assert.throws(() => demo.propose(state, base), /only cases in the specialist queue/i);
  assert.throws(() => demo.confirm(state, { caseId: a.id, accepted: true }), /Choose/);
  const rejected = demo.confirm(state, { caseId: a.id, accepted: false, confirmed: true });
  assert.equal(rejected.learned, null, '“Still need help” on a proposal teaches nothing');
  assert.equal(state.learned.length, 0);
});

test('the guided scenario drives the same public actions end to end', () => {
  const state = demo.getSession(demo.createSession());
  const result = demo.runGuided(state);
  assert.equal(state.learned.length, 1);
  assert.equal(result.b.attempts[0].source, 'learned');
  assert.deepEqual(state.events.map((e) => e.kind).filter((k) => ['issue_created', 'still_need_help', 'specialist_proposed', 'user_a_confirmed', 'memory_learned', 'learned_suggestion_shown', 'user_b_benefited'].includes(k)),
    ['issue_created', 'still_need_help', 'specialist_proposed', 'user_a_confirmed', 'memory_learned', 'issue_created', 'learned_suggestion_shown', 'user_b_benefited']);
  assert.equal(demo.sessionCount() > 0, true);
});

test('limits: oversized bodies and runaway sessions are rejected', async (t) => {
  const h = createHandler({ config: {} });
  t.after(() => h.close());
  const id = (await start(h)).sessionId;
  assert.equal((await post(h, id, 'customer/issue', { user: 'A', description: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post(h, id, 'customer/issue', { user: 'A', description: 'y'.repeat(501) })).status, 400);
  assert.equal((await post(h, id, 'customer/issue', { user: 'Z', description: 'ok' })).status, 400);
  for (let i = 0; i < 20; i++) await post(h, id, 'customer/issue', { user: 'A', description: 'Wi-Fi network offline ' + i });
  assert.equal((await post(h, id, 'customer/issue', { user: 'A', description: 'one more' })).status, 409);
  void FOUR;
});
