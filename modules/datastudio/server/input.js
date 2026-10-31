// Turns what the host application passes in (table metadata, optionally rows) into the description the
// engine works with (engine/schema.js). This is the module's input contract; see README "Table metadata".
//
// {
//   id: 'sales', label: 'Sales', description: '...', asOf: '2026-10-30',
//   tables: [{
//     name: 'orders',                     identifier used in field paths: letters, digits, underscore
//     label: 'Orders',                    optional display name
//     sqlName: ['public', 'orders'],      optional, for SQL providers (default: name)
//     primaryKey: 'order_id',             optional
//     dateColumn: 'ordered_at',           optional: the date the dashboard period applies to
//     displayColumn: 'number',            optional: the column that names a row
//     columns: [{ name, type, label, format, hidden, time }],   type: text|number|date|bool or an SQL type name
//     foreignKeys: [{ column: 'customer_id', references: { table: 'customers', column: 'customer_id' } }],
//     rows: [...]                         optional: the rows, for the in-memory provider
//   }],
//   provider: memoryProvider(...) | postgresProvider({ query }) | sqliteProvider({ query }) | your own,
//   dashboards: [...]                     optional starting dashboards (else one is built from the data)
// }
const { pretty, TYPES } = require('./engine/schema');
const { MemoryAdapter } = require('./engine/memory');

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const FORMATS = ['', 'auto', 'int', 'dec', 'money', 'pct', 'hours', 'minutes', 'days'];

// text|number|date|bool, or the name of a database type
function typeOf(t) {
  const s = String(t || 'text').toLowerCase();
  if (TYPES.includes(s)) return { type: s, time: false };
  if (/bool/.test(s)) return { type: 'bool', time: false };
  if (/timestamp|datetime|time/.test(s)) return { type: 'date', time: true };
  if (/date/.test(s)) return { type: 'date', time: false };
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(s)) return { type: 'number', time: false };
  return { type: 'text', time: false };
}

function normalizeTables(tables) {
  if (!Array.isArray(tables) || !tables.length) throw new Error('A source needs at least one table');
  const raw = { tables: {}, links: [] };
  const rows = {};
  for (const t of tables) {
    if (!t || !NAME.test(t.name || '')) throw new Error(`Table names must be letters, digits and underscores: ${t && t.name}`);
    if (raw.tables[t.name]) throw new Error(`The table "${t.name}" is listed twice`);
    if (!Array.isArray(t.columns) || !t.columns.length) throw new Error(`The table "${t.name}" has no columns`);
    const fk = new Set((t.foreignKeys || []).map((f) => f.column));
    const fields = {};
    for (const c of t.columns) {
      const col = typeof c === 'string' ? { name: c } : c;
      if (!NAME.test(col.name || '')) throw new Error(`Column names must be letters, digits and underscores: ${t.name}.${col.name}`);
      const ty = typeOf(col.type);
      fields[col.name] = {
        label: col.label || pretty(col.name), type: ty.type, time: col.time ?? ty.time,
        format: FORMATS.includes(col.format) ? col.format : '',
        // columns that only point at other tables are hidden from field lists unless asked otherwise
        hidden: col.hidden ?? fk.has(col.name),
      };
    }
    const key = t.primaryKey && fields[t.primaryKey] ? t.primaryKey : null;
    const texts = Object.keys(fields).filter((c) => fields[c].type === 'text' && !fields[c].hidden);
    const dates = Object.keys(fields).filter((c) => fields[c].type === 'date');
    raw.tables[t.name] = {
      label: t.label || pretty(t.name), key, fields,
      sqlName: Array.isArray(t.sqlName) ? t.sqlName.map(String) : t.sqlName ? [String(t.sqlName)] : [t.name],
      display: (t.displayColumn && fields[t.displayColumn] && t.displayColumn) || ['name', 'title', 'label', 'number', 'code'].find((c) => texts.includes(c)) || texts[0] || null,
      date: t.dateColumn !== undefined ? t.dateColumn || null : dates.find((c) => /created|date|day|time|_at$/.test(c)) || dates[0] || null,
    };
    if (Array.isArray(t.rows)) rows[t.name] = t.rows;
  }
  for (const t of tables) {
    for (const f of t.foreignKeys || []) {
      const to = f.references && f.references.table;
      if (!raw.tables[t.name].fields[f.column] || !raw.tables[to] || !raw.tables[to].fields[f.references.column]) throw new Error(`Foreign key ${t.name}.${f.column} points at a column that is not listed`);
      raw.links.push({ from: t.name, col: f.column, to, toCol: f.references.column, name: f.name || pretty(f.column.replace(/_(id|key|code)$/, '')), reason: 'Foreign key in the database' });
    }
  }
  return { raw, rows: Object.keys(rows).length ? rows : null };
}

// ---- rows held in memory ----
const pad = (n) => String(n).padStart(2, '0');
function dateText(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}${v.getUTCHours() || v.getUTCMinutes() ? ` ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : ''}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}${m[4] !== undefined ? ` ${m[4]}:${m[5]}` : ''}` : null;
}
// Values as the in-memory engine expects them: numbers, booleans, 'YYYY-MM-DD[ HH:MM]' text, text.
function normalizeRows(raw, data) {
  const out = {};
  for (const [t, def] of Object.entries(raw.tables)) {
    const list = data[t] || [];
    if (!Array.isArray(list)) throw new Error(`The rows of "${t}" must be a list`);
    const cols = Object.entries(def.fields);
    out[t] = list.map((r) => {
      const o = {};
      for (const [c, f] of cols) {
        const v = r[c];
        if (v === null || v === undefined || v === '') { o[c] = null; continue; }
        o[c] = f.type === 'number' ? (Number.isFinite(Number(v)) ? Number(v) : null)
          : f.type === 'bool' ? (typeof v === 'boolean' ? v : /^(true|yes|y|1)$/i.test(String(v)))
            : f.type === 'date' ? dateText(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      return o;
    });
  }
  return out;
}

// The rows of every table, given by the host: { orders: [...], customers: [...] }
// (the service puts the values into the form the engine expects before the first query)
const memoryProvider = (rowsByTable = {}) => ({ kind: 'memory', data: rowsByTable, create(schema) { return new MemoryAdapter(schema, this.data); } });

module.exports = { normalizeTables, normalizeRows, memoryProvider, typeOf, FORMATS, NAME };
