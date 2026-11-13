// Shadow mode: opt-in, invisible to customers, tenant-scoped, privacy-safe, observable, and easy to switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createShadow } from '../server/shadow.js';

const seeded = async (t) => {
  const w = await world(t, { choose: true });
  FOUR.slice(0, 3).forEach(([title, symptoms, step], i) => w.seed(w.company, { title, symptoms, steps: [step], sourceKey: 'sh:' + i }));
  return w;
};
const runs = (w) => w.db().prepare('SELECT * FROM shadow_runs').all();
const live = async (w, name) => {
  const c = await w.customer(name);
  const ticket = await w.ticket(c, ISSUE);
  const r = (await w.ask(c, ticket, ISSUE)).data;
  return { c, ticket, r };
};

test('shadow mode is off by default and records nothing until an owner turns it on', async (t) => {
  const w = await seeded(t);
  const status = (await w.owner.api('company/shadow')).data.shadow;
  assert.equal(status.enabled, false);
  await live(w, 'alice');
  await w.h.shadow.idle();
  assert.equal(runs(w).length, 0);
});

test('only the owner of the company can change it, and it needs confirmation', async (t) => {
  const w = await seeded(t);
  const customer = await w.customer('casey');
  assert.equal((await customer.api('company/shadow', { confirmed: true, enabled: true })).status, 403);
  assert.equal((await w.owner.api('company/shadow', { enabled: true })).status, 400);
  assert.equal((await w.owner.api('company/shadow', { confirmed: true, enabled: 'yes' })).status, 400);
  assert.equal((await w.other.api('company/shadow', { confirmed: true, enabled: true })).status, 200, 'another owner only changes their own service');
  assert.equal((await w.owner.api('company/shadow')).data.shadow.enabled, false, 'and this company stays off');
});

test('with shadow on, the customer sees exactly what they would see without it, and nothing changes in attempts, counters or cases', async (t) => {
  const off = await seeded(t), on = await seeded(t);
  assert.equal((await on.owner.api('company/shadow', { confirmed: true, enabled: true })).data.shadow.enabled, true);
  const a = await live(off, 'alice'), b = await live(on, 'alice');
  await on.h.shadow.idle();
  const strip = (r) => ({ reply: r.reply, stage: r.workflow.stage, choices: r.choices.map((c) => c.title), why: r.choices.map((c) => c.why.replace(/\d+%/, '')) });
  assert.deepEqual(strip(b.r), strip(a.r), 'the customer-visible response is identical');
  const count = (w, table) => w.db().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  for (const table of ['troubleshooting_attempts', 'resolution_uses', 'follow_through_tasks']) assert.equal(count(on, table), count(off, table), table + ' is unchanged');
  assert.equal(on.w ? 0 : count(on, "memory_pool WHERE reuse_failure_count>0 OR reuse_success_count>0"), 0);
  assert.equal(runs(off).length, 0);
  assert.equal(runs(on).length, 1, 'one background ranking was recorded');
  const row = runs(on)[0];
  assert.equal(row.company_id, on.company);
  assert.equal(row.eligible, 3);
  assert.equal(JSON.parse(row.top_json).length, 3);
  assert.ok(row.latency_ms >= 0);
  assert.equal(row.error, null);
});

test('a shadow row holds ids, scores and sizes, never the customer’s words, and is invisible to other companies', async (t) => {
  const w = await seeded(t);
  await w.owner.api('company/shadow', { confirmed: true, enabled: true });
  const secret = 'my email is dana.private@example.com and my phone is +1 415 555 0134';
  const c = await w.customer('dana');
  const ticket = await w.ticket(c, ISSUE + ' ' + secret);
  await w.ask(c, ticket, ISSUE + ' ' + secret);
  await w.h.shadow.idle();
  const dump = JSON.stringify(w.db().prepare('SELECT * FROM shadow_runs').all());
  assert.ok(!/dana|555|flickers|startup/i.test(dump.replace(/Display flicker[^"]*/g, '')), 'no customer text is stored');
  assert.ok(runs(w)[0].query_chars > 50, 'only its length is');
  const other = (await w.other.api('company/shadow')).data.shadow;
  assert.equal(other.runs, 0, 'another company sees none of it');
  assert.equal((await w.owner.api('company/shadow')).data.shadow.runs, 1);
});

test('a failure inside shadow ranking is recorded and swallowed: it can never reach the live flow', async (t) => {
  const w = await seeded(t);
  const broken = { retrieve: async () => { throw new Error('index exploded: dana.private@example.com'); } };
  const shadow = createShadow(w.h.store, broken, {});
  w.db().prepare("INSERT INTO shadow_settings(company_id,chatbot_id,enabled,changed_at) VALUES(?,?,1,'now')").run(w.company, w.company + ':repair');
  const run = shadow.observe({ companyId: w.company, chatbotId: w.company + ':repair', ticketId: 'T1', text: 'anything', factsText: 'anything' });
  await assert.doesNotReject(run);
  const row = runs(w)[0];
  assert.match(row.error, /live flow was not affected/);
  assert.ok(!JSON.stringify(row).includes('dana'), 'the error text is generic, never the exception');
  assert.equal(shadow.observe({ companyId: w.company, chatbotId: 'nobody', ticketId: 'T', text: 'x' }), null, 'a service that is not opted in does no work');
});

test('turning it off stops observation immediately; the report is honest about what it measures', async (t) => {
  const w = await seeded(t);
  await w.owner.api('company/shadow', { confirmed: true, enabled: true });
  const first = await live(w, 'alice');
  await w.h.shadow.idle();
  assert.equal(runs(w).length, 1);
  // The specialist's real solution arrives: the background ranking is compared with it.
  w.h.shadow.compare({ companyId: w.company, ticketId: first.ticket, resolutionText: FOUR[0][2] });
  const rep = (await w.owner.api('company/shadow')).data.shadow;
  assert.equal(rep.comparedWithSpecialistSolution, 1);
  assert.equal(rep.top3ResemblesSolution, 1);
  assert.equal(rep.coverage, 1);
  assert.match(rep.note, /proxy, not a verdict/);
  assert.match(rep.storedPerRun, /Never the customer’s words/);
  await w.owner.api('company/shadow', { confirmed: true, enabled: false });
  await live(w, 'bob');
  await w.h.shadow.idle();
  assert.equal(runs(w).length, 1, 'no new run after it was switched off');
  const events = w.db().prepare("SELECT kind FROM knowledge_events WHERE kind LIKE 'shadow_%' ORDER BY rowid").all().map((e) => e.kind);
  assert.deepEqual(events, ['shadow_enabled', 'shadow_disabled']);
});
