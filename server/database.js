import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const collections = ['repair', 'it', 'requirements', 'bookings', 'handoffs', 'audit', 'memories', 'conversations', 'operations', 'demoBookings', 'outbox', 'resolutions'];
const requiredLegacy = ['repair', 'it', 'requirements', 'bookings', 'handoffs', 'audit', 'memories'];
export class SqliteStore {
  constructor({ file, seed }) {
    const legacy = file?.endsWith('.json') ? file : null;
    this.file = legacy ? file.slice(0, -5) + '.sqlite' : file || ':memory:';
    if (this.file !== ':memory:') mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new Database(this.file);
    if (this.file !== ':memory:') chmodSync(this.file, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, record_key TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(collection, record_key));
      CREATE INDEX IF NOT EXISTS record_scope ON records(collection, json_extract(payload, '$.scope'), json_extract(payload, '$.ticketId'));
      CREATE UNIQUE INDEX IF NOT EXISTS provider_slot ON records(json_extract(payload, '$.provider'), json_extract(payload, '$.datetime')) WHERE collection='bookings' AND json_extract(payload, '$.cancelledAt') IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_slot ON records(json_extract(payload, '$.datetime')) WHERE collection='demoBookings' AND json_extract(payload, '$.cancelledAt') IS NULL;
      CREATE TABLE IF NOT EXISTS staff_access (account_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('repair','it')));
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('repair','it')), email_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, demo_profile TEXT, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL, CHECK(account_id IS NOT NULL OR demo_profile IS NOT NULL));
      CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id);
      CREATE TABLE IF NOT EXISTS auth_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, used INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, encrypted_token TEXT NOT NULL, calendar_id TEXT NOT NULL DEFAULT 'primary', connected_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) return;
      let data = seed();
      if (legacy && existsSync(legacy)) {
        data = JSON.parse(readFileSync(legacy, 'utf8'));
        for (const key of requiredLegacy) if (!Array.isArray(data[key])) throw new Error('Invalid data store: ' + key + ' must be an array. Restore a valid backup before starting.');
      }
      for (const key of collections) {
        data[key] ??= [];
        if (!Array.isArray(data[key])) throw new Error('Invalid data store: ' + key + ' must be an array.');
      }
      this.save(data);
      this.db.prepare('INSERT INTO schema_migrations VALUES(1, ?)').run(new Date().toISOString());
    }).immediate();
  }
  get data() {
    const data = Object.fromEntries(collections.map((key) => [key, []]));
    for (const row of this.db.prepare('SELECT collection, payload FROM records ORDER BY collection, position').all()) data[row.collection].push(JSON.parse(row.payload));
    data.schemaVersion = 3;
    return data;
  }
  save(data) {
    const upsert = this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,record_key) DO UPDATE SET position=excluded.position,payload=excluded.payload WHERE position<>excluded.position OR payload<>excluded.payload');
    const remove = this.db.prepare('DELETE FROM records WHERE collection=? AND record_key=?');
    for (const collection of collections) {
      const previous = new Set(this.db.prepare('SELECT record_key FROM records WHERE collection=?').all(collection).map((r) => r.record_key));
      for (const [index, row] of data[collection].entries()) {
        const key = collection === 'operations' ? row.scope + ':' + row.key : (row.scope || '') + ':' + (row.id || row.ticket_id || String(index));
        upsert.run(collection, key, index, JSON.stringify(row)); previous.delete(key);
      }
      for (const key of previous) remove.run(collection, key);
    }
  }
  update(change) {
    try {
      return this.db.transaction(() => { const next = this.data; const result = change(next); this.save(next); return result; }).immediate();
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw Object.assign(new Error('This update conflicts with a record saved by another request. Refresh and retry safely.'), { status: 409 });
      throw error;
    }
  }
  operation(scope, key, fingerprint) {
    if (!key) return null;
    const row = this.db.prepare("SELECT payload FROM records WHERE collection='operations' AND record_key=?").get(scope + ':' + key);
    if (!row) return null;
    const found = JSON.parse(row.payload);
    if (found.fingerprint !== fingerprint) throw Object.assign(new Error('This submission key was already used for different details.'), { status: 409 });
    return found.response;
  }
  close() { this.db.close(); }
}
