import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHandler} from '../server/app.js';
import {invoke} from './invoke.js';

const directory=await mkdtemp(join(tmpdir(),'continuum-fictional-demo-'));
const file=join(directory,'demo.sqlite');
const password='fictional demo passphrase 2026';
const h=createHandler({file,config:{ENABLE_OUTBOX_WORKER:'false'}});
function client() {
  let cookie='',csrf='';
  return async (route,body)=>{
    const r=await invoke(h,route,{body,headers:{cookie,'x-csrf-token':csrf}});
    if(r.headers?.['Set-Cookie']) cookie=r.headers['Set-Cookie'].split(';')[0];
    if(r.data.csrfToken) csrf=r.data.csrfToken;
    assert.ok(r.status<400,route+': '+JSON.stringify(r.data));return r.data;
  };
}
try {
  const owner=client(),other=client(),one=client(),two=client();
  const a=await owner('auth/register',{name:'Alex Owner',email:'owner-a@example.test',password,createCompany:true,companyName:'Fictional Company A',provider:'repair'});
  const b=await other('auth/register',{name:'Blair Owner',email:'owner-b@example.test',password,createCompany:true,companyName:'Fictional Company B',provider:'repair'});
  const code=(await owner('company/customer-code',{confirmed:true})).code;
  for(const [api,name,email] of [[one,'Customer One','one@example.test'],[two,'Customer Two','two@example.test']]) await api('auth/register',{name,email,password,companyCode:code,provider:'repair'});
  const issue='Network offline on Model X firmware 4';
  const request=async api=>(await api('request',{title:'Model X network',issueDesc:issue,confirmed:true})).ticketId;
  const ask=(api,ticketId,message=issue)=>api('chat',{ticketId,message});
  const fail=(api,attempt)=>api('troubleshooting/outcome',{attemptId:attempt.id,worked:false,confirmed:true});
  const id1=await request(one),standard1=await ask(one,id1);
  assert.equal(standard1.attempt.source,'standard');await fail(one,standard1.attempt);
  const human=await ask(one,id1,'Continue troubleshooting');
  const caseId=human.workflow.handoffId;assert.ok(caseId);
  await owner('operator/assign',{handoffId:caseId,assignedTo:a.profile.id,revision:0,confirmed:true});
  const solution='Fictional demo only: select the verified Model X training network profile and reconnect.';
  const proposed=await owner('operator/resolve',{handoffId:caseId,revision:1,title:'Model X network offline',symptoms:'Network offline',environment:'Model X firmware 4',solution,reviewedForPrivacy:true,confirmed:true});
  await one('resolutions/confirm',{id:proposed.id,accepted:true,confirmed:true});
  console.log('PASS Customer 1: standard failed → company specialist → customer-confirmed published solution.');
  const id2=await request(two),standard2=await ask(two,id2);assert.equal(standard2.attempt.source,'standard');await fail(two,standard2.attempt);
  const learned=await ask(two,id2,'Continue troubleshooting');assert.equal(learned.attempt.source,'learned');assert.equal(learned.reply,'Fictional demo only: select the verified Model X training network profile and reconnect.');
  await two('troubleshooting/outcome',{attemptId:learned.attempt.id,worked:true,confirmed:true});
  console.log('PASS Customer 2: standard failed → compatible shared fix → confirmed reuse success.');
  const id3=await request(two),standard3=await ask(two,id3);await fail(two,standard3.attempt);
  const failedLearned=await ask(two,id3,'Continue troubleshooting');await fail(two,failedLearned.attempt);
  assert.ok((await owner('operator')).cases.some(c=>c.ticketId===id3));
  console.log('PASS Learned fix failure: one case in Company A queue; one ordinary failure does not lock the fix out.');
  await one('auth/workspace',{companyId:a.profile.companyId,chatbotId:a.profile.companyId+':it'});
  const itId=await request(one),itStandard=await ask(one,itId);await fail(one,itStandard.attempt);
  assert.equal((await ask(one,itId,'Continue troubleshooting')).trace.learnedResolutions,0);
  console.log('PASS Company A IT service cannot retrieve its repair service’s solution.');
  const bCode=(await other('company/customer-code',{confirmed:true})).code;
  await one('auth/join',{companyCode:bCode});await one('auth/workspace',{companyId:b.profile.companyId});
  const bId=await request(one),bStandard=await ask(one,bId);await fail(one,bStandard.attempt);
  assert.equal((await ask(one,bId,'Continue troubleshooting')).trace.learnedResolutions,0);
  await one('auth/workspace',{companyId:a.profile.companyId});
  const memberships=(await one('auth/workspaces')).memberships;assert.equal(memberships.length,2);
  console.log('PASS Customer 1 switches between two memberships; Company B cannot retrieve Company A knowledge.');
  console.log('Fictional accounts: owner-a@example.test, owner-b@example.test, one@example.test, two@example.test');
  console.log('Fictional password: '+password);
  h.close();
  if(process.argv.includes('--serve')) {
    const env={...process.env,DATABASE_FILE:file,APP_URL:'http://localhost:3211',FRONTEND_PORT:'3211',API_PORT:'0',NODE_ENV:'test',ENABLE_DEMO_MODE:'false',ENABLE_OUTBOX_WORKER:'false',REQUIRE_LIVE_INTEGRATIONS:'false',REQUIRE_EMAIL_VERIFICATION:'false',HINDSIGHT_BASE_URL:'',HINDSIGHT_API_KEY:'',OPENAI_API_KEY:'',RESEND_API_KEY:'',EMAIL_FROM:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',PROVIDER_ALLOWED_ORIGINS:''};
    console.log('Isolated browser demo: http://localhost:3211/desk');
    const child=spawn(process.execPath,['server/start.js'],{env,stdio:'inherit'});
    const code=await new Promise(resolve=>child.on('exit',resolve));if(code) process.exitCode=code;
  }
  if(process.argv.includes('--keep')) console.log('Preserved fictional database: '+file);
  else await rm(directory,{recursive:true,force:true});
} catch(error) {
  try{h.close();}catch{}
  console.error(error);process.exitCode=1;
  if(!process.argv.includes('--keep')) await rm(directory,{recursive:true,force:true});
}
