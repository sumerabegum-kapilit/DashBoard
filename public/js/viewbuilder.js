// "Build a view": a business user picks a table, what to calculate, how to group it, filters and a chart.
// The server turns the choices into SQL over the linked tables; nothing here writes SQL.
import { get, post } from './api.js';
import { read, write } from './state.js';
import { mk, button, selectBox, field, fInt, f1, toast, clamp } from './util.js';
import { render, VIEWS } from './render.js';

let MODEL = null;
export async function loadModel() {
  if (!MODEL) MODEL = await get('/api/model');
  return MODEL;
}

export const FNS = [['count', 'Count of rows'], ['sum', 'Sum of'], ['avg', 'Average of'], ['median', 'Median of'], ['min', 'Lowest'], ['max', 'Highest'], ['distinct', 'Number of different']];
const OPS = {
  text: [['is', 'is'], ['not', 'is not'], ['contains', 'contains'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  number: [['ge', 'at least'], ['le', 'at most'], ['is', 'equals'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  date: [['ge', 'on or after'], ['le', 'on or before'], ['empty', 'is empty'], ['notempty', 'is not empty']],
  bool: [['is', 'is']],
};
const PARTS = ['month', 'quarter', 'year', 'weekday'];
const ADDITIVE = ['count', 'sum'];
const CATEGORY = VIEWS.category.filter(([v]) => v !== 'table');
const TIME = VIEWS.time.filter(([v]) => v !== 'table').map(([v, l]) => ['t:' + v, l]);
export const CHARTS = [['kpi', 'Single number'], ['table', 'Table only'], ...CATEGORY, ...TIME];
const SHARES = ['donut', 'pie', 'polar', 'treemap', 'waffle', 'funnel', 't:area', 't:stack'];

export const STARTER_VIEWS = [
  { id: 'v1', title: 'Hours logged by project type', base: 'timelogs', fn: 'sum', field: 'hours', group: 'item_id.project_id.type', filters: [{ field: 'hours', op: 'le', value: '12' }], chart: 'bar', top: 10 },
  { id: 'v2', title: 'Average watchers per work item, by priority', base: 'items', fn: 'avg', field: 'n_watchers', group: 'priority', filters: [], chart: 'column', top: 10 },
  { id: 'v3', title: 'Comments written per person', base: 'comments', fn: 'count', group: 'author_id.name', filters: [], chart: 'bar', top: 10 },
  { id: 'v4', title: 'Work items by sprint status', base: 'items', fn: 'count', group: 'sprint_id.status', filters: [{ field: 'sprint_id.status', op: 'notempty' }], chart: 'donut', top: 10 },
  { id: 'v5', title: 'Status changes by weekday and new status', base: 'changes', fn: 'count', group: 'date|weekday', split: 'to_status', filters: [], chart: 'bar', top: 10 },
  { id: 'v6', title: 'Work items created per week, by type', base: 'items', fn: 'count', group: 'type', time: 'created', grain: 'week', filters: [], chart: 't:line', top: 5 },
];
const BLANK = { title: '', base: 'items', fn: 'count', field: '', group: 'status', split: '', time: '', grain: 'auto', filters: [], chart: 'bar', top: 10 };

// ---- fields reachable from a table, up to two links away ----
const fieldCache = new Map();
export function fieldsFrom(base) {
  if (fieldCache.has(base)) return fieldCache.get(base);
  const out = [];
  const walk = (t, prefix, names, depth, seen) => {
    const group = names.length ? names.join(' › ') : MODEL.tables[t].label;
    for (const f of MODEL.tables[t].fields) out.push({ path: prefix + f.col, label: [...names, f.label].join(' › '), short: f.label, type: f.type, group });
    if (depth >= 2) return;
    for (const l of MODEL.links) {
      if (l.from !== t || seen.includes(l.col + '>' + l.to)) continue;
      walk(l.to, prefix + l.col + '.', [...names, l.name], depth + 1, [...seen, l.col + '>' + l.to]);
    }
  };
  walk(base, '', [], 0, []);
  fieldCache.set(base, out);
  return out;
}
export function fieldOf(base, ref) {
  const [path, part] = String(ref || '').split('|');
  const f = fieldsFrom(base).find((x) => x.path === path);
  return f ? { ...f, part } : null;
}
const refLabel = (base, ref) => { const f = fieldOf(base, ref); return f ? f.label + (f.part ? ` (${f.part})` : '') : ''; };
export const keyLabel = (k) => (k === '__other' ? 'Other' : k === '__all' ? 'All' : String(k));
export function describe(spec) {
  const what = spec.fn === 'count' ? 'Count of ' + MODEL.tables[spec.base].label.toLowerCase() : (FNS.find(([f]) => f === spec.fn) || [])[1] + ' ' + (refLabel(spec.base, spec.field) || '…').toLowerCase();
  const by = [spec.group && 'by ' + refLabel(spec.base, spec.group).toLowerCase(), spec.split && 'split by ' + refLabel(spec.base, spec.split).toLowerCase(), spec.time && 'over ' + refLabel(spec.base, spec.time).toLowerCase()].filter(Boolean).join(', ');
  return what + (by ? ' ' + by : '');
}
export function normSpec(s) {
  const o = { ...BLANK, ...(s || {}), filters: Array.isArray(s && s.filters) ? s.filters.map((f) => ({ ...f })) : [] };
  if (!MODEL.tables[o.base]) o.base = 'items';
  for (const k of ['field', 'group', 'split', 'time']) if (o[k] && !fieldOf(o.base, o[k])) o[k] = '';
  o.filters = o.filters.filter((f) => !f.field || fieldOf(o.base, f.field));
  if (!FNS.some(([f]) => f === o.fn)) o.fn = 'count';
  if (!CHARTS.some(([c]) => c === o.chart)) o.chart = 'bar';
  return o;
}
const apiSpec = (s) => ({ base: s.base, fn: s.fn, field: s.field, group: s.group, split: s.split, time: s.time, grain: s.grain, top: s.top, filters: s.filters.filter((f) => f.field && f.op) });

// ---- results ----
const results = new Map();
export async function runSpec(spec) {
  const key = JSON.stringify(apiSpec(spec));
  if (!results.has(key)) {
    const p = post('/api/model/query', { spec: apiSpec(spec) });
    results.set(key, p);
    p.catch(() => results.delete(key));
  }
  return results.get(key);
}
export function payloadOf(res) {
  if (res.time) return { kind: 'time', grain: res.time.grain, fmt: 'auto', keys: res.time.keys, series: res.time.series.map((s) => ({ name: s.key, label: keyLabel(s.key), values: s.values })) };
  if (res.groups) {
    return {
      kind: 'category', fmt: 'auto',
      items: res.groups.map((g) => ({ name: g.key, label: keyLabel(g.key), value: g.value ?? 0, segs: res.additive && g.segs ? g.segs.map((s) => ({ name: s.key, label: keyLabel(s.key), value: s.value })) : undefined })),
    };
  }
  return null;
}
const num = (v) => (v == null ? '—' : Number.isInteger(v) ? fInt(v) : f1(v));
// Which records sit behind a clicked value
export function selection(res, spec, pick) {
  const sel = {};
  const shownGroups = (res.groups || []).map((g) => g.key).filter((k) => k !== '__other');
  if (pick.group !== undefined) { sel.group = pick.group; sel.groupShown = shownGroups; }
  if (pick.index !== undefined && res.time) { sel.bucket = res.time.keys[pick.index]; sel.grain = res.time.grain; }
  if (pick.series !== undefined) { sel.series = pick.series; sel.seriesShown = (spec.split ? res.splitKeys || [] : shownGroups).filter((k) => k !== '__other'); }
  return sel;
}
export function drawResult(box, res, spec, onPick) {
  box.replaceChildren();
  if (!res.rows) return box.append(mk('p', 'empty', 'No rows match. Remove a filter or pick another table.'));
  if (spec.chart === 'kpi') {
    const k = mk('div', 'view-kpi');
    k.append(button(num(res.total), 'view-kpi-num', () => onPick({}), 'Show the records'), mk('span', 'note', describe(spec)));
    return box.append(k);
  }
  if (spec.chart === 'table') return;
  const time = spec.chart.startsWith('t:');
  if (time && !res.time) return box.append(mk('p', 'empty', 'Pick a date in "Over time" to draw this chart.'));
  if (!time && !res.groups) return box.append(mk('p', 'empty', 'Pick a field in "Group by" to draw this chart.'));
  const data = time ? payloadOf({ time: res.time }) : payloadOf({ groups: res.groups, additive: res.additive });
  render(box, data, time ? spec.chart.slice(2) : spec.chart, {
    height: 300,
    onPick: (p) => onPick(time ? { index: p.index, series: p.series } : { group: p.name }),
  });
}

// ---- the page ----
const ui = { drill: null, drillPage: 1, tablePage: 1, tableSig: '', showModel: false, seq: 0 };
let host = null;

export async function mountBuilder(el) {
  host = el;
  el.replaceChildren(mk('p', 'empty', 'Loading tables…'));
  try { await loadModel(); } catch (e) { el.replaceChildren(mk('p', 'error', e.message)); return; }
  draw();
}
const getDraft = () => normSpec(read('draft', STARTER_VIEWS[0]));
const setDraft = (d) => { write('draft', normSpec(d)); ui.drill = null; draw(); };
export const getSaved = () => (read('views', null) || STARTER_VIEWS).map((v) => ({ ...normSpec(v), id: v.id }));
const setSaved = (list) => { write('views', list); draw(); };

function draw() {
  const d = getDraft();
  const root = mk('div', 'builder');
  root.append(editor(d));
  const out = mk('section', 'card result');
  const head = mk('div', 'result-head');
  const titles = mk('div');
  titles.append(mk('h3', null, d.title || describe(d)));
  const sub = mk('span', 'note', 'Running…');
  titles.append(sub);
  head.append(titles);
  out.append(head);
  const box = mk('div', 'chart-box');
  out.append(box);
  const tableHost = mk('div');
  out.append(tableHost);
  root.append(out);
  const drillHost = mk('div');
  root.append(drillHost, gallery(), modelPanel());
  host.replaceChildren(root);

  const seq = ++ui.seq;
  runSpec(d).then((res) => {
    if (seq !== ui.seq) return;
    sub.textContent = `${fInt(res.rows)} of ${fInt(MODEL.tables[d.base].rows)} rows · result ${num(res.total)}`;
    const pick = (p) => { ui.drill = selection(res, d, p); ui.drillPage = 1; showRecords(drillHost, d, true); };
    try { drawResult(box, res, d, pick); } catch (e) { box.replaceChildren(mk('p', 'empty', 'This combination could not be drawn. Try another chart or grouping.')); }
    if (!box.childNodes.length) box.remove();
    if (res.rows) tableHost.append(resultTable(res, d, pick));
    if (ui.drill) showRecords(drillHost, d, false);
  }).catch((e) => {
    if (seq !== ui.seq) return;
    sub.textContent = '';
    box.replaceChildren(mk('p', 'error', e.message));
  });
}

function editor(d) {
  const card = mk('section', 'card editor');
  const up = (patch) => setDraft({ ...d, ...patch });
  const base = d.base;
  const head = mk('div', 'editor-head');
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'view-title';
  title.value = d.title || '';
  title.placeholder = describe(d);
  title.setAttribute('aria-label', 'Name of this view');
  title.addEventListener('change', () => up({ title: title.value.trim() }));
  head.append(title);
  const saved = getSaved();
  const editing = d.id && saved.some((v) => v.id === d.id);
  const acts = mk('div', 'toolbar');
  if (editing) acts.append(button('Save changes', 'btn primary', () => { setSaved(saved.map((v) => (v.id === d.id ? { ...d } : v))); toast('Saved.'); }));
  acts.append(
    button(editing ? 'Save as new view' : 'Save view', editing ? 'btn' : 'btn primary', () => {
      const id = 'v' + Date.now().toString(36);
      const view = { ...d, id, title: d.title || describe(d) };
      write('views', [...saved, view]);
      setDraft(view);
      toast('Saved to My views.');
    }),
    button('Add to My dashboard', 'btn', () => {
      let id = d.id;
      let views = saved;
      if (!editing) { id = 'v' + Date.now().toString(36); views = [...saved, { ...d, id, title: d.title || describe(d) }]; write('views', views); write('draft', { ...d, id, title: d.title || describe(d) }); }
      const board = read('board', []);
      if (!board.some((b) => b.id === id)) write('board', [...board, { id, w: 3 }]);
      toast('Added to My dashboard.');
      draw();
    }),
    button('Start over', 'btn', () => setDraft({ ...BLANK })),
  );
  head.append(acts);
  card.append(head);

  const steps = mk('div', 'steps');
  const step = (n, label, ...controls) => {
    const s = mk('div', 'step');
    s.append(mk('span', 'step-num', String(n)), mk('b', null, label));
    const body = mk('div', 'step-body');
    body.append(...controls);
    s.append(body);
    steps.append(s);
  };
  const groupsOf = (accept, withParts) => {
    const groups = new Map();
    for (const f of fieldsFrom(base)) {
      if (!accept(f)) continue;
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push([f.path, f.short]);
      if (withParts && f.type === 'date') for (const p of PARTS) groups.get(f.group).push([f.path + '|' + p, `${f.short} (${p})`]);
    }
    return [...groups].map(([group, items]) => ({ group, items }));
  };
  step(1, 'Start from', field('Table', selectBox(Object.entries(MODEL.tables).map(([k, t]) => [k, `${t.label} (${fInt(t.rows)})`]), base,
    (v) => up({ base: v, field: '', group: '', split: '', time: '', filters: [] }), { label: 'Table' })));
  const calc = [field('Calculate', selectBox(FNS, d.fn, (v) => up({ fn: v, field: v === 'count' ? '' : d.field, chart: !ADDITIVE.includes(v) && SHARES.includes(d.chart) ? 'bar' : d.chart })))];
  if (d.fn !== 'count') calc.push(field('Field', selectBox(groupsOf(d.fn === 'distinct' ? () => true : (f) => f.type === 'number'), d.field, (v) => up({ field: v }), { blank: 'Choose a field…' })));
  step(2, 'What to calculate', ...calc);
  const groupable = (f) => f.type !== 'number' || /hour|status/i.test(f.short);
  step(3, 'Group and split',
    field('Group by', selectBox(groupsOf(groupable, true), d.group, (v) => up({ group: v }), { blank: 'No grouping' })),
    field('Split each group by', selectBox(groupsOf(groupable, true), d.split, (v) => up({ split: v }), { blank: 'No split' })));
  step(4, 'Over time',
    field('Date', selectBox(groupsOf((f) => f.type === 'date'), d.time, (v) => up({ time: v, chart: v && !d.chart.startsWith('t:') ? 't:line' : !v && d.chart.startsWith('t:') ? 'bar' : d.chart }), { blank: 'Not over time' })),
    field('Step', selectBox([['auto', 'Automatic'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']], d.grain || 'auto', (v) => up({ grain: v }))));
  step(5, 'Show as',
    field('Chart', selectBox(CHARTS, d.chart, (v) => up({ chart: v }), { disabled: (v) => !ADDITIVE.includes(d.fn) && SHARES.includes(v) })),
    field('Groups shown', selectBox([[5, 'Top 5'], [10, 'Top 10'], [15, 'Top 15'], [25, 'Top 25'], [50, 'Top 50']], String(d.top), (v) => up({ top: Number(v) }))));
  card.append(steps);

  const fbox = mk('div', 'filters-box');
  fbox.append(mk('b', null, 'Only include rows where'));
  d.filters.forEach((f, i) => {
    const row = mk('div', 'filter-row');
    const setF = (patch) => up({ filters: d.filters.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
    const def = fieldOf(base, f.field);
    row.append(selectBox(groupsOf(() => true), f.field, (v) => { const nf = fieldOf(base, v); setF({ field: v, op: OPS[nf ? nf.type : 'text'][0][0], value: '' }); }, { blank: 'Choose a field…', label: 'Field' }));
    if (def) {
      row.append(selectBox(OPS[def.type] || OPS.text, f.op, (v) => setF({ op: v }), { label: 'Condition' }));
      if (!['empty', 'notempty'].includes(f.op)) {
        let input;
        if (def.type === 'bool') input = selectBox([['Yes', 'Yes'], ['No', 'No']], f.value || '', (v) => setF({ value: v }), { blank: 'Choose…', label: 'Value' });
        else if (def.type === 'text' && (f.op === 'is' || f.op === 'not')) {
          input = selectBox([], f.value || '', (v) => setF({ value: v }), { blank: f.value || 'Loading values…', label: 'Value' });
          post('/api/model/values', { base, field: f.field }).then((vals) => {
            input.replaceChildren(new Option('Choose…', ''), ...vals.map((v) => new Option(`${v.v} (${fInt(v.n)})`, v.v)));
            input.value = f.value || '';
          }).catch(() => {});
        } else {
          input = document.createElement('input');
          input.type = def.type === 'date' ? 'date' : def.type === 'number' ? 'number' : 'text';
          input.value = f.value || '';
          input.setAttribute('aria-label', 'Value');
          input.addEventListener('change', () => setF({ value: input.value }));
        }
        row.append(input);
      }
    }
    row.append(button('✕', 'tool', () => up({ filters: d.filters.filter((x, k) => k !== i) }), 'Remove this filter'));
    fbox.append(row);
  });
  fbox.append(button('+ Add filter', 'btn', () => up({ filters: [...d.filters, { field: '', op: 'is', value: '' }] })));
  card.append(fbox);
  return card;
}

function resultTable(res, spec, pick) {
  let head, rows;
  if (res.groups) {
    head = [refLabel(spec.base, spec.group), ...(res.additive && res.splitKeys ? res.splitKeys.map(keyLabel) : []), res.additive && res.splitKeys ? 'Total' : 'Value'];
    rows = res.groups.map((g) => ({ cells: [keyLabel(g.key), ...(res.additive && g.segs ? g.segs.map((s) => num(s.value)) : []), num(g.value)], pick: { group: g.key } }));
  } else if (res.time) {
    head = ['Period', ...res.time.series.map((s) => keyLabel(s.key))];
    rows = res.time.keys.map((k, i) => ({ cells: [k, ...res.time.series.map((s) => num(s.values[i]))], pick: { index: i } })).reverse();
  } else {
    head = ['Result'];
    rows = [{ cells: [num(res.total)], pick: {} }];
  }
  const sig = JSON.stringify(apiSpec(spec));
  if (ui.tableSig !== sig) { ui.tableSig = sig; ui.tablePage = 1; }
  const last = Math.max(1, Math.ceil(rows.length / 10));
  ui.tablePage = clamp(ui.tablePage, 1, last);
  const wrap = mk('div', 'result-table');
  const scroll = mk('div', 'scroll'), t = mk('table', 'table');
  scroll.append(t);
  const hr = mk('tr');
  for (const h of head) hr.append(mk('th', null, h));
  const th = mk('thead'); th.append(hr); t.append(th);
  const tb = mk('tbody'); t.append(tb);
  for (const r of rows.slice((ui.tablePage - 1) * 10, ui.tablePage * 10)) {
    const tr = mk('tr'), first = mk('td');
    first.append(button(r.cells[0], 'link', () => pick(r.pick), 'Show records for ' + r.cells[0]));
    tr.append(first, ...r.cells.slice(1).map((c) => mk('td', null, c)));
    tb.append(tr);
  }
  const tools = mk('div', 'pager');
  const prev = button('‹ Previous', 'btn', () => { ui.tablePage--; draw(); });
  prev.disabled = ui.tablePage <= 1;
  const next = button('Next ›', 'btn', () => { ui.tablePage++; draw(); });
  next.disabled = ui.tablePage >= last;
  const msg = mk('span', 'note');
  tools.append(prev, next, mk('span', 'note', `page ${ui.tablePage} of ${last}`), button('Copy as CSV', 'btn', () => {
    const csv = [head, ...rows.map((r) => r.cells)].map((line) => line.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    navigator.clipboard.writeText(csv).then(() => { msg.textContent = `Copied ${rows.length} rows.`; }, () => { msg.textContent = 'The browser blocked copying.'; });
  }), msg);
  wrap.append(scroll, tools);
  return wrap;
}

export async function recordsPanel(target, spec, sel, page, onPage, onClose) {
  target.replaceChildren(mk('p', 'empty', 'Loading records…'));
  try {
    const data = await post('/api/model/records', { spec: apiSpec(spec), sel, page });
    const panel = mk('section', 'card records');
    const head = mk('div', 'result-head');
    head.append(mk('h3', null, `Records (${fInt(data.total)})`), button('Close', 'btn', onClose));
    const scroll = mk('div', 'scroll'), t = mk('table', 'table wrap');
    scroll.append(t);
    const hr = mk('tr');
    for (const c of data.columns) hr.append(mk('th', null, c.label));
    const th = mk('thead'); th.append(hr); t.append(th);
    const tb = mk('tbody'); t.append(tb);
    const show = (v) => (v == null ? '—' : v === true ? 'Yes' : v === false ? 'No' : String(v));
    for (const r of data.rows) { const tr = mk('tr'); for (const c of data.columns) tr.append(mk('td', null, show(r[c.key]))); tb.append(tr); }
    const last = Math.max(1, Math.ceil(data.total / 10));
    const pager = mk('div', 'pager');
    const prev = button('‹ Previous', 'btn', () => onPage(page - 1));
    prev.disabled = page <= 1;
    const next = button('Next ›', 'btn', () => onPage(page + 1));
    next.disabled = page >= last;
    pager.append(prev, next, mk('span', 'note', `page ${page} of ${last}`));
    panel.append(head, scroll, pager);
    target.replaceChildren(panel);
    return panel;
  } catch (e) {
    target.replaceChildren(mk('p', 'error', e.message));
    return null;
  }
}
async function showRecords(target, spec, scroll) {
  const panel = await recordsPanel(target, spec, ui.drill, ui.drillPage,
    (p) => { ui.drillPage = p; showRecords(target, spec, false); },
    () => { ui.drill = null; target.replaceChildren(); });
  if (panel && scroll) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function gallery() {
  const saved = getSaved(), d = getDraft(), board = read('board', []);
  const card = mk('section', 'card');
  card.append(mk('h3', null, 'My views'));
  if (!saved.length) { card.append(mk('p', 'empty', 'No saved views yet. Build one above and press Save view.')); return card; }
  const grid = mk('div', 'gallery');
  saved.forEach((v, i) => {
    const tile = mk('div', 'tile' + (d.id === v.id ? ' open' : ''));
    tile.append(mk('b', null, v.title || describe(v)), mk('span', 'note', describe(v)));
    const acts = mk('div', 'toolbar');
    const move = (to) => { const next = saved.slice(); const [it] = next.splice(i, 1); next.splice(clamp(to, 0, next.length), 0, it); setSaved(next); };
    const earlier = button('◀', 'tool', () => move(i - 1), 'Move earlier');
    earlier.disabled = i === 0;
    const later = button('▶', 'tool', () => move(i + 1), 'Move later');
    later.disabled = i === saved.length - 1;
    const pinned = board.some((b) => b.id === v.id);
    acts.append(
      button('Open', 'btn primary', () => { setDraft({ ...v }); window.scrollTo({ top: 0, behavior: 'smooth' }); }),
      button(pinned ? 'On My dashboard' : 'Add to My dashboard', 'btn', () => { if (!pinned) { write('board', [...board, { id: v.id, w: 3 }]); toast('Added to My dashboard.'); draw(); } }),
      button('Copy', 'btn', () => setSaved([...saved.slice(0, i + 1), { ...v, id: 'v' + Date.now().toString(36), title: (v.title || describe(v)) + ' (copy)' }, ...saved.slice(i + 1)])),
      button('Delete', 'btn danger', () => { setSaved(saved.filter((x) => x.id !== v.id)); write('board', board.filter((b) => b.id !== v.id)); }),
      earlier, later,
    );
    tile.append(acts);
    grid.append(tile);
  });
  card.append(grid);
  return card;
}

function modelPanel() {
  const card = mk('section', 'card');
  const head = mk('div', 'result-head');
  head.append(mk('h3', null, 'How the tables connect'), button(ui.showModel ? 'Hide' : 'Show', 'btn', () => { ui.showModel = !ui.showModel; draw(); }));
  card.append(head);
  if (!ui.showModel) return card;
  const grid = mk('div', 'model-grid');
  for (const [k, t] of Object.entries(MODEL.tables)) {
    const box = mk('div', 'model-box');
    box.append(mk('b', null, `${t.label} · ${fInt(t.rows)} rows`));
    const out = MODEL.links.filter((l) => l.from === k).map((l) => `${l.name} → ${MODEL.tables[l.to].label}`);
    if (out.length) box.append(mk('span', 'note', 'Links to: ' + out.join(', ')));
    const own = t.fields.filter((f) => !f.rollup).map((f) => f.label);
    const borrowed = t.fields.filter((f) => f.rollup).map((f) => f.label);
    box.append(mk('span', 'note', 'Fields: ' + own.join(', ')));
    if (borrowed.length) box.append(mk('span', 'note', 'Borrowed totals: ' + borrowed.join(', ')));
    grid.append(box);
  }
  card.append(grid);
  return card;
}
