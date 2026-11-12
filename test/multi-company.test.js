import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHandler} from '../server/app.js';
import {invoke} from '../scripts/invoke.js';
import {getBot} from '../server/chatbots.js';

const password='fictional support demo passphrase 2026';
export function client(handler) {
  let cookie='',csrf='';
  return {async api(route,body,headers={}) {
    const r=await invoke(handler(),route,{body,headers:{cookie,'x-csrf-token':csrf,...headers}});
    if(r.headers?.['Set-Cookie']) cookie=r.headers['Set-Cookie'].split(';')[0];
    if(r.data.csrfToken) csrf=r.data.csrfToken;
    return r;
  }};
}
async function fixture(t,file,settings={}) {
  let h=createHandler({file,config:settings});t.after(()=>h.close());
  const owner=client(()=>h),a=client(()=>h),b=client(()=>h),other=client(()=>h);
  const registered=await owner.api('auth/register',{name:'Owner',email:'owner@example.test',password,createCompany:true,companyName:'Company A',provider:'repair'});
  assert.equal(registered.status,201,JSON.stringify(registered.data));
  const company=registered.data.profile.companyId,ownerId=registered.data.profile.id;
  const code=(await owner.api('company/customer-code',{confirmed:true})).data.code;
  for(const [c,name] of [[a,'one'],[b,'two']]) assert.equal((await c.api('auth/register',{name,email:name+'@example.test',password,companyCode:code,provider:'repair'})).status,201);
  const otherReg=await other.api('auth/register',{name:'Owner B',email:'other@example.test',password,createCompany:true,companyName:'Company B',provider:'repair'});
  const companyB=otherReg.data.profile.companyId;
  return {get h(){return h;},restart(){h.close();h=createHandler({file,config:{}});},owner,ownerId,a,b,other,company,companyB,code};
}
async function ticket(c,issue='Network offline on Model X firmware 4') {
  const r=await c.api('request',{title:'Model X device',issueDesc:issue,confirmed:true});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.ticketId;
}
const ask=(c,id,message='Network offline on Model X firmware 4',extra={})=>c.api('chat',{ticketId:id,message,...extra});
async function config(f,change={}) {
  const b=getBot(f.h.store.db,f.company,f.company+':repair');
  const r=await f.owner.api('company/chatbots',{...b,...change});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.chatbot;
}

test('one identity has independent roles, invitation joins, revocation and stale workspace protection',async t=>{
  const f=await fixture(t);
  const account=(await f.a.api('auth/session')).data.profile.id;
  const invite=(await f.other.api('company/invitations',{email:'one@example.test',role:'staff',provider:'it'})).data.url.split('invite=')[1];
  assert.equal((await f.b.api('auth/join',{invitation:invite})).status,400);
  assert.equal((await f.a.api('auth/join',{invitation:invite})).status,200);
  assert.equal((await f.a.api('auth/join',{invitation:invite})).status,400);
  assert.equal((await f.a.api('auth/join',{companyCode:f.code,role:'owner'})).status,200);
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM company_memberships WHERE account_id=?').get(account).n,2);
  assert.equal((await f.a.api('auth/workspace',{companyId:f.companyB})).data.profile.role,'staff');
  assert.equal((await f.a.api('auth/session')).data.profile.companyId,f.companyB);
  assert.equal((await f.a.api('company')).status,403);
  assert.equal((await f.a.api('operator')).status,200);
  assert.equal((await f.a.api('auth/workspace',{companyId:f.companyB,chatbotId:f.company+':repair'})).status,404);
  assert.equal((await f.a.api('auth/workspace',{companyId:'forged'})).status,403);
  await f.a.api('auth/workspace',{companyId:f.company});
  const id=await ticket(f.a);
  const proposal=await ask(f.a,id,'I want human help');
  assert.equal(proposal.data.action.kind,'handoff');
  await f.a.api('auth/workspace',{companyId:f.companyB});
  assert.equal((await f.a.api('operator',undefined,{'x-workspace':f.company+'|'+f.company+':repair'})).status,409);
  assert.equal((await f.a.api('status?ticketId='+id)).status,403); // staff cannot access personal request routes
  assert.equal((await f.other.api('company/revoke-membership',{id:account,confirmed:true})).status,200);
  assert.equal((await f.a.api('operator')).status,403);
  assert.equal((await f.a.api('auth/workspace',{companyId:f.company})).status,200);
  assert.equal((await f.a.api('status?ticketId='+id)).status,200);
  assert.equal((await f.a.api('auth/workspace',{companyId:f.companyB})).status,403);
  // Losing every membership revokes company access, while global authentication still permits a new invitation/join.
  const bId=(await f.b.api('auth/session')).data.profile.id;
  await f.owner.api('company/revoke-membership',{id:bId,confirmed:true});
  assert.equal((await f.b.api('workspace')).status,403);
  assert.equal((await f.b.api('auth/login',{email:'two@example.test',password})).status,200);
  const bCode=(await f.other.api('company/customer-code',{confirmed:true})).data.code;
  assert.equal((await f.b.api('auth/join',{companyCode:bCode})).status,200);
  assert.equal((await f.b.api('auth/workspace',{companyId:f.companyB})).status,200);
});

test('durable standard → confirmed shared fix → outcomes and company human queue',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'continuum-multi-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const f=await fixture(t,join(dir,'test.sqlite'));
  await config(f,{playbooks:[{id:'network-check',version:3,topics:['network','offline'],steps:'Check the network connection once.'}]});
  const firstId=await ticket(f.a);
  const first=(await ask(f.a,firstId)).data;
  assert.equal(first.attempt.source,'standard');assert.equal(first.trace.learnedResolutions,0);
  const repeat=(await ask(f.a,firstId,'Thanks!')).data;
  assert.equal(repeat.attempt.id,first.attempt.id);assert.equal(repeat.attempt.outcome,'pending');
  assert.equal((await f.a.api('feedback',{id:first.id,rating:5})).status,200);
  assert.equal((await ask(f.a,firstId,'Current status?')).data.trace.learnedResolutions,0);
  const failed=()=>f.a.api('troubleshooting/outcome',{attemptId:first.attempt.id,worked:false,confirmed:true});
  assert.equal((await failed()).status,200);assert.equal((await failed()).status,200);
  assert.equal((await f.a.api('troubleshooting/outcome',{attemptId:first.attempt.id,worked:true,confirmed:true})).status,409);
  f.restart();
  const escalated=(await ask(f.a,firstId,'Continue troubleshooting')).data;
  assert.equal(escalated.workflow.stage,'human');
  const again=(await ask(f.a,firstId)).data;assert.equal(again.workflow.handoffId,escalated.workflow.handoffId);
  const queue=(await f.owner.api('operator')).data;
  const handoff=queue.cases.find(h=>h.id===escalated.workflow.handoffId);
  assert.equal(handoff.attempts.length,1);assert.equal(handoff.attempts[0].outcome,'failed');
  assert.equal((await f.other.api('operator/assign',{handoffId:handoff.id,assignedTo:f.ownerId,revision:0,confirmed:true})).status,404);
  await f.owner.api('operator/assign',{handoffId:handoff.id,assignedTo:f.ownerId,revision:0,confirmed:true});
  const resolution=(await f.owner.api('operator/resolve',{handoffId:handoff.id,revision:1,title:'Model X network offline',symptoms:'Network offline',environment:'Model X firmware 4',solution:'Install verified network driver 4.2 and reconnect.',confirmed:true,reviewedForPrivacy:true})).data;
  assert.equal(resolution.status,'pending_confirmation');
  const secondId=await ticket(f.b);
  const standard=(await ask(f.b,secondId)).data;
  assert.equal(standard.attempt.source,'standard');
  assert.equal((await f.a.api('resolutions/confirm',{id:resolution.id,accepted:true,confirmed:true})).status,200);
  await f.b.api('troubleshooting/outcome',{attemptId:standard.attempt.id,worked:false,confirmed:true});
  const learned=(await ask(f.b,secondId,'Continue troubleshooting')).data;
  assert.equal(learned.attempt.source,'learned');assert.match(learned.reply,/driver 4.2/);
  assert.equal(learned.trace.learnedResolutions,1);
  assert.equal((await f.a.api('troubleshooting/outcome',{attemptId:learned.attempt.id,worked:true,confirmed:true})).status,404);
  const outcomes=await Promise.all([true,false].map(worked=>f.b.api('troubleshooting/outcome',{attemptId:learned.attempt.id,worked,confirmed:true})));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  assert.equal((await f.b.api('status?ticketId='+secondId)).data.status,'Resolved');
  const stats=(await f.owner.api('operator')).data.resolutions.find(r=>r.id===resolution.id).reuse;
  assert.equal(stats.succeeded,1);
  // A new issue for this account can reuse the resolution; failure reaches the same company's queue.
  const thirdId=await ticket(f.b);const st=(await ask(f.b,thirdId)).data;
  await f.b.api('troubleshooting/outcome',{attemptId:st.attempt.id,worked:false,confirmed:true});
  const failedLearned=(await ask(f.b,thirdId,'Continue troubleshooting')).data;
  const outcome=await f.b.api('troubleshooting/outcome',{attemptId:failedLearned.attempt.id,worked:false,confirmed:true});assert.equal(outcome.status,200);
  // With no further eligible suggestion, the failure reaches the company queue immediately.
  assert.ok(outcome.data.handoffId);
  const duplicate=await f.b.api('handoff',{ticketId:thirdId,summary:'Need human help',confirmed:true});assert.equal(duplicate.data.id,outcome.data.handoffId);
  // One ordinary failure no longer locks the fix out globally or flags it for review.
  const review=(await f.owner.api('operator')).data.resolutions.find(r=>r.id===resolution.id);assert.equal(review.reviewRequired,false);
  assert.equal(f.h.store.db.prepare("SELECT status FROM memory_pool WHERE id=?").get(resolution.id).status,'active');
  const fourthId=await ticket(f.b);const fourth=(await ask(f.b,fourthId)).data;
  await f.b.api('troubleshooting/outcome',{attemptId:fourth.attempt.id,worked:false,confirmed:true});
  assert.equal((await ask(f.b,fourthId,'Continue troubleshooting')).data.workflow.stage,'human');
  // Same adapter, separate chatbot: neither its queue nor its knowledge can access the first bot.
  const template=getBot(f.h.store.db,f.company,f.company+':repair');delete template.id;
  const unrelated=(await f.owner.api('company/chatbots',{...template,name:'Unrelated repair service'})).data.chatbot;
  assert.equal((await f.b.api('auth/workspace',{companyId:f.company,chatbotId:unrelated.id})).status,200);
  assert.equal((await f.b.api('status?ticketId='+secondId)).status,404);
  const unrelatedId=await ticket(f.b);const us=(await ask(f.b,unrelatedId)).data;
  await f.b.api('troubleshooting/outcome',{attemptId:us.attempt.id,worked:false,confirmed:true});
  assert.equal((await ask(f.b,unrelatedId,'Continue troubleshooting')).data.trace.learnedResolutions,0);
  const codeB=(await f.other.api('company/customer-code',{confirmed:true})).data.code;
  await f.b.api('auth/join',{companyCode:codeB});await f.b.api('auth/workspace',{companyId:f.companyB});
  const otherId=await ticket(f.b);const os=(await ask(f.b,otherId)).data;
  await f.b.api('troubleshooting/outcome',{attemptId:os.attempt.id,worked:false,confirmed:true});
  assert.equal((await ask(f.b,otherId,'Continue troubleshooting')).data.trace.learnedResolutions,0);
  assert.equal(f.h.store.db.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(f.h.store.db.pragma('foreign_key_check'),[]);
});

test('context, scope, standard success, immediate human help, allowed actions and memory off',async t=>{
  const f=await fixture(t);
  const id=await ticket(f.a,'Network offline');
  // Use a title without environment evidence.
  f.h.store.update(d=>{d.repair.find(r=>r.ticket_id===id).device='Device';});
  const missing=(await ask(f.a,id,'Network offline')).data;
  assert.equal(missing.workflow.stage,'context');
  assert.equal((await ask(f.a,id,'environment: Model X firmware 4')).data.attempt.source,'standard');
  const pending=f.h.store.db.prepare('SELECT id FROM troubleshooting_attempts WHERE ticket_id=?').get(id);
  const safety=(await ask(f.a,id,'The device is burning')).data;
  assert.equal(safety.workflow.stage,'handoff_prepared');
  await f.a.api('troubleshooting/outcome',{attemptId:pending.id,worked:true,confirmed:true,memory:false});
  assert.equal((await ask(f.a,id)).data.workflow.stage,'resolved');
  const immediateId=await ticket(f.b);
  const human=(await ask(f.b,immediateId,'Please get a human now')).data;assert.equal(human.action.kind,'handoff');
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM troubleshooting_attempts WHERE ticket_id=?').get(immediateId).n,0);
  assert.equal((await ask(f.b,immediateId,'Device smoking and burning')).data.workflow.stage,'handoff_prepared');
  const skippedId=await ticket(f.b,'Display flickers on Model X firmware 4');
  assert.equal((await ask(f.b,skippedId,'Display flickers on Model X firmware 4')).data.workflow.stage,'human');
  assert.equal(f.h.store.db.prepare("SELECT outcome FROM troubleshooting_attempts WHERE ticket_id=? AND source='standard'").get(skippedId).outcome,'skipped');
  const unsupportedId=await ticket(f.b,'Invoice address change');
  assert.equal((await ask(f.b,unsupportedId,'How do I change my invoice address?')).data.workflow.stage,'unsupported');
  const offId=await ticket(f.b);const off=(await ask(f.b,offId,undefined,{memory:false})).data;
  const before=f.h.store.data.memories.length;
  await f.b.api('troubleshooting/outcome',{attemptId:off.attempt.id,worked:false,confirmed:true,memory:false});
  const result=(await ask(f.b,offId,'Continue troubleshooting',{memory:false})).data;
  assert.equal(result.workflow.stage,'human');assert.equal(result.trace.learnedResolutions,0);
  assert.equal(f.h.store.data.memories.length,before);
  await config(f,{allowedActions:['handoff','outcome']});
  assert.equal((await f.a.api('request',{title:'Forged',issueDesc:'New request',confirmed:true})).status,403);
  assert.equal((await f.a.api('company/chatbots',{name:'forged'})).status,403);
  await config(f,{allowedActions:['request','outcome'],playbooks:[]});
  const routedId=await ticket(f.a),casesBefore=f.h.store.data.handoffs.length;
  const routed=(await ask(f.a,routedId)).data;
  assert.equal(routed.workflow.stage,'support_route');assert.doesNotMatch(routed.reply,/submitted/i);
  assert.equal(f.h.store.data.handoffs.length,casesBefore);
  assert.equal((await ask(f.a,routedId,'I need human help')).data.workflow.stage,'support_route');
});

test('mock gateway imports directory entries atomically and links verified memberships in two companies',async t=>{
  const f=await fixture(t,undefined,{PROVIDER_ALLOWED_ORIGINS:'https://mock.example'});
  const account=(await f.a.api('auth/session')).data.profile.id;
  let wrong=false;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer fictional-token');
    if(url.endsWith('/requests')) return Response.json([{id:'request-1',customerId:'external-1',title:'Model X device',issue:'Network offline',status:'Investigating'}]);
    return Response.json({id:'external-1',email:wrong?'wrong@example.test':'one@example.test',displayName:'Fictional One',internalCredential:'fictional-private-gateway-field'});
  });
  for(const owner of [f.owner,f.other]) assert.equal((await owner.api('company/connector',{baseUrl:'https://mock.example',apiToken:'fictional-token',confirmed:true})).status,200);
  const imported=await f.owner.api('company/connector/lookup-customer',{externalId:'external-1'});
  assert.equal(imported.status,200);assert.equal(imported.data.customer.internalCredential,undefined);
  assert.equal((await f.owner.api('company/connector/lookup-customer',{externalId:'external-1'})).status,200);
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM customer_directory').get().n,1);
  assert.equal((await f.owner.api('company/connector/customer',{accountId:account,externalId:'external-1'})).status,403);
  f.h.store.db.prepare('UPDATE accounts SET email_verified=1 WHERE id=?').run(account);
  assert.equal((await f.owner.api('company/connector/customer',{accountId:account,externalId:'external-1'})).status,200);
  assert.equal((await f.owner.api('company/connector/customer',{accountId:account,externalId:'external-1'})).status,200);
  const otherAccount=(await f.b.api('auth/session')).data.profile.id;
  f.h.store.db.prepare('UPDATE accounts SET email_verified=1 WHERE id=?').run(otherAccount);
  assert.equal((await f.owner.api('company/connector/customer',{accountId:otherAccount,externalId:'external-1'})).status,403);
  wrong=true;assert.equal((await f.owner.api('company/connector/lookup-customer',{externalId:'external-1'})).status,409);wrong=false;
  assert.equal(f.h.store.db.prepare('SELECT email FROM customer_directory').get().email,'one@example.test');
  const code=(await f.other.api('company/customer-code',{confirmed:true})).data.code;
  await f.a.api('auth/join',{companyCode:code});
  await f.other.api('company/connector/lookup-customer',{externalId:'external-1'});
  assert.equal((await f.other.api('company/connector/customer',{accountId:account,externalId:'external-1'})).status,200);
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM external_customers WHERE account_id=?').get(account).n,2);
  assert.equal((await f.a.api('connector/sync',{})).data.imported,1);
  assert.equal((await f.a.api('connector/sync',{})).data.imported,1);
  assert.equal((await f.a.api('workspace')).data.tickets.length,1);
  await f.a.api('auth/workspace',{companyId:f.companyB});
  assert.equal((await f.a.api('workspace')).data.tickets.length,0);
  assert.equal((await f.a.api('connector/sync',{})).data.imported,1);
  assert.equal((await f.a.api('workspace')).data.tickets.length,1);
  assert.equal(f.h.store.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,4);
});

test('memory-off specialist confirmation closes the case without publishing long-term knowledge',async t=>{
  const f=await fixture(t),id=await ticket(f.a);
  const handoff=(await f.a.api('handoff',{ticketId:id,summary:'Fictional issue',confirmed:true,memory:false})).data;
  await f.owner.api('operator/assign',{handoffId:handoff.id,assignedTo:f.ownerId,revision:0,confirmed:true});
  const r=(await f.owner.api('operator/resolve',{handoffId:handoff.id,revision:1,title:'Network offline',symptoms:'Network offline',environment:'Model X firmware 4',solution:'Fictional verified driver steps.',confirmed:true,reviewedForPrivacy:true})).data;
  const before=f.h.store.data.memories.length;
  const confirmed=await f.a.api('resolutions/confirm',{id:r.id,accepted:true,confirmed:true,memory:false});
  assert.equal(confirmed.status,200);assert.equal(confirmed.data.status,'confirmed_private');
  assert.equal(f.h.store.data.memories.length,before);
  assert.equal((await f.a.api('status?ticketId='+id)).data.status,'Resolved');
  assert.ok(!f.h.store.data.memories.some(m=>m.resolutionId===r.id));
  const secondId=await ticket(f.b),standard=(await ask(f.b,secondId)).data;
  await f.b.api('troubleshooting/outcome',{attemptId:standard.attempt.id,worked:false,confirmed:true});
  assert.equal((await ask(f.b,secondId,'Continue troubleshooting')).data.trace.learnedResolutions,0);
});

test('charging: unknown device details offer human help, and confirmed specialist steps reach another customer after the standard check',async t=>{
  const f=await fixture(t);
  const issue='The charging capacity of my laptop is reducing';
  const id=await ticket(f.a,issue);
  f.h.store.update(d=>{d.repair.find(r=>r.ticket_id===id).device='Charging problem';});
  const initial=(await ask(f.a,id,issue)).data;
  assert.equal(initial.workflow.stage,'context');assert.match(initial.reply,/device model/);
  for(const message of ['I am not able to confirm the environment',"I don't know"]) {
    const unknown=(await ask(f.a,id,message)).data;
    assert.equal(unknown.workflow.stage,'handoff_prepared');assert.equal(unknown.action.kind,'handoff');
    assert.match(unknown.reply,/specialist/i);assert.doesNotMatch(unknown.reply,/environment: …/);
  }
  const h=(await f.a.api('handoff',{ticketId:id,summary:'Charging issue; device details need specialist assistance.',confirmed:true})).data;
  await f.owner.api('operator/assign',{handoffId:h.id,assignedTo:f.ownerId,revision:0,confirmed:true});
  const solution='Fictional ChargeDemo test solution: select the specialist-provided training battery profile and test charging again.';
  const r=(await f.owner.api('operator/resolve',{handoffId:h.id,revision:1,title:'Laptop charging capacity reducing',symptoms:'Laptop charging capacity reducing',environment:'Model ChargeDemo version 1',solution,reviewedForPrivacy:true,confirmed:true})).data;
  const second=await ticket(f.b,issue+' on Model ChargeDemo version 1');
  f.h.store.update(d=>{d.repair.find(r=>r.ticket_id===second).device='ChargeDemo laptop';});
  const standard=(await ask(f.b,second,issue+' on Model ChargeDemo version 1')).data;
  assert.equal(standard.attempt.source,'standard');assert.equal(standard.attempt.fix_id,'charging-connection-check');assert.equal(standard.trace.learnedResolutions,0);
  assert.ok(!f.h.store.data.memories.some(m=>m.resolutionId===r.id));
  assert.equal((await f.a.api('resolutions/confirm',{id:r.id,accepted:true,confirmed:true})).status,200);
  assert.ok(f.h.store.data.memories.some(m=>m.resolutionId===r.id && m.kind==='verified_resolution'));
  assert.equal((await ask(f.b,second,issue)).data.attempt.source,'standard');
  await f.b.api('troubleshooting/outcome',{attemptId:standard.attempt.id,worked:false,confirmed:true});
  const learned=(await ask(f.b,second,'Continue troubleshooting')).data;
  assert.equal(learned.attempt.source,'learned');assert.equal(learned.reply,'Fictional ChargeDemo test solution: select the approved training battery profile and test charging again.');assert.equal(learned.trace.learnedResolutions,1);
  assert.ok(learned.evidence.some(e=>e.text.includes(solution)),'The original reviewed source remains available in evidence.');
  assert.equal(f.h.store.data.resolutions.find(x=>x.id===r.id).solution,solution,'Customer wording does not rewrite the approved source.');
  const history=(await f.b.api('conversation?ticketId='+second)).data.messages;
  assert.equal(history.at(-1).response.reply,learned.reply);
  assert.equal((await f.b.api('troubleshooting/outcome',{attemptId:learned.attempt.id,worked:true,confirmed:true})).status,200);
  assert.equal((await f.b.api('status?ticketId='+second)).data.status,'Resolved');
  assert.equal((await f.owner.api('operator')).data.resolutions.find(x=>x.id===r.id).reuse.succeeded,1);
});
