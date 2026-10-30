// The data sources the studio can show: the built-in dummy data sets, files people upload (CSV or JSON),
// and PostgreSQL databases people connect. Each source is described the same way (engine/schema.js)
// and answers the same questions (engine/engine.js), so every dashboard feature works on every source.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { finalize, pretty, checkCalc, resolve, TYPES } = require('./engine/schema');
const { MemoryAdapter } = require('./engine/memory');
const { PostgresAdapter, openPool, introspect } = require('./engine/postgres');
const { SqliteAdapter } = require('./engine/sqlite');
const importer = require('./importer');
const relations = require('./relations');
const { todayUtc } = require('./demo/rand');

const DEMOS = [require('./demo/helpdesk'), require('./demo/sales')];
const FILE = path.join(path.dirname(config.stateFile), 'sources.json');
const UPLOADS = path.join(path.dirname(config.stateFile), 'uploads');
const ID = /^[a-z][a-z0-9_-]{1,40}$/;

const sources = new Map();
// sources people added, their description edits, and each source's relationship model (relations.js)
let saved = { sources: [], overrides: {}, models: {} };
let writing = Promise.resolve();

function persist() {
  const body = JSON.stringify(saved, null, 1);
  writing = writing.then(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', body);
    fs.renameSync(FILE + '.tmp', FILE);
  }).catch((err) => console.error('Could not save sources:', err.message));
  return writing;
}

const modelOf = (id) => relations.normalize(saved.models[id]);
function build(src) {
  src.schema = finalize({ ...src.raw, id: src.id, label: src.label }, saved.overrides[src.id] || {}, modelOf(src.id));
  // a table's period date may run through a link that is no longer there
  for (const [t, def] of Object.entries(src.schema.tables)) {
    if (!def.date) continue;
    let ok = false;
    try { ok = resolve(src.schema, t, def.date).type === 'date'; } catch (e) { /* not reachable any more */ }
    if (!ok) def.date = null;
  }
  if (src.adapter && src.adapter.close) src.adapter.close();
  src.adapter = src.kind === 'postgres' ? new PostgresAdapter(src.schema, src.pool)
    : src.kind === 'upload' ? new SqliteAdapter(src.schema, path.join(src.dir, 'data.sqlite'))
      : new MemoryAdapter(src.schema, src.data);
  src.counts = null;
  // answers are cached per version; any change to the source or its description starts a new one
  src.version = (src.version || 0) + 1;
  return src;
}

function addDemo(mod) {
  const today = todayUtc();
  const src = { id: mod.schema.id, label: mod.schema.label, kind: 'demo', raw: mod.schema, data: mod.generate(today), asOf: today, builtAt: today };
  sources.set(src.id, build(src));
  src.refresh = () => { if (todayUtc() !== src.builtAt) { src.builtAt = src.asOf = todayUtc(); src.data = mod.generate(src.asOf); build(src); } };
}

async function addPostgres(def) {
  const pool = openPool(def.url, def.timezone || config.timezone);
  try {
    const raw = await introspect(pool, def.schemaName || 'public', def);
    if (!Object.keys(raw.tables).length) throw new Error('No tables could be read in that schema');
    const src = { id: def.id, label: def.label, kind: 'postgres', raw, pool, asOf: todayUtc(), schemaName: def.schemaName || 'public' };
    sources.set(src.id, build(src));
    return src;
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
}

// An uploaded source is a folder: data.sqlite holds the rows, schema.json describes them.
function addUpload(def) {
  const dir = path.join(UPLOADS, def.id);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'));
  const old = sources.get(def.id);
  const src = old && old.kind === 'upload' && !old.broken ? Object.assign(old, { raw, label: def.label }) : { id: def.id, label: def.label, kind: 'upload', raw, dir, asOf: todayUtc() };
  sources.set(src.id, build(src));
  return src;
}
// Uploads saved by an earlier version as one JSON file are moved into the folder form once.
async function migrateUpload(def) {
  const old = path.join(UPLOADS, def.id + '.json');
  if (!fs.existsSync(old) || fs.existsSync(path.join(UPLOADS, def.id, 'schema.json'))) return;
  const body = JSON.parse(fs.readFileSync(old, 'utf8'));
  const dir = path.join(UPLOADS, def.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(body.data)) {
    const tmp = path.join(dir, name + '.ndjson');
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
    await importer.importFile(importer.newJob({}), { file: tmp, format: 'json', dir, name, label: body.schema.tables[name].label });
    fs.rmSync(tmp);
  }
  fs.renameSync(old, old + '.migrated');
}

async function load() {
  for (const m of DEMOS) addDemo(m);
  try { saved = { sources: [], overrides: {}, models: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { /* first start */ }
  for (const def of saved.sources) {
    try {
      if (def.kind === 'upload') { await migrateUpload(def); addUpload(def); }
      else if (def.kind === 'postgres') await addPostgres(def);
    } catch (e) {
      console.error(`Could not open the source "${def.label}":`, e.message);
      sources.set(def.id, { id: def.id, label: def.label, kind: def.kind, broken: e.message });
    }
  }
}

function get(id) {
  const src = sources.get(id);
  if (!src) throw new Error('Unknown data source');
  if (src.broken) throw new Error(`That source could not be opened: ${src.broken}`);
  if (src.refresh) src.refresh();
  return src;
}

async function counts(src) {
  if (!src.counts || Date.now() - src.counts.at > 60_000) {
    const c = {};
    await Promise.all(Object.keys(src.schema.tables).map(async (t) => { c[t] = await src.adapter.count(t); }));
    src.counts = { at: Date.now(), c };
  }
  return src.counts.c;
}

const list = () => [...sources.values()].map((s) => ({
  id: s.id, label: s.label, kind: s.kind, broken: s.broken || null,
  description: s.schema ? s.schema.description : '', tables: s.schema ? Object.keys(s.schema.tables).length : 0, asOf: s.asOf || null,
}));

function newId(label) {
  const base = (String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source').slice(0, 30);
  let id = /^[a-z]/.test(base) ? base : 's-' + base;
  for (let i = 2; sources.has(id); i++) id = `${base}-${i}`;
  return id;
}

// ---- files people upload ----
// The browser sends the file itself as the request body; it is saved to disk, then imported in the
// background. The answer is a job id the browser polls for progress (importer.js).
function startUpload(req, query) {
  const format = query.format === 'json' || /\.(json|ndjson|jsonl)$/i.test(query.filename || '') ? 'json' : 'csv';
  const name = importer.colName(query.table || String(query.filename || '').replace(/\.[^.]+$/, '') || query.label || 'data') || 'data';
  const into = query.sourceId ? saved.sources.find((s) => s.id === query.sourceId && s.kind === 'upload') : null;
  if (query.sourceId && !into) throw new Error('Files can only be added to an uploaded source');
  // the same table is not imported twice unless replacing it is asked for
  if (into && sources.get(into.id) && sources.get(into.id).raw.tables[name] && query.replace !== '1') {
    throw new Error(`A table called "${name}" is already in this source. Choose "Replace" to load it again.`);
  }
  const declared = Number(req.headers['content-length']) || null;
  const max = config.maxUploadMb * 1048576;
  if (declared && declared > max) throw new Error(`The file is larger than ${config.maxUploadMb} MB (MAX_UPLOAD_MB)`);
  const job = importer.newJob({ size: declared });
  (async () => {
    let incoming = null;
    try {
      incoming = await importer.receive(req, UPLOADS, max, job);
      const def = into || { id: newId(query.label || name), kind: 'upload', label: String(query.label || pretty(name)).slice(0, 60) };
      const dir = path.join(UPLOADS, def.id);
      fs.mkdirSync(dir, { recursive: true });
      await importer.importFile(job, { file: incoming.file, format, dir, name, label: query.table || name });
      if (!into) { saved.sources.push(def); await persist(); }
      const src = addUpload(def);
      // relationships are looked for after each file, unless several files come at once (detect=0):
      // then the browser asks once at the end
      if (query.detect !== '0') { job.state = 'relating'; await setModel(src, await relations.detect(src, modelOf(src.id))); }
      job.sourceId = def.id;
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
      if (!/larger than|interrupted|empty|header|no rows|JSON|Cancelled/.test(e.message)) console.error('Upload failed:', e);
    } finally {
      if (incoming) fs.rm(incoming.file, { force: true }, () => {});
    }
  })();
  return job;
}

async function connect({ label, url, schemaName }) {
  const def = { id: newId(label || 'database'), kind: 'postgres', label: String(label || 'Database').slice(0, 60), url: String(url || ''), schemaName: /^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName || '') ? schemaName : 'public' };
  const src = await addPostgres(def);
  saved.sources.push(def);
  await persist();
  return src;
}

async function remove(id) {
  const def = saved.sources.find((s) => s.id === id);
  if (!def) throw new Error('Only sources you added can be removed');
  const src = sources.get(id);
  if (src && src.pool) await src.pool.end().catch(() => {});
  if (src && src.adapter && src.adapter.close) await src.adapter.close();
  sources.delete(id);
  saved.sources = saved.sources.filter((s) => s.id !== id);
  delete saved.overrides[id];
  delete saved.models[id];
  if (def.kind === 'upload') fs.rmSync(path.join(UPLOADS, id), { recursive: true, force: true });
  await persist();
}

// ---- edits to how a source is described: names, types, formats, hidden fields, calculated fields ----
const FORMATS = ['', 'auto', 'int', 'dec', 'money', 'pct', 'hours', 'minutes', 'days'];
async function setOverrides(id, body) {
  const src = get(id);
  const out = { tables: {} };
  for (const [t, o] of Object.entries((body && body.tables) || {})) {
    const raw = src.raw.tables[t];
    if (!raw || !o || typeof o !== 'object') continue;
    const clean = {};
    if (o.label) clean.label = String(o.label).slice(0, 60);
    if (o.date !== undefined) clean.date = o.date ? String(o.date) : null;
    if (o.display && (raw.fields[o.display] || (o.calcs || []).some((c) => c.col === o.display))) clean.display = o.display;
    clean.fields = {};
    for (const [col, f] of Object.entries(o.fields || {})) {
      if (!raw.fields[col] || !f) continue;
      const cf = {};
      if (f.label) cf.label = String(f.label).slice(0, 60);
      if (TYPES.includes(f.type)) cf.type = f.type;
      if (FORMATS.includes(f.format)) cf.format = f.format;
      if (typeof f.hidden === 'boolean') cf.hidden = f.hidden;
      clean.fields[col] = cf;
    }
    const fieldsNow = Object.fromEntries(Object.entries(raw.fields).map(([c, f]) => [c, { ...f, ...(clean.fields[c] || {}) }]));
    clean.calcs = (Array.isArray(o.calcs) ? o.calcs.slice(0, 30) : []).filter((c) => !raw.fields[c.col] && checkCalc(c, fieldsNow)).map((c) => ({ ...c, label: String(c.label || c.col).slice(0, 60) }));
    out.tables[t] = clean;
  }
  saved.overrides[id] = out;
  build(src);
  // a table's period date can be any date field reachable from it; drop it if it no longer resolves to a date
  let fixed = false;
  for (const [t, def] of Object.entries(src.schema.tables)) {
    if (!def.date) continue;
    let ok = false;
    try { ok = resolve(src.schema, t, def.date).type === 'date'; } catch (e) { /* not a field any more */ }
    if (!ok) { out.tables[t] = { ...(out.tables[t] || {}), date: null }; fixed = true; }
  }
  if (fixed) build(src);
  await persist();
  return src;
}

// ---- the relationship model ----
async function setModel(src, model) {
  saved.models[src.id] = model;
  build(src);
  await persist();
  return src;
}
async function modelView(src) {
  return relations.describe(src, modelOf(src.id), await counts(src));
}
// One entry point for every change to the model; each returns the model as the browser sees it.
async function changeModel(id, action, body = {}) {
  const src = get(id);
  const m = modelOf(id);
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const names = Array.isArray(body.tables) ? body.tables.map(String) : [];
  let next;
  switch (action) {
    case 'detect': next = await relations.detect(src, m); break;
    case 'create': next = (await relations.create(src, m, body)).model; break;
    case 'edit': next = (await relations.edit(src, m, String(body.id), body)).model; break;
    case 'confirm': next = relations.confirm(m, ids); break;
    case 'delete': next = relations.remove(src, m, ids); break;
    case 'unhide': next = relations.unhide(m, Array.isArray(body.sigs) ? body.sigs.map(String) : []); break;
    case 'remove-tables': next = relations.removeTables(src, m, names); break;
    case 'restore-tables': next = relations.restoreTables(m, names); break;
    case 'layout': next = relations.setLayout(m, body.positions); break;
    default: throw new Error('Unknown change');
  }
  await setModel(src, next);
  return action === 'layout' ? { saved: true } : modelView(src);
}

module.exports = { load, get, list, counts, startUpload, jobOf: importer.jobOf, connect, remove, setOverrides, overridesOf: (id) => saved.overrides[id] || { tables: {} }, FORMATS, modelView, changeModel };
