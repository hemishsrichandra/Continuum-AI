import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './_helpers.js';
import { documentText } from '../server/vector-index.js';
import * as demo from '../server/demo-learning.js';

const ISSUE = 'The display flickers after startup on Model X firmware 4. My email is jane.doe@corp.example.';
const SOLUTION = { title: 'Display flicker after startup', environment: 'Model X firmware 4', solution: 'Open Display settings, select the Standard display profile, save and restart the laptop.', safety: 'None identified', safetyReviewed: true, reviewedForPrivacy: true, confirmed: true };

async function propose(w, extra = {}, issue = ISSUE) {
  const a = await w.customer('alice');
  const ticketId = await w.ticket(a, issue);
  const handoff = (await a.api('handoff', { ticketId, summary: issue, confirmed: true })).data;
  const me = (await w.owner.api('auth/session')).data.profile.id;
  await w.owner.api('operator/assign', { handoffId: handoff.id, assignedTo: me, revision: 0, confirmed: true });
  const r = await w.owner.api('operator/resolve', { handoffId: handoff.id, revision: 1, ...SOLUTION, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { a, ticketId, proposal: r.data };
}

test('a proposal needs no symptoms field: the searchable text comes from the customer’s sanitized original issue', async (t) => {
  const w = await world(t);
  const { a, proposal } = await propose(w);
  assert.equal(proposal.passport.symptoms.includes('jane.doe@corp.example'), false, 'personal data is scrubbed');
  assert.match(proposal.passport.symptoms, /display flickers after startup on Model X firmware 4/i);
  await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true });
  const row = w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(proposal.id);
  assert.equal(row.symptoms_text, proposal.passport.symptoms);
  assert.equal(documentText(row), `${row.title}\n${row.symptoms_text}\n${JSON.parse(row.steps_json).join(' ')}`, 'the indexed document is exactly title, issue and steps');
  assert.ok(!/Applies to/.test(documentText(row)), 'applicability stays separate metadata');
});

test('a legacy "symptoms" value from an old client is ignored, never used as a retrieval keyword', async (t) => {
  const w = await world(t);
  const { proposal } = await propose(w, { symptoms: 'zzz secret retrieval keywords zzz' });
  assert.ok(!JSON.stringify(proposal.passport).includes('zzz'));
});

test('a customer issue that carries a credential contributes nothing but the title', async (t) => {
  const w = await world(t);
  const { proposal } = await propose(w, {}, 'Display flickers. My password is api_key = sk-abcdef0123456789');
  assert.ok(!proposal.passport.symptoms.includes('sk-abcdef'));
  assert.equal(proposal.passport.symptoms, 'Display flicker after startup', 'falls back to the title, never an invented quote');
});

test('a revision needs no symptoms and keeps the original issue text', async (t) => {
  const w = await world(t);
  const { a, proposal } = await propose(w);
  await a.api('resolutions/confirm', { id: proposal.id, accepted: true, confirmed: true });
  const before = w.db().prepare('SELECT symptoms_text,version_number FROM memory_pool WHERE id=?').get(proposal.id);
  const r = await w.owner.api('operator/revise', { id: proposal.id, title: 'Reviewed: display flicker', environment: 'Model X firmware 4', solution: 'Switch to the Fixed 60 Hz mode and restart the laptop.', reviewedForPrivacy: true, confirmed: true, version: before.version_number, symptoms: 'ignored' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const next = w.db().prepare("SELECT symptoms_text FROM memory_pool WHERE company_id=? AND source_key=? AND status='active'").get(w.company, 'resolution:' + proposal.id);
  assert.equal(next.symptoms_text, before.symptoms_text);
});

test('the demo specialist form needs no symptoms either; the learned entry derives from User A’s own description', () => {
  const state = demo.getSession(demo.createSession());
  const c = demo.createIssue(state, { user: 'A', description: demo.SCRIPT.userA.description, device: demo.SCRIPT.userA.device }).case;
  demo.feedback(state, { caseId: c.id, worked: false, confirmed: true });
  const { symptoms, ...noSymptoms } = demo.SCRIPT.specialist;
  void symptoms;
  demo.propose(state, { caseId: c.id, ...noSymptoms, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true });
  demo.confirm(state, { caseId: c.id, accepted: true, confirmed: true });
  assert.equal(state.learned[0].symptoms, demo.SCRIPT.userA.description);
  const b = demo.createIssue(state, { user: 'B', description: demo.SCRIPT.userB.description, device: demo.SCRIPT.userB.device }).case;
  assert.ok(b.attempts[0], 'User B is still helped by the learned entry');
});
