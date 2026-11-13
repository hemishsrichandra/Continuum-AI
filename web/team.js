import { staffAccountControls, bindStaffAccount } from './staff-account.js';
import { request, escapeHtml as q, formatDate } from './client.js';
import { mountConnector } from './connector-ui.js';
import { mountChatbotConfig } from './chatbot-config.js';
import { mountDataSources } from './data-sources-ui.js';
import { mountKnowledgeImport } from './knowledge-import-ui.js';
import { mountStaffAccess } from './staff-access-ui.js';
import { confirmDialog, copyText } from './form-kit.js';

const TABS = [['overview', 'Overview'], ['team', 'Team & access'], ['services', 'AI services'], ['knowledge', 'Knowledge'], ['connections', 'Connections']];
const pillTone = (status) => (status === 'active' ? 'green' : status === 'revoked' ? 'warn' : '');

const when = (ms) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const pendingInvites = (data) => {
  const list = (data.invitations || []).filter((i) => !i.consumed_at);
  if (!list.length) return '';
  return `<div class="hub-card"><div class="hub-section-head"><div><h2>Pending invitations</h2><p>Invitations expire after 48 hours. Sending a new link closes the old one.</p></div></div>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map((i) => `<tr><td><b>${q(i.email)}</b></td><td>${q(i.role === 'staff' ? 'Specialist' : 'Customer')} · ${q(i.provider)}</td><td><span class="pill ${i.expires_at > Date.now() ? 'green' : 'warn'}">${i.expires_at > Date.now() ? 'Open until ' + q(when(i.expires_at)) : 'Expired'}</span></td><td class="row-actions"><button class="button small" data-resend="${q(i.email)}">Send a new link</button></td></tr>`).join('')}</tbody></table></div>
    <div class="copy-row" id="resend-row" hidden><input id="resend-link" readonly aria-label="New invitation link"><button class="button small" data-copy="#resend-link">Copy</button></div></div>`;
};
export async function mountTeam() {
  const app = document.querySelector('#app');
  let data;
  try { data = await request('company'); }
  catch (e) {
    app.innerHTML = `<section class="wrap section"><h1>Company access</h1><p>${q(e.message)}</p><a class="button" href="/desk">Sign in</a></section>`;
    return;
  }
  const notice = (text) => { document.querySelector('#team-result').textContent = text; };
  const customers = data.members.filter((m) => m.role === 'customer' && m.status === 'active');
  app.innerHTML = `<section class="wrap section hub">
    <header class="hub-head"><div><span class="eyebrow">COMPANY WORKSPACE</span><h1>${q(data.company.name)}</h1><p class="lead">Invite people, set up your AI services and connect the knowledge you already have.</p></div>
      <div class="actions">${staffAccountControls}<a class="button" href="/operator">← Specialist console</a></div></header>
    <div class="hub-tabs" role="tablist" aria-label="Company sections">${TABS.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="false" tabindex="-1" data-tab="${id}">${label}</button>`).join('')}</div>
    <p id="team-result" role="status"></p>
    ${TABS.map(([id]) => `<section class="hub-panel" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" hidden></section>`).join('')}</section>`;
  bindStaffAccount(app);

  const panel = (id) => app.querySelector('#panel-' + id);
  const mounted = new Set();
  const failed = (host, what, retry) => {
    host.insertAdjacentHTML('beforeend', `<div class="hub-card"><p role="alert">${q(what)} could not load. The rest of the page still works.</p><button class="button">Try again</button></div>`);
    host.lastElementChild.querySelector('button').addEventListener('click', () => { host.lastElementChild.remove(); retry(); });
  };
  const load = (host, what, fn) => { const go = () => fn().catch(() => failed(host, what, go)); return go(); };

  const builders = {
    overview: async (host) => {
      const [bots, sources] = await Promise.all([request('company/chatbots').catch(() => null), request('company/data-sources').catch(() => null)]);
      const specialists = data.members.filter((m) => m.role === 'staff' && m.status === 'active').length;
      const services = bots ? bots.chatbots.filter((b) => b.active).length : null;
      const sourceList = sources ? sources.sources : null;
      const lastSync = sourceList ? sourceList.map((s) => s.lastSyncedAt).filter(Boolean).sort().pop() : null;
      const stat = (n, label, note = '', tone = '') => `<div class="stat-card ${tone}"><b>${q(n ?? '—')}</b><span>${q(label)}</span>${note ? `<small>${q(note)}</small>` : ''}</div>`;
      const steps = [
        [specialists > 0, 'Invite your first specialist', 'team'],
        [services > 0, 'Review your AI services', 'services'],
        [sourceList && sourceList.length > 0, 'Connect a knowledge source (optional)', 'knowledge'],
      ];
      host.innerHTML = `<div class="stat-row">${stat(specialists, 'Active specialists')}${stat(customers.length, 'Customers')}${stat(services, 'Active services')}${stat(sourceList ? sourceList.length : null, 'Knowledge sources', lastSync ? 'Last sync ' + formatDate(lastSync, true) : 'Not synced yet')}</div>
        <div class="hub-two"><div class="hub-card"><h2>Quick actions</h2><div class="quick-actions"><button class="button primary" data-go="team">+ Invite a team member</button><button class="button" data-go="knowledge">+ Connect a knowledge source</button><button class="button" data-copy-signup>Copy customer signup link</button></div><p class="muted small" data-quick-note></p></div>
        <div class="hub-card"><h2>Getting set up</h2><ol class="setup-list">${steps.map(([done, label, tab]) => `<li class="${done ? 'done' : ''}"><span class="tick" aria-hidden="true">${done ? '✓' : ''}</span>${done ? `<span>${q(label)}</span>` : `<button class="link" data-go="${tab}">${q(label)}</button>`}</li>`).join('')}</ol></div></div>`;
      host.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go, true)));
      host.querySelector('[data-copy-signup]').addEventListener('click', async (e) => {
        if (!(await confirmDialog({ title: 'Create and copy a new signup link?', body: 'This replaces the current signup link, which will stop working. Accounts that already exist stay active.', confirm: 'Create and copy' }))) return;
        try {
          const r = await request('company/customer-code', { body: { confirmed: true } });
          await copyText(r.url, e.target);
          host.querySelector('[data-quick-note]').textContent = 'A new signup link was created and copied. The previous link no longer works.';
        } catch (error) { notice(error.message); }
      });
    },

    team: async (host) => {
      host.innerHTML = `<div class="hub-two">
        <div class="hub-card" data-signup><h2>Customer signup link</h2><p>Share this so customers can create their own account. A new link replaces the previous one; existing accounts stay active.</p>
          <div class="copy-row" hidden><input id="customer-link" readonly aria-label="Customer signup link"><button class="button small" data-copy="#customer-link">Copy</button></div>
          <button class="button" id="customer-code">Create a signup link</button></div>
        <div class="hub-card"><h2>Invite a team member</h2><form id="invite-form" class="form-grid">
          <label>Email<input name="email" type="email" required maxlength="254"></label>
          <label>Role<select name="role"><option value="staff">Specialist</option><option value="customer">Customer</option></select></label>
          <label>Type of support<select name="provider"><option value="repair">Device repair</option><option value="it">IT support</option></select></label>
          ${data.emailConfigured ? '<label class="switch form-end"><input type="checkbox" name="sendEmail"> Also email this invitation to them</label>' : ''}<div class="form-end"><button class="button primary">Create private invitation</button></div></form>
          <div class="copy-row" id="invitation-row" hidden><input id="invitation-link" readonly aria-label="Invitation link"><button class="button small" data-copy="#invitation-link">Copy</button></div>
          <p class="muted small">Invitations expire after 48 hours and work only for the email address you enter.</p></div></div>
        <div class="hub-card"><div class="hub-section-head"><div><h2>Members</h2><p>${data.members.length} ${data.members.length === 1 ? 'person' : 'people'} in this company.</p></div></div>
          <div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Support</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.members.map((m) => `<tr><td><b>${q(m.name)}</b><small>${q(m.email)}</small></td><td>${q(m.role)}</td><td>${q(m.provider || '—')}</td><td><span class="pill ${pillTone(m.status)}">${q(m.status)}</span></td><td class="row-actions">${m.role === 'staff' && m.status === 'active' ? `<button class="button small" data-revoke="${q(m.id)}" data-name="${q(m.name)}">Remove specialist access</button>` : ''}${m.role !== 'owner' && m.status === 'active' ? `<button class="button small danger-ghost" data-revoke-membership="${q(m.id)}" data-name="${q(m.name)}">Revoke company access</button>` : ''}${m.role !== 'owner' && m.status === 'revoked' ? `${m.role === 'staff' ? `<button class="button small" data-reinstate="${q(m.id)}" data-role="staff" data-name="${q(m.name)}">Reinstate as specialist</button>` : ''}<button class="button small" data-reinstate="${q(m.id)}" data-role="customer" data-name="${q(m.name)}">Reinstate${m.role === 'staff' ? ' as customer' : ''}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
        ${pendingInvites(data)}
        <div data-access></div>`;
      host.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(host.querySelector(b.dataset.copy).value, b)));
      host.querySelector('#customer-code').addEventListener('click', async (event) => {
        const button = event.target;
        if (!host.querySelector('#customer-link').value || await confirmDialog({ title: 'Replace the signup link?', body: 'The current link will stop working. Accounts that already exist stay active.', confirm: 'Create new link' })) {
          button.disabled = true;
          try {
            const result = await request('company/customer-code', { body: { confirmed: true } });
            host.querySelector('[data-signup] .copy-row').hidden = false;
            host.querySelector('#customer-link').value = result.url;
            button.textContent = 'Create a new link';
            notice('Customer signup link created.');
          } catch (e) { notice(e.message); } finally { button.disabled = false; }
        }
      });
      host.querySelector('#invite-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = event.target.querySelector('button');
        button.disabled = true;
        try {
          const fields = Object.fromEntries(new FormData(event.target));
          const result = await request('company/invitations', { body: { ...fields, sendEmail: fields.sendEmail === 'on' } });
          host.querySelector('#invitation-row').hidden = false;
          host.querySelector('#invitation-link').value = result.url;
          notice(result.emailed ? 'Private invitation created and emailed. You can also copy the link.' : 'Private invitation created. Share it with the person you invited.');
        } catch (e) { notice(e.message); } finally { button.disabled = false; }
      });
      const act = async (button, route, title, body, confirm, done) => {
        if (!(await confirmDialog({ title, body, confirm, cancel: 'Keep access', danger: true }))) return;
        button.disabled = true;
        try { await request(route, { body: { id: button.dataset[route.includes('staff') ? 'revoke' : 'revokeMembership'], confirmed: true } }); await mountTeam(); notice(done); }
        catch (e) { notice(e.message); button.disabled = false; }
      };
      host.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => act(b, 'company/revoke-staff', `Remove specialist access for ${b.dataset.name}?`, 'They stay a customer of this company but can no longer work cases. Cases they hold return to the queue.', 'Remove specialist access', 'Specialist access removed. Active assignments were released; review the service queue.')));
      host.querySelectorAll('[data-revoke-membership]').forEach((b) => b.addEventListener('click', () => act(b, 'company/revoke-membership', `Revoke ${b.dataset.name}’s company access?`, 'They will lose all access to this company, including their requests. This is the stronger of the two options.', 'Revoke access', 'Company access revoked.')));
      host.querySelectorAll('[data-reinstate]').forEach((b) => b.addEventListener('click', async () => {
        const asRole = b.dataset.role;
        if (!(await confirmDialog({ title: `Reinstate ${b.dataset.name}?`, body: asRole === 'staff' ? 'They get their specialist access back. Cases that were released to the queue stay there.' : 'They return as a customer of this company. They will not have specialist access.', confirm: 'Reinstate' }))) return;
        b.disabled = true;
        try { await request('company/reinstate-membership', { body: { id: b.dataset.reinstate, role: asRole, confirmed: true } }); await mountTeam(); notice('Member reinstated.'); }
        catch (e) { notice(e.message); b.disabled = false; }
      }));
      host.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Send a new invitation link?', body: 'The earlier link for ' + b.dataset.resend + ' stops working. The new one lasts 48 hours.' + (data.emailConfigured ? ' It will also be emailed to them.' : ''), confirm: 'Send new link' }))) return;
        b.disabled = true;
        try {
          const r = await request('company/invitations/resend', { body: { email: b.dataset.resend, confirmed: true, sendEmail: Boolean(data.emailConfigured) } });
          host.querySelector('#resend-row').hidden = false;
          host.querySelector('#resend-link').value = r.url;
          notice('New invitation link created for ' + b.dataset.resend + '. Copy it and share it with them.');
        } catch (e) { notice(e.message); } finally { b.disabled = false; }
      }));
      await mountStaffAccess(host.querySelector('[data-access]'));
    },

    services: (host) => mountChatbotConfig(host),
    knowledge: async (host) => { await mountKnowledgeImport(host); await mountDataSources(host); },
    connections: (host) => mountConnector(host, customers),
  };

  function show(id, focus = false) {
    if (!builders[id]) id = 'overview';
    for (const [tab] of TABS) {
      const on = tab === id;
      const button = app.querySelector('#tab-' + tab);
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panel(tab).hidden = !on;
    }
    try { history.replaceState(null, '', '#' + id); } catch { /* the URL is a convenience only */ }
    if (!mounted.has(id)) { mounted.add(id); load(panel(id), TABS.find(([t]) => t === id)[1], () => builders[id](panel(id))); }
    if (focus) app.querySelector('#tab-' + id).focus();
  }

  const tabs = app.querySelector('.hub-tabs');
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  tabs.addEventListener('keydown', (e) => {
    const ids = TABS.map(([id]) => id), at = ids.indexOf(document.activeElement?.dataset?.tab);
    if (at < 0) return;
    const next = e.key === 'ArrowRight' ? (at + 1) % ids.length : e.key === 'ArrowLeft' ? (at - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
    if (next >= 0) { e.preventDefault(); show(ids[next], true); }
  });
  show(location.hash.slice(1) || 'overview');
}
