import { randomUUID } from 'node:crypto';
import { botId, privateScope, getBot } from './chatbots.js';
import { fault, provider } from './providers.js';
import {tokens,compatibility} from './context.js';
import {needsReview} from './reuse.js';
import {customerAdvice} from './customer-advice.js';

const now = () => new Date().toISOString();
const hasTopic = (text, topics) => {
  const words=tokens(text);
  return topics.some(t=>String(text).toLowerCase().includes(t.toLowerCase()) ||
    (tokens(t).size>0 && [...tokens(t)].every(word=>words.has(word))));
};
export function createTroubleshooting(store, learning, reuse, providerActions) {
  const sql = store.db;
  function authorize(p) {
    if(!p.demo && !sql.prepare("SELECT 1 FROM company_memberships WHERE company_id=? AND account_id=? AND role='customer' AND status='active'").get(p.companyId,p.id))
      throw fault(403,'Your customer membership is no longer active in this workspace.');
    if(!getBot(sql,p.companyId,botId(p)).active) throw fault(403,'This support service is inactive.');
  }
  const args = (p,t) => [p.companyId,botId(p),p.id,t.id];
  const attempts = (p,t) => sql.prepare('SELECT * FROM troubleshooting_attempts WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=? ORDER BY created_at').all(...args(p,t));
  function saveAttempt(p,t,source,fix,context,exchangeId,outcome='pending',useId=null) {
    sql.prepare(`INSERT INTO troubleshooting_attempts(id,company_id,chatbot_id,customer_id,ticket_id,source,fix_id,snapshot,context,outcome,exchange_id,use_id,created_at,outcome_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,chatbot_id,customer_id,ticket_id,source) DO NOTHING`)
      .run(randomUUID(),...args(p,t),source,fix.id,JSON.stringify(fix),JSON.stringify(context),outcome,exchangeId,useId,now(),outcome==='skipped'?now():null);
    return attempts(p,t).find(a=>a.source===source);
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
    // Reuse feedback has a synchronous transaction before its optional remote invalidation.
    // Marking a learned attempt and recording reuse are completed together below in processFeedback.
    return result;
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
        remote=reuse.feedback(p,{useId:a.use_id,worked:body.worked,confirmed:true,memory:body.memory,allowHandoff:getBot(sql,p.companyId,botId(p)).allowedActions.includes('handoff')});
      }).immediate();
      const r=await remote;
      if(r.handoffId) sql.prepare('UPDATE troubleshooting_attempts SET handoff_id=? WHERE id=?').run(r.handoffId,a.id);
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
    const record=(source,fix,context,outcome='pending',useId=null)=>preview?{id:'preview',source,fix_id:fix.id,snapshot:JSON.stringify(fix),context:JSON.stringify(context),outcome}:saveAttempt(p,t,source,fix,context,exchangeId,outcome,useId);
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
      if(pending.source==='learned') return b.allowedActions.includes('handoff')
        ? response('The fix did not work. Your case has been submitted to the company support team.',{workflow:{stage:'human'}})
        : response('The fix did not work. For human support, '+b.escalationRules.supportRoute,{workflow:{stage:'support_route'}});
    } else if(pending) {
      if(pending.source==='learned' && enabled) {
        const recalled=await learning.recall(p.companyId,p.provider,message,t,p.id,botId(p));
        authorize(p);
        const fix=recalled.facts.find(f=>f.resolutionId===pending.fix_id);
        const current=fix && store.data.resolutions.find(r=>r.id===fix.resolutionId);
        if(current && !current.retiredAt && !needsReview(current)) return response(customerAdvice(fix.solution),{attempt:pending,resolutionUse:reuse.current(privateScope(p),pending.use_id),
          decision:{mode:'recommend',action:null},evidence:[{id:fix.id,resolutionId:fix.resolutionId,kind:'verified_resolution',text:fix.text}],
          trace:{knowledge:recalled.source,memory:'Operational workflow',recalled:1,learnedResolutions:1,elapsedMs:0},workflow:{stage:'learned_pending'}});
      }
      // Questions, reactions and preferences never finalize an outcome.
      return response('A fix is awaiting your outcome. Choose “It worked”, “Still need help”, or request Human help.',{attempt:pending,workflow:{stage:pending.source+'_pending'}});
    }
    if(t.status==='Resolved' || rows.some(a=>a.outcome==='succeeded')) return response('Your request is resolved. Create a new request for another issue.',{workflow:{stage:'resolved'}});
    const previous=sql.prepare('SELECT context FROM troubleshooting_context WHERE company_id=? AND chatbot_id=? AND customer_id=? AND ticket_id=?').get(...args(p,t));
    const context=previous?JSON.parse(previous.context):{};
    if(inputContext && typeof inputContext==='object' && !Array.isArray(inputContext)) {
      for(const k of b.requiredContext) if(typeof inputContext[k]==='string' && inputContext[k].trim() && inputContext[k].length<=1000) context[k]=inputContext[k].trim();
    }
    if(!context.environment && /\b(?:model|firmware|windows|macos|ubuntu|android|ios|version)\s+[\w.-]+/i.test(t.title+' '+t.issue)) context.environment=t.title+' '+t.issue;
    if(/\b(?:model|firmware|windows|macos|ubuntu|android|ios|version)\s+[\w.-]+/i.test(message)) context.environment=message;
    for(const k of b.requiredContext) {
      const match=message.match(new RegExp('(?:^|\\n)'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':\\s*([^\\n]+)','i'));
      if(match) context[k]=match[1].slice(0,1000);
    }
    if(!preview) sql.prepare('INSERT INTO troubleshooting_context VALUES(?,?,?,?,?) ON CONFLICT(company_id,chatbot_id,customer_id,ticket_id) DO UPDATE SET context=excluded.context').run(...args(p,t),JSON.stringify(context));
    const query=[t.title,t.issue,message, ...Object.values(context)].join('\n');
    const missing=b.requiredContext.filter(k=>!context[k]);
    const unavailable=/\b(?:don.t know|do not know|not sure|no idea|(?:not able|unable|can.t|cannot)\s+(?:to\s+)?(?:confirm|find|identify|provide))\b/i.test(message);
    const related=[...tokens(message)].some(word=>tokens(t.title+' '+t.issue).has(word));
    if(!(missing.length && unavailable) && (!hasTopic(t.issue+' '+message,b.supportedTopics) || (!hasTopic(message,b.supportedTopics) && !related && !/\b(?:continue|troubleshoot|environment|model|firmware|version)\b/i.test(message) && !Object.keys(inputContext||{}).length)))
      return response(`${b.name} handles ${b.supportedTopics.join(', ')}. ${b.escalationRules.supportRoute}`,{action:b.allowedActions.includes('handoff')?{kind:'handoff',ticketId:t.id,summary:message}:null,workflow:{stage:'unsupported'}});
    if(missing.length) {
      if(unavailable) return response('That is okay. A specialist can help identify your device and check the problem. '+(b.allowedActions.includes('handoff')?'I have prepared a handoff; review it to send your case.':b.escalationRules.supportRoute),{
        action:b.allowedActions.includes('handoff')?{kind:'handoff',ticketId:t.id,summary:t.issue+'\nThe customer could not provide: '+missing.map(k=>k==='environment'?'device model and operating-system version':k.replaceAll('_',' ')).join(', ')}:null,
        workflow:{stage:b.allowedActions.includes('handoff')?'handoff_prepared':'support_route',missing}});
      const labels=missing.map(k=>k==='environment'?'your device model and operating-system version':k.replaceAll('_',' '));
      return response('Before suggesting a fix, please tell me '+labels.join(', ')+'. For example: “Model X, Windows 11”. If you do not know, say “I don’t know” and I can help you contact a specialist.',{workflow:{stage:'context',missing}});
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
    if(rows.some(a=>a.source==='learned')) {
      const h=escalate('Troubleshooting did not resolve the issue.');
      return escalated(h);
    }
    const learned=enabled?await learning.recall(p.companyId,p.provider,query,t,p.id,botId(p)):{facts:[],source:'Disabled'};
    authorize(p);
    if(getBot(sql,p.companyId,botId(p)).revision!==b.revision) throw fault(409,'This service configuration changed. Ask again for current guidance.');
    const currentTicket=provider(store,p).ticket(t.id);
    if(currentTicket.handoffs?.some(h=>!['Resolved','Closed'].includes(h.status)))
      return response('Your case is now with the company support team.',{workflow:{stage:'human'}});
    if(currentTicket.status==='Resolved') return response('Your request is resolved.',{workflow:{stage:'resolved'}});
    if(learned.clarification?.length) return response('Please confirm the applicable environment: '+learned.clarification.map(c=>c.environment).join('; '),{workflow:{stage:'learned_context'}});
    const f=learned.facts[0];
    if(f) {
      const r=store.data.resolutions.find(r=>r.id===f.resolutionId);
      if(!r || r.retiredAt || needsReview(r)) throw fault(409,'The reviewed solution changed. Ask again for current guidance.');
      const evidence=[{id:f.id,resolutionId:r.id,kind:'verified_resolution',text:f.text}];
      const result=response(customerAdvice(r.solution),{decision:{mode:'recommend',action:null},evidence,trace:{knowledge:learned.source,memory:enabled?'Operational workflow':'Disabled',learnedResolutions:1,recalled:1,elapsedMs:0}});
      return sql.transaction(()=>{
        authorize(p);
        const existing=attempts(p,t).find(a=>a.source==='learned');
        if(existing) return response('A reviewed fix is already awaiting your outcome. Use the outcome controls on that fix.',{attempt:existing,workflow:{stage:'learned_pending'}});
        const latest=provider(store,p).ticket(t.id);
        if(latest.status==='Resolved' || latest.handoffs.some(h=>!['Resolved','Closed'].includes(h.status)))
          return response('Your case has changed. Refresh to see its current state.',{workflow:{stage:'waiting'}});
        const use=preview?null:reuse.record(p,t,result,exchangeId,now());
        const a=record('learned',{id:r.id,environment:r.environment,solution:r.solution},context,'pending',use?.id);
        return {...result,attempt:a,resolutionUse:use,workflow:{stage:'learned_pending'}};
      }).immediate();
    }
    const h=escalate(enabled?'No applicable reviewed fix after standard troubleshooting.':'Standard troubleshooting did not resolve the issue. AI memory is off.');
    return escalated(h);
  }
  return {process,feedback:processFeedback,attempts};
}
