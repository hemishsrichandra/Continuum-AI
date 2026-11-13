// Small building blocks for owner screens, so nobody has to type JSON or comma-separated lists.
import { escapeHtml as q } from './client.js';

const CLOSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
let counter = 0;
const uid = (p) => `${p}-${++counter}`;

/** A list of short words shown as removable tags. Enter or a comma adds one. */
export function chipsField({ label, values = [], placeholder = 'Type and press Enter', hint = '', max = 30 }) {
  const el = document.createElement('div');
  el.className = 'field chips-field';
  const id = uid('chips');
  el.innerHTML = `<label for="${id}">${q(label)}</label><div class="chips" data-chips></div><input id="${id}" type="text" maxlength="200" placeholder="${q(placeholder)}" autocomplete="off">${hint ? `<small class="muted">${q(hint)}</small>` : ''}`;
  const list = [...values];
  const box = el.querySelector('[data-chips]');
  const input = el.querySelector('input');
  const draw = () => { box.innerHTML = list.map((v, i) => `<span class="chip-tag">${q(v)}<button type="button" data-rm="${i}" aria-label="Remove ${q(v)}">${CLOSE}</button></span>`).join(''); };
  const add = (raw) => { for (const part of String(raw).split(',')) { const v = part.trim(); if (v && !list.includes(v) && list.length < max) list.push(v); } draw(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); input.value = ''; }
    else if (e.key === 'Backspace' && !input.value && list.length) { list.pop(); draw(); }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { list.splice(Number(b.dataset.rm), 1); draw(); input.focus(); } });
  draw();
  return { el, get: () => { if (input.value.trim()) { add(input.value); input.value = ''; } return [...list]; } };
}

/**
 * A table of rows the owner can add to and remove from. `columns` describe each cell ({key, label, type, options, placeholder, width}).
 * `get()` returns one object per non-empty row.
 */
export function rowsField({ label, columns, rows = [], addLabel = 'Add a row', empty = 'Nothing added yet.', max = 20, hint = '' }) {
  const el = document.createElement('div');
  el.className = 'field rows-field';
  const head = uid('rows');
  el.innerHTML = `<span class="rows-label" id="${head}">${q(label)}</span>${hint ? `<small class="muted">${q(hint)}</small>` : ''}<div class="rows" role="group" aria-labelledby="${head}"></div><button type="button" class="button small">${q(addLabel)}</button>`;
  const host = el.querySelector('.rows');
  const addBtn = el.querySelector(':scope > button');
  const cell = (c, v) => {
    const id = uid('cell');
    if (c.type === 'checkbox') return `<label class="row-check"><input type="checkbox" data-k="${q(c.key)}" ${v ? 'checked' : ''}> ${q(c.label)}</label>`;
    return `<label class="row-cell" for="${id}"><span>${q(c.label)}</span><input id="${id}" data-k="${q(c.key)}" type="${c.type || 'text'}" value="${q(v ?? '')}" placeholder="${q(c.placeholder || '')}" maxlength="${c.max || 200}"></label>`;
  };
  const addRow = (values = {}) => {
    if (host.children.length >= max) return;
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = columns.map((c) => cell(c, values[c.key])).join('') + `<button type="button" class="icon-button row-remove" aria-label="Remove this row">${CLOSE}</button>`;
    row.querySelector('.row-remove').addEventListener('click', () => { row.remove(); sync(); });
    host.append(row);
    sync();
  };
  const sync = () => { addBtn.disabled = host.children.length >= max; el.dataset.empty = host.children.length ? '' : empty; };
  addBtn.addEventListener('click', () => { addRow(); host.lastElementChild?.querySelector('input')?.focus(); });
  rows.forEach(addRow);
  sync();
  return {
    el,
    get: () => [...host.children].map((row) => Object.fromEntries(columns.map((c) => {
      const input = row.querySelector(`[data-k="${c.key}"]`);
      return [c.key, c.type === 'checkbox' ? input.checked : input.value.trim()];
    }))).filter((r) => columns.some((c) => c.type !== 'checkbox' && r[c.key])),
  };
}

/** A themed confirmation instead of firing a risky action straight away. Resolves true or false. */
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Go back', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm-dialog';
    d.setAttribute('aria-labelledby', 'confirm-title');
    d.innerHTML = `<form method="dialog"><h2 id="confirm-title">${q(title)}</h2><p>${q(body)}</p><div class="actions"><button class="button" value="no" formnovalidate>${q(cancel)}</button><button class="button ${danger ? 'danger' : 'primary'}" value="yes">${q(confirm)}</button></div></form>`;
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}

/** Copy text and say so on the button for a moment. */
export async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; t.className = 'sr-only'; document.body.append(t); t.select();
    try { document.execCommand('copy'); } catch { /* the field next to the button is still selectable */ }
    t.remove();
  }
  if (!button) return;
  const was = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = was; }, 1600);
}

/** Show a number-and-caption summary as small coloured badges, instead of a sentence of counters. */
export const badges = (items) => `<ul class="stat-badges">${items.map(([n, label, tone = '']) => `<li class="stat-badge ${tone}"><b>${q(n)}</b><span>${q(label)}</span></li>`).join('')}</ul>`;

/** Ask for a short note. Resolves with the text, or null if the person backs out. */
export function noteDialog({ title, label, confirm = 'Send', cancel = 'Cancel', hint = '' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm-dialog';
    d.setAttribute('aria-labelledby', 'note-title');
    d.innerHTML = `<form method="dialog"><h2 id="note-title">${q(title)}</h2><label>${q(label)}<textarea name="note" rows="4" maxlength="1000"></textarea></label>${hint ? `<small class="muted">${q(hint)}</small>` : ''}<div class="actions"><button class="button" value="no" formnovalidate>${q(cancel)}</button><button class="button primary" value="yes">${q(confirm)}</button></div></form>`;
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes' ? d.querySelector('textarea').value.trim() : null); d.remove(); });
    document.body.append(d);
    d.showModal();
    d.querySelector('textarea').focus();
  });
}
