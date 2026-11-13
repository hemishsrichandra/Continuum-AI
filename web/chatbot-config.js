// Owner UI: support services. Everything the server stores as lists or JSON is edited with tags, rows and checkboxes.
import { request, escapeHtml as q } from './client.js';
import { chipsField, rowsField } from './form-kit.js';

const ACTIONS = [
  ['request', 'Create requests'], ['requirement', 'Record requirements'], ['book', 'Book visits'],
  ['cancel', 'Cancel visits'], ['handoff', 'Hand over to a specialist'], ['outcome', 'Record whether a fix worked'],
];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 49);

export async function mountChatbotConfig(host) {
  const { chatbots } = await request('company/chatbots');
  const draw = async () => {
    const fresh = (await request('company/chatbots')).chatbots;
    host.innerHTML = `<div class="hub-section-head"><div><h2>AI services</h2><p>Each service has its own cases, questions and reviewed solutions. Changes apply to future conversations; earlier attempts keep the steps the customer was shown.</p></div><button class="button primary" data-new>+ Add a service</button></div>
      <div class="service-grid">${fresh.map((b) => `<article class="service-card ${b.active ? '' : 'is-off'}">
        <div class="service-top"><h3>${q(b.name)}</h3><span class="pill ${b.active ? 'green' : ''}">${b.active ? 'Active' : 'Paused'}</span></div>
        <p>${q(b.purpose)}</p>
        <ul class="tag-list" aria-label="Topics">${b.supportedTopics.slice(0, 8).map((t) => `<li>${q(t)}</li>`).join('')}${b.supportedTopics.length > 8 ? `<li class="more">+${b.supportedTopics.length - 8}</li>` : ''}</ul>
        <p class="muted small">${b.diagnosticSchema?.length || 0} question${(b.diagnosticSchema?.length || 0) === 1 ? '' : 's'} asked · ${b.playbooks.length} standard playbook${b.playbooks.length === 1 ? '' : 's'}</p>
        <div class="actions"><button class="button small" data-edit="${q(b.id)}">Edit service</button></div></article>`).join('')}</div>
      <p role="status" data-result></p>`;
    host.querySelector('[data-new]').addEventListener('click', () => newService(fresh));
    host.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => editService(fresh.find((b) => b.id === button.dataset.edit))));
  };

  const say = (text) => { const r = host.querySelector('[data-result]'); if (r) r.textContent = text; };

  function newService(list) {
    const dialog = document.createElement('dialog');
    dialog.className = 'editor-dialog small';
    dialog.setAttribute('aria-labelledby', 'new-service-title');
    dialog.innerHTML = `<form><h2 id="new-service-title">Add a service</h2><p class="muted">The new service starts with the configuration you pick, which you can change afterwards.</p>
      <label>Name<input name="name" required maxlength="100"></label>
      <label>Start from<select name="template">${list.map((b) => `<option value="${q(b.id)}">${q(b.name)}</option>`).join('')}</select></label>
      <p role="alert" data-error></p>
      <div class="actions"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Create service</button></div></form>`;
    wire(dialog, async (form, error) => {
      const f = Object.fromEntries(new FormData(form));
      const body = { ...list.find((b) => b.id === f.template), name: f.name };
      delete body.id; delete body.revision;
      try { await request('company/chatbots', { body }); dialog.close(); await draw(); say('Service created.'); } catch (e) { error(e.message); }
    });
  }

  function editService(b) {
    const topics = chipsField({ label: 'Topics this service handles', values: b.supportedTopics, placeholder: 'e.g. screen, battery, vpn', hint: 'Requests about these topics go to this service.' });
    const urgent = chipsField({ label: 'Hand over to a person straight away for', values: b.escalationRules.immediateTopics, placeholder: 'e.g. smoke, burning', hint: 'Safety words that skip suggestions entirely.' });
    const schema = rowsField({
      label: 'What we ask customers', hint: 'Customers are only asked for required details we do not already know.',
      columns: [{ key: 'key', label: 'Short name', placeholder: 'device' }, { key: 'label', label: 'Question shown', placeholder: 'Which device model?' }, { key: 'help', label: 'Example (optional)', placeholder: 'Model X, Windows 11' }, { key: 'options', label: 'Fixed choices (optional)', placeholder: 'Windows, macOS, Linux' }, { key: 'required', label: 'Required', type: 'checkbox' }],
      rows: (b.diagnosticSchema || []).map((f) => ({ ...f, options: (f.options || []).join(', ') })), addLabel: '+ Add a question', max: 20,
    });
    const playbooks = [];
    const pbHost = document.createElement('div');
    pbHost.className = 'playbooks';
    const addPlaybook = (p = { id: '', version: 1, topics: [], steps: '' }) => {
      const wrap = document.createElement('fieldset');
      wrap.className = 'playbook';
      const topicsField = chipsField({ label: 'Used for', values: p.topics, placeholder: 'e.g. wifi, offline' });
      wrap.innerHTML = `<legend>${p.id ? q(p.id) : 'New playbook'} <span class="pill">version ${q(p.version)}</span></legend><label>Name<input data-f="id" value="${q(p.id)}" maxlength="100" ${p.id ? 'readonly' : ''} required></label><label>Steps for the customer<textarea data-f="steps" rows="4" maxlength="3000" required>${q(p.steps)}</textarea></label><label>Only applies to (optional)<input data-f="environment" value="${q(p.environment || '')}" maxlength="500" placeholder="e.g. Windows 11"></label><button type="button" class="button small danger-ghost" data-rm>Remove playbook</button>`;
      wrap.querySelector('[data-f="environment"]').closest('label').before(topicsField.el);
      wrap.querySelector('[data-rm]').addEventListener('click', () => { playbooks.splice(playbooks.indexOf(entry), 1); wrap.remove(); });
      const entry = { wrap, topicsField, version: p.version };
      playbooks.push(entry);
      pbHost.append(wrap);
    };
    b.playbooks.forEach(addPlaybook);
    const actions = new Set(b.allowedActions);
    const dialog = document.createElement('dialog');
    dialog.className = 'editor-dialog';
    dialog.setAttribute('aria-labelledby', 'edit-service-title');
    dialog.innerHTML = `<form><h2 id="edit-service-title">Edit ${q(b.name)}</h2>
      <section class="editor-block"><h3>About</h3><label>Name<input name="name" value="${q(b.name)}" required maxlength="100"></label><label>Purpose<textarea name="purpose" required rows="2">${q(b.purpose)}</textarea></label>
        <label class="switch"><input name="active" type="checkbox" ${b.active ? 'checked' : ''}> Service is active</label></section>
      <section class="editor-block" data-slot="topics"><h3>Topics</h3></section>
      <section class="editor-block" data-slot="schema"><h3>Questions</h3></section>
      <section class="editor-block"><h3>Standard playbooks</h3><p class="muted">The first suggestion a customer sees, before any learned fix applies.</p><div data-slot="playbooks"></div><button type="button" class="button small" data-add-playbook>+ Add a playbook</button></section>
      <section class="editor-block"><h3>What the assistant may do</h3><div class="check-grid">${ACTIONS.map(([k, label]) => `<label class="privacy-check"><input type="checkbox" name="act" value="${k}" ${actions.has(k) ? 'checked' : ''}> ${q(label)}</label>`).join('')}</div></section>
      <section class="editor-block" data-slot="urgent"><h3>Escalation</h3></section>
      <label>Where customers are told to go for a person<input name="route" value="${q(b.escalationRules.supportRoute)}" required maxlength="1000"></label>
      <p role="alert" data-error></p>
      <div class="actions sticky-actions"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Save service</button></div></form>`;
    dialog.querySelector('[data-slot=topics]').append(topics.el);
    dialog.querySelector('[data-slot=schema]').append(schema.el);
    dialog.querySelector('[data-slot=playbooks]').append(pbHost);
    dialog.querySelector('[data-slot=urgent]').append(urgent.el);
    dialog.querySelector('[data-add-playbook]').addEventListener('click', () => { addPlaybook(); pbHost.lastElementChild.querySelector('input').focus(); });
    wire(dialog, async (form, error) => {
      const f = new FormData(form);
      const rows = schema.get();
      const diagnosticSchema = rows.map((r) => {
        const key = r.key ? slug(r.key) : slug(r.label);
        const options = r.options ? r.options.split(',').map((x) => x.trim()).filter(Boolean) : [];
        return { key, label: r.label, required: r.required, ...(r.help && { help: r.help }), ...(options.length && { options }) };
      });
      if (diagnosticSchema.some((d) => !d.key || !d.label)) return error('Give every question a short name and the question to show.');
      const pbs = playbooks.map((p) => ({ id: p.wrap.querySelector('[data-f=id]').value.trim(), version: p.version, topics: p.topicsField.get(), steps: p.wrap.querySelector('[data-f=steps]').value.trim(), ...(p.wrap.querySelector('[data-f=environment]').value.trim() && { environment: p.wrap.querySelector('[data-f=environment]').value.trim() }) }));
      if (pbs.some((p) => !p.id || !p.steps)) return error('Every playbook needs a name and steps.');
      const body = { ...b, name: f.get('name'), purpose: f.get('purpose'), active: form.elements.active.checked, supportedTopics: topics.get(), diagnosticSchema, requiredContext: diagnosticSchema.filter((d) => d.required).map((d) => d.key), allowedActions: f.getAll('act'), escalationRules: { immediateTopics: urgent.get(), supportRoute: f.get('route') }, playbooks: pbs };
      try { await request('company/chatbots', { body }); dialog.close(); await draw(); say('Service saved.'); } catch (e) { error(e.message); }
    });
  }

  /** Common dialog plumbing: submit handler with a disabled button and an inline error, close on Cancel. */
  function wire(dialog, onSubmit) {
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const errorBox = dialog.querySelector('[data-error]');
    const error = (text) => { errorBox.textContent = text; };
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button:not([type=button])');
      submit.disabled = true; error('');
      try { await onSubmit(form, error); } finally { submit.disabled = false; }
    });
    dialog.showModal();
  }

  void chatbots;
  await draw();
}
