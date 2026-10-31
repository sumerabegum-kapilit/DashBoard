// The service (service.js) behind an Express router, and the browser files behind a static handler.
// The host mounts both wherever it likes:
//
//   app.use('/analytics/api', createRouter(studio, { userOf: (req) => req.user }));
//   app.use('/analytics/assets', studioAssets());
//
// Every route asks the service, and the service asks the host's authorize() hook, so permissions hold
// whichever way the module is used. Express is the host's: it is required here only when used.
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'client');

function loadExpress(given) {
  if (given) return given;
  try { return require('express'); } catch (e) { throw new Error('createRouter needs Express: install it in the host application, or pass { express }'); }
}

/**
 * @param {object} studio   from createStudio()
 * @param {object} [opts]
 * @param {function} [opts.userOf]   (req) => the user the host signed in (anything; given to authorize()). Default req.user
 * @param {object} [opts.express]    the host's express, if it cannot be required from here
 * @param {function} [opts.onError]  (err, req) => void, for logging server errors (default console.error)
 */
function createRouter(studio, opts = {}) {
  const express = loadExpress(opts.express);
  const userOf = opts.userOf || ((req) => req.user || null);
  const onError = opts.onError || ((err, req) => console.error('[datastudio]', req.method, req.originalUrl, err));
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));

  // Errors with a status are for the person (403, 404, 400); errors from the engine are messages for the
  // person too; anything thrown by the host's data provider (it carries a code, or is not an Error) is logged.
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, userOf(req)));
    } catch (err) {
      const status = err && err.status ? err.status : err && err.code ? 500 : err instanceof Error ? 400 : 500;
      if (status >= 500) onError(err, req);
      res.status(status).json({ error: status >= 500 ? 'The data could not be read. See the server log for details.' : err.message });
    }
  };
  const id = (req) => req.params.id;

  r.get('/sources', handle((req, user) => studio.listSources(user)));
  r.get('/sources/:id/schema', handle((req, user) => studio.getSchema(id(req), user)));
  r.get('/sources/:id/mappings', handle((req, user) => studio.getMappings(id(req), user)));
  r.put('/sources/:id/overrides', handle((req, user) => studio.setOverrides(id(req), req.body, user)));
  r.post('/sources/:id/query', handle((req, user) => studio.query(id(req), req.body && req.body.spec, req.body && req.body.ctx, user)));
  r.post('/sources/:id/records', handle((req, user) => studio.records(id(req), req.body, user)));
  r.post('/sources/:id/values', handle((req, user) => studio.values(id(req), req.body, user)));
  r.get('/sources/:id/model', handle((req, user) => studio.getModel(id(req), user)));
  r.post('/sources/:id/model/:action', handle((req, user) => studio.changeModel(id(req), req.params.action, req.body || {}, user)));
  r.get('/sources/:id/starters', handle((req, user) => studio.starters(id(req), user)));
  r.post('/sources/:id/autodash', handle((req, user) => studio.buildDashboard(id(req), req.body && req.body.table, user)));
  r.get('/sources/:id/dashboards', handle((req, user) => studio.getDashboards(id(req), user)));
  r.put('/sources/:id/dashboards', handle((req, user) => studio.saveDashboards(id(req), req.body, user)));
  r.get('/sources/:id/dashboards/:dash', handle((req, user) => studio.getDashboard(id(req), req.params.dash, user)));
  r.put('/sources/:id/dashboards/:dash', handle((req, user) => studio.saveDashboard(id(req), { ...req.body, id: req.params.dash }, user)));
  r.delete('/sources/:id/dashboards/:dash', handle((req, user) => studio.deleteDashboard(id(req), req.params.dash, user)));
  r.get('/sources/:id/config', handle((req, user) => studio.exportConfig(id(req), user)));
  r.put('/sources/:id/config', handle((req, user) => studio.importConfig(id(req), req.body, user)));
  r.use((req, res) => res.status(404).json({ error: 'Unknown address' }));
  return r;
}

// d3's built file. Its package lists it under "exports" as "umd", so find it next to the package entry.
function findD3() {
  const fs = require('fs');
  for (const guess of [() => require.resolve('d3/dist/d3.min.js'), () => path.join(path.dirname(require.resolve('d3')), '..', 'dist', 'd3.min.js')]) {
    try { const f = guess(); if (fs.existsSync(f)) return f; } catch (e) { /* try the next way */ }
  }
  return null; // then the host loads d3 itself (mount option d3)
}

// The browser side: studio.js (mount), its modules and styles, and d3.
function studioAssets(opts = {}) {
  const express = loadExpress(opts.express);
  const r = express.Router();
  const d3File = findD3();
  r.get('/vendor/d3.min.js', (req, res) => (d3File ? res.sendFile(d3File) : res.status(404).end()));
  r.use(express.static(CLIENT, { index: false, maxAge: opts.maxAge || 0 }));
  return r;
}

module.exports = { createRouter, studioAssets, CLIENT };
