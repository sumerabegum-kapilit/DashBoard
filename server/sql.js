// SQL shared by the dashboard queries.
// Every query starts with the same parameters, in this order:
//   $1 from date, $2 to date, $3 project id (or null), $4 longest valid time entry in minutes, $5 "as of" date.
const config = require('./config');

const PARAMS = `params AS (
  SELECT $1::date AS d_from, $2::date AS d_to, $3::uuid AS p_project, $4::int AS max_min, $5::date AS as_of,
         ($1::date - ($2::date - $1::date + 1)) AS p_from, ($1::date - 1) AS p_to
)`;

// One row per live (not deleted) work item, with its done date and cycle time.
// Done date: the resolution date, else the last move to Done. Cycle time: first move into
// In Progress / In Review / Blocked until done.
const ITEMS = `${PARAMS},
st AS (
  SELECT h.issue_id,
         min(h.changed_at) FILTER (WHERE h.new_value->>'name' IN ('In Progress', 'In Review', 'Blocked')) AS started_at,
         max(h.changed_at) FILTER (WHERE h.new_value->>'name' = 'Done') AS done_hist
  FROM issue_history h
  WHERE h.field_name = 'status'
  GROUP BY h.issue_id
),
it AS (
  SELECT i.id, i.issue_key, i.title, i.project_id, p.name AS project, p.project_type::text AS ptype,
         i.issue_type::text AS type, i.priority::text AS priority, ws.name AS status,
         coalesce(ws.name = 'Done', false) AS is_done,
         i.assignee_id, coalesce(u.full_name, 'Unassigned') AS assignee, i.story_points::float8 AS points,
         i.created_at::date AS created, i.due_date AS due, x.done_at::date AS done,
         CASE WHEN x.done_at IS NOT NULL AND st.started_at IS NOT NULL AND x.done_at >= st.started_at
              THEN extract(epoch FROM x.done_at - st.started_at) / 3600 END AS cycle_h
  FROM issues i
  JOIN projects p ON p.id = i.project_id
  LEFT JOIN workflow_statuses ws ON ws.id = i.status_id
  LEFT JOIN users u ON u.id = i.assignee_id
  LEFT JOIN st ON st.issue_id = i.id
  CROSS JOIN LATERAL (SELECT CASE WHEN ws.name = 'Done' THEN coalesce(i.resolution_date, st.done_hist, i.updated_at) END AS done_at) x
  CROSS JOIN params
  WHERE NOT i.is_deleted AND (params.p_project IS NULL OR i.project_id = params.p_project)
)`;

// Valid time entries on live work items, in the window and project.
const HOURS = `SELECT t.*, i.project_id
  FROM time_logs t
  JOIN issues i ON i.id = t.issue_id AND NOT i.is_deleted
  CROSS JOIN params
  WHERE t.time_spent_minutes <= params.max_min AND (params.p_project IS NULL OR i.project_id = params.p_project)`;

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const grainSql = (g) => {
  if (!GRAINS.includes(g)) throw new Error('Unknown time step');
  return g;
};
// Every bucket of the window, so empty days or weeks still show as zero.
const buckets = (g) => `b AS (SELECT generate_series(date_trunc('${grainSql(g)}', d_from), d_to, interval '1 ${g}')::date AS k FROM params)`;

const args = (w) => [w.from, w.to, w.project, config.maxEntryMinutes, w.asOf];

module.exports = { PARAMS, ITEMS, HOURS, GRAINS, grainSql, buckets, args };
