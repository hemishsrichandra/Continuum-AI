import { randomUUID } from 'node:crypto';
import { Store } from '../server/providers.js';
import { existsSync } from 'node:fs';
if(existsSync('.env')) process.loadEnvFile('.env');
const [email, provider, companyId]=process.argv.slice(2);
if(!email || !companyId || !['repair','it'].includes(provider)) throw new Error('Usage: node scripts/grant-staff.js staff@example.com repair|it company-id');
const store=new Store(process.env.DATABASE_FILE || process.env.DATA_FILE || 'data/demo.json');
try {
 const user=store.db.prepare('SELECT id FROM accounts WHERE email=?').get(email.toLowerCase());
 if(!user) throw new Error('Create the staff account first.');
 store.db.transaction(()=>{
 const result=store.db.prepare("UPDATE company_memberships SET role=CASE WHEN role='owner' THEN role ELSE 'staff' END,provider=? WHERE account_id=? AND company_id=? AND status='active'").run(provider,user.id,companyId);
 if(!result.changes) throw new Error('Active membership not found.');
 store.update(data=>data.audit.push({id:randomUUID(),scope:'company:'+companyId,kind:'staff_granted',email:email.toLowerCase(),authorId:'administrative-script',createdAt:new Date().toISOString()}));
 }).immediate();
 console.log('Staff access provisioned for the selected service workspace.');
} finally {store.close();}
