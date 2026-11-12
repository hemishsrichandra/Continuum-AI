import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/providers.js';
import { world, ISSUE } from './_helpers.js';

const row = (collection, company, i, extra = {}) => {
  const scope = `${company}:repair:u${i % 7}`;
  if (collection === 'conversations') return { id: `c-${company}-${i}`, scope, ticketId: 'T' + i, message: 'm' + i, response: { reply: 'r' }, ...extra };
  if (collection === 'audit') return { id: `a-${company}-${i}`, scope, ticketId: 'T' + i, kind: 'chat', ...extra };
  if (collection === 'requirements') return { id: `q-${company}-${i}`, scope, ticketId: 'T' + i, note: 'n', ...extra };
  if (collection === 'memories') return { id: `m-${company}-${i}`, scope, ticketId: 'T' + i, kind: 'action', text: 't', ...extra };
  if (collection === 'handoffs') return { id: `h-${company}-${i}`, scope, companyId: company, chatbotId: company + ':repair', ticketId: 'T' + i, status: 'Queued', ...extra };
  if (collection === 'bookings') return { id: `b-${company}-${i}`, scope, companyId: company, provider: 'repair', ticketId: 'T' + i, datetime: 'd' + i, ...extra };
  if (collection === 'resolutions') return { id: `r-${company}-${i}`, companyId: company, chatbotId: company + ':repair', title: 't', ...extra };
  if (collection === 'repair') return { ticket_id: `SR-${company}-${i}`, customer_id: 'u' + (i % 7), companyId: company, chatbotId: company + ':repair', device: 'd', issue: 'i', status: 'Received', ...extra };
  if (collection === 'it') return { id: `IT-${company}-${i}`, user_id: 'u' + (i % 7), companyId: company, chatbotId: company + ':it', problem: 'p', state: 'Open', ...extra };
  throw new Error(collection);
};
const COLLECTIONS = ['repair', 'it', 'requirements', 'bookings', 'handoffs', 'audit', 'memories', 'conversations', 'resolutions'];
function fill(store, companies, perCollection = 6) {
  store.update((data) => {
    for (const c of companies) for (const col of COLLECTIONS) for (let i = 0; i < perCollection; i++) data[col].push(row(col, c, i));
    // Extra scope forms used by the application.
    data.audit.push({ id: 'audit-company-A', scope: 'company:A', kind: 'x' }, { id: 'audit-company-B', scope: 'company:B', kind: 'x' });
    data.memories.push({ id: 'k-A', scope: 'knowledge:A:chatbot:A:repair', ticketId: 'knowledge', kind: 'verified_resolution', text: 'k' }, { id: 'k-B', scope: 'knowledge:B:chatbot:B:repair', ticketId: 'knowledge', kind: 'verified_resolution', text: 'k' });
    data.operations.push({ scope: 'operator:A:s1', key: 'op1', fingerprint: 'f', response: {} }, { scope: 'operator:B:s1', key: 'op1', fingerprint: 'f', response: {} }, { scope: 'A:repair:u1', key: 'op2', fingerprint: 'f', response: {} });
  });
}
const owner = (r) => r.companyId ?? (r.scope.startsWith('knowledge:') ? r.scope.split(':')[1] : r.scope.startsWith('company:') || r.scope.startsWith('operator:') ? r.scope.split(':')[1] : r.scope.split(':')[0]);

test('dataFor returns exactly one company’s rows, in global order, and equals filtering the full store', () => {
  const s = new Store(':memory:');
  fill(s, ['A', 'B', 'C']);
  const full = s.data;
  for (const c of ['A', 'B', 'C']) {
    const scoped = s.dataFor(c);
    for (const col of [...COLLECTIONS, 'operations']) {
      const expected = full[col].filter((r) => (col === 'operations' ? r.scope.split(':')[col === 'operations' && r.scope.startsWith('operator:') ? 1 : 0] === c : owner(r) === c));
      assert.deepEqual(scoped[col], expected, `${c}/${col}`);
    }
    assert.deepEqual(scoped.outbox, []);
    assert.deepEqual(scoped.demoBookings, []);
  }
  assert.equal(s.dataFor('nobody').conversations.length, 0);
  assert.throws(() => s.dataFor(''), /company id/);
  assert.throws(() => s.dataFor(undefined), /company id/);
  s.close();
});

test('a company id that is a prefix of another does not leak rows (A vs AB)', () => {
  const s = new Store(':memory:');
  fill(s, ['A', 'AB', 'A-1']);
  const scoped = s.dataFor('A');
  for (const col of COLLECTIONS) assert.ok(scoped[col].every((r) => owner(r) === 'A'), col);
  assert.ok(scoped.conversations.length > 0);
  s.close();
});

test('scoped update changes, adds and removes only that company’s rows and never touches others', () => {
  const s = new Store(':memory:');
  fill(s, ['A', 'B']);
  const bBefore = JSON.stringify(s.dataFor('B'));
  const outsideBefore = JSON.stringify(s.data.conversations.filter((c) => owner(c) === 'B'));
  s.updateFor('A', (d) => {
    d.conversations.find((c) => c.id === 'c-A-0').message = 'changed';
    d.conversations.push({ id: 'new-A', scope: 'A:repair:u1', ticketId: 'T', message: 'fresh', response: {} });
    d.audit.splice(0, 2);
    d.handoffs.push({ id: 'h-new', scope: 'A:repair:u1', companyId: 'A', chatbotId: 'A:repair', ticketId: 'T', status: 'Queued' });
  });
  assert.equal(JSON.stringify(s.dataFor('B')), bBefore, 'company B untouched');
  assert.equal(JSON.stringify(s.data.conversations.filter((c) => owner(c) === 'B')), outsideBefore);
  const a = s.dataFor('A');
  assert.equal(a.conversations.find((c) => c.id === 'c-A-0').message, 'changed');
  assert.ok(a.conversations.some((c) => c.id === 'new-A'));
  assert.equal(a.audit.filter((r) => r.id.startsWith('a-A-')).length, 4, 'two audit rows removed');
  assert.ok(a.handoffs.some((h) => h.id === 'h-new'));
  assert.equal(s.data.conversations.length, s.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='conversations'").get().n);
  s.close();
});

test('scoped update is atomic: an error rolls everything back', () => {
  const s = new Store(':memory:');
  fill(s, ['A']);
  const before = JSON.stringify(s.data);
  assert.throws(() => s.updateFor('A', (d) => { d.conversations.length = 0; d.audit.push({ id: 'x', scope: 'A:r:u', kind: 'k' }); throw new Error('boom'); }), /boom/);
  assert.equal(JSON.stringify(s.data), before);
  s.close();
});

test('scoped and full updates interleave safely and keep a stable order', () => {
  const s = new Store(':memory:');
  fill(s, ['A', 'B']);
  for (let i = 0; i < 5; i++) {
    s.updateFor('A', (d) => d.conversations.push({ id: 'sa' + i, scope: 'A:repair:u1', ticketId: 'T', message: 'a' + i, response: {} }));
    s.updateFor('B', (d) => d.conversations.push({ id: 'sb' + i, scope: 'B:repair:u1', ticketId: 'T', message: 'b' + i, response: {} }));
    s.update((d) => d.conversations.push({ id: 'full' + i, scope: 'A:repair:u2', ticketId: 'T', message: 'f' + i, response: {} }));
  }
  const ids = s.data.conversations.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  const pos = (id) => ids.indexOf(id);
  for (let i = 1; i < 5; i++) { assert.ok(pos('sa' + i) > pos('sa' + (i - 1))); assert.ok(pos('sb' + i) > pos('sb' + (i - 1))); assert.ok(pos('full' + i) > pos('full' + (i - 1))); }
  assert.equal(s.data.conversations.length, 2 * 6 + 15);
  s.close();
});

test('scoped update gives rows without an id one (so they can be addressed), and operations stay keyed by scope+key', () => {
  const s = new Store(':memory:');
  fill(s, ['A']);
  s.updateFor('A', (d) => { d.audit.push({ scope: 'A:repair:u1', kind: 'no-id' }); d.operations.push({ scope: 'A:repair:u1', key: 'k9', fingerprint: 'f', response: {} }); });
  const added = s.dataFor('A').audit.find((r) => r.kind === 'no-id');
  assert.ok(added.id);
  assert.equal(s.operation('A:repair:u1', 'k9', 'f') !== undefined, true);
  s.close();
});

test('rows() validates its inputs', () => {
  const s = new Store(':memory:');
  fill(s, ['A']);
  assert.equal(s.rows('handoffs', '$.companyId', 'A').length, 6);
  assert.throws(() => s.rows('nope', '$.companyId', 'A'), /Invalid/);
  assert.throws(() => s.rows('handoffs', "$.companyId') OR 1=1 --", 'A'), /Invalid/);
  s.close();
});

test('SQL plans: company and scope reads use indexes, not table scans', () => {
  const s = new Store(':memory:');
  const plan = (sql, ...args) => s.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');
  assert.match(plan("SELECT payload FROM records WHERE collection=? AND json_extract(payload,'$.companyId')=?", 'handoffs', 'x'), /USING INDEX records_(company|chatbot)/);
  assert.match(plan("SELECT payload FROM records WHERE collection=? AND json_extract(payload,'$.scope')>=? AND json_extract(payload,'$.scope')<?", 'conversations', 'a:', 'a;'), /USING INDEX record_scope/);
  assert.match(plan('SELECT COALESCE(MAX(position),-1) FROM records WHERE collection=?', 'audit'), /USING (COVERING )?INDEX records_position/);
  s.close();
});

test('other tenants’ data does not slow reads or writes (30k foreign rows; previously 0.5–3.7 s per request)', async (t) => {
  const w = await world(t);
  const a = await w.customer('alice');
  const id = await w.ticket(a, ISSUE);
  await w.ask(a, id, ISSUE);
  const db = w.db();
  const ins = db.prepare('INSERT INTO records VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) ins.run('conversations', 'x:' + i, i + 1000, JSON.stringify({ id: 'c' + i, scope: 'other:repair:u' + (i % 50), ticketId: 'T' + (i % 500), message: 'hello ' + i, response: { reply: 'r', trace: { elapsedMs: 5 } } }));
    for (let i = 0; i < 5000; i++) ins.run('handoffs', 'h:' + i, i + 1000, JSON.stringify({ id: 'h' + i, scope: 'other:repair:u' + (i % 50), companyId: 'other', chatbotId: 'other:repair', ticketId: 'T' + i, status: 'Queued', createdAt: new Date().toISOString() }));
    for (let i = 0; i < 5000; i++) ins.run('repair', 'r:' + i, i + 1000, JSON.stringify({ ticket_id: 'SR-' + i, customer_id: 'u' + (i % 50), companyId: 'other', chatbotId: 'other:repair', device: 'd', issue: 'i', status: 'Received' }));
    for (let i = 0; i < 10000; i++) ins.run('audit', 'a:' + i, i + 1000, JSON.stringify({ id: 'a' + i, scope: 'other:repair:u' + (i % 50), ticketId: 'T' + i, kind: 'chat' }));
  })();
  const median = async (fn) => { const t = []; for (let i = 0; i < 5; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return t.sort((x, y) => x - y)[2]; };
  const limit = 120; // ms; generous for slow CI machines. Before the fix these took roughly 500–3700 ms.
  let n = 0;
  const timings = {
    workspace: await median(() => a.api('workspace')),
    status: await median(() => a.api('status?ticketId=' + id)),
    conversation: await median(() => a.api('conversation?ticketId=' + id)),
    operator: await median(() => w.owner.api('operator')),
    intelligence: await median(() => w.owner.api(`companies/${w.company}/intelligence`)),
    createRequest: await median(() => a.api('request', { title: 'Model X ' + n++, issueDesc: ISSUE, confirmed: true })),
    chat: await median(() => w.ask(a, id, 'Still broken ' + n++)),
  };
  for (const [name, ms] of Object.entries(timings)) assert.ok(ms < limit, `${name} took ${ms.toFixed(1)} ms with 30k foreign rows`);
  // And correctness is unchanged: the other tenant's rows are invisible and untouched.
  assert.equal((await a.api('workspace')).data.tickets.length, 6, 'the original ticket plus the five timed creations, and nothing from the other tenant');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE collection='handoffs' AND json_extract(payload,'$.companyId')='other'").get().n, 5000);
});
