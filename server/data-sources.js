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
import { isPrivateAddress, resolveAllowed, pinnedGet, resolvePostgresDestination } from './net-guard.js';
import { resolve, sep } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { fault } from './providers.js';
import { botId, getBot, normalizeBot } from './chatbots.js';
import { insertPassport, computeInitialConfidence, normalizeSafety, stepsList, refreshFacets } from './passports.js';
import { tokens } from './context.js';
import { localEmbedding, vectorToBlob, LOCAL_EMBEDDING_MODEL } from './scoring.js';
import { containsSecret, scrubPII, dangerousInstructions } from './privacy.js';
import { customerFacts } from './applicability.js';
import { field, json } from './requests.js';
import { sanitizeDeep, isPersonalKey, shapeEvidence, shapeProvenance } from './privacy-sanitizer.js';

export const SOURCE_TYPES = ['csv_sync', 'sqlite', 'rest_api', 'postgres'];
// Preview and CSV limits only. A real sync is not capped at this number: it reads databases in batches (see DATA_SOURCE_BATCH_SIZE and
// DATA_SOURCE_MAX_RECORDS, a pause-and-resume safety limit, never a silent cut-off).
export const MAX_RECORDS = 2000;
const CSV_MAX_ROWS = 50000;
const MAX_BYTES = 1048576;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
export const PASSPORT_FIELDS = ['externalId', 'title', 'symptoms', 'steps', 'applicability', 'safety', 'updatedAt'];
const REQUIRED_FIELDS = ['externalId', 'title', 'symptoms', 'steps'];

// --------------------------------------------------------------------------- safety helpers
export { isPrivateAddress };
/** Throws unless the URL is an https (or explicitly allowed loopback) origin the server owner allowlisted and resolves publicly. */
export async function assertSafeUrl(input, { allowedOrigins, allowLoopback = false, resolver = lookup, ownerOrigins = false } = {}) {
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
    throw fault(400, ownerOrigins ? `Approve ${url.origin} under “Allowed websites” before connecting to it.` : 'The server owner must allow this origin in DATA_SOURCE_ALLOWED_ORIGINS before it can be used.');
  try {
    await resolveAllowed(url.hostname, { allowLoopback, resolver });
  } catch (e) {
    throw fault(e.status || 400, e.message);
  }
  return url;
}
/** Like assertSafeUrl, but also returns the validated address the connection must be pinned to. */
export async function resolveDestination(input, options) {
  const url = await assertSafeUrl(input, options);
  const [first] = await resolveAllowed(url.hostname, { allowLoopback: options.allowLoopback, resolver: options.resolver });
  return { url, address: first.address, family: first.family };
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
    // A field that holds personal data (an email, phone, customer id ...) is never a compatibility condition.
    if (isPersonalKey(key)) { issues.push(`diagnostic field “${key}” holds personal data and cannot be used`); continue; }
    const value = clip(get(column), 200);
    if (!value) continue;
    const required = schema.find((s) => s.key === key)?.required !== false;
    conditions.push({ key, op: 'in', values: value.split(/[|;]/).map((v) => v.trim().toLowerCase()).filter(Boolean).slice(0, 20), required });
  }
  let applicability = { ...(redacted.applicability && { environmentText: redacted.applicability }), ...(conditions.length && { conditions }) };
  // Nested values (the diagnostic conditions) get the same inspection as free text.
  const cleanedApplicability = sanitizeDeep(applicability);
  applicability = cleanedApplicability.value;
  redactions += cleanedApplicability.count;
  if (cleanedApplicability.secret) issues.push('contains a credential or secret');
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
export function parseCsv(textInput, { maxRows = CSV_MAX_ROWS } = {}) {
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
    if (rows.length > maxRows + 1) throw fault(400, `A CSV can hold at most ${maxRows} rows. Use a SQLite or PostgreSQL source, or split the file.`);
  }
  if (quoted) throw fault(400, 'The CSV has an unterminated quoted field.');
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  if (rows.length < 1) throw fault(400, 'The CSV is empty.');
  // Real exports have headers like "Ticket ID" or "Resolution (internal)". A header that is already a plain identifier is kept
  // exactly (so saved mappings keep working); any other header becomes one: "Ticket ID" -> Ticket_ID.
  const header = rows[0].map((h) => { const t = h.trim(); return IDENT.test(t) ? t : t.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, 'c_').slice(0, 64) || 'column'; });
  if (new Set(header).size !== header.length) throw fault(400, 'CSV column names must be unique.');
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function createDataSources(store, delivery, config = {}, { drivers = {}, resolver = lookup } = {}) {
  const sql = store.db;
  const allowedOrigins = new Set((config.DATA_SOURCE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const sqliteDirs = (config.DATA_SOURCE_SQLITE_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean).map((d) => { try { return realpathSync(resolve(d)); } catch { return null; } }).filter(Boolean);
  const allowLoopback = config.NODE_ENV !== 'production' && config.DATA_SOURCE_ALLOW_LOOPBACK === 'true';
  const pgHosts = new Set((config.DATA_SOURCE_POSTGRES_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const pgPorts = new Set((config.DATA_SOURCE_POSTGRES_PORTS || '5432').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536));
  const now = () => new Date().toISOString();
  const intOr = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  const batchSize = intOr(config.DATA_SOURCE_BATCH_SIZE, 500, 10, 5000); // rows fetched, mapped and written per step
  const maxRecords = intOr(config.DATA_SOURCE_MAX_RECORDS, 100000, 100, 5000000); // one sync run pauses here and can be resumed
  // An uploaded CSV is stored sealed with the source, so it has its own size limit (default 10 MB, at most 50 MB).
  const csvMaxBytes = intOr(config.DATA_SOURCE_CSV_MAX_BYTES, 10 * 1048576, 65536, 50 * 1048576);
  // Owners may approve websites for REST sources in the app, unless the server operator turns that off. The network guard
  // (public DNS only, pinned address, no redirects) applies to every origin either way.
  const ownerOrigins = config.DATA_SOURCE_OWNER_ORIGINS !== 'false';
  const originsFor = (companyId) => new Set([...allowedOrigins, ...(ownerOrigins && companyId ? sql.prepare('SELECT origin FROM company_source_origins WHERE company_id=?').all(companyId).map((r) => r.origin) : [])]);

  const availability = {
    csv_sync: () => ({ available: true }),
    sqlite: () => (sqliteDirs.length ? { available: true } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_SQLITE_DIRS to the directories that may be read.' }),
    rest_api: () => (allowedOrigins.size || ownerOrigins ? { available: true, ...(ownerOrigins && { note: 'Approve the website under “Allowed websites” first.' }) } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_ALLOWED_ORIGINS.' }),
    postgres: () => {
      if (!(drivers.postgres || config.DATA_SOURCE_POSTGRES_DRIVER === 'pg')) return { available: false, reason: 'unavailable: no PostgreSQL driver is installed (install the optional “pg” package and set DATA_SOURCE_POSTGRES_DRIVER=pg).' };
      if (!pgHosts.size) return { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_POSTGRES_HOSTS to the database hosts that may be read.' };
      return { available: true, note: 'read-only, TLS required' };
    },
  };
  const status = () => Object.fromEntries(SOURCE_TYPES.map((t) => [t, availability[t]()]));

  // ----- adapters: each returns an array of plain row objects (bounded)
  async function readCsv(conn) {
    if (typeof conn.csv !== 'string' || !conn.csv.trim()) throw fault(400, 'Paste or upload the CSV content.');
    if (Buffer.byteLength(conn.csv) > csvMaxBytes) throw fault(413, `The CSV is larger than ${Math.round(csvMaxBytes / 1048576)} MB. Split it, or use a SQLite or PostgreSQL source.`);
    return parseCsv(conn.csv, { maxRows: Math.max(CSV_MAX_ROWS, Math.ceil(csvMaxBytes / 100)) });
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
  async function readSqlite(conn, mapping, { offset = 0, limit = batchSize } = {}) {
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
      // A stable order makes the page boundaries reliable; the id column was validated as a plain identifier above.
      return db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM "${conn.table}" ORDER BY "${mapping.fields.externalId}" LIMIT ? OFFSET ?`).all(limit, offset);
    } finally {
      db.close();
    }
  }
  async function readRest(conn, { page = null, companyId = null } = {}) {
    if (!availability.rest_api().available) throw fault(503, availability.rest_api().reason);
    // Resolve and validate ONCE, then connect to that exact address (no second DNS lookup can redirect the request).
    const dest = await resolveDestination(conn.url, { allowedOrigins: originsFor(companyId), allowLoopback, resolver, ownerOrigins });
    let response;
    try {
      const target = new URL(String(dest.url));
      if (page !== null) {
        if (!IDENT.test(conn.pageParam || '')) throw fault(400, 'The page parameter must be a plain name such as page.');
        target.searchParams.set(conn.pageParam, String(page));
        const size = Number(conn.pageSize);
        if (Number.isInteger(size) && size >= 10 && size <= 5000) target.searchParams.set(IDENT.test(conn.limitParam || '') ? conn.limitParam : 'limit', String(size));
      }
      response = await pinnedGet({ url: target, address: dest.address, family: dest.family, timeoutMs: 12000, maxBytes: MAX_BYTES * 4, headers: { Accept: 'application/json', ...(conn.token && { Authorization: 'Bearer ' + conn.token }) } });
    } catch (e) {
      throw fault(e.status === 413 ? 413 : 503, e.status ? e.message : 'The REST source could not be reached.');
    }
    if (response.status < 200 || response.status >= 300) throw fault(503, 'The REST source returned HTTP ' + response.status + '.');
    let body;
    try { body = JSON.parse(response.body.toString()); } catch { throw fault(502, 'The REST source did not return JSON.'); }
    const list = conn.recordsPath ? dotted(body, conn.recordsPath) : body;
    if (!Array.isArray(list)) throw fault(502, 'The REST source must return an array of records (set “recordsPath” if they are nested).');
    return list; // one HTTP response, bounded by MAX_BYTES; larger sources should be SQLite/PostgreSQL or split
  }
  async function readPostgres(conn, mapping, { offset = 0, limit = batchSize } = {}) {
    const status_ = availability.postgres();
    if (!status_.available) throw fault(503, status_.reason);
    if (!IDENT.test(conn.table || '') || (conn.schema && !IDENT.test(conn.schema))) throw fault(400, 'Enter a plain table (and optional schema) name.');
    const columns = [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];
    if (columns.some((c) => !IDENT.test(c))) throw fault(400, 'Mapped columns must be plain identifiers for PostgreSQL sources.');
    const pg = drivers.postgres || (await import('pg').catch(() => null));
    if (!pg) throw fault(503, 'unavailable: the “pg” package is not installed.');
    const Client = pg.Client || pg.default?.Client;
    const dest = await postgresDestination(conn.uri);
    // Discrete settings, never the raw connection string: the validated address is pinned, TLS verifies the host name,
    // the session is read-only, and every wait is bounded.
    const client = new Client({
      host: dest.address, port: dest.port, user: dest.user, password: dest.password, database: dest.database,
      ssl: dest.tls ? { rejectUnauthorized: true, servername: dest.host } : false,
      statement_timeout: 12000, query_timeout: 15000, connectionTimeoutMillis: 8000, application_name: 'continuum-import',
      options: '-c default_transaction_read_only=on',
    });
    client.on?.('error', () => {});
    try {
      await client.connect();
    } catch {
      throw fault(503, 'The PostgreSQL source could not be reached.');
    }
    try {
      const table = (conn.schema ? `"${conn.schema}".` : '') + `"${conn.table}"`;
      const result = await client.query(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM ${table} ORDER BY "${mapping.fields.externalId}" LIMIT ${Number(limit)} OFFSET ${Number(offset)}`);
      return result.rows;
    } finally {
      await client.end().catch(() => {});
    }
  }
  const postgresDestination = (uri) => resolvePostgresDestination(uri, { allowedHosts: pgHosts, allowedPorts: pgPorts, allowLoopback, resolver }).catch((e) => { throw fault(e.status || 400, e.message); });
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
    resumable: row.status === 'deferred', paused: row.status === 'paused', authoritativeSnapshot: Boolean(row.authoritative_snapshot), syncIntervalHours: row.sync_interval_hours ?? null, nextSyncAt: row.sync_interval_hours ? row.next_sync_at : null,
  });

  /** Rows come in batches: sqlite and PostgreSQL are paged from the database; CSV and REST are one bounded read that is sliced. */
  async function* sourceBatches(row, mapping, startOffset = 0) {
    const conn = connection(row), type = row.source_type;
    if (type === 'sqlite' || type === 'postgres') {
      const read = type === 'sqlite' ? readSqlite : readPostgres;
      for (let offset = startOffset; ;) {
        const rows = await read(conn, mapping, { offset, limit: batchSize });
        if (!rows.length) return;
        yield { rows, nextOffset: offset + rows.length, last: rows.length < batchSize };
        if (rows.length < batchSize) return;
        offset += rows.length;
      }
    }
    if (type === 'rest_api' && conn.pageParam) {
      // A REST API that pages by number is read one page at a time until it returns an empty page; resume counts records, so the
      // page size must be known to resume part-way.
      const size = Number(conn.pageSize);
      if (startOffset && !(Number.isInteger(size) && size >= 10)) throw fault(400, 'Set a page size on this source to resume it part-way.');
      const first = Number.isInteger(Number(conn.pageStart)) ? Number(conn.pageStart) : 1;
      for (let page = first + (startOffset && size ? Math.floor(startOffset / size) : 0), seen = startOffset, pages = 0; pages < 10000; page++, pages++) {
        const rows = await readRest(conn, { page, companyId: row.company_id });
        if (!rows.length) return;
        seen += rows.length;
        yield { rows, nextOffset: seen, last: false };
      }
      throw fault(502, 'The REST source kept returning pages; stopped after 10,000 pages.');
    }
    const raw = type === 'rest_api' ? await readRest(conn, { companyId: row.company_id }) : await readers[type](conn, mapping);
    for (let i = startOffset; i < raw.length; i += batchSize) yield { rows: raw.slice(i, i + batchSize), nextOffset: Math.min(i + batchSize, raw.length), last: i + batchSize >= raw.length };
  }
  const mapBatch = (rows, row, mapping, schema, seenIds, base) => rows.map((r, i) => {
    const m = mapRecord(r, mapping, schema, { declaredVerified: Boolean(row.declared_verified) });
    if (m.externalId && seenIds.has(m.externalId)) m.issues.push('duplicate external id in this batch');
    seenIds.add(m.externalId);
    return { index: base + i, ...m };
  });

  /** Read + map + validate without writing anything. Looks at the first PREVIEW records only and says so. */
  async function dryRun(row, { limit = 200 } = {}) {
    const mapping = JSON.parse(row.field_mapping_json);
    const schema = JSON.parse(row.diagnostic_schema_json);
    const seen = new Set();
    const records = [];
    let truncated = false;
    for await (const batch of sourceBatches(row, mapping)) {
      records.push(...mapBatch(batch.rows, row, mapping, schema, seen, records.length));
      if (records.length >= MAX_RECORDS) { truncated = !batch.last; break; }
    }
    const valid = records.filter((r) => !r.issues.length);
    return {
      total: records.length, truncated, valid: valid.length, invalid: records.length - valid.length,
      flaggedForReview: valid.filter((r) => r.hazards.length).length,
      withRedactions: valid.filter((r) => r.redactions).length,
      records,
      sample: records.slice(0, limit).map((r) => ({ index: r.index, externalId: r.externalId, title: r.passport.title, symptoms: r.passport.symptoms, steps: r.passport.steps, applicability: r.passport.applicability, safety: r.passport.safety, cInit: r.cInit.score, issues: r.issues, hazards: r.hazards, redactions: r.redactions })),
    };
  }

  /**
   * Idempotent, transactional upsert into this company's pool, one batch per transaction. A run that reaches DATA_SOURCE_MAX_RECORDS
   * pauses (status "deferred") and the next run continues from where it stopped; nothing is dropped. Records the source no longer lists
   * are retired only after ONE uninterrupted run read the whole source from the start.
   */
  async function sync(companyId, id, actor) {
    const row = stored(companyId, id);
    if (row.status === 'paused') throw fault(409, 'This source is paused. Resume it before syncing.');
    if (row.status === 'syncing' && Date.now() - Date.parse(row.updated_at) < 10 * 60 * 1000) throw fault(409, 'A sync is already running for this source.');
    const mapping = JSON.parse(row.field_mapping_json), schema = JSON.parse(row.diagnostic_schema_json);
    const resuming = row.status === 'deferred' && Number.isInteger(row.sync_cursor) && row.sync_cursor > 0;
    const startOffset = resuming ? row.sync_cursor : 0;
    const result = { startedAt: now(), inserted: 0, updated: 0, unchanged: 0, skippedLocallyReviewed: 0, invalid: 0, flaggedForReview: 0, duplicates: 0, missingFromSource: 0, processed: 0, batches: 0, ...(resuming && { resumedFrom: startOffset }) };
    sql.prepare("UPDATE company_data_sources SET status='syncing',updated_at=? WHERE id=? AND company_id=?").run(now(), id, companyId);
    const seenKeys = new Set(), seenIds = new Set();
    const apply = (rec) => {
        // A record the source still has but that fails validation is NOT withdrawn: it must not be retired.
        if (rec.externalId) seenKeys.add(`import:${id}:${rec.externalId}`);
        if (rec.issues.length) {
          if (rec.issues.includes('duplicate external id in this batch')) result.duplicates++;
          else result.invalid++;
          return;
        }
        const sourceKey = `import:${id}:${rec.externalId}`;
        const p = rec.passport;
        const contentHash = JSON.stringify([p.title, p.symptoms, p.applicability, p.safety, p.steps]);
        const latest = sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND source_key=? ORDER BY version_number DESC LIMIT 1').get(companyId, sourceKey);
        const seenAt = now();
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
          return;
        }
        sql.prepare("UPDATE memory_pool SET last_seen_at=?,source_version=? WHERE id=? AND company_id=?").run(seenAt, rec.updatedAt || null, latest.id, companyId);
        // A record the source withdrew earlier and now lists again returns through the normal approval policy.
        if (latest.status === 'retired' && latest.source_status === 'withdrawn' && latest.origin_type === 'company_db_sync') {
          const hold = rec.hazards.length || !row.declared_verified;
          sql.prepare("UPDATE memory_pool SET status=?,source_status='present',flagged_reason=?,updated_at=? WHERE id=? AND company_id=?")
            .run(hold ? 'flagged_for_review' : 'active', rec.hazards.length ? 'Imported instructions need review: ' + rec.hazards.join(', ') : hold ? 'Imported from a company database and waiting for approval' : null, seenAt, latest.id, companyId);
          result.reappeared = (result.reappeared || 0) + 1;
          return;
        }
        sql.prepare("UPDATE memory_pool SET source_status='present' WHERE id=? AND company_id=? AND source_status<>'present'").run(latest.id, companyId);
        // An import still waiting for approval has no local decisions yet, so the source may keep correcting it.
        const awaiting = latest.origin_type === 'company_db_sync' && latest.status === 'flagged_for_review' && !latest.locally_reviewed && latest.version_number === 1 && latest.reuse_failure_count === 0 && String(latest.flagged_reason || '').startsWith('Imported');
        // Never overwrite local decisions: review, revision lineage, flags or tracked failures.
        const local = latest.locally_reviewed || latest.version_number > 1 || latest.parent_version_id || (latest.status !== 'active' && !awaiting) || latest.reuse_failure_count > 0 || latest.origin_type !== 'company_db_sync';
        if (local) { result.skippedLocallyReviewed++; return; }
        const next = { title: p.title, symptoms_text: p.symptoms, applicability_json: JSON.stringify(p.applicability), safety_restrictions_json: JSON.stringify(p.safety), steps_json: JSON.stringify(stepsList(p.steps)) };
        const same = latest.title === next.title && latest.symptoms_text === next.symptoms_text && latest.applicability_json === next.applicability_json && latest.safety_restrictions_json === next.safety_restrictions_json && latest.steps_json === next.steps_json;
        if (same) { result.unchanged++; return; }
        sql.prepare(`UPDATE memory_pool SET title=?,symptoms_text=?,applicability_json=?,safety_restrictions_json=?,steps_json=?,initial_confidence_score=?,
          status=?,flagged_reason=?,risk_level=?,verification_evidence_json=?,provenance_json=?,updated_at=? WHERE id=? AND company_id=?`)
          .run(next.title, next.symptoms_text, next.applicability_json, next.safety_restrictions_json, next.steps_json, rec.cInit.score,
            rec.hazards.length || awaiting ? 'flagged_for_review' : 'active', rec.hazards.length ? 'Imported instructions need review: ' + rec.hazards.join(', ') : awaiting ? 'Imported from a company database and waiting for approval' : null, rec.hazards.length ? 'high' : 'standard',
            JSON.stringify(shapeEvidence(evidence).value), JSON.stringify(shapeProvenance({ cInit: rec.cInit, redactions: rec.redactions, hazards: rec.hazards, importedBy: actor, resyncedAt: now() }).value), now(), latest.id, companyId);
        // Content changed: refresh search terms and the local embedding (FTS is maintained by trigger).
        sql.prepare('UPDATE memory_pool SET search_terms=?,embedding_blob=?,embedding_model=? WHERE id=? AND company_id=?')
          .run([...tokens(`${p.title}\n${p.symptoms}`)].join(' '), vectorToBlob(localEmbedding(`${p.title}\n${p.symptoms}\n${stepsList(p.steps).join(' ')}`)), LOCAL_EMBEDDING_MODEL, latest.id, companyId);
        refreshFacets(sql, sql.prepare('SELECT * FROM memory_pool WHERE id=?').get(latest.id));
        result.updated++;
        if (rec.hazards.length) result.flaggedForReview++;
    };
    let nextOffset = startOffset, deferred = false, total = 0, invalidTotal = 0;
    try {
      for await (const batch of sourceBatches(row, mapping, startOffset)) {
        const records = mapBatch(batch.rows, row, mapping, schema, seenIds, total);
        sql.transaction(() => { for (const rec of records) apply(rec); }).immediate();
        total += records.length;
        invalidTotal += records.filter((r) => r.issues.length).length;
        nextOffset = batch.nextOffset;
        result.processed = total;
        result.batches++;
        sql.prepare('UPDATE company_data_sources SET last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?').run(JSON.stringify({ ...result, inProgress: true }), now(), id, companyId);
        if (total >= maxRecords && !batch.last) { deferred = true; break; }
      }
    } catch (e) {
      const message = safeMessage(e);
      sql.prepare("UPDATE company_data_sources SET status='error',last_error=?,updated_at=? WHERE id=? AND company_id=?").run(message, now(), id, companyId);
      throw e.status ? e : fault(503, message);
    }
    if (deferred) {
      result.deferred = true;
      result.nextOffset = nextOffset;
      result.warning = `Paused after ${total} records (the per-run limit is ${maxRecords}). Nothing was dropped: run the sync again to continue from record ${nextOffset}.`;
      result.finishedAt = now();
      sql.prepare("UPDATE company_data_sources SET status='deferred',sync_cursor=?,last_error=NULL,last_synced_at=?,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?").run(nextOffset, result.finishedAt, JSON.stringify(result), result.finishedAt, id, companyId);
      return result;
    }
    sql.transaction(() => {
      // Reconciliation. Only a COMPLETE, owner-declared authoritative snapshot, read in one uninterrupted run from the start, may retire
      // records the source no longer lists. A resumed, partial, failed, empty or mostly-invalid read never does.
      const current = sql.prepare("SELECT id,source_key FROM memory_pool WHERE company_id=? AND source_id=? AND origin_type='company_db_sync' AND status IN ('active','flagged_for_review')").all(companyId, id);
      const absent = resuming ? [] : current.filter((e) => !seenKeys.has(e.source_key));
      const complete = !resuming && Boolean(row.authoritative_snapshot) && total > 0 && invalidTotal / total <= 0.5;
      result.snapshot = complete ? 'complete' : 'partial';
      result.missingFromSource = absent.length;
      if (absent.length && complete) {
        const retire = sql.prepare("UPDATE memory_pool SET status='retired',source_status='withdrawn',flagged_reason='Withdrawn from the source database',provenance_json=json_set(provenance_json,'$.retiredBy','source'),updated_at=? WHERE id=? AND company_id=?");
        for (const e of absent) retire.run(now(), e.id, companyId);
        result.retiredFromSource = absent.length;
      } else if (absent.length) {
        const mark = sql.prepare("UPDATE memory_pool SET source_status='missing' WHERE id=? AND company_id=?");
        for (const e of absent) mark.run(e.id, companyId);
        if (!row.authoritative_snapshot) result.warning = 'Records missing from the source were left in place because this source is not marked as a complete snapshot.';
      }
      if (!total) result.warning = 'The source returned no records, so nothing was retired.';
      if (resuming) result.warning = 'The resumed import finished. Run a full sync to reconcile records the source no longer lists.';
      result.finishedAt = now();
      sql.prepare("UPDATE company_data_sources SET status='ok',sync_cursor=NULL,last_error=NULL,last_synced_at=?,last_complete_sync_at=CASE WHEN ? THEN ? ELSE last_complete_sync_at END,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?")
        .run(result.finishedAt, complete ? 1 : 0, result.finishedAt, JSON.stringify(result), result.finishedAt, id, companyId);
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
        allowedWebsites: { ownerManaged: ownerOrigins, server: [...allowedOrigins], company: ownerOrigins ? sql.prepare('SELECT origin,added_at AS addedAt FROM company_source_origins WHERE company_id=? ORDER BY origin').all(companyId) : [] },
        csvMaxBytes,
        availability: status(), sourceTypes: SOURCE_TYPES, passportFields: PASSPORT_FIELDS, requiredFields: REQUIRED_FIELDS,
        chatbots: sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(companyId).map((r) => normalizeBot(JSON.parse(r.config))).map((b) => ({ id: b.id, name: b.name, diagnosticSchema: b.diagnosticSchema || [] })),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/data-sources') {
      const body = await json(req, csvMaxBytes + 65536);
      if (body.confirmed !== true) throw fault(400, 'Confirm saving this data source.');
      if (!SOURCE_TYPES.includes(body.sourceType)) throw fault(400, 'Choose a supported source type.');
      const bot = getBot(sql, companyId, field(body.chatbotId || botId(profile), 'service', 200));
      const existing = body.id ? stored(companyId, body.id) : null;
      if (existing && (existing.chatbot_id !== bot.id || existing.source_type !== body.sourceType)) throw fault(409, 'The service and source type of an existing source cannot change.');
      const schema = bot.diagnosticSchema || [];
      const mapping = validateMapping(body.fieldMapping, schema);
      if (body.declaredVerified !== undefined && typeof body.declaredVerified !== 'boolean') throw fault(400, 'declaredVerified must be true or false.');
      if (body.authoritativeSnapshot !== undefined && typeof body.authoritativeSnapshot !== 'boolean') throw fault(400, 'authoritativeSnapshot must be true or false.');
      const authoritative = body.authoritativeSnapshot === undefined ? Boolean(existing?.authoritative_snapshot) : body.authoritativeSnapshot;
      const id = existing?.id || randomUUID();
      // Optional scheduled sync: every N hours (1–720), or null for manual only.
      let interval = existing?.sync_interval_hours ?? null;
      if (body.syncIntervalHours !== undefined) {
        if (body.syncIntervalHours === null) interval = null;
        else if (Number.isInteger(body.syncIntervalHours) && body.syncIntervalHours >= 1 && body.syncIntervalHours <= 720) interval = body.syncIntervalHours;
        else throw fault(400, 'The sync interval must be a whole number of hours from 1 to 720, or null for manual sync only.');
      }
      const nextSync = interval === null ? null : interval === existing?.sync_interval_hours && existing?.next_sync_at ? existing.next_sync_at : new Date(Date.now() + interval * 3600000).toISOString();
      let encrypted = existing?.encrypted_connection_uri || null;
      if (body.connection !== undefined) {
        if (!body.connection || typeof body.connection !== 'object' || Array.isArray(body.connection)) throw fault(400, 'Send the connection details as an object.');
        const c = body.connection;
        if (body.sourceType === 'rest_api') await assertSafeUrl(c.url, { allowedOrigins: originsFor(companyId), allowLoopback, resolver, ownerOrigins });
        if (body.sourceType === 'postgres' && availability.postgres().available) await postgresDestination(c.uri);
        if (body.sourceType === 'sqlite') { if (availability.sqlite().available) safePath(c.path); if (!IDENT.test(c.table || '')) throw fault(400, 'Enter a plain table name.'); }
        encrypted = delivery.seal(Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, k === 'csv' ? csvMaxBytes : MAX_BYTES)])), 'datasource:' + id);
      }
      if (!encrypted) throw fault(400, 'Provide the connection details.');
      const t = now();
      sql.prepare(`INSERT INTO company_data_sources(id,company_id,chatbot_id,name,source_type,encrypted_connection_uri,field_mapping_json,diagnostic_schema_json,declared_verified,status,created_at,updated_at,sync_interval_hours,next_sync_at,authoritative_snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,'configured',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,encrypted_connection_uri=excluded.encrypted_connection_uri,field_mapping_json=excluded.field_mapping_json,declared_verified=excluded.declared_verified,updated_at=excluded.updated_at,sync_interval_hours=excluded.sync_interval_hours,next_sync_at=excluded.next_sync_at,authoritative_snapshot=excluded.authoritative_snapshot WHERE company_data_sources.company_id=excluded.company_id`)
        .run(id, companyId, bot.id, field(body.name, 'name', 100), body.sourceType, encrypted, JSON.stringify(mapping), JSON.stringify(schema), body.declaredVerified ? 1 : 0, t, t, interval, nextSync, authoritative ? 1 : 0);
      send(existing ? 200 : 201, { source: publicView(stored(companyId, id)) });
      return true;
    }
    if (endpoint === 'POST /api/company/data-sources/origins' || endpoint === 'POST /api/company/data-sources/origins/remove') {
      if (!ownerOrigins) throw fault(403, 'The server operator manages allowed websites for this installation.');
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm this change.');
      let url;
      try { url = new URL(String(body.origin || '')); } catch { throw fault(400, 'Enter a website such as https://support.example.com.'); }
      if (endpoint.endsWith('/remove')) {
        sql.prepare('DELETE FROM company_source_origins WHERE company_id=? AND origin=?').run(companyId, url.origin);
      } else {
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!(url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:'))) throw fault(400, 'Only https websites can be approved.');
        if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw fault(400, 'Enter only the website address (for example https://support.example.com), without a path.');
        // Refuse private or internal addresses now, not only at sync time.
        try { await resolveAllowed(url.hostname, { allowLoopback, resolver }); } catch (e) { throw fault(e.status || 400, e.message); }
        if (sql.prepare('SELECT COUNT(*) n FROM company_source_origins WHERE company_id=?').get(companyId).n >= 25) throw fault(400, 'A company can approve at most 25 websites.');
        sql.prepare('INSERT OR IGNORE INTO company_source_origins(company_id,origin,added_by,added_at) VALUES(?,?,?,?)').run(companyId, url.origin, profile.id, now());
      }
      send(200, { company: sql.prepare('SELECT origin,added_at AS addedAt FROM company_source_origins WHERE company_id=? ORDER BY origin').all(companyId) });
      return true;
    }
    const match = endpoint.match(/^(POST|DELETE) \/api\/company\/data-sources\/([^/]+)(?:\/(preview|sync|test|pause|resume))?$/);
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
      if (method === 'POST' && action === 'test') {
        // Non-mutating: open the source, read one small batch, report what was found. Nothing is saved or counted, and the
        // connection details are never echoed.
        const started = performance.now();
        let rows = 0, columns = [];
        try {
          for await (const batch of sourceBatches(row, JSON.parse(row.field_mapping_json))) { rows = batch.rows.length; columns = Object.keys(batch.rows[0] || {}).slice(0, 30); break; }
        } catch (e) { throw e.status ? e : fault(503, safeMessage(e)); }
        send(200, { ok: true, reachable: true, firstBatchRows: rows, columns, ms: Math.round(performance.now() - started), note: rows ? 'Connected and read the first batch. Nothing was saved.' : 'Connected, but the source returned no rows.' });
        return true;
      }
      if (method === 'POST' && (action === 'pause' || action === 'resume')) {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Confirm this change.');
        if (action === 'pause') {
          if (row.status === 'syncing') throw fault(409, 'A sync is running. Pause the source after it finishes.');
          sql.prepare("UPDATE company_data_sources SET status='paused',updated_at=? WHERE id=? AND company_id=?").run(now(), row.id, companyId);
        } else {
          if (row.status !== 'paused') throw fault(409, 'This source is not paused.');
          const back = row.sync_cursor ? 'deferred' : row.last_synced_at ? 'ok' : 'configured';
          sql.prepare('UPDATE company_data_sources SET status=?,updated_at=? WHERE id=? AND company_id=?').run(back, now(), row.id, companyId);
        }
        send(200, { source: publicView(stored(companyId, row.id)) });
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
  /**
   * Run every source whose schedule is due. Each source is claimed with a conditional update that moves its next
   * run forward first, so overlapping workers (or a slow sync) can never run the same source twice. A failure is
   * recorded on the source (status/last_error) and the next attempt waits for the next interval.
   */
  async function runDue(at = Date.now()) {
    const due = sql.prepare('SELECT id,company_id,sync_interval_hours FROM company_data_sources WHERE sync_interval_hours IS NOT NULL AND status<>? AND next_sync_at<=? ORDER BY next_sync_at LIMIT 20').all('paused', new Date(at).toISOString());
    const results = [];
    for (const row of due) {
      const next = new Date(at + row.sync_interval_hours * 3600000).toISOString();
      const claimed = sql.prepare('UPDATE company_data_sources SET next_sync_at=? WHERE id=? AND company_id=? AND sync_interval_hours IS NOT NULL AND next_sync_at<=?').run(next, row.id, row.company_id, new Date(at).toISOString());
      if (!claimed.changes) continue;
      try {
        const result = await sync(row.company_id, row.id, 'scheduled');
        results.push({ id: row.id, status: 'ok', inserted: result.inserted, updated: result.updated });
      } catch (e) {
        results.push({ id: row.id, status: 'error', error: e.status ? e.message : 'sync failed' });
      }
    }
    return results;
  }
  return { handle, dryRun, sync, runDue, status, availability: status };
}
