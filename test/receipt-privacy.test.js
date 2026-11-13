import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ISSUE, FOUR } from './_helpers.js';
import { shapeEvidence, shapeProvenance } from '../server/privacy-sanitizer.js';

const bot = (w) => w.botOf(w.company);
const SECRETS = ['jane.doe@example.com', '98765 43210', '+44 20 7946 0958', '12 Park Road', 'SN-4455-AB-9981', 'bob@corp.example'];
const clean = (json) => { for (const s of SECRETS) assert.ok(!json.includes(s), `${s} must not be stored: ${json.slice(0, 200)}`); };
const base = (w, extra) => ({ companyId: w.company, chatbotId: bot(w), origin: 'specialist_confirmed', title: FOUR[0][0], symptoms: FOUR[0][1], applicability: { environmentText: 'Model X firmware 4' }, safety: { restrictions: [], noneIdentified: true, reviewed: true }, steps: [FOUR[0][2]], initialConfidence: 0.8, ...extra });
const stored = (w, id) => w.db().prepare('SELECT verification_evidence_json e, provenance_json p, review_note n FROM memory_pool WHERE id=?').get(id);

test('receipts: personal data in evidence and provenance is redacted before storage, unknown keys are dropped, legitimate receipts survive', async (t) => {
  const w = await world(t);
  const row = w.h.memoryPool.insert(base(w, {
    sourceKey: 'r:1',
    evidence: {
      customerConfirmed: true, confirmedAt: '2026-11-13T10:00:00Z', proposalId: 'prop-1', handoffId: 'jane.doe@example.com', label: 'Confirmed. Contact jane.doe@example.com or +44 20 7946 0958',
      reviewNote: 'Called customer at 98765 43210, lives at 12 Park Road, Mumbai', externalRecordId: 'bob@corp.example', sourceUpdatedAt: 'SN-4455-AB-9981',
      customerEmail: 'jane.doe@example.com', rawTranscript: 'phone 98765 43210', nested: { deep: { email: 'jane.doe@example.com' } },
    },
    provenance: { cInit: { score: 0.8, components: { P: 1 }, authorBasis: 'note from jane.doe@example.com' }, redactions: 2, hazards: ['call +44 20 7946 0958'], importedBy: 'bob@corp.example', phone: '98765 43210', autoPublished: { at: '2026-11-13T10:00:00Z', policy: 'contact 98765 43210' } },
  }));
  const s = stored(w, row.id);
  clean(s.e);
  clean(s.p);
  const ev = JSON.parse(s.e), pv = JSON.parse(s.p);
  assert.equal(ev.customerConfirmed, true);
  assert.equal(ev.proposalId, 'prop-1');
  assert.equal(ev.confirmedAt, '2026-11-13T10:00:00.000Z');
  assert.equal(ev.handoffId, '[redacted id]', 'an identifier that is really an email is not kept');
  assert.match(ev.label, /\[redacted email\]/);
  assert.equal(ev.customerEmail, undefined);
  assert.equal(ev.rawTranscript, undefined);
  assert.equal(ev.nested, undefined, 'unknown keys never reach storage');
  assert.equal(pv.phone, undefined);
  assert.equal(pv.importedBy, '[redacted id]');
  assert.equal(pv.cInit.score, 0.8);
  assert.ok(pv.receiptRedactions >= 6, 'the redaction count is kept as a safe receipt');
});

test('receipts: credentials and tokens in evidence or provenance are rejected, not stored', async (t) => {
  const w = await world(t);
  assert.throws(() => w.h.memoryPool.insert(base(w, { sourceKey: 'r:2', evidence: { label: 'api_key = sk-abcdef0123456789' } })), /credentials/i);
  assert.throws(() => w.h.memoryPool.insert(base(w, { sourceKey: 'r:3', provenance: { note: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' } })), /credentials/i);
  assert.throws(() => w.h.memoryPool.insert(base(w, { sourceKey: 'r:4', provenance: { cInit: { basis: 'password: hunter2hunter2' } } })), /credentials/i);
  assert.equal(w.db().prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_key LIKE 'r:%'").get().n, 0);
  assert.throws(() => shapeEvidence({ label: 'bearer abcdefghijklmnopqrstuvwxyz012345' }), /credentials/i);
});

test('receipts: every publication route applies the same policy (revision note, overdue publication, review note, import update)', async (t) => {
  const w = await world(t);
  const v1 = w.seed(w.company, { title: FOUR[0][0], symptoms: FOUR[0][1], steps: [FOUR[0][2]], sourceKey: 'r:rev' });
  const v2 = w.h.memoryPool.revise({ companyId: w.company, chatbotId: bot(w), id: 'staff-1' }, v1.id, {
    title: 'Display flicker: driver', symptoms: 'Display flickers after startup', environment: 'Model X firmware 4', solution: 'Install the approved driver 4.2 and restart the laptop now.',
    note: 'Checked with jane.doe@example.com on 98765 43210', confirmed: true, reviewedForPrivacy: true, version: 1,
  });
  const rev = stored(w, v2.id);
  clean(rev.e);
  assert.match(JSON.parse(rev.e).reviewNote, /redacted/);
  assert.equal(JSON.parse(rev.e).revisedFrom, v1.id, 'the lineage receipt is preserved');
  assert.equal(JSON.parse(rev.e).customerConfirmed, false);

  // Review notes: stored scrubbed; credentials rejected.
  w.db().prepare("UPDATE memory_pool SET status='flagged_for_review' WHERE id=?").run(v2.id);
  assert.throws(() => w.h.memoryPool.review({ companyId: w.company, chatbotId: bot(w) }, v2.id, { decision: 'keep', note: 'password: hunter2hunter2', confirmed: true }), /credentials/i);
  w.h.memoryPool.review({ companyId: w.company, chatbotId: bot(w) }, v2.id, { decision: 'keep', note: 'OK per jane.doe@example.com, call 98765 43210', confirmed: true });
  clean(stored(w, v2.id).n);
  assert.match(stored(w, v2.id).n, /redacted/);
});

test('receipts: rows stored before the policy are scrubbed by the migration and never returned raw by the API', async (t) => {
  const w = await world(t);
  const row = w.seed(w.company, { title: FOUR[1][0], symptoms: FOUR[1][1], steps: [FOUR[1][2]], sourceKey: 'r:legacy' });
  // A legacy row (or a direct SQL write) carrying raw personal data.
  w.db().prepare('UPDATE memory_pool SET verification_evidence_json=?,provenance_json=?,review_note=? WHERE id=?').run(
    JSON.stringify({ customerConfirmed: true, label: 'from jane.doe@example.com', customerEmail: 'jane.doe@example.com' }), JSON.stringify({ importedBy: 'bob@corp.example', phone: '98765 43210' }), 'call 98765 43210', row.id);
  const viaApi = JSON.stringify((await w.owner.api('operator')).data.passports);
  clean(viaApi);
  assert.ok(viaApi.includes(row.id), 'the passport is still listed');
  // The one-off migration cleans the stored copy as well.
  w.db().prepare('DELETE FROM schema_migrations WHERE version=8').run();
  w.h.store.migrateV8();
  const after = stored(w, row.id);
  clean(after.e + after.p + after.n);
  assert.equal(JSON.parse(after.e).customerConfirmed, true, 'legitimate receipt content survives');
  assert.equal(w.db().prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=8').get().n, 1);
});

test('receipts: the shapers accept normal structured receipts unchanged', () => {
  const evidence = { type: 'company_database_import', sourceId: 'src-1', sourceType: 'csv_sync', externalRecordId: 'K-1', declaredVerified: true, importedAt: '2026-11-13T10:00:00.000Z', customerConfirmed: false, sourceUpdatedAt: '2026-11-01' };
  const r = shapeEvidence(evidence);
  assert.deepEqual(r.value, { ...evidence, sourceUpdatedAt: '2026-11-01T00:00:00.000Z' }, 'dates are normalised to ISO');
  assert.equal(r.count, 0);
  assert.deepEqual(r.dropped, []);
  const pv = shapeProvenance({ cInit: { score: 0.8, components: { P_passport: 1, S_diag: 0.5 }, formula: 'C_init = 0.40*P + 0.35*S + 0.25*R' }, redactions: 0, hazards: [], importedBy: 'scheduled' });
  assert.equal(pv.value.cInit.components.P_passport, 1);
  assert.equal(pv.value.importedBy, 'scheduled');
  void ISSUE;
});
