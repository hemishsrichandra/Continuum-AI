import {request,escapeHtml as q,saveSession} from './client.js';
export async function mountWorkspaceControl() {
  document.querySelector('#workspace-control')?.remove();
  document.querySelector('#workspace-nav-label')?.remove();
  document.body.classList.remove('support-shell');
  if(!['/desk','/team','/operator'].includes(location.pathname.replace(/\/+$/,''))) return;
  let data;
  try {data=await request('auth/workspaces');} catch {return;}
  document.body.classList.add('support-shell');
  const navLabel=document.createElement('span');navLabel.id='workspace-nav-label';navLabel.className='workspace-nav-label';
  navLabel.innerHTML='<span class="status-dot" aria-hidden="true"></span> Support workspace';
  document.querySelector('.nav-actions')?.append(navLabel);
  const section=document.createElement('section');section.id='workspace-control';section.className='wrap workspace-switcher';
  section.setAttribute('aria-label','Workspace selection');
  const membership=data.memberships.find(m=>m.companyId===data.companyId);
  section.innerHTML=`<div class="workspace-switcher-intro"><span class="workspace-emblem" aria-hidden="true">◈</span><div><span class="switcher-caption">YOUR WORKSPACE</span><span class="switcher-hint">One account. Connected support.</span></div></div><div id="select-workspace"><label>Company<select name="companyId" aria-describedby="workspace-switch-hint">${data.memberships.map(m=>`<option value="${q(m.companyId)}" ${m.companyId===data.companyId?'selected':''}>${q(m.name)}</option>`).join('')}</select></label><label>Service<select name="chatbotId" aria-describedby="workspace-switch-hint">${data.chatbots.map(b=>`<option value="${q(b.id)}" ${b.id===data.chatbotId?'selected':''}>${q(b.name)}</option>`).join('')}</select></label></div><span class="workspace-role">${q(membership?.role || 'Account')}</span><details class="workspace-join"><summary>Join a company <span aria-hidden="true">＋</span></summary><form id="join-workspace"><h2>Connect another company</h2><p>Use a signup code or the token from your private invitation.</p><label>Company signup code<input name="companyCode" maxlength="200" autocomplete="off"></label><label>Or private invitation token<input name="invitation" maxlength="200" autocomplete="off"></label><button class="button primary">Join company</button></form></details><span class="sr-only" id="workspace-switch-hint">Choosing a company or service switches your workspace immediately.</span><p role="status" aria-live="polite" id="workspace-result" hidden></p>`;
  document.querySelector('#app')?.before(section);
  let switching=false;
  async function switchWorkspace(body,join=false) {
    if(switching) return;
    switching=true;section.setAttribute('aria-busy','true');
    const result=section.querySelector('#workspace-result');
    result.hidden=false;result.className='workspace-switch-message';result.textContent=join?'Joining company…':'Switching workspace…';
    section.querySelectorAll('input,select,button').forEach(el=>{el.disabled=true;});
    try {
      if(join) {
        for(const key of Object.keys(body)) if(!body[key]) delete body[key];
        const joined=await request('auth/join',{body});
        await request('auth/workspace',{body:{companyId:joined.companyId}});
      } else await request('auth/workspace',{body});
      saveSession('supportly-ticket',null);
      location.replace('/desk');
    } catch(error){
      result.textContent=error.message;result.classList.add('error');
      section.querySelector('[name=companyId]').value=data.companyId;
      section.querySelector('[name=chatbotId]').value=data.chatbotId;
      section.querySelectorAll('input,select,button').forEach(el=>{el.disabled=false;});
      section.setAttribute('aria-busy','false');switching=false;
    }
  }
  section.querySelector('[name=companyId]').addEventListener('change',e=>switchWorkspace({companyId:e.target.value}));
  section.querySelector('[name=chatbotId]').addEventListener('change',e=>switchWorkspace({companyId:data.companyId,chatbotId:e.target.value}));
  section.querySelector('#join-workspace').addEventListener('submit',e=>{
    e.preventDefault();switchWorkspace(Object.fromEntries(new FormData(e.target)),true);
  });
}
