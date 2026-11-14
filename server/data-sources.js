// Domain-agnostic company data-source mediator.
//
// An owner configures a source (CSV, SQLite, PostgreSQL, MySQL/MariaDB, SQL Server or a REST/JSON API), maps the foreign fields onto
// Resolution Passport fields, previews/validates with a dry run, then syncs into THAT company's memory_pool. Nothing here is specific to
// repair or IT: diagnostic fields come from the service's diagnostic schema.
//
// Safety properties (all covered by test/data-sources.test.js and test/source-sync.test.js):
//  * connection details are encrypted at rest (AES-256-GCM via delivery.seal) and never returned; errors are sanitised so they cannot
//    echo secrets; editing a source never reveals a stored secret (blank secret fields keep the stored value)
//  * file sources: only server-allowlisted directories; databases: read-only sessions, validated identifiers, bound values, no user SQL
//  * REST: https + allowlisted origins, public DNS only, pinned address, no redirects, every follow-up page link must stay on the
//    configured origin, size/time limits and bounded retries
//  * unavailable drivers/credentials are reported as configuration-required, never faked as a successful sync
//  * imports are idempotent upserts keyed by company/source/external id and never overwrite locally reviewed, revised, flagged or
//    failure-tracked records
//  * a sync is resumable: progress (a keyset checkpoint) commits in the same transaction as each batch of writes; a failed, cancelled,
//    paused or partial run never retires knowledge and is never reported as complete
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { resolve, sep, basename } from 'node:path';
import { realpathSync, createReadStream, statSync } from 'node:fs';
import { isPrivateAddress, resolveAllowed, pinnedGet, resolvePostgresDestination, resolveDatabaseDestination } from './net-guard.js';
import { fault } from './providers.js';
import { botId, getBot, normalizeBot } from './chatbots.js';
import { insertPassport, computeInitialConfidence, normalizeSafety, normalizeApplicability, stepsList, refreshFacets } from './passports.js';
import { tokens } from './context.js';
import { localEmbedding, vectorToBlob, LOCAL_EMBEDDING_MODEL } from './scoring.js';
import { containsSecret, scrubPII, dangerousInstructions } from './privacy.js';
import { customerFacts } from './applicability.js';
import { field, json } from './requests.js';
import { sanitizeDeep, sanitizeText, isPersonalKey, shapeEvidence, shapeProvenance } from './privacy-sanitizer.js';
import { IDENT, PATH, dotted, CsvParser, csvHeaderName, csvBatches, sliceString, sqlBatches, encodeKey, compareKeys, restBatches, fetchWithRetries, restStyle, REST_STYLES } from './source-adapters.js';
import { createKnowledgeLifecycle, recordKnowledgeEvent } from './knowledge-lifecycle.js';

export const SOURCE_TYPES = ['csv_sync', 'csv_file', 'sqlite', 'postgres', 'mysql', 'mssql', 'rest_api'];
// Preview limit only. A real sync is not capped at this number: it reads in batches (DATA_SOURCE_BATCH_SIZE) and one run pauses after
// DATA_SOURCE_MAX_RECORDS so it stays bounded; the next run continues from the checkpoint. Nothing is ever silently cut off.
export const MAX_RECORDS = 2000;
const MAX_BYTES = 1048576;
export const PASSPORT_FIELDS = ['externalId', 'title', 'problemCategory', 'productFamily', 'model', 'symptoms', 'steps', 'applicability', 'safety', 'updatedAt', 'sourceVersion'];
const REQUIRED_FIELDS = ['externalId', 'title', 'symptoms', 'steps'];
const CONNECTION_KEYS = {
  csv_sync: ['csv'],
  csv_file: ['path'],
  sqlite: ['path', 'table'],
  postgres: ['uri', 'schema', 'table'],
  mysql: ['uri', 'schema', 'table'],
  mssql: ['uri', 'schema', 'table'],
  rest_api: ['url', 'token', 'recordsPath', 'pagination', 'pageParam', 'pageSize', 'limitParam', 'pageStart', 'offsetParam', 'cursorParam', 'nextCursorPath', 'nextLinkPath', 'sinceParam'],
};
// Write-only values: sent when set, never returned, and a blank value on edit keeps what is stored.
const SECRET_KEYS = new Set(['csv', 'token', 'uri', 'url']);
const DAY = 86400000;
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

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
const clip = (v, n) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const safeMessage = (e) => (e?.status ? e.message : 'The source could not be read. Check the configuration and try again.');
const slug = (v) => String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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
const splitValues = (text, n = 20) => String(text || '').split(/[|;]/).map((v) => v.trim()).filter(Boolean).slice(0, n);
/**
 * Map one source row to a candidate passport plus per-record validation issues.
 * problemCategory / productFamily / model become explicit conditions: model is mandatory when the record names one (a customer who has not
 * said which model is asked, never assumed); productFamily is mandatory only when this service asks customers for a `product_family`;
 * problemCategory only ever nudges ranking. A missing value in the source adds NO condition, so it can never create a false mismatch.
 */
export function mapRecord(row, mapping, schema = [], { declaredVerified = false } = {}) {
  const get = (path) => dotted(row, path);
  const issues = [];
  if (row?.__issue) issues.push('malformed row: ' + row.__issue);
  const opt = (name, n) => (mapping.fields[name] ? clip(get(mapping.fields[name]), n) : '');
  const raw = {
    externalId: clip(get(mapping.fields.externalId), 200),
    title: clip(get(mapping.fields.title), 200),
    symptoms: clip(get(mapping.fields.symptoms), 2000),
    steps: clip(get(mapping.fields.steps), 3000),
    applicability: opt('applicability', 500),
    safety: opt('safety', 1000),
    updatedAt: opt('updatedAt', 40),
    sourceVersion: opt('sourceVersion', 80),
    problemCategory: opt('problemCategory', 400),
    productFamily: opt('productFamily', 400),
    model: opt('model', 400),
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
  const structured = {};
  const structuredCondition = (key, name, values, required) => {
    if (!values.length) return;
    structured[name] = values;
    if (!conditions.some((c) => c.key === key)) conditions.push({ key, op: 'in', values, required });
  };
  structuredCondition('problem_category', 'problemCategory', splitValues(raw.problemCategory).map(slug).filter(Boolean), false);
  structuredCondition('product_family', 'productFamily', splitValues(raw.productFamily).map(slug).filter(Boolean), schema.some((s) => s.key === 'product_family' && s.required !== false));
  structuredCondition('model', 'models', splitValues(raw.model).map((v) => v.toLowerCase().replace(/\s+/g, ' ')), true);
  let applicability = { ...(redacted.applicability && { environmentText: redacted.applicability }), ...(conditions.length && { conditions }), ...(Object.keys(structured).length && { structured }) };
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
  // Long catalogue IDs can resemble opaque credentials to the receipt scrubber. Keep a deterministic,
  // non-secret reference instead of storing/echoing that value or relaxing credential detection.
  // Explicit credential syntax is still a validation error above; free-text passport fields are unchanged.
  const externalId = sanitizeText(raw.externalId).secret && !containsSecret(raw.externalId)
    ? 'record.' + createHash('sha256').update(raw.externalId).digest('hex').match(/.{16}/g).join('.')
    : raw.externalId;
  return { externalId, passport, redactions, hazards, issues, cInit: confidence, updatedAt: raw.updatedAt, sourceVersion: raw.sourceVersion };
}

// --------------------------------------------------------------------------- CSV (whole-text helper kept for pasted content and tests)
export function parseCsv(textInput, { maxRows = 50000 } = {}) {
  const parser = new CsvParser();
  const all = [];
  const take = (rows) => {
    for (const r of rows) {
      all.push(r.cells);
      if (all.length > maxRows + 1) throw fault(400, `A CSV can hold at most ${maxRows} rows. Use a SQLite or PostgreSQL source, or split the file.`);
    }
  };
  take(parser.push(String(textInput)));
  take(parser.end());
  if (all.length < 1) throw fault(400, 'The CSV is empty.');
  const header = all[0].map(csvHeaderName);
  if (new Set(header).size !== header.length) throw fault(400, 'CSV column names must be unique.');
  return all.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function createDataSources(store, delivery, config = {}, { drivers = {}, resolver = lookup, lifecycle = null, sleepFn = undefined } = {}) {
  const sql = store.db;
  const life = lifecycle || createKnowledgeLifecycle(store);
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = new Set(list(config.DATA_SOURCE_ALLOWED_ORIGINS));
  const realDirs = (v) => list(v).map((d) => { try { return realpathSync(resolve(d)); } catch { return null; } }).filter(Boolean);
  const sqliteDirs = realDirs(config.DATA_SOURCE_SQLITE_DIRS);
  const csvDirs = realDirs(config.DATA_SOURCE_CSV_DIRS);
  const allowLoopback = config.NODE_ENV !== 'production' && config.DATA_SOURCE_ALLOW_LOOPBACK === 'true';
  const hosts = (v) => new Set(list(v).map((s) => s.toLowerCase()));
  const ports = (v, d) => new Set(list(v || d).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536));
  const dbConfig = {
    postgres: { hosts: hosts(config.DATA_SOURCE_POSTGRES_HOSTS), ports: ports(config.DATA_SOURCE_POSTGRES_PORTS, '5432') },
    mysql: { hosts: hosts(config.DATA_SOURCE_MYSQL_HOSTS), ports: ports(config.DATA_SOURCE_MYSQL_PORTS, '3306') },
    mssql: { hosts: hosts(config.DATA_SOURCE_MSSQL_HOSTS), ports: ports(config.DATA_SOURCE_MSSQL_PORTS, '1433') },
  };
  const now = () => new Date().toISOString();
  const intOr = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  const limits = {
    batchSize: intOr(config.DATA_SOURCE_BATCH_SIZE, 500, 5, 5000), // rows fetched, mapped and written per step (one transaction)
    maxRecords: intOr(config.DATA_SOURCE_MAX_RECORDS, 100000, 100, 50000000), // one run pauses here and resumes from its checkpoint
    // An uploaded (pasted) CSV is stored sealed with the source, so it has its own size limit (default 10 MB, at most 50 MB).
    csvMaxBytes: intOr(config.DATA_SOURCE_CSV_MAX_BYTES, 10 * 1048576, 65536, 50 * 1048576),
    csvFileMaxBytes: intOr(config.DATA_SOURCE_CSV_FILE_MAX_BYTES, 2 * 1073741824, 65536, 50 * 1073741824),
    csvMaxRows: intOr(config.DATA_SOURCE_CSV_MAX_ROWS, 20000000, 100, 500000000),
    maxResponseBytes: intOr(config.DATA_SOURCE_MAX_RESPONSE_BYTES, MAX_BYTES * 4, 65536, 64 * 1048576),
    fetchTimeoutMs: intOr(config.DATA_SOURCE_FETCH_TIMEOUT_MS, 12000, 500, 120000),
    retries: intOr(config.DATA_SOURCE_RETRIES, 3, 1, 8),
    retryBaseMs: intOr(config.DATA_SOURCE_RETRY_BASE_MS, 500, 1, 60000),
    maxRetryAfterMs: intOr(config.DATA_SOURCE_MAX_RETRY_AFTER_MS, 30000, 0, 600000),
    maxPages: intOr(config.DATA_SOURCE_MAX_PAGES, 1000000, 1, 100000000),
    lookbackSeconds: intOr(config.DATA_SOURCE_LOOKBACK_SECONDS, 300, 0, 86400),
    fullSyncHours: intOr(config.DATA_SOURCE_FULL_SYNC_HOURS, 168, 1, 8760),
    leaseMs: intOr(config.DATA_SOURCE_LEASE_MS, 300000, 1000, 3600000),
    schedulerConcurrency: intOr(config.DATA_SOURCE_SCHEDULER_CONCURRENCY, 2, 1, 16),
    schedulerPerTick: intOr(config.DATA_SOURCE_SCHEDULER_PER_TICK, 20, 1, 500),
    schedulerRetryMinutes: intOr(config.DATA_SOURCE_SCHEDULER_RETRY_MINUTES, 5, 1, 1440),
  };
  const batchSize = limits.batchSize, maxRecords = limits.maxRecords, csvMaxBytes = limits.csvMaxBytes;
  // Owners may approve websites for REST sources in the app, unless the server operator turns that off. The network guard
  // (public DNS only, pinned address, no redirects) applies to every origin either way.
  const ownerOrigins = config.DATA_SOURCE_OWNER_ORIGINS !== 'false';
  const originsFor = (companyId) => new Set([...allowedOrigins, ...(ownerOrigins && companyId ? sql.prepare('SELECT origin FROM company_source_origins WHERE company_id=?').all(companyId).map((r) => r.origin) : [])]);

  const driverOf = (type) => drivers[type] || (config[`DATA_SOURCE_${type.toUpperCase()}_DRIVER`] === { postgres: 'pg', mysql: 'mysql2', mssql: 'mssql' }[type] ? 'dynamic' : null);
  const dbAvailability = (type, pkg, label) => () => {
    if (!driverOf(type)) return { available: false, reason: `unavailable: no ${label} driver is installed (install the optional “${pkg}” package and set DATA_SOURCE_${type.toUpperCase()}_DRIVER=${pkg}).` };
    if (!dbConfig[type].hosts.size) return { available: false, reason: `configuration-required: the server owner must set DATA_SOURCE_${type.toUpperCase()}_HOSTS to the database hosts that may be read.` };
    return { available: true, note: type === 'mssql' ? 'TLS required. SQL Server has no read-only session mode: use a login that can only SELECT.' : 'read-only session, TLS required' };
  };
  const availability = {
    csv_sync: () => ({ available: true }),
    csv_file: () => (csvDirs.length ? { available: true, note: 'streamed from disk, never loaded whole' } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_CSV_DIRS to the directories CSV files may be read from.' }),
    sqlite: () => (sqliteDirs.length ? { available: true } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_SQLITE_DIRS to the directories that may be read.' }),
    rest_api: () => (allowedOrigins.size || ownerOrigins ? { available: true, ...(ownerOrigins && { note: 'Approve the website under “Allowed websites” first.' }) } : { available: false, reason: 'configuration-required: the server owner must set DATA_SOURCE_ALLOWED_ORIGINS.' }),
    postgres: dbAvailability('postgres', 'pg', 'PostgreSQL'),
    mysql: dbAvailability('mysql', 'mysql2', 'MySQL/MariaDB'),
    mssql: dbAvailability('mssql', 'mssql', 'SQL Server'),
  };
  const status = () => Object.fromEntries(SOURCE_TYPES.map((t) => [t, availability[t]()]));

  // ----- connection helpers
  const safeFile = (path, dirs, what) => {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw fault(400, `Enter the ${what} file path.`);
    let real;
    try { real = realpathSync(resolve(path)); } catch { throw fault(400, `The ${what} file was not found.`); }
    if (!dirs.some((d) => real === d || real.startsWith(d + sep))) throw fault(400, 'That file is not in a directory the server owner allowed.');
    return real;
  };
  const dbDestination = (type, uri) => {
    const c = dbConfig[type];
    const call = type === 'postgres'
      ? resolvePostgresDestination(uri, { allowedHosts: c.hosts, allowedPorts: c.ports, allowLoopback, resolver })
      : resolveDatabaseDestination(uri, type === 'mysql'
        ? { label: 'MySQL', protocols: ['mysql:', 'mariadb:'], defaultPort: 3306, hostsVar: 'DATA_SOURCE_MYSQL_HOSTS', portsVar: 'DATA_SOURCE_MYSQL_PORTS', allowedHosts: c.hosts, allowedPorts: c.ports, allowLoopback, resolver }
        : { label: 'SQL Server', protocols: ['sqlserver:', 'mssql:'], defaultPort: 1433, hostsVar: 'DATA_SOURCE_MSSQL_HOSTS', portsVar: 'DATA_SOURCE_MSSQL_PORTS', allowedHosts: c.hosts, allowedPorts: c.ports, allowLoopback, resolver });
    return call.catch((e) => { throw fault(e.status || 400, e.message); });
  };
  /** Validate a connection (shape, allowlists, destinations) without reading any data. Throws an actionable 4xx. */
  async function validateConnection(type, conn, companyId) {
    if (type === 'csv_sync') {
      if (typeof conn.csv !== 'string' || !conn.csv.trim()) throw fault(400, 'Paste or upload the CSV content.');
      if (Buffer.byteLength(conn.csv) > csvMaxBytes) throw fault(413, `The CSV is larger than ${Math.round(csvMaxBytes / 1048576)} MB. Use a CSV file source, a database source, or split it.`);
    } else if (type === 'csv_file') {
      if (!availability.csv_file().available) throw fault(503, availability.csv_file().reason);
      const file = safeFile(conn.path, csvDirs, 'CSV');
      if (!/\.csv$/i.test(file)) throw fault(400, 'The file must be a .csv file.');
      if (statSync(file).size > limits.csvFileMaxBytes) throw fault(413, `The CSV file is larger than ${Math.round(limits.csvFileMaxBytes / 1048576)} MB (DATA_SOURCE_CSV_FILE_MAX_BYTES).`);
    } else if (type === 'sqlite') {
      if (availability.sqlite().available) safeFile(conn.path, sqliteDirs, 'database');
      if (!IDENT.test(conn.table || '')) throw fault(400, 'Enter a plain table name.');
    } else if (type === 'rest_api') {
      await assertSafeUrl(conn.url, { allowedOrigins: originsFor(companyId), allowLoopback, resolver, ownerOrigins });
      if (conn.pagination && !REST_STYLES.includes(conn.pagination)) throw fault(400, `Pagination must be one of: ${REST_STYLES.join(', ')}.`);
      for (const k of ['pageParam', 'limitParam', 'offsetParam', 'cursorParam', 'sinceParam']) if (conn[k] && !IDENT.test(conn[k])) throw fault(400, `“${k}” must be a plain name such as page.`);
      for (const k of ['recordsPath', 'nextCursorPath']) if (conn[k] && !PATH.test(conn[k])) throw fault(400, `“${k}” must be a plain property path such as data.items.`);
      if (conn.nextLinkPath && conn.nextLinkPath !== 'header:link' && !PATH.test(conn.nextLinkPath)) throw fault(400, '“nextLinkPath” must be a property path such as links.next, or header:link.');
      if (conn.pageSize && !(Number.isInteger(Number(conn.pageSize)) && Number(conn.pageSize) >= 10 && Number(conn.pageSize) <= 5000)) throw fault(400, 'Page size must be a whole number from 10 to 5000.');
      const style = restStyle(conn);
      if (style === 'page' && !conn.pageParam) throw fault(400, 'Page paging needs the page parameter name (for example page).');
      if (style === 'cursor' && !(conn.cursorParam && conn.nextCursorPath)) throw fault(400, 'Cursor paging needs the cursor parameter and the path of the next cursor in the response.');
      if (style === 'next_link' && !conn.nextLinkPath) throw fault(400, 'Next-link paging needs the path of the next link in the response, or header:link.');
    } else {
      if (!IDENT.test(conn.table || '') || (conn.schema && !IDENT.test(conn.schema))) throw fault(400, 'Enter a plain table (and optional schema) name.');
      if (availability[type]().available) await dbDestination(type, conn.uri);
      else if (typeof conn.uri !== 'string' || !conn.uri) throw fault(400, 'Enter the connection string.');
    }
  }
  const stored = (companyId, id) => {
    const row = sql.prepare('SELECT * FROM company_data_sources WHERE id=? AND company_id=?').get(id, companyId);
    if (!row) throw fault(404, 'Data source not found in this company.');
    return row;
  };
  const connection = (row) => (row.encrypted_connection_uri ? delivery.unseal(row.encrypted_connection_uri, 'datasource:' + row.id) : {});

  /** What an owner may see of a stored connection: where it points and which options are set, never a secret value. */
  function connectionView(row) {
    let conn;
    try { conn = connection(row); } catch { return { readable: false }; }
    const settings = Object.fromEntries(CONNECTION_KEYS[row.source_type].filter((k) => !SECRET_KEYS.has(k) && k !== 'path' && conn[k] !== undefined).map((k) => [k, conn[k]]));
    const secrets = Object.fromEntries(CONNECTION_KEYS[row.source_type].filter((k) => SECRET_KEYS.has(k)).map((k) => [k, Boolean(conn[k])]));
    const summary = {};
    if (row.source_type === 'csv_sync') { summary.bytes = Buffer.byteLength(conn.csv || ''); summary.rows = summary.bytes <= 2097152 ? Math.max(0, (conn.csv || '').split(/\r\n|\r|\n/).filter(Boolean).length - 1) : null; }
    if (row.source_type === 'csv_file' || row.source_type === 'sqlite') summary.file = conn.path ? basename(conn.path) : null;
    if (row.source_type === 'rest_api' && conn.url) { try { const u = new URL(conn.url); summary.endpoint = u.origin + u.pathname + (u.search ? '?…' : ''); } catch { summary.endpoint = null; } }
    if (['postgres', 'mysql', 'mssql'].includes(row.source_type) && conn.uri) {
      try { const u = new URL(conn.uri); summary.host = decodeURIComponent(u.hostname); summary.port = Number(u.port) || null; summary.database = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { /* unreadable */ }
    }
    return { readable: true, settings, secretsSet: secrets, summary };
  }
  function incrementalSupport(row, conn, mapping) {
    if (!mapping.fields.updatedAt) return { ok: false, reason: 'Map the “Last updated” column to enable incremental sync.' };
    if (row.source_type === 'csv_sync' || row.source_type === 'csv_file') return { ok: false, reason: 'A CSV has no reliable change signal, so every sync reads the whole file (a full sync).' };
    if (row.source_type === 'rest_api' && !conn.sinceParam) return { ok: false, reason: 'Set the API’s “modified since” parameter to enable incremental sync; without it every sync is a full read.' };
    return { ok: true, reason: row.source_type === 'rest_api' ? 'The API filters by the “modified since” parameter.' : 'Reads rows changed since the high-water mark.' };
  }
  function freshness(row) {
    const last = row.last_synced_at ? Date.parse(row.last_synced_at) : null;
    if (row.status === 'paused') return { state: 'paused', label: 'Paused by you' };
    if (row.status === 'error') return { state: 'error', label: 'Last sync failed', ageHours: last ? Math.round((Date.now() - last) / 3600000) : null };
    if (!last) return { state: 'never', label: 'Never synced' };
    const ageHours = Math.round((Date.now() - last) / 360000) / 10;
    if (row.status === 'deferred' || row.sync_checkpoint_json) return { state: 'partial', label: 'Import paused part-way', ageHours };
    if (row.sync_interval_hours && ageHours > row.sync_interval_hours * 2 + 1) return { state: 'stale', label: `Overdue: last good sync ${ageHours} h ago`, ageHours };
    return { state: 'fresh', label: 'Up to date as of the last sync', ageHours };
  }
  const publicView = (row) => {
    const mapping = parse(row.field_mapping_json, { fields: {}, diagnostics: {} });
    const view = connectionView(row);
    const support = view.readable ? incrementalSupport(row, connection(row), mapping) : { ok: false, reason: 'The stored connection could not be read.' };
    const checkpoint = parse(row.sync_checkpoint_json, null);
    return {
      id: row.id, chatbotId: row.chatbot_id, name: row.name, sourceType: row.source_type,
      hasConnection: Boolean(row.encrypted_connection_uri), connection: view, fieldMapping: mapping,
      diagnosticSchema: parse(row.diagnostic_schema_json, []), declaredVerified: Boolean(row.declared_verified),
      status: row.status, lastSyncedAt: row.last_synced_at, lastSyncResult: parse(row.last_sync_result_json, null),
      lastError: row.last_error, createdAt: row.created_at, availability: availability[row.source_type]?.(),
      resumable: Boolean(checkpoint) && row.status !== 'syncing', paused: row.status === 'paused', syncing: row.status === 'syncing' && (row.lease_until || 0) > Date.now(),
      authoritativeSnapshot: Boolean(row.authoritative_snapshot), syncIntervalHours: row.sync_interval_hours ?? null, nextSyncAt: row.sync_interval_hours ? row.next_sync_at : null,
      incremental: { enabled: Boolean(row.incremental_enabled), supported: support.ok, reason: support.reason, highWater: parse(row.high_water_json, null)?.v ?? null },
      progress: checkpoint ? { mode: checkpoint.mode, processed: checkpoint.scanProcessed ?? checkpoint.processed ?? 0 } : null,
      freshness: freshness(row), consecutiveFailures: row.consecutive_failures || 0, staleAfterDays: row.stale_after_days ?? null,
      lastCompleteSyncAt: row.last_complete_sync_at, lastFullSyncAt: row.last_full_sync_at, lastScheduledAt: row.last_scheduled_at,
    };
  };
  const runsOf = (companyId, id, n = 8) => sql.prepare('SELECT id,mode,trigger_kind AS trigger,status,started_at AS startedAt,finished_at AS finishedAt,resumed,error,result_json FROM source_sync_runs WHERE company_id=? AND source_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(companyId, id, n)
    .map(({ result_json, ...r }) => ({ ...r, resumed: Boolean(r.resumed), counts: (({ inserted, updated, unchanged, invalid, duplicates, processed, skippedLocallyReviewed, flaggedForReview } = {}) => ({ inserted, updated, unchanged, invalid, duplicates, processed, skippedLocallyReviewed, flaggedForReview }))(parse(result_json, {})) }));

  // --------------------------------------------------------------------------- adapters
  async function openSql(type, conn, mapping) {
    if (!availability[type]().available) throw fault(503, availability[type]().reason);
    const columns = [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];
    if (columns.some((c) => !IDENT.test(c))) throw fault(400, `Mapped columns must be plain identifiers for ${type} sources.`);
    if (!IDENT.test(conn.table || '') || (conn.schema && !IDENT.test(conn.schema))) throw fault(400, 'Enter a plain table (and optional schema) name.');
    if (type === 'sqlite') {
      const file = safeFile(conn.path, sqliteDirs, 'database');
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(file, { readonly: true, fileMustExist: true });
      const known = new Set(db.prepare(`PRAGMA table_info("${conn.table}")`).all().map((c) => c.name));
      if (!known.size) { db.close(); throw fault(400, 'That table was not found.'); }
      const missing = columns.filter((c) => !known.has(c));
      if (missing.length) { db.close(); throw fault(400, `Columns not found in the table: ${missing.join(', ')}.`); }
      return { query: async (text, params) => db.prepare(text).all(...params), close: async () => db.close() };
    }
    const dest = await dbDestination(type, conn.uri);
    const connectOnce = async () => {
      if (type === 'postgres') {
        const pg = typeof drivers.postgres === 'object' ? drivers.postgres : await import('pg').catch(() => null);
        if (!pg) throw fault(503, 'unavailable: the “pg” package is not installed.');
        const Client = pg.Client || pg.default?.Client;
        const client = new Client({
          host: dest.address, port: dest.port, user: dest.user, password: dest.password, database: dest.database,
          ssl: dest.tls ? { rejectUnauthorized: true, servername: dest.host } : false,
          statement_timeout: 12000, query_timeout: 15000, connectionTimeoutMillis: 8000, application_name: 'continuum-import',
          options: '-c default_transaction_read_only=on',
        });
        client.on?.('error', () => {});
        await client.connect();
        return { query: async (text, params) => (await client.query(text, params)).rows, close: async () => { await client.end().catch(() => {}); } };
      }
      if (type === 'mysql') {
        const mysql = typeof drivers.mysql === 'object' ? drivers.mysql : await import('mysql2/promise').catch(() => null);
        if (!mysql) throw fault(503, 'unavailable: the “mysql2” package is not installed.');
        const lib = mysql.createConnection ? mysql : mysql.default;
        const client = await lib.createConnection({
          host: dest.address, port: dest.port, user: dest.user, password: dest.password, database: dest.database,
          ssl: dest.tls ? { rejectUnauthorized: true, servername: dest.host } : undefined, connectTimeout: 8000, supportBigNumbers: true, bigNumberStrings: true,
        });
        try { await client.query('SET SESSION TRANSACTION READ ONLY'); } catch (e) { await client.end?.().catch(() => {}); throw e; }
        return { query: async (text, params) => (await client.query({ sql: text, values: params, timeout: 15000 }))[0], close: async () => { await client.end().catch(() => {}); } };
      }
      const mssql = typeof drivers.mssql === 'object' ? drivers.mssql : await import('mssql').catch(() => null);
      if (!mssql) throw fault(503, 'unavailable: the “mssql” package is not installed.');
      const lib = mssql.ConnectionPool ? mssql : mssql.default;
      const pool = new lib.ConnectionPool({
        server: dest.address, port: dest.port, user: dest.user, password: dest.password, database: dest.database,
        options: { encrypt: dest.tls, trustServerCertificate: false, serverName: dest.host, readOnlyIntent: true, appName: 'continuum-import' },
        requestTimeout: 15000, connectionTimeout: 8000,
      });
      await pool.connect();
      return {
        query: async (text, params) => { const request = pool.request(); params.forEach((v, i) => request.input('p' + (i + 1), v)); return (await request.query(text)).recordset; },
        close: async () => { await pool.close().catch(() => {}); },
      };
    };
    // A connection that fails to open is retried a few times; anything after that is the source's answer, not a hiccup.
    for (let attempt = 1; ; attempt++) {
      try { return await connectOnce(); } catch (e) {
        if (e.status) throw e;
        if (attempt >= limits.retries) throw fault(503, `The ${type} source could not be reached. Check the host, credentials and that the database allows this server.`);
        await (sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms))))(limits.retryBaseMs * 2 ** (attempt - 1));
      }
    }
  }
  const sqlAdapter = (type) => ({
    async *batches({ conn, mapping, checkpoint, mode, since, batchSize: size }) {
      const session = await openSql(type, conn, mapping);
      try {
        yield* sqlBatches(type, {
          query: async (text, params) => { try { return await session.query(text, params); } catch (e) { throw e.status ? e : fault(503, `The ${type} query failed. Check the table and column names and that the database account may read them.`); } },
          mapping, conn, checkpoint, mode, since, batchSize: size,
        });
      } finally { await session.close(); }
    },
  });
  async function restGet(companyId, conn, url) {
    const headers = { Accept: 'application/json', ...(conn.token && { Authorization: 'Bearer ' + conn.token }) };
    const response = await fetchWithRetries(async () => {
      // Validated and resolved on EVERY request (including next-page links): the address connected to is the one just checked.
      const dest = await resolveDestination(String(url), { allowedOrigins: originsFor(companyId), allowLoopback, resolver, ownerOrigins });
      try { return await pinnedGet({ url: dest.url, address: dest.address, family: dest.family, timeoutMs: limits.fetchTimeoutMs, maxBytes: limits.maxResponseBytes, headers }); }
      catch (e) {
        // Timeouts and unreachable hosts are retried; a redirect, an oversized response or a refused destination is final.
        const retryable = !e.status || (e.status === 503 && /timed out|could not be (?:reached|read)/i.test(e.message));
        throw Object.assign(fault(e.status === 413 ? 413 : retryable || e.status === 502 ? 503 : e.status, e.status ? e.message : 'The REST source could not be reached.'), retryable ? {} : { noRetry: true });
      }
    }, { attempts: limits.retries, baseMs: limits.retryBaseMs, maxRetryAfterMs: limits.maxRetryAfterMs, sleepFn });
    let body;
    try { body = JSON.parse(response.body.toString()); } catch { throw fault(502, 'The REST source did not return JSON.'); }
    return { body, headers: response.headers };
  }
  const adapters = {
    csv_sync: {
      async *batches({ conn, mapping, checkpoint, batchSize: size }) {
        if (typeof conn.csv !== 'string' || !conn.csv.trim()) throw fault(400, 'Paste or upload the CSV content.');
        if (Buffer.byteLength(conn.csv) > csvMaxBytes) throw fault(413, `The CSV is larger than ${Math.round(csvMaxBytes / 1048576)} MB. Use a CSV file source or a database source.`);
        yield* csvBatches(sliceString(conn.csv), { batchSize: size, skip: checkpoint?.rows || 0, maxRows: limits.csvMaxRows, requiredColumns: mappedColumns(mapping) });
      },
    },
    csv_file: {
      async *batches({ conn, mapping, checkpoint, batchSize: size }) {
        if (!availability.csv_file().available) throw fault(503, availability.csv_file().reason);
        const file = safeFile(conn.path, csvDirs, 'CSV');
        if (statSync(file).size > limits.csvFileMaxBytes) throw fault(413, `The CSV file is larger than ${Math.round(limits.csvFileMaxBytes / 1048576)} MB (DATA_SOURCE_CSV_FILE_MAX_BYTES).`);
        const stream = createReadStream(file, { highWaterMark: 65536 });
        try { yield* csvBatches(stream, { batchSize: size, skip: checkpoint?.rows || 0, maxRows: limits.csvMaxRows, requiredColumns: mappedColumns(mapping) }); } finally { stream.destroy(); }
      },
    },
    sqlite: sqlAdapter('sqlite'),
    postgres: sqlAdapter('postgres'),
    mysql: sqlAdapter('mysql'),
    mssql: sqlAdapter('mssql'),
    rest_api: {
      async *batches({ row, conn, checkpoint, since }) {
        if (!availability.rest_api().available) throw fault(503, availability.rest_api().reason);
        yield* restBatches({ conn, checkpoint, since, maxPages: limits.maxPages, getJson: (url) => restGet(row.company_id, conn, url) });
      },
    },
  };
  const mappedColumns = (mapping) => [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];

  const mapBatch = (rows, row, mapping, schema, base) => {
    const inBatch = new Set();
    return rows.map((r, i) => {
      const m = mapRecord(r, mapping, schema, { declaredVerified: Boolean(row.declared_verified) });
      if (m.externalId && inBatch.has(m.externalId)) m.issues.push('duplicate external id in this batch');
      inBatch.add(m.externalId);
      return { index: base + i, ...m };
    });
  };

  /** Read + map + validate without writing anything. Looks at the first MAX_RECORDS records only and says so. */
  async function dryRun(row, { limit = 200 } = {}) {
    const mapping = parse(row.field_mapping_json, {});
    const schema = parse(row.diagnostic_schema_json, []);
    const records = [];
    let truncated = false;
    const it = adapters[row.source_type].batches({ row, conn: connection(row), mapping, checkpoint: null, mode: 'full', since: null, batchSize })[Symbol.asyncIterator]();
    try {
      for (let step = await it.next(); !step.done; step = await it.next()) {
        records.push(...mapBatch(step.value.rows, row, mapping, schema, records.length));
        if (records.length >= MAX_RECORDS) { truncated = !(await it.next()).done; break; }
      }
    } finally { await it.return?.(); }
    const valid = records.filter((r) => !r.issues.length);
    return {
      total: records.length, truncated, valid: valid.length, invalid: records.length - valid.length,
      flaggedForReview: valid.filter((r) => r.hazards.length).length,
      withRedactions: valid.filter((r) => r.redactions).length,
      records,
      sample: records.slice(0, limit).map((r) => ({ index: r.index, externalId: r.externalId, title: r.passport.title, symptoms: r.passport.symptoms, steps: r.passport.steps, applicability: r.passport.applicability, safety: r.passport.safety, cInit: r.cInit.score, issues: r.issues, hazards: r.hazards, redactions: r.redactions })),
    };
  }

  // --------------------------------------------------------------------------- sync
  const keyOf = (value) => { try { return value === undefined || value === null || value === '' ? null : encodeKey(value); } catch { return null; } };
  const sinceFor = (highWater, conn, type) => {
    if (!highWater) return null;
    if (type === 'rest_api') return highWater.t === 'd' ? new Date(Date.parse(highWater.v) - limits.lookbackSeconds * 1000).toISOString() : highWater.v;
    if (highWater.t === 'd') return { t: 'd', v: new Date(Date.parse(highWater.v) - limits.lookbackSeconds * 1000).toISOString() };
    return highWater; // text and numbers compare inclusively (>=), so ties and late arrivals at the mark are re-read
  };

  /**
   * Idempotent, transactional upsert into this company's pool, one batch per transaction, with the checkpoint committed in the same
   * transaction. A run that reaches DATA_SOURCE_MAX_RECORDS pauses (status "deferred") and the next run continues from the checkpoint;
   * nothing is dropped. A FULL scan that was read to the end (across any number of resumed runs) may retire records the source no longer
   * lists, only if the owner declared the source an authoritative snapshot. Incremental, cancelled, failed and partial runs never retire.
   */
  async function sync(companyId, id, actor, { mode: requested = null, trigger = 'manual' } = {}) {
    const before = stored(companyId, id);
    if (before.status === 'paused') throw fault(409, 'This source is paused. Resume it before syncing.');
    const t0 = Date.now();
    const claimed = sql.prepare("UPDATE company_data_sources SET status='syncing',lease_until=?,stop_request=NULL,updated_at=? WHERE id=? AND company_id=? AND status<>'paused' AND (status<>'syncing' OR lease_until IS NULL OR lease_until<?)").run(t0 + limits.leaseMs, now(), id, companyId, t0);
    if (!claimed.changes) throw fault(409, 'A sync is already running for this source.');
    const row = stored(companyId, id);
    const runId = randomUUID();
    const mapping = parse(row.field_mapping_json, {}), schema = parse(row.diagnostic_schema_json, []);
    let checkpoint = parse(row.sync_checkpoint_json, null);
    if (!checkpoint && before.status === 'deferred' && Number.isInteger(row.sync_cursor) && row.sync_cursor > 0)
      checkpoint = { mode: 'full', scan: row.scan_generation, pos: { offset: row.sync_cursor }, processed: row.sync_cursor, scanProcessed: row.sync_cursor, scanInvalid: 0, noReconcile: true, legacy: true };
    const resuming = Boolean(checkpoint);
    const startedAt = now();
    const result = { startedAt, inserted: 0, updated: 0, unchanged: 0, skippedLocallyReviewed: 0, invalid: 0, flaggedForReview: 0, duplicates: 0, missingFromSource: 0, processed: 0, batches: 0, maxBatchRows: 0, ...(resuming && { resumedFrom: checkpoint.scanProcessed ?? checkpoint.processed ?? 0 }) };
    const fail = (e, finalStatus = 'error') => {
      const message = safeMessage(e);
      sql.prepare("UPDATE company_data_sources SET status=?,last_error=?,consecutive_failures=consecutive_failures+1,lease_until=NULL,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?")
        .run(finalStatus, message, JSON.stringify({ ...result, failed: true, error: message, finishedAt: now() }), now(), id, companyId);
      sql.prepare("UPDATE source_sync_runs SET status='failed',finished_at=?,error=?,result_json=? WHERE id=?").run(now(), message, JSON.stringify(result), runId);
      return e.status ? e : fault(503, message);
    };
    let conn, since = null, mode;
    try {
      conn = connection(row);
      const support = incrementalSupport(row, conn, mapping);
      const hw = parse(row.high_water_json, null);
      if (checkpoint) mode = checkpoint.mode;
      else if (requested === 'full') mode = 'full';
      else if (requested === 'incremental') {
        if (!support.ok) throw fault(400, 'Incremental sync is not available for this source. ' + support.reason);
        if (!hw) throw fault(409, 'Run one complete full sync first: incremental sync continues from its high-water mark.');
        mode = 'incremental';
      } else {
        const fullDue = !row.last_full_sync_at || t0 - Date.parse(row.last_full_sync_at) > limits.fullSyncHours * 3600000;
        mode = row.incremental_enabled && support.ok && hw && !fullDue ? 'incremental' : 'full';
        if (mode === 'full') result.modeReason = !row.incremental_enabled ? 'Incremental sync is off for this source, so this is a full sync.' : !support.ok ? support.reason : !hw ? 'No high-water mark yet: this first run is a full sync.' : 'A periodic full sync is due (it also detects removed records).';
      }
      result.mode = mode;
      if (mode === 'incremental') since = sinceFor(hw, conn, row.source_type);
      if (!checkpoint) {
        const scan = mode === 'full' ? row.scan_generation + 1 : row.scan_generation;
        if (mode === 'full') sql.prepare('UPDATE company_data_sources SET scan_generation=? WHERE id=? AND company_id=?').run(scan, id, companyId);
        checkpoint = { mode, scan, pos: null, processed: 0, scanProcessed: 0, scanInvalid: 0, hw: null };
      }
    } catch (e) {
      sql.prepare('INSERT INTO source_sync_runs(id,company_id,source_id,mode,trigger_kind,status,started_at,resumed) VALUES(?,?,?,?,?,?,?,?)').run(runId, companyId, id, requested || 'auto', trigger, 'running', startedAt, 0);
      throw fail(e);
    }
    sql.prepare('INSERT INTO source_sync_runs(id,company_id,source_id,mode,trigger_kind,status,started_at,resumed) VALUES(?,?,?,?,?,?,?,?)').run(runId, companyId, id, mode, trigger, 'running', startedAt, resuming ? 1 : 0);
    const scan = checkpoint.scan;
    const fullScan = mode === 'full';
    const stampAll = sql.prepare('UPDATE memory_pool SET source_scan=? WHERE company_id=? AND source_key=?');
    const changedIds = new Set();
    const apply = (rec) => {
      const sourceKey = rec.externalId ? `import:${id}:${rec.externalId}` : null;
      const latest = sourceKey ? sql.prepare('SELECT * FROM memory_pool WHERE company_id=? AND source_key=? ORDER BY version_number DESC LIMIT 1').get(companyId, sourceKey) : null;
      if (sourceKey && fullScan) {
        // The same id twice in one scan (even in different batches) is a duplicate: the first occurrence wins and the later one is reported.
        // Batches commit atomically with their checkpoint, so a resumed run never re-reads a committed batch and cannot trip this check.
        if (latest && latest.source_scan === scan) { result.duplicates++; return; }
        // A record the source still has (even one that fails validation) is stamped as seen in this scan, so it can never be retired.
        stampAll.run(scan, companyId, sourceKey);
      }
      if (rec.issues.length) {
        if (rec.issues.includes('duplicate external id in this batch')) result.duplicates++;
        else result.invalid++;
        return;
      }
      const p = rec.passport;
      const seenAt = now();
      const version = rec.sourceVersion || rec.updatedAt || null;
      const evidence = { type: 'company_database_import', sourceId: id, sourceType: row.source_type, externalRecordId: rec.externalId, declaredVerified: Boolean(row.declared_verified), importedAt: seenAt, customerConfirmed: false, ...(rec.updatedAt && { sourceUpdatedAt: rec.updatedAt }) };
      const eventBase = { companyId, chatbotId: row.chatbot_id, sourceId: id, actor };
      if (!latest) {
        const stored_ = insertPassport(sql, {
          companyId, chatbotId: row.chatbot_id, origin: 'company_db_sync', sourceKey, sourceId: id, externalRecordId: rec.externalId,
          title: p.title, symptoms: p.symptoms, applicability: p.applicability, safety: p.safety, steps: p.steps,
          initialConfidence: rec.cInit.score, customerConfirmed: false, evidence,
          provenance: { cInit: rec.cInit, redactions: rec.redactions, hazards: rec.hazards, importedBy: actor },
        });
        sql.prepare('UPDATE memory_pool SET last_seen_at=?,source_version=?,source_scan=? WHERE id=? AND company_id=?').run(seenAt, version, fullScan ? scan : null, stored_.id, companyId);
        recordKnowledgeEvent(sql, { ...eventBase, memoryId: stored_.id, kind: 'imported', detail: { status: stored_.status, sourceVersion: version, hazards: rec.hazards.length } });
        changedIds.add(stored_.id);
        result.inserted++;
        if (rec.hazards.length) result.flaggedForReview++;
        return;
      }
      sql.prepare('UPDATE memory_pool SET last_seen_at=?,source_version=? WHERE id=? AND company_id=?').run(seenAt, version, latest.id, companyId);
      // A record the source withdrew earlier and now lists again returns through the normal approval policy.
      if (latest.status === 'retired' && latest.source_status === 'withdrawn' && latest.origin_type === 'company_db_sync') {
        const hold = rec.hazards.length || !row.declared_verified;
        sql.prepare("UPDATE memory_pool SET status=?,source_status='present',flagged_reason=?,updated_at=? WHERE id=? AND company_id=?")
          .run(hold ? 'flagged_for_review' : 'active', rec.hazards.length ? 'Imported instructions need review: ' + rec.hazards.join(', ') : hold ? 'Imported from a company database and waiting for approval' : null, seenAt, latest.id, companyId);
        recordKnowledgeEvent(sql, { ...eventBase, memoryId: latest.id, kind: 'reappeared', detail: { heldForReview: Boolean(hold) } });
        changedIds.add(latest.id);
        result.reappeared = (result.reappeared || 0) + 1;
        return;
      }
      sql.prepare("UPDATE memory_pool SET source_status='present' WHERE id=? AND company_id=? AND source_status<>'present'").run(latest.id, companyId);
      // An import still waiting for approval has no local decisions yet, so the source may keep correcting it.
      const awaiting = latest.origin_type === 'company_db_sync' && latest.status === 'flagged_for_review' && !latest.locally_reviewed && latest.version_number === 1 && latest.reuse_failure_count === 0 && String(latest.flagged_reason || '').startsWith('Imported');
      // Never overwrite local decisions: review, revision lineage, flags or tracked failures.
      const local = latest.locally_reviewed || latest.version_number > 1 || latest.parent_version_id || (latest.status !== 'active' && !awaiting) || latest.reuse_failure_count > 0 || latest.origin_type !== 'company_db_sync';
      if (local) { result.skippedLocallyReviewed++; return; }
      // Compared in the stored (normalised) form, so an unchanged record is recognised as unchanged on every run.
      const next = { title: p.title, symptoms_text: p.symptoms, applicability_json: JSON.stringify(normalizeApplicability(p.applicability)), safety_restrictions_json: JSON.stringify(normalizeSafety(p.safety)), steps_json: JSON.stringify(stepsList(p.steps)) };
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
      recordKnowledgeEvent(sql, { ...eventBase, memoryId: latest.id, kind: 'updated_from_source', detail: { sourceVersion: version, hazards: rec.hazards.length } });
      changedIds.add(latest.id);
      result.updated++;
      if (rec.hazards.length) result.flaggedForReview++;
    };

    const stopRequested = () => sql.prepare('SELECT stop_request FROM company_data_sources WHERE id=? AND company_id=?').get(id, companyId)?.stop_request || null;
    const it = adapters[row.source_type].batches({ row, conn, mapping, checkpoint: checkpoint.pos, mode, since, batchSize })[Symbol.asyncIterator]();
    let deferred = false, stop = null, endReached = false;
    try {
      for (;;) {
        const step = await it.next();
        if (step.done) { endReached = true; break; }
        const { rows, checkpoint: pos } = step.value;
        const records = mapBatch(rows, row, mapping, schema, checkpoint.scanProcessed);
        for (const r of rows) {
          const k = keyOf(dotted(r, mapping.fields.updatedAt || '_'));
          if (k && compareKeys(k, checkpoint.hw) > 0) checkpoint.hw = k;
        }
        sql.transaction(() => {
          changedIds.clear();
          for (const rec of records) apply(rec);
          if (changedIds.size) life.detectConflicts(companyId, [...changedIds], actor);
          checkpoint.pos = pos;
          checkpoint.processed += records.length;
          checkpoint.scanProcessed += records.length;
          checkpoint.scanInvalid += records.filter((r) => r.issues.length).length;
          result.processed += records.length;
          result.batches++;
          result.maxBatchRows = Math.max(result.maxBatchRows, records.length);
          // Durable progress: the checkpoint commits with the batch it describes, so a crash can only lose work that was never committed.
          sql.prepare('UPDATE company_data_sources SET sync_checkpoint_json=?,lease_until=?,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?')
            .run(JSON.stringify(checkpoint), Date.now() + limits.leaseMs, JSON.stringify({ ...result, inProgress: true, scanProcessed: checkpoint.scanProcessed }), now(), id, companyId);
        }).immediate();
        // Hand the event loop back between batches so a long import never starves other requests (health, cancel, other tenants).
        await new Promise((r) => setImmediate(r));
        stop = stopRequested();
        if (stop) break;
        if (result.processed >= maxRecords) { deferred = !(await it.next()).done; endReached = !deferred; break; }
      }
    } catch (e) {
      await it.return?.().catch(() => {});
      throw fail(e);
    }
    await it.return?.().catch(() => {});
    if (stop) {
      result.finishedAt = now();
      if (stop === 'cancel') {
        result.cancelled = true;
        result.warning = 'Cancelled by the owner. Records already imported were kept; the next sync starts from the beginning.';
        sql.prepare("UPDATE company_data_sources SET status='cancelled',stop_request=NULL,sync_checkpoint_json=NULL,sync_cursor=NULL,lease_until=NULL,last_error=NULL,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?").run(JSON.stringify(result), result.finishedAt, id, companyId);
        sql.prepare("UPDATE source_sync_runs SET status='cancelled',finished_at=?,result_json=? WHERE id=?").run(result.finishedAt, JSON.stringify(result), runId);
      } else {
        result.paused = true;
        result.warning = 'Paused by the owner. Progress was kept; resume the source to continue where it stopped.';
        sql.prepare("UPDATE company_data_sources SET status='paused',stop_request=NULL,lease_until=NULL,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?").run(JSON.stringify(result), result.finishedAt, id, companyId);
        sql.prepare("UPDATE source_sync_runs SET status='paused',finished_at=?,result_json=? WHERE id=?").run(result.finishedAt, JSON.stringify(result), runId);
      }
      return result;
    }
    if (deferred) {
      result.deferred = true;
      result.nextOffset = checkpoint.scanProcessed;
      result.warning = `Paused after ${result.processed} records this run (the per-run limit is ${maxRecords}). Nothing was dropped: run the sync again to continue from record ${checkpoint.scanProcessed}.`;
      result.finishedAt = now();
      // last_synced_at is NOT advanced: a partial run is not a completed sync.
      sql.prepare("UPDATE company_data_sources SET status='deferred',lease_until=NULL,last_error=NULL,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?").run(JSON.stringify(result), result.finishedAt, id, companyId);
      sql.prepare("UPDATE source_sync_runs SET status='deferred',finished_at=?,result_json=? WHERE id=?").run(result.finishedAt, JSON.stringify(result), runId);
      return result;
    }
    try {
      sql.transaction(() => {
        const total = checkpoint.scanProcessed, invalidTotal = checkpoint.scanInvalid;
        const finished = now();
        let completeRead = false;
        if (fullScan) {
          // Reconciliation by scan stamp: every record the scan saw carries this scan's number, whichever run saw it, so a scan that was
          // paused and resumed any number of times reconciles exactly like an uninterrupted one. A scan that began under the old
          // offset checkpoint has no such stamps and never reconciles.
          const absentWhere = "company_id=? AND source_id=? AND origin_type='company_db_sync' AND status IN ('active','flagged_for_review') AND (source_scan IS NULL OR source_scan<>?)";
          const absent = checkpoint.noReconcile ? [] : sql.prepare(`SELECT id,chatbot_id FROM memory_pool WHERE ${absentWhere}`).all(companyId, id, scan);
          completeRead = !checkpoint.noReconcile && total > 0;
          const complete = completeRead && Boolean(row.authoritative_snapshot) && invalidTotal / total <= 0.5;
          result.snapshot = complete ? 'complete' : 'partial';
          result.missingFromSource = absent.length;
          if (absent.length && complete) {
            const retire = sql.prepare("UPDATE memory_pool SET status='retired',source_status='withdrawn',flagged_reason='Withdrawn from the source database',provenance_json=json_set(provenance_json,'$.retiredBy','source'),updated_at=? WHERE id=? AND company_id=?");
            for (const e of absent) { retire.run(finished, e.id, companyId); recordKnowledgeEvent(sql, { companyId, chatbotId: e.chatbot_id, memoryId: e.id, sourceId: id, kind: 'withdrawn', actor, detail: { reason: 'absent from a complete authoritative sync' } }); }
            result.retiredFromSource = absent.length;
          } else if (absent.length) {
            const mark = sql.prepare("UPDATE memory_pool SET source_status='missing' WHERE id=? AND company_id=?");
            for (const e of absent) mark.run(e.id, companyId);
            if (!row.authoritative_snapshot) result.warning = 'Records missing from the source were left in place because this source is not marked as a complete snapshot.';
          }
          if (checkpoint.noReconcile) result.warning = 'The resumed import finished. Run a full sync to reconcile records the source no longer lists.';
        } else result.snapshot = 'incremental';
        if (!total && fullScan) result.warning = 'The source returned no records, so nothing was retired.';
        result.finishedAt = finished;
        const priorHw = parse(row.high_water_json, null);
        const newHw = checkpoint.hw && compareKeys(checkpoint.hw, priorHw) > 0 ? checkpoint.hw : priorHw;
        // Only a read that reached the end advances the high-water mark; a full read also seeds it so incremental sync can start.
        sql.prepare(`UPDATE company_data_sources SET status='ok',sync_checkpoint_json=NULL,sync_cursor=NULL,lease_until=NULL,last_error=NULL,consecutive_failures=0,last_synced_at=?,
          last_complete_sync_at=CASE WHEN ? THEN ? ELSE last_complete_sync_at END,last_full_sync_at=CASE WHEN ? THEN ? ELSE last_full_sync_at END,high_water_json=?,last_sync_result_json=?,updated_at=? WHERE id=? AND company_id=?`)
          .run(finished, completeRead ? 1 : 0, finished, fullScan ? 1 : 0, finished, newHw ? JSON.stringify(newHw) : null, JSON.stringify({ ...result, scanProcessed: total }), finished, id, companyId);
        sql.prepare("UPDATE source_sync_runs SET status='completed',finished_at=?,result_json=? WHERE id=?").run(finished, JSON.stringify(result), runId);
      }).immediate();
    } catch (e) { throw fail(e); }
    return result;
  }

  /** Ask a running sync to stop at the next batch boundary ('cancel' drops its progress, 'pause' keeps it), or discard saved progress when nothing is running. */
  function requestStop(companyId, id, kind) {
    const row = stored(companyId, id);
    const running = row.status === 'syncing' && (row.lease_until || 0) > Date.now();
    if (running) {
      sql.prepare('UPDATE company_data_sources SET stop_request=? WHERE id=? AND company_id=?').run(kind, id, companyId);
      return { requested: true, running: true };
    }
    if (kind === 'cancel') {
      if (row.status === 'paused') throw fault(409, 'Resume the source before cancelling its saved progress.');
      sql.prepare("UPDATE company_data_sources SET status=CASE WHEN status='configured' THEN 'configured' ELSE 'cancelled' END,sync_checkpoint_json=NULL,sync_cursor=NULL,lease_until=NULL,stop_request=NULL,updated_at=? WHERE id=? AND company_id=?").run(now(), id, companyId);
      return { requested: true, running: false };
    }
    sql.prepare("UPDATE company_data_sources SET status='paused',updated_at=? WHERE id=? AND company_id=?").run(now(), id, companyId);
    return { requested: true, running: false };
  }

  // --------------------------------------------------------------------------- HTTP
  const schedulerState = { lastTickAt: null, lastResults: [] };
  async function handle(req, endpoint, session, send) {
    if (!/\/api\/company\/data-sources/.test(endpoint)) return false;
    const profile = session.profile;
    if (!session.account_id || profile.role !== 'owner') throw fault(403, 'Only the company owner can manage data sources.');
    const companyId = profile.companyId;
    if (endpoint === 'GET /api/company/data-sources') {
      send(200, {
        sources: sql.prepare('SELECT * FROM company_data_sources WHERE company_id=? ORDER BY created_at').all(companyId).map((r) => ({ ...publicView(r), recentRuns: runsOf(companyId, r.id, 5) })),
        allowedWebsites: { ownerManaged: ownerOrigins, server: [...allowedOrigins], company: ownerOrigins ? sql.prepare('SELECT origin,added_at AS addedAt FROM company_source_origins WHERE company_id=? ORDER BY origin').all(companyId) : [] },
        csvMaxBytes, limits: { batchSize, maxRecordsPerRun: maxRecords, csvMaxBytes, csvFileMaxBytes: limits.csvFileMaxBytes, csvMaxRows: limits.csvMaxRows, maxResponseBytes: limits.maxResponseBytes, fetchTimeoutMs: limits.fetchTimeoutMs, retries: limits.retries, lookbackSeconds: limits.lookbackSeconds, fullSyncHours: limits.fullSyncHours },
        scheduler: { concurrency: limits.schedulerConcurrency, perTick: limits.schedulerPerTick, lastTickAt: schedulerState.lastTickAt, mine: schedulerState.lastResults.filter((r) => r.companyId === companyId).slice(-10).map(({ companyId: _c, ...r }) => r) },
        availability: status(), sourceTypes: SOURCE_TYPES, passportFields: PASSPORT_FIELDS, requiredFields: REQUIRED_FIELDS, restStyles: REST_STYLES, connectionKeys: CONNECTION_KEYS,
        chatbots: sql.prepare('SELECT config FROM chatbots WHERE company_id=?').all(companyId).map((r) => normalizeBot(JSON.parse(r.config))).map((b) => ({ id: b.id, name: b.name, diagnosticSchema: b.diagnosticSchema || [] })),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/data-sources') {
      const body = await json(req, csvMaxBytes + 65536);
      if (body.confirmed !== true) throw fault(400, 'Confirm saving this data source.');
      const existing = body.id ? stored(companyId, body.id) : null;
      const type = existing ? existing.source_type : body.sourceType;
      if (!SOURCE_TYPES.includes(type)) throw fault(400, 'Choose a supported source type.');
      if (existing && body.sourceType && body.sourceType !== existing.source_type) throw fault(409, 'The service and source type of an existing source cannot change.');
      const bot = getBot(sql, companyId, field(body.chatbotId || existing?.chatbot_id || botId(profile), 'service', 200));
      if (existing && existing.chatbot_id !== bot.id) throw fault(409, 'The service and source type of an existing source cannot change.');
      if (existing && existing.status === 'syncing' && (existing.lease_until || 0) > Date.now()) throw fault(409, 'A sync is running. Cancel or pause it before editing this source.');
      const schema = bot.diagnosticSchema || [];
      const mapping = validateMapping(body.fieldMapping ?? (existing ? parse(existing.field_mapping_json, null) : null), schema);
      if (body.declaredVerified !== undefined && typeof body.declaredVerified !== 'boolean') throw fault(400, 'declaredVerified must be true or false.');
      if (body.authoritativeSnapshot !== undefined && typeof body.authoritativeSnapshot !== 'boolean') throw fault(400, 'authoritativeSnapshot must be true or false.');
      if (body.incrementalEnabled !== undefined && typeof body.incrementalEnabled !== 'boolean') throw fault(400, 'incrementalEnabled must be true or false.');
      const authoritative = body.authoritativeSnapshot === undefined ? Boolean(existing?.authoritative_snapshot) : body.authoritativeSnapshot;
      const declared = body.declaredVerified === undefined ? Boolean(existing?.declared_verified) : body.declaredVerified;
      const incremental = body.incrementalEnabled === undefined ? Boolean(existing?.incremental_enabled) : body.incrementalEnabled;
      let staleDays = existing?.stale_after_days ?? null;
      if (body.staleAfterDays !== undefined) {
        if (body.staleAfterDays === null) staleDays = null;
        else if (Number.isInteger(body.staleAfterDays) && body.staleAfterDays >= 1 && body.staleAfterDays <= 3650) staleDays = body.staleAfterDays;
        else throw fault(400, 'The stale-after policy must be a whole number of days from 1 to 3650, or null for none.');
      }
      const id = existing?.id || randomUUID();
      // Optional scheduled sync: every N hours (1–720), or null for manual only. Nothing is scheduled unless the owner sets this.
      let interval = existing?.sync_interval_hours ?? null;
      if (body.syncIntervalHours !== undefined) {
        if (body.syncIntervalHours === null) interval = null;
        else if (Number.isInteger(body.syncIntervalHours) && body.syncIntervalHours >= 1 && body.syncIntervalHours <= 720) interval = body.syncIntervalHours;
        else throw fault(400, 'The sync interval must be a whole number of hours from 1 to 720, or null for manual sync only.');
      }
      const nextSync = interval === null ? null : interval === existing?.sync_interval_hours && existing?.next_sync_at ? existing.next_sync_at : new Date(Date.now() + interval * 3600000).toISOString();
      let encrypted = existing?.encrypted_connection_uri || null;
      let connectionChanged = false;
      if (body.connection !== undefined) {
        if (!body.connection || typeof body.connection !== 'object' || Array.isArray(body.connection)) throw fault(400, 'Send the connection details as an object.');
        const previous = existing ? connection(existing) : {};
        const merged = { ...previous };
        for (const [k, raw] of Object.entries(body.connection)) {
          if (!CONNECTION_KEYS[type].includes(k)) throw fault(400, `“${k}” is not a setting of this kind of source.`);
          const v = typeof raw === 'number' ? String(raw) : raw;
          if (v === undefined || v === null) continue;
          if (typeof v !== 'string') throw fault(400, `“${k}” must be text.`);
          if (v === '') { if (!SECRET_KEYS.has(k)) delete merged[k]; continue; } // a blank secret keeps the stored value
          merged[k] = v.slice(0, k === 'csv' ? csvMaxBytes : MAX_BYTES);
        }
        await validateConnection(type, merged, companyId);
        encrypted = delivery.seal(merged, 'datasource:' + id);
        connectionChanged = JSON.stringify(merged) !== JSON.stringify(previous);
      } else if (!existing) throw fault(400, 'Provide the connection details.');
      if (!encrypted) throw fault(400, 'Provide the connection details.');
      const mappingChanged = existing ? JSON.stringify(mapping) !== JSON.stringify(parse(existing.field_mapping_json, {})) : false;
      const t = now();
      const name = field(body.name ?? existing?.name, 'name', 100);
      sql.transaction(() => {
        sql.prepare(`INSERT INTO company_data_sources(id,company_id,chatbot_id,name,source_type,encrypted_connection_uri,field_mapping_json,diagnostic_schema_json,declared_verified,status,created_at,updated_at,sync_interval_hours,next_sync_at,authoritative_snapshot,incremental_enabled,stale_after_days)
          VALUES(?,?,?,?,?,?,?,?,?,'configured',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,encrypted_connection_uri=excluded.encrypted_connection_uri,field_mapping_json=excluded.field_mapping_json,declared_verified=excluded.declared_verified,updated_at=excluded.updated_at,sync_interval_hours=excluded.sync_interval_hours,next_sync_at=excluded.next_sync_at,authoritative_snapshot=excluded.authoritative_snapshot,incremental_enabled=excluded.incremental_enabled,stale_after_days=excluded.stale_after_days WHERE company_data_sources.company_id=excluded.company_id`)
          .run(id, companyId, bot.id, name, type, encrypted, JSON.stringify(mapping), JSON.stringify(schema), declared ? 1 : 0, t, t, interval, nextSync, authoritative ? 1 : 0, incremental ? 1 : 0, staleDays);
        // Reading a different place or mapping the columns differently invalidates saved progress and the high-water mark: start clean.
        if (existing && (connectionChanged || mappingChanged))
          sql.prepare("UPDATE company_data_sources SET sync_checkpoint_json=NULL,sync_cursor=NULL,high_water_json=NULL,status=CASE WHEN status IN ('deferred','error','cancelled') THEN 'configured' ELSE status END WHERE id=? AND company_id=?").run(id, companyId);
        if (existing) recordKnowledgeEvent(sql, { companyId, chatbotId: bot.id, sourceId: id, kind: 'source_edited', actor: profile.id, detail: { connectionChanged, mappingChanged, name } });
      }).immediate();
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
    const match = endpoint.match(/^(GET|POST|DELETE) \/api\/company\/data-sources\/([^/]+)(?:\/(preview|sync|test|pause|resume|cancel|runs))?$/);
    if (match) {
      const [, method, id, action] = match;
      const row = stored(companyId, decodeURIComponent(id));
      if (method === 'GET' && action === 'runs') {
        send(200, { runs: runsOf(companyId, row.id, 50) });
        return true;
      }
      if (method === 'DELETE' && !action) {
        sql.prepare('DELETE FROM company_data_sources WHERE id=? AND company_id=?').run(row.id, companyId);
        // Imported passports stay (history/metrics); they are retired so they stop being recommended.
        sql.prepare("UPDATE memory_pool SET status='retired',updated_at=? WHERE company_id=? AND source_id=? AND origin_type='company_db_sync' AND status IN ('active','flagged_for_review') AND locally_reviewed=0").run(now(), companyId, row.id);
        recordKnowledgeEvent(sql, { companyId, chatbotId: row.chatbot_id, sourceId: row.id, kind: 'source_removed', actor: profile.id, detail: { name: row.name } });
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
        const conn = connection(row), mapping = parse(row.field_mapping_json, {});
        const it = adapters[row.source_type].batches({ row, conn, mapping, checkpoint: null, mode: 'full', since: null, batchSize })[Symbol.asyncIterator]();
        try {
          const step = await it.next();
          if (!step.done) { rows = step.value.rows.length; columns = Object.keys(step.value.rows[0] || {}).slice(0, 30); }
        } catch (e) { throw e.status ? e : fault(503, safeMessage(e)); } finally { await it.return?.().catch(() => {}); }
        const support = incrementalSupport(row, conn, mapping);
        send(200, { ok: true, reachable: true, firstBatchRows: rows, columns, ms: Math.round(performance.now() - started), incremental: support, note: rows ? 'Connected and read the first batch. Nothing was saved.' : 'Connected, but the source returned no rows.' });
        return true;
      }
      if (method === 'POST' && (action === 'pause' || action === 'resume')) {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Confirm this change.');
        if (action === 'pause') {
          if (row.status === 'paused') throw fault(409, 'This source is already paused.');
          const result = requestStop(companyId, row.id, 'pause');
          send(200, { ...result, source: publicView(stored(companyId, row.id)) });
        } else {
          if (row.status !== 'paused') throw fault(409, 'This source is not paused.');
          const back = row.sync_checkpoint_json || row.sync_cursor ? 'deferred' : row.last_synced_at ? 'ok' : 'configured';
          sql.prepare('UPDATE company_data_sources SET status=?,updated_at=? WHERE id=? AND company_id=?').run(back, now(), row.id, companyId);
          send(200, { source: publicView(stored(companyId, row.id)) });
        }
        return true;
      }
      if (method === 'POST' && action === 'cancel') {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Confirm cancelling this sync.');
        send(200, { ...requestStop(companyId, row.id, 'cancel'), source: publicView(stored(companyId, row.id)) });
        return true;
      }
      if (method === 'POST' && action === 'sync') {
        const body = await json(req);
        if (body.confirmed !== true) throw fault(400, 'Confirm the sync.');
        if (body.mode !== undefined && !['full', 'incremental'].includes(body.mode)) throw fault(400, 'mode must be full or incremental.');
        send(200, { success: true, result: await sync(companyId, row.id, profile.id, { mode: body.mode || null }) });
        return true;
      }
    }
    throw fault(404, 'Data source route not found.');
  }

  /**
   * Run every source whose schedule is due. Fair across companies (round-robin, so one company with many due sources cannot starve the
   * others), at most one source per company at a time, bounded total concurrency. Each source is claimed with a conditional update that moves
   * its next run forward first, so overlapping workers can never run the same source twice. A failure is recorded on the source and retried
   * after a short, growing delay (never later than the normal interval); a run that paused at its per-run limit continues on the next tick.
   * Only sources an owner gave a sync interval are ever run here: nothing is scheduled by default.
   */
  async function runDue(at = Date.now()) {
    const iso = new Date(at).toISOString();
    const due = sql.prepare("SELECT id,company_id,sync_interval_hours FROM company_data_sources WHERE sync_interval_hours IS NOT NULL AND status<>'paused' AND (status<>'syncing' OR lease_until IS NULL OR lease_until<?) AND next_sync_at<=? ORDER BY next_sync_at").all(at, iso);
    const queues = new Map();
    for (const r of due) { if (!queues.has(r.company_id)) queues.set(r.company_id, []); queues.get(r.company_id).push(r); }
    const order = [];
    while (order.length < limits.schedulerPerTick && [...queues.values()].some((q) => q.length)) for (const q of queues.values()) if (q.length && order.length < limits.schedulerPerTick) order.push(q.shift());
    const results = [];
    const runOne = async (r) => {
      const next = new Date(at + r.sync_interval_hours * 3600000).toISOString();
      const claimed = sql.prepare('UPDATE company_data_sources SET next_sync_at=?,last_scheduled_at=? WHERE id=? AND company_id=? AND sync_interval_hours IS NOT NULL AND next_sync_at<=?').run(next, iso, r.id, r.company_id, iso);
      if (!claimed.changes) return;
      try {
        const result = await sync(r.company_id, r.id, 'scheduled', { trigger: 'scheduled' });
        if (result.deferred) sql.prepare('UPDATE company_data_sources SET next_sync_at=? WHERE id=? AND company_id=?').run(new Date(at + 60000).toISOString(), r.id, r.company_id);
        results.push({ id: r.id, companyId: r.company_id, status: result.deferred ? 'deferred' : result.cancelled || result.paused ? 'stopped' : 'ok', mode: result.mode, inserted: result.inserted, updated: result.updated, at: iso });
      } catch (e) {
        const failures = sql.prepare('SELECT consecutive_failures n FROM company_data_sources WHERE id=? AND company_id=?').get(r.id, r.company_id)?.n || 1;
        const retry = Math.min(r.sync_interval_hours * 60, limits.schedulerRetryMinutes * 2 ** Math.min(failures - 1, 10));
        if (e.status !== 409) sql.prepare('UPDATE company_data_sources SET next_sync_at=? WHERE id=? AND company_id=?').run(new Date(at + retry * 60000).toISOString(), r.id, r.company_id);
        results.push({ id: r.id, companyId: r.company_id, status: 'error', error: e.status ? e.message : 'sync failed', retryInMinutes: e.status === 409 ? null : retry, at: iso });
      }
    };
    // Waves of distinct companies, up to the concurrency limit.
    const waiting = [...order];
    while (waiting.length) {
      const wave = [], used = new Set();
      for (let i = 0; i < waiting.length && wave.length < limits.schedulerConcurrency; i++) if (!used.has(waiting[i].company_id)) { used.add(waiting[i].company_id); wave.push(waiting[i]); waiting.splice(i--, 1); }
      await Promise.all(wave.map(runOne));
    }
    schedulerState.lastTickAt = iso;
    schedulerState.lastResults = [...schedulerState.lastResults, ...results].slice(-100);
    return results;
  }
  /** Counts for the owner's health summary: nothing here reads source content. */
  function health(companyId) {
    const rows = sql.prepare('SELECT * FROM company_data_sources WHERE company_id=?').all(companyId);
    const views = rows.map((r) => freshness(r));
    return { total: rows.length, failing: views.filter((v) => v.state === 'error').length, stale: views.filter((v) => v.state === 'stale').length, partial: views.filter((v) => v.state === 'partial').length, paused: views.filter((v) => v.state === 'paused').length, needsAttention: views.filter((v) => ['error', 'stale', 'partial'].includes(v.state)).length };
  }
  return { handle, dryRun, sync, runDue, status, availability: status, requestStop, health, limits, lifecycle: life, runs: (companyId, id, n) => runsOf(companyId, id, n) };
}
