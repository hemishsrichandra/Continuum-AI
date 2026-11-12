import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureBots, defaultBotId, knowledgeScope } from './chatbots.js';
import { SCHEMA_V5, backfillV5 } from './passports.js';

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
        this.freshInstall = true;
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
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()) return;
      this.db.exec(`
        CREATE TABLE company_memberships (
          company_id TEXT NOT NULL REFERENCES companies(id), account_id TEXT NOT NULL REFERENCES accounts(id),
          role TEXT NOT NULL CHECK(role IN ('customer','staff','owner')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
          provider TEXT NOT NULL CHECK(provider IN ('repair','it')), created_at INTEGER NOT NULL,
          PRIMARY KEY(company_id,account_id));
        CREATE UNIQUE INDEX account_normalized_email ON accounts(lower(trim(email)));
        INSERT INTO company_memberships SELECT company_id,id,role,'active',COALESCE((SELECT provider FROM staff_access WHERE account_id=accounts.id),provider),created_at FROM accounts;
        CREATE TABLE chatbots (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), adapter TEXT NOT NULL CHECK(adapter IN ('repair','it')), config TEXT NOT NULL CHECK(json_valid(config)), UNIQUE(company_id,id));
        ALTER TABLE sessions ADD COLUMN active_company_id TEXT REFERENCES companies(id);
        ALTER TABLE sessions ADD COLUMN active_chatbot_id TEXT REFERENCES chatbots(id);
        UPDATE sessions SET active_company_id=(SELECT company_id FROM accounts WHERE id=account_id);
        ALTER TABLE external_customers RENAME TO external_customers_v3;
        CREATE TABLE external_customers (account_id TEXT NOT NULL REFERENCES accounts(id),company_id TEXT NOT NULL REFERENCES companies(id),external_id TEXT NOT NULL, PRIMARY KEY(company_id,account_id),UNIQUE(company_id,external_id));
        INSERT INTO external_customers SELECT * FROM external_customers_v3;
        DROP TABLE external_customers_v3;
        CREATE TABLE customer_directory (company_id TEXT NOT NULL REFERENCES companies(id),external_id TEXT NOT NULL,email TEXT NOT NULL,display_name TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(company_id,external_id));
        ALTER TABLE resolution_uses ADD COLUMN chatbot_id TEXT REFERENCES chatbots(id);
        CREATE TABLE troubleshooting_attempts (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL,
          customer_id TEXT NOT NULL, ticket_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('standard','learned')),
          fix_id TEXT NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), context TEXT NOT NULL CHECK(json_valid(context)),
          outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed','skipped')),
          exchange_id TEXT, use_id TEXT REFERENCES resolution_uses(id), handoff_id TEXT, created_at TEXT NOT NULL,outcome_at TEXT,
          FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id),
          UNIQUE(company_id,chatbot_id,customer_id,ticket_id,source));
        CREATE TABLE troubleshooting_context (company_id TEXT NOT NULL,chatbot_id TEXT NOT NULL,customer_id TEXT NOT NULL,ticket_id TEXT NOT NULL,context TEXT NOT NULL CHECK(json_valid(context)),PRIMARY KEY(company_id,chatbot_id,customer_id,ticket_id));
      `);
      for (const c of this.db.prepare('SELECT id FROM companies').all()) ensureBots(this.db, c.id);
      this.db.exec("UPDATE sessions SET active_chatbot_id=active_company_id || ':' || (SELECT provider FROM company_memberships WHERE company_id=active_company_id AND account_id=sessions.account_id); UPDATE resolution_uses SET chatbot_id=company_id || ':' || provider;");
      const data = this.data;
      for (const [collection, rows] of Object.entries(data)) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const parts = row.scope?.split(':') || [];
          const adapter = ['repair','it'].includes(collection) ? collection : row.provider || parts[1];
          const company = row.companyId || (parts[0] === 'knowledge' ? parts[1] : parts[0]);
          if (company && ['repair','it'].includes(adapter)) row.chatbotId ||= defaultBotId(company, adapter);
          if (row.scope?.startsWith('knowledge:')) {
            const [, c, p] = parts;
            if (['repair','it'].includes(p)) {
              row.scope = knowledgeScope(c, defaultBotId(c,p));
              // Invalidate old remote bank documents locally; worker republishes to the new bank.
              if (row.syncedTo) row.previousSyncedTo = row.syncedTo;
              delete row.syncedTo;
              row.syncPending = true;
            }
          }
        }
      }
      this.save(data);
      for (const u of this.db.prepare('SELECT * FROM resolution_uses ORDER BY created_at DESC').all()) {
        const r=data.resolutions.find(r=>r.id===u.resolution_id);
        const insert=this.db.prepare('INSERT OR IGNORE INTO troubleshooting_attempts(id,company_id,chatbot_id,customer_id,ticket_id,source,fix_id,snapshot,context,outcome,exchange_id,use_id,handoff_id,created_at,outcome_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        insert.run('legacy-standard:'+u.id,u.company_id,u.chatbot_id,u.customer_id,u.ticket_id,'standard','legacy-stage',JSON.stringify({reason:'Legacy learned recommendation predates configured standard playbooks.'}),u.environment,'skipped',u.exchange_id,null,u.handoff_id,u.created_at,u.created_at);
        insert.run('legacy-learned:'+u.id,u.company_id,u.chatbot_id,u.customer_id,u.ticket_id,'learned',u.resolution_id,JSON.stringify({id:u.resolution_id,environment:r?.environment,solution:r?.solution}),u.environment,u.status,u.exchange_id,u.id,u.handoff_id,u.created_at,u.feedback_at);
      }
      this.db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(new Date().toISOString());
    }).immediate();
    this.migrateV5();
    this.migrateV6();
    // Idempotent hardening: the case timeline is an audit trail and can only be appended to.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS case_events_append_only_update BEFORE UPDATE ON case_events BEGIN SELECT RAISE(ABORT,'case_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS case_events_append_only_delete BEFORE DELETE ON case_events BEGIN SELECT RAISE(ABORT,'case_events is append-only'); END;
    `);
  }
  // Migration 6: per-service staff access, scheduled data-source sync columns and expression indexes for
  // the hot read paths. Additive and idempotent.
  migrateV6() {
    // Every statement is idempotent, so this runs on each start (it also repairs a database whose v5 tables
    // were restored from an older backup after v6 had been recorded).
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS staff_chatbot_access (
          company_id TEXT NOT NULL, account_id TEXT NOT NULL, chatbot_id TEXT NOT NULL, granted_by TEXT, created_at TEXT NOT NULL,
          PRIMARY KEY(company_id,account_id,chatbot_id),
          FOREIGN KEY(company_id,account_id) REFERENCES company_memberships(company_id,account_id),
          FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id));
        CREATE INDEX IF NOT EXISTS staff_access_account ON staff_chatbot_access(company_id,account_id);
        CREATE INDEX IF NOT EXISTS records_company ON records(collection, json_extract(payload,'$.companyId'));
        CREATE INDEX IF NOT EXISTS records_position ON records(collection, position);
        CREATE INDEX IF NOT EXISTS records_chatbot ON records(collection, json_extract(payload,'$.companyId'), json_extract(payload,'$.chatbotId'));
      `);
      const columns = this.db.prepare('PRAGMA table_info(company_data_sources)').all().map((c) => c.name);
      if (!columns.includes('sync_interval_hours')) this.db.exec('ALTER TABLE company_data_sources ADD COLUMN sync_interval_hours INTEGER CHECK(sync_interval_hours IS NULL OR sync_interval_hours BETWEEN 1 AND 720)');
      if (!columns.includes('next_sync_at')) this.db.exec('ALTER TABLE company_data_sources ADD COLUMN next_sync_at TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS data_source_due ON company_data_sources(next_sync_at) WHERE sync_interval_hours IS NOT NULL');
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(6,?)').run(new Date().toISOString());
    }).immediate();
  }
  // Migration 5: unified company memory (Resolution Passports), FTS5 index,
  // follow-through tasks, case timeline, company data sources and sequential
  // troubleshooting attempts. Additive, transactional and idempotent. A file
  // database is copied to <file>.pre-v5.bak before the first upgrade.
  migrateV5() {
    if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=5').get()) return;
    if (this.file !== ':memory:' && this.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n > 1 && !this.freshInstall) {
      const backup = this.file + '.pre-v5.bak';
      if (!existsSync(backup)) {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.db.prepare('VACUUM INTO ?').run(backup);
        try { chmodSync(backup, 0o600); } catch { /* best effort */ }
      }
    }
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=5').get()) return;
      this.db.exec(SCHEMA_V5);
      // Rebuild attempts so one ticket can hold up to three sequential learned suggestions.
      this.db.exec(`
        CREATE TABLE troubleshooting_attempts_v5 (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), chatbot_id TEXT NOT NULL,
          customer_id TEXT NOT NULL, ticket_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('standard','learned')),
          sequence INTEGER NOT NULL DEFAULT 1 CHECK(sequence BETWEEN 1 AND 3),
          fix_id TEXT NOT NULL, memory_id TEXT, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), context TEXT NOT NULL CHECK(json_valid(context)),
          score TEXT CHECK(score IS NULL OR json_valid(score)),
          outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed','skipped')),
          exchange_id TEXT, use_id TEXT REFERENCES resolution_uses(id), handoff_id TEXT, created_at TEXT NOT NULL,outcome_at TEXT,
          FOREIGN KEY(company_id,chatbot_id) REFERENCES chatbots(company_id,id),
          UNIQUE(company_id,chatbot_id,customer_id,ticket_id,source,sequence));
        INSERT INTO troubleshooting_attempts_v5(id,company_id,chatbot_id,customer_id,ticket_id,source,sequence,fix_id,memory_id,snapshot,context,outcome,exchange_id,use_id,handoff_id,created_at,outcome_at)
          SELECT id,company_id,chatbot_id,customer_id,ticket_id,source,1,fix_id,CASE WHEN source='learned' THEN fix_id END,snapshot,context,outcome,exchange_id,use_id,handoff_id,created_at,outcome_at FROM troubleshooting_attempts;
        DROP TABLE troubleshooting_attempts;
        ALTER TABLE troubleshooting_attempts_v5 RENAME TO troubleshooting_attempts;
        CREATE INDEX IF NOT EXISTS troubleshooting_ticket ON troubleshooting_attempts(company_id,chatbot_id,customer_id,ticket_id);
        CREATE INDEX IF NOT EXISTS resolution_use_ticket ON resolution_uses(company_id,chatbot_id,customer_id,ticket_id);
      `);
      backfillV5(this.db, this.data, this.db.prepare('SELECT * FROM resolution_uses').all());
      this.db.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(new Date().toISOString());
    }).immediate();
  }
  // Collections whose rows carry a companyId, and collections whose rows are scoped by a string prefix.
  static BY_COMPANY = ['repair', 'it', 'bookings', 'handoffs', 'resolutions'];
  static BY_SCOPE = ['requirements', 'audit', 'memories', 'conversations', 'operations'];
  #load(withKeys = false) {
    const data = Object.fromEntries(collections.map((key) => [key, []]));
    const snapshot = withKeys ? new Map() : null;
    for (const row of this.db.prepare('SELECT collection, record_key, position, payload FROM records ORDER BY collection, position').all()) {
      data[row.collection].push(JSON.parse(row.payload));
      if (snapshot) snapshot.set(row.collection + '\u0000' + row.record_key, row.position + '\u0000' + row.payload);
    }
    data.schemaVersion = 6;
    return { data, snapshot };
  }
  get data() {
    return this.#load().data;
  }
  /**
   * Only the rows belonging to one company, read through the expression indexes (records_company and
   * record_scope). Use this for read paths so one busy tenant does not slow every other tenant. Rows keep
   * their global order. Collections that are not company-owned (outbox, demo bookings) are empty here.
   */
  dataFor(companyId) {
    return this.#scoped(companyId, false).data;
  }
  #scoped(companyId, withKeys) {
    if (typeof companyId !== 'string' || !companyId) throw new Error('dataFor requires a company id');
    const data = Object.fromEntries(collections.map((key) => [key, []]));
    const snapshot = withKeys ? new Map() : null;
    const take = (collection, rows) => {
      rows.sort((x, y) => x.position - y.position);
      for (const row of rows) {
        data[collection].push(JSON.parse(row.payload));
        if (snapshot) snapshot.set(collection + '\u0000' + row.record_key, { position: row.position, payload: row.payload });
      }
    };
    const prefixRange = (prefix) => [prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)];
    const ranges = [`${companyId}:`, `knowledge:${companyId}:`, `operator:${companyId}:`].map(prefixRange);
    for (const collection of SqliteStore.BY_COMPANY)
      take(collection, this.db.prepare("SELECT record_key, position, payload FROM records WHERE collection=? AND json_extract(payload,'$.companyId')=?").all(collection, companyId));
    // One indexed range query per prefix (an OR of ranges defeats the scope index), merged back into global order.
    const queries = [
      ...ranges.map((range) => ["json_extract(payload,'$.scope')>=? AND json_extract(payload,'$.scope')<?", range]),
      ["json_extract(payload,'$.scope')=?", [`company:${companyId}`]],
    ];
    for (const collection of SqliteStore.BY_SCOPE) {
      const found = [];
      for (const [where, args] of queries)
        for (const row of this.db.prepare(`SELECT record_key, position, payload FROM records WHERE collection=? AND ${where}`).all(collection, ...args)) found.push(row);
      take(collection, found);
    }
    data.schemaVersion = 6;
    return { data, snapshot };
  }
  /** All rows of one collection whose JSON path equals a value (index-backed for companyId/scope). */
  rows(collection, path, value) {
    if (!collections.includes(collection) || !/^\$\.[A-Za-z_][A-Za-z0-9_]*$/.test(path)) throw new Error('Invalid collection or path');
    return this.db.prepare(`SELECT payload FROM records WHERE collection=? AND json_extract(payload,'${path}')=? ORDER BY position`).all(collection, value).map((r) => JSON.parse(r.payload));
  }
  // Writes only the rows that changed. `snapshot` (from #load) lets this compare in memory instead of
  // issuing one SQL statement per existing row.
  save(data, snapshot = null) {
    const upsert = this.db.prepare(
      'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,record_key) DO UPDATE SET position=excluded.position,payload=excluded.payload WHERE position<>excluded.position OR payload<>excluded.payload',
    );
    const remove = this.db.prepare('DELETE FROM records WHERE collection=? AND record_key=?');
    const keyOf = (collection, row, index) =>
      collection === 'operations' ? row.scope + ':' + row.key : (row.scope || '') + ':' + (row.id || row.ticket_id || String(index));
    if (snapshot) {
      const seen = new Set();
      for (const collection of collections)
        for (const [index, row] of data[collection].entries()) {
          const key = keyOf(collection, row, index);
          const id = collection + '\u0000' + key;
          const payload = JSON.stringify(row);
          seen.add(id);
          if (snapshot.get(id) !== index + '\u0000' + payload) upsert.run(collection, key, index, payload);
        }
      for (const id of snapshot.keys())
        if (!seen.has(id)) {
          const [collection, key] = id.split('\u0000');
          remove.run(collection, key);
        }
      return;
    }
    for (const collection of collections) {
      const previous = new Set(this.db.prepare('SELECT record_key FROM records WHERE collection=?').all(collection).map((r) => r.record_key));
      for (const [index, row] of data[collection].entries()) {
        const key = keyOf(collection, row, index);
        upsert.run(collection, key, index, JSON.stringify(row));
        previous.delete(key);
      }
      for (const key of previous) remove.run(collection, key);
    }
  }
  updateFor(companyId, change) {
    return this.update(change, { companyId });
  }
  // Persists only the changed rows of ONE company's slice. Rows keep their positions; new rows are appended.
  #saveScoped(data, snapshot) {
    const upsert = this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,record_key) DO UPDATE SET position=excluded.position,payload=excluded.payload');
    const remove = this.db.prepare('DELETE FROM records WHERE collection=? AND record_key=?');
    const seen = new Set();
    for (const collection of [...SqliteStore.BY_COMPANY, ...SqliteStore.BY_SCOPE]) {
      let next = null;
      for (const row of data[collection]) {
        if (collection !== 'operations' && !row.id && !row.ticket_id) row.id = randomUUID();
        const key = collection === 'operations' ? row.scope + ':' + row.key : (row.scope || '') + ':' + (row.id || row.ticket_id);
        const id = collection + '\u0000' + key;
        const payload = JSON.stringify(row);
        seen.add(id);
        const before = snapshot.get(id);
        if (before) {
          if (before.payload !== payload) upsert.run(collection, key, before.position, payload);
        } else {
          next ??= this.db.prepare('SELECT COALESCE(MAX(position),-1) m FROM records WHERE collection=?').get(collection).m;
          upsert.run(collection, key, ++next, payload);
        }
      }
    }
    for (const id of snapshot.keys())
      if (!seen.has(id)) {
        const [collection, key] = id.split('\u0000');
        remove.run(collection, key);
      }
  }
  /**
   * Run `change` against the store and persist the result atomically. With `{ companyId }` only that
   * company's rows are loaded and written, so the cost does not grow with other tenants' data. Use the scoped
   * form only when `change` touches that company's rows (and the outbox/demo collections, which it never sees).
   */
  update(change, { companyId } = {}) {
    try {
      return this.db
        .transaction(() => {
          if (companyId) {
            const { data: scoped, snapshot: slice } = this.#scoped(companyId, true);
            const result = change(scoped);
            this.#saveScoped(scoped, slice);
            return result;
          }
          const { data: next, snapshot } = this.#load(true);
          const result = change(next);
          this.save(next, snapshot);
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
