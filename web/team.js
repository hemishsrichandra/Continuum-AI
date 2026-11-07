import {staffAccountControls, bindStaffAccount} from './staff-account.js';
import { request, escapeHtml as q } from './client.js';
import { mountConnector } from './connector-ui.js';
export async function mountTeam() {
  const app = document.querySelector('#app');
  try {
    const data = await request('company');
    app.innerHTML = `<section class="wrap section"><span class="eyebrow">OWNER · COMPANY & TEAM</span><h1>${q(data.company.name)}</h1><p class="lead">Manage your team and connections. Handle customer cases in the specialist console.</p><div class="actions">${staffAccountControls}<a class="button" href="/operator">Customer cases</a></div><p id="team-result" role="status"></p><section class="panel content-panel"><h2>Customer registration</h2><p>Create a signup link for your customers. Generating another link disables the previous signup link. Existing accounts stay active.</p><button class="button" id="customer-code">Generate customer signup link</button><label id="customer-link-label" hidden>Customer signup link<input id="customer-link" readonly></label></section><section class="panel content-panel"><h2>Invite a team member</h2><form id="invite-form"><label>Email<input name="email" type="email" required maxlength="254"></label><label>Access<select name="role"><option value="staff">Specialist</option><option value="customer">Customer</option></select></label><label>Schema adapter<select name="provider"><option value="repair">Standard service requests</option><option value="it">IT incidents</option></select></label><button class="button primary">Create private invitation</button></form><label id="invitation-label" hidden>Share this link with the invited person<input id="invitation-link" readonly></label><p>Invitations expire after 48 hours and work only for the specified email address.</p></section><section class="panel content-panel"><h2>Members</h2>${data.members.map((m) => `<article class="memory-entry"><b>${q(m.name)}</b><p>${q(m.email)} · ${q(m.role)} · ${q(m.provider)}</p>${m.role === 'staff' ? `<button class="button small" data-revoke="${q(m.id)}">Remove specialist access</button>` : ''}</article>`).join('')}</section></section>`;
    bindStaffAccount(app);
    const notice = (text) => {
      document.querySelector('#team-result').textContent = text;
    };
    document.querySelector('#customer-code').addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const result = await request('company/customer-code', { body: { confirmed: true } });
        document.querySelector('#customer-link-label').hidden = false;
        document.querySelector('#customer-link').value = result.url;
        notice('Customer signup link created.');
      } catch (e) {
        notice(e.message);
      } finally {
        event.target.disabled = false;
      }
    });
    document.querySelector('#invite-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button');
      button.disabled = true;
      try {
        const result = await request('company/invitations', {
          body: Object.fromEntries(new FormData(event.target)),
        });
        document.querySelector('#invitation-label').hidden = false;
        document.querySelector('#invitation-link').value = result.url;
        notice('Private invitation created. Share it with the specified person.');
      } catch (e) {
        notice(e.message);
      } finally {
        button.disabled = false;
      }
    });
    app.querySelectorAll('[data-revoke]').forEach((button) =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await request('company/revoke-staff', { body: { id: button.dataset.revoke, confirmed: true } });
          await mountTeam();
          document.querySelector('#team-result').textContent = 'Specialist access removed. Active assignments were released; review the service queue.';
        } catch (e) {
          notice(e.message);
          button.disabled = false;
        }
      }),
    );
    async function loadConnector() {
      app.querySelector('#connector-load-error')?.remove();
      try { await mountConnector(app, data.members); }
      catch {
        const panel = document.createElement('section');
        panel.id = 'connector-load-error';
        panel.className = 'panel content-panel';
        panel.innerHTML = '<p role="alert">Connection settings could not load. Company and team controls remain available.</p><button class="button">Retry connection settings</button>';
        panel.querySelector('button').addEventListener('click', loadConnector);
        app.querySelector('section.wrap').append(panel);
      }
    }
    await loadConnector();
  } catch (e) {
    app.innerHTML = `<section class="wrap section"><h1>Company access</h1><p>${q(e.message)}</p><a class="button" href="/desk">Sign in</a></section>`;
  }
}
