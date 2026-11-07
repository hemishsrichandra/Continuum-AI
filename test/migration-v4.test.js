import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/providers.js';

test('populated v3 migration preserves identities, sessions, connectors, attempts and original knowledge domains',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'continuum-v3-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'legacy.sqlite'),db=new Database(file);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old');
    CREATE TABLE companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,join_hash TEXT UNIQUE,created_at INTEGER NOT NULL);
    INSERT INTO companies VALUES('legacy','Legacy company',NULL,1);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,provider TEXT NOT NULL,email_verified INTEGER NOT NULL,created_at INTEGER NOT NULL,company_id TEXT REFERENCES companies(id),role TEXT NOT NULL);
    INSERT INTO accounts VALUES('stable-id','existing@example.test','Existing','unchanged password hash','repair',1,1,'legacy','staff');
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT,demo_profile TEXT,csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES('session-hash','stable-id',NULL,'csrf',9999999999999,1,1);
    CREATE TABLE records(collection TEXT NOT NULL,record_key TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(collection,record_key));
    CREATE TABLE external_customers(account_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,external_id TEXT NOT NULL,UNIQUE(company_id,external_id));
    INSERT INTO external_customers VALUES('stable-id','legacy','external-original');
    CREATE TABLE resolution_uses(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,provider TEXT NOT NULL,customer_id TEXT NOT NULL,scope TEXT NOT NULL,ticket_id TEXT NOT NULL,resolution_id TEXT NOT NULL,exchange_id TEXT NOT NULL,environment TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',note TEXT,handoff_id TEXT,created_at TEXT NOT NULL,feedback_at TEXT,UNIQUE(company_id,provider,customer_id,ticket_id,resolution_id));
    INSERT INTO resolution_uses VALUES('use-1','legacy','repair','stable-id','legacy:repair:stable-id','SR-1','resolution-1','exchange-1','{}','failed',NULL,'case-1','2026-01-01','2026-01-02');
  `);
  const rows={
    repair:{ticket_id:'SR-1',companyId:'legacy',customer_id:'stable-id',device:'Model X',issue:'Display flicker',status:'Reopened'},
    it:{id:'IT-1',companyId:'legacy',user_id:'stable-id',problem:'VPN',state:'Open'},
    resolutions:{id:'resolution-1',companyId:'legacy',provider:'repair',status:'published',memoryId:'memory-1',environment:'Model X',solution:'Verified steps'},
    memories:{id:'memory-1',scope:'knowledge:legacy:repair',ticketId:'knowledge',kind:'verified_resolution',resolutionId:'resolution-1',text:'Reviewed resolution',syncedTo:'https://old.example/bank',createdAt:'2026-01-01'},
    handoffs:{id:'case-1',companyId:'legacy',provider:'repair',scope:'legacy:repair:stable-id',customerId:'stable-id',ticketId:'SR-1',status:'Queued'},
    conversations:{id:'exchange-1',scope:'legacy:repair:stable-id',ticketId:'SR-1',message:'private',response:{reply:'original conversation'}},
    audit:{id:'audit-original',scope:'legacy:repair:stable-id',kind:'original'},
  };
  for(const [collection,row] of Object.entries(rows)) db.prepare('INSERT INTO records VALUES(?,?,0,?)').run(collection,collection,JSON.stringify(row));
  db.close();
  let store=new Store(file);
  const account=store.db.prepare('SELECT * FROM accounts').get();assert.equal(account.password_hash,'unchanged password hash');assert.equal(account.id,'stable-id');
  assert.equal(store.db.prepare('SELECT role FROM company_memberships').get().role,'staff');
  assert.equal(store.db.prepare('SELECT active_chatbot_id FROM sessions').get().active_chatbot_id,'legacy:repair');
  assert.equal(store.db.prepare('SELECT external_id FROM external_customers').get().external_id,'external-original');
  assert.equal(store.data.repair[0].chatbotId,'legacy:repair');assert.equal(store.data.it[0].chatbotId,'legacy:it');
  assert.equal(store.data.resolutions[0].chatbotId,'legacy:repair');
  assert.equal(store.data.memories[0].scope,'knowledge:legacy:chatbot:legacy:repair');
  assert.equal(store.data.memories[0].syncedTo,undefined);assert.equal(store.data.memories[0].syncPending,true);
  assert.equal(store.data.memories[0].previousSyncedTo,'https://old.example/bank');
  assert.equal(store.data.conversations[0].message,'private');assert.equal(store.data.audit[0].id,'audit-original');
  assert.deepEqual(store.db.prepare('SELECT source,outcome FROM troubleshooting_attempts ORDER BY source').all(),[{source:'learned',outcome:'failed'},{source:'standard',outcome:'skipped'}]);
  assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
  const data=JSON.stringify(store.data);store.close();store=new Store(file);
  assert.equal(JSON.stringify(store.data),data);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM company_memberships').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM troubleshooting_attempts').get().n,2);store.close();
});
