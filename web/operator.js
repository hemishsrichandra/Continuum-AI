import {staffAccountControls, bindStaffAccount} from './staff-account.js';
import { request, escapeHtml as q } from './client.js';
export async function mountOperator() {
  const app = document.querySelector('#app');
  try {
    const data = await request('operator' + location.search);
    const formStart = (h, kind) =>
      `<form data-case="${q(h.id)}" data-revision="${h.revision || 0}" data-kind="${kind}" data-key="${crypto.randomUUID()}">`;
    const error = '<p class="notice error" role="alert" hidden></p>';
    app.innerHTML = `<section class="wrap section"><span class="eyebrow">${data.role === 'owner' ? 'OWNER' : 'SPECIALIST'} · ${data.provider === 'it' ? 'IT INCIDENTS' : 'STANDARD REQUESTS'}</span><h1>${data.role === 'owner' ? 'Customer cases.' : 'Resolve with context.'}</h1><p class="lead">Claim a case, track troubleshooting, and ask the customer to confirm the solution before it becomes reusable knowledge.</p><div class="actions">${staffAccountControls}${data.role === 'owner' ? '<a class="button" href="/team">Company & team</a><a class="button" href="/operator?provider=repair">Standard cases</a><a class="button" href="/operator?provider=it">IT cases</a>' : ''}<button class="button" id="refresh-queue">Refresh queue</button></div><p id="operator-result" role="status"></p><h2>${q(data.chatbot.name)} · Service queue</h2>${
      data.cases
        .map((h) => {
          const current = data.resolutions.find((r) => r.id === h.resolutionId);
          const editable =
            (!h.assignedTo || h.assignedTo === data.self || data.role === 'owner') && h.status !== 'Resolved';
          return `<article class="panel content-panel"><span class="pill">${q(h.status)}</span><h3>${q(h.context?.ticket?.title || h.ticketId)}</h3><p>${q(h.summary)}</p><p>Assigned: ${q(data.staff.find((s) => s.id === h.assignedTo)?.name || 'Unassigned')}</p><details><summary>Conversation and service history</summary><p><b>Status:</b> ${q(h.context?.ticket?.status || h.status)} · <b>ETA:</b> ${q(h.context?.ticket?.eta || 'Not posted')} · <b>Team:</b> ${q(h.context?.ticket?.assignedTo || 'Not assigned')}</p>${(h.context?.memories || []).map((m) => `<p class="memory-entry">${q(m.text)}</p>`).join('')}${h.conversation.map((c) => `<div class="memory-entry"><b>${c.system ? 'Specialist' : 'Customer'}</b><p>${q(c.message)}</p><p>${q(c.response.reply)}</p></div>`).join('')}<h4>Request notes</h4>${(h.context?.ticket?.requirements || []).map((r) => `<p class="memory-entry">${q(r.note)}</p>`).join('') || '<p>No notes recorded.</p>'}<h4>Customer fix attempts</h4>${(h.attempts || []).map(a=>`<p>${q(a.source)} · ${q(a.outcome)} · ${q(JSON.parse(a.snapshot).steps || JSON.parse(a.snapshot).solution || JSON.parse(a.snapshot).reason)}</p>`).join('')}<h4>Troubleshooting</h4>${(h.troubleshooting || []).map((s) => `<p><span class="pill">${q(s.outcome)}</span> ${q(s.step)}</p>`).join('') || '<p>No steps recorded yet.</p>'}</details>${
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
          }${editable && h.assignedTo && h.status !== 'Awaiting confirmation' ? `<details><summary>Update progress</summary>${formStart(h, 'progress')}<label>Status<select name="status"><option>In progress</option><option>Waiting for parts</option><option>Awaiting customer</option></select></label><label>Expected completion<input name="eta" type="date" value="${q(h.context?.ticket?.eta || '')}"></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Customer-visible update<textarea name="note" required maxlength="2000"></textarea></label><label>Troubleshooting step (optional)<textarea name="step" maxlength="1000"></textarea></label><label>Step outcome<select name="stepOutcome"><option value="attempted">Attempted</option><option value="failed">Failed</option><option value="succeeded">Succeeded</option></select></label><button class="button">Save progress</button>${error}</form></details>${!current || current.status === 'rejected' ? `<details><summary>Propose a verified solution</summary>${formStart(h, 'resolve')}<label>Reusable title<input name="title" required maxlength="100"></label><label>Matching symptoms<textarea name="symptoms" required maxlength="1000"></textarea></label><label>Applicable product and versions<input name="environment" required maxlength="500"></label><label>Verified solution steps<textarea name="solution" required maxlength="2000"></textarea></label><label class="privacy-check"><input type="checkbox" name="reviewedForPrivacy" required> I tested these steps and removed personal information and secrets.</label><button class="button primary">Send solution for customer confirmation</button>${error}</form></details>` : ''}` : ''}</article>`;
        })
        .join('') || '<p>No specialist cases yet.</p>'
    }<h2>Resolution library</h2>${data.resolutions.map((r) => `<article class="card"><span class="pill">${q(r.retiredAt ? 'Retired' : r.status || 'published')} · ${q(r.sync)}</span><h3>${q(r.title)}</h3><p>${q(r.symptoms)}</p><p><b>Applies to:</b> ${q(r.environment)}</p><p>${q(r.solution)}</p><p>Follow-up results: ${r.reuse?.succeeded || 0} worked · ${r.reuse?.failed || 0} need help · ${r.reuse?.pending || 0} awaiting feedback</p>${r.reviewRequired && !r.retiredAt ? `<p class="notice">Reuse paused after a failure report. Review the case before approving this fix again.</p><form data-review="${q(r.id)}" data-review-revision="${r.reviewRevision}"><label>Review decision<select name="decision"><option value="keep">Keep after reviewing applicability and failed attempt</option><option value="retire">Retire this fix</option></select></label><label>Why is this decision appropriate?<textarea name="note" required maxlength="1000"></textarea></label><button class="button small">Save review</button><p role="alert" hidden></p></form>` : ''}${!r.retiredAt && !r.reviewRequired && (r.status === 'published' || !r.status) ? `<button class="button small" data-retire="${q(r.id)}">Retire resolution</button>` : ''}</article>`).join('') || '<p>No proposed or published resolutions.</p>'}</section>`;
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
        if (form.dataset.kind === 'resolve')
          body.reviewedForPrivacy = form.elements.reviewedForPrivacy.checked;
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
