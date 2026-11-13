import {staffAccountControls, bindStaffAccount} from './staff-account.js';
import { request, escapeHtml as q, formatDate } from './client.js';
import { confirmDialog, noteDialog } from './form-kit.js';
import { toast, emptyState } from './toast.js';
import { setTourRole } from './tour.js';
// Results show as a toast; the old line stays as a screen-reader-only record of the last result.
const say = (text, isError = false) => { const line = document.querySelector('#operator-result'); if (line) line.textContent = text; toast(text, { tone: isError ? 'error' : 'success' }); };
const pct = (n) => (n === null || n === undefined ? '—' : Math.round(n * 100) + '%');
const minutes = (ms) => (ms === null || ms === undefined ? '—' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1) + ' h');
const verification = (p) => p.verification === 'customer_confirmed' ? '<span class="pill green">✓ Confirmed by the original customer</span>'
  : p.verification === 'unconfirmed_by_customer' ? '<span class="pill warn">UNCONFIRMED BY CUSTOMER</span>'
  : p.verification === 'imported_declared_verified' ? '<span class="pill blue">Imported · owner-declared verified (not customer-confirmed)</span>'
  : p.verification === 'imported_unverified' ? '<span class="pill">Imported · unverified</span>'
  : p.verification === 'import_pending_review' ? '<span class="pill warn">Imported · waiting for your approval</span>'
  : p.verification === 'imported_approved' ? '<span class="pill blue">Imported · approved by your team</span>'
  : p.verification === 'specialist_revised' ? '<span class="pill blue">Updated by a specialist · not yet confirmed by a customer</span>'
  : p.verification === 'company_configured' ? '<span class="pill blue">Company-configured standard playbook</span>' : '<span class="pill">Not customer-confirmed</span>';
function dashboard(d) {
  if (!d) return '<p class="muted">Results are unavailable right now.</p>';
  const sc = (value, label, cls = '', note = '') => `<div class="stat-card ${cls}"><b>${q(value)}</b><span>${q(label)}</span>${note ? `<small>${q(note)}</small>` : ''}</div>`;
  const t = (value, label, cls = '', note = '') => `<div class="dash-stat ${cls}"><b>${q(value)}</b>${q(label)}${note ? `<small>${q(note)}</small>` : ''}</div>`;
  return `<section class="panel content-panel" aria-labelledby="intel"><h2 id="intel">How support is going</h2>${d.empty ? emptyState({ icon: 'chart', title: 'No activity yet', hint: 'Figures appear here once customers start using this service.' }) : ''}<div class="stat-row">${selfServiceCard(d, sc)}${sc(d.knowledge.flaggedForReview, 'Paused for review', d.knowledge.flaggedForReview ? 'warn' : '', d.knowledge.flaggedForReview ? 'Needs a decision from you' : 'Nothing waiting')}${sc(d.followThrough.slaBreaches, 'Cases past deadline', d.followThrough.slaBreaches ? 'warn' : '', 'Picked up within ' + d.followThrough.slaHours + ' h')}${sc(d.knowledge.customerConfirmedFixes, 'Fixes customers confirmed', 'ok', 'Trusted company knowledge')}</div>
    ${repeatPanel(d)}
    ${topFixes(d)}
    ${staleFixesPanel(d)}
    <details class="infra more-figures"><summary>More figures</summary><div class="dash-grid">
    ${t(d.knowledge.autoPublishedUnconfirmed, 'Fixes not yet confirmed', d.knowledge.autoPublishedUnconfirmed ? 'warn' : '', 'Never counted as confirmed')}
    ${t(d.knowledge.importedRecords, 'Imported fixes', '', 'Not counted as learned from customers')}
    ${t(d.reuse.memorySucceeded + ' / ' + d.reuse.memoryFailed, 'Reused fixes: worked / didn’t', '', d.reuse.memoryPending + ' awaiting feedback')}
    ${t(d.followThrough.overdueConfirmations + ' / ' + d.followThrough.pendingConfirmations, 'Waiting on customers: overdue / pending')}
    ${t(minutes(d.responseTimes.meanFirstSpecialistResponseMs), 'Average first response', '', 'n=' + d.responseTimes.samples.firstResponse)}
    ${t(minutes(d.responseTimes.meanTimeToCustomerConfirmedResolutionMs), 'Average time to a confirmed fix', '', 'n=' + d.responseTimes.samples.confirmedResolution)}
  </div></details><details><summary>How to read these numbers</summary><ul>${d.notes.map((n) => `<li>${q(n)}</li>`).join('')}</ul></details></section>`;
}
function repeatPanel(d) {
  const r = d.repeatProblems;
  if (!r || (!r.baseline.requests && !r.after.requests)) return '';
  const pc = (x) => (x.rate === null ? '—' : Math.round(x.rate * 100) + '%');
  const lift = r.liftPoints === null ? '' : `<p class="muted">${r.liftPoints >= 0 ? 'Up ' : 'Down '}${Math.abs(r.liftPoints)} points since your first reusable fix. These are different requests, so this shows direction, not proof of cause.</p>`;
  return `<div class="repeat-panel" aria-labelledby="repeat-h"><h3 id="repeat-h">Repeat problems answered without a specialist ${r.synthetic ? '<span class="pill warn">SYNTHETIC SAMPLE DATA</span>' : ''}</h3>
    <div class="repeat-compare"><div class="dash-stat"><b>${q(pc(r.baseline))}</b>Before the first reusable fix<small>${q(r.baseline.solvedWithoutSpecialist)} of ${q(r.baseline.requests)} requests</small></div><span aria-hidden="true" class="repeat-arrow">→</span><div class="dash-stat ok"><b>${q(pc(r.after))}</b>After<small>${q(r.after.solvedWithoutSpecialist)} of ${q(r.after.requests)} requests</small></div></div>${lift}${r.synthetic ? '<p class="notice">This company holds invented sample data created to show the product. It is not a result from real customers.</p>' : ''}</div>`;
}
const STALE_WHY = { success_drop: 'Success is dropping', version_lag: 'Customers are on newer versions', not_reconfirmed: 'Not reconfirmed in a long time' };
function staleFixesPanel(d) {
  if (!d.staleFixes?.length) return '';
  return `<div class="stale-panel"><h3>Fixes that deserve a fresh look</h3><ul class="plain-list">${d.staleFixes.slice(0, 6).map((f) => `<li><b>${q(f.title)}</b> ${f.signals.map((s) => `<span class="pill warn" title="${q(s.detail)}">${q(STALE_WHY[s.kind] || s.kind)}</span>`).join(' ')}<br><small>${q(f.signals.map((s) => s.detail).join(' '))}</small> <a href="#knowledge">Review</a></li>`).join('')}</ul><small class="muted">Nothing changes automatically. A person decides whether to keep, revise or retire each fix.</small></div>`;
}
function selfServiceCard(d, sc) {
  const s = d.selfService;
  if (!s || !s.requestsWithSuggestions) return sc('—', 'Solved without a specialist', '', 'Appears once customers try suggested fixes');
  return sc(Math.round(s.deflectionRate * 100) + '%', 'Solved without a specialist', s.deflectionRate >= 0.3 ? 'ok' : '', s.solvedWithoutSpecialist + ' of ' + s.requestsWithSuggestions + ' requests with a suggested fix');
}
function topFixes(d) {
  if (!d.topFixes?.length) return '';
  return `<div><h3>Fixes that solved the most problems</h3><ol class="top-fixes">${d.topFixes.map((f) => `<li><b>${q(f.title)}</b> · solved ${q(f.successes)} ${f.successes === 1 ? 'problem' : 'problems'}${f.failures ? ` · did not work ${q(f.failures)} ${f.failures === 1 ? 'time' : 'times'}` : ''}</li>`).join('')}</ol></div>`;
}
function queue(ft, bots) {
  const open = (ft?.tasks || []).filter((t) => t.status === 'pending' || t.status === 'escalated' || t.status === 'auto_published');
  return `<section class="panel content-panel" aria-labelledby="ft"><h2 id="ft">Waiting on a deadline</h2><p class="muted">Customers have ${q(ft?.confirmationHours)} h to confirm a fix; cases should be picked up within ${q(ft?.slaHours)} h. Silence is never treated as success.</p>${open.length ? `<div class="table-scroll"><table><thead><tr><th>Type</th><th>Case</th><th>Due</th><th>State</th><th>Next step</th></tr></thead><tbody>${open.map((t) => `<tr><td>${q(t.type.replaceAll('_', ' '))}</td><td>${q(t.ticketId)}</td><td>${q(formatDate(t.deadlineAt, true))}${t.overdue ? ' <span class="pill warn">OVERDUE</span>' : ''}</td><td>${q(t.status.replaceAll('_', ' '))}</td><td>${q(t.nextStep)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Nothing is waiting on a deadline.</p>'}</section>`;
}
const STATUS_PILL = { flagged_for_review: ['warn', 'Paused for review'], superseded: ['', 'Older version'], retired: ['', 'Retired'] };
const SEARCH_PILL = { updating: ['', 'Search updating'], needs_attention: ['warn', 'Search needs attention'] };
function healthPanel(h) {
  if (!h) return '';
  const { search, waitingApproval, tasks } = h.summary;
  const label = { ready: ['green', 'Ready'], updating: ['', 'Updating' + (search.pending ? ' (' + search.pending + ')' : '')], basic: ['', 'Basic mode'], limited: ['warn', 'Temporarily limited'], attention: ['warn', 'Needs attention'] }[search.state];
  const note = { basic: 'Searching uses keywords and built-in matching.', limited: 'The smart search index cannot be reached right now, so keyword search is being used. Nothing is lost.', attention: 'Some fixes could not be added to search yet.' }[search.state] || '';
  const d = h.details;
  return `<section class="panel content-panel" aria-labelledby="health"><h2 id="health">Status</h2><ul class="plain-list">
    <li><b>Knowledge search</b> <span class="pill ${label[0]}">${q(label[1])}</span> ${note ? '<small>' + q(note) + '</small>' : ''}</li>
    <li><b>Waiting for your approval</b> <span class="pill ${waitingApproval ? 'warn' : 'green'}">${waitingApproval ? q(waitingApproval) + (waitingApproval === 1 ? ' fix' : ' fixes') : 'Nothing'}</span> ${waitingApproval ? '<a href="#knowledge">Review</a>' : ''}</li>
    <li><b>Updates sent to your ticket system</b> <span class="pill ${h.summary.syncedUpdates?.state === 'attention' ? 'warn' : 'green'}">${h.summary.syncedUpdates?.state === 'attention' ? q(h.summary.syncedUpdates.failed) + ' failed · ' + q(h.summary.syncedUpdates.overdue) + ' late' : 'All delivered'}</span></li>
    <li><b>Background work</b> <span class="pill ${tasks.state === 'ok' ? 'green' : 'warn'}">${tasks.state === 'ok' ? 'All running' : q(tasks.count) + ' need attention'}</span> ${tasks.state === 'ok' ? '' : '<button class="button small" id="health-retry">Try again</button>'}</li>
  </ul><details><summary>Details</summary><dl class="passport-meta"><dt>Searchable fixes</dt><dd>${q(d.knowledge.indexed)} ready · ${q(d.knowledge.pending)} updating · ${q(d.knowledge.failed)} need attention</dd><dt>Search method</dt><dd>${q(d.embedding.neural ? 'Smart matching (' + d.embedding.model + ')' : 'Built-in matching')}</dd>${d.workers.filter((w) => w.lastError).map((w) => '<dt>' + q(w.name.replaceAll('-', ' ')) + '</dt><dd>' + q(w.lastError) + '</dd>').join('')}</dl></details></section>`;
}
function passportCard(p, chatbotId) {
  const flagged = p.status === 'flagged_for_review';
  const current = ['active', 'flagged_for_review'].includes(p.status);
  const steps = (p.steps || []).join(' ');
  const waiting = p.verification === 'import_pending_review';
  const state = STATUS_PILL[p.status];
  const search = SEARCH_PILL[p.searchStatus];
  const restrictions = (p.safety.restrictions || []).map((r) => r.text).join('; ');
  return `<article class="card" data-passport="${q(p.id)}" data-state="${flagged ? 'needs' : p.status === 'active' ? 'use' : 'older'}">${verification(p)} <span class="pill">Version ${q(p.version)}</span>${state ? ` <span class="pill ${state[0]}">${state[1]}</span>` : ''}${search ? ` <span class="pill ${search[0]}">${search[1]}</span>` : ''}${p.successes ? ` <span class="pill green">Solved ${q(p.successes)} ${p.successes === 1 ? 'problem' : 'problems'}</span>` : ''}<h3>${q(p.title)}</h3><p>${q(p.symptoms)}</p>
    <dl class="passport-meta"><dt>Applies to</dt><dd>${q(p.applicability.environmentText || (p.applicability.conditions || []).map((c) => c.key + ': ' + (c.values || []).join(' or ')).join('; ') || 'Any device')}</dd>
    <dt>Steps</dt><dd>${q(steps)}</dd>${restrictions ? `<dt>Do not use if</dt><dd>${q(restrictions)}</dd>` : ''}</dl>
    <details><summary>More details</summary><dl class="passport-meta"><dt>Source</dt><dd>${q(p.originLabel)}</dd><dt>Safety</dt><dd>${q(restrictions || (p.safety.noneIdentified ? 'None identified' : 'None recorded'))}</dd><dt>Track record</dt><dd>${q(pct(p.reliability))} reliable · ${q(p.successes)} worked · ${q(p.failures)} did not${p.consecutiveFailures ? ' (' + q(p.consecutiveFailures) + ' in a row)' : ''}</dd>${p.sourceTicketId ? `<dt>From case</dt><dd>${q(p.sourceTicketId)}</dd>` : ''}${p.parentVersionId ? `<dt>Earlier version</dt><dd>This replaces ${q(p.parentVersionId)}. Its customer confirmation does not carry over.</dd>` : ''}</dl></details>
    ${flagged ? `<p class="notice">${waiting ? 'Imported from your knowledge base. Customers will not see it until you approve it.' : 'Paused for review: ' + q(p.flaggedReason || 'flagged') + '.'}</p><form data-review="${q(p.id)}" data-review-revision="${q(p.failures)}"><label>${waiting ? 'Short note (kept with your decision)' : 'Why is this decision appropriate?'}<textarea name="note" required maxlength="1000"></textarea></label><div class="decision-row"><button class="button success" name="decision" value="keep">${waiting ? 'Approve: customers can receive this fix' : 'Keep this fix'}</button><span class="decision-gap" aria-hidden="true"></span><button class="button danger-ghost" name="decision" value="retire">${waiting ? 'Do not use this fix' : 'Retire this fix'}</button></div><p role="alert" hidden></p></form>` : ''}
    ${current && p.origin !== 'standard_playbook' ? `<details><summary>Publish a revised version</summary><form data-revise="${q(p.id)}" data-version="${q(p.version)}"><label>Title<input name="title" required maxlength="100" value="${q(p.title)}"></label><label>Applies to<input name="environment" required maxlength="500" value="${q(p.applicability.environmentText || '')}"></label><label>Steps<textarea name="solution" required maxlength="2000">${q(steps)}</textarea></label><label>Safety restrictions<input name="safety" maxlength="1000" value="${q(restrictions)}" placeholder="None identified"></label><label>What changed?<input name="note" maxlength="500"></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><button class="button small primary">Publish version ${q(p.version + 1)}</button><p role="alert" hidden></p></form>${p.status === 'active' ? `<button class="button small" data-retire="${q(p.id)}">Retire</button>` : ''}</details>` : ''}</article>`;
}
let selectedCase = null;
export async function mountOperator() {
  const app = document.querySelector('#app');
  try {
    const data = await request('operator' + location.search);
    const health = data.role === 'owner' ? await request('company/system-health').catch(() => null) : null;
    const intel = await request('companies/' + encodeURIComponent(data.companyId) + '/intelligence?chatbotId=' + encodeURIComponent(data.chatbot.id)).catch(() => null);
    const formStart = (h, kind) =>
      `<form data-case="${q(h.id)}" data-revision="${h.revision || 0}" data-kind="${kind}" data-key="${crypto.randomUUID()}">`;
    const error = '<p class="notice error" role="alert" hidden></p>';
    const openCases = data.cases.filter((h) => !['Resolved', 'Closed'].includes(h.status)).length;
    const needsYou = data.passports.filter((p) => p.status === 'flagged_for_review').length;
    const reviewPanel = () => {
      const list = data.role === 'owner' ? data.cases.filter((h) => h.ownerReview && !['Resolved', 'Closed'].includes(h.status)) : [];
      if (!list.length) return '';
      return `<section class="panel content-panel" aria-labelledby="needs-review"><h2 id="needs-review">Needs your review</h2><p class="muted">A specialist asked you to look at these cases.</p><ul class="plain-list">${list.map((h) => `<li><b>${q(h.context?.ticket?.title || h.ticketId)}</b> ${h.urgent ? '<span class="pill warn">Urgent</span>' : ''}${h.ownerReview.note ? `<small>${q(h.ownerReview.note)}</small>` : ''} <button type="button" class="button small" data-open-case="${q(h.id)}">Open case</button></li>`).join('')}</ul></section>`;
    };
    // Owners dispatch from a list of active staff; specialists get one-click claim and release and never a one-person dropdown.
    const assignBlock = (h) => {
      if (['Resolved', 'Closed'].includes(h.status)) return '';
      const who = data.staff.find((x) => x.id === h.assignedTo)?.name;
      if (h.status === 'Awaiting confirmation') return h.assignedTo ? `<span class="pill">${h.assignedTo === data.self ? '✓ Assigned to you' : 'Assigned to ' + q(who || 'a specialist')}</span>` : '';
      if (data.role === 'owner') return `${formStart(h, 'assign')}<label>Assign case to specialist<select name="assignedTo">${data.staff.map((x) => `<option value="${q(x.id)}" ${x.id === h.assignedTo ? 'selected' : ''}>${q(x.name)}</option>`).join('')}</select></label><button class="button small primary">${h.assignedTo ? 'Reassign case' : 'Assign case'}</button>${error}</form>`;
      if (!h.assignedTo) return `${formStart(h, 'assign')}<input type="hidden" name="assignedTo" value="${q(data.self)}"><button class="button primary">✋ Claim this case</button>${error}</form>`;
      if (h.assignedTo === data.self) return `<span class="pill green">✓ Assigned to you</span>${formStart(h, 'assign')}<input type="hidden" name="assignedTo" value=""><button class="button small">Release to queue</button>${error}</form>`;
      return `<span class="pill">Assigned to ${q(who || 'another specialist')}</span>`;
    };
    const caseBadges = (h) => `${h.urgent ? '<span class="pill warn">Urgent</span>' : ''}${h.ownerReview ? '<span class="pill blue">Owner review</span>' : ''}`;
    const caseRank = (h) => (['Resolved', 'Closed'].includes(h.status) ? 4 : 0) + (h.urgent ? 0 : 1) + (h.ownerReview ? 0 : 1);
    const caseList = () => `<nav class="case-list" aria-label="Cases"><ul>${[...data.cases].sort((a, b) => caseRank(a) - caseRank(b)).map((h) => `<li><button type="button" class="case-pick" data-case-pick="${q(h.id)}"><b>${q(h.context?.ticket?.title || h.ticketId)}</b><span class="case-meta"><span class="pill">${q(h.status)}</span>${caseBadges(h)}</span><small>${q(data.staff.find((x) => x.id === h.assignedTo)?.name || 'Unassigned')}</small></button></li>`).join('')}</ul></nav>`;
    app.innerHTML = `<section class="wrap section"><div class="console-head"><span class="eyebrow">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'} · ${data.provider === 'it' ? 'IT INCIDENTS' : 'DEVICE REPAIR'}</span><h1>${q(data.chatbot.name)}</h1></div><p id="operator-result" class="sr-only"></p><div class="console-shell"><nav class="console-side" aria-label="Console sections"><span class="side-title">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'}</span><button type="button" data-nav="overview">Overview</button><button type="button" data-nav="cases">Cases${openCases ? ` <span class="badge">${openCases}</span>` : ''}</button><button type="button" data-nav="knowledge">Knowledge${needsYou ? ` <span class="badge">${needsYou}</span>` : ''}</button>${data.role === 'owner' ? '<span class="side-title">COMPANY</span><a href="/team">Team and data sources</a>' : ''}<span class="side-title">YOU</span>${staffAccountControls}<button type="button" id="refresh-queue">Refresh</button></nav><div class="console-main"><div data-section="overview">${healthPanel(health)}${reviewPanel()}${dashboard(intel)}${queue(data.followThrough)}</div><div data-section="cases" hidden><section class="panel content-panel" aria-labelledby="open-req"><h2 id="open-req">Open customer requests</h2><p class="muted">Every request in this service, including ones not yet escalated to a specialist.</p>${(data.requests || []).length ? `<div class="table-scroll"><table><thead><tr><th>Request</th><th>Customer</th><th>Status</th><th>Opened</th><th>Troubleshooting so far</th></tr></thead><tbody>${data.requests.map((x) => `<tr><td><b>${q(x.title)}</b><br><small>${q(x.ticketId)}</small></td><td>${q(x.customer)}</td><td>${q(x.status)}</td><td>${q(formatDate(x.createdAt, true))}</td><td>${x.attempts.length ? x.attempts.map((a) => q(a.source + (a.source === 'learned' ? ' #' + a.sequence : '') + ': ' + a.outcome)).join('<br>') : 'Nothing suggested yet'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No open requests outside the specialist queue.</p>'}</section><h2>Cases for specialists</h2>${data.cases.length ? '<div class="case-shell">' + caseList() + '<div class="case-detail-area">' : ''}${
      data.cases
        .map((h) => {
          const current = data.resolutions.find((r) => r.id === h.resolutionId);
          const editable =
            (!h.assignedTo || h.assignedTo === data.self || data.role === 'owner') && h.status !== 'Resolved';
          const canWork = editable && h.assignedTo && h.status !== 'Awaiting confirmation';
          const canPropose = canWork && (!current || current.status === 'rejected');
          const open = !['Resolved', 'Closed'].includes(h.status);
          const flag = (kind, value, label, cls) => `<button type="button" class="button small ${cls}" data-flag="${kind}" data-case-id="${q(h.id)}" data-revision="${h.revision || 0}" data-value="${value}">${label}</button>`;
          const flags = editable && open
            ? `<div class="case-flags" role="group" aria-label="Flag this case">${flag('urgent', h.urgent ? 'false' : 'true', h.urgent ? 'Remove urgent flag' : 'Flag as urgent', h.urgent ? '' : 'danger-ghost')}${data.role === 'owner' ? (h.ownerReview ? flag('review', 'false', 'Close owner review', '') : '') : (h.ownerReview ? '' : flag('review', 'true', 'Request owner review', ''))}</div>`
            : '';
          return `<article class="panel content-panel case-detail" data-case-detail="${q(h.id)}" hidden><div class="case-head"><span class="pill">${q(h.status)}</span>${caseBadges(h)}</div><h3>${q(h.context?.ticket?.title || h.ticketId)}</h3><p>${q(h.summary)}</p>${h.followUpRequired ? `<p class="notice">Follow-up required: ${q(h.followUpReason || 'the customer has not confirmed')}</p>` : ''}<p>Assigned: ${q(data.staff.find((s) => s.id === h.assignedTo)?.name || 'Unassigned')}</p>${h.ownerReview ? `<p class="notice">Owner review requested${h.ownerReview.note ? ': ' + q(h.ownerReview.note) : '.'}</p>` : ''}<div class="case-actions">${assignBlock(h)}${flags}</div>
            ${canWork ? `<div class="case-tabs" role="tablist" aria-label="Case sections"><button type="button" role="tab" data-case-tab="history" aria-selected="true">Conversation & history</button><button type="button" role="tab" data-case-tab="progress" aria-selected="false">Update progress</button>${canPropose ? '<button type="button" role="tab" data-case-tab="propose" aria-selected="false">Propose a solution</button>' : ''}</div>` : '<h4 class="case-tab-title">Conversation & history</h4>'}
            <div class="case-panel" data-case-panel="history"><p><b>Status:</b> ${q(h.context?.ticket?.status || h.status)} · <b>ETA:</b> ${q(h.context?.ticket?.eta || 'Not posted')} · <b>Team:</b> ${q(h.context?.ticket?.assignedTo || 'Not assigned')}</p>${(h.context?.memories || []).map((m) => `<p class="memory-entry">${q(m.text)}</p>`).join('')}${h.conversation.map((c) => `<div class="memory-entry"><b>${c.system ? 'Specialist' : 'Customer'}</b><p>${q(c.message)}</p><p>${q(c.response.reply)}</p></div>`).join('')}<h4>Request notes</h4>${(h.context?.ticket?.requirements || []).map((r) => `<p class="memory-entry">${q(r.note)}</p>`).join('') || '<p>No notes recorded.</p>'}<h4>Customer fix attempts</h4>${(h.attempts || []).map(a=>`<p>${q(a.source)} · ${q(a.outcome)} · ${q(JSON.parse(a.snapshot).steps || JSON.parse(a.snapshot).solution || JSON.parse(a.snapshot).reason)}</p>`).join('')}<h4>Timeline</h4><ol class="timeline-list">${(h.timeline || []).map((e) => `<li><time datetime="${q(e.at)}">${q(formatDate(e.at, true))}</time>${q(e.kind.replaceAll('_', ' '))}${e.detail?.label ? ' · ' + q(e.detail.label) : ''}</li>`).join('') || '<li>No events recorded yet.</li>'}</ol><h4>Troubleshooting</h4>${(h.troubleshooting || []).map((s) => `<p><span class="pill">${q(s.outcome)}</span> ${q(s.step)}</p>`).join('') || '<p>No steps recorded yet.</p>'}</div>
            ${canWork ? `<div class="case-panel" data-case-panel="progress" hidden>${formStart(h, 'progress')}<label>Status<select name="status"><option>In progress</option><option>Waiting for parts</option><option>Awaiting customer</option></select></label><label>Expected completion<input name="eta" type="date" value="${q(h.context?.ticket?.eta || '')}"></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Customer-visible update<textarea name="note" required maxlength="2000"></textarea></label><label>Troubleshooting step (optional)<textarea name="step" maxlength="1000"></textarea></label><label>Step outcome<select name="stepOutcome"><option value="attempted">Attempted</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option></select></label><button class="button">Save progress</button>${error}</form></div>` : ''}
            ${canPropose ? `<div class="case-panel" data-case-panel="propose" hidden>${formStart(h, 'resolve')}<label>Reusable title<input name="title" required maxlength="100"></label><label>Applicable product and versions<input name="environment" required maxlength="500"></label><label>Verified solution steps<textarea name="solution" required maxlength="2000"></textarea></label><label>Safety restrictions (or “None identified”)<input name="safety" maxlength="1000" placeholder="None identified"></label><label class="privacy-check"><input type="checkbox" name="safetyReviewed"> I reviewed safety: any restriction above is complete (needed for “None identified” to count).</label><label>Risk level<select name="riskLevel"><option value="standard">Standard</option><option value="high">High risk: never auto-published</option></select></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><div class="actions"><button type="button" class="button small" data-preview>Preview scrubbed passport</button><button class="button primary">Send solution for customer confirmation</button></div><div data-preview-result role="status"></div>${error}</form></div>` : ''}</article>`;
        })
        .join('') || emptyState({ icon: 'inbox', title: 'The queue is clear', hint: 'Cases arrive here when a customer asks for a person or a suggested fix does not help.' })
    }${data.cases.length ? '</div></div>' : ''}</div><div data-section="knowledge" hidden><h2 id="passports">Fixes this service can recommend</h2><p class="muted">Each fix shows where it came from and whether a customer has confirmed it.</p><div class="auth-tabs filter-tabs" role="group" aria-label="Filter fixes">${[['use', 'In use', data.passports.filter((p) => p.status === 'active').length], ['needs', 'Needs you', needsYou], ['older', 'Older versions', data.passports.filter((p) => !['active', 'flagged_for_review'].includes(p.status)).length]].map(([k, label, n]) => `<button type="button" data-fix-filter="${k}">${label} <span class="count">${n}</span></button>`).join('')}</div>${data.passports.filter((p) => p.origin !== 'standard_playbook' || p.status !== 'superseded').map((p) => passportCard(p, data.chatbot.id)).join('') || emptyState({ icon: 'book', title: 'No fixes in the library yet', hint: 'A fix is added when a customer confirms a specialist’s solution, or when you import articles and past tickets.', action: '<a class="button small" href="/team#knowledge">Import knowledge</a>' })}</div></div></div></section>`;
    bindStaffAccount(app);
    // One section at a time: Overview, Cases or Knowledge (kept in the address so Back and bookmarks work).
    const sections = ['overview', 'cases', 'knowledge'];
    const show = (name) => {
      const active = sections.includes(name) ? name : 'overview';
      app.querySelectorAll('[data-section]').forEach((el) => { el.hidden = el.dataset.section !== active; });
      app.querySelectorAll('[data-nav]').forEach((b) => { if (b.dataset.nav === active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    };
    app.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search + '#' + b.dataset.nav); show(b.dataset.nav); }));
    app.querySelectorAll('a[href="#knowledge"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname + location.search + '#knowledge'); show('knowledge'); }));
    show(location.hash.slice(1));
    const pickCase = (id) => {
      selectedCase = id;
      app.querySelectorAll('[data-case-detail]').forEach((el) => { el.hidden = el.dataset.caseDetail !== id; });
      app.querySelectorAll('[data-case-pick]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.casePick === id)));
    };
    const firstCase = app.querySelector('[data-case-pick]')?.dataset.casePick;
    if (firstCase) pickCase(app.querySelector(`[data-case-pick="${CSS.escape(selectedCase || '')}"]`) ? selectedCase : firstCase);
    app.querySelectorAll('[data-case-pick]').forEach((b) => b.addEventListener('click', () => pickCase(b.dataset.casePick)));
    app.querySelectorAll('[data-open-case]').forEach((b) => b.addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search + '#cases'); show('cases'); pickCase(b.dataset.openCase); app.querySelector('[data-section=cases]').scrollIntoView(); }));
    app.querySelectorAll('[data-case-tab]').forEach((b) => b.addEventListener('click', () => {
      const article = b.closest('[data-case-detail]');
      article.querySelectorAll('[data-case-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      article.querySelectorAll('[data-case-panel]').forEach((p) => { p.hidden = p.dataset.casePanel !== b.dataset.caseTab; });
    }));
    app.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', async () => {
      const on = b.dataset.value === 'true', review = b.dataset.flag === 'review';
      let note;
      if (review && on) {
        note = await noteDialog({ title: 'Ask the owner to review this case', label: 'What should the owner look at?', confirm: 'Send to owner', hint: 'Visible to your company team only, never to the customer.' });
        if (note === null) return;
      } else if (!review && on && !(await confirmDialog({ title: 'Mark this case urgent?', body: 'It moves to the top of the list for everyone on the team, and the request shows an Urgent priority.', confirm: 'Mark urgent' }))) return;
      b.disabled = true;
      try {
        await request('operator/flag?chatbotId=' + encodeURIComponent(data.chatbot.id), { body: { handoffId: b.dataset.caseId, revision: Number(b.dataset.revision), [review ? 'ownerReview' : 'urgent']: on, ...(note ? { note } : {}), confirmed: true } });
        await mountOperator();
        say(review ? (on ? 'The owner has been asked to review this case.' : 'Owner review closed.') : (on ? 'Case marked urgent.' : 'Urgent flag removed.'));
      } catch (e) {
        say(e.message, true);
        b.disabled = false;
      }
    }));
    const filterFixes = (kind) => {
      app.querySelectorAll('[data-fix-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fixFilter === kind)));
      app.querySelectorAll('[data-passport]').forEach((card) => { card.hidden = card.dataset.state !== kind; });
    };
    app.querySelectorAll('[data-fix-filter]').forEach((b) => b.addEventListener('click', () => filterFixes(b.dataset.fixFilter)));
    filterFixes(needsYou ? 'needs' : 'use');
    app.querySelectorAll('form[data-review]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        // Read the form BEFORE disabling the buttons: a disabled submitter is left out of FormData, which used to drop the
        // decision (keep / retire) so every review was refused with "Confirm the review decision."
        const fields = Object.fromEntries(new FormData(form, event.submitter));
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach((b) => { b.disabled = true; });
        try {
          await request('operator/review-resolution?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body: {
              ...fields,
              id: form.dataset.review,
              reviewRevision: Number(form.dataset.reviewRevision),
              confirmed: true,
            },
          });
          await mountOperator();
        } catch (e) {
          const alert = form.querySelector('[role=alert]');
          alert.hidden = false;
          alert.textContent = e.message;
          buttons.forEach((b) => { b.disabled = false; });
        }
      }),
    );
    app.querySelectorAll('form[data-revise]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button.primary');
        button.disabled = true;
        try {
          await request('operator/revise?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body: { ...Object.fromEntries(new FormData(form)), id: form.dataset.revise, version: Number(form.dataset.version), reviewedForPrivacy: form.elements.reviewedForPrivacy.checked, confirmed: true },
          });
          await mountOperator();
          say('Revised version published. The previous version is kept as history.');
        } catch (e) {
          const alert = form.querySelector('[role=alert]');
          alert.hidden = false;
          alert.textContent = e.message;
          button.disabled = false;
        }
      }),
    );
    app.querySelectorAll('[data-preview]').forEach((button) =>
      button.addEventListener('click', async () => {
        const form = button.closest('form');
        const target = form.querySelector('[data-preview-result]');
        if (!form.reportValidity()) return;
        try {
          const f = Object.fromEntries(new FormData(form));
          const r = await request('operator/preview-passport?chatbotId=' + encodeURIComponent(data.chatbot.id), { body: { ...f, handoffId: form.dataset.case, reviewedForPrivacy: form.elements.reviewedForPrivacy.checked, safetyReviewed: form.elements.safetyReviewed.checked, confirmed: true } });
          target.innerHTML = `<div class="notice"><b>This is what customers will see${r.redactions ? ' (' + q(r.redactions) + ' personal detail' + (r.redactions === 1 ? '' : 's') + ' removed)' : ''}:</b><p>${q(r.passport.steps.join(' '))}</p><small>It becomes reusable once the customer confirms it worked.</small></div>`;
        } catch (e) {
          target.textContent = e.message;
        }
      }),
    );
    document.querySelector('#refresh-queue').addEventListener('click', mountOperator);
    setTourRole(data.role === 'owner' ? 'owner' : 'staff');
    document.querySelector('#health-retry')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      await request('company/system-health', { body: {} }).catch(() => {});
      await mountOperator();
    });
    app.querySelectorAll('form[data-case]').forEach((form) => {
      form.addEventListener('change', () => {
        form.dataset.key = crypto.randomUUID();
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        const body = {
          ...Object.fromEntries(new FormData(form)),
          handoffId: form.dataset.case,
          revision: Number(form.dataset.revision),
          confirmed: true,
        };
        if (form.dataset.kind === 'resolve') {
          body.reviewedForPrivacy = form.elements.reviewedForPrivacy.checked;
          body.safetyReviewed = form.elements.safetyReviewed.checked;
        }
        if (form.dataset.kind === 'progress' && !body.step) {
          delete body.step;
          delete body.stepOutcome;
        }
        try {
          await request('operator/' + form.dataset.kind + '?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body,
            key: form.dataset.key,
          });
          await mountOperator();
          say('Case update saved.');
        } catch (e) {
          const p = form.querySelector('[role=alert]');
          p.hidden = false;
          p.textContent = e.message;
          button.disabled = false;
        }
      });
    });
    app.querySelectorAll('[data-retire]').forEach((button) =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await request('operator/retire?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body: { id: button.dataset.retire, confirmed: true },
          });
          await mountOperator();
        } catch (e) {
          say(e.message, true);
          button.disabled = false;
        }
      }),
    );
  } catch (e) {
    app.innerHTML = `<section class="wrap section"><h1>Specialist access</h1><p>${q(e.message)}</p><a class="button" href="/desk">Sign in</a></section>`;
  }
}
