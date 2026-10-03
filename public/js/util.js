// Shared helpers: DOM building, API client, formatting, toasts and modals.

export const state = { user: null, meta: null, settings: {}, reports: [] };

/** Build a DOM element. Children may be strings, nodes, arrays, null/false. Strings are always text (no HTML injection). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
/** Replace an element's children; accepts nested arrays and skips null/false. */
export function fill(el, ...children) { el.replaceChildren(); append(el, children); return el; }
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login' && path !== '/me') {
    window.dispatchEvent(new Event('erp:unauthorized'));
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}
export const get = (p) => api('GET', p);

export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
}

// ---------- formatting ----------
const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const currency = () => state.settings.currency || 'AED';
export const fmtMoney = (v, withCur = false) => (v === null || v === undefined || v === '' ? '—' : (withCur ? `${currency()} ` : '') + moneyFmt.format(Number(v)));
export const fmtCompact = (v) => `${currency()} ${compactFmt.format(Number(v) || 0)}`;
export const fmtNum = (v) => (v === null || v === undefined || v === '' ? '—' : numFmt.format(Number(v)));
export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(String(v).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export const today = () => new Date().toISOString().slice(0, 10);

const STATUS_TONE = {
  good: ['Active', 'Approved', 'Issued', 'Paid', 'Done', 'Available', 'Received', 'Completed', 'OK', 'Current'],
  info: ['In Progress', 'In Use', 'Tendering', 'Sent'],
  warn: ['On Hold', 'Partially Paid', 'Under Maintenance', 'On Leave', 'Unpaid', 'High', 'Reorder', '1–30 days', '31–60 days'],
  bad: ['Overdue', 'Cancelled', 'Blocked', 'Out of Service', 'Critical', 'Terminated', '61–90 days', '90+ days'],
};
export function badge(value) {
  if (value === null || value === undefined || value === '') return '—';
  const tone = Object.keys(STATUS_TONE).find((t) => STATUS_TONE[t].includes(value)) || '';
  return h('span', { class: `badge ${tone}` }, value);
}
export function progressBar(pct, over = false) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return h('div', { class: 'progress', title: `${fmtNum(pct)}%` },
    h('div', { class: `bar${over ? ' over' : ''}` }, h('span', { style: { width: `${v}%` } })),
    h('small', {}, `${fmtNum(pct ?? 0)}%`));
}

/** Render a field value for display. */
export function fmtField(f, row) {
  const v = row[f.name];
  switch (f.type) {
    case 'money': return fmtMoney(v);
    case 'number': case 'int': return fmtNum(v);
    case 'percent': return f.name === 'progress' ? progressBar(v) : (v === null || v === undefined ? '—' : `${fmtNum(v)}%`);
    case 'date': return fmtDate(v);
    case 'bool': return v ? 'Yes' : 'No';
    case 'ref': return row[`${f.name}_label`] ?? '—';
    case 'select': case 'status': return f.name === 'status' || f.name.endsWith('_status') || f.type === 'status' || f.name === 'priority' ? badge(v) : (v ?? '—');
    case 'password': return '••••••••';
    default: return v === null || v === undefined || v === '' ? '—' : String(v);
  }
}
export const isNumericType = (t) => ['money', 'number', 'int', 'percent'].includes(t);

// ---------- toast ----------
let toastTimer;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 5000 : 2600);
}

// ---------- modal ----------
export function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? { maxWidth: '1040px' } : null },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'btn btn-ghost', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, modal);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => modal.querySelector('input:not([readonly]), select, textarea, button')?.focus(), 0);
  return { close, modal };
}

export function confirmDialog(message, { danger = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = openModal({
      title: 'Please confirm',
      body: h('p', { style: { margin: 0 } }, message),
      footer: [h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, okLabel)],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

// ---------- reference options cache ----------
const optionCache = new Map();
export async function refOptions(resource) {
  if (!optionCache.has(resource)) optionCache.set(resource, get(`/${resource}/options`).catch((e) => { optionCache.delete(resource); throw e; }));
  return optionCache.get(resource);
}
export const invalidateOptions = (resource) => optionCache.delete(resource);

export function downloadCsv(path) {
  const a = h('a', { href: `/api${path}`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}
