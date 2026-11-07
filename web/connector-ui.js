import { request, escapeHtml as q } from './client.js';
export async function mountConnector(app, members) {
  const c = await request('company/connector');
  const section = document.createElement('section');
  section.className = 'panel content-panel';
  section.innerHTML = `<h2>Connect your service system</h2><p>Import service records and optionally send confirmed request actions to a gateway that supports safe retries. Calendar bookings stay in Continuum.</p><p data-connector-summary>${c.configured ? 'Gateway configured: ' + q(c.baseUrl) : 'No gateway configured.'}</p><p>Allowed gateway origins: ${q(c.allowedOrigins.join(', ') || 'Ask the server owner to configure PROVIDER_ALLOWED_ORIGINS.')}</p><form id="connector-form" autocomplete="off"><label>Gateway base URL<input name="baseUrl" type="url" autocomplete="off" required value="${q(c.baseUrl || '')}"></label><label>Gateway API token<input name="apiToken" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" required></label><label>JSON field mapping<textarea name="mapping" required>${q(JSON.stringify(c.mapping, null, 2))}</textarea></label><label class="privacy-check"><input type="checkbox" name="writesEnabled" ${c.writesEnabled ? 'checked' : ''}> Allow confirmed request actions to sync to this gateway</label><button class="button">Save connection</button></form><h3>Link a customer</h3><form id="external-customer-form"><label>Continuum account<select name="accountId">${members.map((m) => `<option value="${q(m.id)}">${q(m.name)} · ${q(m.email)}</option>`).join('')}</select></label><label>Customer ID in your service system<input name="externalId" required maxlength="200"></label><button class="button">Link customer</button></form><p role="status" id="connector-result"></p>`;
  app.querySelector('section.wrap').append(section);
  for (const [id, route] of [
    ['connector-form', 'company/connector'],
    ['external-customer-form', 'company/connector/customer'],
  ])
    section.querySelector('#' + id).addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button');
      button.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(event.target));
        if (body.mapping) {
          body.mapping = JSON.parse(body.mapping);
          body.writesEnabled = event.target.elements.writesEnabled.checked;
        }
        await request(route, { body: { ...body, confirmed: true } });
        section.querySelector('#connector-result').textContent =
          'Saved. Linked customers can now import their service records from the workspace.';
        if (route === 'company/connector') {
          section.querySelector('[data-connector-summary]').textContent =
            'Gateway configured: ' + body.baseUrl;
        }
        if (event.target.elements.apiToken) event.target.elements.apiToken.value = '';
      } catch (e) {
        section.querySelector('#connector-result').textContent = e.message;
      } finally {
        button.disabled = false;
      }
    });
}
