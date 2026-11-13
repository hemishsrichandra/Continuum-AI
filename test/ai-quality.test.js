import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { world, ISSUE, FOUR } from './_helpers.js';
import { checkGrounded, createFixExplainer, templateWhy } from '../server/fix-explainer.js';
import { staleFixes } from '../server/stale-fixes.js';
import { intelligenceFor } from '../server/intelligence.js';

const FIX = { id: 'm1', version: 1, title: 'Display flicker: adaptive refresh', symptoms: 'Display flickers after startup', steps: ['Disable adaptive refresh in Display settings and restart the laptop.'], reasons: ['Model X'] };
const reply = (content) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

// ---------------------------------------------------------------- grounded explanations
test('a grounded sentence passes; invented numbers, links, commands, extra sentences and foreign words are rejected', () => {
  const source = 'Display flicker: adaptive refresh. Display flickers after startup. Disable adaptive refresh in Display settings and restart the laptop. My screen flickers on boot.';
  assert.equal(checkGrounded('Your screen flickers at startup, and this fix turns off adaptive refresh, which is what the steps change.', source).ok, true);
  assert.equal(checkGrounded('This fix sets the refresh rate to 144 Hz.', source).ok, false, 'a number that is not stored');
  assert.equal(checkGrounded('Open https://evil.example/fix and run it.', source).ok, false, 'a link');
  assert.equal(checkGrounded('Run sudo reboot after turning off adaptive refresh.', source).ok, false, 'a command');
  assert.equal(checkGrounded('It matches your flicker. It also reinstalls the firmware.', source).ok, false, 'two sentences');
  assert.equal(checkGrounded('This replaces the motherboard capacitors preventing electrical oscillation anomalies.', source).ok, false, 'mostly words that are not in the stored text');
  assert.equal(checkGrounded('', source).ok, false);
});

test('the explainer uses the model only when it stays grounded, and always falls back to the template', async () => {
  const cfg = { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'm' };
  const customer = 'My screen flickers on boot';
  const ok = createFixExplainer(cfg, { fetchImpl: reply('Your screen flickers at startup, and this fix turns off adaptive refresh in Display settings.') });
  assert.deepEqual(await ok.explain(FIX, customer).then((r) => r.method), 'model');
  const invented = createFixExplainer(cfg, { fetchImpl: reply('This fix also updates your BIOS to version 9.9.') });
  const r = await invented.explain(FIX, customer);
  assert.equal(r.method, 'template');
  assert.equal(r.text, templateWhy(FIX), 'the template only restates stored fields');
  assert.equal(invented.stats().rejected, 1);
  const failing = createFixExplainer(cfg, { fetchImpl: async () => { throw new Error('network'); } });
  assert.equal((await failing.explain(FIX, customer)).method, 'template');
  const offline = createFixExplainer({}, { fetchImpl: reply('should never be called') });
  assert.equal((await offline.explain(FIX, customer)).method, 'template', 'no key, no model call');
});

test('the customer text is scrubbed before it reaches the model, and credential-like text is never sent', async () => {
  const sent = [];
  const fetchImpl = async (url, o) => { sent.push(JSON.parse(o.body).messages[1].content); return reply('Your screen flickers at startup, matching this stored fix.')(); };
  const e = createFixExplainer({ OPENAI_API_KEY: 'k' }, { fetchImpl });
  await e.explain(FIX, 'My screen flickers. Email me at jane.doe@example.com or call 555-123-4567.');
  assert.ok(sent.length === 1 && !/jane\.doe|555-123/.test(sent[0]), sent[0]);
  await e.explain({ ...FIX, id: 'm2' }, 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789 and my screen flickers');
  assert.ok(!sent.some((s) => /sk-abcdef/.test(s)), 'a secret never leaves the server');
});

test('a recommendation carries a grounded "why this fits" sentence and the stored steps are untouched', async (t) => {
  const seen = [];
  const w = await world(t, { config: { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', __explainFetch: async (u, o) => { seen.push(o); return reply('Your display flickers after startup, which is the problem this stored fix addresses.')(); } } });
  w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'x:0' });
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  const r = (await w.ask(cust, ticket, ISSUE)).data;
  assert.equal(r.whyFits.method, 'model');
  assert.match(r.whyFits.text, /flickers/);
  assert.equal(r.evidence[0].text, FOUR[0][2], 'the reviewed steps are shown exactly as stored');
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------- near-miss learning
async function twoFixes(t) {
  const w = await world(t);
  const a = w.seed(w.company, { title: 'Display flicker: adaptive refresh', symptoms: 'Display flickers after startup', steps: ['Disable adaptive refresh in Display settings and restart the laptop.'], environment: 'Model X', sourceKey: 'nm:a' });
  const b = w.seed(w.company, { title: 'Display flicker: driver update', symptoms: 'Display flickers after startup', steps: ['Install the approved display driver from the vendor support site.'], environment: 'Model X', sourceKey: 'nm:b' });
  const pool = w.h.memoryPool;
  const ask = (text) => pool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text });
  return { w, a, b, pool, ask };
}

test('near-misses lower a fix only for customers in a similar situation', async (t) => {
  const { w, a, pool, ask } = await twoFixes(t);
  const baseFw5 = (await ask('Display flickers after startup on Model X firmware 5')).eligible.find((c) => c.id === a.id).breakdown.S_final;
  for (let i = 0; i < 3; i++) pool.recordNearMiss({ companyId: w.company, chatbotId: w.botOf(w.company), memoryId: a.id, ticketId: 't' + i, reason: 'no_change', factsText: 'Display flickers on Model X firmware 5' });
  const fw5 = (await ask('Display flickers after startup on Model X firmware 5')).eligible.find((c) => c.id === a.id).breakdown;
  const fw4 = (await ask('Display flickers after startup on Model X firmware 4')).eligible.find((c) => c.id === a.id).breakdown;
  assert.ok(fw5.nearMissPenalty > 0 && fw5.S_final < baseFw5, 'demoted for the same firmware');
  assert.equal(fw4.nearMissPenalty, undefined, 'untouched for a different firmware');
  const ranked = (await ask('Display flickers after startup on Model X firmware 5')).eligible.map((c) => c.id);
  assert.equal(ranked[0] === a.id, false, 'the other fix now leads for firmware 5 customers');
});

test('near-miss weights follow the reason, are capped, idempotent per ticket, and reject secrets', async (t) => {
  const { w, a, pool } = await twoFixes(t);
  const base = { companyId: w.company, chatbotId: w.botOf(w.company), memoryId: a.id, factsText: 'Model X firmware 5' };
  pool.recordNearMiss({ ...base, ticketId: 't1', reason: 'made_worse' });
  pool.recordNearMiss({ ...base, ticketId: 't1', reason: 'no_change' });
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM fix_near_misses').get().n, 1, 'one record per ticket');
  assert.equal(w.db().prepare('SELECT reason FROM fix_near_misses').get().reason, 'no_change', 'the latest answer wins');
  pool.recordNearMiss({ ...base, ticketId: 't2', reason: 'nonsense-reason' });
  assert.ok(w.db().prepare("SELECT 1 FROM fix_near_misses WHERE reason='unspecified'").get(), 'unknown reasons are stored as unspecified');
  assert.throws(() => pool.recordNearMiss({ ...base, ticketId: 't3', reason: 'no_change', detail: 'token sk-abcdefghijklmnopqrstuvwxyz0123456789' }), /credentials/i);
  for (let i = 0; i < 20; i++) pool.recordNearMiss({ ...base, ticketId: 'c' + i, reason: 'made_worse' });
  const r = await pool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.company), text: 'Display flickers after startup on Model X firmware 5' });
  assert.ok(r.eligible.find((c) => c.id === a.id)?.breakdown.nearMissPenalty <= 0.12, 'the penalty is capped');
  assert.equal(w.db().prepare('SELECT facts_json FROM fix_near_misses LIMIT 1').get().facts_json.includes('@'), false);
});

test('"Still need help" with a reason is remembered with the device facts and never the customer', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'nm:flow' });
  const cust = await w.customer('alice');
  const ticket = await w.ticket(cust, ISSUE);
  const first = (await w.ask(cust, ticket, ISSUE)).data;
  const out = await cust.api('troubleshooting/outcome', { attemptId: first.attempt.id, worked: false, confirmed: true, reason: 'different_problem', reasonNote: 'It is the external monitor that flickers' });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const row = w.db().prepare('SELECT * FROM fix_near_misses').get();
  assert.equal(row.memory_id, fix.id);
  assert.equal(row.reason, 'different_problem');
  assert.deepEqual(JSON.parse(row.facts_json).sort(), JSON.parse(row.facts_json), 'facts are stored as sorted key:value pairs');
  assert.ok(JSON.parse(row.facts_json).some((f) => f.startsWith('firmware:')), row.facts_json);
  assert.equal(JSON.stringify(row).includes(cust.id), false, 'no customer id is stored with the near-miss');
});

// ---------------------------------------------------------------- stale fixes and the repeat-problem metric
function outcomes(w, memoryId, list, { daysAgo = 1, context = {} } = {}) {
  const sql = w.db();
  list.forEach((ok, i) => {
    const at = new Date(Date.now() - (daysAgo + (list.length - i)) * 3600000).toISOString();
    sql.prepare(`INSERT INTO troubleshooting_attempts(id,company_id,chatbot_id,customer_id,ticket_id,source,sequence,fix_id,memory_id,snapshot,context,outcome,created_at,outcome_at)
      VALUES(?,?,?,?,?,'learned',1,?,?,'{}',?,?,?,?)`).run(randomUUID(), w.company, w.botOf(w.company), 'c' + i + memoryId, 't' + i + memoryId, memoryId, memoryId, JSON.stringify(context), ok ? 'succeeded' : 'failed', at, at);
  });
}

test('a clear drop in recent success is reported as a stale fix; a steady record is not', async (t) => {
  const w = await world(t);
  const sliding = w.seed(w.company, { title: 'Sliding fix', symptoms: 'a', steps: ['Restart the laptop.'], sourceKey: 's:1' });
  const steady = w.seed(w.company, { title: 'Steady fix', symptoms: 'b', steps: ['Restart the router.'], sourceKey: 's:2' });
  outcomes(w, sliding.id, [true, true, true, true, false, false, false]);
  outcomes(w, steady.id, [true, true, true, true, true, false, true]);
  const found = staleFixes(w.h.store, w.company);
  assert.deepEqual(found.map((f) => f.id), [sliding.id]);
  assert.equal(found[0].signals[0].kind, 'success_drop');
});

test('a fix that covers an older version is flagged when several recent customers report a newer one', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: 'Old firmware fix', symptoms: 'a', steps: ['Restart the laptop.'], environment: 'Model X firmware 4', sourceKey: 'v:1' });
  outcomes(w, fix.id, [true, true, true], { context: { environment: 'Model X firmware 6' } });
  const found = staleFixes(w.h.store, w.company);
  assert.equal(found[0]?.signals.find((s) => s.kind === 'version_lag')?.kind, 'version_lag');
  assert.match(found[0].signals.find((s) => s.kind === 'version_lag').detail, /firmware 6/);
});

test('version lag only counts customers on the same model as the fix', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: 'Model R fix', symptoms: 'a', steps: ['Restart the router.'], environment: 'Model R firmware 2', sourceKey: 'v:r' });
  outcomes(w, fix.id, [true, true, true, true], { context: { environment: 'Model X firmware 6' } });
  assert.equal(staleFixes(w.h.store, w.company).length, 0, 'firmware 6 on a Model X says nothing about a Model R fix');
  const fix2 = w.seed(w.company, { title: 'Model R fix two', symptoms: 'b', steps: ['Restart the laptop.'], environment: 'Model R firmware 2', sourceKey: 'v:r2' });
  outcomes(w, fix2.id, [true, true, true], { context: { environment: 'Model R firmware 5' } });
  const found = staleFixes(w.h.store, w.company);
  assert.deepEqual(found.map((f) => f.id).sort(), [fix.id, fix2.id].sort(), 'once Model R customers report firmware 5, every Model R fix that covers only firmware 2 is flagged');
  assert.match(found[0].signals[0].detail, /same model/);
});

test('an unconfirmed fix nobody has touched for a long time asks for a fresh look', async (t) => {
  const w = await world(t);
  const fix = w.seed(w.company, { title: 'Imported fix', symptoms: 'a', steps: ['Restart the laptop.'], origin: 'company_db_sync', sourceKey: 'o:1' });
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  w.db().prepare('UPDATE memory_pool SET created_at=?, updated_at=? WHERE id=?').run(old, old, fix.id);
  assert.equal(staleFixes(w.h.store, w.company)[0].signals[0].kind, 'not_reconfirmed');
  assert.equal(staleFixes(w.h.store, w.company, { at: Date.now() - 399 * 86400000 }).length, 0, 'recent enough at that earlier date');
});

test('the repeat-problem metric splits requests at the first reusable fix and labels sample companies', async (t) => {
  const w = await world(t);
  const sql = w.db();
  const bot = w.botOf(w.company);
  const insert = (ticket, at, outcome) => sql.prepare(`INSERT INTO troubleshooting_attempts(id,company_id,chatbot_id,customer_id,ticket_id,source,sequence,fix_id,memory_id,snapshot,context,outcome,created_at,outcome_at)
    VALUES(?,?,?,?,?,'standard',1,'p',NULL,'{}','{}',?,?,?)`).run(randomUUID(), w.company, bot, 'cust' + ticket, ticket, outcome, at, at);
  const fix = w.seed(w.company, { title: 'First learned fix', symptoms: 'a', steps: ['Restart the laptop.'], sourceKey: 'm:1' });
  const t0 = Date.parse('2026-01-10T00:00:00Z');
  sql.prepare('UPDATE memory_pool SET created_at=? WHERE id=?').run(new Date(t0).toISOString(), fix.id);
  insert('b1', new Date(t0 - 5 * 86400000).toISOString(), 'failed');
  insert('b2', new Date(t0 - 4 * 86400000).toISOString(), 'failed');
  insert('b3', new Date(t0 - 3 * 86400000).toISOString(), 'succeeded');
  insert('b4', new Date(t0 - 2 * 86400000).toISOString(), 'failed');
  insert('a1', new Date(t0 + 86400000).toISOString(), 'succeeded');
  insert('a2', new Date(t0 + 2 * 86400000).toISOString(), 'succeeded');
  insert('a3', new Date(t0 + 3 * 86400000).toISOString(), 'succeeded');
  insert('a4', new Date(t0 + 4 * 86400000).toISOString(), 'failed');
  const m = intelligenceFor(w.h.store, w.company).repeatProblems;
  assert.deepEqual([m.baseline.requests, m.baseline.solvedWithoutSpecialist, m.baseline.rate], [4, 1, 0.25]);
  assert.deepEqual([m.after.requests, m.after.solvedWithoutSpecialist, m.after.rate], [4, 3, 0.75]);
  assert.equal(m.liftPoints, 50);
  assert.equal(m.synthetic, false);
  sql.prepare('INSERT INTO sample_companies(company_id) VALUES(?)').run(w.company);
  assert.equal(intelligenceFor(w.h.store, w.company).repeatProblems.synthetic, true);
});
