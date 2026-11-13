// Owner UI: import help articles, PDFs and past resolved tickets as free text. The server drafts fixes from the text
// (by rules, or an approved model that may only use words from the source); the owner checks the drafts here and sends
// them for review. Nothing reaches a customer until a specialist approves it in the console.
import { request, escapeHtml as q } from './client.js';
import { badges } from './form-kit.js';

const ACCEPT = '.txt,.md,.markdown,.html,.htm,.pdf,.csv,.tsv,.json';

const toBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export async function mountKnowledgeImport(host) {
  const [data, session] = await Promise.all([request('company/data-sources'), request('auth/session').catch(() => ({}))]);
  const current = session.profile?.chatbotId;
  const section = document.createElement('section');
  section.className = 'hub-card';
  section.id = 'knowledge-import';
  section.innerHTML = `<div class="hub-section-head"><div><h2>Import articles and past tickets</h2><p>Upload the help articles, PDFs or solved tickets you already have. We draft a fix from each one; you check the drafts, and a specialist approves each fix before any customer sees it.</p></div></div>
    <form id="import-form" class="stack-form">
      <div class="form-row"><label>Service<select name="chatbotId">${data.chatbots.map((b) => `<option value="${q(b.id)}" ${b.id === current ? 'selected' : ''}>${q(b.name)}</option>`).join('')}</select></label>
      <fieldset class="segmented"><legend>What are you importing?</legend><label><input type="radio" name="kind" value="articles" checked> Help articles or PDFs</label><label><input type="radio" name="kind" value="tickets"> Past solved tickets (CSV or JSON export)</label></fieldset></div>
      <label>Files (text, Markdown, HTML, PDF, CSV or JSON; up to 20 files, 2 MB each)<input type="file" name="files" multiple accept="${ACCEPT}"></label>
      <details><summary>Or paste text instead</summary><label>Pasted text<textarea name="pasted" rows="6" placeholder="Paste an article, or a CSV export with a header row"></textarea></label></details>
      <p class="muted small" data-kind-hint>Each article becomes one draft. Separate several articles in one file with a line of three dashes (---) or give each its own top-level heading.</p>
      <div class="actions"><button class="button primary">Draft fixes</button></div>
    </form>
    <div data-import-result role="status" aria-live="polite"></div>`;
  host.append(section);
  const form = section.querySelector('#import-form');
  const out = section.querySelector('[data-import-result]');
  const hint = section.querySelector('[data-kind-hint]');
  form.addEventListener('change', () => {
    hint.textContent = form.elements.kind.value === 'tickets'
      ? 'Use your helpdesk’s export of solved tickets. We look for columns such as ID, Subject, Description and Resolution, skip unsolved tickets and one-word resolutions, and merge tickets that were fixed the same way.'
      : 'Each article becomes one draft. Separate several articles in one file with a line of three dashes (---) or give each its own top-level heading.';
  });
  let state = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    const files = [];
    try {
      for (const f of form.elements.files.files) {
        if (f.size > 2 * 1024 * 1024) throw new Error(`“${f.name}” is larger than 2 MB.`);
        files.push(/\.pdf$/i.test(f.name) ? { name: f.name, base64: await toBase64(f) } : { name: f.name, text: await f.text() });
      }
      if (form.elements.pasted.value.trim()) files.push({ name: form.elements.kind.value === 'tickets' ? 'pasted.csv' : 'pasted text', text: form.elements.pasted.value });
      if (!files.length) throw new Error('Choose a file or paste some text.');
    } catch (e) { out.innerHTML = `<p class="notice error">${q(e.message)}</p>`; return; }
    button.disabled = true;
    out.innerHTML = '<p class="muted">Reading and drafting… this can take a minute for large files.</p>';
    try {
      const r = await request('company/knowledge-import/draft', { body: { chatbotId: form.elements.chatbotId.value, kind: form.elements.kind.value, files }, timeout: 300000 });
      state = { chatbotId: form.elements.chatbotId.value, drafts: r.drafts };
      render(r);
    } catch (e) { out.innerHTML = `<p class="notice error">${q(e.message)}</p>`; }
    button.disabled = false;
  });

  function render(r) {
    const ready = r.drafts.filter((d) => d.ready).length;
    out.innerHTML = `<p><b>Drafts only. Nothing has been saved.</b> ${r.drafting.method === 'model' ? 'Structured by a language model; any step whose wording was not in your source was removed.' : 'Drafted by rules: every word comes from your source.'}</p>
      ${badges([[r.drafts.length, 'drafts'], [ready, 'ready', 'good'], [r.drafts.length - ready, 'need attention', r.drafts.length - ready ? 'warn' : ''], [r.skippedCount, 'skipped', r.skippedCount ? 'warn' : '']])}
      ${r.skippedCount ? `<details><summary>Why ${q(r.skippedCount)} item${r.skippedCount === 1 ? ' was' : 's were'} skipped</summary><ul>${r.skipped.slice(0, 50).map((s) => `<li>${q(s.ref)}: ${q(s.reason)}</li>`).join('')}</ul></details>` : ''}
      <div class="import-drafts">${r.drafts.map((d, i) => `<article class="card" data-draft="${i}">
        <label class="privacy-check"><input type="checkbox" data-include ${d.ready ? 'checked' : ''} ${d.alreadyImported ? 'disabled' : ''}> Send for review</label>
        ${d.seenInTickets > 1 ? `<span class="pill green">Closed ${q(d.seenInTickets)} past tickets</span>` : ''} ${d.alreadyImported ? '<span class="pill">Already imported</span>' : ''} ${d.hazards.length ? `<span class="pill warn">Needs a safety check: ${q(d.hazards.join(', '))}</span>` : ''}
        <label>Title<input data-f="title" maxlength="120" value="${q(d.title)}"></label>
        <label>What the customer experiences<textarea data-f="symptoms" rows="2" maxlength="2000">${q(d.symptoms)}</textarea></label>
        <label>Steps (one per line)<textarea data-f="steps" rows="${Math.min(8, Math.max(2, d.steps.length))}">${q(d.steps.join('\n'))}</textarea></label>
        <div class="form-row"><label>Applies to<input data-f="appliesTo" maxlength="500" value="${q(d.appliesTo)}" placeholder="Leave empty if not stated"></label><label>Do not use if<input data-f="safety" maxlength="1000" value="${q(d.safety)}" placeholder="None stated"></label></div>
        <small class="muted">From ${q(d.sourceName)}${d.sourceRef ? ' · ' + q(d.sourceRef) : ''}</small>${d.issues.length ? `<p class="notice">${q(d.issues.join('; '))}</p>` : ''}
      </article>`).join('')}</div>
      ${r.drafts.length ? `<div class="actions"><button class="button primary" data-send>Send selected drafts for review</button></div>` : ''}<p role="alert" data-send-result></p>`;
    out.querySelector('[data-send]')?.addEventListener('click', send);
  }

  async function send(event) {
    const button = event.currentTarget;
    const chosen = [...out.querySelectorAll('[data-draft]')].filter((c) => c.querySelector('[data-include]').checked).map((c) => {
      const d = state.drafts[Number(c.dataset.draft)];
      const v = (f) => c.querySelector(`[data-f="${f}"]`).value;
      return { ...d, title: v('title'), symptoms: v('symptoms'), steps: v('steps').split('\n').map((s) => s.trim()).filter(Boolean), appliesTo: v('appliesTo'), safety: v('safety') };
    });
    const result = out.querySelector('[data-send-result]');
    if (!chosen.length) { result.textContent = 'Select at least one draft.'; return; }
    button.disabled = true;
    try {
      const r = await request('company/knowledge-import/save', { body: { confirmed: true, chatbotId: state.chatbotId, drafts: chosen }, timeout: 120000 });
      result.innerHTML = `<b>${q(r.saved)} fix${r.saved === 1 ? '' : 'es'} sent for review.</b> ${q(r.next)} <a href="/operator/?chatbotId=${encodeURIComponent(state.chatbotId)}#knowledge">Review them now</a>.${r.alreadyImported ? ` ${q(r.alreadyImported)} had already been imported.` : ''}${r.rejected.length ? `<br>Not saved: ${r.rejected.map((x) => q(x.title + ' (' + x.reason + ')')).join('; ')}` : ''}`;
    } catch (e) { result.textContent = e.message; button.disabled = false; }
  }
}
