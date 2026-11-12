import { randomUUID } from 'node:crypto';
import { botId, privateScope, getBot } from './chatbots.js';
import { fault, provider } from './providers.js';
import {tokens,compatibility,relevance} from './context.js';
import {failedResolutions} from './reuse.js';
import {signatureOf} from './passports.js';
import {passportView} from './memory-pool.js';
import {THRESHOLDS,compatibilityGate} from './scoring.js';
import {customerFacts} from './applicability.js';
import {customerAdvice} from './customer-advice.js';

const now = () => new Date().toISOString();
const hasTopic = (text, topics) => {
  const words=tokens(text);
  return topics.some(t=>String(text).toLowerCase().includes(t.toLowerCase()) ||
    (tokens(t).size>0 && [...tokens(t)].every(word=>words.has(word))));
};
// Customer-visible provenance without private customer details.
const LABELS={specialist_confirmed:"Learned from a customer-confirmed specialist resolution",auto_published_overdue:"Specialist fix · UNCONFIRMED BY CUSTOMER",company_db_sync:"Imported from your company's support knowledge base",standard_playbook:"Standard playbook"};
export const sourceInfo=(row,score)=>({id:row.id,origin:row.origin_type,label:LABELS[row.origin_type],version:row.version_number,customerConfirmed:Boolean(row.customer_confirmed),unconfirmed:row.origin_type==='auto_published_overdue'&&!row.customer_confirmed,title:row.title,...(score&&{score})});
const evidenceFor=(row,score)=>({id:row.id,resolutionId:row.id,kind:row.customer_confirmed?'verified_resolution':'company_memory',origin:row.origin_type,version:row.version_number,text:JSON.parse(row.steps_json).join(' '),
  ...(score&&{score}),passport:passportView(row,{internal:false})});
export function createTroubleshooting(store, learning, reuse, providerActions, {memoryPool, followThrough} = {}) {
  const sql = store.db;
  function authorize(p) {
    if(!p.demo && !sql.prepare("SELECT 1 FROM company_memberships WHERE company_id=? AND account_id=? AND role='customer' AND status='active'").get(p.companyId,p.id))
      throw fault(403,'Your customer membership is no longer active in this workspace.');
    if(!getBot(sql,p.companyId,botId(p)).active) throw fault(403,'This support service is inactive.');
  }
  const args = (p,t) => [p.companyId,botId(p),p.id,t.id];
  const attempts = (p,t) => sql.prepare('SELECT * FROM troubleshooting_attempts WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=? ORDER BY created_at').all(...args(p,t));
  const ev=(p,t,kind,detail={})=>followThrough?.log({companyId:p.companyId,chatbotId:botId(p),ticketId:t.id,customerId:p.id,kind,detail,actor:'customer'});
  function saveAttempt(p,t,source,fix,context,exchangeId,outcome='pending',useId=null,extra={}) {
    const sequence=extra.sequence||1;
    sql.prepare(`INSERT INTO troubleshooting_attempts(id,company_id,chatbot_id,customer_id,ticket_id,source,sequence,fix_id,memory_id,snapshot,context,score,outcome,exchange_id,use_id,created_at,outcome_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,chatbot_id,customer_id,ticket_id,source,sequence) DO NOTHING`)
      .run(randomUUID(),...args(p,t),source,sequence,fix.id,extra.memoryId||null,JSON.stringify(fix),JSON.stringify(context),extra.score?JSON.stringify(extra.score):null,outcome,exchangeId,useId,now(),outcome==='skipped'?now():null);
    return attempts(p,t).find(a=>a.source===source && a.sequence===sequence);
  }
  function human(p,t,reason) {
    const b = getBot(sql,p.companyId,botId(p));
    if(!b.allowedActions.includes('handoff')) return {unavailable:true,supportRoute:b.escalationRules.supportRoute};
    const db = provider(store,p);
    const existing = db.ticket(t.id).handoffs.find(h=>!['Resolved','Closed'].includes(h.status));
    if (existing) return {waiting:true,handoffId:existing.id};
    const result = sql.transaction(()=>{
      const h=db.commit('handoff',{summary:reason,context:{ticket:t,attempts:attempts(p,t)}},t.id);
      providerActions?.enqueue(p,'handoff',h.id,t.id,{summary:reason});
      return h;
    }).immediate();
    sql.prepare('UPDATE troubleshooting_attempts SET handoff_id=? WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').run(result.id,...args(p,t));
    // Specialists see which suggested fixes already failed for this customer.
    store.update(d=>{const h=d.handoffs.find(x=>x.id===result.id&&x.companyId===p.companyId);
      if(h){h.troubleshooting||=[];for(const a of attempts(p,t).filter(a=>a.source==='learned'&&a.outcome==='failed'))
        if(!h.troubleshooting.some(x=>x.attemptId===a.id)) h.troubleshooting.push({id:randomUUID(),attemptId:a.id,resolutionId:a.memory_id,step:JSON.parse(a.snapshot).steps,outcome:'failed',note:'The suggested fix did not resolve the issue.',authorId:p.id,createdAt:a.outcome_at||now()});}});
    ev(p,t,'escalated_to_specialist',{reason,handoffId:result.id,attempts:attempts(p,t).map(a=>({source:a.source,sequence:a.sequence,outcome:a.outcome}))});
    return {waiting:true,handoffId:result.id};
  }
  async function feedback(p,body) {
    if (body.confirmed !== true || typeof body.worked !== 'boolean') throw fault(400,'Confirm whether the fix worked.');
    const a = sql.prepare('SELECT * FROM troubleshooting_attempts WHERE id=? AND company_id=? AND chatbot_id=? AND customer_id=?').get(body.attemptId,p.companyId,botId(p),p.id);
    if (!a) throw fault(404,'Attempt not found in this workspace.');
    const target = body.worked?'succeeded':'failed';
    // Transaction prevents concurrent outcomes and includes reuse statistics/case creation.
    const result = sql.transaction(()=>{
      const current = sql.prepare('SELECT outcome FROM troubleshooting_attempts WHERE id=?').get(a.id);
      if (current.outcome !== 'pending') {
        if (current.outcome !== target) throw fault(409,'This outcome is already final.');
        return {success:true,outcome:target};
      }
      sql.prepare("UPDATE troubleshooting_attempts SET outcome=?,outcome_at=? WHERE id=? AND outcome='pending'").run(target,now(),a.id);
      const t = provider(store,p).ticket(a.ticket_id);
      if (body.worked) provider(store,p).commit('outcome',{outcome:'resolved',note:'Customer confirmed the troubleshooting fix worked.'},t.id);
      return {success:true,outcome:target,ticket:t};
    }).immediate();
    ev(p,{id:a.ticket_id},body.worked?'suggestion_worked':'suggestion_failed',{source:a.source,sequence:a.sequence});
    // Reuse feedback has a synchronous transaction before its optional remote invalidation.
    // Marking a learned attempt and recording reuse are completed together below in processFeedback.
    return result;
  }
  // Next eligible company-memory suggestion for this ticket (none once three were tried).
  async function nextSuggestion(p,t,context,message='') {
    const rows=attempts(p,t),learnedRows=rows.filter(a=>a.source==='learned');
    if(learnedRows.length>=THRESHOLDS.maxSuggestions) return {eligible:[],withheld:[],backend:'none'};
    const failedBefore=failedResolutions(store,p.companyId,p.provider,p.id,botId(p));
    const triedIds=new Set(learnedRows.map(a=>a.memory_id||a.fix_id));
    const triedSig=new Set(learnedRows.map(a=>signatureOf(JSON.parse(a.snapshot).steps||[])));
    const std=rows.find(a=>a.source==='standard');
    const stdFix=std?JSON.parse(std.snapshot):null;
    const stdSig=stdFix?.steps?[signatureOf([stdFix.steps])]:[];
    const query=[t.title,t.issue,message,...Object.values(context)].join('\n');
    return memoryPool.retrieve({companyId:p.companyId,chatbotId:botId(p),text:query,fields:context,
      excludeIds:new Set([...triedIds,...failedBefore.ids]),excludeSignatures:new Set([...triedSig,...failedBefore.signatures,...stdSig]),
      allowedOrigins:['specialist_confirmed','company_db_sync','auto_published_overdue']});
  }
  async function processFeedback(p,body) {
    authorize(p);
    const a = sql.prepare('SELECT * FROM troubleshooting_attempts WHERE id=? AND company_id=? AND chatbot_id=? AND customer_id=?').get(body.attemptId,p.companyId,botId(p),p.id);
    if (!a) throw fault(404,'Attempt not found in this workspace.');
    if (a.source === 'learned' && a.use_id) {
      if (body.confirmed !== true || typeof body.worked !== 'boolean') throw fault(400,'Confirm whether the fix worked.');
      const target = body.worked?'succeeded':'failed';
      // Reuse performs all local writes before yielding. Outer transaction makes both records atomic.
      let remote;
      sql.transaction(()=>{
        const current=sql.prepare('SELECT outcome FROM troubleshooting_attempts WHERE id=?').get(a.id);
        if (current.outcome !== 'pending' && current.outcome !== target) throw fault(409,'This outcome is already final.');
        sql.prepare("UPDATE troubleshooting_attempts SET outcome=?,outcome_at=? WHERE id=? AND outcome='pending'").run(target,now(),a.id);
        remote=reuse.feedback(p,{useId:a.use_id,worked:body.worked,confirmed:true,memory:body.memory,allowHandoff:false,note:body.note,safetyIncident:body.safetyIncident===true});
      }).immediate();
      const r=await remote;
      ev(p,{id:a.ticket_id},body.worked?'suggestion_worked':'suggestion_failed',{source:a.source,sequence:a.sequence,memoryId:a.memory_id});
      if(r.handoffId) sql.prepare('UPDATE troubleshooting_attempts SET handoff_id=? WHERE id=?').run(r.handoffId,a.id);
      if(!body.worked && getBot(sql,p.companyId,botId(p)).allowedActions.includes('handoff')) {
        // Nothing further to try: the case reaches the company queue now, even if the customer leaves.
        const t=provider(store,p).ticket(a.ticket_id);
        const prior=sql.prepare('SELECT context FROM troubleshooting_context WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').get(...args(p,t));
        const next=body.memory===false?{eligible:[]}:await nextSuggestion(p,t,prior?JSON.parse(prior.context):{});
        const open=t.handoffs?.find(h=>!['Resolved','Closed'].includes(h.status));
        if(!next.eligible.length && open) return {...r,handoffId:open.id};
        if(!next.eligible.length) {
          const h=human(p,t,'The suggested fixes did not resolve the issue.');
          store.update(d=>{const row=d[p.provider].find(x=>x.companyId===p.companyId&&x.chatbotId===botId(p)&&(x.ticket_id||x.id)===t.id);if(row){row[p.provider==='repair'?'status':'state']='Reopened';row.updatedAt=now();}});
          return {...r,handoffId:h.handoffId||r.handoffId};
        }
      }
      return r;
    }
    return feedback(p,body);
  }
  async function process(p,t,message,inputContext={},enabled=true,exchangeId=randomUUID(),preview=false) {
    authorize(p);
    const b=getBot(sql,p.companyId,botId(p));
    const response=(reply,extra={})=>({id:exchangeId,reply,model:'Support workflow',ticket:t,action:null,
      decision:{mode:'inform',action:null},evidence:[],retained:null,
      trace:{knowledge:enabled?'Not required':'Disabled',memory:enabled?'Operational workflow':'Disabled',recalled:0,learnedResolutions:0,elapsedMs:0},...extra});
    const escalated=h=>h.unavailable
      ? response('For human support, '+h.supportRoute,{workflow:{stage:'support_route'}})
      : response(preview?'A specialist handoff can be prepared.':'Your case has been submitted to the company support team.',{action:preview?{kind:'handoff',ticketId:t.id,summary:message}:null,workflow:{stage:preview?'handoff_prepared':'human',...h}});
    const record=(source,fix,context,outcome='pending',useId=null,extra={})=>preview?{id:'preview',source,sequence:extra.sequence||1,fix_id:fix.id,snapshot:JSON.stringify(fix),context:JSON.stringify(context),outcome}:saveAttempt(p,t,source,fix,context,exchangeId,outcome,useId,extra);
    const escalate=reason=>!b.allowedActions.includes('handoff')?{unavailable:true,supportRoute:b.escalationRules.supportRoute}:preview?{prepared:true}:human(p,t,reason);
    let rows=attempts(p,t);
    const active=t.handoffs?.find(h=>!['Resolved','Closed'].includes(h.status));
    if(active) return response('Your case is with the company support team. You can check its status and read specialist updates here.',{decision:{mode:'waiting',action:null,handoffId:active.id},workflow:{stage:'human',handoffId:active.id}});
    if(t.status==='Resolved') return response('Your request is resolved. Create a new request for another issue.',{workflow:{stage:'resolved'}});
    if(hasTopic(message+'\n'+t.issue,b.escalationRules.immediateTopics))
      return response('This issue needs immediate specialist attention. '+b.escalationRules.supportRoute,{action:b.allowedActions.includes('handoff')?{kind:'handoff',ticketId:t.id,summary:message}:null,workflow:{stage:'handoff_prepared'}});
    const pending=rows.find(a=>a.outcome==='pending');
    const worked=/^(?:yes[, ]+)?(?:it worked|that worked|the fix worked|problem (?:is )?(?:solved|resolved)|that fixed it)[.!\s]*$/i.test(message);
    const failed=/^(?:still need help|it (?:did not|didn't) work|that (?:did not|didn't) work|the fix failed|still not working)[.!\s]*$/i.test(message);
    if(pending && (worked||failed) && !preview) {
      await processFeedback(p,{attemptId:pending.id,worked,confirmed:true,memory:enabled});
      if(worked) return response('You confirmed that it worked. Your request is resolved.',{workflow:{stage:'resolved'}});
      t=provider(store,p).ticket(t.id);rows=attempts(p,t);
      const opened=t.handoffs?.find(h=>!['Resolved','Closed'].includes(h.status));
      if(opened) return response('That did not work. Your case has been submitted to the company support team.',{decision:{mode:'waiting',action:null,handoffId:opened.id},workflow:{stage:'human',handoffId:opened.id}});
    } else if(pending) {
      if(pending.source==='learned' && enabled) {
        authorize(p);
        const row=memoryPool.get(p.companyId,botId(p),pending.memory_id||pending.fix_id);
        // Latest facts must still be compatible with the pending fix; a conflict withholds the steps.
        const prior=sql.prepare('SELECT context FROM troubleshooting_context WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').get(...args(p,t));
        const pctx=prior?JSON.parse(prior.context):{};
        const text=[t.title,t.issue,message,...Object.values(pctx)].join('\n');
        const gate=row&&compatibilityGate({applicability:JSON.parse(row.applicability_json),safety:JSON.parse(row.safety_restrictions_json),facts:customerFacts(text,pctx),text,fields:pctx});
        if(row && row.status==='active' && gate.eligible && relevance(message,row.symptoms_text+' '+row.title)>=0.35) return response(customerAdvice(JSON.parse(row.steps_json).join(' ')),{attempt:pending,resolutionUse:reuse.current(privateScope(p),pending.use_id),
          decision:{mode:'recommend',action:null},evidence:[evidenceFor(row,pending.score&&JSON.parse(pending.score))],
          learnedSource:sourceInfo(row,pending.score&&JSON.parse(pending.score)),
          trace:{knowledge:'Company memory',memory:'Operational workflow',recalled:1,learnedResolutions:1,elapsedMs:0},workflow:{stage:'learned_pending',sequence:pending.sequence}});
      }
      // Questions, reactions and preferences never finalize an outcome.
      return response('A fix is awaiting your outcome. Choose “It worked”, “Still need help”, or request Human help.',{attempt:pending,workflow:{stage:pending.source+'_pending'}});
    }
    if(t.status==='Resolved' || rows.some(a=>a.outcome==='succeeded')) return response('Your request is resolved. Create a new request for another issue.',{workflow:{stage:'resolved'}});
    const previous=sql.prepare('SELECT context FROM troubleshooting_context WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').get(...args(p,t));
    const context=previous?JSON.parse(previous.context):{};
    if(inputContext && typeof inputContext==='object' && !Array.isArray(inputContext)) {
      for(const k of b.diagnosticSchema.map(f=>f.key)) if(typeof inputContext[k]==='string' && inputContext[k].trim() && inputContext[k].length<=1000) context[k]=inputContext[k].trim();
    }
    if(!context.environment && /\b(?:model|firmware|windows|macos|ubuntu|android|ios|version)\s+[\w.-]+/i.test(t.title+' '+t.issue)) context.environment=t.title+' '+t.issue;
    if(/\b(?:model|firmware|windows|macos|ubuntu|android|ios|version)\s+[\w.-]+/i.test(message)) context.environment=message;
    for(const k of b.diagnosticSchema.map(f=>f.key)) {
      const match=message.match(new RegExp('(?:^|\\n)'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':\\s*([^\\n]+)','i'));
      if(match) context[k]=match[1].slice(0,1000);
    }
    if(!preview) sql.prepare('INSERT INTO troubleshooting_context VALUES(?,?,?,?,?) ON CONFLICT(company_id,chatbot_id,customer_id,ticket_id) DO UPDATE SET context=excluded.context').run(...args(p,t),JSON.stringify(context));
    const query=[t.title,t.issue,message, ...Object.values(context)].join('\n');
    const missing=b.requiredContext.filter(k=>!context[k]);
    const unavailable=/\b(?:don.t know|do not know|not sure|no idea|(?:not able|unable|can.t|cannot)\s+(?:to\s+)?(?:confirm|find|identify|provide))\b/i.test(message);
    const related=[...tokens(message)].some(word=>tokens(t.title+' '+t.issue).has(word));
    if(!(worked||failed) && !(missing.length && unavailable) && (!hasTopic(t.issue+' '+message,b.supportedTopics) || (!hasTopic(message,b.supportedTopics) && !related && !/\b(?:continue|troubleshoot|environment|model|firmware|version)\b/i.test(message) && !Object.keys(inputContext||{}).length)))
      return response(`${b.name} handles ${b.supportedTopics.join(', ')}. ${b.escalationRules.supportRoute}`,{action:b.allowedActions.includes('handoff')?{kind:'handoff',ticketId:t.id,summary:message}:null,workflow:{stage:'unsupported'}});
    if(missing.length) {
      if(unavailable) return response('That is okay. A specialist can help identify your device and check the problem. '+(b.allowedActions.includes('handoff')?'I have prepared a handoff; review it to send your case.':b.escalationRules.supportRoute),{
        action:b.allowedActions.includes('handoff')?{kind:'handoff',ticketId:t.id,summary:t.issue+'\nThe customer could not provide: '+missing.map(k=>k==='environment'?'device model and operating-system version':(b.diagnosticSchema.find(f=>f.key===k)?.label||k).replaceAll('_',' ')).join(', ')}:null,
        workflow:{stage:b.allowedActions.includes('handoff')?'handoff_prepared':'support_route',missing}});
      const fieldOf=k=>b.diagnosticSchema.find(f=>f.key===k)||{key:k,label:k.replaceAll('_',' ')};
      const labels=missing.map(k=>fieldOf(k).label);
      const example=(fieldOf(missing[0]).help||'For example: Model X, Windows 11').replace(/^For example:\s*/i,'');
      return response('Before suggesting a fix, please tell me '+labels.join(', ')+'. For example: “'+example+'”. If you do not know, say “I don’t know” and I can help you contact a specialist.',{workflow:{stage:'context',missing,fields:missing.map(fieldOf)}});
    }
    const standard=rows.find(a=>a.source==='standard');
    if(!standard) {
      const candidates=b.playbooks.filter(f=>hasTopic(query,f.topics));
      const fix=candidates.find(f=>!f.environment || compatibility(f.environment,query).compatible);
      const unclear=!fix && candidates.find(f=>f.environment && compatibility(f.environment,query).missing.length && !compatibility(f.environment,query).conflicts.length);
      if(unclear) return response('Before suggesting the standard fix, please confirm this environment: '+unclear.environment,{workflow:{stage:'standard_context'}});
      const a=record('standard',fix||{id:'none',version:1,reason:'No applicable playbook'},context,fix?'pending':'skipped');
      if(fix) return response(fix.steps,{attempt:a,workflow:{stage:'standard_pending'}});
    }
    const learnedRows=rows.filter(a=>a.source==='learned');
    if(learnedRows.length>=THRESHOLDS.maxSuggestions) return escalated(escalate('Three company-memory suggestions were tried without resolving the issue.'));
    if(enabled) {
      const retrieved=await nextSuggestion(p,t,context,message);
      authorize(p);
      if(getBot(sql,p.companyId,botId(p)).revision!==b.revision) throw fault(409,'This service configuration changed. Ask again for current guidance.');
      const currentTicket=provider(store,p).ticket(t.id);
      if(currentTicket.handoffs?.some(h=>!['Resolved','Closed'].includes(h.status)))
        return response('Your case is now with the company support team.',{workflow:{stage:'human'}});
      if(currentTicket.status==='Resolved') return response('Your request is resolved.',{workflow:{stage:'resolved'}});
      const top=retrieved.eligible[0];
      if(top) {
        const row=top.row,score={...top.breakdown,backend:retrieved.backend,constraints:top.gate.reasons};
        const steps=JSON.parse(row.steps_json);
        const sequence=learnedRows.length+1;
        const result=response(customerAdvice(steps.join(' ')),{decision:{mode:'recommend',action:null},evidence:[evidenceFor(row,score)],
          learnedSource:sourceInfo(row,score),
          trace:{knowledge:'Company memory ('+retrieved.backend+')',memory:'Operational workflow',learnedResolutions:1,recalled:retrieved.eligible.length,elapsedMs:0}});
        return sql.transaction(()=>{
          authorize(p);
          const latest=provider(store,p).ticket(t.id);
          if(latest.status==='Resolved' || latest.handoffs.some(h=>!['Resolved','Closed'].includes(h.status)))
            return response('Your case has changed. Refresh to see its current state.',{workflow:{stage:'waiting'}});
          if(attempts(p,t).some(a=>a.outcome==='pending')) return response('A fix is already awaiting your outcome. Use the outcome controls on that fix.',{attempt:attempts(p,t).find(a=>a.outcome==='pending'),workflow:{stage:'learned_pending'}});
          const use=preview?null:reuse.recordMemory(p,t,row,exchangeId,now());
          const a=record('learned',{id:row.id,title:row.title,steps:steps.join(' '),origin:row.origin_type,version:row.version_number},context,'pending',use?.id,{sequence,memoryId:row.id,score});
          if(!preview) ev(p,t,'suggestion_offered',{source:'learned',sequence,memoryId:row.id,origin:row.origin_type,version:row.version_number,sFinal:score.S_final});
          return {...result,attempt:a,resolutionUse:use,workflow:{stage:'learned_pending',sequence}};
        }).immediate();
      }
      if(retrieved.withheld.length && !unavailable && !learnedRows.length)
        return response('Before suggesting a reviewed fix, please confirm: '+retrieved.withheld.flatMap(w=>w.missing).filter((v,i,all)=>all.indexOf(v)===i).slice(0,4).join('; '),{workflow:{stage:'learned_context'}});
    }
    const h=escalate(enabled?'No applicable reviewed fix after standard troubleshooting.':'Standard troubleshooting did not resolve the issue. AI memory is off.');
    return escalated(h);
  }
  return {process,feedback:processFeedback,attempts};
}
