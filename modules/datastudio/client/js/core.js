// Shared pieces of the studio: the open source and its description, talking to the server,
// number formats, field lists that follow links, and small DOM helpers.
import { get, post, put } from './api.js';
import { d3, mk, button } from './util.js';

export const app = { source: null, schema: null, sources: [], editing: false, root: document, options: {} };
// An element of the studio by its id, looked up inside the element the studio is mounted in.
export const $ = (id) => app.root.querySelector('#ds-' + id);
// What may this person change on the open source? (decided by the host, see README "Permissions")
export const can = (what) => !!(app.schema && app.schema.can && app.schema.can[what]);

// ---- where the studio is: "/<source>/<page>", kept in the address (#/...) or only in memory ----
export const nav = {
  mode: 'hash', path: '/', listeners: new Set(),
  get() { return this.mode === 'hash' ? (location.hash.replace(/^#/, '') || '/') : this.path; },
  href(p) { return this.mode === 'hash' ? '#' + p : '#'; },
  go(p) {
    if (this.mode === 'hash') { if (location.hash === '#' + p) this.emit(); else location.hash = p; return; }
    this.path = p;
    this.emit();
  },
  emit() { for (const f of this.listeners) f(this.get()); },
};
// A link that moves the studio without leaving the host's page.
export function link(text, p) {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = nav.href(p);
  a.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey || e.button) return; e.preventDefault(); nav.go(p); });
  return a;
}

// ---- server ----
const results = new Map();
export async function query(spec, ctx) {
  const key = app.source + JSON.stringify([spec, ctx]);
  if (!results.has(key)) {
    const p = post(`/sources/${app.source}/query`, { spec, ctx });
    results.set(key, p);
    p.catch(() => results.delete(key));
  }
  return results.get(key);
}
export const records = (body) => post(`/sources/${app.source}/records`, body);
export const valuesOf = (base, field, search) => post(`/sources/${app.source}/values`, { base, field, search });
export const clearResults = () => results.clear();
export async function loadSchema(id) {
  app.schema = await get(`/sources/${id}/schema`, { fresh: true });
  app.source = id;
  fieldCache.clear();
  clearResults();
  return app.schema;
}
export { get, post, put };

// ---- formats ----
const fInt = d3.format(',.0f');
const f1 = d3.format(',.1f');
const f2 = d3.format(',.2f');
const compact = (v) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
export const FORMATS = [['auto', 'Automatic'], ['int', 'Whole number'], ['dec', 'One decimal'], ['money', 'Money'], ['pct', 'Percent'], ['hours', 'Hours'], ['minutes', 'Minutes'], ['days', 'Days']];
export function fmt(kind, opts = {}) {
  const big = (v, f) => (opts.short && Math.abs(v) >= 10000 ? compact(v) : f(v));
  switch (kind) {
    case 'int': return (v) => big(v, fInt);
    case 'dec': return (v) => big(v, Math.abs(v) < 10 ? f2 : f1);
    case 'money': return (v) => '$' + big(v, Math.abs(v) >= 1000 ? fInt : f2);
    case 'pct': return (v) => (Math.abs(v) < 0.1 ? d3.format('.1%')(v) : d3.format('.0%')(v));
    case 'hours': return (v) => big(v, Math.abs(v) < 10 ? f1 : fInt) + ' h';
    case 'minutes': return (v) => (Math.abs(v) >= 120 ? f1(v / 60) + ' h' : fInt(v) + ' min');
    case 'days': return (v) => big(v, f1) + ' d';
    default: return (v) => big(v, Number.isInteger(v) ? fInt : Math.abs(v) < 10 ? f2 : f1);
  }
}
export const show = (f) => (v) => (v == null || Number.isNaN(v) ? '—' : f(v));

// ---- fields reachable from a table, following links up to two steps ----
const fieldCache = new Map();
export function fieldsFrom(base, depth = 2) {
  const ck = base + depth;
  if (fieldCache.has(ck)) return fieldCache.get(ck);
  const S = app.schema;
  const out = [];
  const walk = (t, prefix, names, d, seen) => {
    const group = names.length ? names.join(' › ') : S.tables[t].label;
    for (const f of S.tables[t].fields) {
      const ownName = names.length && f.col === S.tables[t].display;
      out.push({ path: prefix + f.col, label: [...names, ...(ownName ? [] : [f.label])].join(' › '), short: ownName ? names[names.length - 1] : f.label, type: f.type, format: f.format, hidden: f.hidden, time: f.time, rollup: f.rollup, group, table: t, depth: d });
    }
    if (d >= depth) return;
    for (const l of S.links) {
      if (l.from !== t || seen.includes(l.to)) continue;
      walk(l.to, prefix + l.col + '.', [...names, l.name], d + 1, [...seen, l.to]);
    }
  };
  walk(base, '', [], 0, [base]);
  fieldCache.set(ck, out);
  return out;
}
export function fieldOf(base, ref) {
  if (!ref) return null;
  const [path, part] = String(ref).split('|');
  const f = fieldsFrom(base, 3).find((x) => x.path === path);
  return f ? { ...f, part: part || null, label: f.label + (part ? ` (${PART_LABEL[part] || part})` : ''), type: part ? 'text' : f.type } : null;
}
export const PART_LABEL = { day: 'day', month: 'month', quarter: 'quarter', year: 'year', weekday: 'weekday', hour: 'hour of day' };
export const labelOf = (base, ref) => (fieldOf(base, ref) || {}).label || ref;

// Options for a field select, grouped by table. accept(f) decides which fields fit; parts adds date parts.
export function fieldOptions(base, accept = () => true, { parts = false, hidden = false } = {}) {
  const groups = new Map();
  for (const f of fieldsFrom(base)) {
    if ((f.hidden && !hidden) || !accept(f)) continue;
    if (!groups.has(f.group)) groups.set(f.group, []);
    const items = groups.get(f.group);
    items.push([f.path, f.short]);
    if (parts && f.type === 'date') for (const p of ['day', 'weekday', 'month', 'quarter', 'year', ...(f.time ? ['hour'] : [])]) items.push([f.path + '|' + p, `${f.short} (${PART_LABEL[p]})`]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

export const keyLabel = (k) => (k === '__other' ? 'Other' : k === '__all' ? 'All' : String(k));

// ---- small DOM helpers ----
export function select(options, value, onChange, opts = {}) {
  const s = document.createElement('select');
  if (opts.label) s.setAttribute('aria-label', opts.label);
  if (opts.blank !== undefined) s.append(new Option(opts.blank, ''));
  for (const o of options) {
    if (o.group) {
      const g = document.createElement('optgroup');
      g.label = o.group;
      for (const [v, t] of o.items) g.append(new Option(t, v));
      s.append(g);
    } else s.append(new Option(o[1], o[0]));
  }
  s.value = value == null ? '' : String(value);
  if (s.value !== String(value ?? '') && value) { s.append(new Option(String(value), value)); s.value = value; }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
export function input(type, value, onChange, opts = {}) {
  const i = document.createElement('input');
  i.type = type;
  i.value = value == null ? '' : value;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  if (opts.label) i.setAttribute('aria-label', opts.label);
  for (const k of ['min', 'max', 'step']) if (opts[k] !== undefined) i[k] = opts[k];
  i.addEventListener(opts.live ? 'input' : 'change', () => onChange(i.value));
  return i;
}
export function check(label, value, onChange) {
  const l = mk('label', 'check');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  l.append(i, mk('span', null, label));
  return l;
}
export function row(label, ...controls) {
  const l = mk('div', 'frow');
  l.append(mk('span', 'flabel', label), ...controls);
  return l;
}
export { mk, button };
export const uid = (p = 'w') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const clone = (o) => JSON.parse(JSON.stringify(o));
