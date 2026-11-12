import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/evaluate.js';
import { world } from './_helpers.js';
import { cases } from '../evaluation/cases.js';
import { hardNegatives } from '../evaluation/validation.js';
import { readFileSync } from 'node:fs';
import { tokens, conceptTokens, fuzzyConcept, editDistance } from '../server/context.js';
import { extractMentions } from '../server/applicability.js';
import { localEmbedding, cosine, LOCAL_EMBEDDING_MODEL } from '../server/scoring.js';
import { extractFacts } from '../server/facts.js';

// Recall floors reflect measured results with a little headroom; precision/safety floors are absolute.
// regression/challenge/holdout wording informed the concept map; validation was written afterwards
// and measured once without tuning, so it is the honest out-of-sample figure.
const SETS = [
  { name: 'regression', options: {}, minRecall: 20 },
  { name: 'challenge', options: { challenge: true }, minRecall: 28 },
  { name: 'holdout', options: { holdout: true }, minRecall: 28 },
  { name: 'validation', options: { validation: true }, minRecall: 24 },
  // Typos/slang: `informal` informed the typo matcher; `informal2` was written afterwards and measured once.
  { name: 'informal', options: { informal: true }, minRecall: 22 },
  { name: 'informal2', options: { informal2: true }, minRecall: 23 },
];
for (const { name, options, minRecall } of SETS)
  test(`RAG evaluation (${name}): recall floor ${minRecall}/${name === 'regression' ? 20 : 30}, zero unsafe recommendations, zero memory-off leaks, no repeated failed fix`, async () => {
    const r = await evaluate(options);
    const c = r.counts;
    assert.ok(c.correctMemoryOn >= minRecall, `recall ${c.correctMemoryOn}/${c.positiveQuestions} below ${minRecall}`);
    assert.equal(c.incorrectRecommendations, 0, 'unsafe or wrong recommendations: ' + JSON.stringify(r.cases.flatMap((k) => k.negative.filter((n) => !n.safe).map((n) => n.question))));
    assert.equal(c.correctMemoryOff, 0, 'a fix leaked with memory off');
    assert.equal(c.memoryOffWithheld, c.positiveQuestions);
    assert.equal(c.failedFixRepeated, 0);
  });

async function seeded(t, { environment = '' } = {}) {
  const w = await world(t);
  const bot = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.id === w.botOf(w.company));
  await w.owner.api('company/chatbots', { ...bot, playbooks: [] });
  for (const c of cases) w.seed(w.company, { title: c.title, symptoms: c.symptoms, environment, steps: [c.solution], sourceKey: 'c:' + c.id });
  const retrieve = (text, extra = {}) => w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text, allowedOrigins: ['specialist_confirmed'], ...extra });
  return { w, retrieve };
}

test('precision: near-miss questions that share words with stored fixes receive no suggestion (with a positive control)', async (t) => {
  // Environment-free passports isolate the similarity scoring from the compatibility gate.
  const { retrieve } = await seeded(t);
  const leaks = [];
  for (const q of hardNegatives) if ((await retrieve(q)).eligible.length) leaks.push(q);
  assert.deepEqual(leaks, []);
  // Control: genuine paraphrases DO retrieve in the same setup, so the test can fail.
  for (const q of ['The paper is jammed in the printer.', 'My laptop screen flickers at startup.', 'There is no sound from the speakers.'])
    assert.ok((await retrieve(q)).eligible.length >= 1, 'control failed for: ' + q);
});

test('cross-domain precision: each paraphrase retrieves its own fix first, not another domain’s', async (t) => {
  const { w, retrieve } = await seeded(t);
  const byTitle = Object.fromEntries(cases.map((c) => [c.id, c.title]));
  const probes = { display: 'The panel shakes and strobes when the laptop turns on.', wireless: 'The wifi signal keeps cutting out and I rejoin.', battery: 'The battery depletes much too fast when idle.', printer: 'A sheet is trapped in the printer.', vpn: 'The VPN declines my credentials when I sign in.', audio: 'I cannot hear anything from the speakers.', camera: 'The webcam preview is just black.', storage: 'There is no free space left on the disk.', email: 'My mailbox is not refreshing with new messages.', application: 'The program quits right after I launch it.' };
  for (const [id, q] of Object.entries(probes)) {
    const out = await retrieve(q);
    assert.equal(out.eligible[0]?.row.title, byTitle[id], `${id}: got ${out.eligible.map((e) => e.row.title).join(', ') || 'nothing'}`);
    assert.equal(out.eligible.length, 1, `${id}: no second, unrelated suggestion`);
  }
  void w;
});

test('concept normalisation: multi-word phrases survive, shared concepts dominate paraphrase similarity', () => {
  assert.deepEqual([...conceptTokens('There is no sound at all')].sort(), ['audio', 'silent']);
  assert.ok(tokens('Unplugged, my laptop loses its charge').has('drain'), 'drain is recognised before "charge" is rewritten');
  assert.ok(conceptTokens('Unplugged, my laptop loses its charge').has('battery'));
  const near = cosine(localEmbedding('Display flickers after startup'), localEmbedding('The monitor flashes when booting the notebook'));
  const far = cosine(localEmbedding('Display flickers after startup'), localEmbedding('The printer reports a paper jam'));
  assert.ok(near > 0.6, 'paraphrase similarity ' + near);
  assert.ok(far < 0.2, 'unrelated similarity ' + far);
  assert.ok(near - far > 0.4);
  assert.equal(cosine(localEmbedding('x'), localEmbedding('x')) > 0.99 || cosine(localEmbedding('x'), localEmbedding('x')) === null, true);
});

test('retrieval is deterministic: the same query yields identical ordering and scores', async (t) => {
  const { retrieve } = await seeded(t);
  const a = await retrieve('The screen flickers when the laptop starts and the wifi also drops.');
  const b = await retrieve('The screen flickers when the laptop starts and the wifi also drops.');
  assert.deepEqual(a.eligible.map((e) => [e.id, e.finalScore]), b.eligible.map((e) => [e.id, e.finalScore]));
});

test('rows embedded by an older local model are re-embedded on first use and stay retrievable', async (t) => {
  const { w, retrieve } = await seeded(t);
  w.db().prepare("UPDATE memory_pool SET embedding_model='local-hashed-concepts-v1', embedding_blob=NULL WHERE origin_type='specialist_confirmed'").run();
  assert.ok((await retrieve('The paper is jammed in the printer.')).eligible.length >= 1);
  const upgraded = w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE origin_type='specialist_confirmed' AND embedding_model=? AND embedding_blob IS NOT NULL").get(LOCAL_EMBEDDING_MODEL).n;
  assert.equal(upgraded, cases.length);
});

test('a pending fix is shown again only for messages the hybrid retriever still matches', async (t) => {
  const { w } = await seeded(t, { environment: 'Model X firmware 4' });
  const a = await w.customer('alice');
  const id = await w.ticket(a, 'The display flickers after startup on Model X firmware 4.', 'Model X display');
  const first = (await w.ask(a, id, 'The display flickers after startup on Model X firmware 4.')).data;
  assert.equal(first.attempt?.source, 'learned');
  const reworded = (await w.ask(a, id, 'The picture on the panel keeps shimmering when I power it on.')).data;
  assert.equal(reworded.attempt?.id, first.attempt.id, 'a reworded complaint re-shows the same pending fix');
  assert.equal(reworded.trace.learnedResolutions, 1);
  const unrelated = (await w.ask(a, id, 'How do I update my invoice address?')).data;
  assert.equal(unrelated.trace.learnedResolutions, 0, 'the ticket’s own text cannot make an unrelated message look relevant');
  assert.match(unrelated.reply, /awaiting your outcome/);
  assert.equal(w.db().prepare('SELECT outcome FROM troubleshooting_attempts WHERE id=?').get(first.attempt.id).outcome, 'pending');
});

test('a strong retrieval match makes wording outside the service topic list in scope; truly off-topic requests stay out', async (t) => {
  const { w } = await seeded(t, { environment: 'Model X firmware 4' });
  const a = await w.customer('alice');
  // The ticket and message contain none of the service's topic words.
  const id = await w.ticket(a, 'Model X firmware 4: the visuals shimmer and strobe when I switch it on.', 'Model X problem');
  const strong = (await w.ask(a, id, 'The visuals shimmer and strobe whenever I switch it on, Model X firmware 4.')).data;
  assert.notEqual(strong.workflow?.stage, 'unsupported', strong.reply);
  const other = await w.ticket(a, 'Please tell me about my invoice for the annual plan.', 'Billing question');
  const off = (await w.ask(a, other, 'How do I update my invoice address for the annual plan?')).data;
  assert.equal(off.workflow?.stage, 'unsupported');
  assert.equal(off.trace.learnedResolutions, 0);
});

test('technical sentences that merely mention email are not contact preferences', () => {
  const kinds = (text) => extractFacts(text).filter((f) => f.kind === 'preference').length;
  assert.equal(kinds('Email synchronization has stalled and the message list never refreshes.'), 0);
  assert.equal(kinds('My mail app never updates the inbox.'), 0);
  assert.equal(kinds('Please email me instead of calling.'), 1);
  assert.equal(kinds('I prefer a phone call after 5 pm.'), 1);
  assert.equal(kinds('Do not call me, email me.'), 1);
  assert.equal(kinds('Please speak Spanish when you call.'), 1);
});

test('typo tolerance maps common misspellings but leaves real words alone', () => {
  for (const [typo, concept] of [['disply', 'display'], ['flikers', 'flicker'], ['startp', 'startup'], ['wireles', 'network'], ['conection', 'network'], ['battry', 'battery'], ['speakrs', 'audio'], ['storge', 'storage'], ['mailbx', 'email'], ['aplication', 'application'], ['sofware', 'application'], ['refreshng', 'sync']])
    assert.equal(fuzzyConcept(typo), concept, typo);
  for (const real of ['internal', 'audit', 'block', 'defined', 'falling', 'printed', 'quit', 'stack', 'changing', 'settings', 'online', 'power', 'phone'])
    assert.equal(fuzzyConcept(real), null, real + ' must not be “corrected”');
  assert.equal(editDistance('network', 'netwrok'), 1, 'a transposition is one edit');
  assert.equal(editDistance('internal', 'internet'), 2, 'two edits apart, so never mapped');
});

test('typo audit: no ordinary English word near the vocabulary is silently mapped to a support concept', () => {
  const allowed = new Set(['appliaction', 'applications', 'connections', 'ewpty', 'parer']);
  const words = readFileSync(new URL('./fixtures/fuzzy-neighbours.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
  assert.ok(words.length > 200, 'the audit fixture is present');
  const gained = words.filter((w) => [...conceptTokens(w)].some((c) => !conceptTokens(w, { fuzzy: false }).has(c)));
  assert.deepEqual(gained.filter((w) => !allowed.has(w)), []);
});

test('negation applies only to the mention it directly governs (a stray “never” does not negate a later device)', () => {
  const flags = (text) => extractMentions(text).mentions.map((m) => `${m.key}:${m.value}${m.negated ? ':neg' : ''}`);
  assert.deepEqual(flags('the inbox never updates, Model WRONG firmware 99'), ['model:wrong', 'firmware:99']);
  assert.deepEqual(flags('wifi never works on Model X firmware 4'), ['model:x', 'firmware:4']);
  assert.deepEqual(flags('This is NOT Model X firmware 4'), ['model:x:neg', 'firmware:4:neg']);
  assert.deepEqual(flags('I do not have a Model X. Firmware 4'), ['model:x:neg', 'firmware:4']);
  assert.deepEqual(flags('not on Android 13'), ['android:13:neg']);
});
