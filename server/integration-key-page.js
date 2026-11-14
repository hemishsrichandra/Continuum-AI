// Server-rendered integration settings. No JavaScript runs on the one-time secret page.
import { randomBytes } from 'node:crypto';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const root = '/api/company/integration-keys/manage';
const styles = `
html{scroll-behavior:auto}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;background:var(--bg);color:var(--text)}
body::before{display:none}
a{color:var(--atext);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,p{margin:0}
h1,h2,h3{font-family:inherit}
h1{font-size:32px;letter-spacing:-1px;line-height:1.2}
h2{font-size:18px;letter-spacing:-.4px}
h3{font-size:14px;letter-spacing:0}
.shell{width:min(1120px,calc(100% - 48px));margin:auto}
.topbar{border-bottom:1px solid var(--line)}
.nav{height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{font-size:21px;font-weight:750;letter-spacing:-1px;color:var(--text);display:flex;align-items:center;gap:10px}
.brand-mark{color:var(--on-accent);background:var(--accent);border-radius:8px;width:28px;height:28px;display:grid;place-items:center;font-size:19px;letter-spacing:0}
.back{font-size:13px;color:var(--text-2)}
main{padding-top:36px;padding-bottom:64px}
.breadcrumb{font-size:12px;color:var(--text-3);margin-bottom:16px;display:flex;gap:10px}
.page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:30px}
.page-heading p{color:var(--text-2);margin-top:10px;max-width:620px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);font-size:11px;font-weight:650;white-space:nowrap}
.pill.ok{background:var(--tint-green-bg);color:var(--tint-green-fg);border-color:var(--tint-green-line)}
.muted{color:var(--text-2)}
.small{font-size:12px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
.panel{backdrop-filter:none;box-shadow:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius,14px);overflow:hidden}
.panel-head{padding:24px 26px 20px;border-bottom:1px solid var(--line)}
.panel-head p{color:var(--text-2);font-size:13px;margin-top:5px}
.panel-body{padding:24px 26px}
.service-form{display:flex;align-items:end;gap:12px}
.service-form label{flex:1}
.field-label{display:block;font-size:13px;font-weight:650;margin-bottom:8px}
input:not([type=checkbox]),select{width:100%;font:inherit;color:var(--text);background:var(--bg-2);border:1px solid var(--line-2);border-radius:8px;min-height:44px;padding:10px 12px}
select{cursor:pointer}
input::placeholder{color:var(--text-3)}
input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);margin:3px 0 0;flex-shrink:0;cursor:pointer}
button,.button{display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:10px 16px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface-2);color:var(--text);font:inherit;font-size:13px;font-weight:650;cursor:pointer;text-decoration:none;white-space:nowrap}
button:hover,.button:hover{background:var(--surface-3);text-decoration:none}
.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.primary:hover{background:var(--accent-hover)}
.danger{color:var(--tint-red-fg);background:transparent;border-color:var(--tint-red-line);min-height:36px;padding:6px 12px;font-size:12px}
.danger:hover{background:var(--tint-red-bg)}
.divider{border:0;border-top:1px solid var(--line);margin:24px 0}
.field{margin-bottom:24px}
.helper{font-size:12px;color:var(--text-2);margin-top:6px}
fieldset{padding:0;margin:0;border:0;min-width:0}
legend{font-size:13px;font-weight:650;padding:0;margin-bottom:4px}
.knowledge-list{margin-top:14px;border:1px solid var(--line);border-radius:10px;max-height:350px;overflow:auto;background:var(--bg-2)}
.knowledge-row{padding:16px;border-bottom:1px solid var(--line)}
.knowledge-row:last-child{border-bottom:0}
.knowledge-label{display:flex;gap:12px;align-items:flex-start;cursor:pointer}
.knowledge-label strong{font-size:13px;font-weight:600}
.knowledge-meta{display:block;font-size:11px;color:var(--text-3);margin-top:3px}
.knowledge-row details{margin:8px 0 0 29px;font-size:12px;color:var(--text-2)}
summary{cursor:pointer}
details ol{padding-left:18px;margin-bottom:0}
.confirm{display:flex;gap:12px;align-items:flex-start;padding:18px 0 22px;font-size:12px;color:var(--text-2);cursor:pointer}
.form-footer{display:flex;align-items:center;justify-content:space-between;gap:16px}
.form-footer span{font-size:11px;color:var(--text-3)}
.aside{display:grid;gap:20px}
.aside .panel-body{padding:22px}
.aside h3{margin-bottom:10px}
.aside p{font-size:12px;color:var(--text-2)}
.scope-list{list-style:none;margin:0;padding:0}
.scope-list li{font-size:12px;padding:9px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;color:var(--text-2)}
.scope-list li:last-child{border:0}
.check{color:var(--ok);font-weight:700}
.code-label{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--text-3);margin:18px 0 8px}
.endpoint{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;overflow-wrap:anywhere;color:var(--text)}
.method{color:var(--ok);font-weight:700}
.aside pre{background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:14px;font-size:11px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}
.credentials{margin-top:28px}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.section-heading p{font-size:12px;color:var(--text-2);margin-top:5px}
.key-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 24px;border-bottom:1px solid var(--line)}
.key-row:last-child{border-bottom:0}
.key-name{font-weight:600;font-size:13px;margin-bottom:5px;overflow-wrap:anywhere}
.key-prefix{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--text-2)}
.key-detail{color:var(--text-3);font-size:11px;margin-top:5px}
.key-actions{display:flex;align-items:center;gap:16px;flex-shrink:0}
.notice{padding:14px 18px;border:1px solid var(--tint-green-line);border-radius:10px;background:var(--tint-green-bg);color:var(--tint-green-fg);margin-bottom:24px;font-size:13px}
.empty{padding:26px;color:var(--text-2);font-size:13px}
.success{max-width:720px;margin:20px auto}
.success .panel-body{padding:34px}
.success h2{font-size:24px;margin-top:18px}
.success p{color:var(--text-2);margin-top:12px}
.key-well{padding:20px;margin:26px 0 8px;background:var(--bg-2);border:1px solid var(--tint-green-line);border-radius:10px}
.key-well pre{font-family:ui-monospace,SFMono-Regular,monospace;font-size:14px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;margin:0}
.success .button{margin-top:26px}
.footer-note{font-size:11px;color:var(--text-3);margin-top:24px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
@media(max-width:850px){.layout{grid-template-columns:1fr}
.aside{grid-template-columns:1fr 1fr}
.page-heading{display:block}
.page-heading>.pill{margin-top:16px}
}
@media(max-width:560px){.shell{width:calc(100% - 32px)}
.nav{height:64px}
.brand{font-size:18px}
.back{font-size:11px}
main{padding-top:24px}
h1{font-size:28px}
.panel-head,.panel-body{padding:20px}
.service-form{display:block}
.service-form button{margin-top:12px;width:100%}
.aside{grid-template-columns:1fr}
.form-footer{align-items:stretch;flex-direction:column}
.key-row{padding:18px;align-items:flex-start;flex-direction:column;gap:14px}
.key-actions{width:100%;justify-content:space-between}
.success .panel-body{padding:22px}
.key-well{padding:16px}
.key-well pre{font-size:12px}
}

`;

export function sendKeyPage(res, content, status = 200) {
  const nonce = randomBytes(18).toString('base64');
  res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
    'Content-Security-Policy':`default-src 'none'; style-src 'self' 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>API keys — Continuum</title><link rel="stylesheet" href="/theme.css"><style nonce="${nonce}">${styles}</style></head><body><header class="topbar"><nav class="shell nav" aria-label="Account navigation"><a class="brand" href="/team"><span class="brand-mark" aria-hidden="true">c</span>continuum</a><a class="back" href="/team">← Back to company account</a></nav></header><main class="shell"><div class="breadcrumb"><span>Account &amp; security</span><span aria-hidden="true">/</span><span>Integrations</span></div><div class="page-heading"><div><h1>API keys</h1><p>Connect your company’s chatbot to Continuum’s reviewed knowledge.</p></div><span class="pill">Company owner access</span></div>${content}</main></body></html>`);
  return true;
}

export function createdKeyContent(key) {
  return `<section class="panel success" aria-labelledby="created-title"><div class="panel-body"><span class="pill ok">✓ Key created</span><h2 id="created-title">Copy your key now</h2><p>Your integration is ready. Save this key in your company backend’s secret store. This is the only time the full key will be shown.</p><div class="key-well"><pre>${escape(key)}</pre></div><div class="helper">Select the key, then press ⌘C on Mac or Ctrl+C on Windows.</div><hr class="divider"><h3>Keep this key on your server</h3><p class="small">Send it in the Authorization: Bearer header. Keep it out of browser code, URLs and logs.</p><a class="button primary" href="${root}">Done — manage API keys →</a></div></section>`;
}

export function managementContent({ bots, selected, csrfToken, knowledge, credentials, notice }) {
  const csrf = `<input type="hidden" name="csrf" value="${escape(csrfToken)}">`;
  const active = credentials.filter(k => !k.revokedAt).length;
  const date = value => new Date(value).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
  return `${notice ? '<div class="notice" role="status">Key revoked. Requests using this key will no longer be accepted.</div>' : ''}
  <div class="layout"><section class="panel" aria-labelledby="create-title"><div class="panel-head"><h2 id="create-title">Create an API key</h2><p>Choose a service and the knowledge this integration can access.</p></div><div class="panel-body">
  <form method="get" class="service-form"><label><span class="field-label">Support service</span><select name="chatbotId">${bots.map(b=>`<option value="${escape(b.id)}" ${b.id === selected ? 'selected' : ''}>${escape(b.name)}</option>`).join('')}</select></label><button>Choose service</button></form>
  <hr class="divider"><form method="post">${csrf}<input type="hidden" name="action" value="create"><input type="hidden" name="chatbotId" value="${escape(selected)}"><div class="field"><label class="field-label" for="integration-name">Integration name</label><input id="integration-name" name="name" required maxlength="80" placeholder="e.g. Website support chatbot" autocomplete="off"><p class="helper">A name to help you identify this key later.</p></div>
  <fieldset><legend>Knowledge access</legend><p class="helper">Select reviewed fixes you approve for this chatbot’s audience.</p><div class="knowledge-list">${knowledge.map(r=>`<div class="knowledge-row"><label class="knowledge-label"><input type="checkbox" name="memoryIds" value="${escape(r.id)}"><span><strong>${escape(r.title)}</strong><span class="knowledge-meta">${r.origin_type === 'company_db_sync' ? 'Reviewed company import' : 'Company playbook'} · Version ${r.version_number}</span></span></label><details><summary>View reviewed steps</summary><ol>${JSON.parse(r.steps_json).map(step=>`<li>${escape(step)}</li>`).join('')}</ol></details></div>`).join('') || '<p class="empty">No reviewed knowledge is available for this service yet. Import and approve fixes in the specialist console first.</p>'}</div></fieldset>
  <label class="confirm"><input type="checkbox" name="confirmed" value="yes" required><span>I have reviewed the selected knowledge for privacy and safety, and approve sharing it with this integration’s audience.</span></label><div class="form-footer"><button class="primary" ${knowledge.length ? '' : 'disabled'}>Create integration key →</button><span>The full key is shown only once.</span></div></form></div></section>
  <aside class="aside" aria-label="Integration help"><section class="panel"><div class="panel-body"><h3>One key. One service.</h3><p>Each key is limited to your company, the selected service and the knowledge you approve.</p><ul class="scope-list"><li><span class="check" aria-hidden="true">✓</span>Reviewed suggestions only</li><li><span class="check" aria-hidden="true">✓</span>Personal tickets stay private</li><li><span class="check" aria-hidden="true">✓</span>Revoke access at any time</li></ul></div></section><section class="panel"><div class="panel-body"><h3>Make your first request</h3><p>Call Continuum from your company backend using your new key.</p><div class="code-label">Endpoint</div><div class="endpoint"><span class="method">POST</span> /api/v1/external/suggestions</div><div class="code-label">JSON body</div><pre>{
  "question": "Describe the issue",
  "conversationId": "chat-42"
}</pre><p>Use <code>Authorization: Bearer &lt;key&gt;</code> in the request header.</p></div></section></aside></div>
  <section class="credentials" aria-labelledby="keys-title"><div class="section-heading"><div><h2 id="keys-title">Your API keys <span class="pill">${active} active</span></h2><p>Manage credentials across your company’s support services.</p></div></div><div class="panel">${credentials.map(r=>`<div class="key-row"><div><div class="key-name">${escape(r.name)}</div><div class="key-prefix">${escape(r.prefix)}••••••••</div><div class="key-detail">${escape(bots.find(b=>b.id === r.chatbotId)?.name || 'Archived service')} · Created ${escape(date(r.createdAt))}${r.revokedAt ? ' · Revoked '+escape(date(r.revokedAt)) : ''}</div></div><div class="key-actions"><span class="pill ${r.revokedAt ? '' : 'ok'}">${r.revokedAt ? 'Revoked' : 'Active'}</span>${r.revokedAt ? '' : `<form method="post">${csrf}<input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${escape(r.id)}"><button class="danger" aria-label="Revoke ${escape(r.name)}">Revoke key</button></form>`}</div></div>`).join('') || '<div class="empty"><h3>No API keys yet</h3><p>Create your first key above to connect a company chatbot.</p></div>'}</div><p class="footer-note">Keys retrieve suggestion previews. They do not record customer attempts or successful outcomes. Updated knowledge versions need a new approval and key.</p></section>`;
}
