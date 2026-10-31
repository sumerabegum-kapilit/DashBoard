// Conditions on fields: "Priority is Urgent or High", "Created on or after 2026-01-01", "SLA breached is Yes".
// The same editor is used for dashboard filters, widget filters and the conditions inside a measure.
import { app, $, mk, button, select, input, fieldOf, fieldOptions, valuesOf, labelOf, keyLabel } from './core.js';

export const OPS = {
  text: [['in', 'is any of'], ['notin', 'is none of'], ['contains', 'contains'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  number: [['ge', 'at least'], ['le', 'at most'], ['is', 'equals'], ['not', 'is not'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  date: [['ge', 'on or after'], ['le', 'on or before'], ['between', 'between'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  bool: [['is', 'is']],
};
const NO_VALUE = ['empty', 'notempty'];

export function describeCond(base, c) {
  const f = fieldOf(base, c.field);
  const name = f ? f.label : c.field;
  const op = ((OPS[f ? f.type : 'text'] || OPS.text).find(([o]) => o === c.op) || [c.op, c.op])[1];
  if (NO_VALUE.includes(c.op)) return `${name} ${op}`;
  const v = Array.isArray(c.value) ? (c.value.length > 2 ? `${c.value.slice(0, 2).map(keyLabel).join(', ')} +${c.value.length - 2}` : c.value.map(keyLabel).join(c.op === 'between' ? ' and ' : ', ')) : c.value;
  return `${name} ${op} ${v}`;
}

// A list of values to tick, read from the data, with a search box.
function multiPick(base, field, value, onChange) {
  const chosen = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const box = mk('details', 'multi');
  const sum = mk('summary', null, chosen.size ? [...chosen].map(keyLabel).join(', ') : 'Choose values…');
  box.append(sum);
  const panel = mk('div', 'multi-panel');
  const search = input('search', '', (q) => load(q), { placeholder: 'Search values', live: true, label: 'Search values' });
  const listEl = mk('div', 'multi-list');
  panel.append(search, listEl);
  box.append(panel);
  let timer;
  const load = (q) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      listEl.replaceChildren(mk('span', 'note', 'Loading…'));
      try {
        const vals = await valuesOf(base, field, q || undefined);
        listEl.replaceChildren();
        const keys = [...new Set([...chosen, ...vals.map((v) => v.v)])];
        for (const k of keys) {
          const hit = vals.find((v) => v.v === k);
          const l = mk('label', 'check');
          const i = document.createElement('input');
          i.type = 'checkbox';
          i.checked = chosen.has(k);
          i.addEventListener('change', () => { if (i.checked) chosen.add(k); else chosen.delete(k); sum.textContent = chosen.size ? [...chosen].map(keyLabel).join(', ') : 'Choose values…'; });
          l.append(i, mk('span', null, keyLabel(k)), mk('i', 'note', hit ? String(hit.n) : ''));
          listEl.append(l);
        }
        if (!keys.length) listEl.append(mk('span', 'note', 'No values'));
      } catch (e) { listEl.replaceChildren(mk('span', 'error', e.message)); }
    }, q ? 250 : 0);
  };
  box.addEventListener('toggle', () => {
    if (box.open) load('');
    else if (JSON.stringify([...chosen]) !== JSON.stringify(Array.isArray(value) ? value : [])) onChange([...chosen]);
  });
  return box;
}

function valueControl(base, c, set) {
  const f = fieldOf(base, c.field);
  if (!f || NO_VALUE.includes(c.op)) return null;
  if (f.type === 'bool') return select([['Yes', 'Yes'], ['No', 'No']], c.value || 'Yes', (v) => set({ value: v }), { label: 'Value' });
  if (c.op === 'in' || c.op === 'notin') return multiPick(base, c.field, c.value, (v) => set({ value: v }));
  if (c.op === 'between') {
    const v = Array.isArray(c.value) ? c.value : ['', ''];
    const wrap = mk('span', 'between');
    wrap.append(input('date', v[0], (x) => set({ value: [x, v[1]] }), { label: 'From' }), mk('span', 'note', 'and'), input('date', v[1], (x) => set({ value: [v[0], x] }), { label: 'To' }));
    return wrap;
  }
  return input(f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text', c.value, (x) => set({ value: x }), { label: 'Value' });
}

export function condRow(base, c, onChange, onRemove, opts = {}) {
  const r = mk('div', 'cond');
  const set = (patch) => onChange({ ...c, ...patch });
  r.append(select(fieldOptions(base, opts.accept || (() => true), { parts: opts.parts }), c.field, (v) => {
    const f = fieldOf(base, v);
    const op = OPS[f ? f.type : 'text'][0][0];
    onChange({ field: v, op, value: f && f.type === 'bool' ? 'Yes' : op === 'in' ? [] : '' });
  }, { blank: 'Choose a field…', label: 'Field' }));
  const f = fieldOf(base, c.field);
  if (f) {
    r.append(select(OPS[f.type] || OPS.text, c.op, (op) => set({ op, value: op === 'in' || op === 'notin' ? [] : op === 'between' ? ['', ''] : f.type === 'bool' ? 'Yes' : '' }), { label: 'Condition' }));
    const v = valueControl(base, c, set);
    if (v) r.append(v);
  }
  r.append(button('✕', 'tool', onRemove, 'Remove condition'));
  return r;
}

// An editable list of conditions on one table.
export function condList(base, list, onChange, opts = {}) {
  const box = mk('div', 'conds');
  list.forEach((c, i) => box.append(condRow(base, c, (nc) => onChange(list.map((x, k) => (k === i ? nc : x))), () => onChange(list.filter((x, k) => k !== i)), opts)));
  box.append(button(opts.addLabel || '+ Add condition', 'btn small', () => onChange([...list, { field: '', op: 'in', value: [] }])));
  return box;
}

// Dashboard filters: each is set on one table; widgets built on other tables reach it through their links.
export function filterChips(host, dash, onChange) {
  host.replaceChildren();
  dash.filters.forEach((f, i) => {
    const chip = mk('span', 'fchip');
    const text = mk('button', 'fchip-text', (app.schema.tables[f.table] ? app.schema.tables[f.table].label + ': ' : '') + describeCond(f.table, f));
    text.type = 'button';
    text.title = 'Change this filter';
    text.addEventListener('click', () => openFilterEditor(dash, i, onChange));
    chip.append(text, button('✕', 'fchip-x', () => onChange(dash.filters.filter((x, k) => k !== i)), 'Remove filter'));
    host.append(chip);
  });
  host.append(button('+ Filter', 'btn small ghost', () => openFilterEditor(dash, -1, onChange)));
}

function openFilterEditor(dash, index, onChange) {
  const dlg = $('modal');
  const tables = Object.entries(app.schema.tables);
  const firstBase = (dash.widgets.find((w) => w.spec && app.schema.tables[w.spec.base]) || {}).spec;
  let f = index >= 0 ? { ...dash.filters[index] } : { table: firstBase ? firstBase.base : tables[0][0], field: '', op: 'in', value: [] };
  const draw = () => {
    const body = mk('div', 'dlg-body');
    body.append(mk('h3', null, index >= 0 ? 'Change filter' : 'Filter the whole dashboard'),
      mk('p', 'note', 'Every widget that can reach this table through its links is filtered. Widgets that cannot say so in their footer.'));
    body.append(mk('span', 'flabel', 'Table'), select(tables.map(([k, t]) => [k, t.label]), f.table, (t) => { f = { table: t, field: '', op: 'in', value: [] }; draw(); }, { label: 'Table' }));
    body.append(mk('span', 'flabel', 'Condition'), condRow(f.table, f, (nc) => { f = { ...f, ...nc }; draw(); }, () => { f.field = ''; draw(); }, { parts: true }));
    const acts = mk('div', 'toolbar end');
    acts.append(button('Cancel', 'btn', () => dlg.close()), button('Apply', 'btn primary', () => {
      if (!f.field) return dlg.close();
      const list = dash.filters.slice();
      if (index >= 0) list[index] = f; else list.push(f);
      dlg.close();
      onChange(list);
    }));
    body.append(acts);
    dlg.replaceChildren(body);
  };
  draw();
  if (!dlg.open) dlg.showModal();
}

export { labelOf };
