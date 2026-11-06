import { Store } from '../server/providers.js';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const email = process.argv[2];
if (!email) throw new Error('Usage: node scripts/grant-owner.js existing-owner@example.com');
const store = new Store(process.env.DATABASE_FILE || process.env.DATA_FILE || 'data/demo.json');
try {
  const result = store.db.prepare("UPDATE accounts SET role='owner' WHERE email=?").run(email.toLowerCase());
  if (!result.changes) throw new Error('Account not found.');
  console.log('Owner access granted in the existing company workspace.');
} finally {
  store.close();
}
