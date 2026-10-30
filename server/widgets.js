// Every chart on the standard pages: one live SQL query each, returned in a chart-ready shape.
//   category: { kind, dim, fmt, items: [{ name, label, value, segs? }], segDim? }
//   time:     { kind, grain, fmt, dim?, keys: ['YYYY-MM-DD'], series: [{ name, label, values, fmt? }] }
//   heat:     { kind, fmt, rows: [{ name, label, values }], cols: [labels] }
const { query } = require('./db');
const { ITEMS, PARAMS, HOURS, buckets, grainSql, args } = require('./sql');

const num = (v) => (v == null ? null : Number(v));
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const OPEN_STATUSES = ['To Do', 'In Progress', 'In Review', 'Blocked'];

const category = (rows, extra = {}) => ({
  kind: 'category',
  fmt: 'int',
  ...extra,
  items: rows.map((r) => ({
    name: r.name ?? '(none)',
    label: r.label ?? r.name ?? '(none)',
    value: num(r.value) ?? 0,
    segs: extra.segs ? extra.segs.map(([key, label]) => ({ name: key, label, value: num(r[key]) ?? 0 })) : undefined,
  })),
  segs: undefined,
  segNames: extra.segs ? extra.segs.map(([key, label]) => ({ name: key, label })) : undefined,
});

// rows of { k, s, v } into one series per s, on the bucket keys of the window
function pivot(keys, rows, order, labels = {}) {
  const names = order || [...new Set(rows.map((r) => r.s))];
  const at = new Map(keys.map((k, i) => [k, i]));
  const series = names.map((s) => ({ name: s, label: labels[s] || s, values: keys.map(() => 0) }));
  const byName = new Map(series.map((s) => [s.name, s]));
  for (const r of rows) {
    const s = byName.get(r.s), i = at.get(r.k);
    if (s && i !== undefined) s.values[i] += num(r.v) || 0;
  }
  return series;
}
async function keysOf(w) {
  return (await query(`WITH ${PARAMS}, ${buckets(w.grain)} SELECT k FROM b ORDER BY k`, args(w))).map((r) => r.k);
}

const W = {};

// ---- overview ----
W.trends = async (w) => {
  const g = grainSql(w.grain);
  const rows = await query(`WITH ${ITEMS}, ${buckets(g)},
    c AS (SELECT date_trunc('${g}', created)::date AS k, count(*) AS n FROM it, params WHERE created BETWEEN d_from AND d_to GROUP BY 1),
    d AS (SELECT date_trunc('${g}', done)::date AS k, count(*) AS n, sum(points) AS pts,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_h) AS cyc
          FROM it, params WHERE done BETWEEN d_from AND d_to GROUP BY 1),
    h AS (SELECT date_trunc('${g}', hl.logged_date)::date AS k, sum(hl.time_spent_minutes) / 60.0 AS hrs
          FROM (${HOURS}) hl, params WHERE hl.logged_date BETWEEN d_from AND d_to GROUP BY 1)
    SELECT b.k, coalesce(c.n, 0) AS created, coalesce(d.n, 0) AS completed,
           coalesce(d.pts, 0) AS points, d.cyc AS cycle, coalesce(h.hrs, 0) AS hours
    FROM b LEFT JOIN c USING (k) LEFT JOIN d USING (k) LEFT JOIN h USING (k) ORDER BY b.k`, args(w));
  const keys = rows.map((r) => r.k);
  const line = (name, label, fmt) => ({ name, label, fmt, values: rows.map((r) => num(r[name])) });
  return {
    kind: 'time', grain: g, fmt: 'int', keys, mixedUnits: true,
    series: [line('completed', 'Completed', 'int'), line('created', 'Created', 'int'), line('points', 'Story points done', 'int'),
      line('cycle', 'Median cycle time (h)', 'dec'), line('hours', 'Hours logged', 'hours')],
  };
};

W.status = async (w) => category(await query(`WITH ${ITEMS} SELECT status AS name, count(*) AS value FROM it GROUP BY 1`, args(w)), { dim: 'status' });

W.priority_open = async (w) => category(await query(`WITH ${ITEMS}
  SELECT priority AS name, count(*) AS value,
         count(*) FILTER (WHERE due < as_of) AS overdue, count(*) FILTER (WHERE due IS NULL OR due >= as_of) AS on_time
  FROM it, params WHERE NOT is_done GROUP BY 1`, args(w)), { dim: 'priority', segs: [['overdue', 'Overdue'], ['on_time', 'On time or no due date']], segDim: 'overdue' });

W.top_projects = async (w) => category(await query(`WITH ${ITEMS}
  SELECT project AS name, count(*) AS value, ${OPEN_STATUSES.map((s) => `count(*) FILTER (WHERE status = '${s}') AS "${s}"`).join(', ')}
  FROM it WHERE NOT is_done GROUP BY 1 ORDER BY value DESC, name LIMIT 10`, args(w)), { dim: 'project', segs: OPEN_STATUSES.map((s) => [s, s]), segDim: 'status' });

W.open_per_person = async (w) => category(await query(`WITH ${ITEMS}
  SELECT assignee AS name, count(*) AS value, ${PRIORITIES.map((p) => `count(*) FILTER (WHERE priority = '${p}') AS ${p}`).join(', ')}
  FROM it WHERE NOT is_done GROUP BY 1 ORDER BY value DESC, name LIMIT 15`, args(w)), { dim: 'person', segs: PRIORITIES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]), segDim: 'priority' });

W.done_per_person = async (w) => category(await query(`WITH ${ITEMS}
  SELECT assignee AS name, count(*) AS value FROM it, params WHERE done BETWEEN d_from AND d_to
  GROUP BY 1 ORDER BY value DESC, name LIMIT 15`, args(w)), { dim: 'person' });

W.hours_per_person = async (w) => category(await query(`WITH ${PARAMS}
  SELECT coalesce(u.full_name, 'Unknown') AS name, round(sum(hl.time_spent_minutes) / 60.0, 1) AS value
  FROM (${HOURS}) hl LEFT JOIN users u ON u.id = hl.user_id, params
  WHERE hl.logged_date BETWEEN d_from AND d_to GROUP BY 1 ORDER BY value DESC, name LIMIT 10`, args(w)), { dim: 'person', fmt: 'hours' });

W.hours_trend = async (w) => {
  const g = grainSql(w.grain);
  const [keys, rows] = await Promise.all([keysOf(w), query(`WITH ${PARAMS},
    hl AS (SELECT * FROM (${HOURS}) x, params WHERE x.logged_date BETWEEN d_from AND d_to),
    top AS (SELECT user_id FROM hl GROUP BY 1 ORDER BY sum(time_spent_minutes) DESC LIMIT 4)
    SELECT date_trunc('${g}', hl.logged_date)::date AS k, coalesce(u.full_name, 'Unknown') AS s, sum(hl.time_spent_minutes) / 60.0 AS v
    FROM hl JOIN top USING (user_id) LEFT JOIN users u ON u.id = hl.user_id GROUP BY 1, 2`, args(w))]);
  return { kind: 'time', grain: g, fmt: 'hours', dim: 'person', keys, series: pivot(keys, rows) };
};

W.roles = async (w) => category(await query(`WITH ${PARAMS}
  SELECT m.project_role::text AS name, count(*) AS value FROM project_members m, params
  WHERE m.is_active AND (p_project IS NULL OR m.project_id = p_project) GROUP BY 1 ORDER BY value DESC`, args(w)), { dim: 'role' });

// ---- delivery ----
W.throughput_by_type = async (w) => {
  const g = grainSql(w.grain);
  const [keys, rows] = await Promise.all([keysOf(w), query(`WITH ${ITEMS}
    SELECT date_trunc('${g}', done)::date AS k, type AS s, count(*) AS v FROM it, params WHERE done BETWEEN d_from AND d_to GROUP BY 1, 2`, args(w))]);
  return { kind: 'time', grain: g, fmt: 'int', dim: 'type', keys, series: pivot(keys, rows, ['task', 'user_story', 'bug', 'epic', 'sub_task', 'technical_story', 'spike']).filter((s) => s.values.some(Boolean)) };
};

W.cfd = async (w) => {
  const rows = await query(`WITH ${PARAMS}, days AS (SELECT generate_series(d_from, d_to, interval '1 day')::date AS k FROM params)
    SELECT c.snapshot_date AS k, kc.name AS s, sum(c.issue_count) AS v
    FROM cfd_snapshots c JOIN kanban_columns kc ON kc.id = c.column_id, params
    WHERE c.snapshot_date BETWEEN d_from AND d_to AND (p_project IS NULL OR c.project_id = p_project)
    GROUP BY 1, 2`, args(w));
  const keys = (await query(`WITH ${PARAMS} SELECT generate_series(d_from, d_to, interval '1 day')::date AS k FROM params`, args(w))).map((r) => r.k);
  return { kind: 'time', grain: 'day', fmt: 'int', dim: 'column', keys, series: pivot(keys, rows, ['Done', 'In Review', 'In Progress', 'Backlog']) };
};

const CYCLE_BUCKETS = [['Under 1 hour', 1], ['1 to 8 hours', 8], ['8 to 24 hours', 24], ['1 to 3 days', 72], ['3 to 7 days', 168], ['1 to 2 weeks', 336], ['2 weeks or more', null]];
W.cycle_buckets = async (w) => {
  const cases = CYCLE_BUCKETS.map(([label, lim], i) => (lim == null ? `ELSE ${i}` : `WHEN cycle_h < ${lim} THEN ${i}`)).join(' ');
  const rows = await query(`WITH ${ITEMS}
    SELECT CASE ${cases} END AS b, count(*) AS value FROM it, params
    WHERE cycle_h IS NOT NULL AND done BETWEEN d_from AND d_to GROUP BY 1`, args(w));
  const at = new Map(rows.map((r) => [r.b, r.value]));
  return category(CYCLE_BUCKETS.map(([label], i) => ({ name: label, value: at.get(i) || 0 })), { dim: 'bucket' });
};

const AGE_BUCKETS = [['0 to 7 days', 8], ['8 to 30 days', 31], ['31 to 60 days', 61], ['61 to 90 days', 91], ['Over 90 days', null]];
W.age_buckets = async (w) => {
  const cases = AGE_BUCKETS.map(([label, lim], i) => (lim == null ? `ELSE ${i}` : `WHEN as_of - created < ${lim} THEN ${i}`)).join(' ');
  const rows = await query(`WITH ${ITEMS}
    SELECT CASE ${cases} END AS b, count(*) AS value, ${PRIORITIES.map((p) => `count(*) FILTER (WHERE priority = '${p}') AS ${p}`).join(', ')}
    FROM it, params WHERE NOT is_done GROUP BY 1`, args(w));
  const at = new Map(rows.map((r) => [r.b, r]));
  return category(AGE_BUCKETS.map(([label], i) => ({ name: label, ...(at.get(i) || { value: 0 }) })), { dim: 'bucket', segs: PRIORITIES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]), segDim: 'priority' });
};

W.open_overdue = async (w) => {
  const rows = await query(`WITH ${ITEMS}, days AS (SELECT generate_series(d_from, d_to, interval '1 day')::date AS k FROM params)
    SELECT days.k,
           count(it.id) FILTER (WHERE it.created <= days.k AND (it.done IS NULL OR it.done > days.k)) AS open,
           count(it.id) FILTER (WHERE it.created <= days.k AND (it.done IS NULL OR it.done > days.k) AND it.due < days.k) AS overdue
    FROM days CROSS JOIN it GROUP BY days.k ORDER BY days.k`, args(w));
  return { kind: 'time', grain: 'day', fmt: 'int', keys: rows.map((r) => r.k), series: [
    { name: 'open', label: 'Open', values: rows.map((r) => r.open) },
    { name: 'overdue', label: 'Overdue', color: 'critical', values: rows.map((r) => r.overdue) },
  ] };
};

// ---- quality ----
W.bugs = async (w) => {
  const g = grainSql(w.grain);
  const rows = await query(`WITH ${ITEMS}, ${buckets(g)},
    r AS (SELECT date_trunc('${g}', created)::date AS k, count(*) AS n FROM it, params WHERE type = 'bug' AND created BETWEEN d_from AND d_to GROUP BY 1),
    f AS (SELECT date_trunc('${g}', done)::date AS k, count(*) AS n FROM it, params WHERE type = 'bug' AND done BETWEEN d_from AND d_to GROUP BY 1)
    SELECT b.k, coalesce(r.n, 0) AS reported, coalesce(f.n, 0) AS fixed FROM b LEFT JOIN r USING (k) LEFT JOIN f USING (k) ORDER BY b.k`, args(w));
  return { kind: 'time', grain: g, fmt: 'int', keys: rows.map((r) => r.k), series: [
    { name: 'reported', label: 'Reported', color: 'critical', values: rows.map((r) => r.reported) },
    { name: 'fixed', label: 'Fixed', values: rows.map((r) => r.fixed) },
  ] };
};

W.overdue_by_project = async (w) => category(await query(`WITH ${ITEMS}
  SELECT project AS name, count(*) AS value, ${PRIORITIES.map((p) => `count(*) FILTER (WHERE priority = '${p}') AS ${p}`).join(', ')}
  FROM it, params WHERE NOT is_done AND due < as_of GROUP BY 1 ORDER BY value DESC, name LIMIT 10`, args(w)), { dim: 'project', segs: PRIORITIES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]), segDim: 'priority' });

W.readiness = async (w) => category(await query(`WITH ${PARAMS}
  SELECT d.item_category::text AS name, round(count(*) FILTER (WHERE d.checked)::numeric / count(*), 4) AS value
  FROM dor_issue_checklist d JOIN issues i ON i.id = d.issue_id AND NOT i.is_deleted, params
  WHERE d.is_active AND (p_project IS NULL OR i.project_id = p_project) GROUP BY 1 ORDER BY value DESC`, args(w)), { dim: 'area', fmt: 'pct', max: 1 });

W.invest = async (w) => {
  const rows = await query(`WITH ${PARAMS}
    SELECT v.dimension::text AS name, count(*) AS value,
           count(*) FILTER (WHERE v.rating = 'met') AS met, count(*) FILTER (WHERE v.rating = 'partially_met') AS partially_met,
           count(*) FILTER (WHERE v.rating = 'not_met') AS not_met
    FROM dor_invest_ratings v, params WHERE p_project IS NULL OR v.project_id = p_project GROUP BY 1`, args(w));
  const order = ['independent', 'negotiable', 'valuable', 'estimable', 'small', 'testable'];
  rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return category(rows, { dim: 'dimension', segs: [['met', 'Met'], ['partially_met', 'Partly met'], ['not_met', 'Not met']], segDim: 'rating' });
};

// ---- activity ----
W.activity_heat = async (w) => {
  const rows = await query(`WITH ${PARAMS}
    SELECT extract(isodow FROM a.created_at)::int AS dow, extract(hour FROM a.created_at)::int AS hr, count(*) AS v
    FROM audit_log a, params
    WHERE a.created_at::date BETWEEN d_from AND d_to AND (p_project IS NULL OR a.project_id = p_project) GROUP BY 1, 2`, args(w));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grid = days.map(() => Array(24).fill(0));
  for (const r of rows) grid[r.dow - 1][r.hr] = r.v;
  return { kind: 'heat', fmt: 'int', valueLabel: 'events', rows: days.map((d, i) => ({ name: d, label: d, values: grid[i] })), cols: [...Array(24).keys()].map((h) => String(h).padStart(2, '0')) };
};

W.activity_trend = async (w) => {
  const g = grainSql(w.grain);
  const [keys, rows] = await Promise.all([keysOf(w), query(`WITH ${PARAMS},
    a AS (SELECT * FROM audit_log a, params WHERE a.created_at::date BETWEEN d_from AND d_to AND (p_project IS NULL OR a.project_id = p_project)),
    top AS (SELECT action FROM a GROUP BY 1 ORDER BY count(*) DESC LIMIT 4)
    SELECT date_trunc('${g}', a.created_at)::date AS k, a.action AS s, count(*) AS v FROM a JOIN top USING (action) GROUP BY 1, 2`, args(w))]);
  return { kind: 'time', grain: g, fmt: 'int', dim: 'action', keys, series: pivot(keys, rows) };
};

W.active_people = async (w) => category(await query(`WITH ${PARAMS}
  SELECT coalesce(a.actor_name, u.full_name, 'System') AS name, count(*) AS value
  FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id, params
  WHERE a.created_at::date BETWEEN d_from AND d_to AND (p_project IS NULL OR a.project_id = p_project)
  GROUP BY 1 ORDER BY value DESC, name LIMIT 12`, args(w)), { dim: 'person' });

// ---- sprints ----
W.sprint_status = async (w) => {
  const rows = await query(`WITH ${PARAMS}
    SELECT CASE WHEN s.status = 'active' AND s.end_date < as_of THEN 'Active, past end date' ELSE initcap(s.status::text) END AS name, count(*) AS value
    FROM sprints s, params WHERE s.deleted_at IS NULL AND (p_project IS NULL OR s.project_id = p_project) GROUP BY 1`, args(w));
  const order = ['Future', 'Active', 'Active, past end date', 'Closed'];
  rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return category(rows, { dim: 'sprint_status' });
};

W.sprint_points = async (w) => category(await query(`WITH ${PARAMS}
  SELECT p.key || ' · ' || s.name AS name, coalesce(sum(i.story_points), 0) AS value,
         coalesce(sum(i.story_points) FILTER (WHERE ws.name = 'Done'), 0) AS done,
         coalesce(sum(i.story_points) FILTER (WHERE ws.name IS DISTINCT FROM 'Done'), 0) AS not_done
  FROM sprints s JOIN projects p ON p.id = s.project_id
  JOIN issues i ON i.sprint_id = s.id AND NOT i.is_deleted LEFT JOIN workflow_statuses ws ON ws.id = i.status_id, params
  WHERE s.deleted_at IS NULL AND (p_project IS NULL OR s.project_id = p_project)
  GROUP BY s.id, p.key, s.name HAVING sum(i.story_points) > 0 ORDER BY value DESC LIMIT 15`, args(w)), { dim: 'sprint', segs: [['done', 'Done'], ['not_done', 'Not done']], segDim: 'done' });

// ---- headline numbers and health ----
async function overview(w) {
  const [k] = await query(`WITH ${ITEMS},
    hrs AS (SELECT coalesce(sum(time_spent_minutes) FILTER (WHERE logged_date BETWEEN d_from AND d_to), 0) / 60.0 AS hours,
                   coalesce(sum(time_spent_minutes) FILTER (WHERE logged_date BETWEEN p_from AND p_to), 0) / 60.0 AS hours_prev
            FROM (${HOURS}) hl, params),
    dor AS (SELECT count(*) AS items, count(*) FILTER (WHERE d.checked) AS ticked
            FROM dor_issue_checklist d JOIN issues i ON i.id = d.issue_id AND NOT i.is_deleted, params
            WHERE d.is_active AND (p_project IS NULL OR i.project_id = p_project))
    SELECT
      count(*) FILTER (WHERE created BETWEEN d_from AND d_to) AS created,
      count(*) FILTER (WHERE created BETWEEN p_from AND p_to) AS created_prev,
      count(*) FILTER (WHERE done BETWEEN d_from AND d_to) AS completed,
      count(*) FILTER (WHERE done BETWEEN p_from AND p_to) AS completed_prev,
      coalesce(sum(points) FILTER (WHERE done BETWEEN d_from AND d_to), 0) AS points,
      coalesce(sum(points) FILTER (WHERE done BETWEEN p_from AND p_to), 0) AS points_prev,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_h) FILTER (WHERE done BETWEEN d_from AND d_to) AS cycle_hours,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_h) FILTER (WHERE done BETWEEN p_from AND p_to) AS cycle_hours_prev,
      min(hrs.hours) AS hours, min(hrs.hours_prev) AS hours_prev,
      count(*) FILTER (WHERE NOT is_done) AS open_now,
      count(*) FILTER (WHERE NOT is_done AND due < as_of) AS overdue,
      count(*) FILTER (WHERE status = 'Blocked') AS blocked,
      count(*) FILTER (WHERE NOT is_done AND priority IN ('critical', 'high')) AS urgent,
      count(*) FILTER (WHERE NOT is_done AND assignee_id IS NOT NULL) AS open_owned,
      count(*) FILTER (WHERE points IS NOT NULL) AS estimated,
      count(*) AS items,
      min(dor.items) AS dor_items, min(dor.ticked) AS dor_ticked,
      min(p_from) AS prev_from
    FROM it CROSS JOIN params CROSS JOIN hrs CROSS JOIN dor`, args(w));
  const share = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    window: { from: w.from, to: w.to, prevFrom: k.prev_from, grain: w.grain },
    kpis: {
      completed: k.completed, completed_prev: k.completed_prev, created: k.created, created_prev: k.created_prev,
      points: k.points, points_prev: k.points_prev, cycle_hours: round1(k.cycle_hours), cycle_hours_prev: round1(k.cycle_hours_prev),
      hours: Math.round(k.hours), hours_prev: Math.round(k.hours_prev),
      open_now: k.open_now, overdue: k.overdue, blocked: k.blocked, urgent: k.urgent,
    },
    health: {
      on_time_share: k.open_now ? share(k.open_now - k.overdue, k.open_now) : null,
      owned_share: k.open_now ? share(k.open_owned, k.open_now) : null,
      estimated_share: share(k.estimated, k.items),
      ready_share: share(k.dor_ticked, k.dor_items),
    },
  };
}

// ---- tables with pages ----
const PROJECT_SORT = { project: 'agg.project', type: 'agg.type', open: 'agg.open', overdue: 'agg.overdue', blocked: 'agg.blocked', urgent: 'agg.urgent', created: 'agg.created', completed: 'agg.completed', done_share: 'agg.done_share', hours: 'hours', people: 'agg.people' };
async function projectHealth(w, { page, size, sort, dir, search }) {
  const col = PROJECT_SORT[sort] || 'agg.open';
  const order = dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await query(`WITH ${ITEMS},
    hrs AS (SELECT hl.project_id, sum(hl.time_spent_minutes) / 60.0 AS hours FROM (${HOURS}) hl, params WHERE hl.logged_date BETWEEN d_from AND d_to GROUP BY 1),
    agg AS (
      SELECT it.project_id, min(it.project) AS project, min(it.ptype) AS type,
             count(*) FILTER (WHERE NOT is_done) AS open,
             count(*) FILTER (WHERE NOT is_done AND due < as_of) AS overdue,
             count(*) FILTER (WHERE status = 'Blocked') AS blocked,
             count(*) FILTER (WHERE NOT is_done AND priority IN ('critical', 'high')) AS urgent,
             count(*) FILTER (WHERE created BETWEEN d_from AND d_to) AS created,
             count(*) FILTER (WHERE done BETWEEN d_from AND d_to) AS completed,
             round(count(*) FILTER (WHERE is_done)::numeric / count(*), 4) AS done_share,
             count(DISTINCT assignee_id) FILTER (WHERE NOT is_done) AS people
      FROM it CROSS JOIN params GROUP BY it.project_id)
    SELECT agg.*, round(coalesce(hrs.hours, 0), 1) AS hours, count(*) OVER () AS total_rows
    FROM agg LEFT JOIN hrs USING (project_id)
    WHERE ($6::text IS NULL OR agg.project ILIKE '%' || $6 || '%')
    ORDER BY ${col} ${order} NULLS LAST, agg.project
    LIMIT $7 OFFSET $8`, [...args(w), search || null, size, (page - 1) * size]);
  return { total: rows[0]?.total_rows || 0, rows: rows.map(({ total_rows, project_id, ...r }) => ({ project_id, ...r })) };
}

async function sprintTable(w, { page, size }) {
  const rows = await query(`WITH ${PARAMS}
    SELECT p.key || ' · ' || s.name AS sprint, p.name AS project, s.status::text AS status, s.start_date, s.end_date,
           (s.status = 'active' AND s.end_date < min(params.as_of)) AS stale,
           count(i.id) AS items, count(i.id) FILTER (WHERE ws.name = 'Done') AS items_done,
           coalesce(sum(i.story_points), 0) AS points, coalesce(sum(i.story_points) FILTER (WHERE ws.name = 'Done'), 0) AS points_done,
           count(*) OVER () AS total_rows
    FROM sprints s JOIN projects p ON p.id = s.project_id
    LEFT JOIN issues i ON i.sprint_id = s.id AND NOT i.is_deleted
    LEFT JOIN workflow_statuses ws ON ws.id = i.status_id
    CROSS JOIN params
    WHERE s.deleted_at IS NULL AND (params.p_project IS NULL OR s.project_id = params.p_project)
    GROUP BY s.id, p.key, p.name
    ORDER BY s.start_date DESC NULLS LAST, sprint
    LIMIT $6 OFFSET $7`, [...args(w), size, (page - 1) * size]);
  return { total: rows[0]?.total_rows || 0, rows: rows.map(({ total_rows, ...r }) => r) };
}

module.exports = { WIDGETS: W, overview, projectHealth, sprintTable };
