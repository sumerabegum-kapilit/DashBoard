// "Data and fields": how a source is described, and adding new data.
// Names, types, formats, hidden fields, the date each table is filtered by, and calculated fields
// are saved on the server for everyone, and every dashboard picks them up.
import { app, mk, button, select, input, check, row, put, post, loadSchema, FORMATS, clone } from './core.js';
import { toast } from '../util.js';
import { importCard } from './bulk.js';

const TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['bool', 'Yes / no']];
const CALC_KINDS = [['diff', 'Time between two dates'], ['arith', 'Arithmetic on numbers'], ['bins', 'Number ranges (e.g. 0–4, 4–24, 24+)'], ['map', 'Group or rename text values']];

export function mountData(host, hooks) {
  const S = app.schema;
  let ov = clone(S.overrides || { tables: {} });
  // a redraw after adding a calculated field keeps the unsaved edits
  let dirty = !!hooks.pending;
  hooks.pending = false;
  const tOv = (t) => (ov.tables[t] = ov.tables[t] || { fields: {}, calcs: [] });
  const fOv = (t, col) => { const o = tOv(t); o.fields = o.fields || {}; return (o.fields[col] = o.fields[col] || {}); };
  const mark = () => { dirty = true; saveBtn.disabled = false; };

  const page = mk('div', 'data-page');
  const head = mk('header', 'dash-bar');
  const top = mk('div', 'dash-top');
  top.append(mk('h1', 'dash-title-static', `${S.label}: data and fields`));
  const saveBtn = button('Save changes', 'btn primary', async () => {
    saveBtn.disabled = true;
    try {
      await put(`/api/s/${app.source}/overrides`, ov);
      await loadSchema(app.source);
      hooks.onChanged();
      dirty = false;
      toast('Saved. Every dashboard on this source now uses the new names and fields.');
      mountData(host, hooks);
    } catch (e) { toast(e.message); saveBtn.disabled = false; }
  });
  saveBtn.disabled = !dirty;
  top.append(saveBtn);
  head.append(top, mk('p', 'note', 'Rename tables and fields, change how numbers are shown, hide fields people do not need, choose the date each table is filtered by, and add calculated fields. The data itself is never changed.'));
  page.append(head);

  // ---- tables ----
  for (const [t, T] of Object.entries(S.tables)) {
    const o = tOv(t);
    const card = mk('details', 'table-card');
    card.open = Object.keys(S.tables)[0] === t;
    const sum = mk('summary');
    sum.append(mk('b', null, T.label), mk('span', 'note', ` ${(T.rows ?? 0).toLocaleString()} rows · ${T.fields.filter((f) => !f.rollup).length} fields`));
    card.append(sum);
    const props = mk('div', 'table-props');
    const own = T.fields.filter((f) => !f.rollup && !f.calc);
    const dates = T.fields.filter((f) => f.type === 'date').map((f) => [f.col, f.label]);
    for (const l of S.links.filter((x) => x.from === t)) for (const f of S.tables[l.to].fields) if (f.type === 'date' && !f.rollup) dates.push([`${l.col}.${f.col}`, `${l.name} › ${f.label}`]);
    props.append(
      row('Name', input('text', o.label || T.label, (v) => { o.label = v; mark(); }, { label: 'Table name' })),
      row('Filtered by date', select(dates, o.date !== undefined ? o.date || '' : T.date || '', (v) => { o.date = v || null; mark(); }, { blank: 'No date', label: 'Date for the dashboard period' })),
      row('Rows are named by', select(T.fields.filter((f) => f.type === 'text' && !f.rollup).map((f) => [f.col, f.label]), o.display || T.display || '', (v) => { o.display = v; mark(); }, { blank: 'Nothing', label: 'Field that names a row' })));
    card.append(props);
    const manage = mk('div', 'toolbar');
    manage.append(button('See it in the model', 'btn small', () => { location.hash = `#/${app.source}/model`; }),
      button('Leave out of the studio', 'btn small danger', async () => {
        if (!confirm(`Leave "${T.label}" out of the studio? Its relationships are removed; the data itself is not deleted. Put it back from the model page.`)) return;
        try { await post(`/api/s/${app.source}/model/remove-tables`, { tables: [t] }); await loadSchema(app.source); hooks.onChanged(); mountData(host, hooks); } catch (e) { toast(e.message); }
      }));
    card.append(manage);

    const tbl = mk('table', 'table fields-table');
    const hr = mk('tr');
    for (const h of ['Field', 'Name', 'Type', 'Format', 'Hidden']) hr.append(mk('th', null, h));
    const th = mk('thead'); th.append(hr); tbl.append(th);
    const tb = mk('tbody');
    for (const f of own) {
      const fo = (o.fields || {})[f.col] || {};
      const tr = mk('tr');
      const td = (el) => { const c = mk('td'); c.append(el); return c; };
      tr.append(mk('td', 'mono', f.col),
        td(input('text', fo.label || f.label, (v) => { fOv(t, f.col).label = v; mark(); }, { label: `Name of ${f.col}` })),
        td(select(TYPES, fo.type || f.type, (v) => { fOv(t, f.col).type = v; mark(); }, { label: `Type of ${f.col}` })),
        td(f.type === 'number' || fo.type === 'number' ? select(FORMATS, fo.format || f.format || 'auto', (v) => { fOv(t, f.col).format = v; mark(); }, { label: `Format of ${f.col}` }) : mk('span', 'note', '—')),
        td(check('', fo.hidden ?? f.hidden, (v) => { fOv(t, f.col).hidden = v; mark(); })));
      tb.append(tr);
    }
    tbl.append(tb);
    const scroll = mk('div', 'scroll');
    scroll.append(tbl);
    card.append(scroll);

    const rolls = T.fields.filter((f) => f.rollup);
    if (rolls.length) card.append(mk('p', 'note', 'Totals borrowed from linked tables: ' + rolls.map((f) => f.label).join(', ')));
    const links = S.links.filter((l) => l.from === t).map((l) => `${l.name} → ${S.tables[l.to].label}`);
    if (links.length) card.append(mk('p', 'note', 'Links to: ' + links.join(', ')));

    // calculated fields
    const calcs = mk('div', 'calcs');
    calcs.append(mk('h3', null, 'Calculated fields'));
    (o.calcs || []).forEach((c, i) => {
      const r = mk('div', 'calc-row');
      r.append(mk('b', null, c.label), mk('span', 'note', describeCalc(c, T)), button('Remove', 'btn small danger', () => { o.calcs = o.calcs.filter((x, k) => k !== i); mark(); mountAgain(); }));
      calcs.append(r);
    });
    calcs.append(calcForm(T, (c) => { o.calcs = [...(o.calcs || []), c]; mark(); mountAgain(); }));
    card.append(calcs);
    page.append(card);
  }
  const mountAgain = () => {
    // redraw with the unsaved edits kept
    S.overrides = ov;
    hooks.pending = true;
    mountData(host, hooks);
    toast('Press "Save changes" to use the new field.');
  };

  page.append(addData(hooks));
  host.replaceChildren(page);
  window.onbeforeunload = () => (dirty ? 'You have unsaved changes.' : undefined);
}

function describeCalc(c, T) {
  const L = (col) => (T.fields.find((f) => f.col === col) || { label: col }).label;
  if (c.kind === 'diff') return `${c.unit} from ${L(c.a)} to ${L(c.b)}`;
  if (c.kind === 'arith') return `${typeof c.a === 'number' ? c.a : L(c.a)} ${c.op} ${typeof c.b === 'number' ? c.b : L(c.b)}`;
  if (c.kind === 'bins') return `${L(c.of)} in ranges at ${c.edges.join(', ')}`;
  if (c.kind === 'map') return `${L(c.of)}: ${Object.entries(c.groups).slice(0, 3).map(([a, b]) => `${a} → ${b}`).join(', ')}${Object.keys(c.groups).length > 3 ? '…' : ''}`;
  return '';
}

function calcForm(T, onAdd) {
  const box = mk('details', 'calc-form');
  box.append(mk('summary', null, '+ Add a calculated field'));
  const form = mk('div', 'calc-body');
  box.append(form);
  const own = T.fields.filter((f) => !f.rollup && !f.calc);
  const of = (type) => own.filter((f) => f.type === type).map((f) => [f.col, f.label]);
  let c = { kind: 'diff', label: '', unit: 'hours' };
  const draw = () => {
    form.replaceChildren(
      row('Kind', select(CALC_KINDS, c.kind, (v) => { c = { kind: v, label: c.label, unit: 'hours', op: '-' }; draw(); }, { label: 'Kind' })),
      row('Name', input('text', c.label, (v) => { c.label = v; }, { placeholder: 'e.g. Hours to first response', label: 'Name', live: true })));
    if (c.kind === 'diff') form.append(row('From', select(of('date'), c.a || '', (v) => { c.a = v; }, { blank: 'Choose…', label: 'From date' })), row('To', select(of('date'), c.b || '', (v) => { c.b = v; }, { blank: 'Choose…', label: 'To date' })), row('In', select([['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days']], c.unit, (v) => { c.unit = v; }, { label: 'Unit' })));
    if (c.kind === 'arith') {
      const side = (k) => { const s = mk('span', 'between'); s.append(select(of('number'), typeof c[k] === 'string' ? c[k] : '', (v) => { c[k] = v; }, { blank: 'A number…', label: 'Field' }), input('number', typeof c[k] === 'number' ? c[k] : '', (v) => { if (v !== '') c[k] = Number(v); }, { placeholder: 'or a value', label: 'Value', step: 'any' })); return s; };
      form.append(row('First', side('a')), row('Operation', select([['+', '+ plus'], ['-', '− minus'], ['*', '× times'], ['/', '÷ divided by']], c.op || '-', (v) => { c.op = v; }, { label: 'Operation' })), row('Second', side('b')));
    }
    if (c.kind === 'bins') form.append(row('Number', select(of('number'), c.of || '', (v) => { c.of = v; }, { blank: 'Choose…', label: 'Number field' })), row('Break at', input('text', (c.edges || []).join(', '), (v) => { c.edges = v.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite); }, { placeholder: '4, 24, 72', label: 'Break points' })));
    if (c.kind === 'map') {
      const ta = document.createElement('textarea');
      ta.rows = 5;
      ta.placeholder = 'One per line:\nUrgent = Needs attention\nHigh = Needs attention';
      ta.value = Object.entries(c.groups || {}).map(([a, b]) => `${a} = ${b}`).join('\n');
      ta.addEventListener('input', () => { c.groups = Object.fromEntries(ta.value.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([a, b]) => a && b)); });
      form.append(row('Field', select([...of('text'), ...of('bool')], c.of || '', (v) => { c.of = v; }, { blank: 'Choose…', label: 'Field' })), row('Values', ta), row('Everything else', input('text', c.rest || '', (v) => { c.rest = v; }, { placeholder: 'Keep as it is', label: 'Everything else' })));
    }
    form.append(button('Add field', 'btn primary small', () => {
      if (!c.label) return toast('Give the field a name.');
      const col = 'calc_' + c.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
      onAdd({ ...c, col });
    }));
  };
  draw();
  return box;
}

// ---- adding data: a CSV or JSON file, or a PostgreSQL database ----
function addData(hooks) {
  const sec = mk('section', 'add-data');
  sec.id = 'add-data';
  sec.append(mk('h2', null, 'Add data'));
  const grid = mk('div', 'add-grid');

  grid.append(importCard(hooks));

  const pg = mk('div', 'add-card');
  let pl = '', url = '', schemaName = 'public';
  const pstatus = mk('p', 'note');
  pg.append(mk('h3', null, 'Connect a PostgreSQL database'), mk('p', 'note', 'Tables, keys and links are read automatically. The connection is read-only. The address is saved on this server in storage/sources.json, so use a read-only database user.'),
    row('Name', input('text', '', (v) => { pl = v; }, { placeholder: 'e.g. Production replica', label: 'Name', live: true })),
    row('Address', input('text', '', (v) => { url = v; }, { placeholder: 'postgres://user:password@host:5432/db', label: 'Address', live: true })),
    row('Schema', input('text', 'public', (v) => { schemaName = v; }, { label: 'Schema', live: true })),
    button('Connect', 'btn', async () => {
      pstatus.textContent = 'Connecting…';
      try {
        const res = await post('/api/sources/connect', { label: pl, url, schemaName });
        await hooks.refreshSources();
        hooks.openSource(res.id);
      } catch (e) { pstatus.textContent = e.message; }
    }), pstatus);
  grid.append(pg);

  const meta = app.sources.find((s) => s.id === app.source);
  if (meta && (meta.kind === 'upload' || meta.kind === 'postgres')) {
    const rm = mk('div', 'add-card');
    rm.append(mk('h3', null, 'Remove this source'), mk('p', 'note', `Removes "${meta.label}" from the studio${meta.kind === 'upload' ? ' and deletes the uploaded files' : ''}. Dashboards built on it stop working.`),
      button('Remove source', 'btn danger', async () => {
        if (!confirm(`Remove "${meta.label}"?`)) return;
        try { await fetch(`/api/sources/${meta.id}`, { method: 'DELETE' }); await hooks.refreshSources(); hooks.openSource(app.sources[0].id); } catch (e) { toast(e.message); }
      }));
    grid.append(rm);
  }
  sec.append(grid);
  return sec;
}
