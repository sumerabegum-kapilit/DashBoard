// The shape every data source is described in, whatever it is stored in.
//
// schema = {
//   tables: { [name]: { label, key: 'id', display: 'name', date: 'created_at', fields: { [col]: { label, type, format, hidden, time, calc } } } },
//   links:  [{ from, col, to, name }]            from.col points at to.key
//   rollups: [{ table, col, label, from, via, fn: 'count'|'sum', field }]   totals a row borrows from rows that point at it
// }
// Field types: text, number, date (may carry a time), bool.
// A reference to a field from a starting table is a path of link columns: "customer_id.region",
// optionally with a date part after a bar: "created_at|month".

const TYPES = ['text', 'number', 'date', 'bool'];
const PARTS = ['day', 'month', 'quarter', 'year', 'weekday', 'hour'];
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_HOPS = 3;
const NONE = '(none)';
const OTHER = '__other';

const pretty = (s) => {
  const t = String(s).replace(/_id$/, '').replace(/[_.]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// The links the engine follows. A link goes from a column to a column whose values are unique
// (the other table's key, or any unique column such as customers.customer_id).
// Links come from the source itself (database foreign keys, declared links) unless hidden in the model,
// plus the relationships people confirmed or drew (server/relations.js) that can be followed:
// many-to-one or one-to-one. Many-to-many relationships are kept for the model view only.
const sigOf = (r) => `${r.from}.${r.col}>${r.to}.${r.toCol}`;
const FOLLOWED = ['N:1', '1:1'];
function modelLinks(raw, model = {}) {
  const hidden = new Set(model.dismissed || []);
  const out = [];
  for (const l of raw.links || []) {
    const t = raw.tables[l.to];
    const link = { ...l, toCol: l.toCol || (t && t.key) || 'id' };
    if (!hidden.has(sigOf(link))) out.push(link);
  }
  for (const r of model.rels || []) {
    if (r.status === 'active' && FOLLOWED.includes(r.cardinality) && r.usable !== false) out.push({ from: r.from, col: r.col, to: r.to, toCol: r.toCol, name: r.name });
  }
  return out;
}

// Fills defaults, adds automatic totals and calculated fields, and checks that every link is sound.
// model: { removed: [tables left out], rels: [...], dismissed: [...] } (server/relations.js)
function finalize(raw, overrides = {}, model = {}) {
  const S = { id: raw.id, label: raw.label, description: raw.description || '', tables: {}, links: [], rollups: [] };
  const removed = new Set(model.removed || []);
  for (const [name, t] of Object.entries(raw.tables)) {
    if (removed.has(name)) continue;
    const o = (overrides.tables || {})[name] || {};
    const fields = {};
    for (const [col, f] of Object.entries(t.fields)) {
      const fo = (o.fields || {})[col] || {};
      const type = TYPES.includes(fo.type) ? fo.type : TYPES.includes(f.type) ? f.type : 'text';
      fields[col] = { label: fo.label || f.label || pretty(col), type, format: fo.format || f.format || '', hidden: fo.hidden ?? !!f.hidden, time: !!f.time };
    }
    for (const c of o.calcs || []) {
      if (!fields[c.col] && checkCalc(c, fields)) fields[c.col] = { label: c.label || pretty(c.col), type: calcType(c), format: c.format || '', hidden: false, time: false, calc: c };
    }
    S.tables[name] = {
      label: o.label || t.label || pretty(name),
      key: t.key === null ? null : t.key || 'id',
      display: (o.display && fields[o.display] ? o.display : t.display) || null,
      date: (o.date !== undefined ? o.date : t.date) || null,
      source: t.source || null, // SQL for a table that is a query (Postgres only)
      displaySql: t.displaySql || null,
      sqlName: t.sqlName || null,
      fields,
    };
  }
  for (const l of modelLinks(raw, model)) {
    if (!S.tables[l.from] || !S.tables[l.to] || !l.toCol) continue;
    // one link per column: a path names the column it follows
    if (S.links.some((x) => x.from === l.from && x.col === l.col)) continue;
    S.links.push({ from: l.from, col: l.col, to: l.to, toCol: l.toCol, name: l.name || pretty(l.col) });
  }
  const auto = raw.autoRollups !== false;
  const declared = raw.rollups || [];
  for (const r of declared) if (S.tables[r.table]) S.rollups.push({ ...r, type: 'number' });
  if (auto) {
    for (const l of S.links) {
      if (l.from === l.to) continue;
      const col = `n__${l.from}__${l.col}`;
      if (S.rollups.some((r) => r.table === l.to && r.from === l.from && r.via === l.col && r.fn === 'count')) continue;
      const sameTarget = S.links.filter((x) => x.from === l.from && x.to === l.to).length > 1;
      const label = `Number of ${S.tables[l.from].label.toLowerCase()}${sameTarget ? ` (as ${l.name.toLowerCase()})` : ''}`;
      S.rollups.push({ table: l.to, col, label, from: l.from, via: l.col, target: l.toCol, fn: 'count', type: 'number' });
    }
  }
  return S;
}

// ---- calculated fields: small, safe formulas over columns of the same table ----
// { col, label, kind: 'diff', a, b, unit: 'minutes'|'hours'|'days' }      b minus a, for two dates
// { col, label, kind: 'arith', a, op: '+'|'-'|'*'|'/', b }              a and b are number columns or numbers
// { col, label, kind: 'bins', of, edges: [4, 24, 72] }                    a number put into ranges
// { col, label, kind: 'map', of, groups: { value: group }, rest: 'Other' } text values renamed or merged
const CALC_KINDS = ['diff', 'arith', 'bins', 'map'];
const calcType = (c) => (c.kind === 'bins' || c.kind === 'map' ? 'text' : 'number');
function checkCalc(c, fields) {
  if (!c || !CALC_KINDS.includes(c.kind) || !/^[a-z][a-z0-9_]{0,40}$/.test(c.col || '')) return false;
  const is = (col, type) => fields[col] && !fields[col].calc && fields[col].type === type;
  const numOrConst = (v) => (typeof v === 'number' && Number.isFinite(v)) || is(v, 'number');
  if (c.kind === 'diff') return is(c.a, 'date') && is(c.b, 'date') && ['minutes', 'hours', 'days'].includes(c.unit);
  if (c.kind === 'arith') return numOrConst(c.a) && numOrConst(c.b) && ['+', '-', '*', '/'].includes(c.op);
  if (c.kind === 'bins') return is(c.of, 'number') && Array.isArray(c.edges) && c.edges.length > 0 && c.edges.length <= 12 && c.edges.every((e) => Number.isFinite(e));
  if (c.kind === 'map') return (is(c.of, 'text') || is(c.of, 'number') || is(c.of, 'bool')) && c.groups && typeof c.groups === 'object' && Object.keys(c.groups).length <= 200;
  return false;
}
const fmtEdge = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
function binLabel(edges, v) {
  if (v == null || Number.isNaN(v)) return null;
  const e = edges.slice().sort((a, b) => a - b);
  if (v < e[0]) return `under ${fmtEdge(e[0])}`;
  for (let i = 1; i < e.length; i++) if (v < e[i]) return `${fmtEdge(e[i - 1])}–${fmtEdge(e[i])}`;
  return `${fmtEdge(e[e.length - 1])}+`;
}
// Sort order for bins, so "under 4" comes before "4–24".
const binOrder = (edges) => {
  const e = edges.slice().sort((a, b) => a - b);
  return [`under ${fmtEdge(e[0])}`, ...e.slice(1).map((x, i) => `${fmtEdge(e[i])}–${fmtEdge(x)}`), `${fmtEdge(e[e.length - 1])}+`];
};

function fieldsOf(S, table) {
  const t = S.tables[table];
  const own = Object.entries(t.fields).map(([col, f]) => ({ col, ...f }));
  for (const r of S.rollups) if (r.table === table) own.push({ col: r.col, label: r.label, type: 'number', format: r.format || '', rollup: r });
  return own;
}
const fieldIndex = new WeakMap();
function fieldOf(S, table, col) {
  let m = fieldIndex.get(S);
  if (!m) { m = new Map(); fieldIndex.set(S, m); }
  const k = table + '\u0000' + col;
  if (!m.has(k)) m.set(k, fieldsOf(S, table).find((f) => f.col === col) || null);
  return m.get(k);
}

// Follows a reference like "ticket_id.customer_id.region|month" from a starting table.
function resolve(S, base, ref) {
  if (typeof ref !== 'string' || !ref) throw new Error('A field is missing');
  if (!S.tables[base]) throw new Error('Unknown table: ' + base);
  const [path, part] = ref.split('|');
  if (part && !PARTS.includes(part)) throw new Error('Unknown date part: ' + part);
  const steps = path.split('.');
  if (steps.length > MAX_HOPS + 1) throw new Error(`Fields can be at most ${MAX_HOPS} links away`);
  const col = steps.pop();
  let table = base;
  for (const fk of steps) {
    const link = S.links.find((l) => l.from === table && l.col === fk);
    if (!link) throw new Error('Unknown link: ' + fk);
    table = link.to;
  }
  const field = fieldOf(S, table, col);
  if (!field) throw new Error('Unknown field: ' + col);
  if (part && field.type !== 'date') throw new Error('Only dates can be split into days, months, years or weekdays');
  // "Customer › Customer" reads as just "Customer" when the field is what names the linked row
  const names = linkNames(S, base, steps);
  const own = names.length && col === S.tables[table].display ? [] : [field.label];
  const label = [...names, ...own].join(' › ') + (part ? ` (${part})` : '');
  return { table, hops: steps, col, field, part: part || null, type: part ? 'text' : field.type, label };
}
function linkNames(S, base, hops) {
  const out = [];
  let t = base;
  for (const fk of hops) {
    const l = S.links.find((x) => x.from === t && x.col === fk);
    out.push(l.name);
    t = l.to;
  }
  return out;
}

// Shortest chain of links from one table to another (following links forward only).
function pathTo(S, from, to, maxHops = MAX_HOPS) {
  if (from === to) return [];
  const queue = [[from, []]];
  const seen = new Set([from]);
  while (queue.length) {
    const [t, hops] = queue.shift();
    if (hops.length >= maxHops) continue;
    for (const l of S.links) {
      if (l.from !== t || seen.has(l.to)) continue;
      const next = [...hops, l.col];
      if (l.to === to) return next;
      seen.add(l.to);
      queue.push([l.to, next]);
    }
  }
  return null;
}

// ---- date helpers shared by the engine and the in-memory adapter (dates are 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM') ----
const DAY = 864e5;
const day = (s) => String(s).slice(0, 10);
const toDate = (s) => new Date(day(s) + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
function weekday(s) { return WEEKDAYS[(toDate(s).getUTCDay() + 6) % 7]; }
function partOf(v, part) {
  if (v == null || v === '') return null;
  const s = String(v);
  switch (part) {
    case 'day': return day(s);
    case 'month': return s.slice(0, 7);
    case 'quarter': return `${s.slice(0, 4)} Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year': return s.slice(0, 4);
    case 'weekday': return weekday(s);
    case 'hour': return s.length >= 13 ? s.slice(11, 13) : '00';
    default: return s;
  }
}
function bucketOf(v, grain) {
  if (v == null || v === '') return null;
  const d = toDate(v);
  if (grain === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (grain === 'month') d.setUTCDate(1);
  else if (grain === 'quarter') { d.setUTCDate(1); d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3); }
  else if (grain === 'year') { d.setUTCDate(1); d.setUTCMonth(0); }
  return iso(d);
}
function stepBucket(k, grain) {
  const d = toDate(k);
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return iso(d);
}
function bucketKeys(lo, hi, grain) {
  const keys = [];
  for (let k = bucketOf(lo, grain); k <= day(hi) && keys.length < 2000; k = stepBucket(k, grain)) keys.push(k);
  return keys;
}
function autoGrain(lo, hi) {
  const days = (toDate(hi) - toDate(lo)) / DAY + 1;
  return days <= 31 ? 'day' : days <= 150 ? 'week' : days <= 800 ? 'month' : 'quarter';
}
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// Group keys sort by the order their meaning has (weekdays, hours, months, ranges), else by value.
function keyOrder(S, base, ref) {
  const order = naturalOrder(S, base, ref);
  // empty values always come last
  return order && ((a, b) => (a === NONE) - (b === NONE) || order(a, b));
}
function naturalOrder(S, base, ref) {
  const r = resolve(S, base, ref);
  if (r.part === 'weekday') return (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b);
  if (r.part || r.field.type === 'date') return (a, b) => String(a).localeCompare(String(b));
  if (r.field.calc && r.field.calc.kind === 'bins') { const o = binOrder(r.field.calc.edges); return (a, b) => o.indexOf(a) - o.indexOf(b); }
  if (r.field.type === 'number') return (a, b) => Number(a) - Number(b);
  return null;
}

// What a client needs to know about a source: tables, fields, links.
function publicSchema(S, counts = {}) {
  return {
    id: S.id, label: S.label, description: S.description,
    tables: Object.fromEntries(Object.entries(S.tables).map(([k, t]) => [k, {
      label: t.label, key: t.key, display: t.display, date: t.date, rows: counts[k] ?? null,
      fields: fieldsOf(S, k).map((f) => ({ col: f.col, label: f.label, type: f.type, format: f.format, hidden: !!f.hidden, time: !!f.time, rollup: !!f.rollup, calc: f.calc || null })),
    }])),
    links: S.links.map((l) => ({ ...l })),
    parts: PARTS, grains: GRAINS, maxHops: MAX_HOPS,
  };
}

module.exports = {
  sigOf, modelLinks, FOLLOWED,
  TYPES, PARTS, GRAINS, WEEKDAYS, MAX_HOPS, NONE, OTHER, CALC_KINDS,
  pretty, finalize, fieldsOf, fieldOf, resolve, pathTo, publicSchema, checkCalc, binLabel, keyOrder,
  day, partOf, bucketOf, bucketKeys, autoGrain, addDays,
};
