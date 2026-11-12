import {staffAccountControls, bindStaffAccount} from './staff-account.js';
import { request, escapeHtml as q, formatDate } from './client.js';
const pct = (n) => (n === null || n === undefined ? '—' : Math.round(n * 100) + '%');
const minutes = (ms) => (ms === null || ms === undefined ? '—' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1) + ' h');
const verification = (p) => p.verification === 'customer_confirmed' ? '<span class="pill green">✓ Confirmed by the original customer</span>'
  : p.verification === 'unconfirmed_by_customer' ? '<span class="pill warn">UNCONFIRMED BY CUSTOMER</span>'
  : p.verification === 'imported_declared_verified' ? '<span class="pill blue">Imported · owner-declared verified (not customer-confirmed)</span>'
  : p.verification === 'imported_unverified' ? '<span class="pill">Imported · unverified</span>'
  : p.verification === 'company_configured' ? '<span class="pill blue">Company-configured standard playbook</span>' : '<span class="pill">Not customer-confirmed</span>';
function dashboard(d) {
  if (!d) return '<p class="muted">Resolution Intelligence is unavailable right now.</p>';
  const t = (value, label, cls = '', note = '') => `<div class="dash-stat ${cls}"><b>${q(value)}</b>${q(label)}${note ? `<small>${q(note)}</small>` : ''}</div>`;
  return `<section class="panel content-panel" aria-labelledby="intel"><h2 id="intel">Resolution Intelligence</h2>${d.empty ? '<p class="muted">No activity yet. Figures appear after customers use this service.</p>' : ''}<div class="dash-grid">
    ${t(d.knowledge.customerConfirmedFixes, 'Customer-confirmed fixes', 'ok')}
    ${t(d.knowledge.autoPublishedUnconfirmed, 'Auto-published · unconfirmed', d.knowledge.autoPublishedUnconfirmed ? 'warn' : '', 'Never counted as verified')}
    ${t(d.knowledge.importedRecords, 'Imported records', '', 'Not counted as learned')}
    ${t(d.reuse.memorySucceeded + ' / ' + d.reuse.memoryFailed, 'Reuse worked / failed', '', d.reuse.memoryPending + ' awaiting feedback')}
    ${t(d.knowledge.flaggedForReview, 'Flagged for review', d.knowledge.flaggedForReview ? 'warn' : '')}
    ${t(d.followThrough.overdueConfirmations + ' / ' + d.followThrough.pendingConfirmations, 'Overdue / pending confirmations')}
    ${t(d.followThrough.slaBreaches, 'SLA breaches (' + d.followThrough.slaHours + ' h)', d.followThrough.slaBreaches ? 'warn' : '')}
    ${t(minutes(d.responseTimes.meanFirstSpecialistResponseMs), 'Mean first response', '', 'n=' + d.responseTimes.samples.firstResponse)}
    ${t(minutes(d.responseTimes.meanTimeToCustomerConfirmedResolutionMs), 'Mean time to confirmed resolution', '', 'n=' + d.responseTimes.samples.confirmedResolution)}
  </div><details><summary>How to read these numbers</summary><ul>${d.notes.map((n) => `<li>${q(n)}</li>`).join('')}</ul></details></section>`;
}
function queue(ft, bots) {
  const open = (ft?.tasks || []).filter((t) => t.status === 'pending' || t.status === 'escalated' || t.status === 'auto_published');
  return `<section class="panel content-panel" aria-labelledby="ft"><h2 id="ft">Follow-through queue</h2><p class="muted">Confirmation deadline ${q(ft?.confirmationHours)} h · case SLA ${q(ft?.slaHours)} h. Silence is never treated as success.</p>${open.length ? `<div class="table-scroll"><table><thead><tr><th>Type</th><th>Case</th><th>Due</th><th>State</th><th>Next step</th></tr></thead><tbody>${open.map((t) => `<tr><td>${q(t.type.replaceAll('_', ' '))}</td><td>${q(t.ticketId)}</td><td>${q(formatDate(t.deadlineAt, true))}${t.overdue ? ' <span class="pill warn">OVERDUE</span>' : ''}</td><td>${q(t.status.replaceAll('_', ' '))}</td><td>${q(t.nextStep)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Nothing is waiting on a deadline.</p>'}</section>`;
}
function passportCard(p, chatbotId) {
  const flagged = p.status === 'flagged_for_review';
  const current = ['active', 'flagged_for_review'].includes(p.status);
  const steps = (p.steps || []).join(' ');
  return `<article class="card" data-passport="${q(p.id)}"><span class="pill">${q(p.originLabel)}</span> ${verification(p)} <span class="pill ${flagged ? 'warn' : ''}">v${q(p.version)} · ${q(p.status.replaceAll('_', ' '))}</span><h3>${q(p.title)}</h3><p>${q(p.symptoms)}</p>
    <dl class="passport-meta"><dt>Applies to</dt><dd>${q(p.applicability.environmentText || (p.applicability.conditions || []).map((c) => c.key + ': ' + (c.values || []).join(' or ')).join('; ') || 'No explicit conditions')}</dd>
    <dt>Safety restrictions</dt><dd>${q((p.safety.restrictions || []).map((r) => r.text).join('; ') || (p.safety.noneIdentified ? 'None identified' : 'None recorded'))}</dd>
    <dt>Steps</dt><dd>${q(steps)}</dd>
    <dt>Evidence</dt><dd>${q(p.evidence?.label || (p.customerConfirmed ? 'Confirmed by the original customer' : p.evidence?.type || '—'))}${p.sourceTicketId ? ' · case ' + q(p.sourceTicketId) : ''}</dd>
    <dt>Confidence</dt><dd>C_init ${q(p.initialConfidence)} · reliability ${q(p.reliability)} · risk ${q(p.riskLevel)}</dd>
    <dt>Outcomes</dt><dd>${q(p.successes)} worked · ${q(p.failures)} failed · ${q(p.consecutiveFailures)} in a row</dd>
    ${p.parentVersionId ? `<dt>Lineage</dt><dd>Revision of ${q(p.parentVersionId)}</dd>` : ''}</dl>
    ${flagged ? `<p class="notice">Paused for review: ${q(p.flaggedReason || 'flagged')}. Keep it, retire it, or publish a revised version.</p><form data-review="${q(p.id)}" data-review-revision="${q(p.failures)}"><label>Review decision<select name="decision"><option value="keep">Keep after reviewing applicability and the failed attempts</option><option value="retire">Retire this fix</option></select></label><label>Why is this decision appropriate?<textarea name="note" required maxlength="1000"></textarea></label><button class="button small">Save review</button><p role="alert" hidden></p></form>` : ''}
    ${current && p.origin !== 'standard_playbook' ? `<details><summary>Publish a revised version</summary><form data-revise="${q(p.id)}" data-version="${q(p.version)}"><label>Title<input name="title" required maxlength="100" value="${q(p.title)}"></label><label>Matching symptoms<textarea name="symptoms" required maxlength="1000">${q(p.symptoms)}</textarea></label><label>Applies to<input name="environment" required maxlength="500" value="${q(p.applicability.environmentText || '')}"></label><label>Steps<textarea name="solution" required maxlength="2000">${q(steps)}</textarea></label><label>Safety restrictions<input name="safety" maxlength="1000" value="${q((p.safety.restrictions || []).map((r) => r.text).join('; '))}" placeholder="None identified"></label><label>What changed?<input name="note" maxlength="500"></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><button class="button small primary">Publish version ${q(p.version + 1)}</button><p role="alert" hidden></p></form>${p.status === 'active' ? `<button class="button small" data-retire="${q(p.id)}">Retire</button>` : ''}</details>` : ''}</article>`;
}
export async function mountOperator() {
  const app = document.querySelector('#app');
  try {
    const data = await request('operator' + location.search);
    const intel = await request('companies/' + encodeURIComponent(data.companyId) + '/intelligence?chatbotId=' + encodeURIComponent(data.chatbot.id)).catch(() => null);
    const formStart = (h, kind) =>
      `<form data-case="${q(h.id)}" data-revision="${h.revision || 0}" data-kind="${kind}" data-key="${crypto.randomUUID()}">`;
    const error = '<p class="notice error" role="alert" hidden></p>';
    app.innerHTML = `<section class="wrap section"><span class="eyebrow">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'} · ${data.provider === 'it' ? 'IT INCIDENTS' : 'STANDARD REQUESTS'}</span><h1>${data.role === 'owner' ? 'Customer cases.' : 'Resolve with context.'}</h1><p class="lead">Claim a case, track troubleshooting, and ask the customer to confirm the solution before it becomes reusable knowledge.</p><div class="actions">${staffAccountControls}${data.role === 'owner' ? '<a class="button" href="/team">Company & team</a><a class="button" href="/operator?provider=repair">Standard cases</a><a class="button" href="/operator?provider=it">IT cases</a>' : ''}<button class="button" id="refresh-queue">Refresh queue</button></div><p id="operator-result" role="status"></p>${dashboard(intel)}${queue(data.followThrough)}<section class="panel content-panel" aria-labelledby="open-req"><h2 id="open-req">Open customer requests</h2><p class="muted">Every request in this service, including ones not yet escalated to a specialist.</p>${(data.requests || []).length ? `<div class="table-scroll"><table><thead><tr><th>Request</th><th>Customer</th><th>Status</th><th>Opened</th><th>Troubleshooting so far</th></tr></thead><tbody>${data.requests.map((x) => `<tr><td><b>${q(x.title)}</b><br><small>${q(x.ticketId)}</small></td><td>${q(x.customer)}</td><td>${q(x.status)}</td><td>${q(formatDate(x.createdAt, true))}</td><td>${x.attempts.length ? x.attempts.map((a) => q(a.source + (a.source === 'learned' ? ' #' + a.sequence : '') + ': ' + a.outcome)).join('<br>') : 'Nothing suggested yet'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No open requests outside the specialist queue.</p>'}</section><h2>${q(data.chatbot.name)} · Service queue</h2>${
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
                  )}</select></label><button class="button small">${h.assignedTo ? 'Update assignment' : 'Claim / assign case'}</button>${error}</form>`
              : ''
          }${editable && h.assignedTo && h.status !== 'Awaiting confirmation' ? `<details><summary>Update progress</summary>${formStart(h, 'progress')}<label>Status<select name="status"><option>In progress</option><option>Waiting for parts</option><option>Awaiting customer</option></select></label><label>Expected completion<input name="eta" type="date" value="${q(h.context?.ticket?.eta || '')}"></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Customer-visible update<textarea name="note" required maxlength="2000"></textarea></label><label>Troubleshooting step (optional)<textarea name="step" maxlength="1000"></textarea></label><label>Step outcome<select name="stepOutcome"><option value="attempted">Attempted</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option></select></label><button class="button">Save progress</button>${error}</form></details>${!current || current.status === 'rejected' ? `<details><summary>Propose a verified solution</summary>${formStart(h, 'resolve')}<label>Reusable title<input name="title" required maxlength="100"></label><label>Matching symptoms<textarea name="symptoms" required maxlength="1000"></textarea></label><label>Applicable product and versions<input name="environment" required maxlength="500"></label><label>Verified solution steps<textarea name="solution" required maxlength="2000"></textarea></label><label>Safety restrictions (or “None identified”)<input name="safety" maxlength="1000" placeholder="None identified"></label><label class="privacy-check"><input type="checkbox" name="safetyReviewed"> I reviewed safety: any restriction above is complete (needed for “None identified” to count).</label><label>Risk level<select name="riskLevel"><option value="standard">Standard</option><option value="high">High risk: never auto-published</option></select></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><div class="actions"><button type="button" class="button small" data-preview>Preview scrubbed passport</button><button class="button primary">Send solution for customer confirmation</button></div><div data-preview-result role="status"></div>${error}</form></details>` : ''}` : ''}</article>`;
        })
        .join('') || '<p>No specialist cases yet.</p>'
    }<h2>Resolution Passports</h2><p class="muted">Everything this service can recommend, with origin, verification status, applicability, restrictions and outcomes. Revisions keep the full version history.</p>${data.passports.filter((p) => p.origin !== 'standard_playbook' || p.status !== 'superseded').map((p) => passportCard(p, data.chatbot.id)).join('') || '<p>No passports yet.</p>'}</section>`;
    bindStaffAccount(app);
    app.querySelectorAll('form[data-review]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          await request('operator/review-resolution?chatbotId=' + encodeURIComponent(data.chatbot.id), {
            body: {
              ...Object.fromEntries(new FormData(form)),
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
          button.disabled = false;
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
          target.innerHTML = `<div class="notice"><b>Customers will see this after removal of personal data (${q(r.redactions)} redactions):</b><p>${q(r.passport.steps.join(' '))}</p><small>C_init ${q(r.cInit.score)} = 0.40×${q(r.cInit.components.P_passport)} (passport) + 0.35×${q(r.cInit.components.S_diag)} (diagnostics) + 0.25×${q(r.cInit.components.R_author)} (author). If the customer is silent, auto-publication needs C_init ≥ 0.75 and no redactions or risk flags.</small></div>`;
        } catch (e) {
          target.textContent = e.message;
        }
      }),
    );
    document.querySelector('#refresh-queue').addEventListener('click', mountOperator);
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
