// The query engine. It turns a view spec into results for any source, through a small adapter interface:
//
//   adapter.aggregate(base, { dims: [{ ref, grain? }], measures: [{ fn, field, filters }], where: [cond] })
//        -> [{ k: [key text per dim], vs: [value per measure], n: rows }]
//   adapter.span(base, ref, where)                 -> { lo, hi }   first and last date
//   adapter.records(base, { where, columns, sort, dir, search, offset, limit }) -> { total, rows: [[value per column]] }
//   adapter.count(base)                           -> number of rows
//
// cond: { field: ref, op, value }. User ops: is, not, in, notin, contains, empty, notempty, ge, le, between.
//       Engine ops: in / notin (value: list of key texts), between (value: [from, to] dates), bucket (value: { grain, key }).
// Keys are text: '(none)' for empty, 'Yes'/'No' for booleans, date parts and buckets as in schema.js.
// Everything here is written once; adapters only know how to run those primitives.
const S_ = require('./schema');
const { resolve, pathTo, fieldsOf, keyOrder, autoGrain, bucketKeys, addDays, NONE, OTHER, GRAINS, MAX_HOPS } = S_;

const FNS = ['count', 'sum', 'avg', 'median', 'min', 'max', 'distinct', 'rate'];
const NUMERIC_FNS = ['sum', 'avg', 'median', 'min', 'max'];
const USER_OPS = { text: ['is', 'not', 'in', 'notin', 'contains', 'empty', 'notempty'], number: ['ge', 'le', 'is', 'not', 'empty', 'notempty', 'in', 'notin'], date: ['ge', 'le', 'between', 'empty', 'notempty'], bool: ['is', 'in', 'notin'] };
const SORTS = ['auto', 'value-desc', 'value-asc', 'label-asc', 'label-desc'];
const MAX_MEASURES = 6;
const FN_LABEL = { count: 'Count', sum: 'Total', avg: 'Average', median: 'Median', min: 'Lowest', max: 'Highest', distinct: 'Number of different', rate: 'Share' };

// ---- validation ----
function cleanConds(S, base, list, max = 20) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list.slice(0, max)) {
    if (!f || !f.field || !f.op) continue;
    const r = resolve(S, base, f.field);
    const ops = USER_OPS[r.type] || USER_OPS.text;
    if (!ops.includes(f.op)) throw new Error(`That filter does not fit the field ${r.label}`);
    let value = f.value;
    if (f.op === 'in' || f.op === 'notin' || f.op === 'between') value = (Array.isArray(value) ? value : [value]).filter((v) => v != null).map((v) => String(v).slice(0, 300)).slice(0, 300);
    else value = value == null ? '' : String(value).slice(0, 300);
    if (f.op === 'between' && value.length !== 2) continue;
    out.push({ field: f.field, op: f.op, value });
  }
  return out;
}

function validate(S, raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (!S.tables[s.base]) throw new Error('Choose a table to start from');
  const base = s.base;
  let measures = Array.isArray(s.measures) && s.measures.length ? s.measures : [{ fn: s.fn || 'count', field: s.field || '' }];
  measures = measures.slice(0, MAX_MEASURES).map((m) => {
    const fn = FNS.includes(m && m.fn) ? m.fn : 'count';
    const out = { fn, field: fn === 'count' || fn === 'rate' ? '' : String(m.field || ''), filters: cleanConds(S, base, m.filters, 8), time: m.time ? String(m.time) : '', label: m.label ? String(m.label).slice(0, 80) : '', format: m.format ? String(m.format).slice(0, 20) : '' };
    if (fn !== 'count' && fn !== 'rate' && !out.field) throw new Error('Choose the field to calculate');
    if (out.field && NUMERIC_FNS.includes(fn) && resolve(S, base, out.field).type !== 'number') throw new Error('Total, average, median, lowest and highest need a number field');
    if (out.time && resolve(S, base, out.time).type !== 'date') throw new Error('A measure date must be a date field');
    if (fn === 'rate' && !out.filters.length) throw new Error('A share needs a condition: which rows count as "yes"');
    return out;
  });
  const spec = {
    base,
    measures,
    group: s.group ? String(s.group) : '',
    split: s.split ? String(s.split) : '',
    time: s.time ? String(s.time) : '',
    grain: GRAINS.includes(s.grain) ? s.grain : 'auto',
    top: Math.min(100, Math.max(1, Number(s.top) || 10)),
    splitTop: Math.min(24, Math.max(1, Number(s.splitTop) || 6)),
    other: s.other !== false,
    sort: SORTS.includes(s.sort) ? s.sort : 'auto',
    cumulative: !!s.cumulative,
    dateField: s.dateField === '-' ? '-' : s.dateField ? String(s.dateField) : '',
    filters: cleanConds(S, base, s.filters),
  };
  for (const k of ['group', 'split', 'time']) if (spec[k]) resolve(S, base, spec[k]);
  if (spec.time && resolve(S, base, spec.time).type !== 'date') throw new Error('"Over time" needs a date field');
  if (spec.dateField && spec.dateField !== '-' && resolve(S, base, spec.dateField).type !== 'date') throw new Error('The period must apply to a date field');
  if (spec.split && !spec.group && !spec.time) spec.group = spec.split, spec.split = '';
  return spec;
}

const measureLabel = (S, base, m) => {
  if (m.label) return m.label;
  if (m.fn === 'count') return 'Number of ' + S.tables[base].label.toLowerCase();
  if (m.fn === 'rate') return 'Share of ' + S.tables[base].label.toLowerCase();
  return `${FN_LABEL[m.fn]} ${m.fn === 'distinct' ? '' : 'of '}${resolve(S, base, m.field).label.toLowerCase()}`.replace('  ', ' ');
};
const measureFormat = (S, base, m) => {
  if (m.format) return m.format;
  if (m.fn === 'rate') return 'pct';
  if (m.fn === 'count' || m.fn === 'distinct') return 'int';
  return resolve(S, base, m.field).field.format || (m.fn === 'avg' || m.fn === 'median' ? 'dec' : 'auto');
};
const additive = (m) => m.fn === 'count' || m.fn === 'sum';

// ---- dashboard context: the period and the filters set for the whole dashboard ----
// ctx = { range: { from, to }, filters: [{ table, field, op, value }], compare: bool }
function contextWhere(S, spec, ctx = {}) {
  const where = [...spec.filters];
  const ignored = [];
  let rangeRef = null;
  if (ctx.range && /^\d{4}-\d{2}-\d{2}$/.test(ctx.range.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(ctx.range.to || '')) {
    rangeRef = spec.dateField === '-' ? null : spec.dateField || S.tables[spec.base].date;
    if (rangeRef) where.push({ field: rangeRef, op: 'between', value: [ctx.range.from, ctx.range.to], range: true });
  }
  for (const f of Array.isArray(ctx.filters) ? ctx.filters.slice(0, 20) : []) {
    const ref = mapFilter(S, spec.base, f);
    if (!ref) { ignored.push(f); continue; }
    try { where.push(...cleanConds(S, spec.base, [{ ...f, field: ref }])); } catch (e) { ignored.push(f); }
  }
  return { where, rangeRef, ignored };
}
// A dashboard filter is set on one table; other widgets reach that table through their links.
function mapFilter(S, base, f) {
  if (!f || !S.tables[f.table] || !f.field) return null;
  let r;
  try { r = resolve(S, f.table, f.field); } catch (e) { return null; }
  const [, part] = f.field.split('|');
  const tail = r.col + (part ? '|' + part : '');
  const tries = [[f.table, f.field], [r.table, tail]];
  for (const [table, field] of tries) {
    const hops = pathTo(S, base, table);
    if (!hops) continue;
    const full = [...hops, field].join('.');
    if (full.split('|')[0].split('.').length - 1 > MAX_HOPS) continue;
    try { resolve(S, base, full); return full; } catch (e) { /* try the next way */ }
  }
  return null;
}
function shiftRange(where) {
  const r = where.find((c) => c.range);
  if (!r) return null;
  const [from, to] = r.value;
  const len = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  return where.map((c) => (c.range ? { ...c, value: [addDays(from, -len), addDays(from, -1)] } : c));
}

// ---- running a view ----
function sorter(S, spec, ref) {
  const natural = keyOrder(S, spec.base, ref);
  const byLabel = natural || ((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const val = (g) => g.values[0] ?? -Infinity;
  switch (spec.sort) {
    case 'value-desc': return (a, b) => val(b) - val(a);
    case 'value-asc': return (a, b) => val(a) - val(b);
    case 'label-asc': return (a, b) => byLabel(a.key, b.key);
    case 'label-desc': return (a, b) => byLabel(b.key, a.key);
    default: return natural ? (a, b) => natural(a.key, b.key) : (a, b) => val(b) - val(a) || String(a.key).localeCompare(String(b.key));
  }
}
// The groups to show: the biggest ones (or all of an ordered set such as weekdays), the rest as "Other".
function pickTop(S, spec, ref, rows, limit) {
  const list = rows.map((r) => ({ key: r.k[0], values: r.vs, n: r.n }));
  const natural = !!keyOrder(S, spec.base, ref);
  const lim = natural && spec.sort === 'auto' ? Math.max(limit, 100) : limit;
  const biggest = list.slice().sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity) || String(a.key).localeCompare(String(b.key)));
  const keep = biggest.slice(0, lim);
  const rest = biggest.slice(lim);
  return { keep: keep.sort(sorter(S, spec, ref)), rest };
}
const notin = (ref, keys) => ({ field: ref, op: 'notin', value: keys });

async function runView(src, raw, ctx = {}) {
  const S = src.schema, A = src.adapter;
  const spec = validate(S, raw);
  const { where, rangeRef, ignored } = contextWhere(S, spec, ctx);
  const ms = spec.measures;
  const agg = (dims, w = where, measures = ms) => A.aggregate(spec.base, { dims, measures, where: w });
  const out = {
    spec,
    measures: ms.map((m) => ({ label: measureLabel(S, spec.base, m), format: measureFormat(S, spec.base, m), additive: additive(m), fn: m.fn })),
    labels: { group: spec.group && resolve(S, spec.base, spec.group).label, split: spec.split && resolve(S, spec.base, spec.split).label, time: spec.time && resolve(S, spec.base, spec.time).label },
    ignored: ignored.map((f) => f.label || f.field),
    range: rangeRef ? { field: resolve(S, spec.base, rangeRef).label } : null,
  };
  const prevWhere = ctx.compare ? shiftRange(where) : null;

  const [tot] = await agg([]);
  out.rows = tot ? tot.n : 0;
  out.total = tot ? tot.vs : ms.map(() => null);
  if (prevWhere) { const [p] = await agg([], prevWhere); out.prevTotal = p ? p.vs : ms.map(() => null); }

  let shownGroups = null;
  if (spec.group) {
    const rows = await agg([{ ref: spec.group }]);
    const { keep, rest } = pickTop(S, spec, spec.group, rows, spec.top);
    out.groups = keep;
    shownGroups = keep.map((g) => g.key);
    out.groupCount = rows.length;
    if (rest.length && spec.other) {
      const [o] = await agg([], [...where, notin(spec.group, shownGroups)]);
      out.groups.push({ key: OTHER, values: o ? o.vs : ms.map(() => null), n: o ? o.n : 0, count: rest.length });
    }
    if (prevWhere) {
      const prev = new Map((await agg([{ ref: spec.group }], prevWhere, [ms[0]])).map((r) => [r.k[0], r.vs[0]]));
      for (const g of out.groups) if (g.key !== OTHER) g.prev = prev.get(g.key) ?? 0;
    }
  }

  let shownSplits = null;
  if (spec.split) {
    const rows = await agg([{ ref: spec.split }], where, [ms[0]]);
    const { keep, rest } = pickTop(S, { ...spec, sort: 'auto' }, spec.split, rows, spec.splitTop);
    shownSplits = keep.map((s) => s.key);
    out.splitKeys = rest.length && spec.other ? [...shownSplits, OTHER] : shownSplits;
    if (out.groups) {
      // every cell is measured directly, so averages and medians are right for "Other" too
      const cell = new Map();
      const put = (g, s, v) => cell.set(g + '\u0000' + s, v);
      for (const r of await agg([{ ref: spec.group }, { ref: spec.split }], where, [ms[0]])) put(r.k[0], r.k[1], r.vs[0]);
      const hasOtherGroup = out.groups.some((g) => g.key === OTHER);
      const hasOtherSplit = out.splitKeys.includes(OTHER);
      if (hasOtherSplit) for (const r of await agg([{ ref: spec.group }], [...where, notin(spec.split, shownSplits)], [ms[0]])) put(r.k[0], OTHER, r.vs[0]);
      if (hasOtherGroup) for (const r of await agg([{ ref: spec.split }], [...where, notin(spec.group, shownGroups)], [ms[0]])) put(OTHER, r.k[0], r.vs[0]);
      if (hasOtherGroup && hasOtherSplit) { const [r] = await agg([], [...where, notin(spec.group, shownGroups), notin(spec.split, shownSplits)], [ms[0]]); put(OTHER, OTHER, r ? r.vs[0] : null); }
      const empty = additive(ms[0]) || ms[0].fn === 'distinct' ? 0 : null;
      for (const g of out.groups) g.segs = out.splitKeys.map((s) => ({ key: s, value: cell.get(g.key + '\u0000' + s) ?? empty }));
    }
  }

  if (spec.time) out.time = await timeSeries(S, A, spec, where, rangeRef, ctx, { shownGroups, shownSplits, splitKeys: out.splitKeys, groups: out.groups });
  return out;
}

async function timeSeries(S, A, spec, where, rangeRef, ctx, shown) {
  const ms = spec.measures;
  const dimRef = spec.split || spec.group;
  // without a grouping, each measure is its own line and may use its own date (e.g. created vs resolved)
  const perMeasure = !dimRef && ms.length > 1;
  const refs = perMeasure ? ms.map((m) => m.time || spec.time) : [spec.time];
  let lo = null, hi = null;
  if (rangeRef && ctx.range && refs.every((r) => r === rangeRef)) {
    lo = ctx.range.from;
    hi = ctx.range.to;
    if (ctx.asOf && hi > ctx.asOf) hi = ctx.asOf;
  } else {
    for (const ref of new Set(refs)) {
      const sp = await A.span(spec.base, ref, where);
      if (sp && sp.lo) { lo = !lo || sp.lo < lo ? sp.lo : lo; hi = !hi || sp.hi > hi ? sp.hi : hi; }
    }
  }
  if (!lo) return null;
  const grain = spec.grain === 'auto' ? autoGrain(lo, hi) : spec.grain;
  const keys = bucketKeys(lo, hi, grain);
  const at = new Map(keys.map((k, i) => [k, i]));
  const notNull = (ref) => ({ field: ref, op: 'notempty' });
  const emptyOf = (m) => (additive(m) || m.fn === 'distinct' ? 0 : null);
  let series;
  if (perMeasure) {
    series = await Promise.all(ms.map(async (m, i) => {
      const ref = m.time || spec.time;
      const values = keys.map(() => emptyOf(m));
      for (const r of await A.aggregate(spec.base, { dims: [{ ref, grain }], measures: [m], where: [...where, notNull(ref)] })) if (at.has(r.k[0])) values[at.get(r.k[0])] = r.vs[0];
      return { key: 'm:' + i, measure: i, values };
    }));
  } else if (!dimRef) {
    const values = keys.map(() => emptyOf(ms[0]));
    for (const r of await A.aggregate(spec.base, { dims: [{ ref: spec.time, grain }], measures: [ms[0]], where: [...where, notNull(spec.time)] })) if (at.has(r.k[0])) values[at.get(r.k[0])] = r.vs[0];
    series = [{ key: '__all', values }];
  } else {
    const lines = spec.split ? shown.splitKeys : shown.groups.map((g) => g.key);
    const shownKeys = spec.split ? shown.shownSplits : shown.shownGroups;
    series = lines.map((k) => ({ key: k, values: keys.map(() => emptyOf(ms[0])) }));
    const byKey = new Map(series.map((s) => [s.key, s]));
    const rows = await A.aggregate(spec.base, { dims: [{ ref: spec.time, grain }, { ref: dimRef }], measures: [ms[0]], where: [...where, notNull(spec.time)] });
    for (const r of rows) {
      const s = byKey.get(r.k[1]);
      if (s && r.k[1] !== OTHER && at.has(r.k[0])) s.values[at.get(r.k[0])] = r.vs[0];
    }
    if (byKey.has(OTHER)) {
      const o = byKey.get(OTHER);
      for (const r of await A.aggregate(spec.base, { dims: [{ ref: spec.time, grain }], measures: [ms[0]], where: [...where, notNull(spec.time), notin(dimRef, shownKeys)] })) if (at.has(r.k[0])) o.values[at.get(r.k[0])] = r.vs[0];
    }
  }
  if (spec.cumulative) for (const s of series) { let run = 0; s.values = s.values.map((v) => (run += v || 0)); }
  return { grain, keys, series };
}

// ---- the rows behind a value someone clicked ----
// sel = { group, groupShown, split, splitShown, series, seriesShown, bucket, grain, measure }
function selectionWhere(S, spec, sel) {
  const c = [];
  const keys = (v) => (Array.isArray(v) ? v.map(String).slice(0, 300) : []);
  const match = (ref, key, shown) => {
    if (!ref || key === undefined || key === null) return;
    if (key === OTHER) c.push(notin(ref, keys(shown)));
    else c.push({ field: ref, op: 'in', value: [String(key)] });
  };
  match(spec.group, sel.group, sel.groupShown);
  match(spec.split, sel.split, sel.splitShown);
  const mi = Number.isInteger(sel.measure) && spec.measures[sel.measure] ? sel.measure : null;
  if (sel.series !== undefined && sel.series !== '__all' && !String(sel.series).startsWith('m:')) match(spec.split || spec.group, sel.series, sel.seriesShown);
  if (mi !== null) c.push(...spec.measures[mi].filters);
  if (sel.bucket && spec.time && GRAINS.includes(sel.grain)) {
    const ref = mi !== null && spec.measures[mi].time ? spec.measures[mi].time : spec.time;
    c.push({ field: ref, op: 'bucket', value: { grain: sel.grain, key: String(sel.bucket) } });
  }
  return c;
}

function defaultColumns(S, base) {
  const cols = fieldsOf(S, base).filter((f) => !f.hidden && !f.rollup).map((f) => f.col);
  for (const l of S.links) if (l.from === base && S.tables[l.to].display) cols.push(l.col + '.' + S.tables[l.to].display);
  return cols.slice(0, 24);
}

async function records(src, raw, ctx = {}, opts = {}) {
  const S = src.schema, A = src.adapter;
  const spec = validate(S, raw);
  const { where } = contextWhere(S, spec, ctx);
  where.push(...selectionWhere(S, spec, opts.sel || {}));
  let columns = Array.isArray(opts.columns) && opts.columns.length ? opts.columns.slice(0, 40).map(String) : defaultColumns(S, spec.base);
  columns = columns.filter((c) => { try { resolve(S, spec.base, c); return true; } catch (e) { return false; } });
  if (!columns.length) columns = defaultColumns(S, spec.base);
  const size = Math.min(500, Math.max(1, Number(opts.size) || 10));
  const page = Math.max(1, Number(opts.page) || 1);
  let sort = opts.sort && columns.includes(opts.sort) ? opts.sort : null;
  if (!sort) {
    const d = S.tables[spec.base].date;
    sort = d && columns.includes(d) ? d : columns[0];
  }
  const dir = opts.dir === 'asc' ? 'asc' : 'desc';
  const search = opts.search ? String(opts.search).slice(0, 100) : '';
  const res = await A.records(spec.base, { where, columns, sort, dir, search, offset: (page - 1) * size, limit: size });
  return {
    columns: columns.map((c) => { const r = resolve(S, spec.base, c); return { ref: c, label: r.label, type: r.type, format: r.field.format || '' }; }),
    sort, dir, page, size, total: res.total, rows: res.rows,
  };
}

// Values of a field with how often each appears, for filter lists.
async function values(src, base, ref, search) {
  const S = src.schema;
  if (!S.tables[base]) throw new Error('Unknown table');
  resolve(S, base, ref);
  const where = search ? [{ field: ref, op: 'contains', value: String(search).slice(0, 100) }] : [];
  const rows = await src.adapter.aggregate(base, { dims: [{ ref }], measures: [{ fn: 'count', field: '', filters: [] }], where });
  return rows.map((r) => ({ v: r.k[0], n: r.vs[0] })).sort((a, b) => b.n - a.n || String(a.v).localeCompare(String(b.v))).slice(0, 300);
}

module.exports = { FNS, USER_OPS, SORTS, validate, runView, records, values, contextWhere, mapFilter, selectionWhere, defaultColumns, measureLabel, NONE, OTHER };
