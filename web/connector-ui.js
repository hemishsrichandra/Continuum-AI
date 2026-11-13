// Owner UI: connect an existing service system (gateway) and link customers to it.
import { request, escapeHtml as q } from './client.js';

// What Continuum needs from the other system, in plain words. The value typed is the property name in that system's JSON.
const MAP = [
  ['id', 'Request number', true], ['customerId', 'Customer ID', true], ['title', 'Request title', true], ['issue', 'Problem description', true],
  ['status', 'Status', true], ['eta', 'Expected completion', false], ['assignedTo', 'Assigned to', false],
];

export async function mountConnector(host, members) {
  const c = await request('company/connector');
  const section = document.createElement('div');
  section.className = 'connector-hub';
  section.innerHTML = `<div class="hub-card"><div class="hub-section-head"><div><h2>Service system</h2><p>Import service records and, if you choose, send confirmed request actions to a gateway that supports safe retries. Calendar bookings stay in Continuum.</p></div>
      <span class="pill ${c.configured ? 'green' : ''}" data-connector-summary>${c.configured ? 'Connected' : 'Not connected'}</span></div>
    ${c.configured ? `<p class="muted small">Gateway: ${q(c.baseUrl)}</p>` : ''}
    <form id="connector-form" autocomplete="off">
      <div class="form-grid"><label>Gateway address<input name="baseUrl" type="url" autocomplete="off" required value="${q(c.baseUrl || '')}" placeholder="https://service.example.com"></label>
      <label>Access token<input name="apiToken" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" required placeholder="Paste a token to save changes"></label></div>
      <h3>Match their fields to ours</h3><p class="muted small">Type the property name your system uses for each item. Names use letters, numbers and underscores.</p>
      <div class="mapping-grid">${MAP.map(([k, label, req]) => `<label>${q(label)}${req ? ' *' : ' (optional)'}<input name="map_${k}" value="${q(c.mapping?.[k] || '')}" ${req ? 'required' : ''} pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="${k}"></label>`).join('')}</div>
      <label class="switch"><input type="checkbox" name="writesEnabled" ${c.writesEnabled ? 'checked' : ''}> Send confirmed request actions to this gateway</label>
      <div class="actions"><button class="button primary">Save connection</button></div>
      <details class="infra"><summary>Technical details</summary><p class="muted small">Gateway addresses must be on this server’s allow-list: ${q(c.allowedOrigins.join(', ') || 'none is configured yet. Ask whoever runs this server to set PROVIDER_ALLOWED_ORIGINS.')}</p></details>
    </form></div>
    <div class="hub-card"><div class="hub-section-head"><div><h2>Customers</h2><p>Bring a customer’s record across, or link an existing Continuum account to an ID in your service system.</p></div></div>
      <div class="split-forms">
        <form id="lookup-form"><h3>Import a customer record</h3><p class="muted small">Imports a directory entry only. To link it, the customer must join this company and verify the matching email address.</p><label>Customer ID in your system<input name="externalId" required maxlength="200"></label><button class="button">Look up and import</button></form>
        <form id="external-customer-form"><h3>Link an account</h3><label>Continuum account<select name="accountId">${members.length ? members.map((m) => `<option value="${q(m.id)}">${q(m.name)} · ${q(m.email)}</option>`).join('') : '<option value="">No customer accounts yet</option>'}</select></label><label>Customer ID in your system<input name="externalId" required maxlength="200"></label><button class="button" ${members.length ? '' : 'disabled'}>Link customer</button></form>
      </div></div><p role="status" id="connector-result"></p>`;
  host.append(section);
  const result = section.querySelector('#connector-result');
  const summary = section.querySelector('[data-connector-summary]');

  section.querySelector('#lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, button = form.querySelector('button');
    button.disabled = true;
    try {
      const r = await request('company/connector/lookup-customer', { body: Object.fromEntries(new FormData(form)) });
      result.textContent = `Imported ${r.customer.displayName} (${r.customer.email}). No account was created.`;
    } catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
  });

  section.querySelector('#external-customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, button = form.querySelector('button');
    button.disabled = true;
    try {
      await request('company/connector/customer', { body: { ...Object.fromEntries(new FormData(form)), confirmed: true } });
      result.textContent = 'Customer linked. They can now import their service records from the workspace.';
    } catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
  });

  section.querySelector('#connector-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, button = form.querySelector('button.primary');
    button.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(form));
      const mapping = Object.fromEntries(MAP.map(([k]) => [k, f['map_' + k]]).filter(([, v]) => v));
      await request('company/connector', { body: { baseUrl: f.baseUrl, apiToken: f.apiToken, mapping, writesEnabled: form.elements.writesEnabled.checked, confirmed: true } });
      result.textContent = 'Saved. Linked customers can now import their service records from the workspace.';
      summary.textContent = 'Connected'; summary.classList.add('green');
      form.elements.apiToken.value = '';
    } catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
  });
}
