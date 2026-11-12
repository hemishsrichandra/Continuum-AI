import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE } from './_helpers.js';

const DAY = 86400000;
const REMOVED = '[removed at the customer’s request]';

async function scene(t, config = {}) {
  const w = await world(t, { config });
  const a = await w.customer('alice'), b = await w.customer('bob');
  const ta = await w.ticket(a, ISSUE), tb = await w.ticket(b, ISSUE);
  await w.ask(a, ta, 'Please email me instead of calling. My phone is 415 555 0100.');
  await w.ask(a, ta, ISSUE);
  await w.ask(b, tb, ISSUE);
  return { w, a, b, ta, tb };
}

test('export contains only the caller’s own data in the current workspace', async (t) => {
  const { w, a, b, ta } = await scene(t);
  const mine = (await a.api('privacy/export')).data;
  assert.equal(mine.account.email, 'alice@example.test');
  assert.deepEqual(mine.requests.map((r) => r.id), [ta]);
  assert.ok(mine.conversations.length >= 2);
  assert.ok(mine.conversations.every((c) => c.ticketId === ta));
  assert.ok(!JSON.stringify(mine).includes('bob@example.test'));
  const theirs = (await b.api('privacy/export')).data;
  assert.ok(!JSON.stringify(theirs).includes('415 555 0100'), 'Bob never receives Alice’s content');
  void w;
});

test('export and erase are customer-only', async (t) => {
  const { w } = await scene(t);
  for (const route of ['privacy/export']) {
    assert.equal((await w.owner.api(route)).status, 403);
    assert.equal((await w.other.api(route)).status, 403);
  }
  assert.equal((await w.owner.api('privacy/erase', { confirmed: true })).status, 403);
  const anonymous = await (await import('../scripts/invoke.js')).invoke(w.h, 'privacy/export');
  assert.equal(anonymous.status, 401);
});

test('erase requires confirmation, removes content, keeps operational records, and does not touch other customers', async (t) => {
  const { w, a, b, ta, tb } = await scene(t);
  const bobBefore = JSON.stringify(w.h.store.data.conversations.filter((c) => c.ticketId === tb));
  assert.equal((await a.api('privacy/erase', {})).status, 400, 'confirmation is required');
  assert.equal((await a.api('privacy/erase', { confirmed: true, ticketId: tb })).status, 404, 'cannot target another customer’s request');
  const r = await a.api('privacy/erase', { confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.erased.conversations >= 2);
  assert.ok(r.data.kept.length >= 3);
  const mine = w.h.store.data.conversations.filter((c) => c.ticketId === ta && !c.system);
  assert.ok(mine.length && mine.every((c) => c.message === REMOVED && c.response.reply === REMOVED && c.erasedAt));
  assert.ok(!JSON.stringify(w.h.store.data).includes('415 555 0100'), 'the phone number is gone from every collection');
  assert.equal(JSON.stringify(w.h.store.data.conversations.filter((c) => c.ticketId === tb)), bobBefore, 'Bob’s data is untouched');
  assert.equal((await a.api('status?ticketId=' + ta)).status, 200, 'the request itself is kept');
  assert.ok(w.h.store.data.audit.some((x) => x.kind === 'privacy_erasure' && !JSON.stringify(x).includes('415')), 'an audit record exists and holds no content');
  const again = (await a.api('privacy/erase', { confirmed: true })).data;
  assert.equal(again.erased.conversations, 0, 'idempotent');
});

test('erase can target one request, and also clears the copies inside a specialist case file', async (t) => {
  const { w, a, ta } = await scene(t);
  const t2 = await w.ticket(a, 'Second request about wifi dropping.', 'Wifi');
  await w.ask(a, t2, 'My wifi drops. Call me on 98765 43210.');
  const handoff = (await a.api('handoff', { ticketId: t2, summary: 'Wifi drops', confirmed: true })).data;
  assert.ok(JSON.stringify(w.h.store.data.handoffs.find((h) => h.id === handoff.id).context).includes('98765 43210'), 'the case file carries a copy');
  const r = (await a.api('privacy/erase', { confirmed: true, ticketId: t2 })).data;
  assert.ok(r.erased.caseFileCopies >= 1);
  assert.ok(!JSON.stringify(w.h.store.data.handoffs.find((h) => h.id === handoff.id).context).includes('98765 43210'));
  assert.ok(!JSON.stringify(w.h.store.data.conversations).includes('98765 43210'));
  assert.ok(JSON.stringify(w.h.store.data.conversations).includes('415 555 0100'), 'the other request is untouched');
  void ta;
});

test('erasing a ticket unlinks shared knowledge sourced from it without deleting the knowledge', async (t) => {
  const { w, a, ta } = await scene(t);
  const row = w.seed(w.company, { title: 'Display fix', symptoms: 'Display flickers after startup', steps: ['Open Display settings and restart.'] });
  w.db().prepare('UPDATE memory_pool SET source_ticket_id=? WHERE id=?').run(ta, row.id);
  const r = (await a.api('privacy/erase', { confirmed: true })).data;
  assert.equal(r.erased.unlinkedKnowledge, 1);
  const after = w.db().prepare('SELECT status,source_ticket_id FROM memory_pool WHERE id=?').get(row.id);
  assert.deepEqual([after.status, after.source_ticket_id], ['active', null]);
});

test('retention is off by default and does nothing until configured', async (t) => {
  const { w } = await scene(t);
  assert.deepEqual(w.h.privacy.policy, { archivedConversationDays: 0, followThroughDays: 0, outboxDays: 0 });
  assert.deepEqual(await w.h.privacy.sweep(Date.now() + 1000 * DAY), { archivedConversations: 0, followThroughTasks: 0, outboxJobs: 0 });
});

test('retention sweep: archived conversations, finished follow-through tasks and old outbox jobs expire after the configured days', async (t) => {
  const { w, a, ta } = await scene(t, { RETENTION_ARCHIVED_CONVERSATION_DAYS: '30', RETENTION_FOLLOW_THROUGH_DAYS: '90', RETENTION_OUTBOX_DAYS: '14' });
  assert.equal((await a.api('conversation/archive', { ticketId: ta, confirmed: true })).status, 200);
  const live = w.h.store.data.conversations.filter((c) => c.ticketId === ta && c.archivedAt).length;
  assert.ok(live >= 2);
  // finished + pending follow-through tasks; old and recent outbox jobs
  const task = (id, status, processed) => w.db().prepare("INSERT INTO follow_through_tasks(id,company_id,ticket_id,task_type,dedupe_key,deadline_at,status,processed_at,created_at) VALUES(?,?,?,'sla_escalation',?,?,?,?,?)").run(id, w.company, 'T', id, 'x', status, processed, processed || new Date().toISOString());
  const t0 = Date.now();
  task('old-done', 'completed', new Date(t0 - 200 * DAY).toISOString());
  task('old-pending', 'pending', null);
  task('recent-done', 'completed', new Date(t0 - 10 * DAY).toISOString());
  w.h.store.update((d) => { d.outbox.push({ id: 'old', status: 'delivered', createdAt: new Date(t0 - 40 * DAY).toISOString(), deliveredAt: new Date(t0 - 40 * DAY).toISOString() }, { id: 'new', status: 'delivered', createdAt: new Date(t0).toISOString(), deliveredAt: new Date(t0).toISOString() }, { id: 'queued-old', status: 'pending', createdAt: new Date(t0 - 40 * DAY).toISOString() }); });
  // 5 days later: the 200-day-old finished task and 40-day-old delivered job are past their limits; the
  // conversation archived just now is not (30-day limit).
  const early = await w.h.privacy.sweep(t0 + 5 * DAY);
  assert.deepEqual(early, { archivedConversations: 0, followThroughTasks: 1, outboxJobs: 1 });
  assert.deepEqual(w.db().prepare('SELECT id FROM follow_through_tasks ORDER BY id').all().map((r) => r.id), ['old-pending', 'recent-done'], 'a pending task is never deleted');
  assert.deepEqual(w.h.store.data.outbox.map((j) => j.id).sort(), ['new', 'queued-old'], 'pending work is never deleted');
  // 40 days later: the archived conversations are past 30 days; the 10-day-old task (now 50 days) is not past 90.
  const swept = await w.h.privacy.sweep(t0 + 40 * DAY);
  assert.deepEqual(swept, { archivedConversations: live, followThroughTasks: 0, outboxJobs: 1 });
  assert.ok(w.h.store.data.conversations.filter((c) => c.ticketId === ta && !c.system).every((c) => c.message === REMOVED));
  assert.deepEqual(w.h.store.data.outbox.map((j) => j.id), ['queued-old'], 'only unfinished work remains');
  assert.deepEqual(await w.h.privacy.sweep(t0 + 41 * DAY), { archivedConversations: 0, followThroughTasks: 0, outboxJobs: 0 }, 'idempotent');
});

test('the worker flush applies retention (not web requests)', async (t) => {
  const { w, a, ta } = await scene(t, { RETENTION_ARCHIVED_CONVERSATION_DAYS: '1' });
  await a.api('conversation/archive', { ticketId: ta, confirmed: true });
  w.h.store.update((d) => { for (const c of d.conversations) if (c.archivedAt) c.archivedAt = new Date(Date.now() - 5 * DAY).toISOString(); });
  await a.api('workspace');
  assert.ok(w.h.store.data.conversations.some((c) => c.ticketId === ta && c.archivedAt && c.message !== REMOVED), 'traffic alone does not purge');
  await w.h.delivery.flush();
  assert.ok(w.h.store.data.conversations.filter((c) => c.ticketId === ta && !c.system).every((c) => c.message === REMOVED));
});
