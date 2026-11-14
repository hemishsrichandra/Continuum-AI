// Non-destructive, resumable preparation of a labelled synthetic company through the real local API.
// Existing companies, passwords and records are never reset. Never run against a public deployment.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const base = new URL(arg('--base') || 'http://localhost:3100');
if (process.env.NODE_ENV === 'production' || !['localhost','127.0.0.1','[::1]'].includes(base.hostname)) throw new Error('This synthetic seed is for a local development app only.');
const manifestPath = resolve(arg('--manifest') || 'data/hackathon-demo.json');
const database = resolve(arg('--database') || 'data/demo.sqlite');
const password = 'ContinuumDemo!2026';
const people = {
  owner:{name:'Avery Morgan · demo owner',email:'showcase-owner@example.test',companyName:'Continuum Solutions'},
  specialist:{name:'Sam Chen · demo specialist',email:'showcase-specialist@example.test'},
  alice:{name:'Alice Parker · demo customer',email:'showcase-alice@example.test'},
  bob:{name:'Bob Rivera · demo customer',email:'showcase-bob@example.test'},
  otherOwner:{name:'Jordan Lee · tenant B owner',email:'showcase-other-owner@example.test',companyName:'Separate Tenant (synthetic)'},
};
let saved = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath,'utf8')) : {synthetic:true,base:base.origin,accounts:people,tickets:{},sources:{},checks:[],stages:{}};
if (saved.base !== base.origin) throw new Error('Use a separate manifest when changing the app origin.');
async function checkpoint() { await mkdir(resolve(manifestPath,'..'),{recursive:true}); await writeFile(manifestPath,JSON.stringify(saved,null,2),{mode:0o600}); }
function client() {
  let cookie='',csrf='',profile;
  return {
    get profile(){return profile;},
    async call(route,body,method=body===undefined?'GET':'POST',key) {
      const r=await fetch(new URL('/api/'+route,base),{method,headers:{'Content-Type':'application/json',...(cookie&&{Cookie:cookie}),...(csrf&&{'X-CSRF-Token':csrf}),...(key&&{'Idempotency-Key':key})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
      const data=await r.json(); if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
      if(data.csrfToken)csrf=data.csrfToken;if(data.profile)profile=data.profile;
      if(!r.ok)throw Object.assign(new Error(route+': '+r.status+' '+data.error),{status:r.status});
      return data;
    },
  };
}
async function account(which,registration) {
 const c=client(),p=people[which];
 try{await c.call('auth/login',{email:p.email,password});}
 catch(error){if(error.status!==401)throw error;await c.call('auth/register',{name:p.name,email:p.email,password,provider:'repair',...(typeof registration==='function'?await registration():registration)});}
 saved.accounts[which]={...p,id:c.profile.id,companyId:c.profile.companyId};await checkpoint();return c;
}
async function stage(name,work) {
 if(saved.stages[name])return;
 console.log('Preparing '+name+'…');await work();saved.stages[name]=true;await checkpoint();
}
const owner=await account('owner',{createCompany:true,companyName:people.owner.companyName});
const otherOwner=await account('otherOwner',{createCompany:true,companyName:people.otherOwner.companyName});
const companyId=owner.profile.companyId,repair=companyId+':repair',it=companyId+':it';
saved.companyId=companyId;saved.services={repair,it};
// Keep the product's own synthetic-data label visible. Only tag the two companies just provisioned.
if(existsSync(database)) {
 const db=new Database(database);
 try{for(const c of [owner,otherOwner])if(db.prepare('SELECT id FROM companies WHERE id=? AND name=?').get(c.profile.companyId,people[c===owner?'owner':'otherOwner'].companyName))db.prepare('INSERT OR IGNORE INTO sample_companies VALUES(?)').run(c.profile.companyId);}finally{db.close();}
}
const specialist=await account('specialist',async()=>{
 const invite=(await owner.call('company/invitations',{email:people.specialist.email,role:'staff',provider:'repair',sendEmail:false})).url;
 return {invitation:new URLSearchParams(new URL(invite).hash.slice(1)).get('invite')};
});
let code;
const customerRegistration=async()=>({companyCode:code||=(await owner.call('company/customer-code',{confirmed:true})).code});
const alice=await account('alice',customerRegistration),bob=await account('bob',customerRegistration);
await stage('team-access',async()=>{await owner.call('company/staff-access',{accountId:specialist.profile.id,chatbotIds:[repair],confirmed:true});});
const mapping={fields:{externalId:'id',title:'title',symptoms:'symptoms',steps:'steps',applicability:'environment',safety:'safety'},diagnostics:{}};
async function source(name,bot,csv,approve=true) {
 const existing=(await owner.call('company/data-sources')).sources.find(s=>s.name===name && s.chatbotId===bot);
 const s=existing||(await owner.call('company/data-sources',{confirmed:true,name,chatbotId:bot,sourceType:'csv_sync',declaredVerified:false,fieldMapping:mapping,connection:{csv}})).source;
 await owner.call(`company/data-sources/${s.id}/preview`,{});
 await owner.call(`company/data-sources/${s.id}/sync`,{confirmed:true});
 await owner.call('auth/workspace',{companyId,chatbotId:bot});
 const pool=(await owner.call('operator')).passports.filter(p=>p.sourceId===s.id);
 if(approve)for(const r of pool.filter(p=>p.status==='flagged_for_review'))await owner.call('operator/review-resolution',{id:r.id,decision:'keep',note:'Synthetic training fixture: reviewed steps, environment, safety and privacy.',confirmed:true});
 saved.sources[name]={id:s.id,chatbotId:bot,records:pool.map(p=>({id:p.id,title:p.title}))};
 return pool;
}
await stage('reviewed-imports',async()=>{
 const csv=await readFile(new URL('../examples/external-chatbot/synthetic-knowledge.csv',import.meta.url),'utf8');
 await source('Synthetic display knowledge — CSV import',repair,csv);
});
await stage('pending-review',async()=>{
 await source('Synthetic knowledge awaiting review',repair,'id,title,symptoms,steps,environment,safety\nPENDING-1,Printer paper alignment,Printer pulls two pages at once,Synthetic training only: align the paper guides and reload one small paper stack.,Model P firmware 3,None identified\n',false);
});
await stage('IT-import',async()=>{
 await source('Synthetic IT support knowledge',it,'id,title,symptoms,steps,environment,safety\nIT-1,VPN disconnects after sign-in,VPN connection drops after sign-in,Synthetic training only: choose the company training VPN profile and reconnect once.,Windows 11,None identified\n');
 await owner.call('auth/workspace',{companyId,chatbotId:repair});
});
async function request(c,label,title,issue,bot=repair) {
 await c.call('auth/workspace',{companyId,chatbotId:bot});
 const workspace=await c.call('workspace');
 let t=workspace.tickets.find(t=>t.title===title);
 if(!t){const made=await c.call('request',{title,issueDesc:issue,confirmed:true},'POST','showcase-request-'+label);t={id:made.ticketId};}
 saved.tickets[label]={...saved.tickets[label],id:t.id,title,issue,chatbotId:bot,account:c===alice?'alice':'bob'};await checkpoint();return t.id;
}
async function handoff(c,id,summary) {return c.call('handoff',{ticketId:id,summary,confirmed:true},'POST','showcase-handoff-'+id);}
async function caseBy(id) {return (await specialist.call('operator')).cases.find(h=>h.ticketId===id);}
async function propose(c,label,title,issue,fix,{accept=false}={}) {
 const id=await request(c,label,title,issue);
 const history=(await c.call('conversation?ticketId='+id)).messages;
 if(!history.length)await c.call('chat',{ticketId:id,message:issue});
 let h=await caseBy(id);
 if(!h){await handoff(c,id,issue);h=await caseBy(id);}
 if(!h.assignedTo){await specialist.call('operator/assign',{handoffId:h.id,assignedTo:specialist.profile.id,revision:h.revision,confirmed:true});h=await caseBy(id);}
 if(!h.resolutionId && !['Awaiting confirmation','Resolved'].includes(h.status)) {
  const proposal=await specialist.call('operator/resolve',{handoffId:h.id,revision:h.revision,title:fix.title,environment:fix.environment,solution:fix.steps,safety:'None identified',safetyReviewed:true,reviewedForPrivacy:true,confirmed:true},'POST','showcase-proposal-'+label);
  saved.tickets[label].proposalId=proposal.id;await checkpoint();
 }
 if(accept && saved.tickets[label].proposalId)await c.call('resolutions/confirm',{id:saved.tickets[label].proposalId,accepted:true,confirmed:true});
 return id;
}
const cameraIssue='The camera image freezes after opening video calls on Model C firmware 2.';
await stage('customer-confirmed-learning',async()=>{
 await propose(alice,'camera-origin','Camera freezes in video calls',cameraIssue,{title:'Camera freezes after video call starts',environment:'Model C firmware 2',steps:'Synthetic training only: open the Camera settings, turn off background effects and restart the video app.'},{accept:true});
});
await stage('successful-reuse',async()=>{
 const id=await request(bob,'camera-reuse','Camera freeze — repeat customer',cameraIssue);
 const result=await bob.call('chat',{ticketId:id,message:cameraIssue});
 let attempt=result.attempt;
 if(result.choices?.length) {await bob.call('troubleshooting/choose',{ticketId:id,resolutionId:result.choices[0].id,confirmed:true});attempt=(await bob.call('conversation?ticketId='+id)).messages.at(-1).response.attempt;}
 if(!attempt || attempt.source!=='learned')throw new Error('The seeded camera fix did not produce a learned attempt.');
 await bob.call('troubleshooting/outcome',{attemptId:attempt.id,worked:true,confirmed:true});
 saved.checks.push('Actual learned reuse chosen and customer-confirmed, without invented metrics.');
});
await stage('pending-specialist-confirmation',async()=>{
 await propose(alice,'printer-confirm','Printer produces blank pages','The printer produces blank pages on Model P firmware 3.',{title:'Printer blank pages after setup',environment:'Model P firmware 3',steps:'Synthetic training only: open the printer setup assistant and select the standard paper profile, then print the test page.'});
});
await stage('active-cases-and-visits',async()=>{
 const issue='Wi-Fi disconnects every few minutes on Model R firmware 2.';
 const id=await request(alice,'wifi-active','Wi-Fi disconnects during calls',issue);
 const response=await alice.call('chat',{ticketId:id,message:issue});
 if(response.attempt?.source==='standard')await alice.call('troubleshooting/outcome',{attemptId:response.attempt.id,worked:false,confirmed:true});
 await handoff(alice,id,'Synthetic customer: standard reconnect did not help; Wi-Fi still drops during calls.');
 let h=await caseBy(id);if(!h.assignedTo){await specialist.call('operator/assign',{handoffId:h.id,assignedTo:specialist.profile.id,revision:h.revision,confirmed:true});h=await caseBy(id);}
 const eta=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 await specialist.call('operator/progress',{handoffId:h.id,revision:h.revision,status:'In progress',priority:'High',eta,note:'Synthetic investigation: checking the training network profile.',step:'Reconnect to the training Wi-Fi network',stepOutcome:'failed',confirmed:true});
 await alice.call('requirement',{ticketId:id,note:'Synthetic customer note: video calls are important; contact me by email after 3 PM.',confirmed:true});
 const slots=await alice.call('slots?ticketId='+id);
 if(slots.slots?.length){const slot=slots.slots[0];const datetime=slot.id||slot.datetime||`${slot.date}T${slot.time}:00+05:30`;const booked=await alice.call('book',{ticketId:id,datetime,confirmed:true},'POST','showcase-service-visit');saved.visit={...booked,datetime};}
});
await stage('ready-to-present-requests',async()=>{
 await request(alice,'display-live','Display flicker — try three suggestions','The display flickers after startup on Model X firmware 4.');
 await request(bob,'camera-live','Camera freeze — live retrieval',cameraIssue);
 const id=await request(bob,'usb-queue','USB port needs a specialist','A USB port disconnects accessories on Model U firmware 1.');
 await handoff(bob,id,'Synthetic queue example: USB accessories disconnect; specialist investigation requested.');
 await request(bob,'IT-live','VPN drops after sign-in','The VPN disconnects after sign-in on Windows 11.',it);
 await bob.call('auth/workspace',{companyId,chatbotId:repair});
});
await stage('separate-company',async()=>{
 const codeB=(await otherOwner.call('company/customer-code',{confirmed:true})).code;
 await bob.call('auth/join',{companyCode:codeB,provider:'repair'});
 await bob.call('auth/workspace',{companyId:otherOwner.profile.companyId,chatbotId:otherOwner.profile.chatbotId});
 await bob.call('request',{title:'Tenant B private router request',issueDesc:'Synthetic separate-company record: router loses power on Model T firmware 5.',confirmed:true},'POST','showcase-tenant-b-request');
 await bob.call('auth/workspace',{companyId,chatbotId:repair});
 saved.otherCompanyId=otherOwner.profile.companyId;
});
await owner.call('auth/workspace',{companyId,chatbotId:repair});
saved.preparedAt=new Date().toISOString();await checkpoint();
console.log('Prepared labelled synthetic accounts and real workflow history. Manifest: '+manifestPath);
console.log('Sign in at '+base.origin+'/desk. Fictional account details are documented in the walkthrough.');
