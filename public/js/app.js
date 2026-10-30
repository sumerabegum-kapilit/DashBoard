// The app: menu, period and project filters, and the page being shown.
import { get, qs } from './api.js';
import { loadState, read, write } from './state.js';
import { PAGES } from './pages.js';
import { mk, button, fFull, parseDay, isoDay, colorFor, labelFor } from './util.js';
import { mountBoard } from './cards.js';
import { render } from './render.js';
import { kpiTiles, healthRings } from './overview.js';
import { serverTable } from './tables.js';
import { mountBuilder } from './viewbuilder.js';
import { mountMine } from './mydashboard.js';

const RANGES = [['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['180d', '6 months', 182], ['365d', '1 year', 365], ['all', 'All time', null], ['custom', 'Custom', null]];
const DEFAULT_FILTERS = { range: '7d', project: '', from: '', to: '' };
let meta = null;
let board = null;

const filters = () => ({ ...DEFAULT_FILTERS, ...read('filters', {}) });
const addDays = (s, n) => { const d = parseDay(s); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };

function windowOf(f) {
  if (f.range === 'custom' && f.from && f.to) return f.from <= f.to ? { from: f.from, to: f.to } : { from: f.to, to: f.from };
  const r = RANGES.find((x) => x[0] === f.range);
  if (!r || r[2] == null) return { from: meta.minDate, to: meta.asOf };
  return { from: addDays(meta.asOf, -(r[2] - 1)), to: meta.asOf };
}
function currentQuery() {
  const f = filters();
  const w = windowOf(f);
  return { from: w.from, to: w.to, project: f.project || null };
}
function setFilters(patch) {
  write('filters', { ...filters(), ...patch });
  syncFilterBar();
  route();
}

// ---- filter bar ----
function buildFilterBar() {
  const seg = document.getElementById('range');
  for (const [key, label] of RANGES) {
    const b = button(label, null, () => {
      if (key === 'custom') {
        const w = windowOf(filters());
        setFilters({ range: 'custom', from: filters().from || w.from, to: filters().to || w.to });
      } else setFilters({ range: key });
    });
    b.dataset.range = key;
    seg.append(b);
  }
  const from = document.getElementById('from'), to = document.getElementById('to');
  for (const input of [from, to]) {
    input.min = meta.minDate;
    input.max = meta.asOf;
    input.addEventListener('change', () => { if (from.value && to.value) setFilters({ range: 'custom', from: from.value, to: to.value }); });
  }
  const project = document.getElementById('project');
  for (const p of meta.projects) project.append(new Option(p.name, p.id));
  project.addEventListener('change', () => setFilters({ project: project.value }));
  document.getElementById('reset').addEventListener('click', () => setFilters({ ...DEFAULT_FILTERS }));
  document.getElementById('data-note').textContent = `Live data · as of ${fFull(parseDay(meta.asOf))} · hours count entries up to ${meta.maxEntryHours} h · ${meta.timezone} time`;
  syncFilterBar();
}
function syncFilterBar() {
  const f = filters();
  for (const b of document.querySelectorAll('#range button')) b.setAttribute('aria-pressed', String(b.dataset.range === f.range));
  const custom = document.getElementById('custom-dates');
  custom.hidden = f.range !== 'custom';
  const w = windowOf(f);
  document.getElementById('from').value = w.from;
  document.getElementById('to').value = w.to;
  document.getElementById('project').value = f.project || '';
  document.getElementById('window-label').textContent = `${fFull(parseDay(w.from))} – ${fFull(parseDay(w.to))}`;
}

// ---- cards on the standard pages ----
function chips(extra, data, s, patch) {
  const off = new Set(s.off || []);
  const row = mk('div', 'chips');
  data.series.forEach((ser, i) => {
    const b = button(labelFor(data.dim, ser.label ?? ser.name), 'chip', () => {
      const next = new Set(off);
      if (next.has(ser.name)) next.delete(ser.name); else next.add(ser.name);
      if (next.size < data.series.length) patch({ off: [...next] }); // always keep one line
    });
    b.setAttribute('aria-pressed', String(!off.has(ser.name)));
    b.style.setProperty('--k', ser.color === 'critical' ? 'var(--bad)' : colorFor(data.dim, ser.name, i));
    row.append(b);
  });
  extra.append(row);
}
function shapesToggle(extra, s, patch) {
  const seg = mk('div', 'seg small');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Scale');
  for (const [val, label] of [[false, 'Actual values'], [true, 'Compare shapes']]) {
    const b = button(label, null, () => patch({ shapes: val }));
    b.setAttribute('aria-pressed', String(!!s.shapes === val));
    seg.append(b);
  }
  extra.append(seg);
}
async function drawCard(c, body, extra, s, patch, q) {
  extra.replaceChildren();
  body.classList.add('loading');
  try {
    if (c.special === 'health') return healthRings(body, await get('/api/overview?' + qs(q)));
    if (c.table) return serverTable(body, c.table, q);
    const data = await get(`/api/widget/${c.widget}?${qs(q)}`);
    const multi = data.kind === 'time' && data.series.length > 1;
    if (c.chips && multi) chips(extra, data, s, patch);
    if (c.shapes && data.mixedUnits) shapesToggle(extra, s, patch);
    render(body, data, s.v, { off: s.off, shapes: c.shapes && s.shapes, noLegend: c.chips && multi });
  } catch (e) {
    body.replaceChildren(mk('p', 'error', e.message));
  } finally {
    body.classList.remove('loading');
  }
}

// ---- pages ----
function route() {
  const id = location.hash.slice(1);
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  for (const a of document.querySelectorAll('#nav a')) a.setAttribute('aria-current', a.dataset.page === page.id ? 'page' : 'false');
  document.title = page.label + ' · ScrumBan';
  document.getElementById('top').hidden = !!page.special;
  if (board) { board.destroy(); board = null; }
  const host = document.getElementById('page');
  host.replaceChildren(mk('h1', 'page-title', page.label));
  const area = mk('div', 'page-area');
  host.append(area);
  if (page.special === 'build') return mountBuilder(area);
  if (page.special === 'mine') return mountMine(area);

  const q = currentQuery();
  if (page.kpis) {
    const k = mk('div', 'kpis');
    area.append(k);
    const prevFrom = addDays(q.from, -((parseDay(q.to) - parseDay(q.from)) / 864e5 + 1));
    get('/api/overview?' + qs(q)).then((d) => kpiTiles(k, d, prevFrom >= meta.minDate)).catch((e) => k.replaceChildren(mk('p', 'error', e.message)));
  }
  const boardHost = mk('div');
  area.append(boardHost);
  board = mountBoard(boardHost, {
    cards: page.cards,
    getLayout: () => read('cards', {})[page.id],
    setLayout: (l) => write('cards', { ...read('cards', {}), [page.id]: l }),
    renderBody: (c, body, extra, s, redraw, patch) => drawCard(c, body, extra, s, patch, q),
  });
}

async function start() {
  const nav = document.getElementById('nav');
  for (const p of PAGES) {
    const a = mk('a', null, p.label);
    a.href = '#' + p.id;
    a.dataset.page = p.id;
    nav.append(a);
  }
  try {
    await loadState();
    meta = await get('/api/meta');
  } catch (e) {
    document.getElementById('page').replaceChildren(mk('p', 'error', 'Could not reach the server or the database: ' + e.message));
    return;
  }
  buildFilterBar();
  window.addEventListener('hashchange', route);
  route();
}
start();
