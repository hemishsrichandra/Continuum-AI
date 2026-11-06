import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.loadEnvFile('.env');
const run = randomUUID().slice(0,8);
const directory = await mkdtemp(join(tmpdir(),'continuum-live-'));
const config = {...process.env, APP_URL:'http://localhost:3100', NODE_ENV:'development', ENABLE_DEMO_MODE:'true', REQUIRE_EMAIL_VERIFICATION:'false', REQUIRE_LIVE_INTEGRATIONS:'true', ENABLE_OUTBOX_WORKER:'false', RESEND_API_KEY:'', EMAIL_FROM:'', GOOGLE_CLIENT_ID:'', GOOGLE_CLIENT_SECRET:'', HINDSIGHT_BANK_PREFIX:(process.env.HINDSIGHT_BANK_PREFIX || 'continuum')+'-verify-'+run};
const handler = createHandler({file:join(directory,'verification.sqlite'),config});
const report={run,bankPrefix:config.HINDSIGHT_BANK_PREFIX,syntheticData:true,checks:[]};
async function api(route,options){const r=await invoke(handler,route,options);if(r.status>=400)throw new Error(route+': '+r.status+' '+r.data.error);return r.data;}
const question='On a Model X laptop with display firmware 4, the display flickers after startup. How can I fix the flickering?';
try {
 const a=(await api('session',{body:{profileId:'alice',pin:config.DEMO_PIN||'246810'}})).token;
 const b=(await api('session',{body:{profileId:'bob',pin:config.DEMO_PIN||'246810'}})).token;
 const ticket=(await api('request',{token:b,body:{title:'Model X laptop display',issueDesc:question,confirmed:true,memory:false}})).ticketId;
 const chat=(memory=true)=>api('chat',{token:b,body:{ticketId:ticket,message:question,memory,retain:false}});
 const before=await chat();report.checks.push({step:'Before human resolution',...before});console.log('Baseline: '+before.model+' / '+before.trace.memory+' / '+before.trace.learnedResolutions+' learned resolutions');
 const handoff=await api('handoff',{token:a,body:{summary:'Model X firmware 4 display flickers after startup; specialist investigation requested.',confirmed:true,memory:false}});
 const registration=await invoke(handler,'auth/register',{body:{name:'Synthetic Verification Specialist',email:'verify-'+run+'@example.test',password:randomUUID()+randomUUID(),provider:'repair'}});
 const staff=registration.data; const cookie=registration.headers['Set-Cookie'].split(';')[0];
 handler.store.db.prepare('INSERT INTO staff_access VALUES(?,?)').run(staff.profile.id,'repair');
 const headers={cookie:handlerCookie(staff), 'x-csrf-token':staff.csrfToken};
 function handlerCookie(){return cookie;}

 const resolution=await api('operator/resolve',{headers,body:{handoffId:handoff.id,title:'Model X display flicker after startup',symptoms:'Display flickers after startup on Model X firmware 4',environment:'Model X laptop, display firmware 4',solution:'Disable Adaptive Refresh in Display Settings, then install verified display driver 4.2. Restart once after driver installation and confirm the flicker stops.',confirmed:true,reviewedForPrivacy:true}});
 report.resolution=resolution;console.log('Resolution publication: '+resolution.sync);
 const after=await chat();report.checks.push({step:'After human resolution',...after});console.log('After: '+after.model+' / '+after.trace.knowledge+' / '+after.trace.learnedResolutions+' learned resolutions');
 const off=await chat(false);report.checks.push({step:'Memory OFF',...off});
 const retired=await api('operator/retire',{headers,body:{id:resolution.id,confirmed:true}});report.retirement=retired;
 const final=await chat();report.checks.push({step:'After retirement',...final});
 report.passed=resolution.sync==='synced'&&before.trace.learnedResolutions===0&&after.trace.learnedResolutions>0&&after.trace.knowledge==='Hindsight'&&/adaptive refresh|4\.2/i.test(after.reply)&&off.trace.learnedResolutions===0&&final.trace.learnedResolutions===0;
 console.log('Live learning verification: '+(report.passed?'PASS':'FAIL'));
 if(!report.passed)process.exitCode=1;
} catch(error){report.error=error.message;report.passed=false;console.error(error.message);process.exitCode=1;}
finally {
 await writeFile('data/live-verification-'+run+'.json',JSON.stringify(report,null,2),{mode:0o600});
 handler.close();await rm(directory,{recursive:true,force:true});
 console.log('Report: data/live-verification-'+run+'.json');
}
