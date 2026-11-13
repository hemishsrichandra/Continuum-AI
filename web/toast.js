// Shared feedback for the signed-in app: toasts (with an optional Undo), loading skeletons and empty states.
// No inline styles (the site's security policy forbids them); everything is styled in site.css.
import { escapeHtml as q } from './client.js';

let region;
function ensureRegion() {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.className = 'toast-region';
  // Polite for confirmations; each error toast carries role="alert" itself so it is announced at once.
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-relevant', 'additions');
  document.body.append(region);
  return region;
}

const ICONS = {
  success: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  error: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>',
};

/**
 * Show a short message in the corner. tone: success | error | info. action: { label, onClick } adds a button (for
 * Undo). Errors stay until dismissed; everything else leaves after `duration` ms, paused while hovered or focused.
 */
export function toast(text, { tone = 'success', action = null, duration = tone === 'error' ? 0 : 5000 } = {}) {
  if (!text) return () => {};
  const host = ensureRegion();
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  if (tone === 'error') el.setAttribute('role', 'alert');
  el.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[tone] || ICONS.info}</svg><p>${q(text)}</p>${action ? `<button type="button" class="toast-action">${q(action.label)}</button>` : ''}<button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  let timer = null, left = duration, started = 0;
  const close = () => { clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  const run = () => { if (left > 0) { started = Date.now(); timer = setTimeout(close, left); } };
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; left -= Date.now() - started; } };
  el.addEventListener('mouseenter', pause); el.addEventListener('focusin', pause);
  el.addEventListener('mouseleave', run); el.addEventListener('focusout', run);
  el.querySelector('.toast-close').addEventListener('click', close);
  el.querySelector('.toast-action')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await action.onClick(); } finally { close(); }
  });
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  run();
  return close;
}


/** Grey placeholder lines shown while a panel loads (hidden from assistive tech; pair with a status message). */
export function skeleton(rows = 3, label = 'Loading…') {
  const el = document.createElement('div');
  el.className = 'skeleton-block';
  el.innerHTML = `<span class="sr-only" role="status">${q(label)}</span>${'<div class="skeleton-card" aria-hidden="true"><i></i><i></i><i></i></div>'.repeat(rows)}`;
  return el;
}

const EMPTY_ICONS = {
  inbox: '<path d="M4 12h4l2 3h4l2-3h4M5 5h14l1 7v7H4v-7z"/>',
  book: '<path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4z"/><path d="M5 16a4 4 0 0 1 4-4h10"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};
/** A designed empty state: icon, a title, one line of guidance and an optional action (HTML string). */
export const emptyState = ({ icon = 'inbox', title, hint = '', action = '' }) =>
  `<div class="empty-block"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${EMPTY_ICONS[icon] || EMPTY_ICONS.inbox}</svg><div><b>${q(title)}</b>${hint ? `<p>${q(hint)}</p>` : ''}${action}</div></div>`;
