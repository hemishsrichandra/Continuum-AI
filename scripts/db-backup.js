import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
const raw = process.env.DATABASE_FILE || process.env.DATA_FILE || 'data/demo.sqlite';
const source = resolve(raw.endsWith('.json') ? raw.slice(0, -5) + '.sqlite' : raw);
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || destination === source || existsSync(destination)) throw new Error('Provide a new backup path: npm run db:backup -- /absolute/path/continuum-backup.sqlite');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true, fileMustExist: true });
try { await db.backup(destination); chmodSync(destination, 0o600); console.log('Database backup saved to ' + destination); }
finally { db.close(); }
