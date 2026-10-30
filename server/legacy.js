// The earlier ScrumBan pages (public/classic.html). They read the ScrumBan PostgreSQL database
// and are only switched on with LEGACY_SCRUMBAN=1; the studio never uses them.
const config = require('./config');
const { query } = require('./db');
const { readWindow } = require('./window');
const { WIDGETS, overview, projectHealth, sprintTable } = require('./widgets');
const model = require('./model');

function mount(app) {
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const userError = /^(Choose|Unknown|A field|Fields can|Only dates|Sum, average|That |"Over time")/.test(err.message);
      if (!userError) console.error(req.method, req.originalUrl, err);
      res.status(userError ? 400 : 500).json({ error: userError ? err.message : 'The database query failed. See the server log for details.' });
    }
  };

  let metaCache = null;
  async function meta() {
    if (metaCache && Date.now() - metaCache.at < 60_000) return metaCache.value;
    const [m] = await query(`SELECT (SELECT min(created_at)::date FROM issues WHERE NOT is_deleted) AS min_date,
                                    coalesce($1::date, current_date) AS as_of`, [config.asOf]);
    const projects = await query(`SELECT id, name, project_type::text AS type FROM projects WHERE deleted_at IS NULL ORDER BY name`);
    const value = { minDate: m.min_date || m.as_of, asOf: m.as_of, timezone: config.timezone, maxEntryHours: config.maxEntryMinutes / 60, projects };
    metaCache = { at: Date.now(), value };
    return value;
  }

  app.get('/api/meta', handle(meta));
  app.get('/api/overview', handle(async (req) => overview(readWindow(req.query, await meta()))));
  app.get('/api/widget/:name', handle(async (req) => {
    const widget = Object.prototype.hasOwnProperty.call(WIDGETS, req.params.name) ? WIDGETS[req.params.name] : null;
    if (!widget) throw new Error('Unknown chart: ' + req.params.name);
    return widget(readWindow(req.query, await meta()));
  }));
  const paging = (q) => ({
    page: Math.max(1, Number(q.page) || 1),
    size: Math.min(100, Math.max(1, Number(q.size) || 10)),
    sort: String(q.sort || ''),
    dir: q.dir === 'asc' ? 'asc' : 'desc',
    search: q.search ? String(q.search).slice(0, 100) : null,
  });
  app.get('/api/table/projects', handle(async (req) => projectHealth(readWindow(req.query, await meta()), paging(req.query))));
  app.get('/api/table/sprints', handle(async (req) => sprintTable(readWindow(req.query, await meta()), paging(req.query))));
  app.get('/api/model', handle(() => model.describeModel()));
  app.post('/api/model/query', handle((req) => model.runView(req.body && req.body.spec)));
  app.post('/api/model/records', handle((req) => {
    const { spec, sel, page } = req.body || {};
    return model.records(spec, sel || {}, Number(page) || 1, 10);
  }));
  app.post('/api/model/values', handle((req) => model.values(req.body && req.body.base, req.body && req.body.field)));
}

module.exports = { mount };
