import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { world, FOUR, ISSUE } from './_helpers.js';
import { invoke } from '../scripts/invoke.js';
import { createExampleServer } from '../examples/external-chatbot/server.js';

async function raw(handler, path, { method = 'GET', headers = {}, body = '' } = {}) {
  let status, responseHeaders, text;
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {method, url:path, headers, socket:{remoteAddress:'127.0.0.1'}});
  const res = {get headersSent(){return status !== undefined;},writeHead(s,h){status=s;responseHeaders=h;},end(v){text=v;}};
  await handler(req,res); return {status,headers:responseHeaders,text};
}
async function keyFor(w, ids, client = w.owner, chatbotId = w.botOf(w.company)) {
  const response = await raw(w.h, '/api/company/integration-keys/manage', {method:'POST',headers:{...client.headers,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams([['csrf',client.headers['x-csrf-token']],['action','create'],['name','Synthetic external bot'],['chatbotId',chatbotId],['confirmed','yes'],...ids.map(id=>['memoryIds',id])]).toString()});
  if (response.status !== 201) return response;
  return {...response,key:response.text.match(/<pre>(ctm_[\w-]+)<\/pre>/)?.[1]};
}
async function imported(w) {
  const mapping = {fields:{externalId:'id',title:'title',symptoms:'symptoms',steps:'steps',applicability:'environment',safety:'safety'},diagnostics:{}};
  const csv = ['id,title,symptoms,steps,environment,safety',...FOUR.slice(0,3).map(([title,symptoms,steps],i)=>`${i},${title},${symptoms},${steps},Model X firmware 4,None identified`)].join('\n');
  const source = await w.owner.api('company/data-sources',{confirmed:true,sourceType:'csv_sync',chatbotId:w.botOf(w.company),name:'Synthetic external fixture',fieldMapping:mapping,connection:{csv},declaredVerified:false});
  assert.equal(source.status,201,JSON.stringify(source.data));
  const preview = await w.owner.api(`company/data-sources/${source.data.source.id}/preview`,{});
  assert.equal(preview.data.valid,3);
  assert.equal((await w.owner.api(`company/data-sources/${source.data.source.id}/sync`,{confirmed:true})).status,200);
  const rows = w.db().prepare('SELECT * FROM memory_pool WHERE source_id=?').all(source.data.source.id);
  for (const row of rows) {
    assert.equal(row.status,'flagged_for_review');
    const review = await w.owner.api('operator/review-resolution',{id:row.id,decision:'keep',note:'Synthetic fixture: checked privacy, compatibility, safety and steps.',confirmed:true});
    assert.equal(review.status,200,JSON.stringify(review.data));
  }
  await w.h.vectorIndex.drain();
  return rows;
}
const ask = (w,key,body = {}) => invoke(w.h,'v1/external/suggestions',{token:key,body:{question:ISSUE,conversationId:'synthetic-1',...body}});

test('real import → review → index → credential → retrieval previews, isolation and revocation', async t => {
  const w = await world(t);
  const rows = await imported(w);
  const created = await keyFor(w,rows.map(r=>r.id));
  assert.equal(created.status,201,created.text); assert.ok(created.key);
  assert.match(created.headers['Content-Security-Policy'],/default-src 'none'/);
  const listed = await w.owner.api('company/integration-keys');
  assert.equal(listed.data.credentials.length,1); assert.ok(!JSON.stringify(listed).includes(created.key));
  const stored = w.db().prepare('SELECT * FROM external_chat_credentials').get();
  assert.equal(stored.key_hash.length,64); assert.ok(!JSON.stringify(stored).includes(created.key));
  const three = await ask(w,created.key);
  assert.equal(three.status,200,JSON.stringify(three.data));
  assert.equal(three.data.status,'suggestions'); assert.equal(three.data.suggestions.length,3);
  assert.equal(new Set(three.data.suggestions.map(s=>s.steps.join())).size,3);
  assert.ok(three.data.suggestions.every(s=>s.provenance.reviewed && s.unconfirmedEvidence));
  assert.equal(three.data.preview,true);
  assert.equal(w.db().prepare('SELECT count(*) n FROM troubleshooting_attempts').get().n,0);
  assert.equal(w.db().prepare('SELECT count(*) n FROM resolution_uses').get().n,0);
  assert.equal(w.db().prepare('SELECT sum(reuse_success_count + reuse_failure_count) n FROM memory_pool').get().n,0);
  const onlyOne = await keyFor(w,[rows[0].id]);
  assert.equal((await ask(w,onlyOne.key)).data.suggestions.length,1);
  const noMatch = await ask(w,created.key,{question:'The satellite antenna has a broken mast.'});
  assert.equal(noMatch.data.status,'no_match'); assert.equal(noMatch.data.suggestions.length,0);
  assert.equal((await ask(w,created.key,{question:'Display flickers after startup on Model Z firmware 9.'})).data.suggestions.length,0);
  const clarify = await ask(w,created.key,{question:'The display flickers after startup.'});
  assert.equal(clarify.data.status,'clarification_required'); assert.ok(clarify.data.clarification.length);
  assert.equal((await ask(w,created.key,{question:ISSUE+' The battery is swollen and smoking.'})).data.suggestions.length,0);
  assert.equal((await ask(w,created.key,{question:'The display flickers after startup.',environment:{environment:'Model X firmware 4'}})).data.suggestions.length,3);
  const ref = three.data.conversationRef;
  assert.equal((await ask(w,created.key)).data.conversationRef,ref);
  assert.notEqual((await ask(w,onlyOne.key)).data.conversationRef,ref);
  assert.notEqual((await ask(w,created.key,{conversationId:'synthetic-2'})).data.conversationRef,ref);
  // There is no saved environment even within a conversation; never borrowed from another conversation/key.
  assert.equal((await ask(w,created.key,{question:'The display flickers after startup.'})).data.status,'clarification_required');
  assert.equal((await ask(w,created.key,{companyId:w.companyB})).status,400);
  assert.equal((await ask(w,created.key,{customerId:'forged-customer'})).status,400);
  assert.equal((await keyFor(w,[rows[0].id],w.other,w.botOf(w.companyB))).status,400);
  assert.equal((await keyFor(w,[rows[0].id],w.owner,w.botOf(w.company,'it'))).status,400);
  const otherPlaybook = w.db().prepare("SELECT id FROM memory_pool WHERE company_id=? AND chatbot_id=? AND origin_type='standard_playbook' LIMIT 1").get(w.companyB,w.botOf(w.companyB));
  const otherKey = await keyFor(w,[otherPlaybook.id],w.other,w.botOf(w.companyB));
  assert.equal((await ask(w,otherKey.key)).data.suggestions.length,0);
  const itPlaybook = w.db().prepare("SELECT id FROM memory_pool WHERE company_id=? AND chatbot_id=? AND origin_type='standard_playbook' LIMIT 1").get(w.company,w.botOf(w.company,'it'));
  const itKey = await keyFor(w,[itPlaybook.id],w.owner,w.botOf(w.company,'it'));
  assert.equal((await ask(w,itKey.key)).data.suggestions.length,0);
  assert.equal((await ask(w,'ctm_'+'0'.repeat(16)+'_'+'a'.repeat(43))).status,401);
  assert.equal((await invoke(w.h,'v1/external/suggestions',{body:{question:ISSUE,conversationId:'1'}})).status,401);
  assert.equal((await w.other.api('company/integration-keys/'+stored.id,undefined,{})).status,404);
  assert.equal((await invoke(w.h,'company/integration-keys/'+stored.id,{method:'DELETE',headers:w.other.headers})).status,404);
  assert.equal((await invoke(w.h,'company/integration-keys/'+stored.id,{method:'DELETE',headers:w.owner.headers})).status,200);
  assert.equal((await ask(w,created.key)).status,401);
});

test('owner/CSRF boundary, review and personal-data exclusions, changed audience records, validation and rate limit', async t => {
  const w = await world(t);
  const rows = await imported(w);
  const created = await keyFor(w,[rows[0].id]);
  const customer = await w.customer('outsider');
  assert.equal((await keyFor(w,[rows[0].id],customer)).status,403);
  const staff = { ...w.owner, headers:{...w.owner.headers,'x-csrf-token':'wrong'} };
  // keyFor uses its header token in the form; the authenticated session still expects its original token.
  assert.equal((await keyFor(w,[rows[0].id],staff)).status,403);
  const personal = w.seed(w.company,{title:'Private personal fix',symptoms:'Display flicker',steps:'Private notes here.'});
  assert.equal((await keyFor(w,[personal.id])).status,400);
  w.db().prepare('UPDATE memory_pool SET locally_reviewed=0 WHERE id=?').run(rows[1].id);
  assert.equal((await keyFor(w,[rows[1].id])).status,400);
  const update = w.db().prepare('UPDATE memory_pool SET status=? WHERE id=?');
  update.run('flagged_for_review',rows[0].id);
  assert.equal((await ask(w,created.key)).data.suggestions.length,0);
  update.run('active',rows[0].id);
  w.db().prepare("UPDATE memory_pool SET source_status='withdrawn' WHERE id=?").run(rows[0].id);
  assert.equal((await ask(w,created.key)).data.suggestions.length,0);
  w.db().prepare("UPDATE memory_pool SET source_status='present',content_hash='changed' WHERE id=?").run(rows[0].id);
  assert.equal((await ask(w,created.key)).data.suggestions.length,0);
  assert.equal((await ask(w,created.key,{question:'x'.repeat(1401)})).status,400);
  assert.equal((await ask(w,created.key,{environment:{customer_id:'spoof'}})).status,400);
  assert.equal((await ask(w,created.key,{environment:{environment:'x'.repeat(9000)}})).status,413);
  let last; for (let i=0;i<31;i++) last = await ask(w,created.key);
  assert.equal(last.status,429); assert.ok(last.headers['Retry-After']);
});

test('separate company adapter keeps key server-side and displays actual API schema over HTTP', async t => {
  const w = await world(t); const rows = await imported(w); const created = await keyFor(w,rows.map(r=>r.id));
  const logs = []; const old = console.error; console.error = (...args) => logs.push(args.join(' ')); t.after(()=>{console.error=old;});
  const backend = createServer(w.h); backend.listen(0,'127.0.0.1'); await once(backend,'listening');
  t.after(()=>{backend.closeAllConnections();backend.close();});
  const server = createExampleServer({key:created.key,apiUrl:'http://127.0.0.1:'+backend.address().port});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>{server.closeAllConnections();server.close();});
  const url = 'http://127.0.0.1:'+server.address().port;
  for (const path of ['/','/chat.js']) {
    const response = await fetch(url+path); assert.equal(response.status,200); assert.ok(!(await response.text()).includes(created.key));
  }
  const response = await fetch(url+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:ISSUE,conversationId:'adapter-1'})});
  const data = await response.json(); assert.equal(response.status,200); assert.equal(data.suggestions.length,3);
  assert.ok(!JSON.stringify(data).includes(created.key)); assert.ok(!JSON.stringify(logs).includes(created.key));
});
