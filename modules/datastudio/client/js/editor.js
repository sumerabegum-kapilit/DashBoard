// The widget editor: a drawer on the right. Every change redraws the widget on the board at once,
// so people see the effect while they choose. "Done" keeps the changes, "Cancel" puts the widget back.
import { app, $, mk, button, select, input, check, row, fieldOptions, fieldOf, labelOf, FORMATS, clone } from './core.js';
import { condList } from './filters.js';
import { CHARTS, ICON, cannot } from './widget.js';

const FNS = [['count', 'Count rows'], ['sum', 'Total of'], ['avg', 'Average of'], ['median', 'Median of'], ['min', 'Lowest'], ['max', 'Highest'], ['distinct', 'Number of different'], ['rate', 'Share of rows where…']];
const NUMERIC = ['sum', 'avg', 'median', 'min', 'max'];
const SORTS = [['auto', 'Natural order'], ['value-desc', 'Largest first'], ['value-asc', 'Smallest first'], ['label-asc', 'A to Z'], ['label-desc', 'Z to A']];
const STEPS = [['auto', 'Automatic'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
// numbers are offered for grouping only when they are small whole numbers or ratings
const groupable = (f) => f.type !== 'number' || (!f.rollup && (f.format === 'int' || /level|rating|satisfaction/i.test(f.path)));

let tab = 'data';

export function openEditor(widget, { onLive, onDone, onCancel }) {
  const drawer = $('drawer');
  const original = clone(widget);
  let w = clone(widget);
  let timer;
  const live = (soft) => { clearTimeout(timer); timer = setTimeout(() => onLive(clone(w)), soft ? 300 : 0); };
  const set = (patch, redraw = true, soft = false) => { w = { ...w, ...patch }; live(soft); if (redraw) draw(); };
  const setSpec = (patch, redraw = true) => set({ spec: { ...w.spec, ...patch } }, redraw);
  const setOpts = (patch, redraw = true, soft = false) => set({ opts: { ...(w.opts || {}), ...patch } }, redraw, soft);
  const close = () => { drawer.hidden = true; app.root.classList.remove('with-drawer'); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !$('modal').open) { close(); onCancel(original); } };
  document.addEventListener('keydown', onKey);

  function draw() {
    const scroller = drawer.querySelector('.drawer-body');
    const top = scroller ? scroller.scrollTop : 0;
    const head = mk('div', 'drawer-head');
    head.append(mk('h2', null, 'Edit widget'), button('✕', 'tool', () => { close(); onCancel(original); }, 'Close without saving'));
    const tabs = mk('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const list = [['data', 'Data'], ['look', 'Look'], ...(w.chart === 'records' ? [['columns', 'Columns']] : []), ['size', 'Size']];
    if (!list.some(([k]) => k === tab)) tab = 'data';
    for (const [k, label] of list) {
      const b = button(label, 'tab', () => { tab = k; draw(); });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === k));
      tabs.append(b);
    }
    const body = mk('div', 'drawer-body');
    if (tab === 'data') dataTab(body);
    if (tab === 'look') lookTab(body);
    if (tab === 'columns') columnsTab(body);
    if (tab === 'size') sizeTab(body);
    const foot = mk('div', 'drawer-foot');
    foot.append(button('Cancel', 'btn', () => { close(); onCancel(original); }), button('Done', 'btn primary', () => { close(); onDone(clone(w)); }));
    drawer.replaceChildren(head, tabs, body, foot);
    body.scrollTop = top;
  }

  // ---- what to show ----
  function dataTab(el) {
    const s = w.spec;
    const base = s.base;
    const T = app.schema.tables;
    el.append(section('Start from',
      row('Table', select(Object.entries(T).map(([k, t]) => [k, `${t.label} (${(t.rows ?? 0).toLocaleString()} rows)`]), base, (v) => {
        set({ spec: { base: v, measures: [{ fn: 'count' }], group: '', split: '', time: '', filters: [], dateField: '' }, opts: { ...(w.opts || {}), columns: undefined } });
      }, { label: 'Table' }))));
    if (w.chart === 'text') return el.append(mk('p', 'note', 'A text note has no data. Write it on the Look tab.'));

    if (w.chart !== 'records') {
      const box = section('Measures', mk('p', 'note', 'What to calculate. Add more than one for tables, scatter plots, or lines such as "created vs resolved".'));
      s.measures.forEach((m, i) => box.append(measureCard(m, i)));
      if (s.measures.length < 6) box.append(button('+ Add measure', 'btn small', () => setSpec({ measures: [...s.measures, { fn: 'count' }] })));
      el.append(box);

      const g = section('Group and split');
      g.append(row('Group by', select(fieldOptions(base, groupable, { parts: true }), s.group, (v) => setSpec({ group: v }), { blank: 'No grouping', label: 'Group by' })));
      if (s.group || s.time) g.append(row('Split by', select(fieldOptions(base, groupable, { parts: true }), s.split, (v) => setSpec({ split: v }), { blank: 'No split', label: 'Split by' })));
      if (s.group) {
        g.append(row('Show', select([5, 8, 10, 12, 15, 20, 25, 30, 50, 100].map((n) => [n, `Top ${n}`]), s.top || 10, (v) => setSpec({ top: Number(v) }), { label: 'How many groups' }),
          check('Put the rest in "Other"', s.other !== false, (v) => setSpec({ other: v }))));
        g.append(row('Order', select(SORTS, s.sort || 'auto', (v) => setSpec({ sort: v }), { label: 'Order' })));
      }
      if (s.split) g.append(row('Split values', select([3, 4, 6, 8, 10, 12, 24].map((n) => [n, `Top ${n}`]), s.splitTop || 6, (v) => setSpec({ splitTop: Number(v) }), { label: 'How many split values' })));
      el.append(g);

      const t = section('Over time');
      t.append(row('Date', select(fieldOptions(base, (f) => f.type === 'date'), s.time, (v) => {
        const chart = v && !w.chart.startsWith('t:') && !['kpi', 'gauge', 'pivot'].includes(w.chart) ? 't:line' : !v && w.chart.startsWith('t:') ? (s.group ? 'bar' : 'kpi') : w.chart;
        set({ chart, spec: { ...s, time: v } });
      }, { blank: 'Not over time', label: 'Date' })));
      if (s.time) t.append(row('Step', select(STEPS, s.grain || 'auto', (v) => setSpec({ grain: v }), { label: 'Step' }), check('Running total', !!s.cumulative, (v) => setSpec({ cumulative: v }))));
      el.append(t);
    }

    const f = section('Filters for this widget');
    f.append(condList(base, s.filters || [], (list) => setSpec({ filters: list }), { parts: true, addLabel: '+ Add filter' }));
    el.append(f);

    const dates = fieldOptions(base, (x) => x.type === 'date');
    const def = T[base].date;
    const p = section('Dashboard period');
    p.append(row('Applies to', select([['', def ? `${labelOf(base, def)} (usual date)` : 'This table has no usual date'], ...dates.flatMap((gr) => gr.items.map(([v, l]) => [v, gr.group + ' › ' + l])), ['-', 'Ignore the period']], s.dateField || '', (v) => setSpec({ dateField: v }), { label: 'Period applies to' })));
    el.append(p);
  }

  function measureCard(m, i) {
    const s = w.spec;
    const card = mk('div', 'measure');
    const up = (patch) => setSpec({ measures: s.measures.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
    const head = mk('div', 'measure-head');
    head.append(mk('span', 'measure-num', String(i + 1)), select(FNS, m.fn, (fn) => up({ fn, field: fn === 'count' || fn === 'rate' ? '' : m.field && (fn === 'distinct' || (fieldOf(s.base, m.field) || {}).type === 'number') ? m.field : '', filters: fn === 'rate' && !(m.filters || []).length ? [{ field: '', op: 'in', value: [] }] : m.filters }), { label: 'Calculation' }));
    if (m.fn !== 'count' && m.fn !== 'rate') head.append(select(fieldOptions(s.base, (f) => (NUMERIC.includes(m.fn) ? f.type === 'number' : true)), m.field, (v) => up({ field: v }), { blank: 'Choose a field…', label: 'Field' }));
    if (s.measures.length > 1) {
      head.append(button('↑', 'tool', () => { if (i) { const l = s.measures.slice(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; setSpec({ measures: l }); } }, 'Move up'),
        button('✕', 'tool', () => setSpec({ measures: s.measures.filter((x, k) => k !== i) }), 'Remove measure'));
    }
    card.append(head);
    card.append(row('Name', input('text', m.label || '', (v) => { s.measures[i] = { ...m, label: v }; setSpec({ measures: s.measures.slice() }, false); }, { placeholder: 'Automatic', label: 'Measure name' })));
    const conds = m.filters || [];
    const more = mk('details', 'measure-more');
    if (conds.length || m.fn === 'rate' || m.time) more.open = true;
    more.append(mk('summary', null, m.fn === 'rate' ? 'Which rows count as "yes"' : 'Only count rows where… (optional)'));
    more.append(condList(s.base, conds, (list) => up({ filters: list }), { parts: true }));
    if (s.time && !s.group && !s.split && s.measures.length > 1) {
      more.append(row('Date for this line', select(fieldOptions(s.base, (f) => f.type === 'date'), m.time || '', (v) => up({ time: v }), { blank: `Same as "Over time"`, label: 'Date for this measure' })));
    }
    card.append(more);
    return card;
  }

  // ---- how it looks ----
  function lookTab(el) {
    const o = w.opts || {};
    el.append(section('Title', input('text', w.title || '', (v) => set({ title: v }, false, true), { placeholder: 'Widget title', label: 'Title', live: true })));
    const gal = section('Show as');
    let group = null;
    let grid;
    for (const [id, label, g] of CHARTS) {
      if (g !== group) { group = g; gal.append(mk('span', 'gal-group', g)); grid = mk('div', 'gallery-grid'); gal.append(grid); }
      const why = cannot(id, w.spec);
      const b = button('', 'chart-pick', () => {
        const patch = { chart: id };
        if (id === 'records' && !o.pageSize) patch.opts = { ...o, pageSize: 10 };
        set(patch);
      });
      b.append(mk('span', 'chart-icon', ICON[id] || '•'), mk('span', null, label));
      b.setAttribute('aria-pressed', String(w.chart === id));
      if (why) { b.classList.add('unfit'); b.title = why; } else b.title = label;
      grid.append(b);
    }
    el.append(gal);

    const c = w.chart;
    const opts = section('Options');
    if (!['records', 'text'].includes(c)) opts.append(row('Number format', select(FORMATS, o.format || 'auto', (v) => setOpts({ format: v }), { label: 'Number format' })));
    if (['bar', 'column', 'lollipop', 'radar', 'funnel', 'treemap', 'donut', 'pie', 'waffle', 'polar'].includes(c)) opts.append(check('Show as share of the total', !!o.share, (v) => setOpts({ share: v })));
    if (c === 'bar') opts.append(check('Mark the previous period (turn on "Compare" on the dashboard)', !!o.compare, (v) => setOpts({ compare: v })));
    if (c === 'kpi' || c === 'gauge') {
      if (c === 'kpi') opts.append(check('Small trend line', !!o.spark, (v) => {
        const T = app.schema.tables[w.spec.base];
        set({ opts: { ...o, spark: v }, spec: { ...w.spec, time: v ? w.spec.time || T.date || '' : w.spec.time } });
      }));
      opts.append(row('Target', input('number', o.target ?? '', (v) => setOpts({ target: v === '' ? undefined : Number(v) }), { label: 'Target', step: 'any' })),
        row('Good when', select([['up', 'Higher is better'], ['down', 'Lower is better'], ['', 'Neither']], o.good ?? 'up', (v) => setOpts({ good: v }), { label: 'Good when' })));
      if (c === 'gauge') opts.append(row('Scale', input('number', o.min ?? 0, (v) => setOpts({ min: Number(v) }), { label: 'Lowest', step: 'any' }), mk('span', 'note', 'to'), input('number', o.max ?? '', (v) => setOpts({ max: v === '' ? undefined : Number(v) }), { label: 'Highest', step: 'any' })));
    }
    if (c === 'pivot') opts.append(check('Bars inside the cells', !!o.bars, (v) => setOpts({ bars: v })));
    if (c === 'text') {
      const ta = document.createElement('textarea');
      ta.value = o.text || '';
      ta.rows = 8;
      ta.placeholder = 'Write a note. **bold**, lines starting with "- " become a list.';
      ta.addEventListener('input', () => setOpts({ text: ta.value }, false, true));
      opts.append(ta);
    }
    if (opts.children.length > 1) el.append(opts);
  }

  // ---- which columns a records table shows ----
  function columnsTab(el) {
    const o = w.opts || {};
    const s = w.spec;
    const cols = o.columns && o.columns.length ? o.columns : null;
    const box = section('Columns', mk('p', 'note', 'Pick any field of this table or of the tables it links to. Use the arrows to change the order.'));
    const list = mk('div', 'col-list');
    const current = cols || [];
    current.forEach((ref, i) => {
      const r = mk('div', 'col-item');
      r.append(mk('span', null, labelOf(s.base, ref)),
        button('↑', 'tool', () => { if (i) { const l = current.slice(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; setOpts({ columns: l }); } }, 'Move up'),
        button('↓', 'tool', () => { if (i < current.length - 1) { const l = current.slice(); [l[i + 1], l[i]] = [l[i], l[i + 1]]; setOpts({ columns: l }); } }, 'Move down'),
        button('✕', 'tool', () => setOpts({ columns: current.filter((x, k) => k !== i) }), 'Remove column'));
      list.append(r);
    });
    if (!cols) list.append(mk('p', 'note', 'Showing the usual columns. Add one below to choose your own.'));
    box.append(list);
    box.append(row('Add column', select(fieldOptions(s.base, (f) => !current.includes(f.path), { hidden: true }), '', (v) => { if (v) setOpts({ columns: [...current, v] }); }, { blank: 'Choose a field…', label: 'Add column' })));
    if (cols) box.append(button('Use the usual columns', 'btn small', () => setOpts({ columns: undefined })));
    box.append(row('Rows per page', select([5, 10, 15, 20, 30, 50, 100].map((n) => [n, String(n)]), o.pageSize || 10, (v) => setOpts({ pageSize: Number(v) }), { label: 'Rows per page' })));
    el.append(box);
  }

  function sizeTab(el) {
    el.append(section('Size', mk('p', 'note', 'Or drag the bottom-right corner of the widget while "Edit layout" is on.'),
      row('Width', select(Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1} of 12 columns`]), w.w, (v) => set({ w: Number(v) }), { label: 'Width' })),
      row('Height', select(Array.from({ length: 16 }, (_, i) => [i + 1, `${i + 1} row${i ? 's' : ''}`]), w.h, (v) => set({ h: Number(v) }), { label: 'Height' }))));
  }

  drawer.hidden = false;
  app.root.classList.add('with-drawer');
  draw();
}

function section(title, ...children) {
  const s = mk('section', 'ed-section');
  s.append(mk('h3', null, title), ...children);
  return s;
}
