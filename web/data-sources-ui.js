// Owner UI: company knowledge sources (CSV, CSV file, SQLite, PostgreSQL, MySQL/MariaDB, SQL Server, REST) with an edit screen, field mapping,
// connection test, preview (dry run), sync / full re-sync, pause, resume, cancel, per-source status and run history, source conflicts, and
// shadow mode. Credentials are write-only: the server never returns them, so an edit form shows only that one is stored and a blank field keeps it.
import { request, escapeHtml as q, formatDate } from './client.js';
import { rowsField, badges, confirmDialog, noteDialog } from './form-kit.js';

const FIELDS = [
  ['externalId', 'Record ID', true], ['title', 'Title', true], ['symptoms', 'Symptoms', true], ['steps', 'Solution steps', true],
  ['problemCategory', 'Problem category', false], ['productFamily', 'Product family', false], ['model', 'Model(s), separated by | or ;', false],
  ['applicability', 'Applies to (text)', false], ['safety', 'Safety restrictions', false], ['updatedAt', 'Last updated (enables incremental sync)', false], ['sourceVersion', 'Source version / etag', false],
];
const TYPE_LABEL = { csv_sync: 'CSV (pasted or uploaded)', csv_file: 'CSV file on the server (streamed)', sqlite: 'SQLite file', rest_api: 'REST API (JSON)', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mssql: 'SQL Server' };
// Connection settings per type: [key, label, secret, type, help]. Secrets are never prefilled.
const DB_FIELDS = [['uri', 'Connection URI (stored encrypted)', true], ['schema', 'Schema / database owner (optional)', false], ['table', 'Table', false]];
const CONN = {
  csv_file: [['path', 'Path of the CSV file (inside a folder the server owner allowed)', false]],
  sqlite: [['path', 'Database file path (must be in an allowed directory)', false], ['table', 'Table', false]],
  postgres: DB_FIELDS, mysql: DB_FIELDS, mssql: DB_FIELDS,
  rest_api: [
    ['url', 'HTTPS URL (stored encrypted)', true, 'url'], ['token', 'Bearer token (optional, stored encrypted)', true, 'password'], ['recordsPath', 'Records path (optional, e.g. data.items)', false],
    ['pagination', 'Paging style', false, 'select:none|page|offset|cursor|next_link'], ['pageSize', 'Page size (10 to 5000)', false, 'number'], ['limitParam', 'Page-size parameter (default limit)', false],
    ['pageParam', 'Page parameter (page style, e.g. page)', false], ['offsetParam', 'Offset parameter (offset style, default offset)', false],
    ['cursorParam', 'Cursor parameter (cursor style)', false], ['nextCursorPath', 'Where the next cursor is in the response (e.g. meta.next)', false],
    ['nextLinkPath', 'Where the next link is (e.g. links.next, or header:link)', false], ['sinceParam', '“Modified since” parameter (enables incremental sync)', false],
  ],
};
const input = (type, f, value = '', secretSet = false) => {
  const [key, label, secret, kind = 'text'] = f;
  const name = `c_${type}_${key}`;
  const hint = secret && secretSet ? ' <span class="pill green">stored</span>' : '';
  if (kind.startsWith('select:')) return `<label>${q(label)}<select name="${name}">${kind.slice(7).split('|').map((o) => `<option ${o === (value || 'none') ? 'selected' : ''}>${q(o)}</option>`).join('')}</select></label>`;
  return `<label>${q(label)}${hint}<input name="${name}" type="${kind}" ${secret ? 'autocomplete="new-password"' : ''} value="${secret ? '' : q(value)}" ${secret && secretSet ? 'placeholder="Stored. Leave blank to keep it."' : ''}></label>`;
};
const pillTone = (s) => ({ fresh: 'green', error: 'warn', stale: 'warn', partial: 'warn', paused: 'warn' }[s] || '');

export async function mountDataSources(host) {
  const [data, session] = await Promise.all([request('company/data-sources'), request('auth/session').catch(() => ({}))]);
  const section = document.createElement('section');
  section.className = 'hub-card';
  section.id = 'data-sources';
  const runBadge = (r) => `<tr><td>${q(formatDate(r.startedAt, true))}</td><td>${q(r.mode)}${r.resumed ? ' (resumed)' : ''}</td><td>${q(r.trigger)}</td><td>${q(r.status)}</td><td>${q([r.counts.inserted && r.counts.inserted + ' new', r.counts.updated && r.counts.updated + ' updated', r.counts.invalid && r.counts.invalid + ' invalid'].filter(Boolean).join(', ') || (r.error ? r.error : '—'))}</td></tr>`;
  const summaryOf = (s) => { const c = s.connection?.summary || {}; return [c.file && 'File ' + c.file, c.endpoint, c.host && c.host + (c.port ? ':' + c.port : '') + (c.database ? ' / ' + c.database : ''), c.bytes != null && Math.round(c.bytes / 1024) + ' KB, ' + c.rows + ' rows'].filter(Boolean).join(' · '); };
  const card = (s) => `<article class="card" data-source="${q(s.id)}"><span class="pill">${q(TYPE_LABEL[s.sourceType])}</span> <span class="pill ${pillTone(s.freshness.state)}" data-freshness="${q(s.freshness.state)}">${q(s.freshness.label)}</span> <span class="pill">${q(s.status === 'deferred' ? 'paused part-way, resumable' : s.status)}</span> ${s.declaredVerified ? '<span class="pill blue">Owner-declared verified</span>' : '<span class="pill">Unverified: imports wait for review</span>'} <span class="pill">${s.incremental.enabled && s.incremental.supported ? 'Incremental' + (s.incremental.highWater ? ' from ' + q(String(s.incremental.highWater).slice(0, 19)) : '') : 'Full sync'}</span><h3>${q(s.name)}</h3>
      <p class="muted">Service: ${q(data.chatbots.find((b) => b.id === s.chatbotId)?.name || s.chatbotId)} · ${q(summaryOf(s))} · credentials ${s.hasConnection ? 'stored and hidden' : 'missing'}</p>
      <p class="muted">Last completed sync: ${s.lastSyncedAt ? q(formatDate(s.lastSyncedAt, true)) : 'never'} · ${s.syncIntervalHours ? 'Automatic every ' + q(s.syncIntervalHours) + ' h, next ' + q(formatDate(s.nextSyncAt, true)) : 'Manual sync only'}${s.progress ? ` · progress saved: ${q(s.progress.processed)} records read (${q(s.progress.mode)} scan)` : ''}${s.consecutiveFailures ? ` · ${q(s.consecutiveFailures)} failed attempt(s) in a row` : ''}</p>
      ${s.lastSyncResult ? `<div data-last-result><span class="muted small">Last run</span>${syncBadges(s.lastSyncResult)}${s.lastSyncResult.modeReason ? `<p class="muted small">${q(s.lastSyncResult.modeReason)}</p>` : ''}</div>` : ''}
      ${s.lastError ? `<p class="notice error">${q(s.lastError)}</p>` : ''}${s.availability && !s.availability.available ? `<p class="notice">${q(s.availability.reason)}</p>` : ''}
      <div class="actions split-actions"><span><button class="button small primary" data-sync-source="${q(s.id)}" ${s.paused || s.syncing ? 'disabled' : ''}>${s.resumable ? 'Resume sync' : 'Sync now'}</button><button class="button small" data-full-source="${q(s.id)}" ${s.paused || s.syncing ? 'disabled' : ''}>Full re-sync</button><button class="button small" data-preview-source="${q(s.id)}">Preview first</button><button class="button small" data-test-source="${q(s.id)}">Test connection</button><button class="button small" data-edit-source="${q(s.id)}" ${s.syncing ? 'disabled title="Cancel or pause the running sync first"' : ''}>Edit</button><button class="button small" data-pause-source="${q(s.id)}" data-paused="${s.paused ? 'true' : 'false'}">${s.paused ? 'Resume source' : 'Pause'}</button>${s.syncing || s.resumable ? `<button class="button small" data-cancel-source="${q(s.id)}">Cancel</button>` : ''}</span><button class="button small danger-ghost" data-delete-source="${q(s.id)}">Remove</button></div><div data-source-result role="status"></div>
      ${s.recentRuns?.length ? `<details><summary>Recent runs (${q(s.recentRuns.length)})</summary><div class="table-scroll"><table><thead><tr><th>Started</th><th>Mode</th><th>By</th><th>Result</th><th>Details</th></tr></thead><tbody>${s.recentRuns.map(runBadge).join('')}</tbody></table></div></details>` : ''}</article>`;
  section.innerHTML = `<div class="hub-section-head"><div><h2>Knowledge sources</h2><p>Bring your existing fixes into a service. They stay inside your company, are labelled as imported, wait for review unless you declare the source verified, and never overwrite fixes your specialists reviewed or revised.</p></div><button class="button primary" data-add-source>+ Connect a source</button></div>
    ${data.sources.length ? data.sources.map(card).join('') : '<p class="empty">No knowledge source connected yet. Connect one to import fixes you already have.</p>'}
    <details class="infra"><summary>Connection types this server supports and its limits</summary><ul class="infra-list">${Object.entries(data.availability).map(([type, a]) => `<li><b>${q(TYPE_LABEL[type])}</b> <span class="pill ${a.available ? 'green' : ''}">${a.available ? 'Available' : 'Not available'}</span>${a.reason || a.note ? `<small>${q(a.reason || a.note)}</small>` : ''}</li>`).join('')}</ul><p class="muted small">Per run: ${q(data.limits.batchSize)} records per batch, pausing after ${q(data.limits.maxRecordsPerRun)} records (it resumes from a saved checkpoint, nothing is dropped). Pasted CSV up to ${q(Math.round(data.limits.csvMaxBytes / 1048576))} MB; CSV files up to ${q(Math.round(data.limits.csvFileMaxBytes / 1048576))} MB; web responses up to ${q(Math.round(data.limits.maxResponseBytes / 1048576))} MB.</p></details>
    ${websites(data.allowedWebsites)}
    <dialog class="editor-dialog" id="source-dialog" aria-labelledby="source-title"><div class="dialog-head"><h2 id="source-title">Connect a knowledge source</h2><button type="button" class="button small" data-close-source>Cancel</button></div><ol class="wiz-progress" aria-label="Steps"></ol><form id="source-form" autocomplete="off">
      <label data-step="1">Name<input name="name" required maxlength="100"></label>
      <label data-step="1">Service<select name="chatbotId">${data.chatbots.map((b) => `<option value="${q(b.id)}" ${b.id === session.profile?.chatbotId ? 'selected' : ''}>${q(b.name)}</option>`).join('')}</select></label>
      <label data-step="1">Source type<select name="sourceType">${data.sourceTypes.map((t) => `<option value="${q(t)}">${q(TYPE_LABEL[t])}</option>`).join('')}</select></label>
      <div data-step="2" data-conn="csv_sync"><label>CSV file (first row = column names, up to ${q(Math.round((data.csvMaxBytes || 1048576) / 1048576))} MB)<input type="file" data-csv-file accept=".csv,text/csv"></label><small class="muted" data-csv-note></small><details><summary>Or paste the CSV</summary><label>CSV content<textarea name="csv" rows="6" placeholder="id,title,symptoms,steps"></textarea></label></details></div>
      ${Object.entries(CONN).map(([type, fields]) => `<div data-step="2" data-conn="${type}" hidden>${fields.map((f) => input(type, f)).join('')}</div>`).join('')}
      <div data-step="3"><h3>Map source columns to passport fields</h3><div class="mapping-grid">${FIELDS.map(([k, label, req]) => `<label>${q(label)}${req ? ' *' : ''}<input name="map_${q(k)}" ${req ? 'required' : ''} pattern="[A-Za-z_][A-Za-z0-9_.]*" placeholder="column or property"></label>`).join('')}</div></div>
      <div data-step="3"><h3>Diagnostic fields (optional)</h3><p class="muted">Map columns that say which environments a fix applies to. Keys must exist in the service’s diagnostic schema.</p><div data-diag></div></div>
      <label data-step="4">Automatic sync (hours, 1–720; leave empty for manual only)<input name="syncIntervalHours" type="number" min="1" max="720" step="1"></label>
      <label data-step="4" class="privacy-check"><input type="checkbox" name="incrementalEnabled"> Use incremental sync when this source can prove what changed (it needs the “Last updated” column, or a “modified since” parameter for REST). Otherwise every sync is a full sync and says so.</label>
      <label data-step="4">Mark records stale when absent from a complete sync for (days, optional)<input name="staleAfterDays" type="number" min="1" max="3650" step="1"></label>
      <label data-step="4" class="privacy-check"><input type="checkbox" name="declaredVerified"> I confirm this source contains reviewed, trusted solutions (raises the initial confidence of imports; they are still not customer-confirmed). Leave unticked and every import waits for review.</label>
      <label data-step="4" class="privacy-check"><input type="checkbox" name="authoritativeSnapshot"> This source always lists every fix I want to keep. If a fix disappears from a complete sync, stop recommending it.</label>
      <button class="button primary">Save data source</button></form><p role="alert" id="source-status"></p></dialog>`;
  host.append(section);
  const makeDiag = (rows = []) => rowsField({ label: 'Which service questions do your columns answer?', hint: 'Optional. Lets a fix say which environments it applies to.', columns: [{ key: 'field', label: 'Service question (short name)', placeholder: 'device' }, { key: 'column', label: 'Column in your source', placeholder: 'device_model' }], rows, addLabel: '+ Add a match', max: 20 });
  let diag = makeDiag();
  section.querySelector('[data-diag]').replaceWith(diag.el);
  const resetDiag = (rows = []) => { const fresh = makeDiag(rows); diag.el.replaceWith(fresh.el); diag = fresh; };
  const dialog = section.querySelector('#source-dialog');
  const form = section.querySelector('#source-form');
  const status = (text) => { section.querySelector('#source-status').textContent = text; };
  let editing = null;
  const toggle = () => form.querySelectorAll('[data-conn]').forEach((d) => { d.hidden = d.dataset.conn !== form.elements.sourceType.value; });
  const stepper = wizardize(form, section.querySelector('.wiz-progress'));
  form.elements.sourceType.addEventListener('change', toggle);
  section.querySelector('[data-add-source]').addEventListener('click', () => { editing = null; form.reset(); resetDiag(); section.querySelector('#source-title').textContent = 'Connect a knowledge source'; form.elements.sourceType.disabled = false; form.elements.chatbotId.disabled = false; toggle(); stepper.show(0); status(''); dialog.showModal(); });
  section.querySelector('[data-close-source]').addEventListener('click', () => dialog.close());
  // A chosen CSV file fills the same field as pasting: the content is sent once, when the source is saved.
  section.querySelector('[data-csv-file]').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    const note = section.querySelector('[data-csv-note]');
    if (!file) return;
    if (file.size > (data.csvMaxBytes || 1048576)) { note.textContent = `“${file.name}” is larger than the limit. Use a CSV file source for large files, or a database.`; event.target.value = ''; return; }
    form.elements.csv.value = await file.text();
    const header = form.elements.csv.value.split(/\r?\n/, 1)[0];
    note.textContent = `Loaded ${file.name} (${Math.max(0, form.elements.csv.value.split(/\r?\n/).filter(Boolean).length - 1)} rows). Columns: ${header.slice(0, 200)}`;
  });
  section.querySelector('[data-add-origin]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const out = section.querySelector('[data-origin-status]');
    try { await request('company/data-sources/origins', { body: { confirmed: true, origin: event.target.elements.origin.value } }); location.reload(); } catch (e) { out.textContent = e.message; }
  });
  section.querySelectorAll('[data-remove-origin]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Remove this website?', body: 'Sources that read from it will fail until you approve it again.', confirm: 'Remove website', cancel: 'Keep it', danger: true }))) return;
    try { await request('company/data-sources/origins/remove', { body: { confirmed: true, origin: b.dataset.removeOrigin } }); location.reload(); } catch (e) { section.querySelector('[data-origin-status]').textContent = e.message; }
  }));

  // ----- edit: prefill everything except secrets
  function openEdit(s) {
    editing = s;
    form.reset();
    section.querySelector('#source-title').textContent = 'Edit “' + s.name + '”';
    form.elements.name.value = s.name;
    form.elements.chatbotId.value = s.chatbotId; form.elements.chatbotId.disabled = true;
    form.elements.sourceType.value = s.sourceType; form.elements.sourceType.disabled = true;
    toggle();
    for (const f of CONN[s.sourceType] || []) {
      const el = form.elements[`c_${s.sourceType}_${f[0]}`];
      if (!el) continue;
      if (f[2]) { el.value = ''; el.placeholder = s.connection.secretsSet?.[f[0]] ? 'Stored. Leave blank to keep it.' : ''; }
      else el.value = s.connection.settings?.[f[0]] ?? (s.connection.summary?.file && f[0] === 'path' ? '' : '');
    }
    if (s.sourceType === 'csv_sync') section.querySelector('[data-csv-note]').textContent = `Stored CSV: ${s.connection.summary?.rows ?? '?'} rows. Choose a file or paste to replace it; leave empty to keep it.`;
    for (const [k] of FIELDS) form.elements['map_' + k].value = s.fieldMapping.fields[k] || '';
    resetDiag(Object.entries(s.fieldMapping.diagnostics || {}).map(([field, column]) => ({ field, column })));
    form.elements.syncIntervalHours.value = s.syncIntervalHours ?? '';
    form.elements.incrementalEnabled.checked = s.incremental.enabled;
    form.elements.staleAfterDays.value = s.staleAfterDays ?? '';
    form.elements.declaredVerified.checked = s.declaredVerified;
    form.elements.authoritativeSnapshot.checked = s.authoritativeSnapshot;
    stepper.show(0);
    status(editing.sourceType === 'rest_api' || ['postgres', 'mysql', 'mssql'].includes(editing.sourceType) ? 'Credentials are stored encrypted and never shown. Leave a credential field blank to keep it. Changing the connection or mapping starts the next sync from the beginning.' : 'Changing the connection or mapping starts the next sync from the beginning.');
    dialog.showModal();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const type = editing ? editing.sourceType : f.sourceType;
    const connection = {};
    if (type === 'csv_sync') { if (f.csv) connection.csv = f.csv; }
    else for (const [key, , secret] of CONN[type]) {
      const v = (form.elements[`c_${type}_${key}`]?.value ?? '').trim();
      if (secret && !v) continue; // a blank credential keeps the stored one
      connection[key] = key === 'pagination' && v === 'none' ? '' : v;
    }
    const fields = Object.fromEntries(FIELDS.map(([k]) => [k, f['map_' + k]]).filter(([, v]) => v));
    const diagnostics = Object.fromEntries(diag.get().filter((r) => r.field && r.column).map((r) => [r.field, r.column]));
    const body = { confirmed: true, name: f.name, fieldMapping: { fields, diagnostics }, declaredVerified: form.elements.declaredVerified.checked, authoritativeSnapshot: form.elements.authoritativeSnapshot.checked, incrementalEnabled: form.elements.incrementalEnabled.checked, syncIntervalHours: f.syncIntervalHours ? Number(f.syncIntervalHours) : null, staleAfterDays: f.staleAfterDays ? Number(f.staleAfterDays) : null };
    if (editing) Object.assign(body, { id: editing.id }, Object.keys(connection).length && { connection });
    else Object.assign(body, { chatbotId: f.chatbotId, sourceType: type, connection });
    try { await request('company/data-sources', { body }); location.reload(); } catch (e) { status(e.message); }
  });

  section.addEventListener('click', async (event) => {
    const b = event.target.closest('button[data-preview-source],button[data-sync-source],button[data-full-source],button[data-delete-source],button[data-test-source],button[data-pause-source],button[data-edit-source],button[data-cancel-source]');
    if (!b) return;
    const id = b.dataset.previewSource || b.dataset.syncSource || b.dataset.fullSource || b.dataset.deleteSource || b.dataset.testSource || b.dataset.pauseSource || b.dataset.editSource || b.dataset.cancelSource;
    if (b.dataset.editSource) return openEdit(data.sources.find((s) => s.id === id));
    const out = b.closest('article').querySelector('[data-source-result]');
    b.disabled = true;
    try {
      if (b.dataset.testSource) {
        const r = await request(`company/data-sources/${encodeURIComponent(id)}/test`, { body: {} });
        out.innerHTML = `<p><b>${q(r.note)}</b> ${r.firstBatchRows ? q(r.firstBatchRows) + ' rows in the first batch, ' : ''}${q(r.ms)} ms.</p>${r.columns.length ? `<p class="muted small">Columns read: ${r.columns.map(q).join(', ')}</p>` : ''}<p class="muted small">Incremental sync: ${r.incremental.ok ? 'possible. ' : 'not available. '}${q(r.incremental.reason)}</p>`;
      } else if (b.dataset.pauseSource) {
        const paused = b.dataset.paused === 'true';
        await request(`company/data-sources/${encodeURIComponent(id)}/${paused ? 'resume' : 'pause'}`, { body: { confirmed: true } });
        location.reload();
        return;
      } else if (b.dataset.cancelSource) {
        if (!(await confirmDialog({ title: 'Cancel this sync?', body: 'A running sync stops after its current batch and its saved progress is discarded; the next sync starts from the beginning. Records already imported stay, and nothing is retired.', confirm: 'Cancel the sync', cancel: 'Keep going', danger: true }))) { b.disabled = false; return; }
        await request(`company/data-sources/${encodeURIComponent(id)}/cancel`, { body: { confirmed: true } });
        location.reload();
        return;
      } else if (b.dataset.previewSource) {
        const r = await request(`company/data-sources/${encodeURIComponent(id)}/preview`, { body: {} });
        out.innerHTML = `<p><b>Preview only. Nothing was saved.</b>${r.truncated ? ' Only the first ' + q(r.total) + ' records are shown.' : ''}</p>${badges([[r.total, 'records'], [r.valid, 'valid', 'good'], [r.invalid, 'invalid', r.invalid ? 'bad' : ''], [r.flaggedForReview, 'would need review', r.flaggedForReview ? 'warn' : ''], [r.withRedactions, 'personal data removed']])}<div class="table-scroll"><table><thead><tr><th>ID</th><th>Title</th><th>C_init</th><th>Issues</th></tr></thead><tbody>${r.sample.slice(0, 10).map((x) => `<tr><td>${q(x.externalId)}</td><td>${q(x.title)}</td><td>${q(x.cInit)}</td><td>${q([...x.issues, ...x.hazards].join('; ') || '—')}</td></tr>`).join('')}</tbody></table></div>`;
      } else if (b.dataset.syncSource || b.dataset.fullSource) {
        const r = await request(`company/data-sources/${encodeURIComponent(id)}/sync`, { body: { confirmed: true, ...(b.dataset.fullSource && { mode: 'full' }) } });
        const res = r.result;
        out.innerHTML = `<p><b>${res.cancelled ? 'Cancelled.' : res.paused ? 'Paused. Progress was kept.' : res.deferred ? 'Paused part-way. Nothing was dropped; sync again to continue.' : 'Sync finished (' + q(res.mode) + ').'}</b> ${q(res.processed ?? '')} records read in ${q(res.batches ?? 1)} batches.</p>${syncBadges(res)}${res.warning || res.modeReason ? `<p class="muted">${q(res.warning || res.modeReason)}</p>` : ''}`;
      } else {
        if (!(await confirmDialog({ title: 'Remove this source?', body: 'Fixes already imported stay in your knowledge. Only the connection is removed, so nothing new will sync.', confirm: 'Remove source', cancel: 'Keep it', danger: true }))) { b.disabled = false; return; }
        await request(`company/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }); location.reload(); return;
      }
    } catch (e) { out.textContent = e.message; }
    b.disabled = false;
  });
  await mountReview(host);
}

/** Source conflicts, stale knowledge and shadow mode: the owner decisions that are not about one source. */
async function mountReview(host) {
  const [overview, shadow] = await Promise.all([request('company/knowledge-lifecycle/overview').catch(() => null), request('company/shadow').catch(() => null)]);
  if (!overview && !shadow) return;
  const section = document.createElement('section');
  section.className = 'hub-card';
  section.id = 'knowledge-review';
  const side = (x, label) => x ? `<div><b>${label}: ${q(x.title)}</b><br><small class="muted">${q(x.origin)} · ${q(x.reviewStatus.replaceAll('_', ' '))}</small></div>` : '';
  section.innerHTML = `<div class="hub-section-head"><div><h2>Knowledge review</h2><p>Conflicts between sources, knowledge that has not been seen for a while, and a safe way to measure ranking on live traffic.</p></div></div>
    ${overview ? `<h3>Conflicting fixes (${q(overview.conflicts.length)})</h3>${overview.conflicts.length ? overview.conflicts.map((c) => `<article class="card" data-conflict="${q(c.id)}"><p class="muted">${q(c.reason)} Neither is recommended while it is unreviewed and imported.</p><div class="split-actions">${side(c.a, 'First')}${side(c.b, 'Second')}</div><div class="actions"><button class="button small" data-resolve="keep_first">Keep first</button><button class="button small" data-resolve="keep_second">Keep second</button><button class="button small" data-resolve="keep_both">Keep both (they apply to different cases)</button><button class="button small danger-ghost" data-resolve="retire_both">Retire both</button></div></article>`).join('') : '<p class="empty">No conflicts between sources.</p>'}
    <h3>Not seen for a while (${q(overview.stale.length)})</h3>${overview.stale.length ? `<ul class="infra-list">${overview.stale.map((s) => `<li><b>${q(s.title)}</b> <small>${q(s.sourceName)}: ${q(s.reason)} It is still active; review or retire it yourself.</small></li>`).join('')}</ul>` : '<p class="empty">Nothing is stale under your sources’ policies. Staleness is only judged after a complete sync.</p>'}` : ''}
    ${shadow ? `<h3>Shadow mode</h3><p class="muted">Ranks suggestions in the background on live conversations and never shows them to customers or changes any outcome. Off unless you turn it on. ${q(shadow.shadow.storedPerRun)}</p><label class="privacy-check"><input type="checkbox" data-shadow ${shadow.shadow.enabled ? 'checked' : ''}> Run shadow ranking for this service</label>${badges([[shadow.shadow.runs, 'rankings recorded'], [shadow.shadow.coverage ?? '—', 'had a suggestion'], [shadow.shadow.top3ResemblesSolution ?? '—', 'top 3 resembled the real fix'], [shadow.shadow.latencyMs.median ?? '—', 'median ms']])}<p class="muted small">${q(shadow.shadow.note)}</p>` : ''}`;
  host.append(section);
  section.querySelector('[data-shadow]')?.addEventListener('change', async (event) => {
    try { await request('company/shadow', { body: { confirmed: true, enabled: event.target.checked } }); location.reload(); } catch (e) { event.target.checked = !event.target.checked; alert(e.message); }
  });
  section.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-resolve]');
    if (!b) return;
    const note = await noteDialog({ title: 'Why this decision?', label: 'Note for the audit trail (no passwords or keys)', confirm: 'Record decision' });
    if (!note) return;
    try { await request('company/knowledge-lifecycle/conflicts/resolve', { body: { confirmed: true, conflictId: b.closest('[data-conflict]').dataset.conflict, decision: b.dataset.resolve, note } }); location.reload(); } catch (e) { b.closest('article').append(Object.assign(document.createElement('p'), { role: 'alert', textContent: e.message })); }
  });
}

/** Websites a REST source may read from: the operator's list plus the ones this owner approved. */
function websites(w) {
  if (!w || (!w.ownerManaged && !w.server.length)) return '';
  const rows = [...w.server.map((o) => `<li><code>${q(o)}</code> <span class="pill">set by the server operator</span></li>`), ...w.company.map((o) => `<li><code>${q(o.origin)}</code> <button type="button" class="button small danger-ghost" data-remove-origin="${q(o.origin)}">Remove</button></li>`)];
  return `<details class="infra"><summary>Allowed websites (${rows.length})</summary><p class="muted small">A REST source can only read from a website listed here. Private and internal network addresses are always refused.</p>${rows.length ? `<ul class="infra-list">${rows.join('')}</ul>` : ''}${w.ownerManaged ? `<form data-add-origin class="actions"><label class="sr-only" for="origin-input">Website address</label><input id="origin-input" name="origin" type="url" required placeholder="https://support.example.com"><button class="button small">Approve website</button></form>` : ''}<p role="alert" data-origin-status></p></details>`;
}

const syncBadges = (r) => badges([[r.inserted, 'added', r.inserted ? 'good' : ''], [r.updated, 'updated'], [r.unchanged, 'unchanged'], [r.skippedLocallyReviewed, 'kept as reviewed'], [(r.invalid || 0) + (r.duplicates || 0), 'skipped', r.invalid ? 'warn' : ''], [r.flaggedForReview, 'need review', r.flaggedForReview ? 'warn' : '']]);

/** Turn the long form into four short steps. Children are grouped by their data-step attribute. */
function wizardize(form, progress) {
  const kids = [...form.children];
  const save = kids.pop();
  const titles = ['What are you connecting?', 'How do we reach it?', 'Match your columns', 'Final options'];
  const steps = titles.map((title, i) => {
    const step = document.createElement('div');
    step.className = 'wiz-step';
    step.hidden = i !== 0;
    const heading = document.createElement('h3');
    heading.className = 'wiz-title';
    heading.textContent = title;
    step.append(heading, ...kids.filter((k) => Number(k.dataset.step) === i + 1));
    return step;
  });
  const nav = document.createElement('div');
  nav.className = 'actions wiz-nav';
  const back = Object.assign(document.createElement('button'), { type: 'button', className: 'button small', textContent: 'Back' });
  const next = Object.assign(document.createElement('button'), { type: 'button', className: 'button small primary', textContent: 'Next' });
  nav.append(back, next, save);
  form.replaceChildren(...steps, nav);
  let at = 0;
  progress.innerHTML = titles.map((title, i) => `<li>${i + 1}. ${title}</li>`).join('');
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
  return { show };
}
