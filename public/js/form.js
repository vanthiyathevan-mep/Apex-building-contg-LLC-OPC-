// Generic create/edit form driven by resource metadata, including line-item editors.
import { h, fill, api, state, openModal, refOptions, invalidateOptions, toast, today, fmtMoney } from './util.js';

function defaultValue(f) {
  if (f.default === 'today') return today();
  if (typeof f.default === 'string' && f.default.startsWith('setting:')) return state.settings[f.default.slice(8)] ?? '';
  return f.default ?? '';
}

async function buildInput(f, value, { compact = false } = {}) {
  const common = { name: f.name, required: !!f.required, 'aria-label': compact ? f.label : null };
  const val = value === null || value === undefined ? '' : value;
  switch (f.type) {
    case 'textarea': return h('textarea', { ...common, value: val });
    case 'select': return h('select', common, h('option', { value: '' }, f.required ? '— Select —' : '—'),
      f.options.map((o) => h('option', { value: o, selected: String(val) === o }, o)));
    case 'ref': {
      const opts = await refOptions(f.ref).catch(() => []);
      return h('select', common, h('option', { value: '' }, f.required ? '— Select —' : '— None —'),
        opts.map((o) => h('option', { value: o.id, selected: String(val) === String(o.id) }, o.label)));
    }
    case 'bool': return h('select', common, h('option', { value: '1', selected: Number(val) === 1 || val === '' }, 'Yes'),
      h('option', { value: '0', selected: val !== '' && Number(val) === 0 }, 'No'));
    case 'date': return h('input', { ...common, type: 'date', value: val });
    case 'email': return h('input', { ...common, type: 'email', value: val });
    case 'password': return h('input', { ...common, type: 'password', autocomplete: 'new-password', value: '' });
    case 'money': case 'number': case 'percent': case 'int':
      return h('input', { ...common, type: 'number', step: f.type === 'int' ? '1' : 'any', min: f.min, max: f.max, value: val, inputmode: 'decimal' });
    default: return h('input', { ...common, type: 'text', value: val, placeholder: f.placeholder || '' });
  }
}

function fieldLabel(f, input) {
  const wide = f.type === 'textarea' || f.hint && f.hint.length > 60;
  return h('label', { class: wide ? 'full' : '' },
    h('span', {}, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
    input,
    f.hint ? h('span', { class: 'hint' }, f.hint) : null);
}

function readValue(el) { return el.value; }

/** Line-item editor (purchase order items, invoice items). */
async function itemsEditor(children, items, onChange) {
  const editable = children.fields.filter((f) => !f.readonly);
  const qtyKey = children.fields.find((f) => f.name === 'quantity') ? 'quantity' : null;
  const priceKey = children.fields.find((f) => f.name === 'unit_price') ? 'unit_price' : 'rate';
  const tbody = h('tbody');
  const rows = [];

  const recalc = () => {
    let subtotal = 0;
    for (const r of rows) {
      const q = Number(r.inputs[qtyKey]?.value) || 0;
      const p = Number(r.inputs[priceKey]?.value) || 0;
      const amt = Math.round(q * p * 100) / 100;
      r.amountCell.textContent = fmtMoney(amt);
      subtotal += amt;
    }
    onChange(subtotal);
  };

  const addRow = async (item = {}) => {
    const inputs = {};
    const cells = [];
    for (const f of editable) {
      const input = await buildInput(f, item[f.name] ?? (item.id ? '' : defaultValue(f)), { compact: true });
      inputs[f.name] = input;
      input.addEventListener('input', recalc);
      input.addEventListener('change', recalc);
      if (f.name === 'material_id') {
        input.addEventListener('change', async () => {
          // Prefill description/unit/price from the chosen material.
          if (!input.value) return;
          try {
            const m = await api('GET', `/materials/${input.value}`);
            if (inputs.description && !inputs.description.value) inputs.description.value = m.name;
            if (inputs.unit && !inputs.unit.value) inputs.unit.value = m.unit;
            if (inputs.unit_price && !Number(inputs.unit_price.value)) inputs.unit_price.value = m.unit_cost;
            recalc();
          } catch { /* ignore */ }
        });
      }
      cells.push(h('td', { style: f.name === 'description' ? { minWidth: '200px' } : (f.type === 'ref' ? { minWidth: '180px' } : { minWidth: '80px' }) }, input));
    }
    const amountCell = h('td', { class: 'num' }, '0.00');
    const row = { inputs, amountCell };
    const tr = h('tr', {}, cells, amountCell,
      h('td', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Remove line', onclick: () => {
        tr.remove(); rows.splice(rows.indexOf(row), 1); recalc();
      } }, '✕')));
    rows.push(row);
    tbody.append(tr);
    recalc();
  };

  for (const it of items) await addRow(it);
  if (!items.length) await addRow();

  const el = h('div', { class: 'full' },
    h('h3', { style: { marginBottom: '8px' } }, children.label),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'items-table' },
        h('thead', {}, h('tr', {}, editable.map((f) => h('th', {}, f.label)), h('th', { class: 'num' }, 'Amount'), h('th', {}))),
        tbody)),
    h('button', { type: 'button', class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => addRow() }, '+ Add line'));

  return {
    el,
    values: () => rows.map((r) => Object.fromEntries(Object.entries(r.inputs).map(([k, i]) => [k, readValue(i)]))),
  };
}

/**
 * Opens the create/edit form. Resolves with the saved record, or null if cancelled.
 * @param {object} res  resource metadata
 * @param {object|null} record existing record (edit) or null (create)
 * @param {object} prefill  initial values for a new record
 */
export function openForm(res, record = null, prefill = {}) {
  return new Promise(async (resolve) => {
    const isEdit = !!record;
    const inputs = {};
    const grid = h('div', { class: 'form-grid' });
    for (const f of res.fields) {
      if (f.readonly) continue;
      const value = isEdit ? record[f.name] : (prefill[f.name] ?? defaultValue(f));
      const input = await buildInput(f, value);
      if (isEdit && f.type === 'password') input.required = false;
      inputs[f.name] = input;
      grid.append(fieldLabel(f, input));
    }

    let items = null;
    let totalsEl = null;
    if (res.children) {
      totalsEl = h('div', { class: 'totals full' });
      const renderTotals = (subtotal) => {
        const vat = subtotal * (Number(inputs.vat_rate?.value) || 0) / 100;
        const ret = inputs.retention_pct ? subtotal * (Number(inputs.retention_pct.value) || 0) / 100 : 0;
        fill(totalsEl, 
          h('div', {}, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(subtotal))),
          h('div', {}, h('span', {}, `VAT (${inputs.vat_rate?.value || 0}%)`), h('span', { class: 'num' }, fmtMoney(vat))),
          inputs.retention_pct ? h('div', {}, h('span', {}, `Retention (${inputs.retention_pct.value || 0}%)`), h('span', { class: 'num' }, `− ${fmtMoney(ret)}`)) : null,
          h('div', { class: 'grand' }, h('span', {}, 'Total'), h('span', { class: 'num' }, fmtMoney(subtotal + vat - ret, true))));
      };
      let lastSubtotal = 0;
      items = await itemsEditor(res.children, isEdit ? record[res.children.key] || [] : [], (s) => { lastSubtotal = s; renderTotals(s); });
      for (const k of ['vat_rate', 'retention_pct']) inputs[k]?.addEventListener('input', () => renderTotals(lastSubtotal));
      grid.append(items.el, totalsEl);
      renderTotals(lastSubtotal);
    }

    const error = h('p', { class: 'form-error', role: 'alert' });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, isEdit ? 'Save changes' : `Create ${res.singular}`);
    const form = h('form', { novalidate: true }, grid);
    let saved = null;

    const submit = async (e) => {
      e.preventDefault();
      error.textContent = '';
      const body = {};
      for (const [k, el] of Object.entries(inputs)) {
        if (el.type === 'password' && !el.value) continue;
        body[k] = readValue(el);
      }
      if (items) body[res.children.key] = items.values();
      saveBtn.disabled = true;
      try {
        saved = isEdit ? await api('PUT', `/${res.key}/${record.id}`, body) : await api('POST', `/${res.key}`, body);
        invalidateOptions(res.key);
        toast(`${res.singular} ${isEdit ? 'updated' : 'created'}`);
        m.close();
      } catch (err) {
        error.textContent = err.message;
        saveBtn.disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    saveBtn.addEventListener('click', submit);

    const m = openModal({
      title: isEdit ? `Edit ${res.singular}` : `New ${res.singular}`,
      body: form,
      wide: !!res.children,
      footer: [error, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), saveBtn],
      onClose: () => resolve(saved),
    });
  });
}
