// The model view: every table of a source on one canvas, with its keys and the relationships between
// tables, Power BI style. Drag a table to move it, drag from a column's dot to another column to relate
// them, click a line to change or delete it, review the relationships the studio found, and leave tables
// out of the studio (the data itself is never changed). Pan with the mouse, zoom with the wheel.
import { d3 } from '../util.js';
import { app, mk, button, select, input, check, get, post } from './core.js';
import { toast } from '../util.js';

const W = 230;        // table card width
const HEAD = 34;      // card header height
const ROW = 22;       // column row height
const MORE = 20;      // "+ n more" row height
const KEYS_ONLY_FROM = 40; // larger models start with key columns only
const CARD = { db: 'Defined by the source', auto: 'Found by the studio', manual: 'Drawn by hand' };
const CARDS = [['N:1', 'Many to one (*:1)'], ['1:N', 'One to many (1:*)'], ['1:1', 'One to one (1:1)'], ['N:M', 'Many to many (*:*)']];

let st = null; // state of the open view

export async function mountModel(host, hooks) {
  host.replaceChildren(mk('p', 'empty', 'Loading the model…'));
  let model;
  try { model = await get(`/api/s/${app.source}/model`, { fresh: true }); } catch (e) { host.replaceChildren(mk('p', 'error', e.message)); return; }
  st = {
    host, hooks, model, pos: { ...model.layout }, selected: new Set(), rel: null, focus: null, search: '',
    keysOnly: st && st.source === app.source ? st.keysOnly : model.tables.length > KEYS_ONLY_FROM,
    panel: st && st.source === app.source ? st.panel : (model.rels.some((r) => r.status === 'suggested') ? 'review' : 'about'),
    source: app.source, transform: st && st.source === app.source ? st.transform : null,
  };
  build();
}

// ---- data helpers ----
const tableOf = (name) => st.model.tables.find((t) => t.name === name);
const keyish = (c) => c.pk || c.fk || /(^|_)(id|key|code|no|prefix)$/i.test(c.col);
function shownColumns(t) {
  const linked = new Set(st.model.rels.flatMap((r) => [r.from === t.name ? r.col : null, r.to === t.name ? r.toCol : null]).filter(Boolean));
  const all = t.columns.map((c) => ({ ...c, linked: linked.has(c.col) }));
  if (!st.keysOnly) return { cols: all, more: 0 };
  const cols = all.filter((c) => c.linked || keyish(c));
  return { cols, more: all.length - cols.length };
}
const cardHeight = (t) => { const { cols, more } = shownColumns(t); return HEAD + cols.length * ROW + (more ? MORE : 0) + 4; };
const relKind = (r) => (r.status === 'suggested' ? 'suggested' : r.status === 'inactive' ? 'inactive' : r.origin);
const ends = (card) => (card === '1:1' ? ['1', '1'] : card === 'N:M' ? ['*', '*'] : ['*', '1']);

async function change(action, body, quiet) {
  try {
    const m = await post(`/api/s/${app.source}/model/${action}`, body);
    st.model = m;
    st.hooks.onChanged();
    if (!quiet) build();
    return m;
  } catch (e) { toast(e.message); return null; }
}

// ---- the page ----
function build() {
  const { model } = st;
  const page = mk('div', 'model-page');
  // header
  const bar = mk('header', 'dash-bar model-bar');
  const top = mk('div', 'dash-top');
  const title = mk('div');
  const sug = model.rels.filter((r) => r.status === 'suggested').length;
  title.append(mk('h1', 'dash-title-static', 'Model'), mk('span', 'note', `${model.tables.length} tables · ${model.rels.filter((r) => r.status !== 'suggested').length} relationships${sug ? ` · ${sug} suggested` : ''}${model.removed.length ? ` · ${model.removed.length} left out` : ''}`));
  const acts = mk('div', 'toolbar');
  acts.append(
    button('Find relationships', 'btn primary', async (e) => { e.target.disabled = true; e.target.textContent = 'Looking…'; const m = await change('detect', {}, true); if (m) { st.panel = 'review'; build(); toast(`${m.rels.filter((r) => r.status === 'suggested').length} relationships to review.`); } }),
    button('Arrange', 'btn', () => { layout(true); }),
    button('Fit', 'btn', () => fit()),
  );
  const keys = check('Key columns only', st.keysOnly, (v) => { st.keysOnly = v; build(); });
  acts.append(keys);
  top.append(title, acts);
  const row2 = mk('div', 'dash-filters');
  const search = input('search', st.search, (v) => { st.search = v.trim().toLowerCase(); highlight(); }, { placeholder: 'Find a table or column', label: 'Find a table or column', live: true });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const t = matches()[0]; if (t) centerOn(t.name); } });
  row2.append(search, legend());
  const sel = mk('span', 'model-sel');
  row2.append(sel);
  bar.append(top, row2);

  // canvas and side panel
  const body = mk('div', 'model-body');
  const wrap = mk('div', 'model-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', 'Model canvas: drag tables to move them, drag from a column dot to another column to relate them');
  const canvas = mk('div', 'model-canvas');
  const svg = d3.select(canvas).append('svg').attr('class', 'model-lines');
  const linesG = svg.append('g');
  const tempLine = svg.append('path').attr('class', 'rel-temp').style('display', 'none');
  wrap.append(canvas);
  const side = mk('aside', 'model-side');
  body.append(wrap, side);
  page.append(bar, body);
  st.host.replaceChildren(page);
  Object.assign(st, { wrap, canvas, svg, linesG, tempLine, side, sel });

  if (!model.tables.length) {
    wrap.append(mk('p', 'empty pad', 'Every table of this source is left out. Put tables back from the list on the right.'));
  }
  layout(false);
  for (const t of model.tables) canvas.append(card(t));
  drawLines();
  zoom();
  panel();
  highlight();
  selection();
}

function legend() {
  const l = mk('div', 'legend model-legend');
  for (const [k, label] of [['db', 'Defined by the source'], ['auto', 'Found, confirmed'], ['manual', 'Drawn by hand'], ['suggested', 'Suggested, to review'], ['nm', 'Many to many (not used in charts)']]) {
    const i = mk('span', 'legend-item');
    const s = d3.select(i).append('svg').attr('width', 26).attr('height', 8);
    s.append('line').attr('x1', 1).attr('x2', 25).attr('y1', 4).attr('y2', 4).attr('class', 'rel rel-' + k);
    i.append(mk('span', null, label));
    l.append(i);
  }
  return l;
}

// ---- table cards ----
function card(t) {
  const p = st.pos[t.name];
  const el = mk('div', 'mt');
  el.dataset.table = t.name;
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  el.style.width = W + 'px';
  const head = mk('div', 'mt-head');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = st.selected.has(t.name);
  box.setAttribute('aria-label', `Select ${t.label}`);
  box.addEventListener('change', () => { if (box.checked) st.selected.add(t.name); else st.selected.delete(t.name); el.classList.toggle('picked', box.checked); selection(); });
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  const name = mk('span', 'mt-name', t.label);
  name.title = `${t.name}${t.rows != null ? ` · ${Number(t.rows).toLocaleString()} rows` : ''}`;
  const x = button('✕', 'tool mt-x', () => removeTables([t.name]), `Leave ${t.label} out of the studio`);
  x.addEventListener('pointerdown', (e) => e.stopPropagation());
  head.append(box, name, mk('span', 'mt-rows', t.rows != null ? compact(t.rows) : ''), x);
  el.append(head);
  const { cols, more } = shownColumns(t);
  for (const c of cols) {
    const r = mk('div', 'mt-col' + (c.pk ? ' pk' : '') + (c.fk ? ' fk' : ''));
    r.dataset.table = t.name;
    r.dataset.col = c.col;
    const badge = mk('span', 'mt-badge', c.pk ? 'PK' : c.fk ? 'FK' : '');
    if (c.pk) badge.title = 'Primary key: values are unique';
    if (c.fk) badge.title = 'Foreign key: points at another table';
    // the stored column name is what relationships are made of; the friendly name is in the tooltip
    const label = mk('span', 'mt-colname', c.col);
    label.title = `${c.label} (${c.type === 'key' ? 'key' : c.type})`;
    const dot = mk('span', 'mt-dot');
    dot.title = 'Drag to another column to relate them';
    dot.addEventListener('pointerdown', (e) => startConnect(e, t.name, c.col));
    r.append(badge, label, mk('span', 'mt-type', c.type === 'number' ? '123' : c.type === 'date' ? 'date' : c.type === 'bool' ? 'y/n' : c.type === 'key' ? 'key' : 'abc'), dot);
    r.addEventListener('click', () => { st.panel = 'new'; st.draft = { from: t.name, col: c.col, to: '', toCol: '' }; panel(); });
    el.append(r);
  }
  if (more) {
    const m = button(`+ ${more} more column${more > 1 ? 's' : ''}`, 'mt-more', () => { st.keysOnly = false; build(); centerOn(t.name); });
    el.append(m);
  }
  if (st.selected.has(t.name)) el.classList.add('picked');
  head.addEventListener('pointerdown', (e) => dragCard(e, t.name, el));
  return el;
}
const compact = (n) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

// where a column's line attaches, in canvas coordinates
function anchor(table, col, side) {
  const t = tableOf(table);
  const p = st.pos[table];
  const { cols } = shownColumns(t);
  const i = cols.findIndex((c) => c.col === col);
  const y = i < 0 ? p.y + HEAD / 2 : p.y + HEAD + i * ROW + ROW / 2;
  return { x: side === 'right' ? p.x + W : p.x, y };
}
function geometry(r) {
  const a = st.pos[r.from], b = st.pos[r.to];
  const fromRight = a.x + W / 2 <= b.x + W / 2;
  const self = r.from === r.to;
  const p = anchor(r.from, r.col, fromRight || self ? 'right' : 'left');
  const q = anchor(r.to, r.toCol, self ? 'right' : fromRight ? 'left' : 'right');
  const bend = self ? 60 : Math.max(40, Math.abs(q.x - p.x) / 2);
  const sx = fromRight || self ? 1 : -1, ex = self ? 1 : fromRight ? -1 : 1;
  return { p, q, sx, ex, d: `M${p.x},${p.y} C${p.x + sx * bend},${p.y} ${q.x + ex * bend},${q.y} ${q.x},${q.y}` };
}
function drawLines(only) {
  const rels = st.model.rels.filter((r) => st.pos[r.from] && st.pos[r.to] && (!only || r.from === only || r.to === only));
  const sel = st.linesG.selectAll('g.relg').filter(only ? (d) => d.from === only || d.to === only : () => true);
  if (only) sel.remove(); else st.linesG.selectAll('*').remove();
  for (const r of rels) {
    const g = geometry(r);
    const grp = st.linesG.append('g').datum(r).attr('class', 'relg' + (st.rel === r.id ? ' on' : '')).attr('data-id', r.id);
    grp.append('path').attr('class', `rel rel-${relKind(r)}${r.cardinality === 'N:M' ? ' rel-nm' : ''}`).attr('d', g.d);
    const [a, b] = ends(r.cardinality);
    grp.append('text').attr('class', 'rel-end').attr('x', g.p.x + g.sx * 9).attr('y', g.p.y - 5).attr('text-anchor', 'middle').text(a);
    grp.append('text').attr('class', 'rel-end').attr('x', g.q.x + g.ex * 9).attr('y', g.q.y - 5).attr('text-anchor', 'middle').text(b);
    grp.append('path').attr('class', 'rel-hit').attr('d', g.d)
      .on('click', (ev) => { ev.stopPropagation(); st.rel = r.id; st.panel = 'rel'; panel(); markRel(); })
      .append('title').text(`${r.from}.${r.col} → ${r.to}.${r.toCol} (${r.cardinality}, ${CARD[r.origin] || r.origin}${r.status === 'suggested' ? ', suggested' : ''})`);
  }
  // the canvas is as large as what is on it
  const xs = Object.values(st.pos);
  const w = Math.max(800, ...xs.map((p) => p.x + W + 200)), h = Math.max(600, ...st.model.tables.map((t) => st.pos[t.name].y + cardHeight(t) + 200));
  st.svg.attr('width', w).attr('height', h);
}
function markRel() {
  st.linesG.selectAll('g.relg').classed('on', (d) => d.id === st.rel);
  for (const el of st.canvas.querySelectorAll('.mt-col.hot')) el.classList.remove('hot');
  const r = st.model.rels.find((x) => x.id === st.rel);
  if (r) for (const [t, c] of [[r.from, r.col], [r.to, r.toCol]]) { const el = st.canvas.querySelector(`.mt-col[data-table="${CSS.escape(t)}"][data-col="${CSS.escape(c)}"]`); if (el) el.classList.add('hot'); }
}

// ---- moving around ----
function zoom() {
  const z = d3.zoom().scaleExtent([0.1, 2.5])
    .filter((ev) => (ev.type === 'wheel' || !ev.target.closest('.mt')) && !ev.button)
    .on('zoom', (ev) => { st.transform = ev.transform; st.canvas.style.transform = `translate(${ev.transform.x}px,${ev.transform.y}px) scale(${ev.transform.k})`; });
  st.zoom = z;
  d3.select(st.wrap).call(z).on('dblclick.zoom', null);
  st.wrap.addEventListener('click', (e) => { if (!e.target.closest('.mt') && !e.target.closest('.relg') && st.rel) { st.rel = null; markRel(); if (st.panel === 'rel') { st.panel = 'about'; panel(); } } });
  if (st.transform) d3.select(st.wrap).call(z.transform, d3.zoomIdentity.translate(st.transform.x, st.transform.y).scale(st.transform.k));
  else requestAnimationFrame(() => fit());
}
function fit() {
  const ts = st.model.tables;
  if (!ts.length) return;
  const x0 = Math.min(...ts.map((t) => st.pos[t.name].x)), y0 = Math.min(...ts.map((t) => st.pos[t.name].y));
  const x1 = Math.max(...ts.map((t) => st.pos[t.name].x + W)), y1 = Math.max(...ts.map((t) => st.pos[t.name].y + cardHeight(t)));
  const w = st.wrap.clientWidth, h = st.wrap.clientHeight;
  const k = Math.max(0.1, Math.min(1.2, (w - 40) / (x1 - x0), (h - 40) / (y1 - y0)));
  d3.select(st.wrap).transition().duration(300).call(st.zoom.transform, d3.zoomIdentity.translate((w - (x1 - x0) * k) / 2 - x0 * k, (h - (y1 - y0) * k) / 2 - y0 * k).scale(k));
}
function centerOn(name) {
  const p = st.pos[name];
  if (!p) return;
  const k = Math.max(0.8, st.transform ? st.transform.k : 1);
  const w = st.wrap.clientWidth, h = st.wrap.clientHeight;
  d3.select(st.wrap).transition().duration(300).call(st.zoom.transform, d3.zoomIdentity.translate(w / 2 - (p.x + W / 2) * k, h / 3 - p.y * k).scale(k));
  const el = st.canvas.querySelector(`.mt[data-table="${CSS.escape(name)}"]`);
  if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}
const toCanvas = (ev) => {
  const r = st.wrap.getBoundingClientRect();
  const t = st.transform || d3.zoomIdentity;
  return { x: (ev.clientX - r.left - t.x) / t.k, y: (ev.clientY - r.top - t.y) / t.k };
};
let saveTimer;
function saveLayout(names) {
  clearTimeout(saveTimer);
  const positions = Object.fromEntries(names.map((n) => [n, st.pos[n]]));
  saveTimer = setTimeout(() => post(`/api/s/${app.source}/model/layout`, { positions }).catch(() => toast('The layout could not be saved.')), 400);
}
function dragCard(e, name, el) {
  if (e.button) return;
  e.preventDefault();
  const start = toCanvas(e), p0 = { ...st.pos[name] };
  // with several tables selected, the selected ones move together
  const group = st.selected.has(name) ? [...st.selected] : [name];
  const p0s = Object.fromEntries(group.map((n) => [n, { ...st.pos[n] }]));
  let moved = false;
  const move = (ev) => {
    const c = toCanvas(ev);
    const dx = c.x - start.x, dy = c.y - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    for (const n of group) {
      st.pos[n] = { x: Math.round(p0s[n].x + dx), y: Math.round(p0s[n].y + dy) };
      const card = n === name ? el : st.canvas.querySelector(`.mt[data-table="${CSS.escape(n)}"]`);
      card.style.left = st.pos[n].x + 'px';
      card.style.top = st.pos[n].y + 'px';
    }
    if (group.length === 1) drawLines(name); else drawLines();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    if (moved) { drawLines(); markRel(); saveLayout(group); } else st.pos[name] = p0;
  };
  el.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
// drag from a column's dot to another column: a new relationship
function startConnect(e, table, col) {
  e.preventDefault();
  e.stopPropagation();
  const a = anchor(table, col, 'right');
  st.tempLine.style('display', null);
  const move = (ev) => {
    const c = toCanvas(ev);
    st.tempLine.attr('d', `M${a.x},${a.y} C${a.x + 60},${a.y} ${c.x - 60},${c.y} ${c.x},${c.y}`);
    for (const el of st.canvas.querySelectorAll('.mt-col.target')) el.classList.remove('target');
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest('.mt-col');
    if (target && !(target.dataset.table === table && target.dataset.col === col)) target.classList.add('target');
  };
  const up = async (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    st.tempLine.style('display', 'none');
    for (const el of st.canvas.querySelectorAll('.mt-col.target')) el.classList.remove('target');
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest('.mt-col');
    if (!target || (target.dataset.table === table && target.dataset.col === col)) return;
    await createRel({ from: table, col, to: target.dataset.table, toCol: target.dataset.col });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
async function createRel(body) {
  const m = await change('create', body, true);
  if (!m) return;
  const r = m.rels.find((x) => x.origin === 'manual' && ((x.from === body.from && x.col === body.col && x.to === body.to) || (x.to === body.from && x.toCol === body.col && x.from === body.to)));
  st.rel = r ? r.id : null;
  st.panel = r ? 'rel' : 'about';
  build();
  if (r) toast(`Related: ${r.from}.${r.col} → ${r.to}.${r.toCol} (${r.cardinality}).${r.cardinality === 'N:M' ? ' Values repeat on both sides, so charts cannot follow it.' : ''}`);
}

// Places tables without a saved place (or all, when asked) with a force layout, related tables close.
function layout(all) {
  const ts = st.model.tables;
  const missing = ts.filter((t) => !st.pos[t.name]);
  if (!all && !missing.length) return;
  const nodes = ts.map((t) => ({ id: t.name, h: cardHeight(t), ...(all || !st.pos[t.name] ? {} : { fx: st.pos[t.name].x + W / 2, fy: st.pos[t.name].y + cardHeight(t) / 2 }) }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = st.model.rels.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to).map((r) => ({ source: r.from, target: r.to }));
  const n = nodes.length;
  nodes.forEach((d, i) => { if (d.fx == null) { const a = i * 2.4; d.x = Math.cos(a) * 40 * Math.sqrt(i + 1); d.y = Math.sin(a) * 40 * Math.sqrt(i + 1); } });
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance(W + 90).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-900))
    .force('collide', d3.forceCollide((d) => Math.max(W, d.h) / 2 + 30).strength(1))
    .force('x', d3.forceX(0).strength(n > 60 ? 0.06 : 0.03))
    .force('y', d3.forceY(0).strength(n > 60 ? 0.08 : 0.05))
    .stop();
  for (let i = 0; i < Math.min(400, 120 + n * 2); i++) sim.tick();
  for (const d of nodes) st.pos[d.id] = { x: Math.round(d.x - W / 2), y: Math.round(d.y - d.h / 2) };
  saveLayout(all ? ts.map((t) => t.name) : missing.map((t) => t.name));
  if (all) { st.transform = null; build(); }
}

// ---- finding and selecting ----
function matches() {
  if (!st.search) return [];
  return st.model.tables.filter((t) => t.name.toLowerCase().includes(st.search) || t.label.toLowerCase().includes(st.search) || t.columns.some((c) => c.col.toLowerCase().includes(st.search)));
}
function highlight() {
  const hits = new Set(matches().map((t) => t.name));
  for (const el of st.canvas.querySelectorAll('.mt')) {
    el.classList.toggle('dim', !!st.search && !hits.has(el.dataset.table));
    el.classList.toggle('hit', !!st.search && hits.has(el.dataset.table));
  }
}
function selection() {
  st.sel.replaceChildren();
  if (!st.selected.size) return;
  st.sel.append(mk('span', 'note', `${st.selected.size} selected`),
    button('Leave out of the studio', 'btn small danger', () => removeTables([...st.selected])),
    button('Clear', 'btn small', () => { st.selected.clear(); build(); }));
}
async function removeTables(names) {
  const labels = names.map((n) => (tableOf(n) || { label: n }).label);
  if (!confirm(`Leave ${names.length === 1 ? `"${labels[0]}"` : `${names.length} tables`} out of the studio?\n\nTheir relationships are removed and widgets that use them stop working. The data itself is not deleted; you can put the tables back from the list on the right.`)) return;
  for (const n of names) st.selected.delete(n);
  const m = await change('remove-tables', { tables: names });
  if (m) toast(`${names.length} table${names.length > 1 ? 's' : ''} left out.`);
}

// ---- the panel on the right ----
function panel() {
  const p = st.side;
  p.replaceChildren();
  const tabs = mk('div', 'tabs');
  const sug = st.model.rels.filter((r) => r.status === 'suggested');
  for (const [k, label] of [['review', `Review${sug.length ? ` (${sug.length})` : ''}`], ['rels', 'Relationships'], ['new', 'New'], ['about', 'Tables']]) {
    const b = button(label, 'tab', () => { st.panel = k; panel(); });
    b.setAttribute('aria-selected', String(st.panel === k || (k === 'rels' && st.panel === 'rel')));
    tabs.append(b);
  }
  p.append(tabs);
  const body = mk('div', 'side-body');
  p.append(body);
  if (st.panel === 'rel') relPanel(body);
  else if (st.panel === 'review') reviewPanel(body, sug);
  else if (st.panel === 'rels') listPanel(body);
  else if (st.panel === 'new') newPanel(body);
  else aboutPanel(body);
}
const relText = (r) => `${tableOf(r.from) ? tableOf(r.from).label : r.from}.${r.col} → ${tableOf(r.to) ? tableOf(r.to).label : r.to}.${r.toCol}`;
function relItem(r, actions) {
  const it = mk('div', 'rel-item' + (st.rel === r.id ? ' on' : ''));
  const t = mk('button', 'link rel-name', relText(r));
  t.type = 'button';
  t.addEventListener('click', () => { st.rel = r.id; st.panel = 'rel'; panel(); markRel(); centerOn(r.from); });
  it.append(t);
  const meta = mk('div', 'rel-meta');
  meta.append(mk('span', 'pill kind-' + relKind(r), r.status === 'suggested' ? 'Suggested' : CARD[r.origin] || r.origin), mk('span', 'pill', r.cardinality));
  if (r.confidence != null && r.status === 'suggested') meta.append(mk('span', 'note', `${Math.round(r.confidence * 100)}% sure`));
  if (r.status === 'inactive') meta.append(mk('span', 'note', 'switched off'));
  else if (r.status !== 'suggested' && !r.followed) meta.append(mk('span', 'note warn', r.cardinality === 'N:M' ? 'not used in charts' : 'not used: the column already leads elsewhere'));
  it.append(meta);
  if (r.reason) it.append(mk('span', 'note', r.reason));
  if (actions) it.append(actions);
  it.addEventListener('mouseenter', () => st.linesG.selectAll('g.relg').classed('hover', (d) => d.id === r.id));
  it.addEventListener('mouseleave', () => st.linesG.selectAll('g.relg').classed('hover', false));
  return it;
}
function reviewPanel(body, sug) {
  if (!sug.length) {
    body.append(mk('p', 'note', st.model.detectedAt ? 'Nothing left to review. Press "Find relationships" to look again, or drag from a column\'s dot to another column to relate them by hand.' : 'Press "Find relationships" and the studio looks for keys and relationships in the names, types and values of every table.'));
    return;
  }
  body.append(mk('p', 'note', 'Found from column names, types and values. Nothing is used until you confirm it.'));
  const high = sug.filter((r) => r.confidence >= 0.9);
  const all = mk('div', 'toolbar');
  if (high.length && high.length < sug.length) all.append(button(`Confirm the ${high.length} likely ones`, 'btn small primary', () => change('confirm', { ids: high.map((r) => r.id) })));
  all.append(button(`Confirm all ${sug.length}`, high.length && high.length < sug.length ? 'btn small' : 'btn small primary', () => change('confirm', { ids: sug.map((r) => r.id) })),
    button('Reject all', 'btn small', () => { if (confirm('Reject every suggestion? They will not be suggested again.')) change('delete', { ids: sug.map((r) => r.id) }); }));
  body.append(all);
  for (const r of sug.slice().sort((a, b) => b.confidence - a.confidence)) {
    const acts = mk('div', 'toolbar');
    acts.append(button('Confirm', 'btn small primary', () => change('confirm', { ids: [r.id] })), button('Reject', 'btn small', () => change('delete', { ids: [r.id] })));
    body.append(relItem(r, acts));
  }
}
function listPanel(body) {
  const rels = st.model.rels.filter((r) => r.status !== 'suggested');
  const f = input('search', '', (v) => { for (const el of body.querySelectorAll('.rel-item')) el.hidden = !el.textContent.toLowerCase().includes(v.toLowerCase()); }, { placeholder: 'Filter', label: 'Filter relationships', live: true });
  body.append(f);
  if (!rels.length) body.append(mk('p', 'note', 'No relationships yet.'));
  for (const kind of ['db', 'auto', 'manual']) {
    const list = rels.filter((r) => r.origin === kind);
    if (!list.length) continue;
    body.append(mk('h3', 'side-h', `${CARD[kind]} (${list.length})`));
    for (const r of list) body.append(relItem(r));
  }
  if (st.model.hidden.length) {
    body.append(mk('h3', 'side-h', `Hidden or rejected (${st.model.hidden.length})`));
    for (const h of st.model.hidden) {
      const it = mk('div', 'rel-item');
      it.append(mk('span', null, `${h.from}.${h.col} → ${h.to}.${h.toCol}`), button('Put back', 'btn small', () => change('unhide', { sigs: [h.sig] })));
      body.append(it);
    }
  }
}
function relPanel(body) {
  const r = st.model.rels.find((x) => x.id === st.rel);
  if (!r) { st.panel = 'rels'; return listPanel(body); }
  body.append(relItem(r));
  if (r.origin === 'db') {
    body.append(mk('p', 'note', 'This relationship comes from the data source itself (a foreign key), so it cannot be changed here. Hide it to stop using it.'),
      button('Hide this relationship', 'btn small danger', () => { st.rel = null; st.panel = 'rels'; change('delete', { ids: [r.id] }); }));
    return;
  }
  // the same pair of columns, whichever way round it is now written
  const pair = (x) => [x.from + '.' + x.col, x.to + '.' + x.toCol].sort().join('|');
  const edit = (patch) => change('edit', { id: r.id, ...patch }, true).then((m) => { if (m) { const nr = m.rels.find((x) => pair(x) === pair(r)); st.rel = nr ? nr.id : null; build(); } });
  body.append(mk('h3', 'side-h', 'How rows meet'),
    select(CARDS, r.cardinality, (v) => edit({ cardinality: v }), { label: 'Cardinality' }),
    mk('p', 'note', r.cardinality === 'N:M' ? 'Values repeat on both sides. Charts cannot follow a many-to-many relationship, because every row would be counted several times.' : `Each row of ${r.from} meets ${r.cardinality === '1:1' ? 'one row of' : 'at most one row of'} ${r.to}; charts on ${r.from} can use the fields of ${r.to}.`));
  const acts = mk('div', 'toolbar');
  if (r.status === 'suggested') acts.append(button('Confirm', 'btn small primary', () => change('confirm', { ids: [r.id] })));
  else acts.append(button(r.status === 'inactive' ? 'Switch on' : 'Switch off', 'btn small', () => edit({ status: r.status === 'inactive' ? 'active' : 'inactive' })));
  acts.append(button(r.status === 'suggested' ? 'Reject' : 'Delete', 'btn small danger', () => { st.rel = null; st.panel = 'rels'; change('delete', { ids: [r.id] }); }));
  body.append(acts);
}
function newPanel(body) {
  const d = st.draft || (st.draft = { from: '', col: '', to: '', toCol: '' });
  const tables = st.model.tables.map((t) => [t.name, t.label]);
  const colsOf = (t) => ((tableOf(t) || { columns: [] }).columns).map((c) => [c.col, c.label + (c.pk ? ' (PK)' : '')]);
  const redraw = () => panel();
  body.append(mk('p', 'note', 'Or drag from the dot at the end of a column to a column of another table.'),
    mk('span', 'flabel', 'From table and column'),
    select(tables, d.from, (v) => { d.from = v; d.col = ''; redraw(); }, { blank: 'Table…', label: 'From table' }),
    select(colsOf(d.from), d.col, (v) => { d.col = v; }, { blank: 'Column…', label: 'From column' }),
    mk('span', 'flabel', 'To table and column'),
    select(tables, d.to, (v) => { d.to = v; d.toCol = (tableOf(v) || {}).key || ''; redraw(); }, { blank: 'Table…', label: 'To table' }),
    select(colsOf(d.to), d.toCol, (v) => { d.toCol = v; }, { blank: 'Column…', label: 'To column' }),
    button('Relate', 'btn primary', () => {
      if (!d.from || !d.col || !d.to || !d.toCol) return toast('Choose both columns.');
      st.draft = null;
      createRel(d);
    }),
    mk('p', 'note', 'Which side is "many" is worked out from the values.'));
}
function aboutPanel(body) {
  body.append(mk('p', 'note', `${st.model.tables.length} tables. Drag a table by its name, select several with their boxes to move or leave them out together. Click a column to start a relationship from it.`));
  const tbl = mk('div', 'side-tables');
  for (const t of st.model.tables.slice().sort((a, b) => a.label.localeCompare(b.label))) {
    const r = mk('div', 'side-table');
    const b = mk('button', 'link', t.label);
    b.type = 'button';
    b.addEventListener('click', () => centerOn(t.name));
    r.append(b, mk('span', 'note', `${t.key ? 'PK ' + t.key : 'no key'}${t.rows != null ? ' · ' + compact(t.rows) : ''}`));
    tbl.append(r);
  }
  body.append(tbl);
  if (st.model.removed.length) {
    body.append(mk('h3', 'side-h', `Left out (${st.model.removed.length})`));
    const acts = mk('div', 'toolbar');
    acts.append(button('Put all back', 'btn small', () => change('restore-tables', { tables: st.model.removed.map((t) => t.name) })));
    body.append(acts);
    for (const t of st.model.removed) {
      const r = mk('div', 'side-table');
      r.append(mk('span', null, t.label), button('Put back', 'btn small', () => change('restore-tables', { tables: [t.name] })));
      body.append(r);
    }
    body.append(mk('p', 'note', 'Tables put back come without relationships; press "Find relationships" to look for them again.'));
  }
}

