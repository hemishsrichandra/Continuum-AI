// Owner UI: company knowledge data sources (CSV, SQLite, REST, PostgreSQL) with
// field mapping, dry-run preview, sync and sync health. Connection secrets are
// write-only: the server never returns them.
import { request, escapeHtml as q, formatDate } from './client.js';

const FIELDS = [['externalId', 'Record ID', true], ['title', 'Title', true], ['symptoms', 'Symptoms', true], ['steps', 'Solution steps', true], ['applicability', 'Applies to (text)', false], ['safety', 'Safety restrictions', false], ['updatedAt', 'Last updated', false]];
const TYPE_LABEL = { csv_sync: 'CSV upload', sqlite: 'SQLite file', rest_api: 'REST API (JSON)', postgres: 'PostgreSQL' };

export async function mountDataSources(app) {
  const data = await request('company/data-sources');
  const section = document.createElement('section');
  section.className = 'panel content-panel';
  section.id = 'data-sources';
  const health = (s) => `<span class="pill ${s.status === 'ok' ? 'green' : s.status === 'error' ? 'warn' : ''}">${q(s.status)}</span>`;
  section.innerHTML = `<h2>Data sources</h2>
    <p>Bring your existing fixes into this service. They stay inside your company, are labelled as imported, and never overwrite fixes your specialists reviewed or revised.</p>
    <div class="dash-grid">${Object.entries(data.availability).map(([type, a]) => `<div class="dash-stat ${a.available ? 'ok' : ''}"><b>${q(TYPE_LABEL[type])}</b>${a.available ? 'Available' : 'Not available'}<small>${q(a.reason || a.note || '')}</small></div>`).join('')}</div>
    ${data.sources.length ? data.sources.map((s) => `<article class="card" data-source="${q(s.id)}"><span class="pill">${q(TYPE_LABEL[s.sourceType])}</span> ${health(s)} ${s.declaredVerified ? '<span class="pill blue">Owner-declared verified</span>' : '<span class="pill">Unverified</span>'}<h3>${q(s.name)}</h3>
      <p class="muted">Service: ${q(data.chatbots.find((b) => b.id === s.chatbotId)?.name || s.chatbotId)} · Last sync: ${s.lastSyncedAt ? q(formatDate(s.lastSyncedAt, true)) : 'never'} · ${s.syncIntervalHours ? 'Automatic every ' + q(s.syncIntervalHours) + ' h, next ' + q(formatDate(s.nextSyncAt, true)) : 'Manual sync only'}</p>
      ${s.lastSyncResult ? `<p>Last result: ${q(s.lastSyncResult.inserted)} added · ${q(s.lastSyncResult.updated)} updated · ${q(s.lastSyncResult.unchanged)} unchanged · ${q(s.lastSyncResult.skippedLocallyReviewed)} kept (locally reviewed) · ${q(s.lastSyncResult.invalid + s.lastSyncResult.duplicates)} skipped · ${q(s.lastSyncResult.flaggedForReview)} flagged for review</p>` : ''}
      ${s.lastError ? `<p class="notice error">${q(s.lastError)}</p>` : ''}${s.availability && !s.availability.available ? `<p class="notice">${q(s.availability.reason)}</p>` : ''}
      <div class="actions"><button class="button small" data-preview-source="${q(s.id)}">Preview (dry run)</button><button class="button small primary" data-sync-source="${q(s.id)}">Sync now</button><button class="button small" data-delete-source="${q(s.id)}">Remove</button></div><div data-source-result role="status"></div></article>`).join('') : '<p>No data source configured yet.</p>'}
    <details><summary>Add a data source</summary><ol class="wiz-progress" aria-label="Steps"></ol><form id="source-form" autocomplete="off">
      <label>Name<input name="name" required maxlength="100"></label>
      <label>Service<select name="chatbotId">${data.chatbots.map((b) => `<option value="${q(b.id)}">${q(b.name)}</option>`).join('')}</select></label>
      <label>Source type<select name="sourceType">${data.sourceTypes.map((t) => `<option value="${q(t)}">${q(TYPE_LABEL[t])}</option>`).join('')}</select></label>
      <div data-conn="csv_sync"><label>CSV content (first row = column names)<textarea name="csv" rows="6" placeholder="id,title,symptoms,steps"></textarea></label></div>
      <div data-conn="sqlite" hidden><label>Database file path (must be in an allowed directory)<input name="path"></label><label>Table<input name="table"></label></div>
      <div data-conn="rest_api" hidden><label>HTTPS URL (origin must be allowed by the server owner)<input name="url" type="url"></label><label>Bearer token (optional, stored encrypted)<input name="token" type="password" autocomplete="new-password"></label><label>Records path (optional, e.g. data.items)<input name="recordsPath"></label></div>
      <div data-conn="postgres" hidden><label>Connection URI (stored encrypted)<input name="uri" type="password" autocomplete="new-password"></label><label>Schema (optional)<input name="schema"></label><label>Table<input name="table_pg"></label></div>
      <h3>Map source columns to passport fields</h3><div class="mapping-grid">${FIELDS.map(([k, label, req]) => `<label>${q(label)}${req ? ' *' : ''}<input name="map_${q(k)}" ${req ? 'required' : ''} pattern="[A-Za-z_][A-Za-z0-9_.]*" placeholder="column or property"></label>`).join('')}</div>
      <h3>Diagnostic fields (optional)</h3><p class="muted">Map columns that say which environments a fix applies to. Keys must exist in the service’s diagnostic schema.</p>
      <label>Diagnostic mapping, one per line: <code>field=column</code><textarea name="diagnostics" rows="3" placeholder="device=device_model&#10;region=region"></textarea></label>
      <label>Automatic sync (hours, 1–720; leave empty for manual only)<input name="syncIntervalHours" type="number" min="1" max="720" step="1"></label>
      <label class="privacy-check"><input type="checkbox" name="declaredVerified"> I confirm this source contains reviewed, trusted solutions (raises the initial confidence of imports; they are still not customer-confirmed).</label>
      <label class="privacy-check"><input type="checkbox" name="authoritativeSnapshot"> This source always lists every fix I want to keep. If a fix disappears from it, stop recommending that fix.</label>
      <button class="button primary">Save data source</button></form></details><p role="status" id="source-status"></p>`;
  app.querySelector('section.wrap').append(section);
  const status = (text) => { section.querySelector('#source-status').textContent = text; };
  const form = section.querySelector('#source-form');
  wizardize(form, section.querySelector('.wiz-progress'));
  const toggle = () => form.querySelectorAll('[data-conn]').forEach((d) => { d.hidden = d.dataset.conn !== form.elements.sourceType.value; });
  form.elements.sourceType.addEventListener('change', toggle);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const type = f.sourceType;
    const connection = type === 'csv_sync' ? { csv: f.csv } : type === 'sqlite' ? { path: f.path, table: f.table } : type === 'rest_api' ? { url: f.url, ...(f.token && { token: f.token }), ...(f.recordsPath && { recordsPath: f.recordsPath }) } : { uri: f.uri, ...(f.schema && { schema: f.schema }), table: f.table_pg };
    const fields = Object.fromEntries(FIELDS.map(([k]) => [k, f['map_' + k]]).filter(([, v]) => v));
    const diagnostics = Object.fromEntries((f.diagnostics || '').split('\n').map((l) => l.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
    try {
      await request('company/data-sources', { body: { confirmed: true, name: f.name, chatbotId: f.chatbotId, sourceType: type, connection, fieldMapping: { fields, diagnostics }, declaredVerified: form.elements.declaredVerified.checked, authoritativeSnapshot: form.elements.authoritativeSnapshot.checked, syncIntervalHours: f.syncIntervalHours ? Number(f.syncIntervalHours) : null } });
      location.reload();
    } catch (e) { status(e.message); }
  });
  section.addEventListener('click', async (event) => {
    const b = event.target.closest('button[data-preview-source],button[data-sync-source],button[data-delete-source]');
    if (!b) return;
    const id = b.dataset.previewSource || b.dataset.syncSource || b.dataset.deleteSource;
    const out = b.closest('article').querySelector('[data-source-result]');
    b.disabled = true;
    try {
      if (b.dataset.previewSource) {
        const r = await request(`company/data-sources/${encodeURIComponent(id)}/preview`, { body: {} });
        out.innerHTML = `<p><b>Dry run:</b> ${q(r.total)} records · ${q(r.valid)} valid · ${q(r.invalid)} invalid · ${q(r.flaggedForReview)} would be flagged · ${q(r.withRedactions)} with personal data removed. Nothing was saved.</p><div class="table-scroll"><table><thead><tr><th>ID</th><th>Title</th><th>C_init</th><th>Issues</th></tr></thead><tbody>${r.sample.slice(0, 10).map((x) => `<tr><td>${q(x.externalId)}</td><td>${q(x.title)}</td><td>${q(x.cInit)}</td><td>${q([...x.issues, ...x.hazards].join('; ') || '—')}</td></tr>`).join('')}</tbody></table></div>`;
      } else if (b.dataset.syncSource) {
        const r = await request(`company/data-sources/${encodeURIComponent(id)}/sync`, { body: { confirmed: true } });
        out.textContent = `Synced: ${r.result.inserted} added, ${r.result.updated} updated, ${r.result.unchanged} unchanged, ${r.result.skippedLocallyReviewed} kept as reviewed.`;
      } else { await request(`company/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }); location.reload(); return; }
    } catch (e) { out.textContent = e.message; }
    b.disabled = false;
  });
}

/** Turn the long form into four short steps. The fields, names and validation are unchanged. */
function wizardize(form, progress) {
  const kids = [...form.children];
  const save = kids.pop();
  const groups = [
    ['What are you connecting?', kids.slice(0, 3)],
    ['How do we reach it?', kids.slice(3, 7)],
    ['Match your columns', kids.slice(7, 12)],
    ['Final options', kids.slice(12)],
  ];
  const steps = groups.map(([title, nodes], i) => {
    const step = document.createElement('div');
    step.className = 'wiz-step';
    step.hidden = i !== 0;
    const heading = document.createElement('h3');
    heading.className = 'wiz-title';
    heading.textContent = title;
    step.append(heading, ...nodes);
    return step;
  });
  const nav = document.createElement('div');
  nav.className = 'actions wiz-nav';
  const back = Object.assign(document.createElement('button'), { type: 'button', className: 'button small', textContent: 'Back' });
  const next = Object.assign(document.createElement('button'), { type: 'button', className: 'button small primary', textContent: 'Next' });
  nav.append(back, next, save);
  form.replaceChildren(...steps, nav);
  let at = 0;
  progress.innerHTML = groups.map(([title], i) => `<li>${i + 1}. ${title}</li>`).join('');
  const show = (n) => {
    at = n;
    steps.forEach((s, i) => { s.hidden = i !== at; });
    progress.querySelectorAll('li').forEach((li, i) => { li.dataset.state = i === at ? 'now' : i < at ? 'done' : ''; });
    back.hidden = at === 0;
    next.hidden = at === steps.length - 1;
    save.hidden = at !== steps.length - 1;
  };
  back.addEventListener('click', () => show(at - 1));
  next.addEventListener('click', () => {
    const fields = [...steps[at].querySelectorAll('input, select, textarea')].filter((el) => !el.closest('[hidden]'));
    const bad = fields.find((el) => !el.checkValidity());
    if (bad) return bad.reportValidity();
    show(at + 1);
  });
  show(0);
}
