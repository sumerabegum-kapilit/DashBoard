// An example host application: "Acme back office". It already has its own users, its own database and
// its own way of loading data; it adds the data studio module for analytics. Everything the host does
// for the module is marked "INTEGRATION".
//
//   node examples/host-app/server.js      then open http://localhost:3300
//
// Needs Node 22.5+ (it uses the built-in node:sqlite as the host's own database) and Express.
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const datastudio = require('../..'); // in another project: require('datastudio') or the path you copied it to
const { shop, shopTables } = require('./sample-data');

const PORT = Number(process.env.PORT || 3300);

// ---- the host's own world: a database it fills itself, and its users ----
const db = new DatabaseSync(':memory:');
function loadShop() {
  const data = shop();
  for (const t of shopTables) {
    const cols = t.columns.map((c) => c.name);
    db.exec(`DROP TABLE IF EXISTS "${t.name}"; CREATE TABLE "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO "${t.name}" VALUES (${cols.map(() => '?').join(', ')})`);
    db.exec('BEGIN');
    for (const r of data[t.name]) ins.run(...cols.map((c) => (typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : r[c])));
    db.exec('COMMIT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders (customer_id); CREATE INDEX IF NOT EXISTS ix_lines_order ON order_lines (order_id)');
}
loadShop();
const USERS = {
  alice: { id: 'alice', name: 'Alice (admin)', role: 'admin' },
  bob: { id: 'bob', name: 'Bob (analyst)', role: 'analyst' },
  carol: { id: 'carol', name: 'Carol (viewer)', role: 'viewer' },
};

// ---- INTEGRATION 1: create the studio with the host's storage and permission rules ----
const studio = datastudio.createStudio({
  store: datastudio.jsonFileStore(path.join(__dirname, 'data', 'studio-config.json')),
  // admins change the data model; analysts build dashboards; viewers look
  authorize: ({ user, action }) => {
    if (!user) return false;
    if (action === 'view') return true;
    if (action === 'dashboards') return user.role === 'admin' || user.role === 'analyst';
    return user.role === 'admin';
  },
  dashboardScope: 'shared',
});

// ---- INTEGRATION 2: hand the studio the tables and how to read them ----
async function registerSources() {
  // a. the host's SQL database, read through the host's own connection
  datastudio.sqliteFunctions(db); // medians on this connection
  await studio.registerSource({
    id: 'shop', label: 'Shop', description: 'Orders, order lines, customers and products from the shop database.',
    tables: shopTables,
    provider: datastudio.sqliteProvider({ query: (sql, params) => db.prepare(sql).all(params) }),
  });
  // b. rows the host already has in memory (from a file, an API, a report ...)
  const regions = ['North', 'South', 'East', 'West'];
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 10); });
  await studio.registerSource({
    id: 'targets', label: 'Sales targets', description: 'Monthly targets per region, kept by the finance team.',
    tables: [{
      name: 'targets', primaryKey: 'target_id', dateColumn: 'month',
      columns: [{ name: 'target_id', type: 'text', hidden: true }, { name: 'region', type: 'text' }, { name: 'month', type: 'date' }, { name: 'target', type: 'number', format: 'money' }],
      rows: months.flatMap((m, i) => regions.map((r, k) => ({ target_id: `${r}-${m}`, region: r, month: m, target: 180000 + k * 25000 + i * 3000 }))),
    }],
  });
}

const app = express();
// the host's own sign-in: here a cookie naming the user, picked on the page
app.use((req, res, next) => {
  const m = /(?:^|;\s*)acme_user=(\w+)/.exec(req.headers.cookie || '');
  req.user = USERS[(m && m[1]) || 'alice'] || null;
  next();
});

// ---- INTEGRATION 3: mount the API and the browser files wherever the host wants them ----
app.use('/analytics/api', datastudio.createRouter(studio, { userOf: (req) => req.user }));
app.use('/analytics/assets', datastudio.studioAssets());

// ---- the host using the module from its own code: a number for its home page ----
app.get('/api/home', async (req, res) => {
  try {
    const r = await studio.query('shop', { base: 'orders', measures: [{ fn: 'sum', field: 'total' }, { fn: 'count' }] }, { range: { from: new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } }, req.user);
    const boards = await studio.getDashboards('shop', req.user);
    res.json({ user: req.user, revenue30d: r.total[0], orders30d: r.total[1], dashboards: boards.dashboards.map((d) => ({ id: d.id, title: d.title })) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// the host reloads its data (a nightly import, say) and tells the studio
app.post('/api/reload', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  loadShop();
  studio.refreshSource('shop');
  res.json({ reloaded: true });
});
app.get('/api/users', (req, res) => res.json(Object.values(USERS)));
app.use(express.static(path.join(__dirname, 'public')));

const ready = registerSources();
if (require.main === module) {
  ready.then(() => app.listen(PORT, () => console.log(`Acme back office with the data studio: http://localhost:${PORT}`)));
}
module.exports = { app, ready, studio, db };
