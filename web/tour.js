// A 30-second guided tour for each role (customer, specialist, owner).
//
// Short on purpose: four or five steps of one sentence each. It never changes data: a step may only switch the visible console section
// (a view toggle) and highlight an element. Nothing runs on a timer, Esc closes it, focus moves into the card and returns to the launcher,
// and the highlight needs no animation, so it is the same with reduced motion.
const STEPS = {
  customer: [
    { target: '#chat-form', title: 'Say what’s wrong', body: 'Describe the problem in your own words. Continuum looks for a fix your company has already confirmed worked.' },
    { target: '.source-banner, .thread', title: 'See where a fix came from', body: 'Every suggestion says who confirmed it and why it fits your problem. Your device and version are checked first.' },
    { target: '.progress-tracker, .outcome, .thread', title: 'Tell us how it went', body: 'Choose “It worked” or “Still need help”. The strip shows what was tried, what is being tried and that a specialist is next if needed.' },
    { target: '[data-prompt="I need human help"]', title: 'A person is always one click away', body: 'Ask for a specialist at any time. They get everything you already tried, so you never repeat yourself.' },
  ],
  staff: [
    { target: '[data-nav="cases"]', show: '[data-nav="cases"]', title: 'Your queue', body: 'Cases waiting for a specialist, most urgent first. Each one shows what the customer already tried.' },
    { target: '.case-list, [data-section="cases"]', title: 'Solve it once', body: 'Write the fix and what it applies to. When the customer confirms it worked, it becomes a trusted answer for the next customer.' },
    { target: '[data-nav="knowledge"]', show: '[data-nav="knowledge"]', title: 'Keep fixes honest', body: 'Fixes that start failing are paused here for review. Keep, revise or retire each one with a short note.' },
    { target: '#passports', title: 'Nothing is hidden', body: 'Every fix shows its source, version, track record and the devices it applies to.' },
  ],
  owner: [
    { target: '[data-nav="overview"]', show: '[data-nav="overview"]', title: 'How support is going', body: 'See how many problems are solved without a specialist, and how repeat problems compare before and after your first reusable fix.' },
    { target: '#intel', title: 'Fixes that need a look', body: 'Fixes that are failing more often, or that customers have moved past, are listed for review. Nothing changes without a person.' },
    { target: '[data-nav="knowledge"]', show: '[data-nav="knowledge"]', title: 'Approve what customers will see', body: 'Imported fixes wait here until your team approves them.' },
    { target: 'a[href="/team"]', title: 'Team and data sources', body: 'Invite specialists, choose which service each can work on, and connect or import your knowledge.' },
    { target: '#health', show: '[data-nav="overview"]', title: 'Is everything running?', body: 'Search, background jobs and approvals in plain language, with details when you need them.' },
  ],
};
const seenKey = (role) => 'continuum-tour-' + role;
const remembered = (role) => { try { return localStorage.getItem(seenKey(role)) === '1'; } catch { return false; } };
const remember = (role) => { try { localStorage.setItem(seenKey(role), '1'); } catch { /* optional */ } };

let role = null, launcher = null, card = null, index = 0, highlighted = null;

function clearHighlight() { highlighted?.classList.remove('tour-target'); highlighted = null; }
function close({ restoreFocus = true } = {}) {
  clearHighlight();
  card?.remove(); card = null;
  if (role) remember(role);
  launcher?.classList.remove('is-new');
  if (restoreFocus) launcher?.focus();
}
function show(i) {
  const steps = STEPS[role];
  index = Math.max(0, Math.min(steps.length - 1, i));
  const step = steps[index];
  if (step.show) document.querySelector(step.show)?.click();
  clearHighlight();
  const target = document.querySelector(step.target);
  if (target) { highlighted = target; target.classList.add('tour-target'); target.scrollIntoView({ block: 'center', behavior: 'auto' }); }
  card ||= Object.assign(document.createElement('div'), { className: 'tour-card' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'tour-title');
  const last = index === steps.length - 1;
  card.innerHTML = `<small class="tour-count">Step ${index + 1} of ${steps.length}</small><h2 id="tour-title" tabindex="-1">${step.title}</h2><p>${step.body}</p>
    <div class="tour-actions"><button type="button" class="button small ghost" data-tour="skip">Skip</button>${index ? '<button type="button" class="button small" data-tour="back">Back</button>' : ''}<button type="button" class="button small primary" data-tour="${last ? 'done' : 'next'}">${last ? 'Done' : 'Next'}</button></div>`;
  if (!card.isConnected) document.body.append(card);
  card.querySelector('[data-tour="next"], [data-tour="done"]')?.focus({ preventScroll: true });
}
function onKey(event) {
  if (!card) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); }
}
function onClick(event) {
  const button = event.target.closest?.('[data-tour]');
  if (!button || !card?.contains(button)) return;
  const action = button.dataset.tour;
  if (action === 'next') show(index + 1);
  else if (action === 'back') show(index - 1);
  else close();
}

/** Call whenever the signed-in role is known; safe to call on every render. */
export function setTourRole(next) {
  if (!STEPS[next]) return;
  if (role === next && launcher?.isConnected) return;
  role = next;
  if (!launcher) {
    launcher = Object.assign(document.createElement('button'), { type: 'button', id: 'tour-launch', className: 'button small tour-launch', textContent: 'Take a 30-second tour' });
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.addEventListener('click', () => (card ? close() : show(0)));
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
  }
  if (!launcher.isConnected) document.body.append(launcher);
  launcher.classList.toggle('is-new', !remembered(role));
}
export const tourSteps = STEPS;
