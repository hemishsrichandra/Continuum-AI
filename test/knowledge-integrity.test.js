import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { createFakeChroma } from './fake-chroma.js';
import { mapRecord } from '../server/data-sources.js';
import { passportView } from '../server/memory-pool.js';
import { sourceInfo } from '../server/troubleshooting.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'applies_to', safety: 'safety' }, diagnostics: {} };
const HEADER = 'id,title,symptoms,steps,applies_to,safety\n';
const K1 = 'K-1,Display flicker after startup,Display flickers after startup,"Open Display settings, select the Standard profile and restart.",Model X firmware 4,None identified\n';
const K2 = 'K-2,Invoice export fails,Cannot export invoice to PDF,"Open Billing, choose Export, pick PDF and retry the export.",Model X firmware 4,None identified\n';
const CHROMA = { VECTOR_STORE: 'chroma', CHROMA_URL: 'http://chroma.test:8000' };

async function setup(t, { verified = true, authoritative = true } = {}) {
  const fake = createFakeChroma();
  const w = await world(t, { config: CHROMA, vectorClient: fake.client });
  const bot = w.botOf(w.company);
  const body = (csv) => ({ confirmed: true, sourceType: 'csv_sync', chatbotId: bot, name: 'Knowledge base', fieldMapping: MAPPING, connection: { csv }, declaredVerified: verified, authoritativeSnapshot: authoritative });
  const created = await w.owner.api('company/data-sources', body(HEADER + K1 + K2));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.source.id;
  const resave = (csv, extra = {}) => w.owner.api('company/data-sources', { ...body(csv), id, ...extra });
  const sync = async () => (await w.owner.api(`company/data-sources/${id}/sync`, { confirmed: true })).data.result;
  const row = (key) => w.db().prepare('SELECT * FROM memory_pool WHERE source_key=?').get(`import:${id}:${key}`);
  const retrieve = (text) => w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text });
  return { w, fake, bot, id, resave, sync, row, retrieve };
}

// ---------------------------------------------------------------------------------------------- Test 5
test('a record withdrawn from a COMPLETE authoritative snapshot is retired, de-indexed and no longer recommendable', async (t) => {
  const s = await setup(t);
  const first = await s.sync();
  assert.equal(first.inserted, 2);
  assert.equal(first.snapshot, 'complete');
  await s.w.h.vectorIndex.drain();
  assert.ok(s.fake.collection().rows.has(s.row('K-2').id), 'verified imports are indexed');
  assert.equal((await s.retrieve('Cannot export invoice to PDF Model X firmware 4')).eligible.length, 1);

  await s.resave(HEADER + K1);
  const second = await s.sync();
  assert.equal(second.retiredFromSource, 1);
  assert.equal(s.row('K-2').status, 'retired');
  assert.equal(s.row('K-2').source_status, 'withdrawn');
  assert.equal(s.row('K-1').status, 'active');
  assert.equal((await s.retrieve('Cannot export invoice to PDF Model X firmware 4')).eligible.length, 0, 'retired before the index catches up');
  await s.w.h.vectorIndex.drain();
  assert.ok(!s.fake.collection().rows.has(s.row('K-2').id), 'the vector is removed');
  assert.ok(s.fake.collection().rows.has(s.row('K-1').id));

  // If the source lists it again it returns through the normal approval policy (here: declared verified).
  await s.resave(HEADER + K1 + K2);
  const third = await s.sync();
  assert.equal(third.reappeared, 1);
  assert.equal(s.row('K-2').status, 'active');
});

// ---------------------------------------------------------------------------------------------- Test 6
test('a partial, empty or mostly-invalid read never retires valid knowledge', async (t) => {
  const s = await setup(t);
  await s.sync();
  // 1. A record that is still in the source but now fails validation is not "withdrawn".
  await s.resave(HEADER + K1 + 'K-2,Invoice export fails,Cannot export invoice to PDF,,Model X firmware 4,None identified\n');
  const invalid = await s.sync();
  assert.equal(invalid.invalid, 1);
  assert.equal(s.row('K-2').status, 'active');
  // 2. An empty response (outage, wrong query) proves nothing.
  await s.resave(HEADER);
  const empty = await s.sync();
  assert.equal(empty.snapshot, 'partial');
  assert.match(empty.warning, /no records/);
  assert.equal(s.row('K-1').status, 'active');
  assert.equal(s.row('K-2').status, 'active');
  // 3. A source that is not marked as a complete snapshot never retires anything.
  await s.resave(HEADER + K1, { authoritativeSnapshot: false });
  const partial = await s.sync();
  assert.equal(partial.snapshot, 'partial');
  assert.equal(s.row('K-2').status, 'active');
  assert.equal(s.row('K-2').source_status, 'missing');
  assert.match(partial.warning, /not marked as a complete snapshot/);
  // 4. A failed read changes nothing at all.
  const before = s.w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE status='active'").get().n;
  const broken = await s.w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: s.bot, name: 'Broken', fieldMapping: MAPPING, connection: { csv: 'a,b\n"open' }, authoritativeSnapshot: true });
  assert.ok(broken.status >= 200);
  assert.equal(s.w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE status='active'").get().n, before);
});

// ---------------------------------------------------------------------------------------------- Test 7
test('unverified imports wait for approval; declared-verified imports are indexed straight away', async (t) => {
  const s = await setup(t, { verified: false });
  await s.sync();
  const k1 = s.row('K-1');
  assert.equal(k1.status, 'flagged_for_review');
  assert.match(k1.flagged_reason, /waiting for approval/);
  assert.equal(passportView(k1).verification, 'import_pending_review');
  assert.equal(k1.customer_confirmed, 0);
  assert.equal((await s.retrieve(ISSUE)).eligible.length, 0, 'not recommended until approved');
  await s.w.h.vectorIndex.drain();
  assert.ok(!s.fake.collection().rows.has(k1.id), 'and not in the vector index either');

  const review = await s.w.owner.api('operator/review-resolution', { id: k1.id, decision: 'keep', note: 'Checked against our runbook.', confirmed: true });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.equal(s.row('K-1').status, 'active');
  assert.equal(passportView(s.row('K-1')).verification, 'imported_approved');
  assert.equal(s.row('K-1').customer_confirmed, 0, 'approval is not customer verification');
  assert.equal((await s.retrieve(ISSUE)).eligible.length, 1);
  await s.w.h.vectorIndex.drain();
  assert.ok(s.fake.collection().rows.has(k1.id));

  const verified = await setup(t, { verified: true });
  await verified.sync();
  assert.equal(verified.row('K-1').status, 'active');
  assert.equal(passportView(verified.row('K-1')).verification, 'imported_declared_verified');
});

test('an import whose diagnostic column holds personal data is rejected, and diagnostic values are scrubbed', () => {
  const mapping = { fields: MAPPING.fields, diagnostics: { customer_email: 'email', region: 'region' } };
  const row = { id: '1', title: 'Flicker', symptoms: 'Display flickers', steps: 'Open Display settings and restart the laptop now.', applies_to: 'Model X', safety: 'None', email: 'a@b.com', region: 'eu call 98765 43210' };
  const rec = mapRecord(row, mapping, []);
  assert.ok(rec.issues.some((i) => /personal data/.test(i)));
  const clean = mapRecord(row, { fields: MAPPING.fields, diagnostics: { region: 'region' } }, []);
  assert.ok(!JSON.stringify(clean.passport).includes('98765'));
  assert.ok(clean.redactions >= 1);
});

// ---------------------------------------------------------------------------------------------- Test 8
test('a revision never inherits customer verification from its parent version', async (t) => {
  const fake = createFakeChroma();
  const w = await world(t, { config: CHROMA, vectorClient: fake.client });
  const bot = w.botOf(w.company);
  const v1 = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'rev:1' });
  assert.equal(v1.customer_confirmed, 1);
  assert.equal(passportView(v1).verification, 'customer_confirmed');
  const v2view = w.h.memoryPool.revise({ companyId: w.company, chatbotId: bot, id: 'staff-1' }, v1.id, {
    title: 'Display flicker: new driver', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4',
    solution: 'Install the approved display driver 4.2 from the vendor support site and restart.', confirmed: true, reviewedForPrivacy: true, version: 1,
  });
  const v2 = w.db().prepare('SELECT * FROM memory_pool WHERE id=?').get(v2view.id);
  assert.equal(v2.customer_confirmed, 0, 'the new instructions are not customer-verified');
  assert.equal(v2view.verification, 'specialist_revised');
  assert.equal(v2view.revisedFrom, v1.id);
  assert.equal(v2view.version, 2);
  assert.equal(v2view.parentVersionId, v1.id);
  assert.equal(w.db().prepare('SELECT status FROM memory_pool WHERE id=?').get(v1.id).status, 'superseded');
  const label = sourceInfo(v2).label;
  assert.doesNotMatch(label, /customer-confirmed/i);
  assert.match(label, /not yet confirmed by a customer/);
  assert.equal(sourceInfo(v1).label, 'Learned from a customer-confirmed specialist resolution', 'the original keeps its own verification');
  // The index follows: V1 is gone, V2 is searchable.
  await w.h.vectorIndex.drain();
  assert.ok(!fake.collection().rows.has(v1.id));
  assert.ok(fake.collection().rows.has(v2.id));
  const out = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text: ISSUE });
  assert.ok(!out.eligible.some((c) => c.id === v1.id), 'obsolete V1 is never recommended');
});
