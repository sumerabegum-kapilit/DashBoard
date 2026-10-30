// Runs the engine's primitives as SQL on a PostgreSQL database, and reads a database's tables,
// keys and foreign keys to describe it automatically. Sessions are read-only; every value a person
// types is a query parameter; table and column names only come from the database's own catalogue.
const { Pool, types } = require('pg');
const { resolve, binLabel, NONE, GRAINS, pretty } = require('./schema');

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const DIFF_SECONDS = { minutes: 60, hours: 3600, days: 86400 };

// Dates and timestamps stay text; numeric and bigint become numbers.
const TYPES = {
  getTypeParser: (oid, format) => {
    if (oid === 1082 || oid === 1114 || oid === 1184) return (v) => (v == null ? null : v.slice(0, 16));
    if (oid === 1700 || oid === 20) return (v) => (v == null ? null : Number(v));
    return types.getTypeParser(oid, format);
  },
};

function openPool(url, timezone = 'UTC') {
  if (!/^postgres(ql)?:\/\//.test(url || '')) throw new Error('That is not a PostgreSQL address (postgres://user:password@host:5432/database)');
  if (!/^[A-Za-z_+\-/0-9]+$/.test(timezone)) throw new Error('Unknown time zone');
  const pool = new Pool({ connectionString: url, max: 5, types: TYPES, options: `-c timezone=${timezone} -c default_transaction_read_only=on -c statement_timeout=30000` });
  pool.on('error', (err) => console.error('Database connection error:', err.message));
  return pool;
}

// Builds FROM + joins as fields are used; values become numbered parameters.
class Builder {
  constructor(S, base) {
    this.S = S;
    this.base = base;
    this.aliases = new Map([['', 't0']]);
    this.joins = [];
    this.params = [];
  }
  table(t) {
    const def = this.S.tables[t];
    return def.source ? `(${def.source})` : def.sqlName.map(q).join('.');
  }
  alias(hops) {
    const key = hops.join('.');
    if (this.aliases.has(key)) return this.aliases.get(key);
    const parent = this.alias(hops.slice(0, -1));
    let t = this.base;
    for (const fk of hops.slice(0, -1)) t = this.S.links.find((l) => l.from === t && l.col === fk).to;
    const link = this.S.links.find((l) => l.from === t && l.col === hops[hops.length - 1]);
    const a = 't' + this.aliases.size;
    this.aliases.set(key, a);
    this.joins.push(`LEFT JOIN ${this.table(link.to)} ${a} ON ${a}.${q(link.toCol)} = ${parent}.${q(link.col)}`);
    return a;
  }
  param(v) {
    this.params.push(v);
    return '$' + this.params.length;
  }
  column(table, col, a) {
    const def = this.S.tables[table];
    const f = def.fields[col];
    if (f && f.calc) return this.calc(f.calc, table, a);
    const r = this.S.rollups.find((x) => x.table === table && x.col === col);
    if (r) {
      if (r.sql) return r.sql(a);
      const v = r.fn === 'sum' ? `coalesce(sum(x.${q(r.field)}), 0)` : 'count(*)';
      return `(SELECT ${v} FROM ${this.table(r.from)} x WHERE x.${q(r.via)} = ${a}.${q(r.target || def.key)})`;
    }
    return `${a}.${q(col)}`;
  }
  calc(c, table, a) {
    const col = (x) => `${a}.${q(x)}`;
    if (c.kind === 'diff') return `round((extract(epoch FROM (${col(c.b)})::timestamp - (${col(c.a)})::timestamp) / ${DIFF_SECONDS[c.unit]})::numeric, 2)::float8`;
    if (c.kind === 'arith') {
      const side = (v) => (typeof v === 'number' ? `(${Number(v)})::float8` : `(${col(v)})::float8`);
      return c.op === '/' ? `(${side(c.a)} / nullif(${side(c.b)}, 0))` : `(${side(c.a)} ${c.op} ${side(c.b)})`;
    }
    if (c.kind === 'bins') {
      const x = `(${col(c.of)})::float8`;
      const edges = c.edges.slice().sort((p, n) => p - n);
      const arms = edges.map((e) => `WHEN ${x} < ${Number(e)} THEN ${lit(binLabel(edges, e - 1e-9))}`).join(' ');
      return `(CASE WHEN ${x} IS NULL THEN NULL ${arms} ELSE ${lit(binLabel(edges, edges[edges.length - 1]))} END)`;
    }
    if (c.kind === 'map') {
      const k = this.keyText(col(c.of), this.S.tables[table].fields[c.of].type);
      const arms = Object.entries(c.groups).map(([from, to]) => `WHEN ${k} = ${this.param(from)} THEN ${this.param(String(to))}`).join(' ');
      return `(CASE WHEN ${col(c.of)} IS NULL THEN NULL ${arms} ELSE ${c.rest ? this.param(c.rest) : k} END)`;
    }
    return 'NULL';
  }
  expr(ref) {
    const r = resolve(this.S, this.base, ref);
    let sql = this.column(r.table, r.col, this.alias(r.hops));
    const p = r.part;
    if (p === 'day') sql = `to_char(${sql}, 'YYYY-MM-DD')`;
    if (p === 'month') sql = `to_char(${sql}, 'YYYY-MM')`;
    if (p === 'quarter') sql = `to_char(${sql}, 'YYYY "Q"Q')`;
    if (p === 'year') sql = `to_char(${sql}, 'YYYY')`;
    if (p === 'weekday') sql = `trim(to_char(${sql}, 'Dy'))`;
    if (p === 'hour') sql = `to_char(${sql}, 'HH24')`;
    return { sql, type: r.type };
  }
  keyText(sql, type) {
    if (type === 'bool') return `(CASE WHEN (${sql}) IS NULL THEN '${NONE}' WHEN (${sql}) THEN 'Yes' ELSE 'No' END)`;
    if (type === 'date') return `coalesce(to_char(${sql}, 'YYYY-MM-DD'), '${NONE}')`;
    return `coalesce((${sql})::text, '${NONE}')`;
  }
  key(dim) {
    const e = this.expr(dim.ref);
    if (dim.grain) {
      if (!GRAINS.includes(dim.grain)) throw new Error('Unknown time step');
      return `coalesce(to_char(date_trunc('${dim.grain}', ${e.sql}), 'YYYY-MM-DD'), '${NONE}')`;
    }
    return this.keyText(e.sql, e.type);
  }
  cond(c) {
    const e = this.expr(c.field);
    const v = c.value;
    switch (c.op) {
      case 'empty': return `(${e.sql}) IS NULL`;
      case 'notempty': return `(${e.sql}) IS NOT NULL`;
      case 'in': return `${this.keyText(e.sql, e.type)} = ANY(${this.param(v)}::text[])`;
      case 'notin': return `${this.keyText(e.sql, e.type)} <> ALL(${this.param(v)}::text[])`;
      case 'bucket': return `to_char(date_trunc('${GRAINS.includes(v.grain) ? v.grain : 'day'}', ${e.sql}), 'YYYY-MM-DD') = ${this.param(v.key)}`;
      case 'between': return `(${e.sql})::date BETWEEN ${this.param(v[0])}::date AND ${this.param(v[1])}::date`;
      case 'contains': return `(${e.sql})::text ILIKE ${this.param('%' + String(v).replace(/[\\%_]/g, (m) => '\\' + m) + '%')}`;
      case 'is':
        if (e.type === 'bool') return `(${e.sql}) = ${this.param(v === 'Yes')}`;
        if (e.type === 'number') return `(${e.sql})::numeric = ${this.param(v)}::numeric`;
        if (e.type === 'date') return `(${e.sql})::date = ${this.param(v)}::date`;
        return `(${e.sql})::text = ${this.param(v)}`;
      case 'not':
        if (e.type === 'number') return `((${e.sql}) IS NULL OR (${e.sql})::numeric <> ${this.param(v)}::numeric)`;
        return `((${e.sql}) IS NULL OR (${e.sql})::text <> ${this.param(v)})`;
      case 'ge': case 'le': {
        const cmp = c.op === 'ge' ? '>=' : '<=';
        if (e.type === 'number') return `(${e.sql})::numeric ${cmp} ${this.param(v)}::numeric`;
        if (e.type === 'date') return `(${e.sql})::date ${cmp} ${this.param(v)}::date`;
        return `(${e.sql})::text ${cmp} ${this.param(v)}`;
      }
      default: throw new Error('Unknown filter');
    }
  }
  measure(m) {
    const f = (m.filters || []).map((c) => this.cond(c));
    const filt = f.length ? ` FILTER (WHERE ${f.join(' AND ')})` : '';
    if (m.fn === 'count') return `count(*)${filt}`;
    if (m.fn === 'rate') return `(count(*)${filt})::float8 / nullif(count(*), 0)`;
    const e = this.expr(m.field);
    if (m.fn === 'distinct') return `count(DISTINCT ${this.keyText(e.sql, e.type)})${filt}`;
    const v = `(${e.sql})::float8`;
    return { sum: `sum(${v})`, avg: `avg(${v})`, median: `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${v})`, min: `min(${v})`, max: `max(${v})` }[m.fn] + filt;
  }
  from() {
    return `FROM ${this.table(this.base)} t0 ${this.joins.join(' ')}`;
  }
}

class PostgresAdapter {
  constructor(schema, pool) {
    this.S = schema;
    this.pool = pool;
  }
  async query(text, params) {
    const { rows } = await this.pool.query(text, params);
    return rows;
  }
  async count(base) {
    const b = new Builder(this.S, base);
    return (await this.query(`SELECT count(*) AS n ${b.from()}`, []))[0].n;
  }
  // ---- profiling, for finding keys and relationships (server/relations.js); cols are stored columns ----
  async profile(table, cols) {
    const b = new Builder(this.S, table);
    const parts = cols.map((c, i) => `count(${q(c)}) AS f${i}, count(DISTINCT ${q(c)}) AS d${i}`);
    const [r] = await this.query(`SELECT count(*) AS n${parts.length ? ', ' + parts.join(', ') : ''} FROM ${b.table(table)} t0`, []);
    return { rows: Number(r.n), cols: Object.fromEntries(cols.map((c, i) => [c, { filled: Number(r['f' + i]), distinct: Number(r['d' + i]) }])) };
  }
  // how many of (up to `limit`) different values of from.col are found in to.toCol, compared as text
  async coverage(from, col, to, toCol, limit = 5000) {
    const b = new Builder(this.S, from);
    const [r] = await this.query(`SELECT count(*) AS n, count(h.x) AS hit
      FROM (SELECT DISTINCT (${q(col)})::text AS x FROM ${b.table(from)} s1 WHERE ${q(col)} IS NOT NULL LIMIT ${Number(limit)}) v
      LEFT JOIN (SELECT DISTINCT (${q(toCol)})::text AS x FROM ${b.table(to)} s2 WHERE ${q(toCol)} IS NOT NULL) h ON h.x = v.x`, []);
    return { values: Number(r.n), found: Number(r.hit) };
  }

  async aggregate(base, { dims = [], measures, where = [] }) {
    const b = new Builder(this.S, base);
    const keys = dims.map((d) => b.key(d));
    const ms = measures.map((m) => b.measure(m));
    const w = where.map((c) => b.cond(c));
    const select = [...keys.map((k, i) => `${k} AS k${i}`), ...ms.map((m, i) => `${m} AS v${i}`), 'count(*) AS n'].join(', ');
    const text = `SELECT ${select} ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ${keys.length ? 'GROUP BY ' + keys.map((k, i) => i + 1).join(', ') : ''}`;
    const rows = await this.query(text, b.params);
    return rows.map((r) => ({ k: keys.map((k, i) => r['k' + i]), vs: ms.map((m, i) => (r['v' + i] == null ? null : Number(r['v' + i]))), n: Number(r.n) }));
  }
  async span(base, ref, where = []) {
    const b = new Builder(this.S, base);
    const e = b.expr(ref).sql;
    const w = where.map((c) => b.cond(c));
    const [r] = await this.query(`SELECT to_char(min(${e}), 'YYYY-MM-DD') AS lo, to_char(max(${e}), 'YYYY-MM-DD') AS hi ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`, b.params);
    return r || { lo: null, hi: null };
  }
  async records(base, { where, columns, sort, dir, search, offset, limit }) {
    const b = new Builder(this.S, base);
    const exprs = columns.map((c) => b.expr(c));
    const w = where.map((c) => b.cond(c));
    if (search) {
      const p = b.param('%' + search.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
      w.push('(' + exprs.map((e) => `(${e.sql})::text ILIKE ${p}`).join(' OR ') + ')');
    }
    const s = exprs[columns.indexOf(sort)].sql;
    const text = `SELECT ${exprs.map((e, i) => `${e.sql} AS c${i}`).join(', ')}, count(*) OVER () AS total_rows ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY ${s} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    const rows = await this.query(text, b.params);
    return { total: rows[0] ? Number(rows[0].total_rows) : 0, rows: rows.map((r) => columns.map((c, i) => r['c' + i])) };
  }
}

// ---- reading a database's own description ----
const NUMBER = ['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'money'];
const DATE = ['date', 'timestamp without time zone', 'timestamp with time zone'];
const SECRET = /pass(word)?|hash|secret|token|salt|otp|api_?key|private/i;
const PERSONAL = /e_?mail|phone|mobile|address|birth|ssn|tax_?id/i;
const DISPLAY = ['name', 'title', 'full_name', 'display_name', 'label', 'username', 'number', 'code', 'key', 'subject'];
const DATE_PREF = /^(created(_at|_on)?|date|order_date|opened_at|start(ed)?_at|logged_date|day|timestamp)$/i;

async function introspect(pool, schemaName = 'public', meta = {}) {
  const cols = (await pool.query(`SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = $1 AND t.table_type IN ('BASE TABLE', 'VIEW') ORDER BY c.table_name, c.ordinal_position`, [schemaName])).rows;
  const cons = (await pool.query(`SELECT tc.constraint_name, tc.constraint_type, kcu.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    LEFT JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = $1 AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`, [schemaName])).rows;
  const byTable = new Map();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
    byTable.get(c.table_name).push(c);
  }
  const pk = new Map();
  const pkCols = new Map();
  for (const c of cons.filter((x) => x.constraint_type === 'PRIMARY KEY')) {
    if (!pkCols.has(c.constraint_name)) pkCols.set(c.constraint_name, []);
    pkCols.get(c.constraint_name).push(c);
  }
  for (const list of pkCols.values()) if (list.length === 1) pk.set(list[0].table_name, list[0].column_name);
  const fks = cons.filter((x) => x.constraint_type === 'FOREIGN KEY' && x.ref_table && pk.get(x.ref_table) === x.ref_col);
  const fkCols = new Set(fks.map((f) => f.table_name + '.' + f.column_name));

  const tables = {};
  for (const [name, list] of byTable) {
    const fields = {};
    for (const c of list) {
      if (c.column_name === pk.get(name) || fkCols.has(name + '.' + c.column_name) || SECRET.test(c.column_name)) continue;
      const type = NUMBER.includes(c.data_type) ? 'number' : DATE.includes(c.data_type) ? 'date' : c.data_type === 'boolean' ? 'bool'
        : ['text', 'character varying', 'character', 'uuid', 'USER-DEFINED', 'citext', 'name'].includes(c.data_type) ? 'text' : null;
      if (!type) continue;
      fields[c.column_name] = { label: pretty(c.column_name), type, time: c.data_type.startsWith('timestamp'), hidden: PERSONAL.test(c.column_name) || c.data_type === 'uuid' };
    }
    if (!Object.keys(fields).length && !pk.get(name)) continue;
    const textCols = Object.keys(fields).filter((k) => fields[k].type === 'text' && !fields[k].hidden);
    const dateCols = Object.keys(fields).filter((k) => fields[k].type === 'date');
    tables[name] = {
      label: pretty(name), sqlName: [schemaName, name], key: pk.get(name) || null,
      display: DISPLAY.find((d) => textCols.includes(d)) || textCols[0] || null,
      date: dateCols.find((d) => DATE_PREF.test(d)) || dateCols[0] || null,
      fields,
    };
  }
  const links = fks.filter((f) => tables[f.table_name] && tables[f.ref_table]).map((f) => ({ from: f.table_name, col: f.column_name, to: f.ref_table, name: pretty(f.column_name.replace(/_id$|id$/i, '') || f.ref_table) }));
  return { id: meta.id, label: meta.label || 'Database', description: meta.description || `PostgreSQL schema "${schemaName}", read automatically`, tables, links };
}

module.exports = { PostgresAdapter, Builder, openPool, introspect };
