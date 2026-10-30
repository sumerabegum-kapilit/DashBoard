// The studio: pick a data source, keep several dashboards for it, filter them, and add, change,
// move, resize or remove any widget. Dashboards are saved per browser (server/store.js).
import { loadState, read, write } from '../state.js';
import { app, mk, button, select, input, get, post, loadSchema, records, keyLabel, labelOf, uid, clone, clearResults } from './core.js';
import { mountGrid } from './grid.js';
import { drawWidget, CHARTS, ICON, cannot, describeSpec, ctxOf, widgetCsv, cell, recordState } from './widget.js';
import { openEditor } from './editor.js';
import { filterChips } from './filters.js';
import { mountData } from './data.js';
import { mountModel } from './model.js';
import { toast } from '../util.js';

const RANGES = [['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['365d', '12 months', 365], ['ytd', 'This year'], ['all', 'All time'], ['custom', 'Custom']];
let grid = null;
let pointer = { x: 0, y: 0 };
document.addEventListener('pointerdown', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);

// ---- saved dashboards ----
const studio = () => read('studio', { sources: {} });
const saveStudio = (s) => write('studio', s);
const bySource = () => studio().sources[app.source] || { dashboards: [], current: null };
function saveSource(patch) {
  const s = studio();
  s.sources = { ...s.sources, [app.source]: { ...bySource(), ...patch } };
  saveStudio(s);
}
const dashboards = () => bySource().dashboards;
const current = () => dashboards().find((d) => d.id === bySource().current) || dashboards()[0];
function saveDash(d) {
  saveSource({ dashboards: dashboards().map((x) => (x.id === d.id ? d : x)), current: d.id });
}
const withIds = (d) => ({ id: uid('d'), title: d.title || 'Dashboard', range: d.range || { preset: '90d' }, compare: !!d.compare, filters: d.filters || [], widgets: (d.widgets || []).map((w) => ({ ...w, id: uid() })) });

function rangeValue(r) {
  const asOf = app.schema.asOf;
  const back = (n) => { const d = new Date(asOf + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (n - 1)); return d.toISOString().slice(0, 10); };
  if (!r || r.preset === 'all') return null;
  if (r.preset === 'custom') return r.from && r.to ? (r.from <= r.to ? { from: r.from, to: r.to } : { from: r.to, to: r.from }) : null;
  if (r.preset === 'ytd') return { from: asOf.slice(0, 4) + '-01-01', to: asOf };
  const p = RANGES.find((x) => x[0] === r.preset);
  return p && p[2] ? { from: back(p[2]), to: asOf } : null;
}

// ---- routing: #/<source>/<dashboard id or "data"> ----
async function route() {
  const [, src, page] = location.hash.split('/');
  const sourceId = app.sources.some((s) => s.id === src && !s.broken) ? src : (app.sources.find((s) => !s.broken) || {}).id;
  if (!sourceId) return document.getElementById('main').replaceChildren(mk('p', 'error', 'No data source could be opened.'));
  if (app.source !== sourceId || !app.schema) {
    // take the old board down first, so its widgets do not finish loading against the new source
    if (grid) { grid.destroy(); grid = null; }
    document.getElementById('main').replaceChildren(mk('p', 'empty', 'Loading…'));
    app.source = null;
    try { await loadSchema(sourceId); } catch (e) { return document.getElementById('main').replaceChildren(mk('p', 'error', e.message)); }
    if (!dashboards().length) {
      const starters = await get(`/api/s/${sourceId}/starters`, { fresh: true });
      const list = starters.map(withIds);
      saveSource({ dashboards: list, current: list[0].id });
    }
  }
  document.getElementById('source').value = app.source;
  if (page === 'model') { sidebar('model'); return mountModel(document.getElementById('main'), { onChanged: () => loadSchema(app.source).catch(() => {}) }); }
  if (page === 'data') { sidebar('data'); return mountData(document.getElementById('main'), { onChanged: () => clearResults(), refreshSources, openSource: (id, page = '') => { app.schema = null; location.hash = `#/${id}/${page}`; } }); }
  if (page && dashboards().some((d) => d.id === page)) saveSource({ current: page });
  sidebar(current().id);
  drawDashboard();
}
const go = (page) => {
  const h = `#/${app.source}/${page}`;
  if (location.hash === h) route(); else location.hash = h;
};

// ---- left side: sources and dashboards ----
function sidebar(active) {
  const nav = document.getElementById('dash-list');
  nav.replaceChildren();
  for (const d of dashboards()) {
    const a = mk('a', null, d.title || 'Untitled');
    a.href = `#/${app.source}/${d.id}`;
    if (d.id === active) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  for (const [id, page] of [['data-link', 'data'], ['model-link', 'model']]) {
    const a = document.getElementById(id);
    a.href = `#/${app.source}/${page}`;
    a.setAttribute('aria-current', active === page ? 'page' : 'false');
  }
  const meta = app.sources.find((s) => s.id === app.source);
  document.getElementById('source-note').textContent = meta ? `${meta.description} Data as of ${app.schema.asOf}.` : '';
}

// ---- the dashboard ----
function drawDashboard() {
  const d = current();
  d.rangeValue = rangeValue(d.range);
  document.title = `${d.title} · Studio`;
  const main = document.getElementById('main');
  if (grid) { grid.destroy(); grid = null; }
  main.replaceChildren(toolbar(d));
  const area = mk('div', 'board-area');
  main.append(area);
  if (!d.widgets.length) {
    const empty = mk('section', 'empty-board');
    empty.append(mk('h2', null, 'This dashboard is empty'), mk('p', 'note', 'Add a widget and pick what it shows, or let the studio build a dashboard from the data.'),
      button('+ Add widget', 'btn primary', () => addWidget(d)), button('Build one for me', 'btn', () => autoBuild()));
    area.append(empty);
    return;
  }
  grid = mountGrid(area, {
    widgets: d.widgets,
    editing: app.editing,
    mountWidget: (w, el) => widgetCard(w, el, d),
    // Each change starts from the dashboard as saved now, not as it was when the board was drawn:
    // resizing does not redraw the board, so that copy would undo every earlier resize.
    onMove: (id, to) => {
      const now = current();
      const list = now.widgets.filter((x) => x.id !== id);
      list.splice(to, 0, now.widgets.find((x) => x.id === id));
      saveDash({ ...now, widgets: list });
      drawDashboard();
    },
    onResize: (id, w, h) => {
      const now = current();
      saveDash({ ...now, widgets: now.widgets.map((x) => (x.id === id ? { ...x, w, h } : x)) });
    },
  });
}

function toolbar(d) {
  const bar = mk('header', 'dash-bar');
  const top = mk('div', 'dash-top');
  const title = input('text', d.title, (v) => { saveDash({ ...current(), title: v.trim() || 'Untitled' }); sidebar(d.id); document.title = `${v} · Studio`; }, { label: 'Dashboard name' });
  title.className = 'dash-title';
  const acts = mk('div', 'toolbar');
  const edit = button(app.editing ? '✓ Done editing' : '✥ Edit layout', app.editing ? 'btn primary' : 'btn', () => { app.editing = !app.editing; drawDashboard(); });
  edit.setAttribute('aria-pressed', String(app.editing));
  acts.append(button('+ Add widget', 'btn primary', () => addWidget(current())), edit, menu([
    ['New empty dashboard', () => { const nd = withIds({ title: 'New dashboard' }); saveSource({ dashboards: [...dashboards(), nd], current: nd.id }); go(nd.id); }],
    ['Build a dashboard from the data…', () => autoBuild()],
    ['Duplicate this dashboard', () => { const nd = { ...withIds(clone(current())), title: current().title + ' (copy)' }; saveSource({ dashboards: [...dashboards(), nd], current: nd.id }); go(nd.id); }],
    ['Download as file (JSON)', () => download(current())],
    ['Open a dashboard file…', () => importFile()],
    ['Restore the starting dashboards', async () => {
      if (!confirm('Put back the starting dashboards for this source? Your other dashboards stay.')) return;
      const list = (await get(`/api/s/${app.source}/starters`, { fresh: true })).map(withIds);
      saveSource({ dashboards: [...dashboards(), ...list], current: list[0].id });
      go(list[0].id);
    }],
    ['Delete this dashboard', () => {
      if (!confirm(`Delete "${current().title}"? This cannot be undone.`)) return;
      const rest = dashboards().filter((x) => x.id !== current().id);
      saveSource({ dashboards: rest, current: rest[0] ? rest[0].id : null });
      if (!rest.length) { saveSource({ dashboards: [withIds({ title: 'New dashboard' })] }); }
      go(current().id);
    }],
  ], '⋯', 'More dashboard actions'));
  top.append(title, acts);

  const filters = mk('div', 'dash-filters');
  const seg = mk('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Period');
  for (const [k, label] of RANGES) {
    const b = button(label, null, () => {
      const r = k === 'custom' ? { preset: 'custom', ...(rangeValue(d.range) || { from: app.schema.asOf.slice(0, 4) + '-01-01', to: app.schema.asOf }) } : { preset: k };
      saveDash({ ...current(), range: r });
      drawDashboard();
    });
    b.setAttribute('aria-pressed', String(d.range.preset === k));
    seg.append(b);
  }
  filters.append(seg);
  if (d.range.preset === 'custom') {
    const span = mk('span', 'between');
    const setR = (patch) => { saveDash({ ...current(), range: { ...current().range, ...patch } }); drawDashboard(); };
    span.append(input('date', d.range.from, (v) => setR({ from: v }), { label: 'From' }), mk('span', 'note', 'to'), input('date', d.range.to, (v) => setR({ to: v }), { label: 'To' }));
    filters.append(span);
  }
  const cmp = button('Compare with previous period', 'btn small toggle', () => { saveDash({ ...current(), compare: !current().compare }); drawDashboard(); });
  cmp.setAttribute('aria-pressed', String(!!d.compare));
  cmp.disabled = !d.rangeValue;
  filters.append(cmp);
  const chips = mk('div', 'chips');
  filterChips(chips, d, (list) => { saveDash({ ...current(), filters: list }); drawDashboard(); });
  filters.append(chips);
  const shown = mk('span', 'note period-note', d.rangeValue ? `${d.rangeValue.from} → ${d.rangeValue.to}` : 'All dates');
  filters.append(shown);
  bar.append(top, filters);
  return bar;
}

function menu(items, label, aria) {
  const wrap = mk('div', 'menu');
  const b = button(label, 'btn', () => { list.hidden = !list.hidden; if (!list.hidden) list.querySelector('button').focus(); }, aria);
  b.setAttribute('aria-haspopup', 'true');
  const list = mk('div', 'menu-list');
  list.hidden = true;
  for (const [text, fn] of items) list.append(button(text, 'menu-item', () => { list.hidden = true; fn(); }));
  wrap.append(b, list);
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) list.hidden = true; });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { list.hidden = true; b.focus(); } });
  return wrap;
}

// ---- one widget on the board ----
function widgetCard(w, el, d) {
  const head = mk('header', 'w-head');
  const titles = mk('div', 'w-titles');
  const h = mk('h3', null, w.title || 'Untitled');
  // the subtitle line is kept from the start, so filling it in later does not shrink the chart
  const sub = mk('span', 'w-sub', ' ');
  titles.append(h, sub);
  const tools = mk('div', 'w-tools');
  if (!['text', 'records'].includes(w.chart)) {
    const fit = CHARTS.filter(([id]) => !['text', 'records'].includes(id) && !cannot(id, w.spec));
    tools.append(select(fit.map(([id, label]) => [id, `${ICON[id]}  ${label}`]), w.chart, (v) => updateWidget({ ...w, chart: v }), { label: 'Chart type' }));
  }
  tools.append(button('✎', 'tool', () => editWidget(w), 'Edit widget'), button('⤢', 'tool', () => expand(w, d), 'Show large'),
    menu([
      ['Duplicate', () => {
        const now = current();
        const at = now.widgets.findIndex((x) => x.id === w.id);
        const list = now.widgets.slice();
        list.splice(at + 1, 0, { ...clone(now.widgets[at] || w), id: uid(), title: w.title + ' (copy)' });
        saveDash({ ...now, widgets: list });
        drawDashboard();
      }],
      ['Download data (CSV)', () => widgetCsv(w, current()).catch((e) => toast(e.message))],
      ['Remove from dashboard', () => { const now = current(); saveDash({ ...now, widgets: now.widgets.filter((x) => x.id !== w.id) }); drawDashboard(); toast(`Removed "${w.title}".`); }],
    ], '⋯', 'More widget actions'));
  head.append(titles, tools);
  const body = mk('div', 'w-body fit');
  const foot = mk('footer', 'w-foot');
  el.classList.add('chart-' + w.chart.replace(':', '-'));
  el.append(head, body, foot);
  const redraw = () => (el.isConnected || !body.childNodes.length) && drawWidget(w, body, foot, current(), { pick: pickMenu }).then((res) => {
    if (!el.isConnected) return;
    sub.textContent = res && res.measures ? describeSpec(w.spec, res) : w.chart === 'records' ? `${app.schema.tables[w.spec.base].label}${w.spec.filters && w.spec.filters.length ? ' · filtered' : ''}` : ''; });
  redraw();
  return { redraw };
}

function updateWidget(w) {
  const d = current();
  saveDash({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? w : x)) });
  drawDashboard();
}
function redrawOne(w) {
  const d = current();
  d.widgets = d.widgets.map((x) => (x.id === w.id ? w : x));
  d.rangeValue = rangeValue(d.range);
  const card = grid && grid.cards.get(w.id);
  if (!card) return drawDashboard();
  const el = card.el;
  el.style.gridColumn = `span ${w.w}`;
  el.style.gridRow = `span ${w.h}`;
  el.replaceChildren();
  el.className = 'widget editing-now';
  card.api = widgetCard(w, el, d);
}
function editWidget(w) {
  openEditor(w, {
    onLive: (nw) => redrawOne(nw),
    onDone: (nw) => { updateWidget(nw); },
    onCancel: (old) => { updateWidget(old); },
  });
}
function addWidget(d) {
  const S = app.schema;
  const base = (d.widgets.find((w) => w.spec && S.tables[w.spec.base]) || {}).spec?.base || Object.keys(S.tables)[0];
  const T = S.tables[base];
  const first = T.fields.find((f) => f.type === 'text' && !f.hidden && f.col !== T.display);
  const w = { id: uid(), title: `${T.label}${first ? ' by ' + first.label.toLowerCase() : ''}`, w: 6, h: 4, chart: first ? 'bar' : 'kpi', spec: { base, measures: [{ fn: 'count' }], group: first ? first.col : '', filters: [] }, opts: {} };
  saveDash({ ...d, widgets: [w, ...d.widgets] });
  drawDashboard();
  editWidget(w);
}

// ---- clicking a value: see its rows, or filter the whole dashboard by it ----
function pickMenu(w, res, p) {
  const spec = res.spec;
  const shownGroups = (res.groups || []).map((g) => g.key).filter((k) => k !== '__other');
  const sel = {};
  const items = [];
  const filterBy = (ref, key, label) => {
    if (!ref || key === '__other' || key === undefined) return;
    items.push([`Only ${label}: ${keyLabel(key)}`, () => addFilter(spec.base, ref, 'in', [key])]);
    items.push([`Leave out ${keyLabel(key)}`, () => addFilter(spec.base, ref, 'notin', [key])]);
  };
  let title = '';
  if (p.group !== undefined) { sel.group = p.group; sel.groupShown = shownGroups; title = keyLabel(p.group); }
  if (p.split !== undefined) { sel.split = p.split; sel.splitShown = (res.splitKeys || []).filter((k) => k !== '__other'); title += ' · ' + keyLabel(p.split); }
  if (p.index !== undefined && res.time) { sel.bucket = res.time.keys[p.index]; sel.grain = res.time.grain; title = (res.time.grain === 'week' ? 'Week of ' : '') + sel.bucket; }
  if (p.series !== undefined && res.time) {
    const s = String(p.series);
    if (s.startsWith('m:')) sel.measure = Number(s.slice(2));
    else if (s !== '__all') { sel.series = s; sel.seriesShown = (spec.split ? res.splitKeys || [] : shownGroups).filter((k) => k !== '__other'); title += ' · ' + keyLabel(s); }
  }
  items.unshift([`See the rows`, () => openRecords(w, spec, sel, title)]);
  filterBy(spec.group, p.group, labelOf(spec.base, spec.group));
  filterBy(spec.split, p.split, labelOf(spec.base, spec.split));
  if (sel.series) filterBy(spec.split || spec.group, sel.series, labelOf(spec.base, spec.split || spec.group));
  popover(title, items);
}
function addFilter(table, field, op, value) {
  const d = current();
  saveDash({ ...d, filters: [...d.filters, { table, field, op, value }] });
  drawDashboard();
  toast('Filter added to the whole dashboard. Remove it with ✕ on the filter.');
}
function popover(title, items) {
  const pop = document.getElementById('pop');
  pop.replaceChildren(mk('div', 'pop-title', title));
  for (const [text, fn] of items) pop.append(button(text, 'menu-item', () => { pop.hidden = true; fn(); }));
  pop.hidden = false;
  const x = Math.min(pointer.x + 8, window.innerWidth - pop.offsetWidth - 12);
  const y = Math.min(pointer.y + 8, window.innerHeight - pop.offsetHeight - 12);
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  pop.querySelector('button').focus();
}
document.addEventListener('pointerdown', (e) => { const pop = document.getElementById('pop'); if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('pop').hidden = true; });

async function openRecords(w, spec, sel, title) {
  const dlg = document.getElementById('modal');
  let page = 1;
  const columns = w.chart === 'records' ? (w.opts || {}).columns : undefined;
  const draw = async () => {
    const box = mk('div', 'dlg-body wide');
    const head = mk('div', 'dlg-head');
    head.append(mk('h3', null, `${w.title}${title ? ' · ' + title : ''}`), button('✕', 'tool', () => dlg.close(), 'Close'));
    box.append(head, mk('p', 'note', 'Loading…'));
    dlg.replaceChildren(box);
    if (!dlg.open) dlg.showModal();
    try {
      const data = await records({ spec, ctx: ctxOf(current()), sel, page, size: 15, columns });
      const scroll = mk('div', 'scroll dlg-scroll');
      const t = mk('table', 'table rec');
      const hr = mk('tr');
      for (const c of data.columns) hr.append(mk('th', c.type === 'number' ? 'num' : null, c.label));
      const th = mk('thead'); th.append(hr); t.append(th);
      const tb = mk('tbody');
      for (const r of data.rows) { const tr = mk('tr'); data.columns.forEach((c, i) => tr.append(cell(r[i], c))); tb.append(tr); }
      t.append(tb);
      scroll.append(t);
      const last = Math.max(1, Math.ceil(data.total / 15));
      const pager = mk('div', 'toolbar');
      const prev = button('‹ Previous', 'btn small', () => { page--; draw(); });
      prev.disabled = page <= 1;
      const next = button('Next ›', 'btn small', () => { page++; draw(); });
      next.disabled = page >= last;
      pager.append(prev, next, mk('span', 'note', `${data.total.toLocaleString()} rows · page ${page} of ${last}`));
      box.replaceChildren(head, scroll, pager);
    } catch (e) { box.append(mk('p', 'error', e.message)); }
  };
  draw();
}

function expand(w, d) {
  const dlg = document.getElementById('modal');
  const box = mk('div', 'dlg-body wide');
  const head = mk('div', 'dlg-head');
  head.append(mk('h3', null, w.title), button('✕', 'tool', () => dlg.close(), 'Close'));
  const body = mk('div', 'w-body fit big');
  const foot = mk('div', 'w-foot');
  box.append(head, body, foot);
  dlg.replaceChildren(box);
  dlg.showModal();
  recordState.delete(w.id);
  requestAnimationFrame(() => drawWidget(w, body, foot, current(), { pick: (ww, res, p) => { dlg.close(); pickMenu(ww, res, p); } }));
}

async function autoBuild() {
  const dlg = document.getElementById('modal');
  const box = mk('div', 'dlg-body');
  let table = '';
  box.append(mk('h3', null, 'Build a dashboard from the data'),
    mk('p', 'note', 'The studio looks at the table and the tables it links to, and adds headline numbers, a trend, a chart for every field worth grouping by, and the rows. Change anything afterwards.'),
    mk('span', 'flabel', 'Main table'), select([['', 'Choose for me'], ...Object.entries(app.schema.tables).map(([k, t]) => [k, `${t.label} (${(t.rows ?? 0).toLocaleString()} rows)`])], '', (v) => { table = v; }, { label: 'Main table' }));
  const acts = mk('div', 'toolbar end');
  acts.append(button('Cancel', 'btn', () => dlg.close()), button('Build it', 'btn primary', async () => {
    acts.replaceChildren(mk('span', 'note', 'Looking at the data…'));
    try {
      const made = withIds(await post(`/api/s/${app.source}/autodash`, { table: table || undefined }));
      made.range = { preset: 'all' };
      saveSource({ dashboards: [...dashboards(), made], current: made.id });
      dlg.close();
      go(made.id);
    } catch (e) { acts.replaceChildren(mk('span', 'error', e.message)); }
  }));
  box.append(acts);
  dlg.replaceChildren(box);
  dlg.showModal();
}

function download(d) {
  const { rangeValue: _, ...rest } = d;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ studio: 1, source: app.source, dashboard: rest }, null, 1)], { type: 'application/json' }));
  a.download = (d.title || 'dashboard').replace(/[^\w -]+/g, '') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importFile() {
  const f = document.createElement('input');
  f.type = 'file';
  f.accept = '.json,application/json';
  f.addEventListener('change', async () => {
    try {
      const body = JSON.parse(await f.files[0].text());
      const dash = body.dashboard || body;
      if (!Array.isArray(dash.widgets)) throw new Error('That file is not a dashboard.');
      if (body.source && body.source !== app.source) toast(`This dashboard was made for "${body.source}"; widgets on tables that do not exist here will show an error.`);
      const nd = withIds(dash);
      saveSource({ dashboards: [...dashboards(), nd], current: nd.id });
      go(nd.id);
    } catch (e) { toast('Could not open the file: ' + e.message); }
  });
  f.click();
}

// ---- start ----
async function start() {
  await loadState();
  const theme = read('studio', {}).theme;
  if (theme) document.documentElement.dataset.theme = theme;
  document.getElementById('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    saveStudio({ ...studio(), theme: document.documentElement.dataset.theme });
    if (location.hash.split('/')[2] !== 'data') drawDashboard();
  });
  try { app.sources = await get('/api/sources', { fresh: true }); } catch (e) { document.getElementById('main').replaceChildren(mk('p', 'error', 'Could not reach the server: ' + e.message)); return; }
  const sel = document.getElementById('source');
  for (const s of app.sources) { const o = new Option(s.label + (s.broken ? ' (unavailable)' : ''), s.id); o.disabled = !!s.broken; sel.append(o); }
  sel.addEventListener('change', () => { app.schema = null; location.hash = `#/${sel.value}/`; });
  document.getElementById('add-source').addEventListener('click', () => { location.hash = `#/${app.source}/data`; setTimeout(() => document.getElementById('add-data')?.scrollIntoView({ behavior: 'smooth' }), 300); });
  window.addEventListener('hashchange', route);
  route();
}
const refreshSources = async () => {
  app.sources = await get('/api/sources', { fresh: true });
  const sel = document.getElementById('source');
  sel.replaceChildren(...app.sources.map((s) => new Option(s.label + (s.broken ? ' (unavailable)' : ''), s.id)));
  sel.value = app.source;
};
start();
