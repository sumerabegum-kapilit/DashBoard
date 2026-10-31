// Chart drawing with d3. Every chart draws into a box, sizes itself from the box width,
// and shows a tooltip on hover. Text never takes series colours; colours come from util.js.
import { d3, mk, fInt, fPct, fCompact, C, MUTED } from './util.js';

export function emptyNote(el, text = 'Nothing to show for this period.') {
  el.replaceChildren(mk('p', 'empty', text));
}

function legend(el, items, shape) {
  const l = mk('div', 'legend');
  for (const s of items) {
    const i = mk('span', 'legend-item');
    const k = mk('span', shape === 'line' ? 'key key-line' : 'key');
    k.style.background = s.color;
    i.append(k, mk('span', null, s.label ?? s.name));
    l.append(i);
  }
  el.append(l);
}

export function showTip(el, ev, title, rows, fmt, keyed) {
  let t = el.querySelector(':scope > .tip');
  if (!t) { t = mk('div', 'tip'); el.append(t); }
  t.replaceChildren(mk('div', 'tip-title', title));
  for (const r of rows) {
    const line = mk('div', 'tip-row');
    if (keyed && r.color) { const k = mk('span', 'key key-line'); k.style.background = r.color; line.append(k); }
    line.append(mk('b', null, r.value == null ? '—' : (r.fmt || fmt)(r.value)), mk('span', null, r.label ?? r.name ?? ''));
    t.append(line);
  }
  t.hidden = false;
  const b = el.getBoundingClientRect();
  let x = ev.clientX - b.left + 14, y = ev.clientY - b.top + 14;
  if (x + t.offsetWidth > b.width) x = Math.max(0, ev.clientX - b.left - t.offsetWidth - 14);
  if (y + t.offsetHeight > b.height) y = Math.max(0, b.height - t.offsetHeight);
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
export function hideTip(el) {
  const t = el.querySelector(':scope > .tip');
  if (t) t.hidden = true;
}
// A box with the class "fit" has a fixed height (a resizable widget): charts fill what is left of it.
// Without it, charts keep their own natural height.
const fits = (el) => el.classList.contains('fit') && el.clientHeight > 60;
const usedH = (el) => [...el.children].reduce((s, c) => s + (c.tagName === 'svg' ? 0 : c.offsetHeight + 6), 0);
export const fitH = (el, fallback) => (fits(el) ? Math.max(90, el.clientHeight - usedH(el) - 4) : fallback);
const rowFit = (el, n, natural, lo = 18, hi = 40) => (fits(el) && n ? Math.max(lo, Math.min(hi, Math.floor((fitH(el, 0) - 4) / n))) : natural);
const svgIn = (el, W, H) => d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img');
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const colorOf = (d, i) => d.color || C(i);
let gradSeq = 0;

// Time chart: line, step, dots, stacked area, columns (plain, stacked or grouped).
// series: [{ name, label, color, values, fmt?, tip?, dash? }]
export function xyChart(el, o) {
  el.replaceChildren();
  const n = o.keys.length;
  if (!n || !o.series.length) return emptyNote(el);
  if (o.series.length > 1 && !o.noLegend) legend(el, o.series, o.mode === 'line' ? 'line' : 'rect');
  const W = Math.max(260, el.clientWidth || 600), H = fits(el) ? fitH(el, 240) : o.height || 240, mt = 8, mb = 22, mr = 10;
  const svg = svgIn(el, W, H);
  const stacked = o.mode === 'area' || o.mode === 'stack' || (o.mode === 'column' && o.series.length > 1);
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) max = Math.max(max, d3.sum(o.series, (s) => s.values[i] || 0));
    else for (const s of o.series) max = Math.max(max, s.values[i] || 0);
  }
  const y = d3.scaleLinear([0, max || 1], [H - mb, mt]).nice();
  const ticks = y.ticks(4);
  const grid = svg.append('g');
  const tt = svg.append('g').attr('class', 'tick').selectAll('text').data(ticks).join('text')
    .attr('y', (d) => y(d)).attr('dy', '0.32em').text((d) => (o.axis || fCompact)(d));
  const ml = Math.ceil(d3.max(tt.nodes(), (t) => t.getComputedTextLength()) || 10) + 10;
  tt.attr('x', ml - 8).attr('text-anchor', 'end');
  grid.selectAll('line').data(ticks.filter((t) => t > 0)).join('line').attr('class', 'gridline')
    .attr('x1', ml).attr('x2', W - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const flat = o.mode === 'line' || o.mode === 'area';
  const x = d3.scaleBand(d3.range(n), [ml, W - mr]).paddingInner(flat ? 0 : 0.22).paddingOuter(flat ? 0 : 0.1);
  const cx = (i) => x(i) + x.bandwidth() / 2;
  const lab = o.tick || String;
  const lw = d3.max(o.keys, (k) => String(lab(k)).length) * 6.4 + 12;
  const every = Math.max(1, Math.ceil(lw / Math.max(1, x.step())));
  svg.append('g').attr('class', 'tick').selectAll('text').data(d3.range(0, n, every)).join('text')
    .attr('x', (i) => (cx(i) + lw / 2 > W ? W - mr : cx(i) - lw / 2 < 0 ? 0 : cx(i)))
    .attr('text-anchor', (i) => (cx(i) + lw / 2 > W ? 'end' : cx(i) - lw / 2 < 0 ? 'start' : 'middle'))
    .attr('y', H - 5).text((i) => lab(o.keys[i]));
  const g = svg.append('g');
  const curve = o.curve || d3.curveLinear;
  if (o.mode === 'line') {
    for (const s of o.series) {
      const defined = (v) => v != null;
      if (o.series.length <= 4 && !s.dash && !o.dots) {
        const id = 'grad-' + ++gradSeq;
        const gr = svg.append('defs').append('linearGradient').attr('id', id).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
        [[0, 0.3], [0.5, 0.1], [1, 0]].forEach(([at, a]) => gr.append('stop').attr('offset', at).attr('stop-opacity', a).style('stop-color', s.color));
        g.append('path').attr('fill', `url(#${id})`).attr('d', d3.area().defined(defined).x((v, i) => cx(i)).y0(y(0)).y1((v) => y(v)).curve(curve)(s.values));
      }
      if (!o.dots) {
        g.append('path').attr('fill', 'none').style('stroke', s.color).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', s.dash ? '5 4' : null).attr('d', d3.line().defined(defined).x((v, i) => cx(i)).y((v) => y(v)).curve(curve)(s.values));
      }
      const pts = s.values.map((v, i) => (v != null && (o.dots || (s.values[i - 1] == null && s.values[i + 1] == null)) ? i : -1)).filter((i) => i >= 0);
      g.selectAll(null).data(pts).join('circle').attr('cx', cx).attr('cy', (i) => y(s.values[i])).attr('r', o.dots ? 4.5 : 3).style('fill', s.color);
    }
  } else if (stacked) {
    const st = d3.stack().keys(d3.range(o.series.length)).value((i, k) => o.series[k].values[i] || 0)(d3.range(n));
    st.forEach((layer, k) => {
      if (o.mode === 'area') {
        g.append('path').style('fill', o.series[k].color).attr('fill-opacity', 0.88).attr('d', d3.area().x((d, i) => cx(i)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(curve)(layer));
      } else {
        g.selectAll(null).data(layer.map((d, i) => [d, i]).filter(([d]) => d[1] > d[0])).join('rect')
          .attr('x', ([, i]) => x(i)).attr('width', x.bandwidth())
          .attr('y', ([d]) => y(d[1])).attr('height', ([d]) => Math.max(0, y(d[0]) - y(d[1]) - (k ? 1 : 0)))
          .attr('rx', Math.min(2, x.bandwidth() / 4)).style('fill', o.series[k].color);
      }
    });
  } else {
    const x1 = d3.scaleBand(d3.range(o.series.length), [0, x.bandwidth()]).padding(o.series.length > 1 ? 0.08 : 0);
    o.series.forEach((s, k) => {
      g.selectAll(null).data(s.values.map((v, i) => [v, i]).filter(([v]) => v)).join('rect')
        .attr('x', ([, i]) => x(i) + x1(k)).attr('width', x1.bandwidth())
        .attr('y', ([v]) => y(v)).attr('height', ([v]) => Math.max(0, y(0) - y(v)))
        .attr('rx', Math.min(2, x1.bandwidth() / 4)).style('fill', s.color);
    });
  }
  svg.append('line').attr('class', 'baseline').attr('x1', ml).attr('x2', W - mr).attr('y1', y(0)).attr('y2', y(0));
  const rule = svg.append('line').attr('class', 'rule').attr('y1', mt).attr('y2', H - mb).style('opacity', 0);
  const titleOf = o.title || lab;
  svg.append('g').selectAll('rect').data(d3.range(n)).join('rect')
    .attr('x', (i) => x(i) - (x.step() - x.bandwidth()) / 2).attr('width', x.step()).attr('y', mt).attr('height', H - mb - mt).attr('fill', 'transparent')
    .style('cursor', o.onPick ? 'pointer' : null)
    .on('pointerenter pointermove', (ev, i) => {
      rule.attr('x1', cx(i)).attr('x2', cx(i)).style('opacity', 1);
      showTip(el, ev, titleOf(o.keys[i]), o.series.map((s) => ({ name: s.name, label: s.label, color: s.color, value: s.tip ? s.tip[i] : s.values[i], fmt: s.fmt })), o.fmt || fInt, o.series.length > 1);
    })
    .on('pointerleave', () => { rule.style('opacity', 0); hideTip(el); })
    .on('click', (ev, i) => { if (o.onPick) o.onPick(i); });
}

// Horizontal bars, optionally stacked from segments, with an optional mark for a compared value.
export function barChart(el, o) {
  el.replaceChildren();
  const items = o.items;
  if (!items.length) return emptyNote(el);
  if (o.segLegend) legend(el, o.segLegend, 'rect');
  const W = Math.max(260, el.clientWidth || 600), rowH = rowFit(el, items.length, 26, 18, 38), H = items.length * rowH + 2;
  const svg = svgIn(el, W, H);
  const fmt = o.fmt || fInt;
  const lt = svg.append('g').attr('class', 'tick').selectAll('text').data(items).join('text').text((d) => d.label);
  const lwMax = Math.min(W * 0.38, (d3.max(lt.nodes(), (t) => t.getComputedTextLength()) || 20) + 10);
  lt.each(function (d) { let s = String(d.label); while (this.getComputedTextLength() > lwMax - 10 && s.length > 4) { s = s.slice(0, -1); this.textContent = s + '…'; } });
  lt.attr('x', lwMax - 8).attr('y', (d, i) => i * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'end');
  const vw = (d3.max(items, (d) => fmt(d.value).length) || 3) * 7 + 12;
  const x = d3.scaleLinear([0, o.max ?? (d3.max(items, (d) => Math.max(d.value, d.prev || 0)) || 1)], [lwMax, W - vw]);
  const bh = Math.max(10, Math.min(24, rowH - 10));
  items.forEach((d, i) => {
    const yy = i * rowH + (rowH - bh) / 2;
    const segs = d.segs || [{ value: d.value, color: colorOf(d, i) }];
    let acc = 0;
    segs.forEach((s, k) => {
      if (!s.value) return;
      const x0 = x(acc), x1 = x(acc + s.value);
      acc += s.value;
      svg.append('rect').attr('x', x0).attr('y', yy).attr('width', Math.max(1, x1 - x0 - (k < segs.length - 1 ? 1 : 0))).attr('height', bh).attr('rx', 2).style('fill', s.color);
    });
    svg.append('text').attr('class', 'val').attr('x', x(Math.max(d.value, d.prev || 0)) + 6).attr('y', yy + bh / 2).attr('dy', '0.32em').text(fmt(d.value));
    if (d.prev != null) svg.append('line').attr('class', 'prev').attr('x1', x(d.prev)).attr('x2', x(d.prev)).attr('y1', yy - 3).attr('y2', yy + bh + 3);
  });
  svg.append('g').selectAll('rect').data(items).join('rect')
    .attr('x', 0).attr('width', W).attr('y', (d, i) => i * rowH).attr('height', rowH).attr('fill', 'transparent')
    .style('cursor', o.onPick ? 'pointer' : null)
    .on('pointerenter pointermove', (ev, d) => showTip(el, ev, d.label, d.segs
      ? d.segs.map((s) => ({ name: s.name, label: s.label, color: s.color, value: s.value })).concat([{ name: 'Total', label: 'Total', value: d.value }])
      : [{ name: '', value: d.value }].concat(d.prev != null ? [{ name: 'compared', label: 'compared period', value: d.prev }] : []), fmt, !!d.segs))
    .on('pointerleave', () => hideTip(el))
    .on('click', (ev, d) => { if (o.onPick) o.onPick(d); });
}

function valueList(parent, items, fmt) {
  const total = d3.sum(items, (d) => d.value) || 1;
  const dl = mk('div', 'dl');
  parent.append(dl);
  items.forEach((d, i) => {
    const row = mk('div', 'dl-row'), k = mk('span', 'key');
    k.style.background = colorOf(d, i);
    row.append(k, mk('span', null, d.label), mk('b', null, fmt(d.value)), mk('i', null, fPct(d.value / total)));
    dl.append(row);
  });
}

export function donutChart(el, o) {
  el.replaceChildren();
  const items = o.items.filter((d) => d.value > 0);
  if (!items.length) return emptyNote(el);
  const fmt = o.fmt || fInt;
  const total = d3.sum(items, (d) => d.value);
  const wrap = mk('div', 'donut');
  el.append(wrap);
  const size = o.size || (fits(el) ? Math.max(110, Math.min(320, (el.clientWidth || 400) * 0.45, fitH(el, 210) - 8)) : Math.min(210, Math.max(150, (el.clientWidth || 400) * 0.45)));
  const svg = d3.select(wrap).append('svg').attr('width', size).attr('height', size).attr('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`).attr('role', 'img');
  const arc = d3.arc().innerRadius(o.pie ? 0 : size * 0.3).outerRadius(size / 2 - 4).padAngle(items.length > 1 ? 0.012 : 0);
  svg.selectAll('path').data(d3.pie().sort(null).value((d) => d.value)(items)).join('path').attr('d', arc).style('fill', (d, i) => colorOf(d.data, i))
    .style('cursor', o.onPick ? 'pointer' : null)
    .on('pointerenter pointermove', (ev, d) => showTip(el, ev, d.data.label, [{ name: '', label: fPct(d.data.value / total) + ' of total', value: d.data.value }], fmt, false))
    .on('pointerleave', () => hideTip(el))
    .on('click', (ev, d) => { if (o.onPick) o.onPick(d.data); });
  if (!o.pie) {
    svg.append('text').attr('class', 'center-num').attr('text-anchor', 'middle').attr('dy', '0.1em').attr('font-size', Math.round(size / 8)).text(fCompact(total));
    svg.append('text').attr('class', 'center-lab').attr('text-anchor', 'middle').attr('dy', '1.6em').text('total');
  }
  valueList(wrap, items, fmt);
}

export function heatmap(el, o) {
  el.replaceChildren();
  if (!o.rows.length || !o.cols.length) return emptyNote(el);
  const fmt = o.fmt || fInt;
  const W = Math.max(260, el.clientWidth || 600), top = 18;
  const cellH = fits(el) ? Math.max(10, Math.min(44, Math.floor((fitH(el, 0) - top - 4) / Math.max(1, o.rows.length)) - 2)) : 22;
  const H = o.rows.length * (cellH + 2) + top + 4;
  const svg = svgIn(el, W, H);
  const lt = svg.append('g').attr('class', 'tick').selectAll('text').data(o.rows).join('text').text((d) => d.label);
  const ml = Math.min(W * 0.32, (d3.max(lt.nodes(), (t) => t.getComputedTextLength()) || 20) + 10);
  lt.each(function (d) { let s = String(d.label); while (this.getComputedTextLength() > ml - 10 && s.length > 4) { s = s.slice(0, -1); this.textContent = s + '…'; } });
  lt.attr('x', ml - 8).attr('y', (d, i) => top + i * (cellH + 2) + cellH / 2).attr('dy', '0.32em').attr('text-anchor', 'end');
  const cw = (W - ml - 4) / o.cols.length;
  const lab = o.colLabel || String;
  const lw = d3.max(o.cols, (c) => String(lab(c)).length) * 6.4 + 8;
  const every = Math.max(1, Math.ceil(lw / cw));
  svg.append('g').attr('class', 'tick').selectAll('text').data(d3.range(0, o.cols.length, every)).join('text')
    .attr('x', (j) => Math.min(W - lw / 2, ml + j * cw + cw / 2)).attr('y', 11).attr('text-anchor', 'middle').text((j) => lab(o.cols[j]));
  const max = d3.max(o.rows, (r) => d3.max(r.values, (v) => v || 0)) || 1;
  o.rows.forEach((r, i) => {
    const yy = top + i * (cellH + 2);
    const rmax = o.rowScale ? d3.max(r.values, (v) => v || 0) || 1 : max;
    r.values.forEach((v, j) => {
      const xx = ml + j * cw;
      svg.append('rect').attr('class', 'cellbg').attr('x', xx).attr('y', yy).attr('width', Math.max(1, cw - 2)).attr('height', cellH).attr('rx', 2);
      svg.append('rect').attr('x', xx).attr('y', yy).attr('width', Math.max(1, cw - 2)).attr('height', cellH).attr('rx', 2)
        .style('fill', C(0)).attr('fill-opacity', v ? 0.12 + 0.88 * (v / rmax) : 0).style('cursor', o.onPick ? 'pointer' : null)
        .on('pointerenter pointermove', (ev) => showTip(el, ev, r.label + ' · ' + (o.colTitle || lab)(o.cols[j]), [{ name: '', label: o.valueLabel || '', value: v || 0 }], r.fmt || fmt, false))
        .on('pointerleave', () => hideTip(el))
        .on('click', () => { if (o.onPick) o.onPick(r.name, j); });
    });
  });
}

export function columnsChart(el, items, fmt, onPick) {
  if (!items.length) return emptyNote(el);
  const segs = items[0].segs;
  const series = segs
    ? segs.map((s, k) => ({ name: s.name, label: s.label ?? s.name, color: s.color, values: items.map((d) => d.segs[k].value) }))
    : [{ name: 'Value', label: 'Value', color: colorOf(items[0], 0), values: items.map((d) => d.value) }];
  xyChart(el, { keys: items.map((d, i) => i), mode: segs ? 'stack' : 'column', tick: (i) => short(items[i].label, 12), title: (i) => items[i].label, series, fmt, height: fitH(el, 260), onPick: onPick ? (i) => onPick(items[i]) : null });
}

export function lollipopChart(el, items, fmt, onPick) {
  el.replaceChildren();
  if (!items.length) return emptyNote(el);
  const W = Math.max(260, el.clientWidth || 600), rowH = rowFit(el, items.length, 28, 18, 40), H = items.length * rowH + 4;
  const svg = svgIn(el, W, H);
  const lt = svg.append('g').attr('class', 'tick').selectAll('text').data(items).join('text').text((d) => short(d.label, 28));
  const lw = Math.min(W * 0.38, (d3.max(lt.nodes(), (t) => t.getComputedTextLength()) || 20) + 10);
  lt.attr('x', lw - 8).attr('y', (d, i) => i * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'end');
  const x = d3.scaleLinear([0, d3.max(items, (d) => d.value) || 1], [lw, W - 56]);
  items.forEach((d, i) => {
    const y = i * rowH + rowH / 2, c = colorOf(d, i);
    svg.append('line').attr('x1', x(0)).attr('x2', x(d.value)).attr('y1', y).attr('y2', y).style('stroke', c).attr('stroke-width', 2.5).attr('stroke-linecap', 'round');
    svg.append('circle').attr('cx', x(d.value)).attr('cy', y).attr('r', 6).style('fill', c);
    svg.append('text').attr('class', 'val').attr('x', x(d.value) + 12).attr('y', y).attr('dy', '0.32em').text(fmt(d.value));
    svg.append('rect').attr('x', 0).attr('width', W).attr('y', i * rowH).attr('height', rowH).attr('fill', 'transparent').style('cursor', onPick ? 'pointer' : null)
      .on('pointerenter pointermove', (ev) => showTip(el, ev, d.label, [{ name: '', value: d.value }], fmt, false))
      .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(d));
  });
}

export function polarChart(el, items, fmt, onPick) {
  el.replaceChildren();
  items = items.filter((d) => d.value > 0);
  if (!items.length) return emptyNote(el);
  const wrap = mk('div', 'donut');
  el.append(wrap);
  const size = fits(el) ? Math.max(110, Math.min(320, (el.clientWidth || 400) * 0.45, fitH(el, 240) - 8)) : Math.min(240, Math.max(170, (el.clientWidth || 400) * 0.45));
  const svg = d3.select(wrap).append('svg').attr('width', size).attr('height', size).attr('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`).attr('role', 'img');
  const r = d3.scaleSqrt([0, d3.max(items, (d) => d.value)], [0, size / 2 - 4]);
  const step = (2 * Math.PI) / items.length;
  for (const lvl of [0.25, 0.5, 0.75, 1]) svg.append('circle').attr('r', (size / 2 - 4) * lvl).attr('fill', 'none').attr('class', 'gridline');
  items.forEach((d, i) => {
    svg.append('path').style('fill', colorOf(d, i)).attr('fill-opacity', 0.85).style('cursor', onPick ? 'pointer' : null)
      .attr('d', d3.arc().innerRadius(0).outerRadius(r(d.value)).startAngle(i * step).endAngle((i + 1) * step).padAngle(0.02)())
      .on('pointerenter pointermove', (ev) => showTip(el, ev, d.label, [{ name: '', value: d.value }], fmt, false))
      .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(d));
  });
  valueList(wrap, items, fmt);
}

export function treemapChart(el, items, fmt, onPick) {
  el.replaceChildren();
  items = items.filter((d) => d.value > 0);
  if (!items.length) return emptyNote(el);
  const W = Math.max(260, el.clientWidth || 600), H = fitH(el, 280);
  const svg = svgIn(el, W, H);
  const root = d3.hierarchy({ children: items.map((d, i) => ({ ...d, i })) }).sum((d) => d.value || 0).sort((a, b) => b.value - a.value);
  d3.treemap().size([W, H]).paddingInner(3).round(true)(root);
  for (const leaf of root.leaves()) {
    const d = leaf.data, w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
    const g = svg.append('g').attr('transform', `translate(${leaf.x0},${leaf.y0})`);
    g.append('rect').attr('width', w).attr('height', h).attr('rx', 4).style('fill', colorOf(d, d.i)).style('cursor', onPick ? 'pointer' : null)
      .on('pointerenter pointermove', (ev) => showTip(el, ev, d.label, [{ name: '', value: d.value }], fmt, false))
      .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(d));
    if (w > 56 && h > 34) {
      g.append('text').attr('x', 8).attr('y', 18).attr('class', 'tm-label').text(short(d.label, Math.floor(w / 7)));
      g.append('text').attr('x', 8).attr('y', 34).attr('class', 'tm-value').text(fmt(d.value));
    }
  }
}

export function waffleChart(el, items, fmt, onPick) {
  el.replaceChildren();
  items = items.filter((d) => d.value > 0);
  if (!items.length) return emptyNote(el);
  const total = d3.sum(items, (d) => d.value);
  // 100 squares shared by largest remainder, so each square is about 1%
  const raw = items.map((d) => (d.value / total) * 100), cells = raw.map(Math.floor);
  let left = 100 - d3.sum(cells);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { cells[i]++; left--; } });
  const wrap = mk('div', 'donut');
  el.append(wrap);
  const s = Math.min(fits(el) ? 30 : 20, Math.max(9, Math.min(((el.clientWidth || 400) * 0.45) / 10, fits(el) ? (fitH(el, 230) - 8) / 10 - 3 : 99))), gap = 3, size = 10 * (s + gap);
  const svg = d3.select(wrap).append('svg').attr('width', size).attr('height', size).attr('viewBox', `0 0 ${size} ${size}`).attr('role', 'img');
  let k = 0;
  cells.forEach((cnt, i) => {
    for (let j = 0; j < cnt; j++, k++) {
      svg.append('rect').attr('x', (k % 10) * (s + gap)).attr('y', Math.floor(k / 10) * (s + gap)).attr('width', s).attr('height', s).attr('rx', 3)
        .style('fill', colorOf(items[i], i)).style('cursor', onPick ? 'pointer' : null)
        .on('pointerenter pointermove', (ev) => showTip(el, ev, items[i].label, [{ name: '', label: fPct(items[i].value / total) + ' of total', value: items[i].value }], fmt, false))
        .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(items[i]));
    }
  });
  valueList(wrap, items, fmt);
}

export function radarChart(el, items, fmt, onPick) {
  if (items.length < 3) return barChart(el, { items, fmt, onPick });
  el.replaceChildren();
  const W = Math.max(280, el.clientWidth || 600), H = fitH(el, 300), R = Math.max(30, Math.min(W / 2 - 90, H / 2 - 28));
  const svg = svgIn(el, W, H).append('g').attr('transform', `translate(${W / 2},${H / 2})`);
  const n = items.length, ang = (i) => (i / n) * 2 * Math.PI - Math.PI / 2;
  const r = d3.scaleLinear([0, d3.max(items, (d) => d.value) || 1], [0, R]);
  for (const lvl of [0.25, 0.5, 0.75, 1]) svg.append('polygon').attr('class', 'gridline').attr('fill', 'none').attr('points', items.map((d, i) => [Math.cos(ang(i)) * R * lvl, Math.sin(ang(i)) * R * lvl].join(',')).join(' '));
  items.forEach((d, i) => {
    svg.append('line').attr('class', 'gridline').attr('x2', Math.cos(ang(i)) * R).attr('y2', Math.sin(ang(i)) * R);
    const lx = Math.cos(ang(i)) * (R + 12), ly = Math.sin(ang(i)) * (R + 12);
    svg.append('text').attr('class', 'tick').attr('x', lx).attr('y', ly).attr('dy', '0.32em').attr('text-anchor', Math.abs(lx) < 4 ? 'middle' : lx > 0 ? 'start' : 'end').text(short(d.label, 16));
  });
  const pts = items.map((d, i) => [Math.cos(ang(i)) * r(d.value), Math.sin(ang(i)) * r(d.value)]);
  svg.append('polygon').attr('points', pts.map((p) => p.join(',')).join(' ')).style('fill', C(0)).attr('fill-opacity', 0.22).style('stroke', C(0)).attr('stroke-width', 2).attr('stroke-linejoin', 'round');
  items.forEach((d, i) => svg.append('circle').attr('cx', pts[i][0]).attr('cy', pts[i][1]).attr('r', 5).style('fill', C(0)).style('cursor', onPick ? 'pointer' : null)
    .on('pointerenter pointermove', (ev) => showTip(el, ev, d.label, [{ name: '', value: d.value }], fmt, false))
    .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(d)));
}

export function funnelChart(el, items, fmt, onPick) {
  el.replaceChildren();
  items = items.slice().sort((a, b) => b.value - a.value);
  if (!items.length) return emptyNote(el);
  const W = Math.max(260, el.clientWidth || 600), rowH = rowFit(el, items.length, 30, 20, 44), H = items.length * rowH;
  const svg = svgIn(el, W, H);
  const lt = svg.append('g').attr('class', 'tick').selectAll('text').data(items).join('text').text((d) => short(d.label, 28));
  const lw = Math.min(W * 0.34, (d3.max(lt.nodes(), (t) => t.getComputedTextLength()) || 20) + 10);
  lt.attr('x', lw - 8).attr('y', (d, i) => i * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'end');
  const area = W - lw - 8, mid = lw + area / 2, x = d3.scaleLinear([0, items[0].value || 1], [0, area]);
  items.forEach((d, i) => {
    const w = Math.max(2, x(d.value));
    svg.append('rect').attr('x', mid - w / 2).attr('y', i * rowH + 3).attr('width', w).attr('height', rowH - 6).attr('rx', 4).style('fill', colorOf(d, i)).style('cursor', onPick ? 'pointer' : null)
      .on('pointerenter pointermove', (ev) => showTip(el, ev, d.label, [{ name: '', value: d.value }], fmt, false))
      .on('pointerleave', () => hideTip(el)).on('click', () => onPick && onPick(d));
    svg.append('text').attr('class', 'fn-val').attr('x', mid).attr('y', i * rowH + rowH / 2).attr('dy', '0.32em').attr('text-anchor', 'middle').text(fmt(d.value));
  });
}

// Plain tables for any data, newest period first.
export function itemsTable(el, items, fmt, onPick) {
  el.replaceChildren();
  if (!items.length) return emptyNote(el);
  const segs = items[0].segs ? items[0].segs.map((s) => s.label ?? s.name) : [];
  const box = mk('div', 'scroll tall'), t = mk('table', 'table');
  box.append(t);
  el.append(box);
  const hr = mk('tr');
  hr.append(mk('th', null, 'Name'));
  for (const n of segs) hr.append(mk('th', null, n));
  hr.append(mk('th', null, segs.length ? 'Total' : 'Value'));
  const th = mk('thead'); th.append(hr); t.append(th);
  const tb = mk('tbody'); t.append(tb);
  for (const d of items) {
    const tr = mk('tr'), first = mk('td');
    if (onPick) { const b = mk('button', 'link', d.label); b.type = 'button'; b.addEventListener('click', () => onPick(d)); first.append(b); } else first.textContent = d.label;
    tr.append(first);
    for (const s of d.segs || []) tr.append(mk('td', null, fmt(s.value)));
    tr.append(mk('td', null, fmt(d.value)));
    tb.append(tr);
  }
}
export function seriesTable(el, keys, series, title, fmt, onPick) {
  el.replaceChildren();
  if (!keys.length || !series.length) return emptyNote(el);
  const box = mk('div', 'scroll tall'), t = mk('table', 'table');
  box.append(t);
  el.append(box);
  const hr = mk('tr');
  hr.append(mk('th', null, 'Period'));
  for (const s of series) hr.append(mk('th', null, s.label ?? s.name));
  const th = mk('thead'); th.append(hr); t.append(th);
  const tb = mk('tbody'); t.append(tb);
  for (let i = keys.length - 1; i >= 0; i--) {
    const tr = mk('tr'), first = mk('td');
    if (onPick) { const b = mk('button', 'link', title(keys[i])); b.type = 'button'; b.addEventListener('click', () => onPick(i)); first.append(b); } else first.textContent = title(keys[i]);
    tr.append(first);
    for (const s of series) { const v = (s.tip || s.values)[i]; tr.append(mk('td', null, v == null ? '—' : (s.fmt || fmt)(v))); }
    tb.append(tr);
  }
}

export { MUTED };
