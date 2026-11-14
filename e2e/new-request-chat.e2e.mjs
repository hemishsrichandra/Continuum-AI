// Adding a problem starts the conversation once, using the existing authenticated chat and retry flow.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser,startApp,signUp,asUser} from './support.mjs';

const ISSUE='The display flickers after startup on Model X firmware 4.';
let app,browser,customer;
before(async()=>{
 app=await startApp({VECTOR_STORE:'sqlite',EMBEDDING_PROVIDER:'local'});browser=await launchBrowser();
 const owner=await signUp(app,{createCompany:true,companyName:'Synthetic automatic chat test',name:'Owner',email:'auto-owner@example.test'});
 const code=(await owner.call('company/customer-code',{confirmed:true})).data.code;
 customer=await signUp(app,{companyCode:code,name:'Customer',email:'auto-customer@example.test'});
 const source=await owner.call('company/data-sources',{confirmed:true,sourceType:'csv_sync',chatbotId:owner.profile.chatbotId,name:'Synthetic display fix',declaredVerified:true,fieldMapping:{fields:{externalId:'id',title:'title',symptoms:'symptoms',steps:'steps',applicability:'environment'},diagnostics:{}},connection:{csv:'id,title,symptoms,steps,environment\nF-1,Display flicker,Display flickers after startup,Disable adaptive refresh in Display settings and restart the laptop.,Model X firmware 4\n'}});
 assert.equal(source.status,201);assert.equal((await owner.call(`company/data-sources/${source.data.source.id}/sync`,{confirmed:true})).status,200);
});
after(async()=>{await browser?.close();await app?.stop();});

async function openDesk(){const view=await asUser(browser,app,customer);await view.page.goto(app.base+'/desk');await view.page.waitForSelector('[data-action=request]');return view;}
async function addProblem(page,title,issue,first=false){
 await page.locator(first?'[data-action=request]':'button[aria-label="Create a new request"]').click();
 await page.locator('#action-form [name=title]').fill(title);await page.locator('#action-form [name=issueDesc]').fill(issue);
 const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/request'&&r.request().method()==='POST');
 await page.locator('#action-form button[type=submit]').click();const response=await created;assert.equal(response.status(),201);return(await response.json()).ticketId;
}

test('first request automatically retrieves an answer once and reload does not send the description again',async()=>{
 const{page,context}=await openDesk();const calls=[];
 page.on('request',r=>{if(new URL(r.url()).pathname==='/api/chat'&&r.method()==='POST')calls.push(r.postDataJSON());});
 const id=await addProblem(page,'First display problem',ISSUE,true);
 await page.locator('.alt-choice').first().waitFor();
 assert.equal(calls.length,1);assert.equal(calls[0].ticketId,id);assert.equal(calls[0].message,ISSUE);
 assert.equal(await page.locator('.bubble.customer').count(),1);
 assert.match(await page.locator('.thread').innerText(),/suggestion that fits/);
 const saved=await customer.call('conversation?ticketId='+id);assert.equal(saved.data.messages.length,1);
 assert.equal(saved.data.messages[0].message,ISSUE);
 await page.reload();await page.locator('.alt-choice').first().waitFor();assert.equal(calls.length,1);
 await context.close();
});

test('the plus button sends the new problem to its own request and shows the standard first step',async()=>{
 const{page,context}=await openDesk();const issue='The Wi-Fi keeps disconnecting on Model R firmware 2.';
 const chat=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat'&&r.request().method()==='POST');
 const id=await addProblem(page,'Wi-Fi automatic first step',issue);
 const response=await chat;assert.equal(response.status(),200);const data=await response.json();assert.equal(data.workflow.stage,'standard_pending');
 await page.locator('[data-attempt][data-worked="false"]').waitFor();
 assert.equal(response.request().postDataJSON().ticketId,id);
 assert.match(await page.locator('.thread').innerText(),/airplane mode/);
 const saved=await customer.call('conversation?ticketId='+id);assert.equal(saved.data.messages.length,1);assert.equal(saved.data.messages[0].message,issue);
 await context.close();
});

test('a failed initial answer can be retried without creating another request or duplicating the conversation',async()=>{
 const{page,context}=await openDesk();const calls=[];let fail=true;
 await page.route('**/api/chat',async route=>{
  calls.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});
  if(fail){fail=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic temporary chat outage.'})});}else await route.continue();
 });
 const before=(await customer.call('workspace')).data.tickets.length;
 const id=await addProblem(page,'Retry automatic answer',ISSUE);
 await page.locator('[data-action=retry-chat]').waitFor();
 assert.equal((await customer.call('workspace')).data.tickets.length,before+1);
 await page.locator('[data-action=retry-chat]').click();await page.locator('.alt-choice').first().waitFor();
 assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.equal(calls[1].body.ticketId,id);
 assert.equal((await customer.call('workspace')).data.tickets.length,before+1);
 assert.equal((await customer.call('conversation?ticketId='+id)).data.messages.length,1);
 await context.close();
});
