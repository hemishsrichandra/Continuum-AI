const app = document.querySelector('#app');
const q = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const parameters = new URLSearchParams(location.search);
const state = { token: sessionStorage.getItem('continuum-token'), memory: true, tab: parameters.has('lab') ? 'lab' : 'chat', thread: [], ledger: [], busy: false };
const actions = { request: 'New request', requirement: 'Add a requirement', book: 'Book a visit', handoff: 'Escalate to a human', outcome: 'Record an outcome', invalidate: 'Retire memory' };
const label = { failed: 'Failed fix', missed: 'Missed commitment', preference: 'Preference', action: 'Confirmed action', resolved: 'Resolved' };
const when = (date) => date ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(date)) : 'Awaiting estimate';

async function api(route, { body, method, publicRoute } = {}) {
  const res = await fetch('/api/' + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(state.token && !publicRoute && { Authorization: 'Bearer ' + state.token }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const result = await res.json();
  if (res.status === 401 && !publicRoute) {
    sessionStorage.removeItem('continuum-token');
    state.token = null;
    login('Your session ended. Verify a demo identity to continue.');
  }
  if (!res.ok) throw new Error(result.error || 'Something went wrong. Try again.');
  return result;
}

function alert(message = '') {
  const element = document.querySelector('#feedback');
  if (element) element.textContent = message;
}

async function login(message = '') {
  app.innerHTML = '<section class="wrap section verify"><div class="eyebrow">DEMO WORKSPACE</div><h1>Open the front desk<span class="brand-dot">.</span></h1><p class="lead">Choose a fictional customer to verify their identity and load their service records.</p><p id="feedback" role="alert">' + q(message) + '</p><form id="login"><fieldset><legend>Demo identity</legend><div class="cards" id="identities">Loading identities…</div></fieldset><div class="login-footer"><label>Demo access code<input name="pin" autocomplete="off" inputmode="numeric" required value="246810"></label><button class="button primary" type="submit">Verify & open workspace ↗</button></div></form></section>';
  try {
    const { profiles } = await api('profiles', { publicRoute: true });
    const selected = profiles.some((p) => p.id === parameters.get('profile')) ? parameters.get('profile') : profiles[0].id;
    document.querySelector('#identities').innerHTML = profiles.map((p) => '<label class="card identity"><input name="profileId" type="radio" value="' + q(p.id) + '"' + (selected === p.id ? ' checked' : '') + '><span class="avatar">' + q(p.initials) + '</span><strong>' + q(p.name) + '</strong><small>' + q(p.label) + ' · ' + q(p.scenario) + '</small></label>').join('');
    document.querySelector('#login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const session = await api('session', { publicRoute: true, body: Object.fromEntries(new FormData(form)) });
        sessionStorage.setItem('continuum-token', session.token);
        state.token = session.token;
        state.ticketId = null;
        state.thread = [];
        state.compare = null;
        state.reflection = null;
        if (parameters.has('profile')) {
          parameters.delete('profile');
          const query = parameters.toString();
          history.replaceState(null, '', '/desk' + (query ? '?' + query : ''));
        }
        await refresh();
      } catch (e) { alert(e.message); } finally { button.disabled = false; }
    });
  } catch (e) { alert(e.message); }
}

async function refresh() {
  state.workspace = await api('workspace');
  state.ticketId ||= state.workspace.profile.ticketId;
  state.ledger = (await api('memory?ticketId=' + encodeURIComponent(state.ticketId))).ledger;
  render();
}

function render() {
  const { profile, tickets, integration, activity } = state.workspace;
  const ticket = tickets.find((t) => t.id === state.ticketId);
  const active = state.ledger.filter((m) => !m.invalidatedAt).length;
  app.innerHTML = '<section class="wrap desk"><div class="desk-heading"><div><div class="eyebrow">SUPPORT WORKSPACE</div><h1>Front desk<span class="brand-dot">.</span></h1><p class="muted">Your service requests and conversation history in one place.</p></div><div class="account"><span class="avatar">' + q(profile.initials) + '</span><div><b>' + q(profile.name) + '</b><small>' + q(profile.label) + ' · Demo verified</small></div><button class="button small" data-action="switch">Switch identity</button></div></div>'
    + '<div class="desk-tabs" aria-label="Workspace view"><button data-tab="chat" aria-pressed="' + (state.tab === 'chat') + '">Front desk chat</button><button data-tab="lab" aria-pressed="' + (state.tab === 'lab') + '">Memory comparison</button><span class="pill ' + (integration.hindsight ? 'green' : '') + '">' + (integration.hindsight ? 'Hindsight configured' : 'Local demo mode') + '</span></div><p id="feedback" role="alert"></p>'
    + '<div class="desk-grid"><aside class="panel ticket-panel"><div class="eyebrow">PROVIDER RECORD</div><label for="ticket">Service request</label><select id="ticket" ' + (state.busy ? 'disabled' : '') + '>' + tickets.map((t) => '<option ' + (t.id === ticket.id ? 'selected' : '') + ' value="' + q(t.id) + '">' + q(t.id + ' · ' + t.title) + '</option>').join('') + '</select><h2>' + q(ticket.title) + '</h2><p class="muted">' + q(ticket.issue) + '</p><span class="pill blue">' + q(ticket.status) + '</span><dl><dt>Current ETA</dt><dd>' + q(when(ticket.eta)) + '</dd><dt>Assigned team</dt><dd>' + q(ticket.assignedTo) + '</dd></dl><h3>Service actions</h3><div class="action-list">' + Object.entries(actions).filter(([kind]) => kind !== 'invalidate').map(([kind, name]) => '<button data-action="' + kind + '" ' + (state.busy ? 'disabled' : '') + '>' + q(name) + ' <span>↗</span></button>').join('') + '</div></aside>'
    + '<div class="desk-main">' + (state.tab === 'lab' ? lab(profile) : chat(profile, active)) + '</div></div>'
    + '<details class="panel activity"><summary>Provider activity</summary>' + (activity.length ? '<ul>' + activity.map((item) => '<li>' + q(item.kind) + ' · ' + q(item.ticketId) + ' · ' + q(when(item.createdAt)) + '</li>').join('') + '</ul>' : '<p class="muted">Confirmed actions will appear here.</p>') + '</details></section><dialog id="action-dialog"></dialog>';
  const thread = document.querySelector('.thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function evidence(entry) {
  return '<div class="evidence">' + entry.evidence.map((fact) => '<details><summary>' + (fact.type === 'provider' ? '◈ ' + q(fact.id) : '↺ ' + q(label[fact.kind] || 'Memory')) + '</summary><p>' + q(fact.text) + '</p></details>').join('') + '</div><small class="trace">' + q(entry.trace.memory) + ' · ' + entry.trace.recalled + ' recalled · ' + q(entry.model) + ' · ' + entry.trace.elapsedMs + ' ms</small>';
}

function chat(profile, count) {
  return '<section class="panel conversation"><header class="conversation-header"><span class="logo">∿</span><div><b>Continuum Assistant</b><small>Grounded in your provider records</small></div><button class="pill ' + (state.memory ? 'green' : '') + '" data-action="toggle" aria-pressed="' + state.memory + '" ' + (state.busy ? 'disabled' : '') + '>● Memory ' + (state.memory ? 'on' : 'off') + '</button></header>'
    + '<div class="thread" aria-live="polite">' + (state.thread.length ? state.thread.map((entry, index) => entry.user ? '<div class="bubble customer">' + q(entry.user) + '</div>' : '<div class="bubble answer">' + q(entry.reply) + (entry.evidence ? evidence(entry) : '') + (entry.action ? '<button class="button small" data-proposal="' + index + '">Review ' + q(actions[entry.action.kind].toLowerCase()) + ' →</button>' : '') + '</div>').join('') : '<div class="welcome"><span class="tile-icon">∿</span><h2>Hi, ' + q(profile.name.split(' ')[0]) + '.</h2><p class="muted">Ask about your service, or start with a suggested question.</p><button class="button small" data-action="prompt">' + q(profile.prompt) + ' ↗</button></div>') + (state.busy ? '<p class="trace" role="status">Checking the provider and available context…</p>' : '') + '</div>'
    + '<form id="chat-form" class="composer"><label class="sr-only" for="message">Your message</label><input id="message" name="message" maxlength="1400" placeholder="Ask about your service request…" required ' + (state.busy ? 'disabled' : '') + '><button type="button" class="button small" data-action="voice" aria-label="Dictate message">♩</button><button type="submit" class="button primary small" ' + (state.busy ? 'disabled' : '') + '>Send ↑</button></form><p class="caption">' + (state.memory ? 'Memory is on. Preferences and service outcomes may be retained.' : 'Memory is off. This conversation skips recall and retention.') + '</p></section>'
    + '<section class="panel memory-panel"><div class="memory-heading"><div><div class="eyebrow">CUSTOMER HISTORY</div><h2>Memory ledger <span class="pill">' + count + ' active</span></h2></div><button class="button small" data-action="reflect" ' + (state.busy || !state.memory ? 'disabled' : '') + '>Reflect ↗</button></div>' + (state.reflection ? '<div class="bubble answer">' + q(state.reflection.text) + '<small class="trace">' + q(state.reflection.source) + '</small></div>' : '') + (state.ledger.length ? state.ledger.map((m) => '<div class="memory-row"><div><span class="pill">' + q(label[m.kind] || m.kind) + '</span><p>' + q(m.text) + '</p><small>' + q(when(m.createdAt)) + (m.invalidatedAt ? ' · Retired' : '') + '</small></div>' + (m.invalidatedAt ? '' : '<button class="button small" data-retire="' + q(m.id) + '" ' + (state.busy ? 'disabled' : '') + '>Retire</button>') + '</div>').join('') : '<p class="muted">There are no retained facts for this ticket yet.</p>') + '</section>';
}

function lab(profile) {
  const { compare } = state;
  return '<section class="panel lab"><div class="eyebrow">THE MEMORY EXPERIMENT</div><h2>Same question. Different context.</h2><p class="muted">Run the same request twice against the same provider record. Neither comparison saves new facts.</p><form id="compare-form" class="composer"><label class="sr-only" for="compare">Comparison question</label><input id="compare" name="message" value="' + q(compare?.message || profile.prompt) + '" required maxlength="1400"><button class="button primary" ' + (state.busy ? 'disabled' : '') + '>' + (state.busy ? 'Comparing…' : 'Run comparison ↗') + '</button></form>'
    + (compare ? '<div class="compare-grid">' + [['Memory off', compare.off], ['Memory on', compare.on]].map(([name, value]) => '<article class="card"><span class="pill ' + (name.endsWith('on') ? 'green' : '') + '">' + name + '</span><p>' + q(value.reply) + '</p>' + evidence(value) + '</article>').join('') + '</div><p class="comparison-result"><strong>Observed difference</strong> · ' + compare.on.trace.recalled + ' recalled facts with memory on vs ' + compare.off.trace.recalled + ' with memory off. ' + (compare.on.action?.kind === 'handoff' && compare.off.action?.kind !== 'handoff' ? 'Only the memory-on response prepared a handoff.' : '') + '</p>' : '') + '</section>';
}

async function send(message) {
  state.thread.push({ user: message });
  state.busy = true;
  render();
  try {
    const result = await api('chat', { body: { message, ticketId: state.ticketId, memory: state.memory } });
    state.thread.push(result);
    if (result.retained) await refresh();
  } catch (e) { state.thread.push({ reply: e.message }); } finally {
    state.busy = false;
    if (state.token) { render(); document.querySelector('#message')?.focus(); }
  }
}

async function openAction(kind, preset = {}) {
  const dialog = document.querySelector('#action-dialog');
  const names = {
    request: '<label>Request title<input required name="title" maxlength="100" value="' + q(preset.title) + '"></label><label>What needs attention?<textarea name="issueDesc" required maxlength="1000">' + q(preset.issueDesc) + '</textarea></label>',
    requirement: '<label>Requirement<textarea name="note" required maxlength="1000">' + q(preset.note) + '</textarea></label>',
    handoff: '<label>Reason for escalation<textarea name="summary" required maxlength="1400">' + q(preset.summary) + '</textarea></label><p class="muted">The handoff includes the service record and ' + (state.memory ? 'relevant retained context.' : 'recent activity.') + '</p>',
    outcome: '<label>Outcome<select name="outcome"><option value="failed">Fix failed</option><option value="resolved">Resolved</option><option value="missed">Deadline missed</option></select></label><label>What happened?<textarea name="note" required maxlength="1000"></textarea></label>',
    invalidate: '<p>Retire this memory so it is excluded from future recall. Its audit record will remain visible.</p>',
  };
  if (kind === 'book') {
    const { slots } = await api('slots?ticketId=' + encodeURIComponent(state.ticketId));
    names.book = slots.length ? '<label>Available time (IST)<select required name="datetime">' + slots.map((slot) => '<option value="' + q(slot.id) + '">' + q(when(slot.date) + ' · ' + slot.time) + '</option>').join('') + '</select></label>' : '<p>No appointments are currently available.</p>';
  }
  dialog.innerHTML = '<form id="action-form" data-kind="' + q(kind) + '"><div class="eyebrow">REVIEW & CONFIRM</div><h2>' + q(actions[kind]) + '</h2>' + names[kind] + '<p id="action-error" role="alert"></p><div class="dialog-buttons"><button type="button" class="button" data-action="close">Cancel</button>' + (kind !== 'book' || names.book.includes('<select') ? '<button class="button primary" type="submit">Confirm →</button>' : '') + '</div></form>';
  dialog.querySelector('form').dataset.id = preset.id || '';
  dialog.showModal();
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { action, tab, proposal, retire } = button.dataset;
  try {
    if (tab && !state.busy) { state.tab = tab; render(); }
    if (action === 'switch' && !state.busy) {
      sessionStorage.removeItem('continuum-token');
      state.token = null; state.memory = true; state.reflection = null;
      await login();
    }
    if (action === 'toggle') { state.memory = !state.memory; render(); }
    if (action === 'prompt') await send(state.workspace.profile.prompt);
    if (action === 'close') document.querySelector('#action-dialog').close();
    if (proposal !== undefined) {
      const item = state.thread[Number(proposal)].action;
      await openAction(item.kind, item);
    }
    if (retire) await openAction('invalidate', { id: retire });
    if (action && actions[action]) await openAction(action);
    if (action === 'reflect') {
      button.disabled = true;
      try { state.reflection = await api('reflect', { body: { ticketId: state.ticketId } }); render(); }
      finally { button.disabled = false; }
    }
    if (action === 'voice') {
      const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Speech) throw new Error('Voice input is unavailable in this browser. You can type your message instead.');
      const recognition = new Speech();
      recognition.lang = 'en-IN';
      recognition.onresult = (result) => { const input = document.querySelector('#message'); if (input) input.value = result.results[0][0].transcript; };
      recognition.onerror = () => alert('Voice input was interrupted. Check microphone permissions or type your message.');
      recognition.start();
    }
  } catch (e) { alert(e.message); }
});

app.addEventListener('change', async (event) => {
  if (event.target.id !== 'ticket') return;
  state.ticketId = event.target.value;
  state.thread = []; state.compare = null; state.reflection = null;
  try { await refresh(); } catch (e) { alert(e.message); }
});

app.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'login') return;
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  if (form.id === 'chat-form') await send(body.message);
  if (form.id === 'compare-form') {
    state.busy = true; render();
    try {
      const payload = { message: body.message, ticketId: state.ticketId, retain: false };
      const off = await api('chat', { body: { ...payload, memory: false } });
      const on = await api('chat', { body: { ...payload, memory: true } });
      state.compare = { message: body.message, off, on };
    } catch (e) { state.busy = false; render(); alert(e.message); return; }
    state.busy = false; render();
  }
  if (form.id === 'action-form') {
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    const { kind, id } = form.dataset;
    let confirmation;
    try {
      const result = await api(kind === 'invalidate' ? 'memory' : kind, {
        method: kind === 'invalidate' ? 'PATCH' : 'POST',
        body: { ...body, id, ticketId: state.ticketId, confirmed: true, memory: state.memory },
      });
      if (kind === 'request') { state.ticketId = result.ticketId; state.thread = []; state.compare = null; state.reflection = null; }
      confirmation = kind === 'invalidate' ? 'Memory retired.' : actions[kind] + ' confirmed. Reference ' + result.id + '.' + (result.retained === 'pending' ? ' Memory sync is pending.' : '');
      form.closest('dialog').close();
      state.thread.push({ reply: confirmation });
      state.tab = 'chat';
    } catch (e) {
      form.querySelector('#action-error').textContent = e.message;
      button.disabled = false;
      return;
    }
    try { await refresh(); alert(confirmation); }
    catch (e) { alert(confirmation + ' The workspace could not refresh. ' + e.message); }
  }
});

if (location.pathname === '/') {
  app.append(document.querySelector('#home').content.cloneNode(true));
} else if (state.token && !parameters.has('profile')) {
  try { await refresh(); } catch (e) { if (state.token) await login(e.message); }
} else {
  await login();
}
