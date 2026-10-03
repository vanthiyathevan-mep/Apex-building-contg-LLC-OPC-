// Page views: dashboard, generic list/record pages, reports, settings, account and print documents.
import {
  h, fill, svg, api, get, qs, state, fmtField, fmtMoney, fmtCompact, fmtNum, fmtDate, fmtDateTime, badge, progressBar,
  isNumericType, toast, confirmDialog, refOptions, invalidateOptions, downloadCsv, currency,
} from './util.js';
import { openForm } from './form.js';

export const go = (hash) => { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); };
const PAGE_SIZE = 50;

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
    h('div', { class: 'actions no-print' }, actions));
}
const card = (...c) => h('div', { class: 'card' }, c);
const cardHead = (title, ...right) => h('div', { class: 'card-head' }, h('h2', {}, title), right.length ? h('div', { class: 'actions' }, right) : null);
const kpi = (label, value, foot, tone = '') => h('div', { class: `card kpi ${tone}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), foot ? h('div', { class: 'foot' }, foot) : null);
const recordHref = (resKey, id) => `#/r/${resKey}/${id}`;

function columnsFor(res, hide = []) {
  const cols = res.fields.filter((f) => f.list && !hide.includes(f.name)).map((f) => ({ ...f, sortKey: f.name }));
  for (const [name, c] of Object.entries(res.computed)) if (c.list) cols.push({ name, label: c.label, type: c.type, sortKey: name });
  // Prefer the computed payment status over the raw document status when both exist.
  return cols;
}

function dataTable(res, rows, { hide = [], sort, onSort } = {}) {
  const cols = columnsFor(res, hide);
  if (!rows.length) return h('div', { class: 'empty' }, `No ${res.label.toLowerCase()} found.`);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => {
      const active = sort && sort.sort === c.sortKey;
      return h('th', {
        class: `${onSort ? 'sortable' : ''} ${isNumericType(c.type) && c.name !== 'progress' ? 'num' : ''}`,
        'aria-sort': active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : null,
        onclick: onSort ? () => onSort(c.sortKey) : null,
      }, c.label, active ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '');
    }))),
    h('tbody', {}, rows.map((row) => h('tr', { class: 'clickable', tabindex: '0',
      onclick: () => go(recordHref(res.key, row.id)),
      onkeydown: (e) => { if (e.key === 'Enter') go(recordHref(res.key, row.id)); },
    }, cols.map((c) => h('td', { class: `${isNumericType(c.type) && c.name !== 'progress' ? 'num' : ''} ${c.type === 'textarea' ? 'wrap' : ''}` },
      c.type === 'textarea' && row[c.name] && row[c.name].length > 140 ? `${row[c.name].slice(0, 140)}…` : fmtField(c, row))))))));
}

// ---------------------------------------------------------------- list view
export async function renderList(view, resKey, params) {
  const res = state.meta.resources[resKey];
  if (!res) return notFound(view);
  const q = { q: params.q || '', sort: params.sort || '', dir: params.dir || '', offset: Number(params.offset) || 0 };
  const filterFields = res.fields.filter((f) => f.filter);
  for (const f of filterFields) q[f.name] = params[f.name] || '';
  if (res.computed.payment_state) q.payment_state = params.payment_state || '';
  if (res.dateField) { q.from = params.from || ''; q.to = params.to || ''; }

  const update = (patch) => {
    const next = { ...q, ...patch };
    if (!('offset' in patch)) next.offset = 0;
    go(`#/r/${resKey}${qs(next)}`);
  };

  const search = h('input', { type: 'search', placeholder: `Search ${res.label.toLowerCase()}…`, value: q.q, 'aria-label': 'Search' });
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => update({ q: search.value }), 350); });

  const filters = [];
  for (const f of filterFields) {
    let opts = f.options ? f.options.map((o) => ({ id: o, label: o })) : await refOptions(f.ref).catch(() => []);
    filters.push(h('select', { 'aria-label': f.label, onchange: (e) => update({ [f.name]: e.target.value }) },
      h('option', { value: '' }, `All ${f.label.toLowerCase()}`),
      opts.map((o) => h('option', { value: o.id, selected: String(q[f.name]) === String(o.id) }, o.label))));
  }
  if (res.computed.payment_state) {
    filters.push(h('select', { 'aria-label': 'Payment status', onchange: (e) => update({ payment_state: e.target.value }) },
      h('option', { value: '' }, 'All statuses'),
      ['Draft', 'Unpaid', 'Partially Paid', 'Overdue', 'Paid', 'Cancelled'].map((o) => h('option', { value: o, selected: q.payment_state === o }, o))));
  }
  if (res.dateField) {
    filters.push(h('input', { type: 'date', value: q.from, 'aria-label': 'From date', title: 'From', onchange: (e) => update({ from: e.target.value }) }),
      h('input', { type: 'date', value: q.to, 'aria-label': 'To date', title: 'To', onchange: (e) => update({ to: e.target.value }) }));
  }

  const apiQuery = { ...q, limit: PAGE_SIZE };
  const data = await get(`/${resKey}${qs(apiQuery)}`);
  const canCreate = res.canWrite && res.ops.includes('create');

  const pager = data.total > PAGE_SIZE ? h('div', { class: 'pager' },
    h('span', {}, `${q.offset + 1}–${Math.min(q.offset + PAGE_SIZE, data.total)} of ${data.total}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-sm', disabled: q.offset === 0, onclick: () => update({ offset: Math.max(0, q.offset - PAGE_SIZE) }) }, '‹ Prev'),
      h('button', { class: 'btn btn-sm', disabled: q.offset + PAGE_SIZE >= data.total, onclick: () => update({ offset: q.offset + PAGE_SIZE }) }, 'Next ›')))
    : h('div', { class: 'pager' }, h('span', {}, `${data.total} record${data.total === 1 ? '' : 's'}`));

  fill(view, 
    pageHead(`${res.icon} ${res.label}`, null,
      h('button', { class: 'btn', onclick: () => downloadCsv(`/${resKey}${qs({ ...q, offset: '', format: 'csv' })}`) }, 'Export CSV'),
      canCreate ? h('button', { class: 'btn btn-primary', onclick: async () => {
        const saved = await openForm(res);
        if (saved) go(recordHref(resKey, saved.id));
      } }, `+ New ${res.singular}`) : null),
    card(
      h('div', { class: 'toolbar' }, search, filters,
        Object.values(q).some((v, i) => v && Object.keys(q)[i] !== 'offset' && Object.keys(q)[i] !== 'sort' && Object.keys(q)[i] !== 'dir')
          ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go(`#/r/${resKey}`) }, 'Clear') : null),
      dataTable(res, data.rows, {
        sort: { sort: q.sort, dir: q.dir },
        onSort: (key) => update({ sort: key, dir: q.sort === key && q.dir !== 'desc' ? 'desc' : 'asc' }),
      }),
      pager));
  if (params.q !== undefined) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}

// ---------------------------------------------------------------- record view
function relatedFor(resKey) {
  const out = [];
  for (const r of Object.values(state.meta.resources)) {
    for (const f of r.fields) if (f.type === 'ref' && f.ref === resKey) out.push({ res: r, field: f });
  }
  return out;
}

function matchesWhen(when, row) {
  return !when || Object.entries(when).every(([k, v]) => row[k] === v);
}

export async function renderRecord(view, resKey, id) {
  const res = state.meta.resources[resKey];
  if (!res) return notFound(view);
  const row = await get(`/${resKey}/${id}`);
  const reload = () => renderRecord(view, resKey, id);
  const canEdit = res.canWrite && res.ops.includes('update');
  const canDelete = res.canWrite && res.ops.includes('delete');

  const actionBtns = (res.canWrite ? res.actions : []).filter((a) => matchesWhen(a.when, row)).map((a) =>
    h('button', { class: 'btn btn-primary', onclick: async () => {
      if (a.confirm && !(await confirmDialog(a.confirm, { okLabel: a.label }))) return;
      try { await api('POST', `/${resKey}/${id}/actions/${a.name}`, {}); toast('Done'); reload(); } catch (e) { toast(e.message, true); }
    } }, a.label));

  const title = row._label || res.singular;
  const projectRef = res.fields.find((f) => f.name === 'project_id');
  const subtitle = projectRef && row.project_id_label ? row.project_id_label : res.singular;

  const head = pageHead(`${res.icon} ${title}`, h('span', {}, h('a', { href: `#/r/${resKey}` }, res.label), subtitle ? ` · ${subtitle}` : ''),
    actionBtns,
    res.printable ? h('button', { class: 'btn', onclick: () => go(`#/print/${resKey}/${id}`) }, '🖨 Print') : null,
    canEdit ? h('button', { class: 'btn', onclick: async () => { if (await openForm(res, row)) reload(); } }, 'Edit') : null,
    canDelete ? h('button', { class: 'btn btn-danger', onclick: async () => {
      if (!(await confirmDialog(`Delete this ${res.singular.toLowerCase()}? This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
      try { await api('DELETE', `/${resKey}/${id}`); invalidateOptions(resKey); toast(`${res.singular} deleted`); go(`#/r/${resKey}`); } catch (e) { toast(e.message, true); }
    } }, 'Delete') : null);

  const details = h('dl', { class: 'dl' },
    res.fields.filter((f) => f.type !== 'password' && f.type !== 'textarea').map((f) => h('div', {},
      h('dt', {}, f.label),
      h('dd', {}, f.type === 'ref' && row[f.name] ? h('a', { href: refHref(f.ref, row[f.name]) }, row[`${f.name}_label`]) : fmtField(f, row)))),
    Object.entries(res.computed).map(([name, c]) => h('div', {}, h('dt', {}, c.label), h('dd', {}, fmtField({ name, type: c.type }, row)))),
    res.fields.filter((f) => f.type === 'textarea').map((f) => h('div', { style: { gridColumn: '1 / -1' } },
      h('dt', {}, f.label), h('dd', {}, row[f.name] || '—'))));

  const sections = [];
  if (res.detailView === 'project') sections.push(await projectSummary(row));
  sections.push(card(cardHead('Details'), h('div', { class: 'card-pad' }, details)));
  if (res.children) sections.push(childrenCard(res, row));

  const related = relatedFor(resKey);
  if (related.length) sections.push(await relatedTabs(related, row));

  fill(view, head, h('div', { class: 'stack' }, sections));
}

function refHref(refKey, id) {
  return state.meta.resources[refKey] ? recordHref(refKey, id) : '#';
}

function childrenCard(res, row) {
  const c = res.children;
  const items = row[c.key] || [];
  return card(cardHead(c.label),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), c.fields.map((f) => h('th', { class: isNumericType(f.type) ? 'num' : '' }, f.label)))),
      h('tbody', {}, items.map((it, i) => h('tr', {}, h('td', {}, i + 1),
        c.fields.map((f) => h('td', { class: isNumericType(f.type) ? 'num' : '' }, fmtField(f, it)))))))),
    h('div', { class: 'card-pad' }, totalsBlock(row)));
}

function totalsBlock(row) {
  return h('div', { class: 'totals' },
    h('div', {}, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(row.subtotal))),
    h('div', {}, h('span', {}, `VAT (${fmtNum(row.vat_rate)}%)`), h('span', { class: 'num' }, fmtMoney(row.vat_amount))),
    row.retention_amount ? h('div', {}, h('span', {}, `Less retention (${fmtNum(row.retention_pct)}%)`), h('span', { class: 'num' }, `− ${fmtMoney(row.retention_amount)}`)) : null,
    h('div', { class: 'grand' }, h('span', {}, row.retention_amount !== undefined ? 'Net payable' : 'Total'), h('span', { class: 'num' }, fmtMoney(row.total, true))),
    row.paid !== undefined ? h('div', {}, h('span', {}, 'Received'), h('span', { class: 'num' }, fmtMoney(row.paid))) : null,
    row.balance !== undefined ? h('div', {}, h('span', {}, 'Balance due'), h('span', { class: 'num' }, fmtMoney(row.balance, true))) : null);
}

async function relatedTabs(related, row) {
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel' });
  let activeKey = null;
  const show = async (rel, btn) => {
    activeKey = rel.res.key + rel.field.name;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b === btn));
    fill(panel, h('div', { class: 'empty' }, 'Loading…'));
    const key = activeKey;
    try {
      const data = await get(`/${rel.res.key}${qs({ [rel.field.name]: row.id, limit: 100 })}`);
      if (key !== activeKey) return;
      const canAdd = rel.res.canWrite && rel.res.ops.includes('create');
      fill(panel, 
        h('div', { class: 'toolbar' },
          h('span', { class: 'muted' }, `${data.total} record${data.total === 1 ? '' : 's'}${data.total > 100 ? ' (showing 100)' : ''}`),
          h('span', { style: { flex: 1 } }),
          data.total ? h('a', { class: 'btn btn-sm', href: `#/r/${rel.res.key}${qs({ [rel.field.name]: row.id })}` }, 'Open full list') : null,
          canAdd ? h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
            if (await openForm(rel.res, null, { [rel.field.name]: row.id })) show(rel, btn);
          } }, `+ Add ${rel.res.singular}`) : null),
        dataTable(rel.res, data.rows, { hide: [rel.field.name] }));
    } catch (e) {
      fill(panel, h('div', { class: 'empty' }, e.message));
    }
  };
  related.forEach((rel, i) => {
    const sameRes = related.filter((r) => r.res.key === rel.res.key).length > 1;
    const btn = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'false' },
      `${rel.res.icon} ${rel.res.label}${sameRes ? ` (${rel.field.label})` : ''}`);
    btn.addEventListener('click', () => show(rel, btn));
    tabs.append(btn);
    if (i === 0) setTimeout(() => show(rel, btn), 0);
  });
  return card(cardHead('Related records'), tabs, panel);
}

async function projectSummary(row) {
  const s = await get(`/projects/${row.id}/summary`);
  const over = s.budget > 0 && s.total_cost > s.budget;
  const tiles = [
    kpi('Contract value', fmtCompact(s.contract_value), `Progress ${s.progress}%`),
    kpi('Cost budget', fmtCompact(s.budget), s.budget_used_pct !== null ? `${s.budget_used_pct}% used` : 'No budget set', over ? 'bad' : ''),
    kpi('Actual cost to date', fmtCompact(s.total_cost), `Committed (open POs) ${fmtCompact(s.committed_cost)}`),
  ];
  if (s.invoiced !== undefined) {
    tiles.push(
      kpi('Invoiced (excl. VAT)', fmtCompact(s.invoiced), `Received ${fmtCompact(s.received)}`),
      kpi('Outstanding', fmtCompact(s.outstanding), null, s.outstanding > 0 ? '' : ''),
      kpi('Gross margin', fmtCompact(s.gross_margin), 'Invoiced − actual cost', s.gross_margin < 0 ? 'bad' : ''));
  }
  const breakdown = [
    ['Labor', s.labor_cost, `${fmtNum(s.labor.hours)} h + ${fmtNum(s.labor.overtime)} h OT · ${s.labor.workers} workers`],
    ['Materials issued', s.material_cost, 'From store (net of returns)'],
    ['Direct purchases', s.purchase_cost, 'Received PO lines not stocked'],
    ['Expenses', s.expense_cost, s.expense_by_category.map((e) => e.category).slice(0, 3).join(', ') || '—'],
  ];
  const max = Math.max(...breakdown.map((b) => b[1]), 1);
  return h('div', { class: 'stack' },
    h('div', { class: 'kpis', style: { marginBottom: 0 } }, tiles),
    h('div', { class: 'grid grid-2' },
      card(cardHead('Cost breakdown'), h('div', { class: 'table-wrap' }, h('table', {},
        h('tbody', {}, breakdown.map(([label, v, note]) => h('tr', {},
          h('td', {}, h('div', {}, label), h('div', { class: 'muted', style: { fontSize: '12px' } }, note)),
          h('td', { style: { width: '40%' } }, h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('span', { style: { width: `${(v / max) * 100}%` } })))),
          h('td', { class: 'num' }, fmtMoney(v))))),
        h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', {}), h('td', { class: 'num' }, fmtMoney(s.total_cost, true))))))),
      card(cardHead('Schedule & tasks'), h('div', { class: 'card-pad stack' },
        h('div', {}, h('div', { class: 'muted' }, 'Overall progress'), progressBar(s.progress)),
        h('div', {}, h('div', { class: 'muted' }, 'Budget consumed'), progressBar(s.budget_used_pct ?? 0, over)),
        h('dl', { class: 'dl' },
          h('div', {}, h('dt', {}, 'Start'), h('dd', {}, fmtDate(s.start_date))),
          h('div', {}, h('dt', {}, 'Completion'), h('dd', {}, fmtDate(s.end_date))),
          ...['Not Started', 'In Progress', 'Blocked', 'Done'].map((st) => h('div', {}, h('dt', {}, `Tasks ${st.toLowerCase()}`),
            h('dd', {}, String(s.tasks.find((x) => x.status === st)?.n || 0)))))))));
}

// ---------------------------------------------------------------- dashboard
export async function renderDashboard(view) {
  const d = await get('/dashboard');
  const f = d.finance;
  const tiles = [
    kpi('Active projects', String(d.projects.active || 0), `${d.projects.pipeline || 0} in pipeline · ${d.projects.completed || 0} completed`),
    kpi('Work backlog', fmtCompact(d.projects.backlog_value), 'Contract value of open projects'),
    kpi('Workforce', String(d.workforce.active), `${d.labor_today.workers} on timesheets today`),
    kpi('Equipment in use', `${d.equipment.in_use || 0} / ${d.equipment.total}`, `${d.equipment.maintenance || 0} under maintenance`),
  ];
  if (f) {
    tiles.push(
      kpi('Invoiced this year', fmtCompact(f.invoiced_ytd), `Collected ${fmtCompact(f.collected_ytd)}`),
      kpi('Receivables', fmtCompact(f.receivables), `Retention held ${fmtCompact(f.retention_held)}`),
      kpi('Overdue invoices', String(f.overdue.n), fmtCompact(f.overdue.v), f.overdue.n ? 'bad' : ''),
      kpi('Open purchase orders', String(d.pending_pos.n), fmtCompact(d.pending_pos.value)));
  }

  const projTable = d.active_projects.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Client'), h('th', {}, 'Progress'), h('th', {}, 'Budget used'), h('th', { class: 'num' }, 'Actual cost'), h('th', {}, 'Due'))),
    h('tbody', {}, d.active_projects.map((p) => h('tr', { class: 'clickable', onclick: () => go(recordHref('projects', p.id)) },
      h('td', {}, h('div', { style: { fontWeight: 600 } }, p.code), h('div', { class: 'muted' }, p.name)),
      h('td', {}, p.client_name || '—'),
      h('td', {}, progressBar(p.progress)),
      h('td', {}, p.budget_used_pct === null ? '—' : progressBar(p.budget_used_pct, p.budget_used_pct > 100)),
      h('td', { class: 'num' }, fmtMoney(p.total_cost)),
      h('td', {}, fmtDate(p.end_date)))))))
    : h('div', { class: 'empty' }, 'No active projects.');

  const alerts = h('ul', { class: 'list-plain' },
    d.alerts.length ? d.alerts.map((a) => h('li', {},
      h('span', {}, h('a', { href: recordHref(a.resource, a.id) }, a.subject), h('div', { class: 'muted', style: { fontSize: '12px' } }, a.kind)),
      badge(a.date < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Due soon'), h('span', { class: 'num' }, fmtDate(a.date))))
      : h('li', { class: 'muted' }, 'Nothing expiring in the next 30 days.'));

  const tasks = h('ul', { class: 'list-plain' },
    d.open_tasks.length ? d.open_tasks.map((t) => h('li', {},
      h('span', {}, h('a', { href: recordHref('tasks', t.id) }, t.title), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${t.project_code} · ${t.priority}`)),
      h('span', { class: 'num' }, fmtDate(t.due_date))))
      : h('li', { class: 'muted' }, 'No tasks due in the next 7 days.'));

  const stock = h('ul', { class: 'list-plain' },
    d.low_stock.length ? d.low_stock.map((m) => h('li', {},
      h('a', { href: recordHref('materials', m.id) }, `${m.code} — ${m.name}`),
      h('span', { class: 'num' }, `${fmtNum(m.stock_qty)} / ${fmtNum(m.reorder_level)} ${m.unit}`)))
      : h('li', { class: 'muted' }, 'All materials above reorder level.'));

  const activity = h('ul', { class: 'list-plain' },
    d.recent_activity.length ? d.recent_activity.map((a) => h('li', {},
      h('span', {}, h('b', {}, a.username), ` ${a.action} `, state.meta.resources[a.resource]?.singular?.toLowerCase() || a.resource,
        a.summary ? ` · ${a.summary}` : ''),
      h('span', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDateTime(a.created_at))))
      : h('li', { class: 'muted' }, 'No activity yet.'));

  fill(view, 
    pageHead('Dashboard', `${state.settings.company_name || ''} · ${fmtDate(new Date().toISOString())}`),
    h('div', { class: 'kpis' }, tiles),
    h('div', { class: 'stack' },
      f ? card(cardHead('Cash flow — last 6 months'), cashflowChart(f.monthly)) : null,
      card(cardHead('Active projects', h('a', { href: '#/r/projects?status=Active', class: 'btn btn-sm' }, 'View all')), projTable),
      h('div', { class: 'grid grid-3' },
        card(cardHead('⚠️ Expiring & due'), alerts),
        card(cardHead('📅 Tasks due this week'), tasks),
        card(cardHead('🧱 Low stock'), stock)),
      card(cardHead('Recent activity'), activity)));
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Grouped bar chart: invoiced / collected / costs per month. */
function cashflowChart(months) {
  const series = [
    { key: 'invoiced', label: 'Invoiced', cls: 's1', color: 'var(--series-1)' },
    { key: 'collected', label: 'Collected', cls: 's2', color: 'var(--series-2)' },
    { key: 'costs', label: 'Costs', cls: 's3', color: 'var(--series-3)' },
  ];
  const W = 760, H = 240, padL = 56, padR = 8, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...months.flatMap((m) => series.map((s) => m[s.key])), 0));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const groupW = plotW / months.length;
  const barW = Math.min(22, (groupW * 0.62 - 4) / 3);
  const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'chart' });

  const bar = (x, v, cls) => {
    const top = y(v), bottom = y(0), hgt = bottom - top;
    if (hgt <= 0) return null;
    const r = Math.min(4, hgt, barW / 2);
    return svg('path', { class: cls, d: `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z` });
  };

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Monthly invoiced, collected and costs' },
    [0, 0.25, 0.5, 0.75, 1].map((t) => [
      svg('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y(max * t), y2: y(max * t) }),
      svg('text', { class: 'axis-label', x: padL - 8, y: y(max * t) + 4, 'text-anchor': 'end' }, new Intl.NumberFormat('en-US', { notation: 'compact' }).format(max * t)),
    ]),
    months.map((m, i) => {
      const gx = padL + i * groupW;
      const start = gx + (groupW - (barW * 3 + 4)) / 2;
      const hit = svg('rect', { class: 'hit', x: gx, y: padT, width: groupW, height: plotH });
      const showTip = () => {
        hit.classList.add('on');
        fill(tip, h('b', {}, monthLabel(m.month)),
          series.map((s) => h('div', {}, h('span', {}, h('i', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: s.color, marginRight: '6px' } }), s.label),
            h('span', { class: 'num' }, fmtMoney(m[s.key])))));
        tip.hidden = false;
        const rect = wrap.getBoundingClientRect();
        const left = ((gx + groupW / 2) / W) * rect.width;
        tip.style.left = `${Math.min(Math.max(left - 90, 0), rect.width - 190)}px`;
        tip.style.top = '0px';
      };
      hit.addEventListener('mouseenter', showTip);
      hit.addEventListener('mouseleave', () => { hit.classList.remove('on'); tip.hidden = true; });
      return [
        hit,
        series.map((s, k) => bar(start + k * (barW + 2), m[s.key], s.cls)),
        svg('text', { class: 'axis-label', x: gx + groupW / 2, y: H - 6, 'text-anchor': 'middle' }, monthLabel(m.month)),
      ];
    }));
  for (const el of chart.querySelectorAll('path')) el.style.pointerEvents = 'none';
  wrap.append(chart, tip);

  const table = h('details', { class: 'data-table' }, h('summary', {}, 'Show data table'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Month'), series.map((s) => h('th', { class: 'num' }, `${s.label} (${currency()})`)))),
      h('tbody', {}, months.map((m) => h('tr', {}, h('td', {}, monthLabel(m.month)), series.map((s) => h('td', { class: 'num' }, fmtMoney(m[s.key])))))))));

  return h('div', {},
    h('div', { class: 'legend', style: { paddingTop: '12px' } }, series.map((s) => h('span', {}, h('i', { style: { background: s.color } }), s.label))),
    wrap, table);
}

// ---------------------------------------------------------------- reports
export function renderReports(view) {
  const descriptions = {
    'project-costing': 'Contract, budget, actual cost by type, invoicing and margin for every project.',
    'receivables-aging': 'Outstanding client invoices grouped by days past due.',
    'labor-summary': 'Hours, overtime and labor cost by employee and project.',
    'expenses-by-category': 'Project and overhead expenses grouped by category.',
    'inventory-valuation': 'Stock on hand, average cost and reorder status.',
    'material-consumption': 'Net materials issued to each project.',
    'vat-summary': 'Output VAT on sales vs input VAT on purchases, by month.',
    'expiring-documents': 'Visas, equipment services and registrations due within 30 days.',
  };
  fill(view, pageHead('📊 Reports', 'Pick a report to run, filter, print or export.'),
    h('div', { class: 'grid grid-3' }, state.reports.map((r) => h('a', { class: 'card card-pad', href: `#/reports/${r.key}`, style: { color: 'inherit', textDecoration: 'none' } },
      h('h2', {}, r.title), h('p', { class: 'muted', style: { margin: '6px 0 0' } }, descriptions[r.key] || '')))));
}

const MONEY_KEY = /(cost|amount|value|vat|total|paid|balance|invoiced|received|margin|variance|outstanding|sales|budget|payable)$/;
const DATE_KEY = /(^date$|_date$|_at$)/;
const STATUS_KEY = /(status|bucket)$/;
const humanize = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bVat\b/, 'VAT').replace(/\bPct\b/, '%');

export async function renderReport(view, key, params) {
  const from = params.from || '';
  const to = params.to || '';
  const data = await get(`/reports/${key}${qs({ from, to })}`);
  const rows = data.rows;
  const keys = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'id' && k !== 'resource' && k !== 'invoiced_gross') : [];
  const isMoney = (k) => MONEY_KEY.test(k) && !k.endsWith('_pct');
  const isNum = (k) => isMoney(k) || rows.every((r) => r[k] === null || typeof r[k] === 'number');
  const cell = (k, v) => {
    if (isMoney(k)) return fmtMoney(v);
    if (DATE_KEY.test(k)) return fmtDate(v);
    if (STATUS_KEY.test(k)) return badge(v);
    if (k === 'progress' || k === 'budget_used_pct') return v === null ? '—' : `${fmtNum(v)}%`;
    if (typeof v === 'number') return fmtNum(v);
    return v ?? '—';
  };
  const totals = keys.map((k) => (isMoney(k) || ['hours', 'overtime_hours', 'days', 'entries'].includes(k) ? rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) : null));
  const rowLink = (r) => (key === 'project-costing' ? recordHref('projects', r.id) : key === 'receivables-aging' ? recordHref('invoices', r.id) : r.resource ? recordHref(r.resource, r.id) : null);

  const setRange = (patch) => go(`#/reports/${key}${qs({ from, to, ...patch })}`);
  const usesRange = ['labor-summary', 'expenses-by-category', 'material-consumption', 'vat-summary'].includes(key);

  fill(view, 
    pageHead(data.title, `${state.settings.company_name || ''}${usesRange && (from || to) ? ` · ${from ? fmtDate(from) : 'start'} – ${to ? fmtDate(to) : 'today'}` : ''} · generated ${fmtDate(new Date().toISOString())}`,
      h('a', { class: 'btn', href: '#/reports' }, '← All reports'),
      h('button', { class: 'btn', onclick: () => downloadCsv(`/reports/${key}${qs({ from, to, format: 'csv' })}`) }, 'Export CSV'),
      h('button', { class: 'btn', onclick: () => { document.body.classList.add('print-report'); window.print(); document.body.classList.remove('print-report'); } }, '🖨 Print')),
    card(
      usesRange ? h('div', { class: 'toolbar no-print' },
        h('label', { style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } }, 'From', h('input', { type: 'date', value: from, onchange: (e) => setRange({ from: e.target.value }) })),
        h('label', { style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } }, 'To', h('input', { type: 'date', value: to, onchange: (e) => setRange({ to: e.target.value }) })),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => go(`#/reports/${key}`) }, 'All dates')) : null,
      rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, keys.map((k) => h('th', { class: isNum(k) ? 'num' : '' }, humanize(k))))),
        h('tbody', {}, rows.map((r) => {
          const link = rowLink(r);
          return h('tr', { class: link ? 'clickable' : '', onclick: link ? () => go(link) : null },
            keys.map((k) => h('td', { class: isNum(k) ? 'num' : '' }, cell(k, r[k]))));
        })),
        totals.some((t) => t !== null) ? h('tfoot', {}, h('tr', {}, keys.map((k, i) => h('td', { class: isNum(k) ? 'num' : '' },
          i === 0 ? 'Total' : totals[i] === null ? '' : isMoney(k) ? fmtMoney(totals[i]) : fmtNum(totals[i]))))) : null))
        : h('div', { class: 'empty' }, 'No data for this report yet.')));
}

// ---------------------------------------------------------------- settings & account
export function renderSettings(view, onSaved) {
  const isAdmin = state.user.role === 'admin';
  const fields = [
    ['company_name', 'Company name'], ['company_trn', 'TRN (Tax Registration No.)'], ['company_phone', 'Phone'], ['company_email', 'Email'],
    ['currency', 'Currency code'], ['default_vat_rate', 'Default VAT %'], ['default_retention_pct', 'Default retention %'],
    ['company_address', 'Address', true], ['invoice_terms', 'Invoice terms & bank details', true],
  ];
  const inputs = {};
  const grid = h('div', { class: 'form-grid' }, fields.map(([k, label, area]) => {
    const input = area ? h('textarea', { name: k, value: state.settings[k] || '', readonly: !isAdmin })
      : h('input', { name: k, value: state.settings[k] || '', readonly: !isAdmin, type: k.endsWith('_rate') || k.endsWith('_pct') ? 'number' : 'text', step: 'any' });
    inputs[k] = input;
    return h('label', { class: area ? 'full' : '' }, label, input);
  }));
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'card card-pad stack' }, grid, isAdmin ? h('div', { class: 'actions' }, error, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings')) : h('p', { class: 'muted' }, 'Only administrators can change company settings.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('PUT', '/settings', Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
      toast('Settings saved');
      onSaved();
    } catch (err) { error.textContent = err.message; }
  });
  fill(view, pageHead('⚙️ Company Settings', 'Used on printed invoices, purchase orders and reports.'), form);
}

export function renderAccount(view) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'card card-pad stack', style: { maxWidth: '460px' } },
    h('h2', {}, 'Change password'),
    h('label', {}, 'Current password', cur), h('label', {}, 'New password', next), h('label', {}, 'Confirm new password', again),
    error, h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update password')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (next.value !== again.value) { error.textContent = 'New passwords do not match'; return; }
    try {
      await api('POST', '/me/password', { current_password: cur.value, new_password: next.value });
      form.reset();
      toast('Password updated');
    } catch (err) { error.textContent = err.message; }
  });

  let theme = 'system';
  try { theme = localStorage.getItem('erp-theme') || 'system'; } catch { /* storage unavailable */ }
  const themeSel = h('select', { onchange: (e) => setTheme(e.target.value) },
    [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: theme === v }, l)));

  fill(view, pageHead('👤 My Account'),
    h('div', { class: 'stack' },
      h('div', { class: 'card card-pad', style: { maxWidth: '460px' } }, h('dl', { class: 'dl' },
        h('div', {}, h('dt', {}, 'Name'), h('dd', {}, state.user.full_name)),
        h('div', {}, h('dt', {}, 'Username'), h('dd', {}, state.user.username)),
        h('div', {}, h('dt', {}, 'Role'), h('dd', {}, state.user.role.replace('_', ' '))))),
      h('div', { class: 'card card-pad', style: { maxWidth: '460px' } }, h('label', {}, 'Theme', themeSel)),
      form));
}

export function setTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('erp-theme', theme); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- print documents
export async function renderPrint(root, resKey, id) {
  const res = state.meta.resources[resKey];
  const doc = await get(`/${resKey}/${id}`);
  const s = state.settings;
  const isInvoice = resKey === 'invoices';
  let party = null;
  let project = null;
  try {
    if (doc.project_id) project = await get(`/projects/${doc.project_id}`);
    if (isInvoice && project?.client_id) party = await get(`/clients/${project.client_id}`);
    if (!isInvoice && doc.supplier_id) party = await get(`/suppliers/${doc.supplier_id}`);
  } catch { /* partial data is fine */ }

  const items = doc[res.children.key] || [];
  const priceKey = isInvoice ? 'rate' : 'unit_price';
  const lines = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [h('br'), p] : [p]));

  fill(root, 
    h('div', { class: 'print-bar' },
      h('button', { class: 'btn', onclick: () => history.back() }, '← Back'),
      h('button', { class: 'btn btn-primary', onclick: () => window.print() }, '🖨 Print / Save as PDF')),
    h('article', { class: 'doc' },
      h('div', { class: 'doc-head' },
        h('div', {}, h('div', { style: { fontSize: '20px', fontWeight: 800 } }, s.company_name),
          h('div', { style: { color: '#555', marginTop: '4px', whiteSpace: 'pre-line' } }, lines(s.company_address, s.company_phone && `Tel: ${s.company_phone}`, s.company_email)),
          s.company_trn ? h('div', { style: { marginTop: '4px' } }, h('b', {}, 'TRN: '), s.company_trn) : null),
        h('div', {}, h('div', { class: 'doc-title' }, isInvoice ? 'TAX INVOICE' : 'PURCHASE ORDER'),
          h('div', { style: { textAlign: 'right', marginTop: '8px' } },
            h('div', {}, h('b', {}, isInvoice ? 'Invoice No: ' : 'PO No: '), isInvoice ? doc.invoice_no : doc.po_no),
            h('div', {}, h('b', {}, 'Date: '), fmtDate(isInvoice ? doc.issue_date : doc.order_date)),
            isInvoice && doc.due_date ? h('div', {}, h('b', {}, 'Due: '), fmtDate(doc.due_date)) : null,
            !isInvoice && doc.delivery_date ? h('div', {}, h('b', {}, 'Delivery by: '), fmtDate(doc.delivery_date)) : null))),
      h('div', { class: 'doc-meta' },
        h('div', {}, h('h3', {}, isInvoice ? 'Bill to' : 'Supplier'),
          party ? h('div', {}, h('b', {}, party.name), h('div', { style: { whiteSpace: 'pre-line' } }, lines(party.address, party.contact_person && `Attn: ${party.contact_person}`, party.phone, party.email)),
            party.trn ? h('div', {}, h('b', {}, 'TRN: '), party.trn) : null) : h('div', {}, '—')),
        h('div', {}, h('h3', {}, 'Project'),
          project ? h('div', {}, h('b', {}, `${project.code} — ${project.name}`), h('div', {}, lines(project.location, project.plot_no && `Plot ${project.plot_no}`))) : h('div', {}, 'General / Store'))),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', {}, 'Unit'),
          h('th', { class: 'num' }, isInvoice ? 'Rate' : 'Unit price'), h('th', { class: 'num' }, `Amount (${currency()})`))),
        h('tbody', {}, items.map((it, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, it.description), h('td', { class: 'num' }, fmtNum(it.quantity)),
          h('td', {}, it.unit || ''), h('td', { class: 'num' }, fmtMoney(it[priceKey])), h('td', { class: 'num' }, fmtMoney(it.amount))))))),
      h('div', { style: { display: 'flex', marginTop: '16px' } }, totalsBlock(isInvoice ? doc : { ...doc, paid: undefined, balance: undefined })),
      doc.notes ? h('div', { style: { marginTop: '20px' } }, h('h3', {}, 'Notes'), h('p', { style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, doc.notes)) : null,
      isInvoice && s.invoice_terms ? h('div', { style: { marginTop: '16px', color: '#444', whiteSpace: 'pre-wrap', fontSize: '12.5px' } }, s.invoice_terms) : null,
      h('div', { class: 'doc-sign' }, h('div', {}, isInvoice ? 'Authorised signatory' : 'Prepared by'), h('div', {}, isInvoice ? 'Received by (client)' : 'Approved by'))));
}

export function notFound(view) {
  fill(view, pageHead('Not found'), h('p', {}, 'That page does not exist or you do not have access. ', h('a', { href: '#/dashboard' }, 'Back to dashboard')));
}
