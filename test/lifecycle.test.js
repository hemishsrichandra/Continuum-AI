// Structured compatibility fields (category, product family, model), review state, cross-source conflicts, staleness and the audit trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './_helpers.js';
import { mapRecord } from '../server/data-sources.js';
import { problemKey, applicabilityOverlaps, reviewStatusOf } from '../server/knowledge-lifecycle.js';

const MAPPING = { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', problemCategory: 'category', productFamily: 'family', model: 'model' }, diagnostics: {} };
const HEAD = 'id,title,symptoms,steps,category,family,model\n';
const csvOf = (...rows) => HEAD + rows.join('\n') + '\n';
const ROUTER = 'R-1,Router drops wifi,Router drops the wifi connection every few minutes,Update the router firmware then restart the router.,Wireless,Acme Router,X100';

async function setup(t, config = {}) {
  const w = await world(t, { config });
  const bot = w.botOf(w.company);
  const save = (csv, body = {}) => w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: bot, name: 'KB ' + Math.random().toString(36).slice(2, 6), fieldMapping: MAPPING, declaredVerified: true, connection: { csv }, ...body });
  const sync = async (csv, body) => { const s = (await save(csv, body)).data.source; const r = await w.owner.api(`company/data-sources/${s.id}/sync`, { confirmed: true }); return { id: s.id, result: r.data.result, status: r.status }; };
  const rows = (where = '1=1') => w.db().prepare(`SELECT * FROM memory_pool WHERE company_id=? AND ${where}`).all(w.company);
  const retrieve = (text, fields = {}, companyId = w.company) => w.h.memoryPool.retrieve({ companyId, chatbotId: companyId + ':repair', text, factsText: text, fields, allowedOrigins: ['company_db_sync'] });
  return { w, bot, save, sync, rows, retrieve };
}

test('category, product family and model become explicit, explainable conditions; a missing source value adds none', () => {
  const m = mapRecord({ id: 'A', title: 'T', symptoms: 'S', steps: 'Do it', category: 'Wi-Fi / Wireless', family: 'Acme Router', model: 'X100 | X200' }, MAPPING, [{ key: 'product_family', required: true }], {});
  const byKey = Object.fromEntries(m.passport.applicability.conditions.map((c) => [c.key, c]));
  assert.deepEqual(byKey.model.values, ['x100', 'x200']);
  assert.equal(byKey.model.required, true);
  assert.deepEqual(byKey.product_family.values, ['acme-router']);
  assert.equal(byKey.product_family.required, true, 'required when this service asks customers for a product_family');
  assert.equal(byKey.problem_category.required, false, 'a category only ever nudges ranking');
  assert.deepEqual(m.passport.applicability.structured, { problemCategory: ['wi-fi-wireless'], productFamily: ['acme-router'], models: ['x100', 'x200'] });
  const noSchema = mapRecord({ id: 'A', title: 'T', symptoms: 'S', steps: 'Do it', category: '', family: 'Acme Router', model: '' }, MAPPING, [], {});
  assert.deepEqual(noSchema.passport.applicability.conditions.map((c) => [c.key, c.required]), [['product_family', false]], 'a blank value adds nothing; a family the service does not ask about is optional');
});

test('model matching is structured: a matching model is explained, a different stated model is excluded, an unstated one asks instead of assuming', async (t) => {
  const s = await setup(t);
  const done = await s.sync(csvOf(ROUTER, 'R-2,Printer jams paper,Printer jams paper on every page,Open the tray and clear the paper path.,Printing,Acme Printer,P7'));
  assert.equal(done.result.inserted, 2);
  const match = await s.retrieve('My Acme router model X100 drops the wifi connection every few minutes');
  assert.equal(match.eligible[0]?.row.external_record_id, 'R-1');
  assert.ok(match.eligible[0].gate.reasons.some((r) => /model: x100/.test(r)), 'the reason names the model that matched');
  assert.ok(match.eligible[0].gate.structured.some((x) => x.field === 'model' && x.status === 'matched'));
  const implied = await s.retrieve('my X100 keeps dropping the wifi connection every few minutes');
  assert.equal(implied.eligible[0]?.row.external_record_id, 'R-1', 'a model named without the word "model" still counts');
  const other = await s.retrieve('My router drops the wifi connection every few minutes', { model: 'x200' });
  assert.equal(other.eligible.length, 0, 'a different model the customer stated is incompatible');
  assert.ok(other.rejected.some((r) => r.status === 'conflict'));
  const unknown = await s.retrieve('My router drops the wifi connection every few minutes');
  assert.equal(unknown.eligible.length, 0, 'an unstated model never creates false certainty');
  assert.equal(unknown.withheld[0]?.title, 'Router drops wifi', 'the customer is asked which model');
  assert.ok(unknown.withheld[0].missing.some((m) => /model/.test(m)));
});

test('a missing category never counts against a fix, a matching one raises it, a different one lowers it slightly, and no category is hard-coded', async (t) => {
  const s = await setup(t);
  await s.sync(csvOf('R-1,Router drops wifi,Router drops the wifi connection every few minutes,Update the router firmware then restart.,Wireless,,'));
  const none = (await s.retrieve('router drops the wifi connection every few minutes')).eligible[0];
  assert.equal(none.gate.compat, 1, 'category unknown: neutral');
  const hit = (await s.retrieve('router drops the wifi connection every few minutes', { problem_category: 'Wireless' })).eligible[0];
  assert.equal(hit.gate.compat, 1);
  assert.ok(hit.gate.reasons.some((r) => /problem category: wireless/.test(r)));
  const miss = (await s.retrieve('router drops the wifi connection every few minutes', { problem_category: 'Printing' })).eligible[0];
  assert.ok(miss.gate.compat < 1 && miss.gate.compat >= 0.7, 'a different category lowers ranking but never excludes');
  assert.ok(miss.gate.structured.some((x) => x.field === 'problem category' && x.status === 'different'));
  // Another company never sees these records or their vocabulary.
  assert.equal((await s.retrieve('router drops the wifi connection every few minutes', {}, s.w.companyB)).eligible.length, 0);
});

test('imported knowledge enters review unless the owner declared the source verified, and review state, provenance and basis are visible', async (t) => {
  const s = await setup(t);
  const unverified = await s.sync(csvOf('R-1,Router drops wifi,Router drops the wifi connection every few minutes,Update the router firmware then restart the router.,,,'), { declaredVerified: false });
  assert.equal(unverified.result.inserted, 1);
  const row = s.rows("origin_type='company_db_sync'")[0];
  assert.equal(row.status, 'flagged_for_review');
  assert.equal(reviewStatusOf(row), 'pending_review');
  assert.equal((await s.retrieve('router drops the wifi connection every few minutes')).eligible.length, 0, 'a pending import is never recommended');
  const view = (await s.w.owner.api('company/resolutions')).data;
  void view;
  const listed = s.w.h.memoryPool.list(s.w.company, s.bot).find((p) => p.id === row.id);
  assert.equal(listed.reviewStatus, 'pending_review');
  assert.equal(listed.verificationBasis, 'import_pending_review');
  assert.equal(listed.customerConfirmed, false);
  assert.ok(listed.lastSeenAt);
  assert.equal(listed.sourceId, unverified.id);
  // Customer-confirmed success, owner verification and an imported declaration are three different things.
  const declared = await s.sync(csvOf('R-9,Speaker crackles,Speaker crackles at high volume always,Lower the volume then reset the equaliser setting.,,,'), { declaredVerified: true });
  const d = s.rows("external_record_id='R-9'")[0];
  assert.equal(d.status, 'active');
  assert.equal(d.customer_confirmed, 0);
  assert.equal(s.w.h.memoryPool.list(s.w.company, s.bot).find((p) => p.id === d.id).verificationBasis, 'imported_declared_verified');
  void declared;
});

test('two sources that give different fixes for the same problem are quarantined for the owner, never resolved silently; the decision is audited', async (t) => {
  const s = await setup(t);
  const a = await s.sync(csvOf(ROUTER));
  assert.equal(s.w.h.dataSources.lifecycle.conflicts(s.w.company).length, 0);
  const b = await s.sync(csvOf('Z-7,Router drops wifi,The router drops its wifi connection every few minutes,Replace the antenna cable and reset the router to factory settings.,Wireless,Acme Router,X100'));
  assert.equal(b.result.inserted, 1);
  const open = s.w.h.dataSources.lifecycle.conflicts(s.w.company);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'different_fix_for_same_problem');
  const [first, second] = [open[0].a, open[0].b];
  assert.equal(first.status, 'flagged_for_review', 'unreviewed imports from both sources are quarantined');
  assert.equal(second.status, 'flagged_for_review');
  assert.equal((await s.retrieve('router model X100 drops the wifi connection every few minutes')).eligible.length, 0, 'neither side is recommended while the owner has not chosen');
  const overview = (await s.w.owner.api('company/knowledge-lifecycle/overview')).data;
  assert.equal(overview.conflicts.length, 1);
  const refused = await s.w.owner.api('company/knowledge-lifecycle/conflicts/resolve', { conflictId: open[0].id, decision: 'keep_first', note: 'x' });
  assert.equal(refused.status, 400, 'a decision must be confirmed');
  const resolved = await s.w.owner.api('company/knowledge-lifecycle/conflicts/resolve', { confirmed: true, conflictId: open[0].id, decision: 'keep_first', note: 'The first source is the vendor guide.' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.conflict.status, 'resolved');
  const live = s.w.db().prepare("SELECT status,locally_reviewed FROM memory_pool WHERE id=?");
  assert.deepEqual({ ...live.get(first.id) }, { status: 'active', locally_reviewed: 1 });
  assert.equal(live.get(second.id).status, 'retired');
  assert.equal((await s.w.owner.api('company/knowledge-lifecycle/conflicts/resolve', { confirmed: true, conflictId: open[0].id, decision: 'keep_both', note: 'again' })).status, 409);
  const history = (await s.w.owner.api(`company/knowledge-lifecycle/history?memoryId=${second.id}`)).data.events.map((e) => e.kind);
  assert.deepEqual(history.filter((k) => k !== 'imported'), ['conflict_opened', 'conflict_resolved']);
  assert.equal((await s.w.other.api('company/knowledge-lifecycle/conflicts/resolve', { confirmed: true, conflictId: open[0].id, decision: 'retire_both', note: 'nope' })).status, 404, 'another company cannot decide');
  void a;
});

test('records that cannot reach the same customer, or only reword the same fix, are not conflicts', async (t) => {
  const s = await setup(t);
  await s.sync(csvOf(ROUTER));
  await s.sync(csvOf('Z-8,Router drops wifi,Router drops the wifi connection every few minutes,Replace the antenna cable and reset to factory settings.,Wireless,Acme Router,X900'));
  assert.equal(s.w.h.dataSources.lifecycle.conflicts(s.w.company).length, 0, 'different models: both can be right');
  await s.sync(csvOf('Z-9,Router drops wifi,Router drops the wifi connection every few minutes,Update the router firmware, then restart the router.,Wireless,Acme Router,X100'));
  assert.equal(s.w.h.dataSources.lifecycle.conflicts(s.w.company).length, 0, 'the same fix reworded is a duplicate, not a conflict');
  assert.equal(problemKey('Router drops WiFi!'), problemKey('wifi router drops'));
  assert.equal(applicabilityOverlaps({ conditions: [{ key: 'model', op: 'in', values: ['a'] }] }, { conditions: [{ key: 'model', op: 'in', values: ['b'] }] }), false);
  assert.equal(applicabilityOverlaps({}, { conditions: [{ key: 'model', op: 'in', values: ['b'] }] }), true);
});

test('staleness is judged only against a COMPLETE sync; a paused, failed or partial source never marks anything stale, and nothing is deleted', async (t) => {
  const s = await setup(t);
  const a = await s.sync(csvOf(ROUTER, 'R-2,Printer jams paper,Printer jams paper on every page,Open the tray and clear the paper path.,Printing,Acme Printer,P7'), { staleAfterDays: 30 });
  const lc = s.w.h.dataSources.lifecycle;
  assert.deepEqual(lc.staleReport(s.w.company), [], 'everything was just seen');
  const day = 86400000;
  const old = new Date(Date.now() - 45 * day).toISOString();
  s.w.db().prepare("UPDATE memory_pool SET last_seen_at=? WHERE external_record_id='R-2'").run(old);
  assert.equal(lc.staleReport(s.w.company).length, 1);
  assert.match(lc.staleReport(s.w.company)[0].reason, /45 days/);
  // The same evidence is not stale when no complete sync has finished, whatever the source's status is.
  s.w.db().prepare('UPDATE company_data_sources SET last_complete_sync_at=NULL WHERE id=?').run(a.id);
  assert.deepEqual(lc.staleReport(s.w.company), []);
  s.w.db().prepare("UPDATE company_data_sources SET last_complete_sync_at=?,status='paused' WHERE id=?").run(new Date().toISOString(), a.id);
  assert.equal(lc.staleReport(s.w.company).length, 1, 'staleness only reports; it never changes or deletes a record');
  assert.equal(s.rows("status='active' AND origin_type='company_db_sync'").length, 2);
  const bad = await s.w.owner.api('company/data-sources', { confirmed: true, id: a.id, staleAfterDays: 0 });
  assert.equal(bad.status, 400);
});

test('the knowledge audit trail records lifecycle changes and is append-only', async (t) => {
  const s = await setup(t);
  const a = await s.sync(csvOf(ROUTER));
  const memory = s.rows("external_record_id='R-1'")[0];
  await s.w.owner.api('company/data-sources', { confirmed: true, id: a.id, name: 'Renamed source' });
  const csv2 = csvOf('R-1,Router drops wifi,Router drops the wifi connection every few minutes,Update the firmware to the latest version and restart the router twice.,Wireless,Acme Router,X100');
  await s.w.owner.api('company/data-sources', { confirmed: true, id: a.id, connection: { csv: csv2 } });
  await s.w.owner.api(`company/data-sources/${a.id}/sync`, { confirmed: true });
  const kinds = s.w.h.dataSources.lifecycle.history(s.w.company, memory.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['imported', 'updated_from_source']);
  const sourceEvents = s.w.db().prepare("SELECT kind FROM knowledge_events WHERE source_id=? AND memory_id IS NULL").all(a.id).map((e) => e.kind);
  assert.ok(sourceEvents.includes('source_edited'));
  assert.throws(() => s.w.db().prepare('UPDATE knowledge_events SET kind=? WHERE company_id=?').run('x', s.w.company), /append-only/);
  assert.throws(() => s.w.db().prepare('DELETE FROM knowledge_events WHERE company_id=?').run(s.w.company), /append-only/);
  const dump = JSON.stringify(s.w.db().prepare('SELECT * FROM knowledge_events').all());
  assert.ok(!/Update the firmware|antenna/.test(dump), 'the trail holds ids and reasons, never record text');
});

test('source health reaches the owner’s system status, and a failing source needs attention without leaking to other companies', async (t) => {
  const s = await setup(t);
  const bad = (await s.save('id,title,symptoms\nR-1,a,b\n')).data.source; // mapping needs a steps column the file lacks
  assert.equal((await s.w.owner.api(`company/data-sources/${bad.id}/sync`, { confirmed: true })).status, 400);
  const mine = (await s.w.owner.api('company/system-health')).data.summary;
  assert.equal(mine.knowledgeSources.state, 'attention');
  assert.equal(mine.knowledgeSources.failing, 1);
  assert.equal(mine.tasks.state, 'attention');
  const theirs = (await s.w.other.api('company/system-health')).data.summary;
  assert.equal(theirs.knowledgeSources.total, 0);
  assert.equal(theirs.knowledgeSources.state, 'ok');
});

test('migration 13 upgrades an existing sources table in place and keeps every source, its credentials and its history', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const { createHandler } = await import('../server/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'continuum-mig13-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = join(dir, 'm.sqlite');
  const w = await world(t, { file });
  const bot = w.botOf(w.company);
  const made = (await w.owner.api('company/data-sources', { confirmed: true, sourceType: 'csv_sync', chatbotId: bot, name: 'Old source', declaredVerified: true, fieldMapping: MAPPING, connection: { csv: csvOf(ROUTER) } })).data.source;
  await w.owner.api(`company/data-sources/${made.id}/sync`, { confirmed: true });
  const before = w.db().prepare('SELECT id,name,encrypted_connection_uri,field_mapping_json,last_synced_at FROM company_data_sources').get();
  w.h.close();
  // Put the table back the way version 12 left it: four source types, none of the new columns, migration 13 not recorded.
  const raw = new Database(file);
  raw.pragma('foreign_keys=OFF');
  const rows = raw.prepare('SELECT * FROM company_data_sources').all();
  raw.exec(`DROP TABLE company_data_sources; CREATE TABLE company_data_sources (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL, name TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('sqlite','postgres','rest_api','csv_sync')), encrypted_connection_uri TEXT, field_mapping_json TEXT NOT NULL DEFAULT '{}', diagnostic_schema_json TEXT NOT NULL DEFAULT '[]', declared_verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'configured', last_synced_at TEXT, last_sync_result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sync_interval_hours INTEGER, next_sync_at TEXT, authoritative_snapshot INTEGER NOT NULL DEFAULT 0, last_complete_sync_at TEXT, sync_cursor INTEGER);`);
  const oldColumns = ['id', 'company_id', 'chatbot_id', 'name', 'source_type', 'encrypted_connection_uri', 'field_mapping_json', 'diagnostic_schema_json', 'declared_verified', 'status', 'last_synced_at', 'last_sync_result_json', 'last_error', 'created_at', 'updated_at', 'sync_interval_hours', 'next_sync_at', 'authoritative_snapshot', 'last_complete_sync_at', 'sync_cursor'];
  for (const r of rows) raw.prepare(`INSERT INTO company_data_sources(${oldColumns.join(',')}) VALUES(${oldColumns.map(() => '?').join(',')})`).run(...oldColumns.map((c) => r[c]));
  raw.prepare('DELETE FROM schema_migrations WHERE version=13').run();
  raw.close();
  const h = createHandler({ file, config: {} });
  t.after(() => h.close());
  const db = h.store.db;
  const after = db.prepare('SELECT id,name,encrypted_connection_uri,field_mapping_json,last_synced_at FROM company_data_sources').get();
  assert.deepEqual({ ...after }, { ...before }, 'the source, its sealed credentials and its mapping are untouched');
  const columns = db.prepare('PRAGMA table_info(company_data_sources)').all().map((c) => c.name);
  for (const c of ['sync_checkpoint_json', 'high_water_json', 'scan_generation', 'lease_until', 'stop_request', 'consecutive_failures', 'incremental_enabled', 'stale_after_days']) assert.ok(columns.includes(c), c);
  db.prepare("INSERT INTO company_data_sources(id,company_id,chatbot_id,name,source_type,created_at,updated_at) VALUES('m1',?,?,'MySQL one','mysql','t','t')").run(w.company, bot);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company_data_sources").get().n, 2, 'new source types are now accepted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=13').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_pool WHERE source_id=?").get(made.id).n, 1, 'imported knowledge is untouched');
});
