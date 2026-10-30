// End-to-end checks of the API against the live database.
// Numbers are compared with plain SQL written independently of the app's queries.
// Run with: npm run test:legacy   (the ScrumBan database must be running)
process.env.AS_OF = process.env.AS_OF || '2026-10-29';
process.env.STATE_FILE = require('path').join(require('os').tmpdir(), 'scrumban-test-state.json');
const test = require('node:test');
const assert = require('node:assert');
process.env.LEGACY_SCRUMBAN = '1';
const { app } = require('../server/index');
const { pool } = require('../server/db');
const { query } = require('../server/db');

let server, base;
test.before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await pool.end();
});
const get = async (url) => {
  const r = await fetch(base + url);
  const body = await r.json();
  assert.strictEqual(r.status, 200, url + ' -> ' + JSON.stringify(body));
  return body;
};
const post = async (url, data, expect = 200) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const body = await r.json();
  assert.strictEqual(r.status, expect, url + ' -> ' + JSON.stringify(body));
  return body;
};
const W7 = 'from=2026-10-23&to=2026-10-29';

test('meta reads the live database', async () => {
  const m = await get('/api/meta');
  assert.strictEqual(m.asOf, '2026-10-29');
  assert.ok(m.projects.length > 0);
});

test('headline numbers match direct SQL', async () => {
  const o = await get('/api/overview?' + W7);
  const [sql] = await query(`
    SELECT count(*) FILTER (WHERE i.created_at::date BETWEEN '2026-10-23' AND '2026-10-29') AS created,
           count(*) FILTER (WHERE ws.name <> 'Done') AS open_now,
           count(*) FILTER (WHERE ws.name <> 'Done' AND i.due_date < '2026-10-29') AS overdue
    FROM issues i JOIN workflow_statuses ws ON ws.id = i.status_id WHERE NOT i.is_deleted`);
  assert.strictEqual(o.kpis.created, sql.created);
  assert.strictEqual(o.kpis.open_now, sql.open_now);
  assert.strictEqual(o.kpis.overdue, sql.overdue);
  assert.strictEqual(o.kpis.completed, 187); // checked earlier against the backup
  const [h] = await query(`SELECT round(sum(t.time_spent_minutes) / 60.0) AS hours FROM time_logs t JOIN issues i ON i.id = t.issue_id AND NOT i.is_deleted
                           WHERE t.logged_date BETWEEN '2026-10-23' AND '2026-10-29' AND t.time_spent_minutes <= 720`);
  assert.strictEqual(o.kpis.hours, h.hours);
});

test('every chart answers for every period', async () => {
  const names = ['trends', 'status', 'priority_open', 'top_projects', 'open_per_person', 'done_per_person', 'hours_per_person', 'hours_trend', 'roles',
    'throughput_by_type', 'cfd', 'cycle_buckets', 'age_buckets', 'open_overdue', 'bugs', 'overdue_by_project', 'readiness', 'invest',
    'activity_heat', 'activity_trend', 'active_people', 'sprint_status', 'sprint_points'];
  for (const range of [W7, 'from=2026-09-30&to=2026-10-29', 'from=2026-07-22&to=2026-10-29']) {
    for (const n of names) {
      const d = await get(`/api/widget/${n}?${range}`);
      assert.ok(['category', 'time', 'heat'].includes(d.kind), n);
      if (d.kind === 'time') assert.ok(d.series.every((s) => s.values.length === d.keys.length), n + ' series length');
    }
  }
});

test('trends add up to the headline numbers', async () => {
  const t = await get('/api/widget/trends?' + W7);
  const o = await get('/api/overview?' + W7);
  const sum = (name) => t.series.find((s) => s.name === name).values.reduce((a, b) => a + b, 0);
  assert.strictEqual(sum('completed'), o.kpis.completed);
  assert.strictEqual(sum('created'), o.kpis.created);
});

test('project filter narrows every number', async () => {
  const m = await get('/api/meta');
  const p = m.projects[0];
  const o = await get(`/api/overview?${W7}&project=${p.id}`);
  const [sql] = await query(`SELECT count(*) AS n FROM issues i JOIN workflow_statuses ws ON ws.id = i.status_id WHERE NOT i.is_deleted AND ws.name <> 'Done' AND i.project_id = $1`, [p.id]);
  assert.strictEqual(o.kpis.open_now, sql.n);
});

test('tables page, sort and search', async () => {
  const a = await get('/api/table/projects?' + W7 + '&page=1&size=10&sort=open&dir=desc');
  assert.strictEqual(a.rows.length, 10);
  assert.ok(a.total > 10);
  assert.ok(a.rows[0].open >= a.rows[9].open);
  const b = await get('/api/table/projects?' + W7 + '&page=2&size=10&sort=open&dir=desc');
  assert.notDeepStrictEqual(a.rows[0], b.rows[0]);
  const s = await get('/api/table/projects?' + W7 + '&search=' + encodeURIComponent(a.rows[0].project.slice(0, 5)));
  assert.ok(s.rows.some((r) => r.project === a.rows[0].project));
  const sp = await get('/api/table/sprints?' + W7 + '&page=1&size=10');
  assert.ok(sp.total > 0);
});

test('build a view: joins match direct SQL', async () => {
  // time entry -> work item -> project type, valid entries only
  const v = await post('/api/model/query', { spec: { base: 'timelogs', fn: 'sum', field: 'hours', group: 'item_id.project_id.type', filters: [{ field: 'hours', op: 'le', value: '12' }] } });
  const sql = await query(`SELECT p.project_type::text AS k, sum(round(t.time_spent_minutes / 60.0, 2)) AS v FROM time_logs t
    JOIN issues i ON i.id = t.issue_id AND NOT i.is_deleted JOIN projects p ON p.id = i.project_id WHERE t.time_spent_minutes <= 720 GROUP BY 1`);
  for (const r of sql) assert.ok(Math.abs(v.groups.find((g) => g.key === r.k).value - r.v) < 0.01, 'hours ' + r.k);
  // borrowed total: average watchers per work item by priority
  const w = await post('/api/model/query', { spec: { base: 'items', fn: 'avg', field: 'n_watchers', group: 'priority' } });
  const ws = await query(`SELECT i.priority::text AS k, avg(coalesce(n, 0)) AS v FROM issues i
    LEFT JOIN (SELECT issue_id, count(*) n FROM issue_watchers GROUP BY 1) x ON x.issue_id = i.id WHERE NOT i.is_deleted GROUP BY 1`);
  for (const r of ws) assert.ok(Math.abs(w.groups.find((g) => g.key === r.k).value - r.v) < 1e-9, 'watchers ' + r.k);
  // split + over time add up
  const t = await post('/api/model/query', { spec: { base: 'items', fn: 'count', group: 'type', time: 'created', grain: 'week' } });
  const total = t.time.series.flatMap((s) => s.values).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, t.total);
  const s = await post('/api/model/query', { spec: { base: 'changes', fn: 'count', group: 'date|weekday', split: 'to_status' } });
  for (const g of s.groups) assert.strictEqual(g.segs.reduce((a, b) => a + b.value, 0), g.value);
  assert.deepStrictEqual(s.groups.map((g) => g.key).filter((k) => k !== '__other'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter((d) => s.groups.some((g) => g.key === d)));
});

test('build a view: records behind a bar', async () => {
  const spec = { base: 'items', fn: 'count', group: 'sprint_id.status', filters: [{ field: 'sprint_id.status', op: 'notempty' }] };
  const v = await post('/api/model/query', { spec });
  const g = v.groups[0];
  const r = await post('/api/model/records', { spec, sel: { group: g.key }, page: 1 });
  assert.strictEqual(r.total, g.value);
  assert.ok(r.rows.length <= 10);
  assert.ok(r.columns.some((c) => c.label === 'Project'));
});

test('build a view refuses unknown tables, fields and unsafe input', async () => {
  await post('/api/model/query', { spec: { base: 'users; drop table issues', fn: 'count' } }, 400);
  await post('/api/model/query', { spec: { base: 'items', fn: 'count', group: 'password_hash' } }, 400);
  await post('/api/model/query', { spec: { base: 'items', fn: 'sum', field: 'title' } }, 400);
  const v = await post('/api/model/query', { spec: { base: 'items', fn: 'count', filters: [{ field: 'title', op: 'contains', value: "'; drop table issues; --" }] } });
  assert.strictEqual(v.total, 0);
});

test('saved settings round trip', async () => {
  const client = 'test_' + Date.now();
  const r = await fetch(base + '/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, key: 'views', value: [{ id: 'x' }] }) });
  assert.strictEqual(r.status, 200);
  const s = await get('/api/state?client=' + client);
  assert.deepStrictEqual(s.views, [{ id: 'x' }]);
});
