import {request,escapeHtml as q} from './client.js';
export async function mountChatbotConfig(app) {
  const {chatbots}=await request('company/chatbots');
  const section=document.createElement('section');section.className='panel content-panel';
  section.innerHTML=`<h2>Support services</h2><p>Each service has its own cases and reviewed solutions. Changes apply to future recommendations; previous attempts keep the steps shown to the customer.</p>${chatbots.map(b=>`<details><summary>${q(b.name)} · ${b.active?'Active':'Inactive'}</summary><form data-bot="${q(b.id)}"><label>Name<input name="name" value="${q(b.name)}" required maxlength="100"></label><label>Purpose<textarea name="purpose" required>${q(b.purpose)}</textarea></label><label>Supported topics (comma separated)<input name="topics" value="${q(b.supportedTopics.join(', '))}"></label><label>Diagnostic fields (JSON list: key, label, required, optional help or options)<textarea name="schema" rows="6">${q(JSON.stringify(b.diagnosticSchema||[],null,2))}</textarea></label><p class="muted">Examples: device, os, firmware, plan tier, region. Customers are asked only for required fields that are still unknown.</p><label>Allowed actions (comma separated)<input name="actions" value="${q(b.allowedActions.join(', '))}"></label><label>Escalate immediately for (comma separated)<input name="immediate" value="${q(b.escalationRules.immediateTopics.join(', '))}"></label><label>Support route<input name="route" value="${q(b.escalationRules.supportRoute)}" required></label><label>Standard playbooks (JSON list: id, version, topics, steps)<textarea name="playbooks" rows="8" required>${q(JSON.stringify(b.playbooks,null,2))}</textarea></label><label><input name="active" type="checkbox" ${b.active?'checked':''}> Active</label><button class="button">Save service</button></form></details>`).join('')}<details><summary>Add a service</summary><form id="new-service"><label>Name<input name="name" required maxlength="100"></label><label>Starting configuration<select name="template">${chatbots.map(b=>`<option value="${q(b.id)}">${q(b.name)}</option>`).join('')}</select></label><button class="button">Create service</button></form></details><p role="status" data-result></p>`;
  app.querySelector('section.wrap').append(section);
  const list=v=>v.split(',').map(x=>x.trim()).filter(Boolean);
  section.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async e=>{
    e.preventDefault();const button=form.querySelector('button');button.disabled=true;
    try {
      const f=Object.fromEntries(new FormData(form));let body;
      if(form.id==='new-service') {body={...chatbots.find(b=>b.id===f.template),name:f.name};delete body.id;delete body.revision;}
      else {const b=chatbots.find(b=>b.id===form.dataset.bot);body={...b,name:f.name,purpose:f.purpose,supportedTopics:list(f.topics),diagnosticSchema:JSON.parse(f.schema),allowedActions:list(f.actions),escalationRules:{immediateTopics:list(f.immediate),supportRoute:f.route},playbooks:JSON.parse(f.playbooks),active:form.elements.active.checked};}
      await request('company/chatbots',{body});location.reload();
    }catch(error){section.querySelector('[data-result]').textContent=error.message;button.disabled=false;}
  }));
}
