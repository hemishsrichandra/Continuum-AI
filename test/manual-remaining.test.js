import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../server/app.js';
import {invoke} from '../scripts/invoke.js';

const password='Synthetic remaining test passphrase 20261107';
function client(h){let cookie='',csrf='';return async(route,body,method)=>{const r=await invoke(h,route,{body,method,headers:{cookie,'x-csrf-token':csrf}});if(r.headers['Set-Cookie'])cookie=r.headers['Set-Cookie'].split(';')[0];if(r.data.csrfToken)csrf=r.data.csrfToken;return r;};}
async function setup(t){
 const h=createHandler({config:{}}); t.after(()=>h.close()); const owner=client(h);
 const registered=await owner('auth/register',{createCompany:true,companyName:'Remaining test company',name:'Owner',email:'owner@example.test',password,provider:'repair'});
 assert.equal(registered.status,201);
 const code=(await owner('company/customer-code',{confirmed:true})).data.code;
 return {h,owner,code,ownerId:registered.data.profile.id};
}
async function join(h,code,name,provider='repair'){
 const api=client(h); const r=await api('auth/register',{companyCode:code,name,email:name+'@example.test',password,provider});assert.equal(r.status,201);return api;
}

test('rotating a customer link rejects the old link while existing customer sessions remain valid',async t=>{
 const f=await setup(t);const a=await join(f.h,f.code,'customer-a');
 const next=(await f.owner('company/customer-code',{confirmed:true})).data.code;
 assert.notEqual(next,f.code);
 const rejected=await client(f.h)('auth/register',{companyCode:f.code,name:'Old link',email:'old@example.test',password,provider:'repair'});
 assert.equal(rejected.status,400);
 assert.equal((await a('workspace')).status,200);
 const b=await join(f.h,next,'customer-b');assert.equal((await b('workspace')).data.tickets.length,0);
});

test('IT workflow publishes and reuses confirmed IT knowledge while Standard requests remain excluded',async t=>{
 const f=await setup(t),a=await join(f.h,f.code,'it-a','it'),b=await join(f.h,f.code,'it-b','it');
 const repair=await join(f.h,f.code,'repair-customer');
 const invitationUrl=(await f.owner('company/invitations',{email:'it-staff@example.test',role:'staff',provider:'it'})).data.url;
 const invitation=new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('invite');
 const staff=client(f.h);const registered=await staff('auth/register',{invitation,name:'IT specialist',email:'it-staff@example.test',password});assert.equal(registered.status,201);
 const issue='AcmeVPN disconnects after sign-in on Windows 11 version 7.';
 const request=async(api,title)=>(await api('request',{title,issueDesc:issue,confirmed:true})).data.ticketId;
 const ticketA=await request(a,'IT VPN A'),ticketB=await request(b,'IT VPN B'),ticketRepair=await request(repair,'Standard VPN');
 assert.match(ticketA,/^IT-/);
 const handoff=(await a('handoff',{ticketId:ticketA,summary:issue,confirmed:true})).data;
 assert.equal((await f.owner('operator?provider=repair')).data.cases.length,0);
 assert.equal((await staff('operator?provider=repair')).status,403);
 assert.equal((await staff('operator/assign',{handoffId:handoff.id,assignedTo:registered.data.profile.id,revision:0,confirmed:true})).status,200);
 assert.equal((await staff('operator/progress',{handoffId:handoff.id,revision:1,status:'Awaiting customer',priority:'High',eta:'2026-12-20',note:'Synthetic IT investigation.',step:'QA reconnect attempted',stepOutcome:'failed',confirmed:true})).status,200);
 const solution='Synthetic IT fixture only: select the QA Training connection profile. Do not apply to real systems.';
 const proposal=await staff('operator/resolve',{handoffId:handoff.id,revision:2,title:'QA AcmeVPN disconnects',symptoms:'VPN disconnects after sign-in',environment:'Windows 11 version 7',solution,reviewedForPrivacy:true,confirmed:true});assert.equal(proposal.status,201);
 assert.equal((await b('chat',{ticketId:ticketB,message:issue})).data.trace.learnedResolutions,0);
 assert.equal((await a('resolutions/confirm',{id:proposal.data.id,accepted:true,confirmed:true})).status,200);
 const answer=(await b('chat',{ticketId:ticketB,message:'The VPN keeps disconnecting after I log in.'})).data;
 assert.equal(answer.trace.learnedResolutions,1);assert.ok(answer.reply.includes(solution));
 assert.equal((await b('chat',{ticketId:ticketB,message:issue,memory:false,retain:false})).data.trace.learnedResolutions,0);
 assert.equal((await repair('chat',{ticketId:ticketRepair,message:issue})).data.trace.learnedResolutions,0);
 assert.equal((await a('status?ticketId='+ticketA)).data.status,'Resolved');
 assert.equal((await f.owner('operator?provider=it')).data.resolutions[0].status,'published');
});

test('revoking a specialist awaiting confirmation preserves the proposal, releases assignment and permits customer confirmation',async t=>{
 const f=await setup(t),a=await join(f.h,f.code,'customer-a');
 const url=(await f.owner('company/invitations',{email:'staff@example.test',role:'staff',provider:'repair'})).data.url;
 const invitation=new URLSearchParams(new URL(url).hash.slice(1)).get('invite');const staff=client(f.h);
 const registered=await staff('auth/register',{invitation,name:'Specialist',email:'staff@example.test',password});assert.equal(registered.status,201);
 const ticket=(await a('request',{title:'Display',issueDesc:'Synthetic display issue',confirmed:true})).data.ticketId;
 const handoff=(await a('handoff',{ticketId:ticket,summary:'Synthetic QA only',confirmed:true})).data;
 await staff('operator/assign',{handoffId:handoff.id,assignedTo:registered.data.profile.id,revision:0,confirmed:true});
 const r=await staff('operator/resolve',{handoffId:handoff.id,revision:1,title:'Synthetic display',symptoms:'Display flicker',environment:'Model X firmware 4',solution:'Synthetic fixture only.',reviewedForPrivacy:true,confirmed:true});assert.equal(r.status,201);
 assert.equal((await f.owner('company/revoke-staff',{id:registered.data.profile.id,confirmed:true})).status,200);
 assert.equal((await staff('operator')).status,401);
 assert.equal((await staff('auth/login',{email:'staff@example.test',password})).data.profile.role,'customer');
 assert.equal((await staff('operator')).status,403);
 const h=(await f.owner('operator')).data.cases.find(x=>x.id===handoff.id);
 assert.equal(h.assignedTo,null);assert.equal(h.status,'Awaiting confirmation');
 assert.equal((await a('status?ticketId='+ticket)).data.status,'Awaiting confirmation');
 assert.equal((await a('resolutions/confirm',{id:r.data.id,accepted:true,confirmed:true})).status,200);
});
