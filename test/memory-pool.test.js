import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world, ISSUE, FOUR } from './_helpers.js';

const fts = (db, q) => db.prepare('SELECT memory_id FROM memory_pool_fts WHERE memory_pool_fts MATCH ?').all(q).map((r) => r.memory_id);

test('FTS5 index stays in sync on insert, update, status change and delete', async (t) => {
  const w = await world(t);
  const row = w.seed(w.company, { title: 'Zebra display fault', symptoms: 'Zebra panel stripes', steps: ['Reseat the zebra cable carefully and restart.'] });
  assert.deepEqual(fts(w.db(), 'zebra'), [row.id]);
  assert.deepEqual(fts(w.db(), 'reseat'), [row.id], 'steps are indexed');
  w.db().prepare('UPDATE memory_pool SET title=? WHERE id=?').run('Quokka display fault', row.id);
  assert.deepEqual(fts(w.db(), 'zebra'), [row.id], 'symptoms still contain zebra');
  assert.deepEqual(fts(w.db(), 'quokka'), [row.id]);
  w.db().prepare("UPDATE memory_pool SET steps_json=? WHERE id=?").run(JSON.stringify(['Replace the panel.']), row.id);
  assert.deepEqual(fts(w.db(), 'reseat'), []);
  assert.deepEqual(fts(w.db(), 'panel'), [row.id]);
  w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(row.id);
  // A retired row may stay indexed; it is never returned because retrieval filters on the base table.
  const out = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'Quokka display fault Model X firmware 4' });
  assert.deepEqual(out.eligible, []);
  w.db().prepare('DELETE FROM memory_pool WHERE id=?').run(row.id);
  assert.deepEqual(fts(w.db(), 'quokka'), []);
  // Standard playbooks and nothing else remain, each indexed exactly once.
  const rows = w.db().prepare('SELECT COUNT(*) n FROM memory_pool').get().n;
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool_fts').get().n, rows);
});

test('retrieval is company- and service-scoped: no cross-tenant or cross-chatbot leakage', async (t) => {
  const w = await world(t);
  w.seed(w.companyB, { title: 'Company B secret fix', symptoms: 'Display flickers after startup', steps: ['Company B private steps for display flicker.'] });
  w.seed(w.company, { title: 'IT only display', symptoms: 'Display flickers after startup', steps: ['IT desk steps for display flicker.'], chatbotId: w.botOf(w.company, 'it'), sourceKey: 'it-1' });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const r = (await w.ask(a, id, ISSUE)).data;
  await w.ask(a, id, 'Still need help');
  const text = JSON.stringify((await w.ask(a, id, 'Continue troubleshooting')).data);
  assert.doesNotMatch(text, /Company B private|IT desk steps/);
  const direct = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: ISSUE });
  assert.equal(direct.eligible.length, 0);
  const crafted = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.companyB), text: ISSUE });
  assert.equal(crafted.eligible.length, 0, 'a chatbot id from another company yields nothing');
  assert.ok(r);
});

test('company owners cannot review, revise or list another company’s passports (direct-ID attacks)', async (t) => {
  const w = await world(t);
  const row = w.seed(w.company, { title: 'Company A fix', symptoms: 'Display flickers after startup', steps: ['Company A steps for flicker.'] });
  const review = await w.other.api('operator/review-resolution', { id: row.id, decision: 'retire', note: 'x', confirmed: true });
  assert.ok([404, 409].includes(review.status), 'status ' + review.status);
  assert.equal(w.db().prepare('SELECT status FROM memory_pool WHERE id=?').get(row.id).status, 'active');
  const lib = (await w.other.api('operator')).data;
  assert.ok(!JSON.stringify(lib).includes('Company A'));
  const revise = await w.other.api('operator/revise', { id: row.id, title: 't', symptoms: 'sss sss sss', environment: 'Model X', solution: 'Steps steps steps steps.', reviewedForPrivacy: true, confirmed: true });
  assert.ok([404, 409, 400].includes(revise.status));
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM memory_pool WHERE lineage_id=?').get(row.id).n, 1);
});

test('main flow: standard first, then at most three distinct ranked memory fixes, then a specialist', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const w = await world(t, { file: join(dir, 'flow.sqlite') });
  // Standard playbook that applies to this issue.
  const bot = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.id === w.botOf(w.company));
  await w.owner.api('company/chatbots', { ...bot, playbooks: [{ id: 'display-basic', version: 1, topics: ['display', 'flicker'], steps: 'Unplug the charger, wait ten seconds and plug it in again.' }] });
  for (const [i, [title, symptoms, steps]] of FOUR.entries()) w.seed(w.company, { title, symptoms, steps: [steps], sourceKey: 'k' + i });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const std = (await w.ask(a, id, ISSUE)).data;
  assert.equal(std.attempt.source, 'standard');
  assert.equal(std.trace.learnedResolutions, 0);
  assert.match(std.reply, /Unplug the charger/);
  // A refresh or unrelated message never counts as an outcome and never repeats/advances.
  const again = (await w.ask(a, id, 'Thanks')).data;
  assert.equal(again.attempt.id, std.attempt.id);
  const seen = [];
  let step = (await w.ask(a, id, 'Still need help')).data;
  for (let n = 1; n <= 3; n++) {
    assert.equal(step.attempt.source, 'learned', 'suggestion ' + n);
    assert.equal(step.attempt.sequence, n);
    assert.equal(step.trace.learnedResolutions, 1);
    assert.ok(step.learnedSource.label);
    assert.ok(step.evidence[0].score.S_final >= 0.7);
    seen.push(step.attempt.memory_id);
    // Reload mid-way: the same pending fix is shown, not a new one.
    if (n === 2) {
      w.restart();
      const reloaded = (await w.ask(a, id, 'The display flickers after startup')).data;
      assert.equal(reloaded.attempt.id, step.attempt.id);
    }
    step = (await w.ask(a, id, 'Still need help')).data;
  }
  assert.equal(new Set(seen).size, 3, 'three distinct fixes');
  assert.equal(step.workflow.stage, 'human', 'after three, the case goes to a specialist');
  const attempts = w.db().prepare("SELECT source,sequence,outcome FROM troubleshooting_attempts ORDER BY created_at").all();
  assert.deepEqual(attempts.map((x) => x.outcome), ['failed', 'failed', 'failed', 'failed']);
  const queue = (await w.owner.api('operator')).data;
  assert.equal(queue.cases.length, 1);
  const events = w.h.followThrough.timeline(w.company, w.botOf(w.company), id).map((e) => e.kind);
  assert.ok(events.includes('suggestion_offered') && events.includes('escalated_to_specialist'));
});

test('fewer qualifying fixes lead to earlier handoff; human help bypasses suggestions', async (t) => {
  const w = await world(t);
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const first = (await w.ask(a, id, ISSUE)).data;
  assert.equal(first.attempt.source, 'learned');
  const next = (await w.ask(a, id, 'Still need help')).data;
  assert.equal(next.workflow.stage, 'human');
  const b = await w.customer('bob');
  const idB = await w.ticket(b, ISSUE);
  const bypass = (await w.ask(b, idB, 'I need human help')).data;
  assert.equal(bypass.action.kind, 'handoff');
  assert.equal(bypass.trace.learnedResolutions, 0);
});

test('explicit feedback is required: silence or a reaction never counts as success', async (t) => {
  const w = await world(t);
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const first = (await w.ask(a, id, ISSUE)).data;
  for (const m of ['great thanks', 'ok', 'Helpful']) await w.ask(a, id, m);
  assert.equal(w.db().prepare('SELECT outcome FROM troubleshooting_attempts WHERE id=?').get(first.attempt.id).outcome, 'pending');
  assert.notEqual((await a.api('status?ticketId=' + id)).data.status, 'Resolved');
  const worked = (await w.ask(a, id, 'It worked')).data;
  assert.equal(worked.workflow.stage, 'resolved');
  assert.equal(w.db().prepare('SELECT reuse_success_count c FROM memory_pool WHERE id=?').get(first.attempt.memory_id).c, 1);
});

test('unsafe, incompatible, negated and unknown-environment candidates are excluded even with high semantic scores', async (t) => {
  const w = await world(t);
  w.seed(w.company, { title: 'Android only display fix', symptoms: 'Display flickers after startup', environment: 'Android 13', steps: ['Android specific step for display flicker.'], sourceKey: 'and' });
  w.seed(w.company, { title: 'Model Y display fix', symptoms: 'Display flickers after startup', environment: 'Model Y firmware 4', steps: ['Model Y specific step for display flicker.'], sourceKey: 'y' });
  w.seed(w.company, { title: 'Battery-safe display fix', symptoms: 'Display flickers after startup', steps: ['Run the display calibration tool for flicker.'], safety: { restrictions: [{ text: 'Never use with a swollen battery', keywords: ['swollen'] }] }, sourceKey: 'safe' });
  const retrieve = (text) => w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text });
  const titles = async (text) => (await retrieve(text)).eligible.map((c) => c.row.title);
  assert.deepEqual(await titles('Display flickers after startup on Pixel running Android 12'), [], 'wrong Android version');
  assert.deepEqual(await titles('Display flickers after startup on Pixel running Android 13'), ['Android only display fix']);
  assert.deepEqual(await titles('Display flickers after startup on a Model X firmware 4'), ['Battery-safe display fix']);
  assert.deepEqual(await titles('Display flickers after startup. This is not a Model X, it is Model Y firmware 4'), ['Model Y display fix']);
  assert.deepEqual(await titles('Display flickers after startup on Model X firmware 4 and the battery is swollen'), [], 'safety restriction and hazard');
  const unknown = await retrieve('Display flickers after startup');
  assert.deepEqual(unknown.eligible, []);
  assert.ok(unknown.withheld.length, 'unknown required fields are withheld for clarification');
});

test('standard playbook content is excluded from learned recommendations in the same ticket', async (t) => {
  const w = await world(t);
  const same = 'Unplug the charger, wait ten seconds and plug it in again to stop the display flicker.';
  const bot = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.id === w.botOf(w.company));
  await w.owner.api('company/chatbots', { ...bot, playbooks: [{ id: 'display-basic', version: 1, topics: ['display', 'flicker'], steps: same }] });
  w.seed(w.company, { title: 'Imported duplicate of the standard playbook', symptoms: 'Display flickers after startup', steps: [same], origin: 'company_db_sync', sourceKey: 'dup' });
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  const std = (await w.ask(a, id, ISSUE)).data;
  assert.equal(std.attempt.source, 'standard');
  const next = (await w.ask(a, id, 'Still need help')).data;
  assert.equal(next.workflow.stage, 'human', 'identical content is not recommended again');
});

test('unified pool holds standard playbooks and is idempotent when playbooks are saved repeatedly', async (t) => {
  const w = await world(t);
  const count = () => w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE company_id=? AND origin_type='standard_playbook'").get(w.company).n;
  const before = count();
  assert.ok(before >= 3);
  const bot = (await w.owner.api('company/chatbots')).data.chatbots.find((b) => b.id === w.botOf(w.company));
  await w.owner.api('company/chatbots', { ...bot });
  await w.owner.api('company/chatbots', { ...bot, revision: bot.revision + 1 });
  assert.equal(count(), before);
});

test('migration is idempotent and survives restart with file-backed storage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-pool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const w = await world(t, { file: join(dir, 'p.sqlite') });
  const row = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  w.restart();
  w.restart();
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
  assert.equal(w.db().prepare('SELECT id FROM memory_pool WHERE id=?').get(row.id).id, row.id);
  assert.deepEqual(w.db().pragma('foreign_key_check'), []);
});

test('a configured remote embedding backend is used for semantic matches without lexical overlap', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    const input = JSON.parse(options.body).input;
    // Both the passport and the paraphrase land on the same direction; invoices elsewhere.
    return Response.json({ data: input.map((x, i) => ({ index: i, embedding: /invoice/i.test(x) ? [0, 0, 1] : /Standard playbook/i.test(x) ? [0, 1, 0] : [1, 0, 0] })) });
  });
  const w = await world(t, { config: { OPENAI_API_KEY: 'synthetic', EMBEDDING_MODEL: 'test-embedding' } });
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const near = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'A strobing panel appears as the computer wakes. Model X firmware 4' });
  assert.equal(near.backend, 'test-embedding');
  assert.equal(near.eligible.length, 1);
  assert.ok(calls.every((u) => u.endsWith('/embeddings')));
  const far = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'How do I update my invoice? Model X firmware 4' });
  assert.equal(far.eligible.length, 0);
});

test('embedding backend failure falls back to the offline representation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const w = await world(t, { config: { OPENAI_API_KEY: 'synthetic', EMBEDDING_MODEL: 'test-embedding' } });
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]] });
  const out = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: ISSUE });
  assert.equal(out.backend, 'local-hashed-concepts-v2');
  assert.equal(out.eligible.length, 1);
});
