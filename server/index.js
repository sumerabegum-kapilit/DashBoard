const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const sources = require('./sources');
const engine = require('./engine/engine');
const { publicSchema } = require('./engine/schema');
const autodash = require('./autodash');
const presets = require('./demo/presets');

const app = express();
app.disable('x-powered-by');

// Small helper: run an async handler and turn errors into a JSON message.
// Errors from a database carry a code and are logged; anything else is a message for the person.
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    const fromDb = !!err.code;
    if (fromDb) console.error(req.method, req.originalUrl, err);
    res.status(fromDb ? 500 : 400).json({ error: fromDb ? 'The database query failed. See the server log for details.' : err.message });
  }
};

// The file itself is the request body (any size up to MAX_UPLOAD_MB), so it is not parsed as JSON here.
// Details come in the address: ?filename=&label=&table=&sourceId=&format=
app.post('/api/sources/upload', handle((req) => ({ job: sources.startUpload(req, req.query).id })));
app.get('/api/jobs/:id', handle((req) => sources.jobOf(req.params.id)));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', handle(() => ({ ok: true })));

// ---- data sources ----
app.get('/api/sources', handle(() => sources.list()));
app.post('/api/sources/connect', handle(async (req) => {
  const src = await sources.connect(req.body || {});
  return { id: src.id };
}));
app.delete('/api/sources/:id', handle(async (req) => { await sources.remove(req.params.id); return { removed: true }; }));

const ctxOf = (src, body) => {
  const c = (body && body.ctx) || {};
  return { range: c.range || null, filters: Array.isArray(c.filters) ? c.filters : [], compare: !!c.compare, asOf: src.asOf };
};
app.get('/api/s/:id/schema', handle(async (req) => {
  const src = sources.get(req.params.id);
  return { ...publicSchema(src.schema, await sources.counts(src)), kind: src.kind, asOf: src.asOf, overrides: sources.overridesOf(src.id), formats: sources.FORMATS, maxUploadMb: config.maxUploadMb };
}));
// The relationship model (Power BI style): tables, keys, relationships, and the layout of the model view.
// POST /api/s/:id/model/<detect|create|edit|confirm|delete|unhide|remove-tables|restore-tables|layout>
app.get('/api/s/:id/model', handle((req) => sources.modelView(sources.get(req.params.id))));
app.post('/api/s/:id/model/:action', handle((req) => sources.changeModel(req.params.id, req.params.action, req.body || {})));
app.put('/api/s/:id/overrides', handle(async (req) => { await sources.setOverrides(req.params.id, req.body); return { saved: true }; }));
// Answers are kept for each version of a source, so reloading a dashboard on a large upload is instant.
const answers = new Map();
function cached(src, kind, body, run) {
  const key = `${src.id}:${src.version}:${kind}:${JSON.stringify(body)}`;
  if (answers.has(key)) { const v = answers.get(key); answers.delete(key); answers.set(key, v); return v; }
  const p = Promise.resolve().then(run);
  answers.set(key, p);
  p.catch(() => answers.delete(key));
  while (answers.size > 500) answers.delete(answers.keys().next().value);
  return p;
}
app.post('/api/s/:id/query', handle((req) => {
  const src = sources.get(req.params.id);
  const b = req.body || {};
  return cached(src, 'q', [b.spec, b.ctx], () => engine.runView(src, b.spec, ctxOf(src, b)));
}));
app.post('/api/s/:id/records', handle((req) => {
  const src = sources.get(req.params.id);
  const b = req.body || {};
  return cached(src, 'r', b, () => engine.records(src, b.spec, ctxOf(src, b), { sel: b.sel, page: b.page, size: b.size, columns: b.columns, sort: b.sort, dir: b.dir, search: b.search }));
}));
app.post('/api/s/:id/values', handle((req) => {
  const b = req.body || {};
  return engine.values(sources.get(req.params.id), b.base, b.field, b.search);
}));
// Dashboards to start from: the hand-made ones for the dummy data, or one built from the source's description.
app.get('/api/s/:id/starters', handle(async (req) => {
  const src = sources.get(req.params.id);
  if (presets[src.id]) return presets[src.id];
  return [await autodash.generate(src, await sources.counts(src))];
}));
app.post('/api/s/:id/autodash', handle(async (req) => {
  const src = sources.get(req.params.id);
  return autodash.generate(src, await sources.counts(src), req.body && req.body.table);
}));

// ---- saved dashboards, layouts and choices, per browser ----
app.get('/api/state', handle((req) => store.get(String(req.query.client || ''))));
app.put('/api/state', handle(async (req) => {
  const { client, key, value } = req.body || {};
  await store.set(String(client || ''), String(key || ''), value);
  return { saved: true };
}));

// The earlier ScrumBan pages read the restored ScrumBan database. They are off unless LEGACY_SCRUMBAN=1.
if (process.env.LEGACY_SCRUMBAN === '1') require('./legacy').mount(app, handle);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown address' }));

// Frontend
app.use('/vendor/d3.min.js', express.static(path.join(config.root, 'node_modules', 'd3', 'dist', 'd3.min.js')));
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

const ready = sources.load();

if (require.main === module) {
  ready.then(() => {
    const server = app.listen(config.port, () => {
      console.log(`Dashboard studio: http://localhost:${config.port}`);
      console.log('Data sources: ' + sources.list().map((s) => `${s.label}${s.broken ? ' (could not open)' : ''}`).join(', '));
    });
    // large uploads over a slow network can take a while
    server.requestTimeout = 60 * 60 * 1000;
  });
}

module.exports = { app, ready };
