// Draws one widget from its spec: asks the engine for the numbers, then draws them as the chosen view.
// Every view works for every source because the engine always answers in the same shape.
import { d3, C } from './util.js';
import { render } from './render.js';
import { showTip, hideTip } from './charts.js';
import { app, mk, button, query, records, fmt, show, keyLabel, labelOf, fieldOf, input, select } from './core.js';
import { describeCond } from './filters.js';

// chart id, label, group, what it needs
export const CHARTS = [
  ['kpi', 'Number', 'Number'], ['gauge', 'Gauge', 'Number'],
  ['bar', 'Bars', 'Compare'], ['column', 'Columns', 'Compare'], ['lollipop', 'Lollipop', 'Compare'], ['radar', 'Radar', 'Compare'], ['funnel', 'Funnel', 'Compare'],
  ['donut', 'Donut', 'Share'], ['pie', 'Pie', 'Share'], ['treemap', 'Treemap', 'Share'], ['waffle', 'Waffle', 'Share'], ['polar', 'Polar area', 'Share'],
  ['t:line', 'Line', 'Over time'], ['t:area', 'Stacked area', 'Over time'], ['t:stack', 'Stacked columns', 'Over time'], ['t:group', 'Grouped columns', 'Over time'], ['t:step', 'Step line', 'Over time'], ['t:dots', 'Dots', 'Over time'], ['t:heat', 'Heat strip', 'Over time'],
  ['matrix', 'Heatmap', 'Two groupings'], ['scatter', 'Scatter', 'Two measures'],
  ['pivot', 'Summary table', 'Tables'], ['t:table', 'Table by period', 'Tables'], ['records', 'Records', 'Tables'],
  ['text', 'Text note', 'Other'],
];
export const ICON = { kpi: '#', gauge: '◠', bar: '☰', column: '▥', lollipop: '⊸', radar: '✶', funnel: '⏷', donut: '◎', pie: '◔', treemap: '▦', waffle: '▩', polar: '❀', 't:line': '∿', 't:area': '◭', 't:stack': '▤', 't:group': '⫼', 't:step': '⌐', 't:dots': '⁘', 't:heat': '▭', matrix: '▦', scatter: '⁙', pivot: '⊞', 't:table': '⊟', records: '≣', text: '¶' };
const SHARES = ['donut', 'pie', 'treemap', 'waffle', 'polar', 't:area', 't:stack'];

// Why a chart cannot show this spec (null when it can). The editor greys out charts with a reason.
export function cannot(chart, spec) {
  const ms = spec.measures || [];
  const m0 = ms[0] || { fn: 'count' };
  const additive = m0.fn === 'count' || m0.fn === 'sum';
  if (chart === 'text' || chart === 'records' || chart === 'kpi' || chart === 'gauge') return null;
  if (chart.startsWith('t:')) return spec.time ? (SHARES.includes(chart) && !additive ? 'Stacking only adds up for counts and totals' : null) : 'Choose a date in "Over time"';
  if (chart === 'matrix') return spec.group && spec.split ? null : 'Needs a grouping and a split';
  if (chart === 'scatter') return spec.group && ms.length >= 2 ? null : 'Needs a grouping and two measures';
  if (!spec.group) return 'Choose a field in "Group by"';
  if (SHARES.includes(chart) && !additive) return 'Shares of a whole only work for counts and totals';
  return null;
}

export function ctxOf(dash) {
  return { range: dash.rangeValue || null, filters: dash.filters, compare: !!dash.compare };
}
const measureFmt = (res, i, w, short) => fmt((w.opts && w.opts.format && w.opts.format !== 'auto' && i === 0 ? w.opts.format : res.measures[i].format) || 'auto', { short });
const seriesLabel = (res, key) => (key === '__all' ? res.measures[0].label : String(key).startsWith('m:') ? res.measures[Number(key.slice(2))].label : keyLabel(key));

// What a widget shows, in words: "Number of tickets by priority, split by channel".
export function describeSpec(spec, res) {
  const m = res ? res.measures.map((x) => x.label).join(', ') : '';
  const by = [spec.group && 'by ' + labelOf(spec.base, spec.group).toLowerCase(), spec.split && 'split by ' + labelOf(spec.base, spec.split).toLowerCase(), spec.time && 'over ' + labelOf(spec.base, spec.time).toLowerCase()].filter(Boolean).join(', ');
  return [m, by].filter(Boolean).join(' ');
}

// ---- drawing ----
export async function drawWidget(w, body, foot, dash, actions) {
  body.classList.add('loading');
  foot.replaceChildren();
  try {
    if (w.chart === 'text') return drawText(body, w);
    if (w.chart === 'records') return await drawRecords(body, foot, w, dash);
    const spec = w.chart === 'kpi' && !(w.opts || {}).spark ? { ...w.spec, time: '' } : w.spec;
    const res = await query(spec, ctxOf(dash));
    body.replaceChildren();
    const notes = [];
    if (res.ignored && res.ignored.length) notes.push(`Not filtered by: ${res.ignored.join(', ')} (no link from ${app.schema.tables[w.spec.base].label.toLowerCase()})`);
    if (dash.rangeValue && !res.range) notes.push(w.spec.dateField === '-' ? 'Not limited to the period' : 'Shows all dates: this table has no date for the period');
    if (res.groupCount > (res.groups || []).length && res.groups) notes.push(`Top ${(res.groups || []).filter((g) => g.key !== '__other').length} of ${res.groupCount}`);
    for (const n of notes) foot.append(mk('span', 'note', n));
    if (!res.rows) return body.append(mk('p', 'empty', 'No rows match these filters.'));
    const why = cannot(w.chart, w.spec);
    if (why) return body.append(mk('p', 'empty', why + '. Open the editor (✎) to change it.'));
    const pick = (p, ev) => actions.pick(w, res, p, ev);
    drawResult(body, w, res, pick);
    return res;
  } catch (e) {
    body.replaceChildren(mk('p', 'error', e.message));
  } finally {
    body.classList.remove('loading');
  }
}

export function drawResult(body, w, res, pick) {
  const o = w.opts || {};
  const c = w.chart;
  if (c === 'kpi') return kpi(body, w, res);
  if (c === 'gauge') return gauge(body, w, res);
  if (c === 'pivot') return pivot(body, w, res, pick);
  if (c === 'scatter') return scatter(body, w, res, pick);
  if (c === 'matrix') return matrix(body, w, res, pick);
  if (c.startsWith('t:')) {
    if (!res.time) return body.append(mk('p', 'empty', 'No dates to draw.'));
    const f = measureFmt(res, 0, w);
    const data = { kind: 'time', grain: res.time.grain, fmt: 'auto', keys: res.time.keys, series: res.time.series.map((s) => ({ name: s.key, label: seriesLabel(res, s.key), values: s.values, color: s.key === '__other' ? 'var(--muted-fill)' : undefined, fmt: String(s.key).startsWith('m:') ? measureFmt(res, Number(s.key.slice(2)), w) : f })) };
    const view = c.slice(2);
    return render(body, data, view === 'table' ? 'table' : view, { onPick: (p) => pick({ index: p.index, series: p.series }) });
  }
  // a grouping drawn with one of the comparison or share charts
  const f = measureFmt(res, 0, w);
  const total = o.share ? d3.sum(res.groups, (g) => g.values[0] || 0) || 1 : 1;
  const val = (v) => (o.share ? (v || 0) / total : v || 0);
  const ff = o.share ? fmt('pct') : f;
  if (res.measures.length > 1 && ['bar', 'column'].includes(c) && !res.splitKeys) {
    // several measures side by side, one colour each (only when they share a unit)
    const series = res.measures.map((m, i) => ({ name: 'm' + i, label: m.label, color: C(i), fmt: measureFmt(res, i, w), values: res.groups.map((g) => g.values[i]) }));
    return render(body, { kind: 'time', grain: 'day', keys: res.groups.map((g) => g.key), series }, 'group', { tick: (k) => keyLabel(k).slice(0, 12), title: keyLabel, fmtFn: f, onPick: (p) => pick({ group: res.groups[p.index].key }) });
  }
  // colour carries identity only where it has to: one colour for a single series, a hue per slice for
  // shares (the first eight; any more are grey, never a repeated hue), a hue per split value
  const ident = (k, i) => (k === '__other' || i >= 8 ? 'var(--muted-fill)' : C(i));
  const oneSeries = !SHARES.includes(c) && c !== 'radar';
  const items = res.groups.map((g, i) => ({
    name: g.key, label: keyLabel(g.key), value: val(g.values[0]), prev: dashCompare(w, g),
    fill: g.key === '__other' ? 'var(--muted-fill)' : oneSeries ? C(0) : ident(g.key, i),
    segs: g.segs ? g.segs.map((s, k) => ({ name: s.key, label: keyLabel(s.key), value: val(s.value), fill: ident(s.key, k) })) : undefined,
  }));
  return renderCategory(body, { kind: 'category', fmt: 'auto', items }, c, ff, (d) => pick({ group: d.name }));
}
const dashCompare = (w, g) => (w.opts && w.opts.compare && g.prev != null ? g.prev : undefined);

function renderCategory(body, data, view, f, onPick) {
  render(body, data, view, { onPick, fmtFn: f });
}

// ---- headline number ----
function deltaChip(v, prev, good) {
  if (prev == null || v == null) return null;
  const chg = prev ? (v - prev) / Math.abs(prev) : null;
  const up = v > prev;
  const better = good === 'up' ? up : good === 'down' ? !up : null;
  const chip = mk('span', 'delta ' + (v === prev || better === null ? 'flat' : better ? 'good' : 'bad'));
  chip.append(mk('b', null, (v === prev ? '■ ' : up ? '▲ ' : '▼ ') + (chg == null ? 'new' : d3.format('+.0%')(chg))), mk('span', null, ' vs previous'));
  chip.title = `Previous period: ${prev}`;
  return chip;
}
function kpi(body, w, res) {
  const o = w.opts || {};
  const v = res.total[0];
  const box = mk('div', 'kpi-box');
  const f = measureFmt(res, 0, w, true);
  const num = mk('div', 'kpi-value', show(f)(v));
  num.title = show(measureFmt(res, 0, w))(v);
  box.append(num);
  // the measure's name only when the title does not already say it
  if (res.measures[0].label.toLowerCase() !== String(w.title || '').toLowerCase()) box.append(mk('div', 'kpi-sub', res.measures[0].label));
  const line = mk('div', 'kpi-line');
  const chip = res.prevTotal ? deltaChip(v, res.prevTotal[0], o.good) : null;
  if (chip) line.append(chip);
  if (o.target !== undefined && o.target !== '' && v != null) {
    const t = Number(o.target);
    const met = o.good === 'down' ? v <= t : v >= t;
    line.append(mk('span', 'kpi-target ' + (met ? 'good' : 'bad'), `${met ? '✓ On target' : '✕ Off target'} (${f(t)})`));
  }
  if (line.children.length) box.append(line);
  res.measures.slice(1).forEach((m, i) => {
    const r = mk('div', 'kpi-more');
    r.append(mk('b', null, show(measureFmt(res, i + 1, w, true))(res.total[i + 1])), mk('span', null, m.label));
    box.append(r);
  });
  body.append(box);
  if (o.spark && res.time && res.time.series[0]) spark(body, res.time.series[0].values, res.time.keys, f, res.time.grain);
}
function spark(el, values, keys, f, grain) {
  const W = Math.max(120, el.clientWidth || 200), H = 30;
  const svg = d3.select(el).append('svg').attr('class', 'spark').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'none');
  const x = d3.scaleLinear([0, Math.max(1, values.length - 1)], [2, W - 2]);
  const y = d3.scaleLinear([0, d3.max(values, (v) => v || 0) || 1], [H - 3, 3]);
  svg.append('path').attr('class', 'spark-area').attr('d', d3.area().defined((v) => v != null).x((v, i) => x(i)).y0(H).y1((v) => y(v))(values));
  svg.append('path').attr('class', 'spark-line').attr('d', d3.line().defined((v) => v != null).x((v, i) => x(i)).y((v) => y(v))(values));
  const dot = svg.append('circle').attr('r', 3).attr('class', 'spark-dot').style('opacity', 0);
  svg.append('rect').attr('width', W).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(values.length - 1, Math.round(x.invert(mx))));
      dot.attr('cx', x(i)).attr('cy', y(values[i] || 0)).style('opacity', 1);
      showTip(el, ev, `${grain === 'week' ? 'Week of ' : ''}${keys[i]}`, [{ name: '', value: values[i] }], show(f), false);
    })
    .on('pointerleave', () => { dot.style('opacity', 0); hideTip(el); });
}
function gauge(body, w, res) {
  const o = w.opts || {};
  const v = res.total[0];
  const f = measureFmt(res, 0, w, true);
  const lo = Number(o.min ?? 0), hi = Number(o.max ?? (res.measures[0].format === 'pct' ? 1 : Math.max(1, (v || 0) * 1.25)));
  const W = 240, H = 140, R = 100;
  const box = mk('div', 'gauge-box');
  body.append(box);
  const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `${res.measures[0].label}: ${show(f)(v)}`);
  const g = svg.append('g').attr('transform', `translate(${W / 2},${R + 12})`);
  const a = d3.scaleLinear([lo, hi], [-Math.PI / 2, Math.PI / 2]).clamp(true);
  const arc = d3.arc().innerRadius(R - 18).outerRadius(R).cornerRadius(4);
  g.append('path').attr('class', 'ring-bg').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: Math.PI / 2 }));
  const t = o.target !== undefined && o.target !== '' ? Number(o.target) : null;
  const met = t == null || v == null ? null : o.good === 'down' ? v <= t : v >= t;
  if (v != null) g.append('path').style('fill', met == null ? C(0) : met ? 'var(--ok)' : 'var(--bad)').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: a(v) }));
  if (t != null) {
    const ta = a(t) - Math.PI / 2;
    g.append('line').attr('class', 'gauge-target').attr('x1', Math.cos(ta) * (R - 24)).attr('y1', Math.sin(ta) * (R - 24)).attr('x2', Math.cos(ta) * (R + 6)).attr('y2', Math.sin(ta) * (R + 6));
  }
  g.append('text').attr('class', 'gauge-num').attr('text-anchor', 'middle').attr('dy', '-0.2em').text(show(f)(v));
  g.append('text').attr('class', 'tick').attr('text-anchor', 'middle').attr('x', -(R - 9)).attr('dy', '1.2em').text(f(lo));
  g.append('text').attr('class', 'tick').attr('text-anchor', 'middle').attr('x', R - 9).attr('dy', '1.2em').text(f(hi));
  box.append(mk('div', 'kpi-sub', res.measures[0].label + (t != null ? ` · target ${f(t)} ${met ? '✓' : '✕'}` : '')));
}

// ---- a heatmap of one grouping against another ----
function matrix(body, w, res, pick) {
  const f = measureFmt(res, 0, w);
  const legend = mk('div', 'legend seq');
  legend.append(mk('span', null, 'less'), mk('span', 'seq-ramp'), mk('span', null, 'more'));
  body.append(legend);
  const host = mk('div', 'fill');
  body.append(host);
  const rows = res.groups.map((g) => ({ name: g.key, label: keyLabel(g.key), values: g.segs.map((s) => s.value) }));
  render(host, { kind: 'heat', rows, cols: res.splitKeys.map(keyLabel), fmt: 'auto' }, 'heat', {
    fmtFn: f, colTitle: (c) => `${res.labels.split}: ${c}`,
    onPick: (p) => pick({ group: p.series, split: res.splitKeys[p.index] }),
  });
}

// ---- summary table: one row per group, one column per measure (and per split value) ----
function pivot(body, w, res, pick) {
  const o = w.opts || {};
  let sortCol = o._sort ?? null, dir = o._dir || 'desc';
  const head = [res.labels.group || 'Group'];
  const cols = [];
  if (res.splitKeys && res.groups[0] && res.groups[0].segs) res.splitKeys.forEach((k, j) => cols.push({ label: keyLabel(k), get: (g) => g.segs[j].value, f: measureFmt(res, 0, w) }));
  res.measures.forEach((m, i) => cols.push({ label: res.splitKeys ? (i === 0 ? 'Total: ' : '') + m.label : m.label, get: (g) => g.values[i], f: measureFmt(res, i, w) }));
  const wrap = mk('div', 'pivot');
  const draw = () => {
    const t = mk('table', 'table');
    const hr = mk('tr');
    const th0 = mk('th');
    th0.append(button(head[0], 'sort', () => { sortCol = sortCol === -1 && dir === 'asc' ? null : -1; dir = sortCol === -1 && dir === 'desc' ? 'asc' : 'desc'; draw(); }));
    hr.append(th0);
    cols.forEach((c, j) => {
      const th = mk('th');
      th.setAttribute('aria-sort', sortCol === j ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.append(button(c.label, 'sort', () => { dir = sortCol === j && dir === 'desc' ? 'asc' : 'desc'; sortCol = j; draw(); }));
      hr.append(th);
    });
    const thead = mk('thead'); thead.append(hr); t.append(thead);
    const tb = mk('tbody');
    let groups = res.groups.slice();
    if (sortCol === -1) groups.sort((a, b) => (dir === 'asc' ? 1 : -1) * String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
    else if (sortCol != null) groups.sort((a, b) => (dir === 'asc' ? 1 : -1) * ((cols[sortCol].get(a) ?? -Infinity) - (cols[sortCol].get(b) ?? -Infinity)));
    const maxes = cols.map((c) => d3.max(res.groups.filter((g) => g.key !== '__other'), (g) => Math.abs(c.get(g) || 0)) || 1);
    for (const g of groups) {
      const tr = mk('tr');
      const td0 = mk('td');
      td0.append(button(keyLabel(g.key), 'link', (ev) => pick({ group: g.key }, ev), 'Show options for ' + keyLabel(g.key)));
      tr.append(td0);
      cols.forEach((c, j) => {
        const v = c.get(g);
        const td = mk('td', null, show(c.f)(v));
        if (o.bars && v != null && g.key !== '__other') { td.className = 'bar-cell'; td.style.setProperty('--p', Math.max(0, Math.min(1, Math.abs(v) / maxes[j]))); }
        tr.append(td);
      });
      tb.append(tr);
    }
    const tot = mk('tr', 'total');
    tot.append(mk('td', null, 'All'));
    cols.forEach((c, j) => tot.append(mk('td', null, j >= cols.length - res.measures.length ? show(c.f)(res.total[j - (cols.length - res.measures.length)]) : '')));
    tb.append(tot);
    t.append(tb);
    wrap.replaceChildren(t);
  };
  draw();
  body.append(wrap);
}

// ---- scatter: each group is a dot, first measure across, second up ----
function scatter(body, w, res, pick) {
  const pts = res.groups.filter((g) => g.key !== '__other' && g.values[0] != null && g.values[1] != null);
  const fx = measureFmt(res, 0, w), fy = measureFmt(res, 1, w);
  const legend = mk('div', 'legend');
  legend.append(mk('span', null, `Across: ${res.measures[0].label} · Up: ${res.measures[1].label}${res.measures[2] ? ' · Size: ' + res.measures[2].label : ''}`));
  body.append(legend);
  const W = Math.max(260, body.clientWidth || 500);
  const H = Math.max(160, (body.clientHeight || 300) - legend.offsetHeight - 10);
  const m = { l: 52, r: 16, t: 10, b: 28 };
  const svg = d3.select(body).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`);
  const x = d3.scaleLinear(d3.extent(pts, (p) => p.values[0]), [m.l, W - m.r]).nice();
  const y = d3.scaleLinear(d3.extent(pts, (p) => p.values[1]), [H - m.b, m.t]).nice();
  const r = res.measures[2] ? d3.scaleSqrt([0, d3.max(pts, (p) => p.values[2] || 0) || 1], [4, 16]) : () => 6;
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('class', 'gridline').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y);
  svg.append('g').attr('class', 'tick').selectAll('text').data(y.ticks(4)).join('text').attr('x', m.l - 6).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text(fy);
  svg.append('g').attr('class', 'tick').selectAll('text').data(x.ticks(5)).join('text').attr('x', x).attr('y', H - 8).attr('text-anchor', 'middle').text(fx);
  svg.append('g').selectAll('circle').data(pts).join('circle').attr('cx', (p) => x(p.values[0])).attr('cy', (p) => y(p.values[1])).attr('r', (p) => r(p.values[2] || 0))
    .attr('class', 'dot').style('fill', C(0)).style('cursor', 'pointer')
    .on('pointerenter pointermove', (ev, p) => showTip(body, ev, keyLabel(p.key), res.measures.slice(0, 3).map((mm, i) => ({ name: mm.label, label: mm.label, value: p.values[i], fmt: show(measureFmt(res, i, w)) })), fx, false))
    .on('pointerleave', () => hideTip(body)).on('click', (ev, p) => pick({ group: p.key }, ev));
  // name the outermost dots so the chart reads without hovering
  const far = pts.slice().sort((a, b) => b.values[1] - a.values[1]).slice(0, 2).concat(pts.slice().sort((a, b) => a.values[1] - b.values[1]).slice(0, 2));
  svg.append('g').selectAll('text').data([...new Set(far)]).join('text').attr('class', 'val').attr('x', (p) => x(p.values[0]) + r(p.values[2] || 0) + 4).attr('y', (p) => y(p.values[1])).attr('dy', '0.32em')
    .attr('text-anchor', (p) => (x(p.values[0]) > W * 0.75 ? 'end' : 'start')).attr('dx', (p) => (x(p.values[0]) > W * 0.75 ? -2 * (r(p.values[2] || 0) + 4) : 0)).text((p) => keyLabel(p.key).slice(0, 22));
}

// ---- text ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function drawText(body, w) {
  const text = (w.opts && w.opts.text) || 'Write a note in the editor.';
  const box = mk('div', 'text-note');
  // a little formatting: **bold**, "- " lists, blank lines between paragraphs
  box.innerHTML = text.split(/\n{2,}/).map((p) => (p.split('\n').every((l) => /^\s*[-*] /.test(l))
    ? '<ul>' + p.split('\n').map((l) => '<li>' + esc(l.replace(/^\s*[-*] /, '')) + '</li>').join('') + '</ul>'
    : '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  body.replaceChildren(box);
}

// ---- the rows themselves, with sorting, search, paging and download ----
export const recordState = new Map();
async function drawRecords(body, foot, w, dash) {
  const o = w.opts || {};
  const st = recordState.get(w.id) || { page: 1, sort: null, dir: 'desc', search: '' };
  recordState.set(w.id, st);
  const size = Number(o.pageSize) || 10;
  const data = await records({ spec: w.spec, ctx: ctxOf(dash), page: st.page, size, columns: o.columns, sort: st.sort, dir: st.dir, search: st.search });
  if (!body.isConnected) return;
  body.replaceChildren();
  const tools = mk('div', 'rec-tools');
  const s = input('search', st.search, (v) => { st.search = v.trim(); st.page = 1; drawRecords(body, foot, w, dash); }, { placeholder: 'Search these rows', label: 'Search' });
  tools.append(s);
  body.append(tools);
  const scroll = mk('div', 'scroll fill');
  const t = mk('table', 'table rec');
  const hr = mk('tr');
  for (const c of data.columns) {
    const th = mk('th');
    th.setAttribute('aria-sort', data.sort === c.ref ? (data.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.append(button(c.label, 'sort', () => { st.dir = data.sort === c.ref && data.dir === 'desc' ? 'asc' : 'desc'; st.sort = c.ref; st.page = 1; drawRecords(body, foot, w, dash); }));
    if (c.type === 'number') th.classList.add('num');
    hr.append(th);
  }
  const thead = mk('thead'); thead.append(hr); t.append(thead);
  const tb = mk('tbody');
  for (const r of data.rows) {
    const tr = mk('tr');
    data.columns.forEach((c, i) => tr.append(cell(r[i], c)));
    tb.append(tr);
  }
  if (!data.rows.length) { const tr = mk('tr'); const td = mk('td', 'empty', 'No rows match.'); td.colSpan = data.columns.length; tr.append(td); tb.append(tr); }
  t.append(tb);
  scroll.append(t);
  body.append(scroll);
  const last = Math.max(1, Math.ceil(data.total / size));
  const prev = button('‹', 'btn small', () => { st.page--; drawRecords(body, foot, w, dash); }, 'Previous page');
  prev.disabled = st.page <= 1;
  const next = button('›', 'btn small', () => { st.page++; drawRecords(body, foot, w, dash); }, 'Next page');
  next.disabled = st.page >= last;
  foot.replaceChildren(prev, mk('span', 'note', `${data.total ? (st.page - 1) * size + 1 : 0}–${Math.min(data.total, st.page * size)} of ${data.total.toLocaleString()}`), next);
}
export function cell(v, c) {
  const td = mk('td');
  if (v == null) { td.textContent = '—'; td.className = 'muted'; return td; }
  if (c.type === 'bool') { td.append(mk('span', 'pill ' + (v ? 'yes' : 'no'), v ? 'Yes' : 'No')); return td; }
  if (c.type === 'number') { td.className = 'num'; td.textContent = fmt(c.format || 'auto')(Number(v)); return td; }
  td.textContent = String(v);
  return td;
}

// ---- downloading what a widget shows ----
export async function widgetCsv(w, dash) {
  let head, rows;
  if (w.chart === 'records') {
    const data = await records({ spec: w.spec, ctx: ctxOf(dash), page: 1, size: 500, columns: (w.opts || {}).columns });
    head = data.columns.map((c) => c.label);
    rows = data.rows;
  } else {
    const res = await query(w.spec, ctxOf(dash));
    if (res.groups) {
      head = [res.labels.group, ...(res.splitKeys && res.groups[0].segs ? res.splitKeys.map(keyLabel) : []), ...res.measures.map((m) => m.label)];
      rows = res.groups.map((g) => [keyLabel(g.key), ...(g.segs ? g.segs.map((s) => s.value) : []), ...g.values]);
    } else if (res.time) {
      head = ['Period', ...res.time.series.map((s) => seriesLabel(res, s.key))];
      rows = res.time.keys.map((k, i) => [k, ...res.time.series.map((s) => s.values[i])]);
    } else {
      head = res.measures.map((m) => m.label);
      rows = [res.total];
    }
  }
  const csv = [head, ...rows].map((r) => r.map((c) => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = (w.title || 'widget').replace(/[^\w -]+/g, '') + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export { describeCond, fieldOf, select };
