// A data provider for SQLite: the engine's primitives written as SQL. It opens no files: the host passes
// its own `query(sql, params)`, where params is an object of named parameters ({ p1: ..., p2: ... },
// written $p1, $p2 in the SQL). Medians use an aggregate function the host registers once on its connection
// with sqliteFunctions(db) (node:sqlite and better-sqlite3 both work).
// Values are expected as text dates ('YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'), numbers, 1/0 for yes/no, and text.
const { resolve, binLabel, NONE, GRAINS } = require('../engine/schema');

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const DIFF = { minutes: 1440, hours: 24, days: 1 };
const WEEKDAY = `CASE strftime('%w', X) WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue' WHEN '3' THEN 'Wed' WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' WHEN '6' THEN 'Sat' END`;

class Builder {
  constructor(S, base) {
    this.S = S;
    this.base = base;
    this.aliases = new Map([['', 't0']]);
    this.joins = [];
    this.params = {};
    this.n = 0;
  }
  table(t) { return this.S.tables[t].sqlName.map(q).join('.'); }
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
    const k = 'p' + ++this.n;
    this.params[k] = v;
    return '$' + k;
  }
  column(table, col, a) {
    const def = this.S.tables[table];
    const f = def.fields[col];
    if (f && f.calc) return this.calc(f.calc, table, a);
    const r = this.S.rollups.find((x) => x.table === table && x.col === col);
    if (r) {
      const v = r.fn === 'sum' ? `coalesce(sum(x.${q(r.field)}), 0)` : 'count(*)';
      return `(SELECT ${v} FROM ${this.table(r.from)} x WHERE x.${q(r.via)} = ${a}.${q(r.target || def.key)})`;
    }
    return `${a}.${q(col)}`;
  }
  calc(c, table, a) {
    const col = (x) => `${a}.${q(x)}`;
    if (c.kind === 'diff') return `round((julianday(${col(c.b)}) - julianday(${col(c.a)})) * ${DIFF[c.unit]}, 2)`;
    if (c.kind === 'arith') {
      const side = (v) => (typeof v === 'number' ? `(${Number(v)})` : `CAST(${col(v)} AS REAL)`);
      return c.op === '/' ? `(${side(c.a)} / nullif(${side(c.b)}, 0))` : `(${side(c.a)} ${c.op} ${side(c.b)})`;
    }
    if (c.kind === 'bins') {
      const x = col(c.of);
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
    switch (r.part) {
      case 'day': sql = `substr(${sql}, 1, 10)`; break;
      case 'month': sql = `substr(${sql}, 1, 7)`; break;
      case 'year': sql = `substr(${sql}, 1, 4)`; break;
      case 'quarter': sql = `(substr(${sql}, 1, 4) || ' Q' || ((CAST(substr(${sql}, 6, 2) AS INTEGER) + 2) / 3))`; break;
      case 'weekday': sql = `(${WEEKDAY.replace(/X/g, `substr(${sql}, 1, 10)`)})`; break;
      case 'hour': sql = `(CASE WHEN ${sql} IS NULL THEN NULL WHEN length(${sql}) >= 13 THEN substr(${sql}, 12, 2) ELSE '00' END)`; break;
      default: break;
    }
    return { sql, type: r.type };
  }
  keyText(sql, type) {
    if (type === 'bool') return `(CASE WHEN (${sql}) IS NULL THEN '${NONE}' WHEN (${sql}) THEN 'Yes' ELSE 'No' END)`;
    if (type === 'date') return `coalesce(substr(${sql}, 1, 10), '${NONE}')`;
    // whole numbers read "4", not "4.0", as in the other adapters
    if (type === 'number') return `(CASE WHEN (${sql}) IS NULL THEN '${NONE}' WHEN (${sql}) = CAST((${sql}) AS INTEGER) THEN CAST(CAST((${sql}) AS INTEGER) AS TEXT) ELSE CAST((${sql}) AS TEXT) END)`;
    return `coalesce(CAST(${sql} AS TEXT), '${NONE}')`;
  }
  bucket(sql, grain) {
    if (!GRAINS.includes(grain)) throw new Error('Unknown time step');
    const d = `substr(${sql}, 1, 10)`;
    if (grain === 'day') return d;
    if (grain === 'week') return `date(${d}, '-' || ((CAST(strftime('%w', ${d}) AS INTEGER) + 6) % 7) || ' days')`;
    if (grain === 'month') return `(substr(${sql}, 1, 7) || '-01')`;
    if (grain === 'quarter') return `(substr(${sql}, 1, 4) || '-' || printf('%02d', ((CAST(substr(${sql}, 6, 2) AS INTEGER) - 1) / 3) * 3 + 1) || '-01')`;
    return `(substr(${sql}, 1, 4) || '-01-01')`;
  }
  key(dim) {
    const e = this.expr(dim.ref);
    if (dim.grain) return `coalesce(${this.bucket(e.sql, dim.grain)}, '${NONE}')`;
    return this.keyText(e.sql, e.type);
  }
  cond(c) {
    const e = this.expr(c.field);
    const v = c.value;
    const s = e.sql;
    switch (c.op) {
      case 'empty': return `(${s}) IS NULL`;
      case 'notempty': return `(${s}) IS NOT NULL`;
      case 'in': return `${this.keyText(s, e.type)} IN (SELECT value FROM json_each(${this.param(JSON.stringify(v))}))`;
      case 'notin': return `${this.keyText(s, e.type)} NOT IN (SELECT value FROM json_each(${this.param(JSON.stringify(v))}))`;
      case 'bucket': return `${this.bucket(s, v.grain)} = ${this.param(v.key)}`;
      case 'between': return `substr(${s}, 1, 10) BETWEEN ${this.param(v[0])} AND ${this.param(v[1])}`;
      case 'contains': return `instr(lower(CAST(${s} AS TEXT)), lower(${this.param(String(v))})) > 0`;
      case 'is':
        if (e.type === 'bool') return `(${s}) = ${v === 'Yes' ? 1 : 0}`;
        if (e.type === 'number') return `(${s}) = CAST(${this.param(v)} AS REAL)`;
        if (e.type === 'date') return `substr(${s}, 1, 10) = ${this.param(v)}`;
        return `CAST(${s} AS TEXT) = ${this.param(v)}`;
      case 'not':
        if (e.type === 'number') return `((${s}) IS NULL OR (${s}) <> CAST(${this.param(v)} AS REAL))`;
        return `((${s}) IS NULL OR CAST(${s} AS TEXT) <> ${this.param(v)})`;
      case 'ge': case 'le': {
        const cmp = c.op === 'ge' ? '>=' : '<=';
        if (e.type === 'number') return `(${s}) IS NOT NULL AND (${s}) ${cmp} CAST(${this.param(v)} AS REAL)`;
        if (e.type === 'date') return `substr(${s}, 1, 10) ${cmp} ${this.param(v)}`;
        return `CAST(${s} AS TEXT) ${cmp} ${this.param(v)}`;
      }
      default: throw new Error('Unknown filter');
    }
  }
  measure(m) {
    const f = (m.filters || []).map((c) => this.cond(c));
    const filt = f.length ? ` FILTER (WHERE ${f.join(' AND ')})` : '';
    if (m.fn === 'count') return `count(*)${filt}`;
    if (m.fn === 'rate') return `CAST(count(*)${filt} AS REAL) / nullif(count(*), 0)`;
    const e = this.expr(m.field);
    if (m.fn === 'distinct') return `count(DISTINCT ${this.keyText(e.sql, e.type)})${filt}`;
    const v = `CAST(${e.sql} AS REAL)`;
    return { sum: `sum(${v})`, avg: `avg(${v})`, median: `median_of(${v})`, min: `min(${v})`, max: `max(${v})` }[m.fn] + filt;
  }
  from() { return `FROM ${this.table(this.base)} t0 ${this.joins.join(' ')}`; }
}

class SqliteAdapter {
  constructor(schema, query) {
    this.S = schema;
    this.run = query;
  }
  async all(text, params) {
    const rows = await this.run(text, params);
    return Array.isArray(rows) ? rows : [];
  }
  async count(base) {
    const b = new Builder(this.S, base);
    return Number((await this.all(`SELECT count(*) AS n ${b.from()}`, {}))[0].n);
  }
  // ---- profiling, for finding keys and relationships (server/relations.js); cols are stored columns ----
  async profile(table, cols) {
    const b = new Builder(this.S, table);
    const parts = cols.map((c, i) => `count(${q(c)}) AS f${i}, count(DISTINCT ${q(c)}) AS d${i}`);
    const [r] = await this.all(`SELECT count(*) AS n${parts.length ? ', ' + parts.join(', ') : ''} FROM ${b.table(table)} t0`, {});
    return { rows: Number(r.n), cols: Object.fromEntries(cols.map((c, i) => [c, { filled: Number(r['f' + i]), distinct: Number(r['d' + i]) }])) };
  }
  // how many of (up to `limit`) different values of from.col are found in to.toCol, compared as text
  async coverage(from, col, to, toCol, limit = 5000) {
    const b = new Builder(this.S, from);
    const [r] = await this.all(`SELECT count(*) AS n, count(h.x) AS hit
      FROM (SELECT DISTINCT CAST(${q(col)} AS TEXT) AS x FROM ${b.table(from)} s1 WHERE ${q(col)} IS NOT NULL LIMIT ${Number(limit)}) v
      LEFT JOIN (SELECT DISTINCT CAST(${q(toCol)} AS TEXT) AS x FROM ${b.table(to)} s2 WHERE ${q(toCol)} IS NOT NULL) h ON h.x = v.x`, {});
    return { values: Number(r.n), found: Number(r.hit) };
  }

  async aggregate(base, { dims = [], measures, where = [] }) {
    const b = new Builder(this.S, base);
    const keys = dims.map((d) => b.key(d));
    const ms = measures.map((m) => b.measure(m));
    const w = where.map((c) => b.cond(c));
    const select = [...keys.map((k, i) => `${k} AS k${i}`), ...ms.map((m, i) => `${m} AS v${i}`), 'count(*) AS n'].join(', ');
    const text = `SELECT ${select} ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ${keys.length ? 'GROUP BY ' + keys.map((k, i) => i + 1).join(', ') : ''}`;
    return (await this.all(text, b.params)).map((r) => ({ k: keys.map((k, i) => String(r['k' + i])), vs: ms.map((m, i) => (r['v' + i] == null ? null : Number(r['v' + i]))), n: Number(r.n) }));
  }
  async span(base, ref, where = []) {
    const b = new Builder(this.S, base);
    const e = b.expr(ref).sql;
    const w = where.map((c) => b.cond(c));
    const [r] = await this.all(`SELECT min(substr(${e}, 1, 10)) AS lo, max(substr(${e}, 1, 10)) AS hi ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`, b.params);
    return r ? { lo: r.lo, hi: r.hi } : { lo: null, hi: null };
  }
  async records(base, { where, columns, sort, dir, search, offset, limit }) {
    const b = new Builder(this.S, base);
    const exprs = columns.map((c) => b.expr(c));
    const w = where.map((c) => b.cond(c));
    if (search) {
      const p = b.param(search);
      w.push('(' + exprs.map((e) => `instr(lower(CAST(${e.sql} AS TEXT)), lower(${p})) > 0`).join(' OR ') + ')');
    }
    const pos = columns.indexOf(sort) + 1;
    const text = `SELECT ${exprs.map((e, i) => `${e.sql} AS c${i}`).join(', ')}, count(*) OVER () AS total_rows ${b.from()} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY ${pos} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    const rows = await this.all(text, b.params);
    return {
      total: rows[0] ? Number(rows[0].total_rows) : 0,
      rows: rows.map((r) => exprs.map((e, i) => { const v = r['c' + i]; return v == null ? null : e.type === 'bool' ? !!v : v; })),
    };
  }
}

// median_of(x) for the host's SQLite connection
function sqliteFunctions(db) {
  db.aggregate('median_of', {
    start: () => [],
    step: (acc, v) => { if (v !== null && v !== undefined) acc.push(Number(v)); return acc; },
    result: (acc) => {
      if (!acc.length) return null;
      acc.sort((a, b) => a - b);
      const h = (acc.length - 1) / 2;
      return (acc[Math.floor(h)] + acc[Math.ceil(h)]) / 2;
    },
  });
  return db;
}

const sqliteProvider = ({ query }) => {
  if (typeof query !== 'function') throw new Error('sqliteProvider needs a query(sql, params) function');
  return { kind: 'sqlite', create: (schema) => new SqliteAdapter(schema, query) };
};

module.exports = { sqliteProvider, sqliteFunctions, SqliteAdapter, Builder };
