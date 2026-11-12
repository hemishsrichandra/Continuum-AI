// Domain-agnostic company data-source mediator.
//
// An owner configures a source (csv_sync, sqlite, rest_api, postgres), maps the
// foreign fields onto Resolution Passport fields, previews/validates with a dry
// run, then syncs into THAT company's memory_pool. Nothing here is specific to
// repair or IT: diagnostic fields come from the service's diagnostic schema.
//
// Safety properties (all covered by test/data-sources.test.js):
//  * connection details are encrypted at rest (AES-256-GCM via delivery.seal)
//    and never returned; errors are sanitised so they cannot echo secrets
//  * SQLite: only server-allowlisted directories, read-only handle, identifiers
//    validated and quoted, no user-supplied SQL
//  * REST: https + server-allowlisted origins only, DNS results must be public,
//    no redirects, size/time limits (SSRF protection)
//  * unavailable drivers/credentials are reported as configuration-required,
//    never faked as a successful sync
//  * imports are idempotent upserts keyed by company/source/external id and never
//    overwrite locally reviewed, revised, flagged or failure-tracked records
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { resolve, sep } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { fault } from './providers.js';
import { botId, getBot, normalizeBot } from './chatbots.js';
import { insertPassport, computeInitialConfidence, normalizeSafety, stepsList } from './passports.js';
import { tokens } from './context.js';
import { localEmbedding, vectorToBlob, LOCAL_EMBEDDING_MODEL } from './scoring.js';
import { containsSecret, scrubPII, dangerousInstructions } from './privacy.js';
import { customerFacts } from './applicability.js';
import { field, json } from './requests.js';

export const SOURCE_TYPES = ['csv_sync', 'sqlite', 'rest_api', 'postgres'];
export const MAX_RECORDS = 2000;
const MAX_BYTES = 1048576;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
export const PASSPORT_FIELDS = ['externalId', 'title', 'symptoms', 'steps', 'applicability', 'safety', 'updatedAt'];
const REQUIRED_FIELDS = ['externalId', 'title', 'symptoms', 'steps'];

// --------------------------------------------------------------------------- safety helpers
export function isPrivateAddress(address) {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('ff')) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true; // not an IP: unknown, treat as unsafe
}
/** Throws unless the URL is an https (or explicitly allowed loopback) origin the server owner allowlisted and resolves publicly. */
export async function assertSafeUrl(input, { allowedOrigins, allowLoopback = false, resolver = lookup } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw fault(400, 'Enter a valid https URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash) throw fault(400, 'The URL must not contain credentials or fragments.');
  if (!(url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:')))
    throw fault(400, 'Only https URLs are allowed.');
  if (!allowedOrigins.has(url.origin))
    throw fault(400, 'The server owner must allow this origin in DATA_SOURCE_ALLOWED_ORIGINS before it can be used.');
  if (loopback) {
    if (!allowLoopback) throw fault(400, 'Private and loopback addresses are not allowed.');
    return url;
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    if (isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw fault(400, 'Private and loopback addresses are not allowed.');
    return url;
  }
  let addresses;
  try {
    addresses = await resolver(url.hostname, { all: true });
  } catch {
    throw fault(400, 'The host could not be resolved.');
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw fault(400, 'Private and loopback addresses are not allowed.');
  return url;
}
const dotted = (row, path) => String(path).split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), row);
const clip = (v, n) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const safeMessage = (e) => (e?.status ? e.message : 'The source could not be read. Check the configuration and try again.');

// --------------------------------------------------------------------------- mapping
export function validateMapping(input, schema = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'Map the source fields to Resolution Passport fields.');
  const out = { fields: {}, diagnostics: {} };
  const fields = input.fields && typeof input.fields === 'object' ? input.fields : input;
  for (const k of REQUIRED_FIELDS) if (typeof fields[k] !== 'string') throw fault(400, `Map the required field “${k}” to a source column or property.`);
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'fields' || k === 'diagnostics') continue;
    if (!PASSPORT_FIELDS.includes(k)) throw fault(400, `Unknown passport field “${k}”.`);
    if (typeof v !== 'string' || !PATH.test(v)) throw fault(400, `“${k}” must map to a plain column or property name.`);
    out.fields[k] = v;
  }
  for (const [k, v] of Object.entries(input.diagnostics || {})) {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(k) || typeof v !== 'string' || !PATH.test(v)) throw fault(400, 'Diagnostic mappings must be {field: column}.');
    if (schema.length && !schema.some((s) => s.key === k)) throw fault(400, `“${k}” is not in this service’s diagnostic schema.`);
    out.diagnostics[k] = v;
  }
  return out;
}
/** Map one source row to a candidate passport plus per-record validation issues. */
export function mapRecord(row, mapping, schema = [], { declaredVerified = false } = {}) {
  const get = (path) => dotted(row, path);
  const issues = [];
  const raw = {
    externalId: clip(get(mapping.fields.externalId), 200),
    title: clip(get(mapping.fields.title), 200),
    symptoms: clip(get(mapping.fields.symptoms), 2000),
    steps: clip(get(mapping.fields.steps), 3000),
    applicability: mapping.fields.applicability ? clip(get(mapping.fields.applicability), 500) : '',
    safety: mapping.fields.safety ? clip(get(mapping.fields.safety), 1000) : '',
    updatedAt: mapping.fields.updatedAt ? clip(get(mapping.fields.updatedAt), 40) : '',
  };
  for (const k of REQUIRED_FIELDS) if (!raw[k]) issues.push(`missing ${k}`);
  if (containsSecret(Object.values(raw).join('\n'))) issues.push('contains a credential or secret');
  const names = [];
  const redacted = {};
  let redactions = 0;
  for (const k of ['title', 'symptoms', 'steps', 'applicability', 'safety']) {
    const r = scrubPII(raw[k], { names });
    redacted[k] = r.text;
    redactions += r.count;
  }
  const hazards = dangerousInstructions(raw.steps);
  const conditions = [];
  for (const [key, column] of Object.entries(mapping.diagnostics)) {
    const value = clip(get(column), 200);
    if (!value) continue;
    const required = schema.find((s) => s.key === key)?.required !== false;
    conditions.push({ key, op: 'in', values: value.split(/[|;]/).map((v) => v.trim().toLowerCase()).filter(Boolean).slice(0, 20), required });
  }
  const applicability = { ...(redacted.applicability && { environmentText: redacted.applicability }), ...(conditions.length && { conditions }) };
  if (!applicability.environmentText && !conditions.length) applicability.universal = false;
  const safety = redacted.safety ? normalizeSafety(redacted.safety) : { restrictions: [] };
  const passport = { title: redacted.title, symptoms: redacted.symptoms, applicability, safety, steps: [redacted.steps] };
  const confidence = computeInitialConfidence(passport, {
    facts: customerFacts([raw.applicability, ...conditions.map((c) => c.key + ' ' + c.values.join(' '))].join('\n'), Object.fromEntries(conditions.map((c) => [c.key, c.values[0]]))),
    author: { kind: declaredVerified ? 'verified_import' : 'unverified_import' },
  });
  return { externalId: raw.externalId, passport, redactions, hazards, issues, cInit: confidence, updatedAt: raw.updatedAt };
}

// --------------------------------------------------------------------------- CSV
export function parseCsv(textInput) {
  const textValue = String(textInput).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < textValue.length; i++) {
    const c = textValue[i];
    if (quoted) {
      if (c === '"' && textValue[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && textValue[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
    if (rows.length > MAX_RECORDS + 1) throw fault(400, `At most ${MAX_RECORDS} records can be imported at once.`);
  }
  if (quoted) throw fault(400, 'The CSV has an unterminated quoted field.');
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  if (rows.length < 1) throw fault(400, 'The CSV is empty.');
  const header = rows[0].map((h) => h.trim());
  if (new Set(header).size !== header.length || header.some((h) => !IDENT.test(h))) throw fault(400, 'CSV column names must be unique plain identifiers.');
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function createDataSources(store, delivery, config = {}, { drivers = {}, resolver = lookup } = {}) {
  const sql = store.db;
  const allowedOrigins = new Set((config.DATA_SOURCE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const sqliteDirs = (config.DATA_SOURCE_SQLITE_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean).map((d) => { try { return realpathSync(resolve(d)); } catch { return null; } }).filter(Boolean);
  const allowLoopback = config.NODE_ENV !== 'production' && config.DATA_SOURCE_ALLOW_LOOPBACK === 'true';
  const now = () => new Date().toISOString();

  const availability = {
    csv_sync: () => ({ available: true }),
    sqlite: () => (sqliteDirs.length ? { available: true } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_SQLITE_DIRS to the directories that may be read.' }),
    rest_api: () => (allowedOrigins.size ? { available: true } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_ALLOWED_ORIGINS.' }),
    postgres: () => (drivers.postgres || config.DATA_SOURCE_POSTGRES_DRIVER === 'pg' ? { available: true, note: 'requires the optional “pg” package' } : { available: false, reason: 'unavailable: no PostgreSQL driver is installed (install the optional “pg” package and set DATA_SOURCE_POSTGRES_DRIVER=pg).' }),
  };
  const status = () => Object.fromEntries(SOURCE_TYPES.map((t) => [t, availability[t]()]));

  // ----- adapters: each returns an array of plain row objects (bounded)
  async function readCsv(conn) {
    if (typeof conn.csv !== 'string' || !conn.csv.trim()) throw fault(400, 'Paste or upload the CSV content.');
    if (Buffer.byteLength(conn.csv) > MAX_BYTES) throw fault(413, 'The CSV is larger than 1 MB.');
    return parseCsv(conn.csv);
  }
  function safePath(path) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw fault(400, 'Enter the database file path.');
    let real;
    try {
      real = realpathSync(resolve(path));
    } catch {
      throw fault(400, 'The database file was not found.');
    }
    if (!sqliteDirs.some((d) => real === d || real.startsWith(d + sep))) throw fault(400, 'That file is not in a directory the server owner allowed.');
    return real;
  }
  async function readSqlite(conn, mapping) {
    if (!availability.sqlite().available) throw fault(503, availability.sqlite().reason);
    const file = safePath(conn.path);
    if (!IDENT.test(conn.table || '')) throw fault(400, 'Enter a plain table name.');
    const columns = [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];
    if (columns.some((c) => !IDENT.test(c))) throw fault(400, 'Mapped columns must be plain identifiers for SQLite sources.');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const known = new Set(db.prepare(`PRAGMA table_info("${conn.table}")`).all().map((c) => c.name));
      if (!known.size) throw fault(400, 'That table was not found.');
      const missing = columns.filter((c) => !known.has(c));
      if (missing.length) throw fault(400, `Columns not found in the table: ${missing.join(', ')}.`);
      return db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM "${conn.table}" LIMIT ${MAX_RECORDS + 1}`).all();
    } finally {
      db.close();
    }
  }
  async function readRest(conn) {
    if (!availability.rest_api().available) throw fault(503, availability.rest_api().reason);
    const url = await assertSafeUrl(conn.url, { allowedOrigins, allowLoopback, resolver });
    let response;
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json', ...(conn.token && { Authorization: 'Bearer ' + conn.token }) } });
    } catch {
      throw fault(503, 'The REST source could not be reached.');
    }
    if (!response.ok) throw fault(503, 'The REST source returned HTTP ' + response.status + '.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES * 4) throw fault(413, 'The REST response is too large.');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fault(502, 'The REST source did not return JSON.'); }
    const list = conn.recordsPath ? dotted(body, conn.recordsPath) : body;
    if (!Array.isArray(list)) throw fault(502, 'The REST source must return an array of records (set “recordsPath” if they are nested).');
    return list.slice(0, MAX_RECORDS + 1);
  }
  async function readPostgres(conn, mapping) {
    const status_ = availability.postgres();
    if (!status_.available) throw fault(503, status_.reason);
    if (!IDENT.test(conn.table || '') || (conn.schema && !IDENT.test(conn.schema))) throw fault(400, 'Enter a plain table (and optional schema) name.');
    const columns = [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];
    if (columns.some((c) => !IDENT.test(c))) throw fault(400, 'Mapped columns must be plain identifiers for PostgreSQL sources.');
    const pg = drivers.postgres || (await import('pg').catch(() => null));
    if (!pg) throw fault(503, 'unavailable: the “pg” package is not installed.');
    const Client = pg.Client || pg.default?.Client;
    const client = new Client({ connectionString: conn.uri, statement_timeout: 12000, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      const table = (conn.schema ? `"${conn.schema}".` : '') + `"${conn.table}"`;
      const result = await client.query(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM ${table} LIMIT ${MAX_RECORDS + 1}`);
      return result.rows;
    } finally {
      await client.end().catch(() => {});
    }
  }
  const readers = { csv_sync: readCsv, sqlite: readSqlite, rest_api: readRest, postgres: readPostgres };

  const stored = (companyId, id) => {
    const row = sql.prepare('SELECT * FROM company_data_sources WHERE id=? AND company_id=?').get(id, companyId);
    if (!row) throw fault(404, 'Data source not found in this company.');
    return row;
  };
  const connection = (row) => (row.encrypted_connection_uri ? delivery.unseal(row.encrypted_connection_uri, 'datasource:' + row.id) : {});
  const publicView = (row) => ({
    id: row.id, chatbotId: row.chatbot_id, name: row.name, sourceType: row.source_type,
    hasConnection: Boolean(row.encrypted_connection_uri), fieldMapping: JSON.parse(row.field_mapping_json),
    diagnosticSchema: JSON.parse(row.diagnostic_schema_json), declaredVerified: Boolean(row.declared_verified),
    status: row.status, lastSyncedAt: row.last_synced_at, lastSyncResult: row.last_sync_result_json ? JSON.parse(row.last_sync_result_json) : null,
    lastError: row.last_error, createdAt: row.created_at, availability: availability[row.source_type]?.(),
  });

  /** Read + map + validate without writing anything. */
  async function dryRun(row, { limit = 200 } = {}) {
    const mapping = JSON.parse(row.field_mapping_json);
    const schema = JSON.parse(row.diagnostic_schema_json);
    const raw = await readers[row.source_type](connection(row), mapping);
    if (raw.length > MAX_RECORDS) throw fault(400, `At most ${MAX_RECORDS} records can be imported at once.`);
    const seen = new Set();
    const records = raw.map((r, index) => {
      const m = mapRecord(r, mapping, schema, { declaredVerified: Boolean(row.declared_verified) });
      if (m.externalId && seen.has(m.externalId)) m.issues.push('duplicate external id in this batch');
      seen.add(m.externalId);
      return { index, ...m };
    });
    const valid = records.filter((r) => !r.issues.length);
    return {
      total: records.length, valid: valid.length, invalid: records.length - valid.length,
      flaggedForReview: valid.filter((r) => r.hazards.length).length,
      withRedactions: valid.filter((r) => r.redactions).length,
      records,
      sample: records.slice(0, limit).map((r) => ({ index: r.index, externalId: r.externalId, title: r.passport.title, symptoms: r.passport.symptoms, steps: r.passport.steps, applicability: r.passport.applicability, safety: r.passport.safety, cInit: r.cInit.score, issues: r.issues, hazards: r.hazards, redactions: r.redactions })),
    };
  }

  /** Idempotent, transactional upsert into this company's pool. */
  async function sync(companyId, id, actor) {
    const row = stored(companyId, id);
    const result = { startedAt: now(), inserted: 0, updated: 0, unchanged: 0, skippedLocallyReviewed: 0, invalid: 0, flaggedForReview: 0, duplicates: 0, missingFromSource: 0 };
    let report;
    try {
      report = await dryRun(row, { limit: 0 });
    } catch (e) {
      const message = safeMessage(e);
      sql.prepare("UPDATE company_data_sources SET status='error',last_error=?,updated_at=? WHERE id=? AND company_id=?").run(message, now(), id, companyId);
      throw e.status ? e : fault(503, message);
    }
    const seenKeys = new Set();
    sql.transaction(() => {
      for (const rec of report.records) {
        if (rec.issues.length) {
          if (rec.issues.includes('duplicate external id in this batch')) result.duplicates++;
          else result.invalid++;
          continue;
        }
        const sourceKey = `import:${id}:${rec.externalId}`;
        seenKeys.add(sourceKey);
        const p = rec.passport;
        const contentHash = JSON.stringify([p.title, p.symptoms, p.applicability, p.safety, p.steps]);
        const latest = sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND source_key=? ORDER BY version_number DESC LIMIT 1').get(companyId, sourceKey);
        const evidence = { type: 'company_database_import', sourceId: id, sourceType: row.source_type, externalRecordId: rec.externalId, declaredVerified: Boolean(row.declared_verified), importedAt: now(), customerConfirmed: false, ...(rec.updatedAt && { sourceUpdatedAt: rec.updatedAt }) };
        if (!latest) {
          insertPassport(sql, {
            companyId, chatbotId: row.chatbot_id, origin: 'company_db_sync', sourceKey, sourceId: id, externalRecordId: rec.externalId,
            title: p.title, symptoms: p.symptoms, applicability: p.applicability, safety: p.safety, steps: p.steps,
            initialConfidence: rec.cInit.score, customerConfirmed: false, evidence,
            provenance: { cInit: rec.cInit, redactions: rec.redactions, hazards: rec.hazards, importedBy: actor },
          });
          result.inserted++;
          if (rec.hazards.length) result.flaggedForReview++;
          continue;
        }
        // Never overwrite local decisions: review, revision lineage, flags or tracked failures.
        const local = latest.locally_reviewed || latest.version_number > 1 || latest.parent_version_id || latest.status !== 'active' || latest.reuse_failure_count > 0 || latest.origin_type !== 'company_db_sync';
        if (local) { result.skippedLocallyReviewed++; continue; }
        const next = { title: p.title, symptoms_text: p.symptoms, applicability_json: JSON.stringify(p.applicability), safety_restrictions_json: JSON.stringify(p.safety), steps_json: JSON.stringify(stepsList(p.steps)) };
        const same = latest.title === next.title && latest.symptoms_text === next.symptoms_text && latest.applicability_json === next.applicability_json && latest.safety_restrictions_json === next.safety_restrictions_json && latest.steps_json === next.steps_json;
        if (same) { result.unchanged++; continue; }
        sql.prepare(`UPDATE memory_pool SET title=?,symptoms_text=?,applicability_json=?,safety_restrictions_json=?,steps_json=?,initial_confidence_score=?,
          status=?,flagged_reason=?,risk_level=?,verification_evidence_json=?,provenance_json=?,updated_at=? WHERE id=? AND company_id=?`)
          .run(next.title, next.symptoms_text, next.applicability_json, next.safety_restrictions_json, next.steps_json, rec.cInit.score,
            rec.hazards.length ? 'flagged_for_review' : 'active', rec.hazards.length ? 'Imported instructions need review: ' + rec.hazards.join(', ') : null, rec.hazards.length ? 'high' : 'standard',
            JSON.stringify(evidence), JSON.stringify({ cInit: rec.cInit, redactions: rec.redactions, hazards: rec.hazards, importedBy: actor, resyncedAt: now() }), now(), latest.id, companyId);
        // Content changed: refresh search terms and the local embedding (FTS is maintained by trigger).
        sql.prepare('UPDATE memory_pool SET search_terms=?,embedding_blob=?,embedding_model=? WHERE id=? AND company_id=?')
          .run([...tokens(`${p.title}\n${p.symptoms}`)].join(' '), vectorToBlob(localEmbedding(`${p.title}\n${p.symptoms}\n${stepsList(p.steps).join(' ')}`)), LOCAL_EMBEDDING_MODEL, latest.id, companyId);
        result.updated++;
        if (rec.hazards.length) result.flaggedForReview++;
      }
      const existing = sql.prepare("SELECT source_key FROM memory_pool WHERE company_id=? AND source_id=? AND origin_type='company_db_sync' AND parent_version_id IS NULL AND status<>'retired'").all(companyId, id);
      result.missingFromSource = existing.filter((e) => !seenKeys.has(e.source_key)).length;
      result.finishedAt = now();
      sql.prepare("UPDATE company_data_sources SET status='ok',last_error=NULL,last_synced_at=?,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?")
        .run(result.finishedAt, JSON.stringify(result), result.finishedAt, id, companyId);
    }).immediate();
    return result;
  }

  async function handle(req, endpoint, session, send) {
    if (!/\/api\/company\/data-sources/.test(endpoint)) return false;
    const profile = session.profile;
    if (!session.account_id || profile.role !== 'owner') throw fault(403, 'Only the company owner can manage data sources.');
    const companyId = profile.companyId;
    if (endpoint === 'GET /api/company/data-sources') {
      send(200, {
        sources: sql.prepare('SELECT * FROM company_data_sources WHERE company_id=? ORDER BY created_at').all(companyId).map(publicView),
        availability: status(), sourceTypes: SOURCE_TYPES, passportFields: PASSPORT_FIELDS, requiredFields: REQUIRED_FIELDS,
        chatbots: sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(companyId).map((r) => normalizeBot(JSON.parse(r.config))).map((b) => ({ id: b.id, name: b.name, diagnosticSchema: b.diagnosticSchema || [] })),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/data-sources') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm saving this data source.');
      if (!SOURCE_TYPES.includes(body.sourceType)) throw fault(400, 'Choose a supported source type.');
      const bot = getBot(sql, companyId, field(body.chatbotId || botId(profile), 'service', 200));
      const existing = body.id ? stored(companyId, body.id) : null;
      if (existing && (existing.chatbot_id !== bot.id || existing.source_type !== body.sourceType)) throw fault(409, 'The service and source type of an existing source cannot change.');
      const schema = bot.diagnosticSchema || [];
      const mapping = validateMapping(body.fieldMapping, schema);
      if (body.declaredVerified !== undefined && typeof body.declaredVerified !== 'boolean') throw fault(400, 'declaredVerified must be true or false.');
      const id = existing?.id || randomUUID();
      let encrypted = existing?.encrypted_connection_uri || null;
      if (body.connection !== undefined) {
        if (!body.connection || typeof body.connection !== 'object' || Array.isArray(body.connection)) throw fault(400, 'Send the connection details as an object.');
        const c = body.connection;
        if (body.sourceType === 'rest_api') await assertSafeUrl(c.url, { allowedOrigins, allowLoopback, resolver });
        if (body.sourceType === 'sqlite') { if (availability.sqlite().available) safePath(c.path); if (!IDENT.test(c.table || '')) throw fault(400, 'Enter a plain table name.'); }
        encrypted = delivery.seal(Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, MAX_BYTES)])), 'datasource:' + id);
      }
      if (!encrypted) throw fault(400, 'Provide the connection details.');
      const t = now();
      sql.prepare(`INSERT INTO company_data_sources(id,company_id,chatbot_id,name,source_type,encrypted_connection_uri,field_mapping_json,diagnostic_schema_json,declared_verified,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'configured',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,encrypted_connection_uri=excluded.encrypted_connection_uri,field_mapping_json=excluded.field_mapping_json,declared_verified=excluded.declared_verified,updated_at=excluded.updated_at WHERE company_data_sources.company_id=excluded.company_id`)
        .run(id, companyId, bot.id, field(body.name, 'name', 100), body.sourceType, encrypted, JSON.stringify(mapping), JSON.stringify(schema), body.declaredVerified ? 1 : 0, t, t);
      send(existing ? 200 : 201, { source: publicView(stored(companyId, id)) });
      return true;
    }
    const match = endpoint.match(/^(POST|DELETE) \/api\/company\/data-sources\/([^/]+)(?:\/(preview|sync))?$/);
    if (match) {
      const [, method, id, action] = match;
      const row = stored(companyId, decodeURIComponent(id));
      if (method === 'DELETE' && !action) {
        sql.prepare('DELETE FROM company_data_sources WHERE id=? AND company_id=?').run(row.id, companyId);
        // Imported passports stay (history/metrics); they are retired so they stop being recommended.
        sql.prepare("UPDATE memory_pool SET status='retired',updated_at=? WHERE company_id=? AND source_id=? AND origin_type='company_db_sync' AND status IN ('active','flagged_for_review') AND locally_reviewed=0").run(now(), companyId, row.id);
        send(200, { success: true });
        return true;
      }
      if (method === 'POST' && action === 'preview') {
        const report = await dryRun(row).catch((e) => { throw e.status ? e : fault(503, safeMessage(e)); });
        const { records, ...rest } = report;
        send(200, { dryRun: true, ...rest });
        return true;
      }
      if (method === 'POST' && action === 'sync') {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Confirm the sync.');
        send(200, { success: true, result: await sync(companyId, row.id, profile.id) });
        return true;
      }
    }
    throw fault(404, 'Data source route not found.');
  }
  return { handle, dryRun, sync, status, availability: status };
}
