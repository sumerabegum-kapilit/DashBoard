// Draws any chart payload from the API in whichever chart type the person picked.
import { fmtOf, colorFor, labelFor, tickFor, titleFor, d3 } from './util.js';
import { xyChart, barChart, donutChart, heatmap, columnsChart, lollipopChart, polarChart, treemapChart, waffleChart, radarChart, funnelChart, itemsTable, seriesTable, emptyNote } from './charts.js';

export const VIEWS = {
  category: [['bar', 'Bars'], ['column', 'Columns'], ['lollipop', 'Lollipop'], ['donut', 'Donut'], ['pie', 'Pie'], ['polar', 'Polar area'], ['treemap', 'Treemap'], ['waffle', 'Waffle'], ['radar', 'Radar'], ['funnel', 'Funnel'], ['table', 'Table']],
  // shares of a whole make no sense for percentages or done/not-done splits
  compare: [['bar', 'Bars'], ['column', 'Columns'], ['lollipop', 'Lollipop'], ['radar', 'Radar'], ['table', 'Table']],
  time: [['line', 'Line'], ['step', 'Step line'], ['dots', 'Dots'], ['area', 'Stacked area'], ['stack', 'Stacked columns'], ['group', 'Grouped columns'], ['heat', 'Heatmap'], ['table', 'Table']],
  // lines that must not be stacked: different units, or one is part of another
  timeNoStack: [['line', 'Line'], ['step', 'Step line'], ['dots', 'Dots'], ['group', 'Grouped columns'], ['heat', 'Heatmap'], ['table', 'Table']],
  heat: [['heat', 'Heatmap'], ['table', 'Table']],
};

export function categoryItems(data) {
  return data.items.map((d, i) => ({
    ...d,
    label: labelFor(data.dim, d.label ?? d.name),
    // a caller may set the colour itself (fill); otherwise it comes from the field and position
    color: d.fill || colorFor(data.dim, d.name, i),
    segs: d.segs ? d.segs.map((s, k) => ({ ...s, label: s.label ?? labelFor(data.segDim, s.name), color: s.fill || colorFor(data.segDim, s.name, k) })) : undefined,
  }));
}

export function timeSeries(data, opts = {}) {
  const off = new Set(opts.off || []);
  return data.series.map((s, i) => ({ ...s, i })).filter((s) => !off.has(s.name)).map((s) => {
    const color = s.color === 'critical' ? 'var(--bad)' : colorFor(data.dim, s.name, s.i);
    const fmt = typeof s.fmt === 'function' ? s.fmt : fmtOf(s.fmt || data.fmt);
    if (!opts.shapes) return { ...s, label: labelFor(data.dim, s.label ?? s.name), color, fmt };
    // "Compare shapes": each line as a share of its own peak; the tooltip keeps the real value
    const peak = d3.max(s.values, (v) => v || 0) || 1;
    return { ...s, label: labelFor(data.dim, s.label ?? s.name), color, fmt, tip: s.values, values: s.values.map((v) => (v == null ? null : (v / peak) * 100)) };
  });
}

export function render(box, data, view, opts = {}) {
  if (!data) return emptyNote(box);
  // a caller may hand over a ready formatter (opts.fmtFn) instead of a format name
  const fmt = opts.fmtFn || fmtOf(data.fmt);
  if (data.kind === 'category') {
    const items = categoryItems(data);
    if (!items.length || items.every((d) => !d.value)) return emptyNote(box);
    const pick = opts.onPick || null;
    switch (view) {
      case 'column': return columnsChart(box, items, fmt, pick);
      case 'lollipop': return lollipopChart(box, items, fmt, pick);
      case 'donut': case 'pie': return donutChart(box, { items: items.map(({ segs, ...d }) => d), fmt, pie: view === 'pie', onPick: pick, size: opts.size });
      case 'polar': return polarChart(box, items, fmt, pick);
      case 'treemap': return treemapChart(box, items, fmt, pick);
      case 'waffle': return waffleChart(box, items, fmt, pick);
      case 'radar': return radarChart(box, items, fmt, pick);
      case 'funnel': return funnelChart(box, items, fmt, pick);
      case 'table': return itemsTable(box, items, fmt, pick);
      default: return barChart(box, { items, fmt, max: data.max, onPick: pick, segLegend: items[0].segs ? items[0].segs.map((s) => ({ name: s.name, label: s.label, color: s.color })) : null });
    }
  }
  if (data.kind === 'time') {
    const series = timeSeries(data, opts);
    if (!series.length) return emptyNote(box, 'Turn on at least one line.');
    const tick = opts.tick || tickFor(data.grain), title = opts.title || titleFor(data.grain);
    if (view === 'heat') return heatmap(box, { rows: series.map((s) => ({ name: s.name, label: s.label, values: s.tip || s.values, fmt: s.fmt })), cols: data.keys, colLabel: tick, colTitle: title, fmt, rowScale: true, onPick: opts.onPick ? (name, j) => opts.onPick({ series: name, index: j }) : null });
    if (view === 'table') return seriesTable(box, data.keys, series, title, fmt, opts.onPick ? (i) => opts.onPick({ index: i }) : null);
    const modes = { line: ['line'], step: ['line', { curve: d3.curveStepAfter }], dots: ['line', { dots: true }], area: ['area'], stack: ['stack'], group: ['group'], column: [series.length > 1 ? 'group' : 'column'] };
    const [mode, extra] = modes[view] || ['line'];
    return xyChart(box, { keys: data.keys, mode, ...(extra || {}), tick, title, series, fmt, noLegend: opts.noLegend, height: opts.height || 260, axis: opts.shapes ? (v) => v + '%' : undefined, onPick: opts.onPick ? (i) => opts.onPick({ index: i }) : null });
  }
  if (data.kind === 'heat') {
    if (view === 'table') return seriesTable(box, data.cols, data.rows.map((r, i) => ({ ...r, color: colorFor(null, r.name, i) })), String, fmt);
    return heatmap(box, { ...data, fmt, colLabel: String, colTitle: opts.colTitle || ((c) => c + ':00'), onPick: opts.onPick ? (name, j) => opts.onPick({ series: name, index: j }) : null });
  }
  return emptyNote(box);
}
