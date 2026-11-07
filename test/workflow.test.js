import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';
import { extractFacts } from '../server/facts.js';
import { compatibility } from '../server/context.js';
import { createLearning } from '../server/learning.js';
import Database from 'better-sqlite3';
import { Store } from '../server/providers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const password = 'a very long test passphrase 2026';

test('a populated pre-company SQLite account table migrates without losing accounts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-legacy-account-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'legacy.sqlite');
  const legacy = new Database(file);
  legacy.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,provider TEXT NOT NULL,email_verified INTEGER NOT NULL,created_at INTEGER NOT NULL); INSERT INTO accounts VALUES('existing','existing@example.test','Existing account','existing hash','repair',1,1)",
  );
  legacy.close();
  const store = new Store(file);
  t.after(() => store.close());
  const migrated = store.db.prepare('SELECT * FROM accounts').get();
  assert.equal(migrated.id, 'existing');
  assert.equal(migrated.company_id, 'legacy');
  assert.equal(migrated.password_hash, 'existing hash');
  assert.equal(migrated.email_verified, 1);
  assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.throws(() => store.db.prepare('UPDATE accounts SET company_id=NULL').run(), /company is required/);
});
async function fixture(t, config = {}, file) {
  const h = createHandler({ config, file });
  t.after(() => h.close());
  function client() {
    let cookie = '',
      csrf = '';
    return {
      get headers() {
        return { cookie, 'x-csrf-token': csrf };
      },
      async api(route, body, options = {}) {
        const r = await invoke(h, route, {
          ...options,
          body,
          headers: { cookie, 'x-csrf-token': csrf, ...options.headers },
        });
        if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
        if (r.data.csrfToken) csrf = r.data.csrfToken;
        return r;
      },
    };
  }
  const owner = client();
  const registered = await owner.api('auth/register', {
    createCompany: true,
    companyName: 'Example service company',
    name: 'Owner',
    email: 'owner@example.test',
    password,
    provider: 'repair',
  });
  assert.equal(registered.status, 201);
  const companyCode = (await owner.api('company/customer-code', { confirmed: true })).data.code;
  const a = client(),
    b = client();
  for (const [c, email] of [
    [a, 'a@example.test'],
    [b, 'b@example.test'],
  ])
    assert.equal(
      (await c.api('auth/register', { companyCode, name: email, email, password, provider: 'repair' }))
        .status,
      201,
    );
  const question = 'The display flickers after startup on Model X firmware 4.';
  const ticketA = (await a.api('request', { title: 'Model X display', issueDesc: question, confirmed: true }))
    .data.ticketId;
  const ticketB = (await b.api('request', { title: 'Model X display', issueDesc: question, confirmed: true }))
    .data.ticketId;
  const handoff = (await a.api('handoff', { ticketId: ticketA, summary: question, confirmed: true })).data.id;
  const ownerId = registered.data.profile.id;
  assert.equal(
    (
      await owner.api('operator/assign', {
        handoffId: handoff,
        assignedTo: ownerId,
        revision: 0,
        confirmed: true,
      })
    ).status,
    200,
  );
  const solution =
    'Disable adaptive refresh in Display settings, then install the verified display driver 4.2.';
  async function propose(revision = 1) {
    const r = await owner.api('operator/resolve', {
      handoffId: handoff,
      revision,
      title: 'Display flicker after startup',
      symptoms: 'Display flickers after startup',
      environment: 'Model X firmware 4',
      solution,
      confirmed: true,
      reviewedForPrivacy: true,
    });
    assert.equal(r.status, 201);
    return r.data;
  }
  const ask = (message = question, extra = {}) => b.api('chat', { ticketId: ticketB, message, ...extra });
  return {
    h,
    owner,
    a,
    b,
    client,
    companyCode,
    question,
    ticketA,
    ticketB,
    handoff,
    ownerId,
    solution,
    propose,
    ask,
  };
}

test('customer acceptance gates publication; paraphrases work; incompatible or unknown environments never receive steps', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  assert.equal((await f.ask()).data.trace.learnedResolutions, 0);
  assert.equal(
    (await f.b.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true })).status,
    404,
  );
  assert.equal(
    (await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true })).status,
    200,
  );
  const on = await f.ask('The monitor flashes when booting the notebook.');
  assert.equal(on.data.trace.learnedResolutions, 1);
  assert.ok(on.data.reply.includes(f.solution));
  assert.equal(
    (await f.ask('The display flickers after startup on Model Z firmware 9.')).data.trace.learnedResolutions,
    0,
  );
  const ticket = (
    await f.b.api('request', {
      title: 'Screen',
      issueDesc: 'The monitor flashes when booting.',
      confirmed: true,
    })
  ).data.ticketId;
  const unknown = await f.b.api('chat', { ticketId: ticket, message: 'The monitor flashes when booting.' });
  assert.equal(unknown.data.trace.learnedResolutions, 0);
  assert.match(unknown.data.reply, /confirm.*environment/i);
  assert.ok(!unknown.data.reply.includes(f.solution));
  assert.equal((await f.ask('How do I update my invoice address?')).data.trace.learnedResolutions, 0);
});

test('reused fixes collect one result per ticket; failure creates one contextual case and review', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const first = (await f.ask()).data,
    repeat = (await f.ask()).data;
  assert.equal(first.decision.mode, 'recommend');
  assert.equal(first.resolutionUse.id, repeat.resolutionUse.id);
  assert.equal(
    (await f.a.api('resolutions/outcome', { useId: first.resolutionUse.id, worked: false, confirmed: true }))
      .status,
    404,
  );
  assert.equal(
    (await f.b.api('resolutions/outcome', { useId: first.resolutionUse.id, worked: true, confirmed: true }))
      .status,
    200,
  );
  assert.equal((await f.b.api('status?ticketId=' + f.ticketB)).data.status, 'Resolved');
  let library = (await f.owner.api('operator')).data.resolutions.find((x) => x.id === r.id);
  assert.deepEqual(library.reuse, { pending: 0, succeeded: 1, failed: 0 });
  const failure = await f.b.api('resolutions/outcome', {
    useId: first.resolutionUse.id,
    worked: false,
    confirmed: true,
  });
  assert.equal(failure.status, 200);
  assert.equal(
    (await f.b.api('resolutions/outcome', { useId: first.resolutionUse.id, worked: false, confirmed: true }))
      .data.handoffId,
    failure.data.handoffId,
  );
  const queue = (await f.owner.api('operator')).data;
  const caseB = queue.cases.find((h) => h.id === failure.data.handoffId);
  assert.equal(caseB.troubleshooting.length, 1);
  assert.equal(caseB.troubleshooting[0].step, f.solution);
  assert.ok(caseB.conversation.some((c) => c.response.reply.includes(f.solution)));
  assert.equal((await f.b.api('status?ticketId=' + f.ticketB)).data.status, 'Reopened');
  library = queue.resolutions.find((x) => x.id === r.id);
  assert.ok(library.reviewRequired);
  assert.equal(library.reuse.failed, 1);
  assert.equal(library.reuse.succeeded, 0);
  const answer = (await f.ask()).data;
  assert.equal(answer.trace.learnedResolutions, 0);
  assert.equal(answer.decision.mode, 'waiting');
  assert.equal(answer.action, null);
  assert.ok(!answer.reply.includes(f.solution));
  assert.equal(
    (
      await f.owner.api('operator/review-resolution', {
        id: r.id,
        reviewRevision: library.reviewRevision,
        decision: 'keep',
        note: 'Investigated the report; original environment remains supported.',
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.ask()).data.trace.learnedResolutions,
    0,
    'A customer who failed the fix must not receive it again after review',
  );
});

test('a pending review excludes failed steps from model prompts as well as fresh recall', async (t) => {
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const c = JSON.parse(JSON.parse(options.body).messages[1].content);
    prompts.push(c);
    return Response.json({ choices: [{ message: { content: c.guidance.join('\n') } }] });
  });
  const f = await fixture(t, { OPENAI_API_KEY: 'synthetic' });
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const use = (await f.ask()).data.resolutionUse;
  await f.b.api('resolutions/outcome', { useId: use.id, worked: false, confirmed: true });
  await f.ask('What is the current status?');
  assert.ok(!JSON.stringify(prompts.at(-1)).includes(f.solution));
  assert.ok(!prompts.at(-1).liveTicket.handoffs);
  await f.owner.api('operator/retire', { id: r.id, confirmed: true });
  await f.ask('What is the current status?');
  assert.ok(!JSON.stringify(prompts.at(-1)).includes(f.solution));
});

test('outcome receipts and review stats survive another SQLite connection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-reuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'app.sqlite');
  const f = await fixture(t, {}, file);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const use = (await f.ask()).data.resolutionUse;
  await f.b.api('resolutions/outcome', { useId: use.id, worked: false, confirmed: true });
  const restarted = createHandler({ file, config: {} });
  t.after(() => restarted.close());
  const replay = await invoke(restarted, 'resolutions/outcome', {
    headers: f.b.headers,
    body: { useId: use.id, worked: false, confirmed: true },
  });
  assert.equal(replay.status, 200);
  const own = restarted.store.data.handoffs.filter((h) => h.ticketId === f.ticketB);
  assert.equal(own.length, 1);
  assert.equal(own[0].troubleshooting.length, 1);
  const conversation = await invoke(restarted, 'conversation?ticketId=' + f.ticketB, {
    headers: f.b.headers,
  });
  assert.equal(
    conversation.data.messages.find((c) => c.response.resolutionUse)?.response.resolutionUse.status,
    'failed',
  );
});

test('a failed-fix report in chat stays a proposal until confirmation, then records reuse feedback and handoff together', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const use = (await f.ask()).data.resolutionUse;
  const chat = (await f.ask('That suggestion did not help.')).data;
  assert.equal(chat.action.failedUseId, use.id);
  assert.equal(
    f.h.store.db.prepare('SELECT status FROM resolution_uses WHERE id=?').get(use.id).status,
    'pending',
  );
  const body = {
    ticketId: f.ticketB,
    summary: chat.action.summary,
    failedUseId: use.id,
    proposalId: chat.id,
    confirmed: true,
  };
  const result = await f.b.api('handoff', body, { headers: { 'idempotency-key': 'confirm-failed-fix' } });
  assert.equal(result.status, 201);
  assert.equal(
    f.h.store.db.prepare('SELECT status FROM resolution_uses WHERE id=?').get(use.id).status,
    'failed',
  );
  assert.equal(
    (await f.b.api('handoff', body, { headers: { 'idempotency-key': 'confirm-failed-fix' } })).data.id,
    result.data.id,
  );
  assert.ok((await f.owner.api('operator')).data.resolutions.find((x) => x.id === r.id).reviewRequired);
});

test('review requires the latest failure report; clearing review helps new customers but never repeats a failed fix', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const c = f.client(),
    d = f.client();
  for (const [client, email] of [
    [c, 'c@example.test'],
    [d, 'd@example.test'],
  ])
    assert.equal(
      (
        await client.api('auth/register', {
          companyCode: f.companyCode,
          name: email,
          email,
          password,
          provider: 'repair',
        })
      ).status,
      201,
    );
  const tc = (await c.api('request', { title: 'Model X display', issueDesc: f.question, confirmed: true }))
    .data.ticketId;
  const uc = (await c.api('chat', { ticketId: tc, message: f.question })).data.resolutionUse;
  const ub = (await f.ask()).data.resolutionUse;
  await f.b.api('resolutions/outcome', { useId: ub.id, worked: false, confirmed: true });
  await c.api('resolutions/outcome', { useId: uc.id, worked: false, confirmed: true });
  assert.equal(
    (
      await f.owner.api('operator/review-resolution', {
        id: r.id,
        reviewRevision: 1,
        decision: 'keep',
        note: 'Reviewed.',
        confirmed: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner.api('operator/review-resolution', {
        id: r.id,
        reviewRevision: 2,
        decision: 'keep',
        note: 'Both cases investigated; verified the original applicability.',
        confirmed: true,
      })
    ).status,
    200,
  );
  const td = (await d.api('request', { title: 'Model X display', issueDesc: f.question, confirmed: true }))
    .data.ticketId;
  assert.equal((await d.api('chat', { ticketId: td, message: f.question })).data.trace.learnedResolutions, 1);
  assert.equal((await f.ask()).data.trace.learnedResolutions, 0);
  const original = f.h.store.data.resolutions.find((x) => x.id === r.id);
  f.h.store.update((data) => {
    data.resolutions.push({
      ...original,
      id: 'duplicate-resolution',
      memoryId: 'duplicate-memory',
      title: 'Revised display fix',
      solution: original.solution.toUpperCase(),
    });
    const m = data.memories.find((m) => m.id === original.memoryId);
    data.memories.push({
      ...m,
      id: 'duplicate-memory',
      resolutionId: 'duplicate-resolution',
      text: m.text + ' Reviewed again.',
    });
  });
  const newTicket = (
    await f.b.api('request', { title: 'Model X display', issueDesc: f.question, confirmed: true })
  ).data.ticketId;
  assert.equal(
    (await f.b.api('chat', { ticketId: newTicket, message: f.question })).data.trace.learnedResolutions,
    0,
    'Republishing identical steps under another ID must not repeat a failed fix',
  );
});

test('progress is assigned, revision-checked, customer-visible, and customer rejection keeps knowledge private', async (t) => {
  const f = await fixture(t);
  const body = {
    handoffId: f.handoff,
    revision: 1,
    status: 'Waiting for parts',
    eta: '2026-12-20',
    priority: 'High',
    note: 'We tested the display and ordered the part.',
    step: 'Replace display cable',
    stepOutcome: 'failed',
    confirmed: true,
  };
  assert.equal((await f.owner.api('operator/progress', body)).status, 200);
  assert.equal((await f.owner.api('operator/progress', body)).status, 409);
  const state = await f.a.api('status?ticketId=' + f.ticketA);
  assert.equal(state.data.status, 'Waiting for parts');
  assert.equal(state.data.eta, body.eta);
  const queue = (await f.owner.api('operator')).data;
  assert.equal(queue.cases[0].context.ticket.eta, body.eta);
  assert.equal((await f.owner.api('operator?provider=it')).data.provider, 'it');
  assert.equal(queue.cases[0].troubleshooting[0].outcome, 'failed');
  assert.ok(queue.cases[0].conversation.some((c) => c.response.reply === body.note));
  const r = await f.propose(2);
  assert.equal(
    (await f.a.api('resolutions/confirm', { id: r.id, accepted: false, confirmed: true })).data.status,
    'rejected',
  );
  assert.equal((await f.ask()).data.trace.learnedResolutions, 0);
  assert.equal((await f.a.api('status?ticketId=' + f.ticketA)).data.status, 'Reopened');
  const retry = await f.propose(4);
  await f.a.api('resolutions/confirm', { id: retry.id, accepted: true, confirmed: true });
  const answered = await f.a.api('chat', {
    ticketId: f.ticketA,
    message: 'Is the issue fixed?',
    retain: false,
  });
  assert.ok(!answered.data.evidence.some((e) => e.kind === 'failed'));
});

test('memory OFF and retired knowledge never enter later model conversation context', async (t) => {
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body),
      context = JSON.parse(body.messages[1].content);
    prompts.push(context);
    return Response.json({ choices: [{ message: { content: context.guidance.join('\n') } }] });
  });
  const f = await fixture(t, { OPENAI_API_KEY: 'synthetic' });
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  await f.ask();
  assert.ok(JSON.stringify(prompts.at(-1)).includes(f.solution));
  await f.ask('What is the current status?', { memory: false });
  assert.ok(!JSON.stringify(prompts.at(-1)).includes(f.solution));
  assert.deepEqual(prompts.at(-1).recentConversation, []);
  await f.owner.api('operator/retire', { id: r.id, confirmed: true });
  await f.ask('What is the current status?');
  assert.ok(!JSON.stringify(prompts.at(-1)).includes(f.solution));
});

test('customer preferences carry across tickets; technical outcomes stay private to their ticket', async (t) => {
  const f = await fixture(t);
  await f.a.api('chat', {
    ticketId: f.ticketA,
    message: 'Please email me instead of calling. That suggestion did not help.',
  });
  const second = (
    await f.a.api('request', { title: 'Battery', issueDesc: 'Battery drains quickly', confirmed: true })
  ).data.ticketId;
  const response = (await f.a.api('chat', { ticketId: second, message: 'How should the team contact me?' }))
    .data;
  assert.ok(response.evidence.some((e) => e.kind === 'preference' && /email/i.test(e.text)));
  assert.ok(!response.evidence.some((e) => e.kind === 'failed'));
  assert.ok(
    !(await f.ask('How should the team contact me?')).data.evidence.some((e) => e.kind === 'preference'),
  );
  await f.a.api('chat', { ticketId: second, message: 'Please text me instead.' });
  const changed = (
    await f.a.api('chat', { ticketId: f.ticketA, message: 'How should the team contact me?', retain: false })
  ).data;
  assert.ok(changed.evidence.some((e) => e.kind === 'preference' && /text me/i.test(e.text)));
  assert.ok(!changed.evidence.some((e) => e.kind === 'preference' && /email/i.test(e.text)));
  const ledger = (await f.a.api('memory?ticketId=' + second)).data.ledger;
  const id = ledger.find((m) => m.kind === 'preference' && !m.invalidatedAt).id;
  assert.equal((await f.a.api('memory', { ticketId: f.ticketA, id }, { method: 'PATCH' })).status, 200);
  assert.equal(
    (
      await f.a.api('chat', { ticketId: second, message: 'Contact preference?', retain: false })
    ).data.evidence.filter((e) => e.kind === 'preference').length,
    0,
  );
});

test('company boundaries cover knowledge, staff, tickets, assignment, and booking capacity', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const other = f.client();
  const signup = await other.api('auth/register', {
    createCompany: true,
    companyName: 'Another company',
    name: 'Other owner',
    email: 'other@example.test',
    password,
    provider: 'repair',
  });
  assert.equal(signup.status, 201);
  const code = (await other.api('company/customer-code',{confirmed:true})).data.code;
  const customer = f.client();
  assert.equal((await customer.api('auth/register',{companyCode:code,name:'Other customer',email:'other-customer@example.test',password,provider:'repair'})).status,201);
  const ticketId = (
    await customer.api('request', { title: 'Model X display', issueDesc: f.question, confirmed: true })
  ).data.ticketId;
  assert.equal((await customer.api('chat', { ticketId, message: f.question })).data.trace.learnedResolutions, 0);
  assert.equal((await other.api('operator')).data.cases.length, 0);
  assert.equal((await customer.api('status?ticketId=' + f.ticketA)).status, 404);
  assert.equal((await other.api('operator/retire', { id: r.id, confirmed: true })).status, 404);
  assert.equal(
    (
      await other.api('operator/assign', {
        handoffId: f.handoff,
        assignedTo: signup.data.profile.id,
        revision: 3,
        confirmed: true,
      })
    ).status,
    404,
  );
  const slot = (await f.b.api('slots?ticketId=' + f.ticketB)).data.slots[0].id;
  assert.equal((await f.b.api('book', { ticketId: f.ticketB, datetime: slot, confirmed: true })).status, 201);
  assert.equal((await customer.api('book', { ticketId, datetime: slot, confirmed: true })).status, 201);
  assert.equal((await f.b.api('company')).status, 403);
});

test('invitations bind email, role, company, expiry, and single use; public customers cannot grant themselves staff', async (t) => {
  const f = await fixture(t);
  const url = (
    await f.owner.api('company/invitations', {
      email: 'staff@example.test',
      role: 'staff',
      provider: 'repair',
    })
  ).data.url;
  const invitation = new URLSearchParams(new URL(url).hash.slice(1)).get('invite');
  const c = f.client();
  assert.equal(
    (
      await c.api('auth/register', {
        invitation,
        name: 'Intruder',
        email: 'intruder@example.test',
        password,
        provider: 'repair',
      })
    ).status,
    400,
  );
  const r = await c.api('auth/register', {
    invitation,
    name: 'Specialist',
    email: 'staff@example.test',
    password,
    provider: 'it',
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.profile.role, 'staff');
  assert.equal(r.data.profile.provider, 'repair');
  assert.ok(f.h.store.db.prepare('SELECT consumed_at FROM invitations').get().consumed_at);
  assert.equal((await c.api('operator')).status, 200);
  assert.equal((await c.api('operator?provider=it')).status, 403);
  await f.owner.api('company/revoke-staff', { id: r.data.profile.id, confirmed: true });
  assert.equal((await c.api('operator')).status, 401);
});

test('expired invitations cannot register; company signup cannot choose owner or staff roles', async (t) => {
  const f = await fixture(t);
  const link = (
    await f.owner.api('company/invitations', {
      email: 'expired@example.test',
      role: 'staff',
      provider: 'repair',
    })
  ).data.url;
  f.h.store.db.prepare('UPDATE invitations SET expires_at=0').run();
  const invitation = new URLSearchParams(new URL(link).hash.slice(1)).get('invite');
  const c = f.client();
  assert.equal(
    (
      await c.api('auth/register', {
        invitation,
        name: 'Expired',
        email: 'expired@example.test',
        password,
        provider: 'repair',
      })
    ).status,
    400,
  );
  const joined = await c.api('auth/register', {
    companyCode: f.companyCode,
    role: 'owner',
    companyId: 'someone-else',
    name: 'Customer',
    email: 'customer-role@example.test',
    password,
    provider: 'repair',
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.profile.role, 'customer');
  assert.notEqual(joined.data.profile.companyId, 'someone-else');
  assert.equal((await c.api('company')).status, 403);
});

test('live semantic matches do not need lexical overlap; unrelated or unverifiable candidates are excluded', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
  const document = f.h.store.data.memories.find((m) => m.id === r.memoryId);
  const remote = createLearning(
    f.h.store,
    { recall: async () => ({ source: 'Hindsight', facts: [document] }) },
    null,
    { OPENAI_API_KEY: 'synthetic' },
  );
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              matches: context.question.includes('invoice')
                ? []
                : context.candidates.map((c) => ({ id: c.id, confidence: 0.99 })),
            }),
          },
        },
      ],
    });
  });
  const companyId = (await f.owner.api('auth/session')).data.profile.companyId;
  assert.equal(
    (
      await remote.recall(companyId, 'repair', 'A strobing panel appears as the computer wakes.', {
        issue: 'Model X firmware 4',
      })
    ).facts.length,
    1,
  );
  assert.equal(
    (await remote.recall(companyId, 'repair', 'How do I update my invoice?', { issue: 'Model X firmware 4' }))
      .facts.length,
    0,
  );
});

test('fact extraction recognizes multiple outcomes and rejects credentials; compatibility handles punctuation', () => {
  assert.ok(
    extractFacts('That suggestion did not help. The promised deadline passed.').some(
      (f) => f.kind === 'failed',
    ),
  );
  assert.ok(
    extractFacts('That suggestion did not help. The promised deadline passed.').some(
      (f) => f.kind === 'missed',
    ),
  );
  assert.deepEqual(extractFacts('Please remember my api_key=secret'), []);
  assert.equal(extractFacts('Please email me about this ticket.')[0].customerWide, false);
  assert.ok(compatibility('Model X firmware 4', 'Model X firmware 4.').compatible);
  assert.ok(!compatibility('Model X firmware 4', 'Model Z firmware 4.').compatible);
});

test('read-only gateways enforce allowed origins, customer binding, mapped schemas, encrypted tokens, and atomic imports', async (t) => {
  const f = await fixture(t, { PROVIDER_ALLOWED_ORIGINS: 'https://gateway.example' });
  assert.equal(
    (
      await f.owner.api('company/connector', {
        baseUrl: 'https://untrusted.example',
        apiToken: 'gateway-secret',
        confirmed: true,
      })
    ).status,
    400,
  );
  const mapping = {
    id: 'ticket',
    customerId: 'customer',
    title: 'device',
    issue: 'problem',
    status: 'state',
    eta: 'due',
    assignedTo: 'team',
  };
  assert.equal(
    (
      await f.owner.api('company/connector', {
        baseUrl: 'https://gateway.example/api',
        apiToken: 'gateway-secret',
        mapping,
        confirmed: true,
      })
    ).status,
    200,
  );
  const status = (await f.owner.api('company/connector')).data;
  assert.ok(!JSON.stringify(status).includes('gateway-secret'));
  const stored = f.h.store.db
    .prepare('SELECT encrypted_token FROM provider_connections')
    .get().encrypted_token;
  assert.ok(!stored.includes('gateway-secret'));
  const account = (await f.a.api('auth/session')).data.profile.id;
  assert.equal(
    (await f.owner.api('company/connector/customer', { accountId: account, externalId: 'customer-a' }))
      .status,
    200,
  );
  assert.equal((await f.b.api('connector/sync', {})).status, 409);
  assert.equal((await f.b.api('company/connector')).status, 403);
  let invalid = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://gateway.example/api/customers/customer-a/requests');
    assert.equal(options.headers.Authorization, 'Bearer gateway-secret');
    assert.equal(options.redirect, 'error');
    return Response.json([
      {
        ticket: 'external-1',
        customer: invalid ? 'another-customer' : 'customer-a',
        device: 'Printer',
        problem: 'Paper jam',
        state: 'Waiting for parts',
        due: '2026-12-20',
        team: 'Printer team',
      },
    ]);
  });
  assert.equal((await f.a.api('connector/sync', {})).data.imported, 1);
  const workspace = (await f.a.api('workspace')).data;
  const imported = workspace.tickets.find((t) => t.external);
  assert.equal(imported.title, 'Printer');
  assert.equal(imported.status, 'Waiting for parts');
  assert.ok(workspace.canSync);
  assert.equal((await f.a.api('connector/sync', {})).data.imported, 1);
  assert.equal((await f.a.api('workspace')).data.tickets.length, 2);
  invalid = true;
  assert.equal((await f.a.api('connector/sync', {})).status, 502);
  assert.equal((await f.a.api('workspace')).data.tickets.length, 2);
});

test('context summary combines current request and active customer preferences, excludes other issues and retired preferences', async (t) => {
  const f = await fixture(t);
  await f.a.api('chat', { ticketId: f.ticketA, message: 'Please email me instead of calling.' });
  const next = (await f.a.api('request', {title:'Battery issue', issueDesc:'Battery drains on Model B firmware 3.', confirmed:true})).data.ticketId;
  let r = await f.a.api('reflect', {ticketId:next});
  assert.equal(r.status, 200);
  assert.match(r.data.text, /Battery drains/);
  assert.match(r.data.text, /email me instead of calling/);
  assert.doesNotMatch(r.data.text, /display flickers/i);
  const ledger = (await f.a.api('memory?ticketId=' + next)).data.ledger;
  const pref = ledger.find(m=>m.kind==='preference' && !m.invalidatedAt);
  await f.a.api('memory', {ticketId:next, id:pref.id}, {method:'PATCH'});
  r = await f.a.api('reflect', {ticketId:next});
  assert.doesNotMatch(r.data.text, /email me instead of calling/);
});

test('revoking a specialist releases active cases and rejects a stale update', async (t) => {
  const f = await fixture(t);
  const link = (await f.owner.api('company/invitations', {email:'newstaff@example.test',role:'staff',provider:'repair'})).data.url;
  const invitation = new URLSearchParams(new URL(link).hash.slice(1)).get('invite');
  const specialist = f.client();
  // Invited registration needs no selectable provider: scope comes from the invitation.
  const registered = await specialist.api('auth/register', {invitation,name:'New specialist',email:'newstaff@example.test',password});
  assert.equal(registered.status,201);
  const assigned = await f.owner.api('operator/assign', {handoffId:f.handoff,assignedTo:registered.data.profile.id,revision:1,confirmed:true});
  assert.equal(assigned.status,200);
  assert.equal((await f.a.api('status?ticketId=' + f.ticketA)).data.assignedTo, 'New specialist');
  const revoked = await f.owner.api('company/revoke-staff', {id:registered.data.profile.id,confirmed:true});
  assert.equal(revoked.status,200);
  const h = f.h.store.data.handoffs.find(h=>h.id===f.handoff);
  assert.equal(h.assignedTo,null);
  assert.equal(h.status,'Queued');
  assert.equal(h.revision,3);
  assert.equal((await f.a.api('status?ticketId=' + f.ticketA)).data.assignedTo, 'Device repair team');
  assert.equal((await specialist.api('operator')).status,401);
});

test('pending specialist confirmation cannot be bypassed by generic outcomes; later notes remain in staff context', async(t)=>{
  const f=await fixture(t);
  const proposed=await f.propose();
  for(const outcome of ['resolved','failed','missed']) {
    const r=await f.a.api('outcome',{ticketId:f.ticketA,outcome,note:'Generic update',confirmed:true});
    assert.equal(r.status,409);
  }
  assert.equal((await f.a.api('status?ticketId='+f.ticketA)).data.status,'Awaiting confirmation');
  await f.a.api('requirement',{ticketId:f.ticketA,note:'New note after handoff: flicker while charging.',confirmed:true});
  const queue=(await f.owner.api('operator')).data;
  assert.ok(queue.cases.find(h=>h.id===f.handoff).context.ticket.requirements.some(r=>r.note.includes('after handoff')));
  assert.equal((await f.a.api('resolutions/confirm',{id:proposed.id,accepted:false,confirmed:true})).status,200);
});

test('customer resolution closes an active specialist case without publishing knowledge or accepting stale edits', async (t) => {
  const f = await fixture(t);
  const result = await f.a.api('outcome', {
    ticketId: f.ticketA, outcome: 'resolved', note: 'The issue is fixed now.', confirmed: true,
  });
  assert.equal(result.status, 201);
  const queue = (await f.owner.api('operator')).data;
  const closed = queue.cases.find(h => h.id === f.handoff);
  assert.equal(closed.status, 'Resolved');
  assert.equal(closed.revision, 2);
  assert.equal(queue.resolutions.length, 0);
  assert.equal((await f.owner.api('operator/progress', {
    handoffId: f.handoff, revision: 1, status: 'In progress', note: 'Stale update', confirmed: true,
  })).status, 409);
  assert.equal((await f.a.api('status?ticketId=' + f.ticketA)).data.status, 'Resolved');
});

test('reassignment rejects an actual former staff identity and its stale progress form', async (t) => {
  const f = await fixture(t);
  const staff = f.client();
  const url = (await f.owner.api('company/invitations', {
    email: 'assigned@example.test', role: 'staff', provider: 'repair',
  })).data.url;
  const invitation = new URLSearchParams(new URL(url).hash.slice(1)).get('invite');
  const registration = await staff.api('auth/register', {
    invitation, name: 'Assigned specialist', email: 'assigned@example.test', password,
  });
  assert.equal(registration.status, 201);
  const assignment = await f.owner.api('operator/assign', {
    handoffId: f.handoff, assignedTo: registration.data.profile.id, revision: 1, confirmed: true,
  });
  assert.equal(assignment.status, 200);
  const stale = (await staff.api('operator')).data.cases.find(h => h.id === f.handoff);
  assert.equal((await f.owner.api('operator/assign', {
    handoffId: f.handoff, assignedTo: f.ownerId, revision: stale.revision, confirmed: true,
  })).status, 200);
  const update = {handoffId:f.handoff,revision:stale.revision,status:'In progress',note:'Stale staff edit',confirmed:true};
  assert.equal((await staff.api('operator/progress', update)).status, 409);
  const current = (await staff.api('operator')).data.cases.find(h => h.id === f.handoff);
  assert.equal(current.assignedTo, f.ownerId);
  assert.equal((await staff.api('operator/progress', {...update,revision:current.revision})).status, 403);
  assert.equal((await f.a.api('status?ticketId=' + f.ticketA)).data.assignedTo, 'Owner');
});

test('credential-bearing chat creates no extracted facts and memory-off handoff carries no recalled preferences', async (t) => {
  const f = await fixture(t);
  await f.b.api('chat', {ticketId:f.ticketB,message:'api_key=synthetic-not-a-real-key Please email me.'});
  let ledger = (await f.b.api('memory?ticketId=' + f.ticketB)).data.ledger;
  assert.equal(ledger.filter(m => m.kind === 'preference').length, 0);
  await f.b.api('chat', {ticketId:f.ticketB,message:'Please email me instead of calling.'});
  const prepared = (await f.b.api('chat', {ticketId:f.ticketB,message:'Please get a human specialist to help me.',memory:false})).data;
  assert.equal(prepared.action.kind, 'handoff');
  const sent = await f.b.api('handoff', {ticketId:f.ticketB,summary:prepared.action.summary,memory:false,confirmed:true});
  assert.equal(sent.status, 201);
  const handoff = (await f.owner.api('operator')).data.cases.find(h => h.id === sent.data.id);
  assert.deepEqual(handoff.context.memories, []);
});

test('a replacement preference is used immediately and retired facts cannot return through model history', async (t) => {
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    prompts.push(context);
    return Response.json({choices:[{message:{content:context.guidance.join('\n')}}]});
  });
  const f = await fixture(t, {OPENAI_API_KEY:'synthetic'});
  await f.b.api('chat', {ticketId:f.ticketB,message:'Please email me instead of calling.'});
  const changed = (await f.b.api('chat', {ticketId:f.ticketB,message:'Please text me instead of calling.'})).data;
  assert.match(changed.reply, /text me/);
  assert.doesNotMatch(changed.reply, /email me/);
  assert.equal(prompts.length, 0, 'Explicit preferences do not need a model rewrite');
  const ledger = (await f.b.api('memory?ticketId='+f.ticketB)).data.ledger;
  const current = ledger.find(m=>m.kind==='preference' && !m.invalidatedAt);
  await f.b.api('memory', {ticketId:f.ticketB,id:current.id}, {method:'PATCH'});
  await f.b.api('chat', {ticketId:f.ticketB,message:'How do I prefer to be contacted?'});
  assert.equal(prompts.length, 0, 'Preference queries use active facts directly');
  await f.b.api('chat', {ticketId:f.ticketB,message:'What is the current status?'});
  assert.doesNotMatch(JSON.stringify(prompts.at(-1)), /email me|text me/);
});

test('asking about a preference never replaces the saved contact instruction', async (t) => {
  const f = await fixture(t);
  await f.b.api('chat', {ticketId:f.ticketB,message:'Please email me instead of calling.'});
  for (const message of ['How do I prefer to be contacted?', 'How should the team contact me?', 'What contact method do I prefer?', 'Can you tell me my contact preference?']) {
    assert.equal(extractFacts(message).filter(f=>f.kind==='preference').length, 0);
    const result = (await f.b.api('chat', {ticketId:f.ticketB,message})).data;
    assert.ok(result.evidence.some(e=>e.kind==='preference' && /email me/.test(e.text)));
    assert.equal(result.model, 'Support workflow');
  }
  assert.equal((await f.b.api('memory?ticketId='+f.ticketB)).data.ledger.filter(m=>m.kind==='preference' && !m.invalidatedAt).length, 1);
  assert.ok(extractFacts('Could you please text me instead of calling?').some(f=>f.kind==='preference'));
});

test('comparison can retrieve a published fix without saving a chat, action, fact or reuse receipt', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', {id:r.id,accepted:true,confirmed:true});
  const before = JSON.stringify(f.h.store.data);
  const receipts = f.h.store.db.prepare('SELECT COUNT(*) AS n FROM resolution_uses').get().n;
  const off = (await f.ask('The monitor flashes when booting the notebook.', {memory:false,retain:false})).data;
  const on = (await f.ask('The monitor flashes when booting the notebook.', {memory:true,retain:false})).data;
  assert.equal(off.trace.learnedResolutions, 0);
  assert.equal(on.trace.learnedResolutions, 1);
  assert.match(on.reply, /Disable adaptive refresh/);
  assert.equal(JSON.stringify(f.h.store.data), before);
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM resolution_uses').get().n, receipts);
});

test('two genuinely retrieved applicable procedures require clarification instead of merging steps', async (t) => {
  const f = await fixture(t);
  const r = await f.propose();
  await f.a.api('resolutions/confirm', {id:r.id,accepted:true,confirmed:true});
  const original = f.h.store.data.resolutions.find(x=>x.id===r.id);
  const second = {...original,id:'competing-qa',memoryId:'competing-qa-memory',solution:'A distinct synthetic procedure.'};
  f.h.store.update(data=>data.resolutions.push(second));
  const learning = createLearning(f.h.store, {
    recall:async()=>({source:'Local demo memory',facts:[original,second].map(x=>({id:x.memoryId,text:x.solution}))}),
  },null,{});
  const result = await learning.recall(original.companyId,'repair',f.question,{issue:f.question});
  assert.deepEqual(result.facts, []);
  assert.match(result.clarification[0].environment, /Multiple reviewed fixes match/);
});

test('a named different request prompts a safe switch instead of answering the selected case', async(t)=>{
  const f=await fixture(t);
  const battery=(await f.a.api('request',{title:'QA battery drain',issueDesc:'Model B firmware 3 loses charge.',confirmed:true,memory:false})).data.ticketId;
  const before=f.h.store.data.handoffs.length;
  const r=await f.a.api('chat',{ticketId:f.ticketA,message:'what about battery drain request'});
  assert.equal(r.status,200);
  assert.deepEqual(r.data.requestChoices,[{id:battery,title:'QA battery drain'}]);
  assert.doesNotMatch(r.data.reply,/is marked|current ETA|specialist case is already/i);
  assert.equal(r.data.action,null);
  assert.equal(r.data.trace.recalled,0);
  assert.equal(f.h.store.data.handoffs.length,before);
  const memories=f.h.store.data.memories.length;
  const failure=await f.a.api('chat',{ticketId:f.ticketA,message:'What about battery drain request? Restarting did not help.'});
  assert.deepEqual(failure.data.requestChoices,[{id:battery,title:'QA battery drain'}]);
  assert.equal(f.h.store.data.memories.length,memories);
  const foreign=await f.a.api('chat',{ticketId:f.ticketA,message:'What about '+f.ticketB+'?'});
  assert.deepEqual(foreign.data.requestChoices,[]);
  assert.doesNotMatch(foreign.data.reply,/is marked|current ETA|exists/i);
  // Selecting the offered request yields its own record and history.
  const selected=await f.a.api('chat',{ticketId:battery,message:'What is the status of my request?',retain:false});
  assert.equal(selected.data.ticket.id,battery);
  assert.match(selected.data.reply,/QA battery drain/);
  assert.doesNotMatch(selected.data.reply,/Model X display/);
});
