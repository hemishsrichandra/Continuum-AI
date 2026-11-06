import { mountOperator } from './operator.js';
import { renderAuth, openAccount } from './auth-ui.js';
import { mountSite } from './pages.js';
import { request, escapeHtml as q, readSession, saveSession, formatDate, calendarLink } from './client.js';

mountSite();
if (location.pathname === '/operator') await mountOperator();
const app = document.querySelector('#app');
const parameters = new URLSearchParams(location.search);
const state = {
  authenticated: false, ticketId: readSession('supportly-ticket'), workspace: null,
  tab: parameters.has('lab') ? 'compare' : 'conversation', messages: [], ledger: [], busy: false,
  memory: true, draft: '', search: '', filter: 'all', notice: '', error: '', reflection: null, pendingChat: null,
};
const names = { request: 'New request', requirement: 'Add a note', book: 'Book a visit', cancel: 'Cancel appointment', handoff: 'Request a specialist', outcome: 'Update outcome', invalidate: 'Retire memory', archive: 'Start a new conversation' };
const kinds = { failed: 'Failed fix', missed: 'Missed commitment', preference: 'Preference', action: 'Action', resolved: 'Resolved', verified_resolution: 'Human-verified resolution' };
const short = (id) => id?.length > 16 ? id.slice(0, 12) + '…' : id;
const ticket = () => state.workspace?.tickets.find((t) => t.id === state.ticketId);
const suggestedQuestion = (profile) => state.ticketId === profile.ticketId ? profile.prompt : 'What is the status of my ' + ticket().title + ' request?';
const disabled = () => state.busy ? 'disabled' : '';
let calendarUrl;
async function api(route, options = {}) {
  try { return await request(route, options); }
  catch (error) {
    if (error.status === 401 && !options.publicRoute) {
      state.authenticated = null; saveSession('continuum-token', null);
      await login('Your session has ended. Sign in to pick up where you left off.');
    }
    throw error;
  }
}
function message(text, isError = false) {
  state[isError ? 'error' : 'notice'] = text;
  const target = document.querySelector(isError ? '#desk-error' : '#desk-notice');
  if (target) { target.textContent = text; target.hidden = !text; }
}
async function login(error = '') {
  await renderAuth(app, { error, onSession: async (session) => {
    state.authenticated = true; state.ticketId = session.profile.ticketId; state.error = ''; state.notice = '';
    await refresh(); render();
  } });
}
async function signedOut(notice = '') {
  state.authenticated = null; state.workspace = null; state.ticketId = null; state.memory = true; state.draft = ''; state.pendingChat = null;
  saveSession('continuum-token', null); saveSession('supportly-ticket', null);
  await login(notice);
}
async function refresh() {
  const workspace = await api('workspace');
  const selected = workspace.tickets.some((t) => t.id === state.ticketId) ? state.ticketId : workspace.profile.ticketId || workspace.tickets[0]?.id || null;
  const query = '?ticketId=' + encodeURIComponent(selected);
  const [memories, conversation] = selected ? await Promise.all([api('memory' + query), api('conversation' + query)]) : [{ ledger: [] }, { messages: [] }];
  state.workspace = workspace; state.ticketId = selected; state.ledger = memories.ledger; state.messages = conversation.messages;
  saveSession('supportly-ticket', selected);
  state.account = workspace.profile;
}
function stats() {
  const m = state.workspace.metrics;
  return `<div class="workspace-stats">${[[m.open, 'Open requests'], [m.appointments, 'Upcoming visits'], [m.actions, 'Confirmed actions'], [m.satisfaction === null ? '—' : m.satisfaction + '%', `Helpful responses${m.ratings ? ' · ' + m.ratings + ' rated' : ''}`]].map(([value, text]) => `<div><strong>${q(value)}</strong><span>${q(text)}</span></div>`).join('')}</div>`;
}
function requestList() {
  const tickets = state.workspace.tickets.filter((t) => (state.filter === 'all' || (t.status === 'Resolved') === (state.filter === 'resolved')) && `${t.title} ${t.id} ${t.issue}`.toLowerCase().includes(state.search.toLowerCase()));
  return tickets.length ? tickets.map((t) => `<button class="request-row ${t.id === state.ticketId ? 'selected' : ''}" data-ticket="${q(t.id)}" ${disabled()} aria-pressed="${t.id === state.ticketId}"><span class="request-row-top"><span class="request-icon" aria-hidden="true">${state.workspace.profile.provider === 'it' ? '⌘' : '▣'}</span><small title="${q(t.id)}">${q(short(t.id))}</small></span><strong>${q(t.title)}</strong><span class="request-issue">${q(t.issue)}</span><span class="pill ${t.status === 'Resolved' ? 'green' : 'blue'}">${q(t.status)}</span></button>`).join('') : '<div class="empty-state compact"><p>No matching requests.</p><small>Try another search or create a request.</small></div>';
}
function render() {
  app.setAttribute('aria-busy', String(state.busy));
  const focused = document.activeElement;
  const restoreAction = app.contains(focused) ? focused?.dataset?.action : null;
  const restoreTab = app.contains(focused) ? focused?.dataset?.tab : null;
  if (!state.authenticated || !state.workspace) return;
  const t = ticket(); const p = state.workspace.profile;
  if (!t) {
    app.innerHTML = `<section class="wrap workspace"><div class="workspace-heading"><div><span class="eyebrow">YOUR CONTINUUM ACCOUNT</span><h1>Welcome, ${q(p.name.split(' ')[0])}.</h1></div><div class="account"><button class="button small" data-action="account">Account & connections</button><button class="text-button" data-action="switch">Sign out</button></div></div><section class="panel onboarding-empty"><span class="assistant-mark large" aria-hidden="true">∿</span><h2>Your service history starts here.</h2><p>Create your first request to start a conversation, add notes, or schedule a visit.</p><button class="button primary" data-action="request">Create your first request →</button></section><p id="desk-error" class="notice error" role="alert" hidden></p></section><dialog id="action-dialog" aria-labelledby="dialog-title"></dialog>`;
    return;
  }
  const active = state.ledger.filter((m) => !m.invalidatedAt);
  app.innerHTML = `<section class="wrap workspace"><div class="workspace-heading"><div><div class="eyebrow">CUSTOMER WORKSPACE</div><h1>Your workspace.</h1>${state.workspace.staff ? '<a class="button small" href="/operator">Specialist console →</a>' : ''}</div><div class="account"><span class="avatar">${q(p.initials)}</span><div><b>${q(p.name)}</b><small>${q(p.label)}</small></div><button class="icon-button" data-action="refresh" aria-label="Refresh workspace" ${disabled()}>↻</button><button class="text-button" data-action="account" ${disabled()}>${p.demo ? 'Demo account' : 'Account'}</button><button class="text-button" data-action="switch" ${disabled()}>Sign out</button></div></div>${stats()}<p id="desk-notice" class="notice success" role="status" ${state.notice ? '' : 'hidden'}>${q(state.notice)}</p><p id="desk-error" class="notice error" role="alert" ${state.error ? '' : 'hidden'}>${q(state.error)}</p><div class="workspace-grid"><aside class="request-sidebar panel"><div class="sidebar-heading"><h2>Requests <span>${state.workspace.tickets.length}</span></h2><button class="icon-button" aria-label="Create a new request" data-action="request" ${disabled()}>+</button></div><div class="request-filters"><label class="sr-only" for="request-search">Search requests</label><input id="request-search" type="search" placeholder="Search requests…" value="${q(state.search)}" ${disabled()}><label class="sr-only" for="request-filter">Filter requests</label><select id="request-filter" ${disabled()}><option value="all" ${state.filter === 'all' ? 'selected' : ''}>All requests</option><option value="open" ${state.filter === 'open' ? 'selected' : ''}>Open</option><option value="resolved" ${state.filter === 'resolved' ? 'selected' : ''}>Resolved</option></select></div><div id="request-list">${requestList()}</div><div class="sidebar-foot"><span class="status-dot"></span> ${p.demo ? 'Demo workspace' : 'Personal workspace'}</div></aside><section class="desk-center"><div class="ticket-summary panel"><div><span class="eyebrow" title="${q(t.id)}">${q(short(t.id))}</span><h2>${q(t.title)}</h2><p>${q(t.issue)}</p></div><span class="pill ${t.status === 'Resolved' ? 'green' : 'blue'}">${q(t.status)}</span><dl><div><dt>Assigned team</dt><dd>${q(t.assignedTo)}</dd></div><div><dt>Estimated completion</dt><dd>${q(formatDate(t.eta))}${state.workspace.metrics.overdue && t.eta && new Date(t.eta + 'T23:59:59+05:30') < new Date() && t.status !== 'Resolved' ? ' <span class="overdue">Overdue</span>' : ''}</dd></div></dl></div><div class="desk-tabs" role="group" aria-label="Workspace view">${[['conversation', 'Conversation'], ['appointments', 'Visits'], ['activity', 'Activity'], ['compare', 'Memory lab']].map(([id, name]) => `<button data-tab="${id}" aria-pressed="${state.tab === id}" ${disabled()}>${name}</button>`).join('')}</div>${state.tab === 'conversation' ? chat(p) : state.tab === 'appointments' ? appointments(t) : state.tab === 'activity' ? activity(t) : lab(p)}</section><aside class="context-sidebar"><section class="panel context-panel"><div class="sidebar-heading"><h2>Next steps</h2><span class="subtle">For this request</span></div><div class="action-list">${['requirement', 'book', 'handoff', 'outcome'].map((kind) => `<button data-action="${kind}" ${disabled()}><span>${q(names[kind])}</span><span aria-hidden="true">↗</span></button>`).join('')}</div></section><section class="panel context-panel"><div class="sidebar-heading"><h2>Remembered context <span>${active.length}</span></h2></div><p class="context-intro">Useful details for the next conversation.</p>${active.length ? active.map((m) => `<article class="memory-entry"><span class="pill">${q(kinds[m.kind] || m.kind)}</span><p>${q(m.text)}</p><div><small>${formatDate(m.createdAt)}</small><button class="text-button" data-retire="${q(m.id)}" ${disabled()} aria-label="Retire memory: ${q(m.text)}">Retire</button></div></article>`).join('') : '<div class="empty-state compact"><p>No remembered context yet.</p><small>Preferences and outcomes will appear here.</small></div>'}<button class="text-button summarize-button" data-action="reflect" ${state.busy || !state.memory || !active.length ? 'disabled' : ''}>Summarize context ↗</button>${state.reflection ? `<div class="reflection"><p>${q(state.reflection.text)}</p></div>` : ''}${state.ledger.some((m) => m.invalidatedAt) ? `<details class="retired"><summary>Retired context</summary>${state.ledger.filter((m) => m.invalidatedAt).map((m) => `<p>${q(m.text)}<small>Retired ${formatDate(m.invalidatedAt)}</small></p>`).join('')}</details>` : ''}</section>${t.requirements.length ? `<section class="panel context-panel"><h2>Request notes</h2>${t.requirements.map((r) => `<div class="memory-entry"><p>${q(r.note)}</p><small>${formatDate(r.createdAt)}</small></div>`).join('')}</section>` : ''}</aside></div></section><dialog id="action-dialog" aria-labelledby="dialog-title"></dialog>`;
  const thread = document.querySelector('.thread'); if (thread) thread.scrollTop = thread.scrollHeight;
  if (!state.busy && restoreTab) app.querySelector('[data-tab="' + CSS.escape(restoreTab) + '"]')?.focus({ preventScroll: true });
  else if (!state.busy && restoreAction) app.querySelector('[data-action="' + CSS.escape(restoreAction) + '"]')?.focus({ preventScroll: true });
}
function evidence(entry) {
  return `<details class="response-details"><summary>Sources & response details</summary><div class="evidence">${(entry.evidence || []).map((fact) => `<div><span class="pill ${fact.type === 'provider' ? 'blue' : ''}">${fact.type === 'provider' ? 'Service record' : q(kinds[fact.kind] || 'Memory')}</span><p>${q(fact.text)}</p></div>`).join('')}</div><small>${entry.trace?.learnedResolutions ? entry.trace.learnedResolutions + ' verified resolutions · ' + q(entry.trace.knowledge) + ' · ' : ''}${q(entry.trace?.memory)} · ${entry.trace?.recalled || 0} recalled · ${q(entry.model)} · ${entry.trace?.elapsedMs || 0} ms</small></details>`;
}
function chat(p) {
  return `<section class="panel conversation"><header class="conversation-header"><span class="assistant-mark" aria-hidden="true">∿</span><div><b>Continuum assistant</b><small>Here to help you move forward</small></div><button class="memory-switch ${state.memory ? 'on' : ''}" data-action="toggle" role="switch" aria-checked="${state.memory}" ${disabled()}><span aria-hidden="true"></span>Memory ${state.memory ? 'on' : 'off'}</button></header><div class="thread" role="log" aria-label="Conversation" aria-live="off" tabindex="0">${state.messages.length ? state.messages.map((entry) => `<div class="message-pair">${entry.system ? '' : `<div class="bubble customer">${q(entry.message)}</div>`}<div class="assistant-response"><span class="assistant-mark" aria-hidden="true">∿</span><div class="answer-content">${entry.response.human ? '<span class="pill green">Specialist resolution</span>' : ''}<div class="bubble answer">${q(entry.response.reply)}</div>${evidence(entry.response)}<div class="response-controls"><small>${formatDate(entry.createdAt)}</small><button class="text-button" data-rating="5" data-id="${q(entry.id)}" aria-label="Mark response helpful" aria-pressed="${entry.rating === 5}" ${disabled()}>Helpful</button><button class="text-button" data-rating="1" data-id="${q(entry.id)}" aria-label="Mark response needs improvement" aria-pressed="${entry.rating === 1}" ${disabled()}>Needs work</button></div>${entry.response.action?.completedAt ? '<span class="pill green">Action confirmed</span>' : entry.response.action ? `<button class="button small" data-proposal="${q(entry.id)}" ${disabled()}>Review ${q(names[entry.response.action.kind].toLowerCase())} →</button>` : ''}</div></div></div>`).join('') : `<div class="welcome"><span class="assistant-mark large" aria-hidden="true">∿</span><h2>Good to see you, ${q(p.name.split(' ')[0])}.</h2><p>Ask a question. We’ll check the latest status<br>and pick up the relevant context.</p><button class="suggestion" data-prompt="${q(suggestedQuestion(p))}" ${disabled()}>${q(suggestedQuestion(p))} <span>↗</span></button><button class="suggestion" data-prompt="Please schedule an appointment for a visit" ${disabled()}>Find a time to visit <span>↗</span></button></div>`}${state.pendingMessage ? `<div class="bubble customer">${q(state.pendingMessage)}</div><div class="thinking" role="status"><span class="status-dot"></span>Checking your request…</div>` : ''}${state.pendingChat && !state.busy ? `<div class="notice error">Your message wasn’t confirmed. <button class="text-button" data-action="retry-chat">Retry safely →</button></div>` : ''}</div><form id="chat-form" class="composer"><label class="sr-only" for="message">Your message</label><textarea id="message" name="message" rows="1" required maxlength="1400" placeholder="Ask about your request…" ${disabled()}>${q(state.draft)}</textarea><button class="button primary" type="submit" ${disabled()} aria-label="Send message">${state.busy ? 'Sending…' : 'Send ↑'}</button></form><div class="composer-footer"><span>Conversation saved · ${state.memory ? 'Relevant context remembered' : 'Long-term memory paused'}</span>${state.messages.length ? `<button class="text-button" data-action="archive" ${disabled()}>New conversation</button>` : ''}</div></section>`;
}
function appointments(t) {
  const visits = [...t.appointments].sort((a, b) => a.datetime.localeCompare(b.datetime));
  return `<section class="panel content-panel"><div class="content-heading"><div><div class="eyebrow">APPOINTMENTS</div><h2>Your upcoming visits</h2></div><button class="button primary small" data-action="book" ${disabled()}>Book a visit +</button></div><p class="muted">All appointment times are in India Standard Time (UTC+05:30).</p>${visits.length ? visits.map((b) => `<article class="visit"><div class="calendar-tile"><strong>${new Date(b.datetime).toLocaleDateString('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' })}</strong><small>${new Date(b.datetime).toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' })}</small></div><div><b>${formatDate(b.datetime, true)} IST</b><small>${q(t.assignedTo)}</small><span class="pill ${b.cancelledAt ? '' : 'green'}">${b.cancelledAt ? 'Cancelled' : new Date(b.datetime) < new Date() ? 'Past visit' : 'Confirmed'}</span></div>${!b.cancelledAt && new Date(b.datetime) > new Date() ? `<div class="visit-actions"><button class="text-button" data-calendar="${q(b.id)}">Add to calendar</button><button class="text-button danger" data-cancel="${q(b.id)}" ${disabled()}>Cancel visit</button></div>` : ''}</article>`).join('') : '<div class="empty-state"><span class="empty-icon">▦</span><h3>No visits scheduled</h3><p>Choose an available time to meet your service team.</p></div>'}</section>`;
}
function activity(t) {
  const items = state.workspace.activity.filter((a) => a.ticketId === t.id && a.kind !== 'chat');
  const descriptions = { request: 'Request created', requirement: 'Note added', book: 'Visit booked', cancel: 'Visit cancelled', handoff: 'Specialist handoff queued', outcome: 'Outcome updated', invalidate: 'Memory retired' };
  return `<section class="panel content-panel"><div class="eyebrow">REQUEST HISTORY</div><h2>Every step, in one place.</h2>${items.length ? `<ol class="timeline">${items.map((item) => `<li><span class="timeline-dot"></span><div><b>${q(descriptions[item.kind] || item.kind)}</b><p>${q(item.note || item.summary || (item.datetime ? formatDate(item.datetime, true) + ' IST' : item.outcome || ''))}</p><small>${formatDate(item.createdAt, true)}</small></div></li>`).join('')}</ol>` : '<div class="empty-state"><span class="empty-icon">↺</span><h3>A fresh start</h3><p>Confirmed updates and appointments will appear here.</p></div>'}</section>`;
}
function lab(p) {
  return `<section class="panel content-panel lab"><div class="eyebrow">MEMORY LAB</div><h2>Same question. Better context.</h2><p class="muted">Compare responses with and without memory. This comparison doesn’t save a conversation or change your records.</p><form id="compare-form"><label for="compare">Your question</label><textarea id="compare" name="message" required maxlength="1400" ${disabled()}>${q(state.compare?.message || suggestedQuestion(p))}</textarea><button class="button primary" ${disabled()}>${state.busy ? 'Comparing…' : 'Compare responses →'}</button></form>${state.compare?.off && state.compare?.on ? `<div class="compare-grid">${[['Memory off', state.compare.off], ['Memory on', state.compare.on]].map(([name, value]) => `<article><span class="pill ${name.endsWith('on') ? 'green' : ''}">${name}</span><p>${q(value.reply)}</p>${evidence(value)}</article>`).join('')}</div><p class="notice success">${state.compare.on.trace.recalled} remembered details with memory on · ${state.compare.off.trace.recalled} with memory off.</p>` : '<div class="empty-state compact"><p>A useful detail can change the next step.</p></div>'}</section>`;
}
async function send(text, retry = false) {
  if (state.busy || !text.trim()) return;
  state.error = ''; state.notice = ''; state.busy = true; state.pendingMessage = text;
  const key = retry && state.pendingChat ? state.pendingChat.key : crypto.randomUUID();
  state.pendingChat = { text, key }; render();
  try {
    const result = await api('chat', { body: { message: text, ticketId: state.ticketId, memory: state.memory }, key });
    state.draft = ''; state.pendingChat = null;
    document.querySelector('#announcer').textContent = result.reply;
    state.messages.push({ id: result.id, message: text, response: result, createdAt: new Date().toISOString() });
    try { await refresh(); } catch (e) { if (state.authenticated) state.notice = 'Message saved. Some workspace details couldn’t refresh.'; }
  } catch (e) { state.error = e.message; state.draft = text; }
  finally { state.busy = false; state.pendingMessage = ''; if (state.authenticated) { render(); document.querySelector('#message')?.focus({ preventScroll: true }); } }
}
async function openAction(kind, preset = {}) {
  if (state.busy) return;
  const dialog = document.querySelector('#action-dialog');
  let fields = {
    request: `<label>Request title<input name="title" required maxlength="100" placeholder="e.g. Laptop keyboard repair" value="${q(preset.title)}"></label><label>What needs attention?<textarea name="issueDesc" required maxlength="1000" placeholder="Tell us what happened…">${q(preset.issueDesc)}</textarea></label>`,
    requirement: `<label>Note for your service team<textarea name="note" required maxlength="1000" placeholder="e.g. Please call before any paid work.">${q(preset.note)}</textarea></label>`,
    handoff: `<p class="muted">Your specialist receives the service record${state.memory ? ', relevant memories,' : ''} and recent activity.</p><label>What do you need help with?<textarea name="summary" required maxlength="1400">${q(preset.summary)}</textarea></label>`,
    outcome: '<label>What happened?<select name="outcome"><option value="resolved">Issue resolved</option><option value="failed">Fix didn’t work · reopen request</option><option value="missed">Commitment missed · follow up</option></select></label><label>Details<textarea name="note" required maxlength="1000" placeholder="Add a little context for your team…"></textarea></label>',
    invalidate: '<p>This detail will no longer be used in future responses. You can still see it under retired context.</p>',
    cancel: `<p>Cancel your visit on <b>${q(formatDate(preset.datetime, true))} IST</b>? This releases the time for another customer.</p>`,
    archive: '<p>Your current conversation will be archived. Your service record and remembered context stay available.</p>',
  }[kind];
  if (kind === 'book') {
    message('Checking available times…');
    const result = await api('slots?ticketId=' + encodeURIComponent(state.ticketId));
    fields = result.slots.length ? `<label>Available time · IST<select name="datetime" required>${result.slots.map((slot) => `<option value="${q(slot.id)}">${formatDate(slot.id, true)} IST</option>`).join('')}</select></label><p class="fine-print">Availability is checked again when you confirm.</p>` : '<p>No visits are currently available. Please check back later.</p>';
    state.notice = ''; message('');
  }
  dialog.innerHTML = `<form id="action-form" data-kind="${kind}" data-id="${q(preset.id)}" data-key="${crypto.randomUUID()}" data-proposal-id="${q(preset.proposalId)}"><div class="dialog-header"><span class="eyebrow">REVIEW & CONFIRM</span><button class="icon-button" type="button" data-action="close" aria-label="Close dialog">×</button></div><h2 id="dialog-title">${q(names[kind])}</h2>${fields}<p id="action-error" class="notice error" role="alert" hidden></p><div class="dialog-buttons"><button type="button" class="button" data-action="close">Go back</button>${kind !== 'book' || fields.includes('<select') ? '<button class="button primary" type="submit">Confirm →</button>' : ''}</div></form>`;
  dialog.showModal();
}
app.addEventListener('input', (event) => {
  if (event.target.id === 'message') state.draft = event.target.value;
  if (event.target.id === 'request-search') { state.search = event.target.value; document.querySelector('#request-list').innerHTML = requestList(); }
});
app.addEventListener('keydown', (event) => {
  if (event.target.id === 'message' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.querySelector('#chat-form').requestSubmit(); }
});
app.addEventListener('change', (event) => {
  if (event.target.id === 'request-filter') { state.filter = event.target.value; document.querySelector('#request-list').innerHTML = requestList(); }
  if (event.target.closest('#action-form')) event.target.closest('form').dataset.key = crypto.randomUUID();
});
app.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  const { action, tab, ticket: selected, prompt, proposal, retire, cancel, calendar, rating, id } = button.dataset;
  if (state.busy && action !== 'close') return;
  try {
    if (action === 'retry-login') return login();
    if (action === 'account') {
      if (state.account.demo) { message('You’re using a fictional demo account. Sign out and create a personal account to manage connections.'); return; }
      return await openAccount(document.querySelector('#action-dialog'), state.account, signedOut);
    }
    if (action === 'refresh') {
      state.busy = true; state.error = ''; render();
      try { await refresh(); state.notice = 'Your workspace is up to date.'; }
      finally { state.busy = false; if (state.authenticated) render(); }
      return;
    }
    if (action === 'switch') { await api('session', { method: 'DELETE' }); return await signedOut(); }
    if (action === 'close') { if (!document.querySelector('#action-form [type=submit]')?.disabled) document.querySelector('#action-dialog').close(); return; }
    if (action === 'toggle') { state.memory = !state.memory; state.pendingChat = null; render(); }
    if (action === 'retry-chat') return send(state.pendingChat.text, true);
    if (tab) { state.tab = tab; render(); }
    if (selected && selected !== state.ticketId) {
      state.busy = true; state.ticketId = selected; state.draft = ''; state.pendingChat = null; state.reflection = null; state.compare = null; state.error = ''; state.notice = '';
      try { await refresh(); } finally { state.busy = false; if (state.authenticated) render(); }
    }
    if (prompt) return send(prompt);
    if (proposal) { const item = state.messages.find((m) => m.id === proposal)?.response.action; if (item) return await openAction(item.kind, { ...item, proposalId: proposal }); }
    if (retire) return await openAction('invalidate', { id: retire });
    if (cancel) return await openAction('cancel', ticket().appointments.find((a) => a.id === cancel));
    if (calendar) {
      if (calendarUrl) URL.revokeObjectURL(calendarUrl);
      calendarUrl = calendarLink(ticket().appointments.find((a) => a.id === calendar), 'Continuum service visit');
      const a = document.createElement('a'); a.href = calendarUrl; a.download = 'continuum-visit.ics'; a.click();
    }
    if (rating) {
      state.busy = true; button.disabled = true;
      try { await api('feedback', { body: { id, rating: Number(rating) } }); await refresh(); state.notice = 'Thanks. Your feedback has been saved.'; }
      finally { state.busy = false; if (state.authenticated) render(); }
    }
    if (action === 'reflect') {
      state.busy = true; render();
      try { state.reflection = await api('reflect', { body: { ticketId: state.ticketId } }); }
      finally { state.busy = false; if (state.authenticated) render(); }
    }
    if (names[action]) return await openAction(action);
  } catch (e) { message(e.message, true); }
});
app.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.target;
  if (!['chat-form', 'compare-form', 'action-form'].includes(form.id)) return;
  if (state.busy) return;
  const body = Object.fromEntries(new FormData(form));
  if (form.id === 'chat-form') return send(body.message);
  if (form.id === 'compare-form') {
    state.busy = true; state.compare = { ...state.compare, message: body.message }; state.error = ''; render();
    try {
      const payload = { message: body.message, ticketId: state.ticketId, retain: false };
      const [off, on] = await Promise.all([api('chat', { body: { ...payload, memory: false } }), api('chat', { body: { ...payload, memory: true } })]);
      state.compare = { message: body.message, off, on };
    } catch (e) { state.compare = null; state.error = e.message; }
    finally { state.busy = false; if (state.authenticated) render(); }
  }
  if (form.id === 'action-form') {
    const button = form.querySelector('[type=submit]'); button.disabled = true; state.busy = true;
    const fields = [...form.querySelectorAll('input, textarea, select')]; fields.forEach((field) => field.disabled = true);
    const { kind, id, key, proposalId } = form.dataset;
    let committed = false;
    const dialog = form.closest('dialog');
    const preventCancel = (e) => e.preventDefault(); dialog.addEventListener('cancel', preventCancel);
    try {
      const route = kind === 'invalidate' ? 'memory' : kind === 'cancel' ? 'book/cancel' : kind === 'archive' ? 'conversation/archive' : kind;
      const result = await api(route, { method: kind === 'invalidate' ? 'PATCH' : 'POST', key, body: { ...body, id, ...(proposalId && { proposalId }), ticketId: state.ticketId, confirmed: true, memory: state.memory } });
      committed = true;
      if (kind === 'request') { state.ticketId = result.ticketId; state.tab = 'conversation'; state.reflection = null; state.compare = null; }
      if (kind === 'book' || kind === 'cancel') state.tab = 'appointments';
      state.notice = kind === 'archive' ? 'Ready for a new conversation.' : kind === 'invalidate' ? 'Context retired.' : names[kind] + ' confirmed.' + (result.retained === 'pending' ? ' Memory sync is pending.' : '');
      state.error = ''; dialog.close(); await refresh();
    } catch (e) {
      if (committed) state.error = 'Your update was saved, but the workspace couldn’t refresh. Reload to see the latest details.';
      else if (state.authenticated) { const error = form.querySelector('#action-error'); error.hidden = false; error.textContent = e.message; }
    } finally {
      dialog.removeEventListener('cancel', preventCancel); button.disabled = false; fields.forEach((field) => field.disabled = false); state.busy = false;
      if (committed && state.authenticated) render();
    }
  }
});
if (location.pathname.replace(/\/+$/, '') === '/desk') {
  document.body.classList.add('desk-page');
  saveSession('continuum-token', null);
  app.innerHTML = '<div class="loading-page" role="status"><span class="assistant-mark large">∿</span><p>Opening your workspace…</p></div>';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const mode = fragment.has('reset') ? 'reset' : fragment.has('verify') ? 'verify' : null;
  if (mode) {
    const link = { token: fragment.get(mode) }; history.replaceState(null, '', '/desk');
    await renderAuth(app, { initialMode: mode, link, onSession: async () => { state.authenticated = true; await refresh(); render(); } });
  } else {
    try { await request('auth/session'); state.authenticated = true; await refresh(); render();
      if (parameters.has('calendar')) { message(parameters.get('calendar') === 'connected' ? 'Google Calendar connected. Visits will sync to your calendar.' : 'Calendar connection cancelled.'); history.replaceState(null, '', '/desk'); }
    } catch (e) { await login(e.status === 401 ? '' : e.message); }
  }
}
