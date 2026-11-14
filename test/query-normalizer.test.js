import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery, normalizeWithRules } from '../server/query-normalizer.js';
import { world } from './_helpers.js';

test('a noisy, emotional message becomes a clean technical symptom with urgency kept separate', async () => {
  const n = await normalizeQuery("I have a meeting in 10 mins, this stupid brick won't wake up!");
  assert.ok(n.symptoms.includes('fails to wake from sleep'), JSON.stringify(n.symptoms));
  assert.equal(n.urgency, 'time-sensitive');
  assert.ok(n.components.includes('power'));
  assert.ok(!/stupid|meeting|10 mins/i.test(n.retrievalText), 'emotion and urgency chatter are not searched on: ' + n.retrievalText);
  assert.ok(n.assumptions.some((a) => /brick/.test(a)), 'a figure of speech is recorded as an unconfirmed assumption');
  assert.ok(n.assumptions.some((a) => /urgency/i.test(a)) && !/emergency|safety/i.test(n.symptoms.join(' ')), 'urgency is never read as a safety emergency');
  assert.equal(n.method, 'rules');
  assert.ok(n.ms < 50, 'rules are instant: ' + n.ms);
});

test('synonyms map to one symptom; negations and device facts survive in the searched text', () => {
  assert.deepEqual(normalizeWithRules('my screen is black after startup').symptoms, ['screen remains black']);
  assert.deepEqual(normalizeWithRules('the display flashes and flickers').symptoms, ['screen flickers']);
  const neg = normalizeWithRules('This is not a MacBook Pro, it is a Dell XPS 13 and the screen is black');
  assert.match(neg.retrievalText, /not a MacBook Pro/i, 'the denial is kept');
  assert.match(neg.retrievalText, /Dell XPS 13/);
  assert.match(normalizeWithRules('wifi keeps dropping on Windows 11').retrievalText, /Windows 11/);
  assert.deepEqual(normalizeWithRules('nothing technical here at all').symptoms, []);
});

test('camera unavailable wording is normalized without treating a different failure as the same symptom', () => {
  for (const text of ['Webcam isnt working in M4 Mac', "The camera isn't working", 'Webcam is not turning on in MAC', 'Camera does not work']) {
    const normalized = normalizeWithRules(text);
    assert.ok(normalized.symptoms.includes('webcam not turning on'), text);
    assert.ok(normalized.retrievalText.includes(text), 'keep the original words and device facts');
  }
  for (const text of ['The webcam freezes during calls', 'The camera works but the microphone does not work', 'The laptop is not turning on', 'The webcam is not failing to turn on'])
    assert.ok(!normalizeWithRules(text).symptoms.includes('webcam not turning on'), text);
});

test('a confirmed webcam fix is offered to a second customer who says isnt working after supplying Mac M4 details', async (t) => {
  const w = await world(t, { choose: true });
  const alice = await w.customer('webcam-alice'), bob = await w.customer('webcam-bob');
  const original = 'Webcam is not turning on in MAC';
  const aliceTicket = await w.ticket(alice, original, 'Webcam issue');
  const handoff = (await alice.api('handoff', {ticketId: aliceTicket, summary: original, confirmed: true})).data;
  const ownerId = (await w.owner.api('auth/session')).data.profile.id;
  assert.equal((await w.owner.api('operator/assign', {handoffId: handoff.id, assignedTo: ownerId, revision: 0, confirmed: true})).status, 200);
  const proposed = await w.owner.api('operator/resolve', {handoffId: handoff.id, revision: 1, title: 'Webcam Not Working', environment: 'Mac, M4', solution: 'Reboot Mac > Clean Camera > Open Camera Lid', reviewedForPrivacy: true, confirmed: true});
  assert.equal(proposed.status, 201);
  assert.equal((await alice.api('resolutions/confirm', {id: proposed.data.id, accepted: true, confirmed: true})).status, 200);

  const question = 'Webcam isnt working in M4 Mac';
  const ticket = await w.ticket(bob, question, 'Webcam isnt working');
  const first = (await w.ask(bob, ticket, question)).data;
  assert.equal(first.workflow.stage, 'context');
  const reply = await w.ask(bob, ticket, 'Here are my details.', {context: {environment: 'Mac, M4'}});
  assert.equal(reply.status, 200);
  assert.equal(reply.data.workflow.stage, 'learned_choices');
  assert.ok(reply.data.choices.some(c => c.id === proposed.data.id));
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM troubleshooting_attempts WHERE customer_id=? AND source=\'learned\'').get(bob.id).n, 0, 'a suggestion is not a tried fix');

  const other = await w.ticket(bob, 'Webcam isnt working on Windows 11', 'Webcam issue');
  const incompatible = (await w.ask(bob, other, 'Webcam isnt working on Windows 11', {context: {environment: 'Windows 11'}})).data;
  assert.ok(!incompatible.choices?.some(c => c.id === proposed.data.id), 'Mac fix stays scoped to its environment');

  const escalated = await w.ticket(bob, question, 'Already with specialist');
  await bob.api('handoff', {ticketId: escalated, summary: question, confirmed: true});
  const waiting = (await w.ask(bob, escalated, question, {context: {environment: 'Mac, M4'}})).data;
  assert.equal(waiting.workflow.stage, 'human', 'do not silently remove an existing specialist handoff');
});

test('personal data is removed before anything reaches a provider', async () => {
  let seen = '';
  const provider = async (text) => { seen = text; return { retrievalText: text, symptoms: [] }; };
  await normalizeQuery('My laptop screen is black. Email me at jane.doe@corp.example or call +91 98765 43210.', { provider });
  assert.ok(seen && !/jane\.doe|98765/.test(seen), 'the provider saw: ' + seen);
});

test('a model answer is used only if it keeps every device fact; otherwise the rules take over', async () => {
  const msg = 'The display flickers on my Dell XPS 13 and it is not a MacBook';
  const good = await normalizeQuery(msg, { provider: async (t) => ({ retrievalText: 'screen flickers; ' + t, symptoms: ['screen flickers'] }) });
  assert.equal(good.method, 'model');
  const changed = await normalizeQuery(msg, { provider: async () => ({ retrievalText: 'screen flickers on a MacBook Pro 16 M2' }) });
  assert.equal(changed.method, 'rules');
  assert.match(changed.fallbackReason, /device fact/);
  const dropped = await normalizeQuery(msg, { provider: async () => ({ retrievalText: 'screen flickers' }) });
  assert.equal(dropped.method, 'rules', 'dropping the device or the negation is rejected');
});

test('provider failure, timeout and nonsense all fall back safely and quickly', async () => {
  const msg = 'The display flickers after startup on the laptop';
  assert.match((await normalizeQuery(msg, { provider: async () => { throw new Error('boom'); } })).fallbackReason, /failed/);
  const t0 = performance.now();
  const slow = await normalizeQuery(msg, { timeoutMs: 60, provider: () => new Promise(() => {}) });
  assert.equal(slow.method, 'rules');
  assert.match(slow.fallbackReason, /in time/);
  assert.ok(performance.now() - t0 < 500, 'the wait is bounded');
  assert.equal((await normalizeQuery(msg, { provider: async () => ({ retrievalText: 'x'.repeat(5000) }) })).method, 'rules');
  assert.equal((await normalizeQuery(msg, { provider: async () => null })).method, 'rules');
  assert.equal((await normalizeQuery('hi', { provider: async () => { throw new Error('must not be called for tiny input'); } })).method, 'rules');
});

const NOISY = 'My Model X firmware 4 laptop will not wake up. I have a meeting in 10 mins, this stupid thing is a brick!!';
const seedFix = (w) => w.seed(w.company, { title: 'Laptop fails to wake from sleep', symptoms: 'The laptop will not wake up. It fails to wake from sleep and the screen remains black', steps: ['Hold the power button for ten seconds, release, then press it again to start the laptop.'], sourceKey: 'n:1' });

test('measured: de-noising raises the match score of the right fix for a noisy complaint (it never lowers it)', async (t) => {
  const w = await world(t);
  const fix = seedFix(w);
  const score = async (text) => {
    const r = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text, factsText: NOISY });
    return [...r.eligible, ...(r.rejected || [])].map((c) => ({ id: c.id, s: c.finalScore ?? c.S_final })).find((c) => c.id === fix.id)?.s ?? 0;
  };
  const raw = await score(NOISY);
  const normalized = await score((await normalizeQuery(NOISY)).retrievalText);
  console.log(`normalizer gain on this example: S_final ${raw.toFixed(3)} -> ${normalized.toFixed(3)}`);
  assert.ok(normalized >= raw, `normalized ${normalized} vs raw ${raw}`);
});

test('end to end: a noisy complaint is answered with the right fix, and the raw message is stored as written', async (t) => {
  const w = await world(t);
  seedFix(w);
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, NOISY);
  const r = (await w.ask(cust, ticket, NOISY)).data;
  assert.equal(r.workflow.stage, 'learned_pending', JSON.stringify(r.workflow));
  assert.match(r.reply, /power button/i);
  const stored = (await cust.api('conversation?ticketId=' + ticket)).data.messages.at(-1);
  assert.match(stored.message, /stupid thing is a brick!!/, 'the customer\'s own words are kept as written');
});
