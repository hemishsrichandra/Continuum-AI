// Interactive Learning Demo UI. Talks only to /api/demo/* with a per-tab demo session id.
// No cookies, no login, no real company data.
const KEY = 'continuum-demo-session';
const q = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = document.querySelector('#demo-app');
const announcer = document.querySelector('#announcer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* optional */ } },
};
let sessionId = store.get();
let state = null;
let busy = false;
let error = '';
let activeTab = 'A';
let guided = null; // { step, total, text }
let previewData = null;
let lastCount = 0;
const drafts = { A: null, B: null, S: null };

async function call(method, route, body) {
  const headers = { ...(sessionId && { 'X-Demo-Session': sessionId }), ...(body && { 'Content-Type': 'application/json' }) };
  let response;
  try {
    response = await fetch('/api/demo/' + route, { method, headers, ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Unable to reach the demo server. Check that it is running and try again.');
  }
  const data = await response.json().catch(() => ({ error: 'The server sent an unexpected response.' }));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: response.status });
  return data;
}
async function newSession() {
  const data = await call('POST', 'session');
  sessionId = data.sessionId;
  store.set(sessionId);
  return data;
}
async function load() {
  try {
    state = sessionId ? (await call('GET', 'state')) : await newSession();
  } catch (e) {
    if (e.status === 404 || e.status === 400) state = await newSession();
    else throw e;
  }
}
async function act(route, body, announce) {
  if (busy) return null;
  busy = true;
  error = '';
  render();
  try {
    const data = await call('POST', route, body);
    state = data.state || data;
    if (announce) announcer.textContent = announce;
    return data;
  } catch (e) {
    if (e.status === 404 && /session/i.test(e.message)) {
      error = 'Your demo session expired, so a fresh empty one was started.';
      await newSession().then((s) => (state = s));
    } else error = e.message;
    return null;
  } finally {
    busy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
const stepClass = (done) => (done ? 'step done' : 'step');
function chain() {
  const s = state.summary;
  const hasEvent = (kind) => state.events.some((e) => e.kind === kind);
  return `<div class="demo-chain" aria-label="Learning progress">
    <span class="${stepClass(hasEvent('still_need_help'))}">1 · A: standard idea fails</span><span class="arrow" aria-hidden="true">→</span>
    <span class="${stepClass(hasEvent('specialist_proposed'))}">2 · Specialist proposes</span><span class="arrow" aria-hidden="true">→</span>
    <span class="${stepClass(s.verifiedMemoryCreated)}">3 · A confirms · memory created</span><span class="arrow" aria-hidden="true">→</span>
    <span class="${stepClass(s.userBBenefited)}">4 · B benefits</span></div>`;
}
function meter() {
  const grew = state.learnedCount > lastCount;
  lastCount = state.learnedCount;
  return `<section class="demo-meter" aria-labelledby="meter-title"><div><span class="demo-count${state.learnedCount ? ' learned' : ''}${grew ? '' : ''}" aria-hidden="true">${state.learnedCount}</span><span class="demo-count-label" id="meter-title">LEARNED MEMORY</span></div>
    <div>${chain()}<p class="demo-progress" role="status">${guided ? `Guided scenario · step ${guided.step} of ${guided.total}: ${q(guided.text)}` : q(state.summary.line)}</p></div></section>`;
}
const attemptCard = (c) => {
  const a = c.attempts.find((x) => x.outcome === 'pending');
  if (c.status === 'suggested' && a) {
    const learned = a.source === 'learned';
    const x = a.explanation;
    return `<div class="demo-card ${learned ? 'learned' : 'standard'}">
      <span class="pill ${learned ? 'green' : 'blue'}">${q(learned ? a.label : 'Initial standard suggestion')}</span>
      ${learned ? '<span class="pill green">✓ Verified · confirmed by the original customer</span>' : ''}
      <p class="steps">${q(a.steps)}</p>
      ${learned ? `<details><summary>Why this was recommended</summary><p>${q(x.why)}</p><dl><dt>Constraints matched</dt><dd>${q(x.constraintsMatched.join('; '))}</dd><dt>Similarity (cosine)</dt><dd>${q(x.scores.cosine)}</dd><dt>Keyword (BM25)</dt><dd>${q(x.scores.normBm25)}</dd><dt>S_hybrid</dt><dd>${q(x.scores.S_hybrid)}</dd><dt>Compatibility</dt><dd>${q(x.scores.S_compat)}</dd><dt>Reliability</dt><dd>${q(x.scores.W_reliability)}</dd><dt>S_final</dt><dd>${q(x.scores.S_final)} (needs ≥ ${q(x.threshold)})</dd></dl><p>${q(x.retrieval)}</p></details>` : '<small>Hardcoded demo playbook. This is not learned memory.</small>'}
      <div class="demo-row"><button class="button primary small" data-act="feedback" data-case="${q(c.id)}" data-worked="true" ${busy ? 'disabled' : ''}>It worked</button><button class="button small" data-act="feedback" data-case="${q(c.id)}" data-worked="false" ${busy ? 'disabled' : ''}>Still need help</button></div></div>`;
  }
  if (c.status === 'needs_info')
    return `<div class="demo-card waiting"><p>${q(c.clarification)}</p><form class="demo-form" data-form="device" data-case="${q(c.id)}"><label>Device and version<input name="device" required maxlength="200" value="${q(c.user === 'B' ? state.script.userB.device : state.script.userA.device)}"></label><button class="button small" ${busy ? 'disabled' : ''}>Continue</button></form></div>`;
  if (c.status === 'queued') return `<div class="demo-card waiting"><span class="pill">With the demo specialist</span><p>Your case moved to the demo-only specialist queue. It is not a real company queue.</p></div>`;
  if (c.status === 'proposal_sent' && c.proposal)
    return `<div class="demo-card learned"><span class="pill blue">Specialist proposal</span><p class="steps">${q(c.proposal.steps)}</p><small>Nothing is learned until you confirm the outcome.</small><div class="demo-row"><button class="button primary small" data-act="confirm" data-case="${q(c.id)}" data-accepted="true" ${busy ? 'disabled' : ''}>It worked</button><button class="button small" data-act="confirm" data-case="${q(c.id)}" data-accepted="false" ${busy ? 'disabled' : ''}>Still need help</button></div></div>`;
  if (c.status === 'resolved') {
    const used = [...c.attempts].reverse().find((x) => x.outcome === 'succeeded');
    return `<div class="demo-card resolved"><span class="pill green">Resolved · you confirmed it worked</span>${used?.source === 'learned' ? '<p>Resolved with the fix ' + q((used.label || 'learned earlier').replace(/^Learned/, 'learned')) + '.</p>' : c.proposal?.status === 'confirmed' ? '<p>Resolved with the specialist’s solution. Continuum learned it.</p>' : '<p>Resolved with the initial standard suggestion.</p>'}</div>`;
  }
  return '';
};
function customerPanel(user) {
  const cases = state.cases.filter((c) => c.user === user);
  const latest = cases.at(-1);
  const script = user === 'A' ? state.script.userA : state.script.userB;
  const d = drafts[user] || { description: '', device: '' };
  const open = latest && !['resolved'].includes(latest.status);
  return `<section class="demo-panel" id="panel-${user}" data-hidden="${activeTab !== user}" aria-labelledby="h-${user}">
    <div><span class="role">CUSTOMER VIEW</span><h2 id="h-${user}">User ${user}${user === 'A' ? ' · teaches' : ' · benefits'}</h2></div>
    ${open ? '' : `<form class="demo-form" data-form="issue" data-user="${user}">
      <label>What is going wrong?<textarea name="description" required maxlength="500" placeholder="Describe the problem">${q(d.description)}</textarea></label>
      <label>Device and version<input name="device" maxlength="200" placeholder="e.g. Demo Laptop X1, firmware 4" value="${q(d.device)}"></label>
      <div class="demo-row"><button class="button primary small" ${busy ? 'disabled' : ''}>Report issue</button><button type="button" class="button small" data-act="fill" data-user="${user}" data-which="script">Use script text</button>${user === 'B' ? '<button type="button" class="button small" data-act="fill" data-user="B" data-which="incompatible">Try an incompatible device</button>' : ''}</div>
      <p class="demo-script">${user === 'A' ? 'Script: a flickering screen on a fictional laptop.' : 'Script: the same problem in different words. Learned fixes from other demo sessions are never visible here.'}</p></form>`}
    ${cases.length ? cases.slice(-2).map((c) => `<div><h3>${q(c.id)} · ${q(c.description)}</h3><small>${q(c.device || 'No device given')}</small>${attemptCard(c)}${c.attempts.filter((a) => a.outcome === 'failed').map((a) => `<p class="demo-script">✗ ${a.source === 'learned' ? 'Learned fix' : 'Initial standard suggestion'}: still need help</p>`).join('')}</div>`).join('') : '<p class="demo-empty">No issue reported yet.</p>'}
  </section>`;
}
function specialistPanel() {
  const queued = state.cases.filter((c) => ['queued', 'proposal_sent'].includes(c.status));
  const target = queued.find((c) => c.status === 'queued') || null;
  const d = drafts.S || {};
  return `<section class="demo-panel specialist" id="panel-S" data-hidden="${activeTab !== 'S'}" aria-labelledby="h-S">
    <div><span class="role">COMPANY · SPECIALIST VIEW (DEMO ONLY)</span><h2 id="h-S">Demo specialist queue</h2></div>
    ${queued.length ? queued.map((c) => `<div class="demo-card ${c.status === 'queued' ? 'waiting' : ''}"><span class="pill">${c.status === 'queued' ? 'Waiting for a specialist' : 'Sent to User ' + q(c.user) + ' · awaiting confirmation'}</span><p><b>User ${q(c.user)}:</b> ${q(c.description)}</p><small>${q(c.device || 'No device given')}</small>${c.attempts.map((a) => `<p class="demo-script">${a.outcome === 'failed' ? '✗' : '•'} Tried: ${q(a.source === 'learned' ? 'learned fix' : 'initial standard suggestion')} — ${q(a.steps)}</p>`).join('')}</div>`).join('') : '<p class="demo-empty">The queue is empty. A case appears here only after “Still need help”.</p>'}
    ${target ? `<form class="demo-form" data-form="propose" data-case="${q(target.id)}"><h3>Resolution Passport for ${q(target.id)}</h3>
      <label>Title<input name="title" required maxlength="100" value="${q(d.title || '')}"></label>
      <label>Matching symptoms<textarea name="symptoms" required maxlength="300">${q(d.symptoms || '')}</textarea></label>
      <label>Applies to (device and version)<input name="environment" required maxlength="200" value="${q(d.environment || '')}"></label>
      <label>Solution steps<textarea name="steps" required maxlength="600">${q(d.steps || '')}</textarea></label>
      <label>Safety restrictions<input name="safety" maxlength="300" value="${q(d.safety ?? '')}" placeholder="None identified"></label>
      <label class="check"><input type="checkbox" name="reviewedForPrivacy" ${d.reviewed ? 'checked' : ''} required> I tested these steps and removed personal information and secrets.</label>
      <div class="demo-row"><button type="button" class="button small" data-act="fill" data-user="S">Use scripted solution</button><button type="button" class="button small" data-act="preview">Preview passport</button><button class="button primary small" ${busy ? 'disabled' : ''}>Send to User ${q(target.user)}</button></div>
      ${previewData ? `<div class="demo-card"><b>Passport preview</b><p>${q(previewData.passport.title)}</p><p class="steps">${q(previewData.passport.steps)}</p><small>C_init ${q(previewData.cInit.score)} = 0.40×${q(previewData.cInit.components.P_passport)} + 0.35×${q(previewData.cInit.components.S_diag)} + 0.25×${q(previewData.cInit.components.R_author)} · ${previewData.redactions} redactions</small></div>` : ''}
    </form>` : ''}
    <div><h3>Verified demo memory (this session)</h3>${state.learned.length ? state.learned.map((l) => `<div class="demo-card learned"><span class="pill green">✓ ${q(l.provenance)}</span><p><b>${q(l.title)}</b></p><p class="steps">${q(l.steps)}</p><small>Applies to ${q(l.applicability)} · safety: ${q(l.safety)}</small><small>C_init ${q(l.cInit.score)} · reliability ${q(l.reliability)} · worked ${l.successes} · failed ${l.failures} · status ${q(l.status)}</small></div>`).join('') : '<p class="demo-empty">Empty. Learned memory: 0.</p>'}</div>
  </section>`;
}
function beforeAfter() {
  const a = state.cases.find((c) => c.user === 'A');
  const b = state.cases.find((c) => c.user === 'B');
  if (!a?.attempts[0] || !b?.attempts[0]) return '';
  const label = (t) => (t.source === 'learned' ? t.label || 'Learned from a confirmed specialist resolution' : 'Initial standard suggestion');
  return `<section aria-labelledby="ba"><h2 id="ba">Before and after</h2><div class="demo-before-after"><div><b>BEFORE LEARNING · USER A SAW</b>${q(label(a.attempts[0]))}: ${q(a.attempts[0].steps)}</div><div><b>AFTER LEARNING · USER B SAW</b>${q(label(b.attempts[0]))}: ${q(b.attempts[0].steps)}</div></div></section>`;
}
function timeline() {
  const key = new Set(['memory_learned', 'user_b_benefited', 'learned_suggestion_shown']);
  return `<section aria-labelledby="tl"><h2 id="tl">Event timeline</h2><ol class="demo-timeline">${state.events.map((e) => `<li class="${key.has(e.kind) ? 'key' : ''}"><span class="n">${e.id}</span><div><span class="who">${q(e.who.toUpperCase())}</span>${q(e.detail)}</div><time datetime="${q(e.at)}">${q(new Date(e.at).toLocaleTimeString())} · memory ${e.learnedCount}</time></li>`).join('')}</ol></section>`;
}
function render() {
  if (!state) return;
  const keepFocus = document.activeElement?.closest?.('form')?.dataset;
  app.innerHTML = `<div class="wrap">
    <div class="demo-hero"><span class="eyebrow">INTERACTIVE LEARNING DEMO</span><h1>One customer teaches. The next one benefits.</h1>
      <p class="lead">Follow User A’s problem to a specialist, watch the confirmed fix become verified demo memory, then see User B receive it. This session is empty, private to this tab and resettable.</p>
      <p class="demo-disclaimer" role="note"><b>Fictional demonstration.</b> Continuum retrieves and reuses approved knowledge; it does not train or change model weights. This demo reads and writes none of a real company’s tickets, memory, databases, connectors or analytics, and calls no external services.</p>
      <div class="demo-actions"><button class="button primary" data-act="guided" ${busy || guided ? 'disabled' : ''}>Run guided scenario</button><button class="button" data-act="reset" ${busy || guided ? 'disabled' : ''}>Reset demo</button><small>Reset clears everything learned in this session, so User B can no longer receive A’s fix.</small></div></div>
    ${error ? `<p class="demo-error" role="alert">${q(error)}</p>` : ''}
    ${meter()}
    <div class="demo-tabs" role="tablist" aria-label="Choose a view">${[['A', 'User A'], ['S', 'Company'], ['B', 'User B']].map(([k, n]) => `<button role="tab" id="tab-${k}" aria-selected="${activeTab === k}" aria-controls="panel-${k}" data-act="tab" data-tab="${k}">${n}</button>`).join('')}</div>
    <div class="demo-grid">${customerPanel('A')}${specialistPanel()}${customerPanel('B')}</div>
    ${beforeAfter()}
    <p class="demo-summary${state.summary.userBBenefited ? '' : ' pending'}" role="status">${q(state.summary.line)}</p>
    ${timeline()}
    <p class="demo-footer-note">Starting suggestions come from two hardcoded demo playbooks. The only learned fix is the one User A confirms in this session. Retrieval here uses a local, offline concept embedding plus BM25 over this session only; compatibility (device, version, safety) is checked separately from similarity.</p></div>`;
  if (keepFocus?.form) app.querySelector(`[data-form="${keepFocus.form}"] textarea, [data-form="${keepFocus.form}"] input`)?.focus?.({ preventScroll: true });
}

// ---------------------------------------------------------------------------
function formValues(form) {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)]));
}
app.addEventListener('input', (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  const v = formValues(form);
  if (form.dataset.form === 'issue') drafts[form.dataset.user] = { description: v.description || '', device: v.device || '' };
  if (form.dataset.form === 'propose') drafts.S = { ...v, reviewed: form.elements.reviewedForPrivacy.checked };
});
app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const v = formValues(form);
  if (form.dataset.form === 'issue') {
    const user = form.dataset.user;
    const done = await act('customer/issue', { user, description: v.description, device: v.device }, 'Issue reported.');
    if (done) drafts[user] = null;
  } else if (form.dataset.form === 'device') await act('customer/device', { caseId: form.dataset.case, device: v.device }, 'Device details added.');
  else if (form.dataset.form === 'propose') {
    const done = await act('specialist/propose', { caseId: form.dataset.case, ...v, reviewedForPrivacy: form.elements.reviewedForPrivacy.checked, safetyReviewed: true, confirmed: true }, 'Resolution Passport sent to the customer.');
    if (done) { drafts.S = null; previewData = null; }
  }
});
app.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act_ = el.dataset.act;
  if (act_ === 'tab') { activeTab = el.dataset.tab; render(); app.querySelector('#tab-' + activeTab)?.focus(); return; }
  if (act_ === 'fill') {
    const which = el.dataset.which;
    if (el.dataset.user === 'S') drafts.S = { ...state.script.specialist, reviewed: true };
    else drafts[el.dataset.user] = which === 'incompatible' ? { ...state.script.userBIncompatible } : { ...(el.dataset.user === 'A' ? state.script.userA : state.script.userB) };
    previewData = null;
    render();
    return;
  }
  if (act_ === 'preview') {
    const form = el.closest('form');
    const v = formValues(form);
    if (!form.reportValidity()) return;
    const done = await act('specialist/propose', { caseId: form.dataset.case, ...v, reviewedForPrivacy: form.elements.reviewedForPrivacy.checked, safetyReviewed: true, confirmed: true, preview: true });
    if (done?.preview) { previewData = done; render(); }
    return;
  }
  if (act_ === 'feedback') await act('customer/feedback', { caseId: el.dataset.case, worked: el.dataset.worked === 'true', confirmed: true }, 'Answer recorded.');
  if (act_ === 'confirm') await act('customer/confirm', { caseId: el.dataset.case, accepted: el.dataset.accepted === 'true', confirmed: true }, el.dataset.accepted === 'true' ? 'Confirmed. Learned memory updated.' : 'Recorded. Nothing was learned.');
  if (act_ === 'reset') { guided = null; previewData = null; drafts.A = drafts.B = drafts.S = null; lastCount = 0; await act('reset', {}, 'Demo reset. Learned memory: 0.'); }
  if (act_ === 'guided') await runGuided();
});

async function runGuided() {
  if (guided) return;
  const total = 6;
  const show = async (step, text, pause = 1100) => { guided = { step, total, text }; render(); announcer.textContent = `Step ${step} of ${total}: ${text}`; await sleep(pause); };
  try {
    if (state.cases.length || state.learnedCount) { await act('reset', {}); lastCount = 0; }
    const S = state.script;
    guided = { step: 0, total, text: 'starting' };
    await show(1, 'User A reports a flickering screen and sees the initial standard suggestion');
    let r = await act('customer/issue', { user: 'A', ...S.userA });
    if (!r) throw new Error('stopped');
    const a = state.cases.find((c) => c.user === 'A');
    activeTab = 'A';
    await show(2, 'User A says “Still need help”: the case moves to the demo specialist queue');
    if (!(await act('customer/feedback', { caseId: a.id, worked: false, confirmed: true }))) throw new Error('stopped');
    activeTab = 'S';
    await show(3, 'The demo specialist proposes a fix with a Resolution Passport');
    if (!(await act('specialist/propose', { caseId: a.id, ...S.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true }))) throw new Error('stopped');
    activeTab = 'A';
    await show(4, 'User A explicitly confirms “It worked”: only now does the demo learn (0 → 1)');
    if (!(await act('customer/confirm', { caseId: a.id, accepted: true, confirmed: true }))) throw new Error('stopped');
    activeTab = 'B';
    await show(5, 'User B reports the same problem in different words and receives the learned fix');
    r = await act('customer/issue', { user: 'B', ...S.userB });
    if (!r) throw new Error('stopped');
    const b = state.cases.find((c) => c.user === 'B');
    await show(6, 'User B confirms it worked: User A taught Continuum, and User B benefited');
    if (b?.attempts.some((x) => x.source === 'learned')) await act('customer/feedback', { caseId: b.id, worked: true, confirmed: true });
  } catch (e) {
    if (e.message !== 'stopped') error = e.message;
  } finally {
    guided = null;
    render();
  }
}

try {
  await load();
  render();
} catch (e) {
  app.innerHTML = `<div class="wrap"><p class="demo-error" role="alert">${q(e.message)}</p></div>`;
}
