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
