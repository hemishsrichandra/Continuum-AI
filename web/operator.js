import {staffAccountControls, bindStaffAccount} from './staff-account.js';
import { request, escapeHtml as q, formatDate } from './client.js';
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
  return `<section class="panel content-panel" aria-labelledby="intel"><h2 id="intel">How support is going</h2>${d.empty ? '<p class="muted">No activity yet. Figures appear after customers use this service.</p>' : ''}<div class="stat-row three">${sc(d.knowledge.flaggedForReview, 'Paused for review', d.knowledge.flaggedForReview ? 'warn' : '', d.knowledge.flaggedForReview ? 'Needs a decision from you' : 'Nothing waiting')}${sc(d.followThrough.slaBreaches, 'Cases past deadline', d.followThrough.slaBreaches ? 'warn' : '', 'Picked up within ' + d.followThrough.slaHours + ' h')}${sc(d.knowledge.customerConfirmedFixes, 'Fixes customers confirmed', 'ok', 'Trusted company knowledge')}</div>
    <details class="infra more-figures"><summary>More figures</summary><div class="dash-grid">
    ${t(d.knowledge.autoPublishedUnconfirmed, 'Fixes not yet confirmed', d.knowledge.autoPublishedUnconfirmed ? 'warn' : '', 'Never counted as confirmed')}
    ${t(d.knowledge.importedRecords, 'Imported fixes', '', 'Not counted as learned from customers')}
    ${t(d.reuse.memorySucceeded + ' / ' + d.reuse.memoryFailed, 'Reused fixes: worked / didn’t', '', d.reuse.memoryPending + ' awaiting feedback')}
    ${t(d.followThrough.overdueConfirmations + ' / ' + d.followThrough.pendingConfirmations, 'Waiting on customers: overdue / pending')}
    ${t(minutes(d.responseTimes.meanFirstSpecialistResponseMs), 'Average first response', '', 'n=' + d.responseTimes.samples.firstResponse)}
    ${t(minutes(d.responseTimes.meanTimeToCustomerConfirmedResolutionMs), 'Average time to a confirmed fix', '', 'n=' + d.responseTimes.samples.confirmedResolution)}
  </div></details><details><summary>How to read these numbers</summary><ul>${d.notes.map((n) => `<li>${q(n)}</li>`).join('')}</ul></details></section>`;
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
  return `<article class="card" data-passport="${q(p.id)}" data-state="${flagged ? 'needs' : p.status === 'active' ? 'use' : 'older'}">${verification(p)} <span class="pill">Version ${q(p.version)}</span>${state ? ` <span class="pill ${state[0]}">${state[1]}</span>` : ''}${search ? ` <span class="pill ${search[0]}">${search[1]}</span>` : ''}<h3>${q(p.title)}</h3><p>${q(p.symptoms)}</p>
    <dl class="passport-meta"><dt>Applies to</dt><dd>${q(p.applicability.environmentText || (p.applicability.conditions || []).map((c) => c.key + ': ' + (c.values || []).join(' or ')).join('; ') || 'Any device')}</dd>
    <dt>Steps</dt><dd>${q(steps)}</dd>${restrictions ? `<dt>Do not use if</dt><dd>${q(restrictions)}</dd>` : ''}</dl>
    <details><summary>More details</summary><dl class="passport-meta"><dt>Source</dt><dd>${q(p.originLabel)}</dd><dt>Safety</dt><dd>${q(restrictions || (p.safety.noneIdentified ? 'None identified' : 'None recorded'))}</dd><dt>Track record</dt><dd>${q(pct(p.reliability))} reliable · ${q(p.successes)} worked · ${q(p.failures)} did not${p.consecutiveFailures ? ' (' + q(p.consecutiveFailures) + ' in a row)' : ''}</dd>${p.sourceTicketId ? `<dt>From case</dt><dd>${q(p.sourceTicketId)}</dd>` : ''}${p.parentVersionId ? `<dt>Earlier version</dt><dd>This replaces ${q(p.parentVersionId)}. Its customer confirmation does not carry over.</dd>` : ''}</dl></details>
    ${flagged ? `<p class="notice">${waiting ? 'Imported from your knowledge base. Customers will not see it until you approve it.' : 'Paused for review: ' + q(p.flaggedReason || 'flagged') + '.'}</p><form data-review="${q(p.id)}" data-review-revision="${q(p.failures)}"><label>${waiting ? 'Short note (kept with your decision)' : 'Why is this decision appropriate?'}<textarea name="note" required maxlength="1000"></textarea></label><div class="decision-row"><button class="button success" name="decision" value="keep">${waiting ? 'Approve: customers can receive this fix' : 'Keep this fix'}</button><span class="decision-gap" aria-hidden="true"></span><button class="button danger-ghost" name="decision" value="retire">${waiting ? 'Do not use this fix' : 'Retire this fix'}</button></div><p role="alert" hidden></p></form>` : ''}
    ${current && p.origin !== 'standard_playbook' ? `<details><summary>Publish a revised version</summary><form data-revise="${q(p.id)}" data-version="${q(p.version)}"><label>Title<input name="title" required maxlength="100" value="${q(p.title)}"></label><label>Matching symptoms<textarea name="symptoms" required maxlength="1000">${q(p.symptoms)}</textarea></label><label>Applies to<input name="environment" required maxlength="500" value="${q(p.applicability.environmentText || '')}"></label><label>Steps<textarea name="solution" required maxlength="2000">${q(steps)}</textarea></label><label>Safety restrictions<input name="safety" maxlength="1000" value="${q(restrictions)}" placeholder="None identified"></label><label>What changed?<input name="note" maxlength="500"></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><button class="button small primary">Publish version ${q(p.version + 1)}</button><p role="alert" hidden></p></form>${p.status === 'active' ? `<button class="button small" data-retire="${q(p.id)}">Retire</button>` : ''}</details>` : ''}</article>`;
}
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
    app.innerHTML = `<section class="wrap section"><div class="console-head"><span class="eyebrow">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'} · ${data.provider === 'it' ? 'IT INCIDENTS' : 'DEVICE REPAIR'}</span><h1>${q(data.chatbot.name)}</h1></div><p id="operator-result" role="status"></p><div class="console-shell"><nav class="console-side" aria-label="Console sections"><span class="side-title">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'}</span><button type="button" data-nav="overview">Overview</button><button type="button" data-nav="cases">Cases${openCases ? ` <span class="badge">${openCases}</span>` : ''}</button><button type="button" data-nav="knowledge">Knowledge${needsYou ? ` <span class="badge">${needsYou}</span>` : ''}</button>${data.role === 'owner' ? '<span class="side-title">COMPANY</span><a href="/team">Team and data sources</a>' : ''}<span class="side-title">YOU</span>${staffAccountControls}<button type="button" id="refresh-queue">Refresh</button></nav><div class="console-main"><div data-section="overview">${healthPanel(health)}${dashboard(intel)}${queue(data.followThrough)}</div><div data-section="cases" hidden><section class="panel content-panel" aria-labelledby="open-req"><h2 id="open-req">Open customer requests</h2><p class="muted">Every request in this service, including ones not yet escalated to a specialist.</p>${(data.requests || []).length ? `<div class="table-scroll"><table><thead><tr><th>Request</th><th>Customer</th><th>Status</th><th>Opened</th><th>Troubleshooting so far</th></tr></thead><tbody>${data.requests.map((x) => `<tr><td><b>${q(x.title)}</b><br><small>${q(x.ticketId)}</small></td><td>${q(x.customer)}</td><td>${q(x.status)}</td><td>${q(formatDate(x.createdAt, true))}</td><td>${x.attempts.length ? x.attempts.map((a) => q(a.source + (a.source === 'learned' ? ' #' + a.sequence : '') + ': ' + a.outcome)).join('<br>') : 'Nothing suggested yet'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No open requests outside the specialist queue.</p>'}</section><h2>Cases for specialists</h2>${
      data.cases
        .map((h) => {
          const current = data.resolutions.find((r) => r.id === h.resolutionId);
          const editable =
            (!h.assignedTo || h.assignedTo === data.self || data.role === 'owner') && h.status !== 'Resolved';
          return `<article class="panel content-panel"><span class="pill">${q(h.status)}</span><h3>${q(h.context?.ticket?.title || h.ticketId)}</h3><p>${q(h.summary)}</p>${h.followUpRequired ? `<p class="notice">Follow-up required: ${q(h.followUpReason || 'the customer has not confirmed')}</p>` : ''}<p>Assigned: ${q(data.staff.find((s) => s.id === h.assignedTo)?.name || 'Unassigned')}</p><details><summary>Conversation and service history</summary><p><b>Status:</b> ${q(h.context?.ticket?.status || h.status)} · <b>ETA:</b> ${q(h.context?.ticket?.eta || 'Not posted')} · <b>Team:</b> ${q(h.context?.ticket?.assignedTo || 'Not assigned')}</p>${(h.context?.memories || []).map((m) => `<p class="memory-entry">${q(m.text)}</p>`).join('')}${h.conversation.map((c) => `<div class="memory-entry"><b>${c.system ? 'Specialist' : 'Customer'}</b><p>${q(c.message)}</p><p>${q(c.response.reply)}</p></div>`).join('')}<h4>Request notes</h4>${(h.context?.ticket?.requirements || []).map((r) => `<p class="memory-entry">${q(r.note)}</p>`).join('') || '<p>No notes recorded.</p>'}<h4>Customer fix attempts</h4>${(h.attempts || []).map(a=>`<p>${q(a.source)} · ${q(a.outcome)} · ${q(JSON.parse(a.snapshot).steps || JSON.parse(a.snapshot).solution || JSON.parse(a.snapshot).reason)}</p>`).join('')}<h4>Timeline</h4><ol class="timeline-list">${(h.timeline || []).map((e) => `<li><time datetime="${q(e.at)}">${q(formatDate(e.at, true))}</time>${q(e.kind.replaceAll('_', ' '))}${e.detail?.label ? ' · ' + q(e.detail.label) : ''}</li>`).join('') || '<li>No events recorded yet.</li>'}</ol><h4>Troubleshooting</h4>${(h.troubleshooting || []).map((s) => `<p><span class="pill">${q(s.outcome)}</span> ${q(s.step)}</p>`).join('') || '<p>No steps recorded yet.</p>'}</details>${
            editable && h.status !== 'Awaiting confirmation'
              ? `${formStart(h, 'assign')}<label>Assign case<select name="assignedTo">${data.staff
                  .filter((s) => data.role === 'owner' || s.id === data.self)
                  .map(
                    (s) =>
                      `<option value="${q(s.id)}" ${s.id === h.assignedTo ? 'selected' : ''}>${q(s.name)}</option>`,
                  )
                  .join(
                    '',
                  )}</select></label><button class="button small ${h.assignedTo ? '' : 'primary'}">${h.assignedTo ? 'Update assignment' : data.role === 'owner' ? 'Assign case' : 'Take this case'}</button>${error}</form>`
              : ''
          }${editable && h.assignedTo && h.status !== 'Awaiting confirmation' ? `<details><summary>Update progress</summary>${formStart(h, 'progress')}<label>Status<select name="status"><option>In progress</option><option>Waiting for parts</option><option>Awaiting customer</option></select></label><label>Expected completion<input name="eta" type="date" value="${q(h.context?.ticket?.eta || '')}"></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Customer-visible update<textarea name="note" required maxlength="2000"></textarea></label><label>Troubleshooting step (optional)<textarea name="step" maxlength="1000"></textarea></label><label>Step outcome<select name="stepOutcome"><option value="attempted">Attempted</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option></select></label><button class="button">Save progress</button>${error}</form></details>${!current || current.status === 'rejected' ? `<details><summary>Propose a verified solution</summary>${formStart(h, 'resolve')}<label>Reusable title<input name="title" required maxlength="100"></label><label>Matching symptoms<textarea name="symptoms" required maxlength="1000"></textarea></label><label>Applicable product and versions<input name="environment" required maxlength="500"></label><label>Verified solution steps<textarea name="solution" required maxlength="2000"></textarea></label><label>Safety restrictions (or “None identified”)<input name="safety" maxlength="1000" placeholder="None identified"></label><label class="privacy-check"><input type="checkbox" name="safetyReviewed"> I reviewed safety: any restriction above is complete (needed for “None identified” to count).</label><label>Risk level<select name="riskLevel"><option value="standard">Standard</option><option value="high">High risk: never auto-published</option></select></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><div class="actions"><button type="button" class="button small" data-preview>Preview scrubbed passport</button><button class="button primary">Send solution for customer confirmation</button></div><div data-preview-result role="status"></div>${error}</form></details>` : ''}` : ''}</article>`;
        })
        .join('') || '<p>No specialist cases yet.</p>'
    }</div><div data-section="knowledge" hidden><h2 id="passports">Fixes this service can recommend</h2><p class="muted">Each fix shows where it came from and whether a customer has confirmed it.</p><div class="auth-tabs filter-tabs" role="group" aria-label="Filter fixes">${[['use', 'In use', data.passports.filter((p) => p.status === 'active').length], ['needs', 'Needs you', needsYou], ['older', 'Older versions', data.passports.filter((p) => !['active', 'flagged_for_review'].includes(p.status)).length]].map(([k, label, n]) => `<button type="button" data-fix-filter="${k}">${label} <span class="count">${n}</span></button>`).join('')}</div>${data.passports.filter((p) => p.origin !== 'standard_playbook' || p.status !== 'superseded').map((p) => passportCard(p, data.chatbot.id)).join('') || '<p>No passports yet.</p>'}</div></div></div></section>`;
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
    const filterFixes = (kind) => {
      app.querySelectorAll('[data-fix-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fixFilter === kind)));
      app.querySelectorAll('[data-passport]').forEach((card) => { card.hidden = card.dataset.state !== kind; });
    };
    app.querySelectorAll('[data-fix-filter]').forEach((b) => b.addEventListener('click', () => filterFixes(b.dataset.fixFilter)));
    filterFixes(needsYou ? 'needs' : 'use');
    app.querySelectorAll('form[data-review]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach((b) => { b.disabled = true; });
        try {
          await request('operator/review-resolution?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body: {
              ...Object.fromEntries(new FormData(form, event.submitter)),
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
          document.querySelector('#operator-result').textContent = 'Revised version published. The previous version is kept as history.';
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
          document.querySelector('#operator-result').textContent = 'Case update saved.';
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
          document.querySelector('#operator-result').textContent = e.message;
          button.disabled = false;
        }
      }),
    );
  } catch (e) {
    app.innerHTML = `<section class="wrap section"><h1>Specialist access</h1><p>${q(e.message)}</p><a class="button" href="/desk">Sign in</a></section>`;
  }
}
