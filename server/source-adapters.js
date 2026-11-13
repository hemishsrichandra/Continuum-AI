// Source adapter building blocks: an incremental CSV parser, SQL page builders for every supported dialect, and REST
// pagination with bounded retries. Nothing here touches the database of this application or holds more than one batch of rows.
//
// ADAPTER CONTRACT (see createDataSources in data-sources.js). An adapter is
//   { type, available(), async *batches({ row, conn, mapping, checkpoint, mode, since, batchSize }) }
// and each yielded batch is { rows: object[], checkpoint: <JSON-serialisable resume token> }. A generator that ends has read the
// whole source. The sync engine persists `checkpoint` in the same transaction as the batch's writes, so a crash or an error can
// only ever lose the batch in flight: the next run resumes from the last committed checkpoint. To add a database, implement
// `batches` (reading only through `buildPageQuery` or an equivalent bounded, read-only query) and register it in `adapters`.
import { setTimeout as sleep } from 'node:timers/promises';
import { fault } from './providers.js';

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
export const dotted = (row, path) => String(path).split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), row);

// --------------------------------------------------------------------------- CSV (incremental)
/** Header names from real exports ("Ticket ID", "Resolution (internal)") become plain identifiers; plain ones are kept exactly. */
export const csvHeaderName = (h) => { const t = String(h).trim(); return IDENT.test(t) ? t : t.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, 'c_').slice(0, 64) || 'column'; };

/** Push text in any chunking; completed rows come back as { cells, line }. Quotes, embedded commas/newlines and CRLF split across chunks are handled. */
export class CsvParser {
  constructor() { this.cell = ''; this.row = []; this.quoted = false; this.skipLF = false; this.line = 1; this.rowLine = 1; this.bomChecked = false; }
  push(text) {
    const out = [];
    let s = String(text);
    if (!this.bomChecked && s.length) { this.bomChecked = true; if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.skipLF) { this.skipLF = false; if (c === '\n') continue; }
      if (this.quoted) {
        if (c === '"') {
          if (i + 1 < s.length ? s[i + 1] === '"' : false) { this.cell += '"'; i++; }
          else if (i + 1 >= s.length) { this.pendingQuote = true; this.quoted = false; } // may be the first half of an escaped quote
          else this.quoted = false;
        } else { if (c === '\n') this.line++; this.cell += c; }
      } else if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === '"') { this.cell += '"'; this.quoted = true; continue; }
        i--; // the quote really did close the field: handle this character normally
      } else if (c === '"' && !this.cell) this.quoted = true;
      else if (c === ',') { this.row.push(this.cell); this.cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r') this.skipLF = true;
        this.row.push(this.cell); this.cell = '';
        if (this.row.some((x) => x !== '')) out.push({ cells: this.row, line: this.rowLine });
        this.row = [];
        this.line++;
        this.rowLine = this.line;
      } else this.cell += c;
    }
    return out;
  }
  end() {
    if (this.pendingQuote) { this.pendingQuote = false; }
    else if (this.quoted) throw fault(400, `The CSV has an unterminated quoted field starting on line ${this.rowLine}. Check for a stray double quote.`);
    this.row.push(this.cell);
    const out = this.row.some((x) => x !== '') ? [{ cells: this.row, line: this.rowLine }] : [];
    this.row = []; this.cell = '';
    return out;
  }
}

/** Decode bytes (or pass strings through) as UTF-8, honouring UTF-16 byte-order marks; anything else is refused, never guessed. */
export async function* decodedChunks(source) {
  let decoder = null, first = true;
  for await (const chunk of source) {
    if (typeof chunk === 'string') { yield chunk; continue; }
    let bytes = chunk;
    if (first) {
      first = false;
      const enc = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      decoder = new TextDecoder(enc, { fatal: true });
      if (enc !== 'utf-8') bytes = bytes.subarray(2);
    }
    try { yield decoder.decode(bytes, { stream: true }); } catch { throw fault(400, 'The file is not valid UTF-8 text. Re-save it as UTF-8 (or UTF-16 with a byte-order mark) and try again.'); }
  }
  if (decoder) { try { const tail = decoder.decode(); if (tail) yield tail; } catch { throw fault(400, 'The file ends in the middle of a character. Re-save it as UTF-8 and try again.'); } }
}

/**
 * Stream a CSV record by record. Each record is the column->value object plus `__line` (1-based line in the file) and, for a row
 * whose column count does not match the header, `__issue` (a row is never silently padded or dropped).
 */
export async function* csvRecords(source, { maxRows = 5000000, requiredColumns = [], skip = 0 } = {}) {
  const parser = new CsvParser();
  let header = null, index = 0;
  const handle = function* (rows) {
    for (const { cells, line } of rows) {
      if (!header) {
        header = cells.map(csvHeaderName);
        if (new Set(header).size !== header.length) throw fault(400, 'CSV column names must be unique.');
        const missing = requiredColumns.filter((c) => !c.includes('.') && !header.includes(c));
        if (missing.length) throw fault(400, `Columns not found in the CSV: ${missing.join(', ')}. The file has: ${header.slice(0, 30).join(', ')}.`);
        continue;
      }
      if (index >= maxRows) throw fault(413, `The CSV has more than ${maxRows} data rows (the limit is DATA_SOURCE_CSV_MAX_ROWS). Split the file or raise the limit.`);
      const n = index++;
      if (n < skip) continue; // resuming: rows before the checkpoint were committed by an earlier run
      const record = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
      Object.defineProperty(record, '__line', { value: line, enumerable: false });
      if (cells.length !== header.length) Object.defineProperty(record, '__issue', { value: `line ${line} has ${cells.length} columns but the header has ${header.length}`, enumerable: false });
      Object.defineProperty(record, '__index', { value: n, enumerable: false });
      yield record;
    }
  };
  for await (const text of decodedChunks(source)) yield* handle(parser.push(text));
  yield* handle(parser.end());
  if (!header) throw fault(400, 'The CSV is empty.');
}

/** Group CSV records into batches whose checkpoint is the number of data rows consumed so far. */
export async function* csvBatches(source, { batchSize, skip = 0, maxRows, requiredColumns }) {
  let rows = [], consumed = skip;
  for await (const record of csvRecords(source, { maxRows, requiredColumns, skip })) {
    rows.push(record);
    consumed = record.__index + 1;
    if (rows.length >= batchSize) { yield { rows, checkpoint: { rows: consumed } }; rows = []; }
  }
  if (rows.length) yield { rows, checkpoint: { rows: consumed } };
}

/** A string as an async stream of fixed-size slices (so a stored CSV is parsed incrementally like a file would be). */
export async function* sliceString(text, size = 65536) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }

// --------------------------------------------------------------------------- SQL pages
const DIALECTS = {
  sqlite: { quote: (n) => `"${n}"`, ph: () => '?' },
  postgres: { quote: (n) => `"${n}"`, ph: (i) => `$${i}` },
  mysql: { quote: (n) => '`' + n + '`', ph: () => '?' },
  mssql: { quote: (n) => `[${n}]`, ph: (i) => `@p${i}`, top: true },
};
export const SQL_TYPES = Object.keys(DIALECTS);

/** A key value as it was read (number, string or Date) -> a JSON-safe token, and back. Anything else cannot be a stable sort key. */
export function encodeKey(v) {
  if (v instanceof Date) return { t: 'd', v: v.toISOString() };
  if (typeof v === 'number' && Number.isFinite(v)) return { t: 'n', v };
  if (typeof v === 'bigint') return { t: 's', v: v.toString() };
  if (typeof v === 'string') return { t: 's', v };
  throw fault(400, 'The record id and “last updated” columns must be text, numbers or timestamps so the sync can resume from them.');
}
export const decodeKey = (k) => (k.t === 'd' ? new Date(k.v) : k.v);
export const compareKeys = (a, b) => {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.t !== b.t) return String(a.v) < String(b.v) ? -1 : 1;
  const x = a.t === 'd' ? Date.parse(a.v) : a.v, y = b.t === 'd' ? Date.parse(b.v) : b.v;
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * One bounded, read-only SELECT for a page. Identifiers are validated and quoted for the dialect, values are always bound,
 * and the ordering is a total order (the id column, or updated-at then id), so a checkpoint is a keyset rather than an offset:
 * rows inserted or removed between runs cannot make a resumed run skip or repeat records.
 *   full:        WHERE id > :after                                     ORDER BY id
 *   incremental: WHERE updated >= :since | (updated, id) > :after      ORDER BY updated, id   (>= keeps ties and late arrivals)
 *   legacy:      ORDER BY id LIMIT/OFFSET (only to resume a checkpoint written before keysets existed)
 */
export function buildPageQuery(type, { schema = null, table, columns, idColumn, updatedColumn = null, mode = 'full', since = null, after = null, offset = null, limit }) {
  const d = DIALECTS[type];
  if (!d) throw fault(400, 'Unsupported database type.');
  const names = [table, idColumn, updatedColumn, schema, ...columns].filter(Boolean);
  if (names.some((n) => !IDENT.test(n))) throw fault(400, 'Table, schema and column names must be plain identifiers.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw fault(400, 'Invalid batch size.');
  const q = d.quote, params = [];
  const bind = (v) => { params.push(v); return d.ph(params.length); };
  const id = q(idColumn), upd = updatedColumn ? q(updatedColumn) : null;
  const where = [];
  let order = id;
  if (mode === 'incremental') {
    if (!upd) throw fault(400, 'Incremental sync needs the “Last updated” column to be mapped.');
    order = `${upd},${id}`;
    if (after) {
      const u1 = bind(decodeKey(after.u)), u2 = bind(decodeKey(after.u)), i = bind(decodeKey(after.id));
      where.push(`(${upd} > ${u1} OR (${upd} = ${u2} AND ${id} > ${i}))`);
    } else if (since) where.push(`${upd} >= ${bind(decodeKey(since))}`);
  } else if (after) where.push(`${id} > ${bind(decodeKey(after.id))}`);
  const from = (schema ? q(schema) + '.' : '') + q(table);
  const cols = [...new Set(columns)].map(q).join(',');
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (type === 'mssql') {
    if (offset) return { text: `SELECT ${cols} FROM ${from}${clause} ORDER BY ${order} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${limit} ROWS ONLY`, params };
    return { text: `SELECT TOP (${limit}) ${cols} FROM ${from}${clause} ORDER BY ${order}`, params };
  }
  return { text: `SELECT ${cols} FROM ${from}${clause} ORDER BY ${order} LIMIT ${limit}${offset ? ` OFFSET ${Math.floor(offset)}` : ''}`, params };
}

/** Page through a SQL source with an injected `query(text, params) -> rows` function. */
export async function* sqlBatches(type, { query, mapping, conn, checkpoint, mode, since, batchSize }) {
  const idColumn = mapping.fields.externalId, updatedColumn = mapping.fields.updatedAt || null;
  const columns = [...new Set([...Object.values(mapping.fields), ...Object.values(mapping.diagnostics)])];
  let after = checkpoint?.after || null, offset = checkpoint?.offset || 0;
  for (;;) {
    const { text, params } = buildPageQuery(type, { schema: conn.schema || null, table: conn.table, columns, idColumn, updatedColumn, mode, since, after: offset ? null : after, offset: offset || null, limit: batchSize });
    const rows = await query(text, params);
    if (!rows.length) return;
    const lastRow = rows[rows.length - 1];
    if (offset) { offset += rows.length; yield { rows, checkpoint: { offset } }; }
    else {
      const next = mode === 'incremental' ? { u: encodeKey(lastRow[updatedColumn]), id: encodeKey(lastRow[idColumn]) } : { id: encodeKey(lastRow[idColumn]) };
      yield { rows, checkpoint: { after: next } };
      after = next;
    }
    if (rows.length < batchSize) return;
  }
}

// --------------------------------------------------------------------------- REST
const retryAfterMs = (headers = {}) => {
  const v = headers['retry-after'];
  if (!v) return null;
  if (/^\d+$/.test(String(v))) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
};
/** Run one request with bounded retries: transient network faults and HTTP 429/500/502/503/504, honouring Retry-After up to a cap. */
export async function fetchWithRetries(doRequest, { attempts = 3, baseMs = 500, maxRetryAfterMs = 30000, sleepFn = (ms) => sleep(ms) } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try { response = await doRequest(); }
    catch (e) {
      if (e.status === 503 && !e.noRetry && attempt < attempts) { await sleepFn(baseMs * 2 ** (attempt - 1)); continue; }
      throw e;
    }
    if (response.status >= 200 && response.status < 300) return response;
    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    if (!retryable) throw fault(response.status === 401 || response.status === 403 ? 502 : 503, `The REST source returned HTTP ${response.status}.` + (response.status === 401 || response.status === 403 ? ' Check the token.' : ''));
    const wait = retryAfterMs(response.headers) ?? baseMs * 2 ** (attempt - 1);
    if (wait > maxRetryAfterMs) throw fault(429, `The source is limiting requests (HTTP ${response.status}, retry after ${Math.ceil(wait / 1000)} s). The sync stopped and can be resumed.`);
    if (attempt >= attempts) throw fault(response.status === 429 ? 429 : 503, `The REST source kept returning HTTP ${response.status} after ${attempts} attempts. The sync stopped and can be resumed.`);
    await sleepFn(wait);
  }
}

export const REST_STYLES = ['none', 'page', 'offset', 'cursor', 'next_link'];
/** Parse an RFC 5988 Link header and return the rel="next" target. */
export function linkHeaderNext(header) {
  for (const part of String(header || '').split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)/.exec(part);
    if (m && /rel\s*=\s*"?(?:[^"]*\s)?next(?:\s[^"]*)?"?/i.test(m[2])) return m[1];
  }
  return null;
}
export const restStyle = (conn) => (REST_STYLES.includes(conn.pagination) ? conn.pagination : conn.pageParam ? 'page' : 'none');
const intIn = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };

/**
 * Page through a REST API in one of four styles. `getJson(url)` returns { body, headers } and is responsible for validating the
 * destination, pinning the address, retrying and bounding the response. Every follow-up URL must stay on the configured origin.
 */
export async function* restBatches({ conn, checkpoint, since, getJson, maxPages = 100000 }) {
  const style = restStyle(conn);
  const base = new URL(conn.url);
  const size = intIn(conn.pageSize, null, 10, 5000);
  const limitParam = IDENT.test(conn.limitParam || '') ? conn.limitParam : 'limit';
  for (const [name, value] of [['pageParam', conn.pageParam], ['offsetParam', conn.offsetParam], ['cursorParam', conn.cursorParam], ['sinceParam', conn.sinceParam]])
    if (value && !IDENT.test(value)) throw fault(400, `“${name}” must be a plain name such as page.`);
  if (style === 'page' && !conn.pageParam) throw fault(400, 'Set the page parameter (for example page).');
  if (style === 'cursor' && !(conn.cursorParam && conn.nextCursorPath && PATH.test(conn.nextCursorPath))) throw fault(400, 'Cursor paging needs a cursor parameter and the path of the next cursor in the response (for example meta.next_cursor).');
  if (style === 'next_link' && !(conn.nextLinkPath === 'header:link' || PATH.test(conn.nextLinkPath || ''))) throw fault(400, 'Next-link paging needs the path of the next link in the response (for example links.next) or header:link.');
  const records = (body) => {
    const list = conn.recordsPath ? dotted(body, conn.recordsPath) : body;
    if (!Array.isArray(list)) throw fault(502, 'The REST source must return an array of records (set “recordsPath” if they are nested).');
    return list;
  };
  const urlFor = (extra = {}) => {
    const u = new URL(base);
    if (since && conn.sinceParam) u.searchParams.set(conn.sinceParam, String(since));
    if (size && style !== 'next_link' && style !== 'none') u.searchParams.set(limitParam, String(size));
    else if (size && style === 'next_link') u.searchParams.set(limitParam, String(size));
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u;
  };
  let seen = checkpoint?.seen || 0;
  if (style === 'none') {
    const { body } = await getJson(urlFor());
    const rows = records(body);
    if (rows.length) yield { rows, checkpoint: { seen: rows.length } };
    return;
  }
  const visited = new Set();
  let page = checkpoint?.page ?? (Number.isInteger(Number(conn.pageStart)) ? Number(conn.pageStart) : 1);
  let offset = checkpoint?.offset ?? 0, cursor = checkpoint?.cursor ?? null, next = checkpoint?.next ?? null;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) throw fault(502, `The REST source kept returning pages; stopped after ${maxPages} pages.`);
    let url;
    if (style === 'page') url = urlFor({ [conn.pageParam]: page });
    else if (style === 'offset') url = urlFor({ [IDENT.test(conn.offsetParam || '') ? conn.offsetParam : 'offset']: offset });
    else if (style === 'cursor') url = urlFor(cursor ? { [conn.cursorParam]: cursor } : {});
    else url = next ? new URL(next, base) : urlFor();
    if (url.origin !== base.origin) throw fault(502, 'The source pointed the next page at a different website; the sync stopped. Nothing from it was followed.');
    if (style === 'next_link') { if (visited.has(url.href)) throw fault(502, 'The source repeated a page link; the sync stopped to avoid looping.'); visited.add(url.href); }
    const { body, headers } = await getJson(url);
    const rows = records(body);
    if (!rows.length) return;
    seen += rows.length;
    let token;
    if (style === 'page') { page += 1; token = { page, seen }; }
    else if (style === 'offset') { offset += rows.length; token = { offset, seen }; }
    else if (style === 'cursor') {
      const nextCursor = dotted(body, conn.nextCursorPath);
      if (nextCursor !== undefined && nextCursor !== null && nextCursor !== '' && String(nextCursor) === String(cursor)) throw fault(502, 'The source returned the same cursor twice; the sync stopped to avoid looping.');
      cursor = nextCursor ? String(nextCursor) : null;
      token = { cursor, seen, done: !cursor };
    } else {
      const link = conn.nextLinkPath === 'header:link' ? linkHeaderNext(headers?.link) : dotted(body, conn.nextLinkPath);
      next = link ? String(link) : null;
      token = { next, seen, done: !next };
    }
    yield { rows, checkpoint: token };
    if (token.done) return;
    // Only an empty page (or no next cursor/link) ends the read: a source may cap its page size below the one requested, so a short page proves nothing.
  }
}
