import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const collections = [
  'repair',
  'it',
  'requirements',
  'bookings',
  'handoffs',
  'audit',
  'memories',
  'conversations',
  'operations',
  'demoBookings',
  'outbox',
  'resolutions',
];
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
    this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) return;
        let data = seed();
        if (legacy && existsSync(legacy)) {
          data = JSON.parse(readFileSync(legacy, 'utf8'));
          for (const key of requiredLegacy)
            if (!Array.isArray(data[key]))
              throw new Error(
                'Invalid data store: ' + key + ' must be an array. Restore a valid backup before starting.',
              );
        }
        for (const key of collections) {
          data[key] ??= [];
          if (!Array.isArray(data[key])) throw new Error('Invalid data store: ' + key + ' must be an array.');
        }
        this.save(data);
        this.db.prepare('INSERT INTO schema_migrations VALUES(1, ?)').run(new Date().toISOString());
      })
      .immediate();
    // Upgrade existing installations atomically. Existing data is never assigned to a
    // newly registered company; its explicit legacy tenant remains isolated.
    this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) return;
        this.db.exec(`
        CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, join_hash TEXT UNIQUE, created_at INTEGER NOT NULL);
        INSERT INTO companies VALUES('legacy','Existing workspace',NULL,0);
        ALTER TABLE accounts ADD COLUMN company_id TEXT REFERENCES companies(id);
        UPDATE accounts SET company_id='legacy' WHERE company_id IS NULL;
        CREATE TRIGGER account_company_required_insert BEFORE INSERT ON accounts WHEN NEW.company_id IS NULL BEGIN SELECT RAISE(ABORT,'company is required'); END;
        CREATE TRIGGER account_company_required_update BEFORE UPDATE OF company_id ON accounts WHEN NEW.company_id IS NULL BEGIN SELECT RAISE(ABORT,'company is required'); END;
        ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('owner','staff','customer'));
        CREATE TABLE invitations (token_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), email TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('repair','it')), role TEXT NOT NULL CHECK(role IN ('staff','customer')), expires_at INTEGER NOT NULL, consumed_at INTEGER);
        UPDATE accounts SET role='staff' WHERE id IN (SELECT account_id FROM staff_access);
        DROP INDEX provider_slot;
        CREATE UNIQUE INDEX provider_slot ON records(json_extract(payload, '$.companyId'), json_extract(payload, '$.provider'), json_extract(payload, '$.datetime')) WHERE collection='bookings' AND json_extract(payload, '$.cancelledAt') IS NULL;
      `);
        const data = this.data;
        for (const [collection, rows] of Object.entries(data)) {
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            if (['repair', 'it', 'bookings', 'handoffs', 'resolutions'].includes(collection))
              row.companyId ||= 'legacy';
            if (row.scope && /^(repair|it):/.test(row.scope)) row.scope = 'legacy:' + row.scope;
            if (row.scope && /^knowledge:(repair|it)$/.test(row.scope))
              row.scope = row.scope.replace('knowledge:', 'knowledge:legacy:');
          }
        }
        this.save(data);
        this.db.prepare('INSERT INTO schema_migrations VALUES(2, ?)').run(new Date().toISOString());
      })
      .immediate();
    this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) return;
        const data = this.data;
        for (const m of data.memories)
          if (m.kind === 'preference' && /\b(call|email|contact|notify|phone|text)\b/i.test(m.text)) {
            m.sourceTicketId = m.ticketId;
            m.ticketId = 'customer-preferences';
            m.customerWide = true;
            m.category = 'contact';
            delete m.syncedTo;
          }
        this.save(data);
        this.db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(new Date().toISOString());
      })
      .immediate();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS provider_connections (company_id TEXT PRIMARY KEY REFERENCES companies(id), base_url TEXT NOT NULL, encrypted_token TEXT NOT NULL, mapping TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_customers (account_id TEXT PRIMARY KEY REFERENCES accounts(id), company_id TEXT NOT NULL REFERENCES companies(id), external_id TEXT NOT NULL, UNIQUE(company_id,external_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS resolution_uses (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      customer_id TEXT NOT NULL, scope TEXT NOT NULL, ticket_id TEXT NOT NULL,
      resolution_id TEXT NOT NULL, exchange_id TEXT NOT NULL, environment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
      note TEXT, handoff_id TEXT, created_at TEXT NOT NULL, feedback_at TEXT,
      UNIQUE(company_id,provider,customer_id,ticket_id,resolution_id)
    ); CREATE INDEX IF NOT EXISTS resolution_use_lookup ON resolution_uses(company_id,provider,resolution_id,status);`);
    this.db
      .transaction(() => {
        const connectorColumns = this.db
          .prepare('PRAGMA table_info(provider_connections)')
          .all()
          .map((c) => c.name);
        if (!connectorColumns.includes('writes_enabled'))
          this.db.exec(
            "ALTER TABLE provider_connections ADD COLUMN writes_enabled INTEGER NOT NULL DEFAULT 0; ALTER TABLE provider_connections ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'; ALTER TABLE provider_connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;",
          );
      })
      .immediate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, account_id TEXT NOT NULL, provider TEXT NOT NULL,
      ticket_id TEXT NOT NULL, action_id TEXT NOT NULL, kind TEXT NOT NULL, customer_id TEXT NOT NULL,
      payload TEXT NOT NULL, config_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      worker TEXT, provider_ref TEXT, last_error TEXT, created_at TEXT NOT NULL,
      UNIQUE(company_id,account_id,kind,action_id)
    ); CREATE INDEX IF NOT EXISTS provider_job_ready ON provider_jobs(status,next_attempt);`);
  }
  get data() {
    const data = Object.fromEntries(collections.map((key) => [key, []]));
    for (const row of this.db
      .prepare('SELECT collection, payload FROM records ORDER BY collection, position')
      .all())
      data[row.collection].push(JSON.parse(row.payload));
    data.schemaVersion = 3;
    return data;
  }
  save(data) {
    const upsert = this.db.prepare(
      'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,record_key) DO UPDATE SET position=excluded.position,payload=excluded.payload WHERE position<>excluded.position OR payload<>excluded.payload',
    );
    const remove = this.db.prepare('DELETE FROM records WHERE collection=? AND record_key=?');
    for (const collection of collections) {
      const previous = new Set(
        this.db
          .prepare('SELECT record_key FROM records WHERE collection=?')
          .all(collection)
          .map((r) => r.record_key),
      );
      for (const [index, row] of data[collection].entries()) {
        const key =
          collection === 'operations'
            ? row.scope + ':' + row.key
            : (row.scope || '') + ':' + (row.id || row.ticket_id || String(index));
        upsert.run(collection, key, index, JSON.stringify(row));
        previous.delete(key);
      }
      for (const key of previous) remove.run(collection, key);
    }
  }
  update(change) {
    try {
      return this.db
        .transaction(() => {
          const next = this.data;
          const result = change(next);
          this.save(next);
          return result;
        })
        .immediate();
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT'))
        throw Object.assign(
          new Error(
            'This update conflicts with a record saved by another request. Refresh and retry safely.',
          ),
          { status: 409 },
        );
      throw error;
    }
  }
  operation(scope, key, fingerprint) {
    if (!key) return null;
    const row = this.db
      .prepare("SELECT payload FROM records WHERE collection='operations' AND record_key=?")
      .get(scope + ':' + key);
    if (!row) return null;
    const found = JSON.parse(row.payload);
    if (found.fingerprint !== fingerprint)
      throw Object.assign(new Error('This submission key was already used for different details.'), {
        status: 409,
      });
    return found.response;
  }
  close() {
    this.db.close();
  }
}
