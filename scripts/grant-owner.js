import { randomUUID } from 'node:crypto';
import { Store } from '../server/providers.js';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const [email,companyId] = process.argv.slice(2);
if (!email || !companyId) throw new Error('Usage: node scripts/grant-owner.js existing-owner@example.com company-id');
const store = new Store(process.env.DATABASE_FILE || process.env.DATA_FILE || 'data/demo.json');
try {
 store.db.transaction(()=>{
  const result = store.db.prepare("UPDATE company_memberships SET role='owner' WHERE account_id=(SELECT id FROM accounts WHERE email=?) AND company_id=? AND status='active'").run(email.toLowerCase(),companyId);
  if (!result.changes) throw new Error('Account not found.');
 store.update(data=>data.audit.push({id:randomUUID(),scope:'company:'+companyId,kind:'owner_granted',email:email.toLowerCase(),authorId:'administrative-script',createdAt:new Date().toISOString()}));
 }).immediate();
  console.log('Owner access granted in the existing company workspace.');
} finally {
  store.close();
}
