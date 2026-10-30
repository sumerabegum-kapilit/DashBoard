// Imports large files (hundreds of MB) without holding them in memory:
// the request body is streamed to a file on disk, read once to work out column types,
// then read again and written in batches into an SQLite database the engine queries on disk.
// Each upload is a job whose progress the browser polls.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setImmediate: yieldNow } = require('timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { pretty } = require('./engine/schema');

const BATCH = 5000;
const MAX_COLUMNS = 200;
const jobs = new Map();

// ---- receiving: the body goes straight to disk, with a size limit ----
function receive(req, dir, maxBytes, job) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `incoming-${crypto.randomBytes(8).toString('hex')}.part`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let bytes = 0;
    const fail = (err) => { req.unpipe(out); out.destroy(); fs.rm(file, { force: true }, () => {}); reject(err); };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      job.received = bytes;
      if (bytes > maxBytes) { req.destroy(); fail(new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB (MAX_UPLOAD_MB)`)); }
    });
    req.on('aborted', () => fail(new Error('The upload was interrupted')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => (bytes ? resolve({ file, bytes }) : fail(new Error('The file is empty'))));
    req.pipe(out);
  });
}

// ---- reading rows from a file as a stream ----
// CSV (comma, semicolon or tab, quoted fields may hold separators and line breaks); the header is the first row
async function* csvRows(file, onBytes) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let sep = null, row = [], cell = '', quoted = false, afterQuote = false, read = 0, first = true;
  const finishRow = function* () {
    row.push(cell);
    cell = '';
    if (row.length > 1 || row[0] !== '') yield row;
    row = [];
  };
  for await (let chunk of stream) {
    read += Buffer.byteLength(chunk);
    onBytes(read);
    if (first) {
      chunk = chunk.replace(/^﻿/, '');
      const line = chunk.split(/\r?\n/, 1)[0];
      const count = (c) => line.split(c).length - 1;
      sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
      first = false;
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (quoted) {
        if (ch === '"') { quoted = false; afterQuote = true; } else cell += ch;
        continue;
      }
      if (ch === '"') { if (afterQuote) cell += '"'; quoted = true; afterQuote = false; continue; }
      afterQuote = false;
      if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') yield* finishRow();
      else if (ch !== '\r') cell += ch;
    }
  }
  if (cell !== '' || row.length) yield* finishRow();
}
// Turns CSV rows into objects keyed by tidy column names.
async function* csvObjects(file, onBytes) {
  let cols = null;
  for await (const r of csvRows(file, onBytes)) {
    if (!cols) { cols = tidyNames(r); continue; }
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i] === undefined ? '' : r[i].trim();
    yield o;
  }
}

// JSON: a list of objects ([{...}, {...}]) or one object per line. Each object is cut out of the
// stream by counting braces, so the whole file is never one string.
async function* jsonObjects(file, onBytes) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let depth = 0, inStr = false, esc = false, buf = '', read = 0;
  for await (const chunk of stream) {
    read += Buffer.byteLength(chunk);
    onBytes(read);
    let start = depth > 0 ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { if (depth > 0) inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const text = buf + chunk.slice(start, i + 1);
          buf = '';
          start = -1;
          let o;
          try { o = JSON.parse(text); } catch (e) { throw new Error('The JSON could not be read near: ' + text.slice(0, 80)); }
          yield Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));
        }
      }
    }
    if (depth > 0) buf += chunk.slice(start < 0 ? 0 : start);
  }
}

const colName = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40);
function tidyNames(head) {
  const seen = new Map();
  return head.map((h, i) => {
    const base = colName(h) || 'column_' + (i + 1);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
}

// ---- values ----
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const p2 = (n) => String(n).padStart(2, '0');
function toDateText(v) {
  const m = DATE_RE.exec(String(v).trim());
  if (!m) return null;
  return `${m[1]}-${p2(m[2])}-${p2(m[3])}` + (m[4] !== undefined ? ` ${p2(m[4])}:${m[5]}` : '');
}
const BOOLS = { true: true, false: false, yes: true, no: false, y: true, n: false };
// 1500, -2.5, 1,500.25 (thousands commas) or 1,5 (decimal comma)
const PLAIN = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i, THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/, DECIMAL_COMMA = /^-?\d+,\d+$/;
const isNum = (v) => typeof v === 'number' || [PLAIN, THOUSANDS, DECIMAL_COMMA].some((re) => re.test(String(v).trim()));
function numOf(v) {
  if (typeof v === 'number') return v;
  const t = String(v).trim();
  return THOUSANDS.test(t) ? Number(t.replace(/,/g, '')) : DECIMAL_COMMA.test(t) ? Number(t.replace(',', '.')) : Number(t);
}
const blank = (v) => v === '' || v === null || v === undefined;
// key and link columns stay text, so they always match the rows they point at
const isKeyCol = (c) => c === 'id' || /_id$/.test(c);

// First pass: what type each column holds, and whether "id" can be kept as the row key.
async function profile(rows, job) {
  const cols = new Map();
  let idFilled = true, n = 0;
  for await (const r of rows) {
    n++;
    for (const [c, v] of Object.entries(r)) {
      let p = cols.get(c);
      if (!p) {
        if (cols.size >= MAX_COLUMNS || !/^[a-z]/.test(c)) continue;
        p = { filled: 0, num: true, bool: true, date: true, time: false, distinct: new Set() };
        cols.set(c, p);
      }
      if (blank(v)) continue;
      p.filled++;
      if (p.distinct && p.distinct.add(String(v).slice(0, 60)).size > 50) p.distinct = null;
      if (p.bool && !(typeof v === 'boolean' || Object.prototype.hasOwnProperty.call(BOOLS, String(v).toLowerCase()))) p.bool = false;
      if (p.num && !isNum(v)) p.num = false;
      if (p.date) { const d = toDateText(v); if (!d) p.date = false; else if (d.length > 10) p.time = true; }
    }
    if (idFilled && blank(r.id)) idFilled = false;
    if (n % BATCH === 0) { job.rows = n; await yieldNow(); }
  }
  if (!n) throw new Error('The file has no rows');
  const fields = {};
  for (const [c, p] of cols) {
    if (c === 'id') continue;
    const type = isKeyCol(c) ? 'text' : !p.filled ? 'text' : p.bool ? 'bool' : p.num ? 'number' : p.date ? 'date' : 'text';
    fields[c] = { label: pretty(c), type, time: type === 'date' && p.time, hidden: isKeyCol(c) };
    if (type === 'number' && p.distinct && p.distinct.size <= 12) fields[c].format = 'int';
  }
  // whether the ids are also unique is checked in the database after loading
  return { fields, n, keepId: idFilled && cols.has('id') };
}

function convert(v, type) {
  if (blank(v)) return null;
  if (type === 'number') { const x = numOf(v); return Number.isFinite(x) ? x : null; }
  if (type === 'bool') return (typeof v === 'boolean' ? v : BOOLS[String(v).toLowerCase()]) ? 1 : 0;
  if (type === 'date') return toDateText(v);
  return String(v);
}

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const sqlTable = (name) => 't_' + name;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return db;
}

// Second pass: create the table and write the rows in batches.
async function load(db, name, rows, prof, job) {
  const cols = Object.keys(prof.fields);
  const T = q(sqlTable(name));
  db.exec(`DROP TABLE IF EXISTS ${T}`);
  db.exec(`CREATE TABLE ${T} (id TEXT, ${cols.map((c) => q(c)).join(', ')})`);
  const ins = db.prepare(`INSERT INTO ${T} (id, ${cols.map(q).join(', ')}) VALUES (${['?', ...cols.map(() => '?')].join(', ')})`);
  const types = cols.map((c) => prof.fields[c].type);
  let n = 0;
  db.exec('BEGIN');
  try {
    for await (const r of rows) {
      n++;
      const vals = [prof.keepId ? String(r.id) : String(n)];
      for (let i = 0; i < cols.length; i++) vals.push(convert(r[cols[i]], types[i]));
      ins.run(...vals);
      if (n % BATCH === 0) {
        db.exec('COMMIT');
        job.rows = n;
        await yieldNow();
        if (job.cancelled) throw new Error('Cancelled');
        db.exec('BEGIN');
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (err) { /* already closed */ }
    throw e;
  }
  job.rows = n;
  job.state = 'indexing';
  await yieldNow();
  // the file's own ids are kept only when every row has a different one; otherwise rows are numbered
  let keptId = prof.keepId;
  if (prof.keepId) {
    const [r] = db.prepare(`SELECT count(*) - count(DISTINCT id) AS dup FROM ${T}`).all();
    if (r.dup) { db.exec(`UPDATE ${T} SET id = CAST(rowid AS TEXT)`); keptId = false; }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ${q('ix_' + name + '_id')} ON ${T} (id)`);
  for (const c of cols) if (isKeyCol(c)) db.exec(`CREATE INDEX IF NOT EXISTS ${q('ix_' + name + '_' + c)} ON ${T} (${q(c)})`);
  db.exec('ANALYZE');
  return { rows: n, keptId };
}

// Imports one file as table `name` into the source folder `dir` (data.sqlite + schema.json).
async function importFile(job, { file, format, dir, name, label }) {
  const db = openDb(path.join(dir, 'data.sqlite'));
  try {
    const rows = () => (format === 'json' ? jsonObjects(file, (b) => { job.read = b; }) : csvObjects(file, (b) => { job.read = b; }));
    job.state = 'reading';
    const prof = await profile(rows(), job);
    job.total = prof.n;
    job.state = 'importing';
    job.read = 0;
    const loaded = await load(db, name, rows(), prof, job);
    const schemaFile = path.join(dir, 'schema.json');
    const schema = fs.existsSync(schemaFile) ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : { tables: {}, links: [] };
    const fields = prof.fields;
    const texts = Object.keys(fields).filter((k) => fields[k].type === 'text' && !fields[k].hidden);
    const dates = Object.keys(fields).filter((k) => fields[k].type === 'date');
    schema.tables[name] = {
      // without an "id" column of its own, a table's key is just the row number
      label: pretty(label || name), key: 'id', syntheticKey: !loaded.keptId, sqlName: [sqlTable(name)], fields,
      display: ['name', 'title', 'label', 'number', 'code', 'subject'].find((k) => texts.includes(k)) || texts[0] || null,
      date: dates.find((k) => /created|date|day|time/.test(k)) || dates[0] || null,
    };
    // relationships between files are found afterwards and offered for review (server/relations.js)
    schema.links = schema.links || [];
    const labels = Object.values(schema.tables).map((t) => t.label);
    schema.description = `Uploaded files: ${labels.length > 6 ? `${labels.length} tables (${labels.slice(0, 5).join(', ')} and ${labels.length - 5} more)` : labels.join(', ')}.`;
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 1));
    return schema;
  } finally {
    db.close();
  }
}

// ---- jobs the browser can follow ----
function newJob(meta) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, state: 'receiving', received: 0, size: meta.size || null, read: 0, rows: 0, total: null, error: null, sourceId: null, started: Date.now() };
  jobs.set(id, job);
  // finished jobs are forgotten after an hour
  setTimeout(() => jobs.delete(id), 3600_000).unref();
  return job;
}
const jobOf = (id) => {
  const j = jobs.get(id);
  if (!j) throw new Error('Unknown upload');
  return j;
};

module.exports = { receive, importFile, newJob, jobOf, openDb, colName, sqlTable, csvObjects, jsonObjects };
