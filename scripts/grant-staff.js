import { Store } from '../server/providers.js';
import { existsSync } from 'node:fs';
if(existsSync('.env')) process.loadEnvFile('.env');
const [email, provider]=process.argv.slice(2);
if(!email || !['repair','it'].includes(provider)) throw new Error('Usage: node scripts/grant-staff.js staff@example.com repair|it');
const store=new Store(process.env.DATABASE_FILE || process.env.DATA_FILE || 'data/demo.json');
try {
 const user=store.db.prepare('SELECT id FROM accounts WHERE email=?').get(email.toLowerCase());
 if(!user) throw new Error('Create the staff account first.');
 store.db.prepare("UPDATE accounts SET role='staff' WHERE id=? AND role<>'owner'").run(user.id);
 store.db.prepare('INSERT INTO staff_access VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET provider=excluded.provider').run(user.id,provider);
 console.log('Staff access provisioned for the selected service workspace.');
} finally {store.close();}
