// Owner UI: restrict a specialist to particular services. No restriction means every service of their adapter.
import { request, escapeHtml as q } from './client.js';

export async function mountStaffAccess(host) {
  const data = await request('company/staff-access');
  const section = document.createElement('section');
  section.className = 'hub-card';
  section.id = 'staff-access';
  section.innerHTML = `<div class="hub-section-head"><div><h2>Specialist service access</h2><p>By default a specialist can work every service of their type. Limit someone to particular services if they should not see other services’ cases or knowledge. Cases they hold in a service they lose go back to that service’s queue.</p></div></div><div class="access-grid">${
    data.staff.length ? data.staff.map((s) => {
      const bots = data.chatbots.filter((b) => b.adapter === s.provider);
      return `<form class="card" data-staff="${q(s.id)}"><h3>${q(s.name)} <small>${q(s.email)}</small></h3>
        <label class="privacy-check"><input type="radio" name="mode" value="all" ${s.chatbotIds ? '' : 'checked'}> Every ${q(s.provider)} service</label>
        <label class="privacy-check"><input type="radio" name="mode" value="some" ${s.chatbotIds ? 'checked' : ''}> Only these services</label>
        <fieldset ${s.chatbotIds ? '' : 'disabled'}><legend class="sr-only">Services</legend>${bots.map((b) => `<label class="privacy-check"><input type="checkbox" name="bot" value="${q(b.id)}" ${(s.chatbotIds || []).includes(b.id) ? 'checked' : ''}> ${q(b.name)}${b.active ? '' : ' (inactive)'}</label>`).join('')}</fieldset>
        <button class="button small primary">Save access</button><p role="status" data-result></p></form>`;
    }).join('') : '<p class="empty">No specialists yet. Invite one from the Team tab.</p>'}</div>`;
  host.append(section);
  for (const form of section.querySelectorAll('form[data-staff]')) {
    const fieldset = form.querySelector('fieldset');
    form.addEventListener('change', () => { fieldset.disabled = form.elements.mode.value !== 'some'; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = form.querySelector('[data-result]');
      const some = form.elements.mode.value === 'some';
      const ids = [...form.querySelectorAll('input[name=bot]:checked')].map((x) => x.value);
      if (some && !ids.length) { result.textContent = 'Choose at least one service, or allow every service.'; return; }
      try {
        const r = await request('company/staff-access', { body: { accountId: form.dataset.staff, chatbotIds: some ? ids : null, confirmed: true } });
        result.textContent = 'Saved.' + (r.releasedCases ? ` ${r.releasedCases} case(s) were returned to the queue.` : '');
      } catch (e) { result.textContent = e.message; }
    });
  }
}
