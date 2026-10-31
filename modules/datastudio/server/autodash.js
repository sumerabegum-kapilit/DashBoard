// Builds a starting dashboard for any source from its description alone: headline numbers,
// a trend, a chart for every field worth grouping by, a weekday-by-hour map and the records.
// People then change, move, resize or delete any of it.
const { fieldsOf, resolve } = require('./engine/schema');

let seq = 0;
const wid = () => 'w' + Date.now().toString(36) + (seq++).toString(36);
const W = (title, w, h, chart, spec, opts = {}) => ({ id: wid(), title, w, h, chart, spec, opts });

// The table most worth a dashboard: has a date, points at the most other tables, has the most rows.
function mainTable(S, counts) {
  return Object.keys(S.tables).sort((a, b) => {
    const score = (t) => (!S.tables[t].date ? 0 : S.tables[t].date.includes('.') ? 500 : 1000) +S.links.filter((l) => l.from === t).length * 100 + Math.log10((counts[t] || 0) + 1);
    return score(b) - score(a);
  })[0];
}

async function generate(src, counts, table) {
  const S = src.schema, A = src.adapter;
  const base = S.tables[table] ? table : mainTable(S, counts);
  const T = S.tables[base];
  const own = fieldsOf(S, base).filter((f) => !f.hidden);
  const count = { fn: 'count' };
  const widgets = [];

  // fields worth grouping by: few different values, from this table and the tables it points at
  const candidates = [];
  for (const f of own) if ((f.type === 'text' || f.type === 'bool') && !f.rollup) candidates.push(f.col);
  for (const l of S.links.filter((x) => x.from === base)) {
    const t = S.tables[l.to];
    if (t.display) candidates.push(`${l.col}.${t.display}`);
    for (const f of fieldsOf(S, l.to)) if (f.type === 'text' && !f.hidden && f.col !== t.display && !f.rollup) candidates.push(`${l.col}.${f.col}`);
  }
  // how many different values each has, asked all at once (large sources answer these in parallel)
  const sizes = await Promise.all(candidates.slice(0, 30).map(async (ref) => (await A.aggregate(base, { dims: [{ ref }], measures: [{ fn: 'count', filters: [] }], where: [] })).length));
  const groupable = candidates.slice(0, 30).map((ref, i) => ({ ref, n: sizes[i], type: resolve(S, base, ref).type })).filter((g) => g.n >= 2 && g.n <= 40);
  const bools = groupable.filter((g) => g.type === 'bool');
  const cats = groupable.filter((g) => g.type !== 'bool').sort((a, b) => a.n - b.n);
  const nums = own.filter((f) => f.type === 'number' && !f.rollup);

  // headline numbers
  const kpis = [W(T.label, 3, 2, 'kpi', { base, measures: [count] }, { good: 'up' })];
  for (const b of bools.slice(0, 2)) kpis.push(W(`${resolve(S, base, b.ref).label}`, 3, 2, 'kpi', { base, measures: [{ fn: 'rate', filters: [{ field: b.ref, op: 'is', value: 'Yes' }], label: `Share of ${T.label.toLowerCase()} where ${resolve(S, base, b.ref).label.toLowerCase()} is yes` }] }, { good: 'down' }));
  for (const f of nums) {
    if (kpis.length >= 4) break;
    kpis.push(W(`Average ${f.label.toLowerCase()}`, 3, 2, 'kpi', { base, measures: [{ fn: 'avg', field: f.col }] }, {}));
  }
  const kw = Math.floor(12 / kpis.length);
  kpis.forEach((k) => { k.w = kw; });
  widgets.push(...kpis);

  // trend, and the share of the best small grouping
  const date = T.date;
  const first = cats.find((c) => c.n <= 7);
  if (date) widgets.push(W(`${T.label} over time`, first ? 8 : 12, 4, first ? 't:stack' : 't:line', { base, measures: [count], time: date, ...(first ? { group: first.ref, top: 6 } : {}) }));
  if (first) widgets.push(W(`${T.label} by ${resolve(S, base, first.ref).label.toLowerCase()}`, date ? 4 : 6, 4, 'donut', { base, measures: [count], group: first.ref }));

  // one chart per remaining grouping
  const charts = ['bar', 'column', 'treemap', 'bar', 'lollipop', 'funnel'];
  cats.filter((c) => c !== first).slice(0, 6).forEach((c, i) => {
    const label = resolve(S, base, c.ref).label;
    const m = nums[i % Math.max(1, nums.length)];
    // every other chart shows an average of a number by the grouping, the rest count rows
    const spec = i % 2 === 1 && m ? { base, measures: [{ fn: 'avg', field: m.col }], group: c.ref, top: 10 } : { base, measures: [count], group: c.ref, top: 10 };
    const title = spec.measures[0].fn === 'avg' ? `Average ${m.label.toLowerCase()} by ${label.toLowerCase()}` : `${T.label} by ${label.toLowerCase()}`;
    widgets.push(W(title, 4, 4, c.n > 12 && charts[i % charts.length] === 'column' ? 'bar' : charts[i % charts.length], spec));
  });

  // when activity happens, if the date carries a time
  const df = date ? resolve(S, base, date).field : null;
  if (df && df.time) widgets.push(W(`When ${T.label.toLowerCase()} arrive`, 12, 4, 'matrix', { base, measures: [count], group: `${date}|weekday`, split: `${date}|hour`, splitTop: 24, other: false }));
  else if (date) widgets.push(W(`${T.label} by weekday`, 6, 4, 'column', { base, measures: [count], group: `${date}|weekday` }));

  // a breakdown table with several numbers side by side
  if (cats[0]) {
    const ms = [count, ...nums.slice(0, 3).map((f) => ({ fn: 'avg', field: f.col }))];
    widgets.push(W(`${T.label} by ${resolve(S, base, cats[0].ref).label.toLowerCase()}: summary`, 12, 5, 'pivot', { base, measures: ms, group: cats[0].ref, top: 25 }));
  }
  widgets.push(W(`All ${T.label.toLowerCase()}`, 12, 7, 'records', { base, measures: [count] }, { pageSize: 15 }));
  return { title: `${T.label} overview`, widgets };
}

module.exports = { generate, mainTable };
