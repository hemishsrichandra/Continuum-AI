// Command palette for the signed-in app: Ctrl+K (⌘K on a Mac) opens a searchable list of places and actions.
// Commands are read from the page when it opens (its tabs and section buttons), so it never goes stale as the app changes.
import { escapeHtml as q } from './client.js';

const APP_PATHS = new Set(['/desk', '/team', '/operator']);
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const shortcut = mac ? '⌘K' : 'Ctrl K';
const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();

function commands() {
  const list = [];
  const seen = new Set();
  const add = (group, label, run, hint = '') => {
    const key = group + label;
    if (!label || seen.has(key)) return;
    seen.add(key);
    list.push({ group, label, run, hint });
  };
  // Tabs and section buttons on the current page.
  document.querySelectorAll('#app [role=tab], #app [data-section], #app [data-nav]').forEach((el) => {
    if (el.closest('[hidden]') || el.disabled) return;
    add('On this page', textOf(el), () => el.click());
  });
  const path = location.pathname.replace(/\/+$/, '') || '/';
  // Other parts of the app this person can reach (the page already links to them when they are allowed).
  const reachable = new Set([...document.querySelectorAll('#app a[href]')].map((a) => a.getAttribute('href').split('#')[0]));
  [['/operator', 'Specialist console'], ['/team', 'Company workspace'], ['/desk', 'Customer workspace']].forEach(([href, label]) => {
    if (href !== path && (reachable.has(href) || href === '/desk')) add('Go to', label, () => { location.href = href; });
  });
  [['/team#team', 'Invite a teammate'], ['/team#knowledge', 'Import articles and past tickets'], ['/team#services', 'Review AI services']].forEach(([href, label]) => {
    if (path === '/team') add('Actions', label, () => document.querySelector('#tab-' + href.split('#')[1])?.click());
    else if (reachable.has('/team')) add('Actions', label, () => { location.href = href; });
  });
  const theme = document.querySelector('.theme-toggle');
  if (theme) add('Preferences', document.documentElement.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme', () => theme.click());
  add('Help', 'Open the interactive demo', () => { location.href = '/demo'; });
  return list;
}

// Every typed character must appear in order; earlier and tighter matches rank higher.
function score(label, query) {
  if (!query) return 1;
  const l = label.toLowerCase(), qy = query.toLowerCase();
  const at = l.indexOf(qy);
  if (at >= 0) return 100 - at;
  let i = 0, gaps = 0, last = -1;
  for (const ch of qy) { const found = l.indexOf(ch, i); if (found < 0) return 0; gaps += last < 0 ? 0 : found - last - 1; last = found; i = found + 1; }
  return Math.max(1, 50 - gaps);
}

let dialog = null;
function open() {
  if (dialog?.open) return;
  const all = commands();
  dialog = document.createElement('dialog');
  dialog.className = 'palette';
  dialog.setAttribute('aria-label', 'Command palette');
  dialog.innerHTML = `<div class="palette-search"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Search commands" placeholder="Go to a section or run an action…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div><ul id="palette-list" role="listbox" aria-label="Commands"></ul><p class="palette-empty" hidden>No matching commands.</p>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input'), listEl = dialog.querySelector('ul'), empty = dialog.querySelector('.palette-empty');
  let shown = [], active = 0;
  const render = () => {
    shown = all.map((c) => ({ c, s: score(c.label + ' ' + c.group, input.value.trim()) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
    if (!input.value.trim()) shown = all;
    active = Math.min(active, Math.max(0, shown.length - 1));
    let group = '';
    listEl.innerHTML = shown.map((c, i) => {
      const head = c.group !== group && !input.value.trim() ? `<li class="palette-group" role="presentation">${q(c.group)}</li>` : '';
      group = c.group;
      return `${head}<li role="option" id="palette-opt-${i}" data-i="${i}" aria-selected="${i === active}">${q(c.label)}${input.value.trim() ? `<small>${q(c.group)}</small>` : ''}</li>`;
    }).join('');
    empty.hidden = shown.length > 0;
    input.setAttribute('aria-activedescendant', shown.length ? 'palette-opt-' + active : '');
    listEl.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const c = shown[i]; if (!c) return; dialog.close(); c.run(); };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  listEl.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (li) run(Number(li.dataset.i)); });
  listEl.addEventListener('mousemove', (e) => { const li = e.target.closest('[role=option]'); if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); render(); } });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); dialog = null; });
  render();
  dialog.showModal();
  input.focus();
}

/** Ctrl+K / ⌘K anywhere in the signed-in app, plus a visible "Search" button in the page header. */
export function mountPalette() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (!APP_PATHS.has(path) || window.__paletteMounted) return;
  window.__paletteMounted = true;
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
  });
  // The app re-renders its header; put the button back whenever it disappears.
  const place = () => {
    // Company workspace: its header actions. Specialist console: its heading block. Customer workspace: the account area.
    const host = document.querySelector('#app .hub-head .actions') || document.querySelector('#app .console-head') || document.querySelector('#app .account');
    if (!host || document.querySelector('#app .palette-trigger')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'button small palette-trigger';
    b.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Search<kbd>${shortcut}</kbd>`;
    b.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');
    b.addEventListener('click', open);
    if (host.matches('.console-head')) host.append(b); else host.prepend(b);
  };
  new MutationObserver(place).observe(document.querySelector('#app'), { childList: true, subtree: true });
  place();
}
