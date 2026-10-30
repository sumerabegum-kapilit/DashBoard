// "Build a view": turns a business user's choices into SQL over the live tables.
// Tables, fields, links and borrowed totals are defined here; anything not defined is refused,
// and every value a user types is sent as a query parameter, never pasted into the SQL.
const { query } = require('./db');
const config = require('./config');

const MAX = () => config.maxEntryMinutes;
const LIVE_ITEM = (col) => `JOIN issues li ON li.id = ${col} AND NOT li.is_deleted`;

const F = (label, type = 'text') => ({ label, type });
const TABLES = {
  items: {
    label: 'Work items', display: `t.key || ' · ' || t.title`, date: 'created',
    source: `(SELECT i.id, i.issue_key AS key, i.title, i.issue_type::text AS type, i.priority::text AS priority, ws.name AS status,
        i.project_id, i.assignee_id, i.reporter_id, i.sprint_id, i.epic_id,
        i.created_at::date AS created, x.done_at::date AS done, i.due_date AS due, i.story_points::float8 AS points,
        CASE WHEN x.done_at IS NOT NULL AND st.started_at IS NOT NULL AND x.done_at >= st.started_at
             THEN round((extract(epoch FROM x.done_at - st.started_at) / 3600)::numeric, 1) END AS cycle_hours,
        CASE WHEN x.done_at IS NOT NULL THEN round((extract(epoch FROM x.done_at - i.created_at) / 86400)::numeric, 1) END AS lead_days,
        dor.items AS checklist_items, dor.ticked AS checklist_ticked
      FROM issues i
      LEFT JOIN workflow_statuses ws ON ws.id = i.status_id
      LEFT JOIN LATERAL (
        SELECT min(h.changed_at) FILTER (WHERE h.new_value->>'name' IN ('In Progress', 'In Review', 'Blocked')) AS started_at,
               max(h.changed_at) FILTER (WHERE h.new_value->>'name' = 'Done') AS done_hist
        FROM issue_history h WHERE h.issue_id = i.id AND h.field_name = 'status') st ON true
      CROSS JOIN LATERAL (SELECT CASE WHEN ws.name = 'Done' THEN coalesce(i.resolution_date, st.done_hist, i.updated_at) END AS done_at) x
      LEFT JOIN LATERAL (SELECT count(*)::int AS items, count(*) FILTER (WHERE d.checked)::int AS ticked
                         FROM dor_issue_checklist d WHERE d.issue_id = i.id AND d.is_active) dor ON true
      WHERE NOT i.is_deleted)`,
    fields: {
      key: F('Key'), title: F('Title'), type: F('Type'), priority: F('Priority'), status: F('Status'),
      created: F('Created', 'date'), done: F('Completed', 'date'), due: F('Due', 'date'), points: F('Story points', 'number'),
      cycle_hours: F('Cycle time (hours)', 'number'), lead_days: F('Lead time (days)', 'number'),
      checklist_items: F('Checklist items', 'number'), checklist_ticked: F('Checklist items ticked', 'number'),
    },
  },
  projects: {
    label: 'Projects', display: 't.name', date: 'created',
    source: `(SELECT id, name, key::text AS key, project_type::text AS type, status::text AS status, owner_id,
        created_at::date AS created, start_date, end_date FROM projects WHERE deleted_at IS NULL)`,
    fields: { name: F('Name'), key: F('Key'), type: F('Project type'), status: F('Status'), created: F('Created', 'date'), start_date: F('Start date', 'date'), end_date: F('End date', 'date') },
  },
  people: {
    label: 'People', display: 't.name', date: 'created',
    source: `(SELECT id, full_name AS name, org_role::text AS org_role, is_active AS active, created_at::date AS created,
        last_login_at::date AS last_login FROM users WHERE deleted_at IS NULL)`,
    fields: { name: F('Name'), org_role: F('Organisation role'), active: F('Active', 'bool'), created: F('Joined', 'date'), last_login: F('Last login', 'date') },
  },
  sprints: {
    label: 'Sprints', display: 't.name', date: 'start_date',
    source: `(SELECT id, project_id, name, status::text AS status, start_date, end_date, committed_points, created_at::date AS created
        FROM sprints WHERE deleted_at IS NULL)`,
    fields: { name: F('Name'), status: F('Status'), start_date: F('Start date', 'date'), end_date: F('End date', 'date'), committed_points: F('Committed points', 'number'), created: F('Created', 'date') },
  },
  timelogs: {
    label: 'Time entries', date: 'day',
    source: `(SELECT t.id, t.issue_id AS item_id, t.user_id AS person_id, t.logged_date AS day,
        round(t.time_spent_minutes / 60.0, 2) AS hours, t.source FROM time_logs t ${LIVE_ITEM('t.issue_id')})`,
    fields: { day: F('Day', 'date'), hours: F('Hours', 'number'), source: F('Source') },
  },
  comments: {
    label: 'Comments', date: 'created',
    source: `(SELECT c.id, c.issue_id AS item_id, c.created_by AS author_id, c.created_at::date AS created,
        c.is_edited AS edited, c.is_deleted AS deleted FROM comments c ${LIVE_ITEM('c.issue_id')})`,
    fields: { created: F('Written on', 'date'), edited: F('Edited', 'bool'), deleted: F('Deleted', 'bool') },
  },
  changes: {
    label: 'Status changes', date: 'date',
    source: `(SELECT h.id, h.issue_id AS item_id, h.changed_by AS person_id, h.changed_at::date AS date,
        extract(hour FROM h.changed_at)::int AS hour, h.old_value->>'name' AS from_status, h.new_value->>'name' AS to_status
        FROM issue_history h ${LIVE_ITEM('h.issue_id')} WHERE h.field_name = 'status')`,
    fields: { date: F('Date', 'date'), hour: F('Hour of day', 'number'), from_status: F('From status'), to_status: F('To status') },
  },
  memberships: {
    label: 'Project memberships', date: 'joined',
    source: `(SELECT m.id, m.project_id, m.user_id AS person_id, m.project_role::text AS role, m.is_active AS active,
        m.joined_at::date AS joined, m.last_active_at::date AS last_active FROM project_members m)`,
    fields: { role: F('Role'), active: F('Active', 'bool'), joined: F('Joined', 'date'), last_active: F('Last active', 'date') },
  },
  watchers: {
    label: 'Watchers', date: 'watched',
    source: `(SELECT w.issue_id AS item_id, w.user_id AS person_id, w.watched_at::date AS watched FROM issue_watchers w ${LIVE_ITEM('w.issue_id')})`,
    fields: { watched: F('Started watching', 'date') },
  },
  links: {
    label: 'Links between items', date: 'created',
    source: `(SELECT l.id, l.source_issue_id AS from_id, l.target_issue_id AS to_id, l.link_type::text AS link_type,
        l.created_at::date AS created FROM issue_links l)`,
    fields: { link_type: F('Link type'), created: F('Created', 'date') },
  },
};

// table, column, table it points to, name of the link
const LINKS = [
  ['items', 'project_id', 'projects', 'Project'], ['items', 'assignee_id', 'people', 'Assignee'], ['items', 'reporter_id', 'people', 'Reporter'],
  ['items', 'sprint_id', 'sprints', 'Sprint'], ['items', 'epic_id', 'items', 'Epic'],
  ['projects', 'owner_id', 'people', 'Owner'], ['sprints', 'project_id', 'projects', 'Project'],
  ['timelogs', 'item_id', 'items', 'Work item'], ['timelogs', 'person_id', 'people', 'Person'],
  ['comments', 'item_id', 'items', 'Work item'], ['comments', 'author_id', 'people', 'Author'],
  ['changes', 'item_id', 'items', 'Work item'], ['changes', 'person_id', 'people', 'Changed by'],
  ['memberships', 'project_id', 'projects', 'Project'], ['memberships', 'person_id', 'people', 'Person'],
  ['watchers', 'item_id', 'items', 'Work item'], ['watchers', 'person_id', 'people', 'Watcher'],
  ['links', 'from_id', 'items', 'From item'], ['links', 'to_id', 'items', 'To item'],
];

// Totals a table borrows from the tables that point to it. `a` is the alias of the row they are counted for.
const ROLLUPS = [
  ['items', 'n_timelogs', 'Number of time entries', (a) => `(SELECT count(*) FROM time_logs x WHERE x.issue_id = ${a}.id)`],
  ['items', 'hours_logged', 'Hours logged (valid entries)', (a) => `(SELECT coalesce(sum(x.time_spent_minutes), 0) / 60.0 FROM time_logs x WHERE x.issue_id = ${a}.id AND x.time_spent_minutes <= ${MAX()})`],
  ['items', 'n_comments', 'Number of comments', (a) => `(SELECT count(*) FROM comments x WHERE x.issue_id = ${a}.id)`],
  ['items', 'n_changes', 'Number of status changes', (a) => `(SELECT count(*) FROM issue_history x WHERE x.issue_id = ${a}.id AND x.field_name = 'status')`],
  ['items', 'n_watchers', 'Number of watchers', (a) => `(SELECT count(*) FROM issue_watchers x WHERE x.issue_id = ${a}.id)`],
  ['items', 'n_links', 'Number of links to other items', (a) => `(SELECT count(*) FROM issue_links x WHERE x.source_issue_id = ${a}.id OR x.target_issue_id = ${a}.id)`],
  ['projects', 'n_items', 'Number of work items', (a) => `(SELECT count(*) FROM issues x WHERE x.project_id = ${a}.id AND NOT x.is_deleted)`],
  ['projects', 'sum_points', 'Story points', (a) => `(SELECT coalesce(sum(x.story_points), 0) FROM issues x WHERE x.project_id = ${a}.id AND NOT x.is_deleted)`],
  ['projects', 'n_sprints', 'Number of sprints', (a) => `(SELECT count(*) FROM sprints x WHERE x.project_id = ${a}.id AND x.deleted_at IS NULL)`],
  ['projects', 'n_members', 'Number of members', (a) => `(SELECT count(*) FROM project_members x WHERE x.project_id = ${a}.id AND x.is_active)`],
  ['projects', 'hours_logged', 'Hours logged (valid entries)', (a) => `(SELECT coalesce(sum(x.time_spent_minutes), 0) / 60.0 FROM time_logs x JOIN issues xi ON xi.id = x.issue_id AND NOT xi.is_deleted WHERE xi.project_id = ${a}.id AND x.time_spent_minutes <= ${MAX()})`],
  ['people', 'n_assigned', 'Number of items assigned', (a) => `(SELECT count(*) FROM issues x WHERE x.assignee_id = ${a}.id AND NOT x.is_deleted)`],
  ['people', 'n_reported', 'Number of items reported', (a) => `(SELECT count(*) FROM issues x WHERE x.reporter_id = ${a}.id AND NOT x.is_deleted)`],
  ['people', 'hours_logged', 'Hours logged (valid entries)', (a) => `(SELECT coalesce(sum(x.time_spent_minutes), 0) / 60.0 FROM time_logs x ${LIVE_ITEM('x.issue_id')} WHERE x.user_id = ${a}.id AND x.time_spent_minutes <= ${MAX()})`],
  ['people', 'n_comments', 'Number of comments written', (a) => `(SELECT count(*) FROM comments x ${LIVE_ITEM('x.issue_id')} WHERE x.created_by = ${a}.id)`],
  ['people', 'n_changes', 'Number of status changes made', (a) => `(SELECT count(*) FROM issue_history x ${LIVE_ITEM('x.issue_id')} WHERE x.changed_by = ${a}.id AND x.field_name = 'status')`],
  ['people', 'n_projects', 'Number of projects joined', (a) => `(SELECT count(*) FROM project_members x WHERE x.user_id = ${a}.id AND x.is_active)`],
  ['people', 'n_watching', 'Number of items watched', (a) => `(SELECT count(*) FROM issue_watchers x ${LIVE_ITEM('x.issue_id')} WHERE x.user_id = ${a}.id)`],
  ['sprints', 'n_items', 'Number of work items', (a) => `(SELECT count(*) FROM issues x WHERE x.sprint_id = ${a}.id AND NOT x.is_deleted)`],
  ['sprints', 'sum_points', 'Story points', (a) => `(SELECT coalesce(sum(x.story_points), 0) FROM issues x WHERE x.sprint_id = ${a}.id AND NOT x.is_deleted)`],
];

const FNS = ['count', 'sum', 'avg', 'median', 'min', 'max', 'distinct'];
const ADDITIVE = ['count', 'sum'];
const OPS = { text: ['is', 'not', 'contains', 'empty', 'notempty'], number: ['ge', 'le', 'is', 'empty', 'notempty'], date: ['ge', 'le', 'empty', 'notempty'], bool: ['is'] };
const PARTS = ['month', 'quarter', 'year', 'weekday'];
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const NONE = '(none)';
const OTHER = '__other';

function fieldsOf(table) {
  const own = Object.entries(TABLES[table].fields).map(([col, f]) => ({ col, ...f }));
  for (const [on, col, label] of ROLLUPS) if (on === table) own.push({ col, label, type: 'number', rollup: true });
  return own;
}

// Follows a path like "item_id.project_id.type|month" from the starting table.
function resolve(base, ref) {
  if (typeof ref !== 'string' || !ref) throw new Error('A field is missing');
  const [path, part] = ref.split('|');
  if (part && !PARTS.includes(part)) throw new Error('Unknown date part');
  const steps = path.split('.');
  if (steps.length > 3) throw new Error('Fields can be at most two links away');
  const col = steps.pop();
  let table = base;
  const hops = [];
  for (const fk of steps) {
    const link = LINKS.find(([t, c]) => t === table && c === fk);
    if (!link) throw new Error('Unknown link: ' + fk);
    hops.push(fk);
    table = link[2];
  }
  const field = fieldsOf(table).find((f) => f.col === col);
  if (!field) throw new Error('Unknown field: ' + col);
  if (part && field.type !== 'date') throw new Error('Only dates can be split into months, years or weekdays');
  return { table, hops, field, part, type: part ? 'text' : field.type };
}

// Builds FROM + joins as fields are used; values become numbered parameters.
class Builder {
  constructor(base) {
    this.base = base;
    this.aliases = new Map([['', 't0']]);
    this.joins = [];
    this.params = [];
  }
  alias(hops) {
    const key = hops.join('.');
    if (this.aliases.has(key)) return this.aliases.get(key);
    const parent = this.alias(hops.slice(0, -1));
    let table = this.base;
    for (const fk of hops.slice(0, -1)) table = LINKS.find(([t, c]) => t === table && c === fk)[2];
    const fk = hops[hops.length - 1];
    const target = LINKS.find(([t, c]) => t === table && c === fk)[2];
    const a = 't' + this.aliases.size;
    this.aliases.set(key, a);
    this.joins.push(`LEFT JOIN ${TABLES[target].source} ${a} ON ${a}.id = ${parent}.${fk}`);
    return a;
  }
  expr(ref) {
    const r = resolve(this.base, ref);
    const a = this.alias(r.hops);
    const rollup = r.field.rollup ? ROLLUPS.find(([on, col]) => on === r.table && col === r.field.col) : null;
    let sql = rollup ? rollup[3](a) : `${a}.${r.field.col}`;
    if (r.part === 'month') sql = `to_char(${sql}, 'YYYY-MM')`;
    if (r.part === 'quarter') sql = `to_char(${sql}, 'YYYY "Q"Q')`;
    if (r.part === 'year') sql = `to_char(${sql}, 'YYYY')`;
    if (r.part === 'weekday') sql = `trim(to_char(${sql}, 'Dy'))`;
    return { sql, type: r.type, field: r.field, part: r.part };
  }
  param(v) {
    this.params.push(v);
    return '$' + this.params.length;
  }
  from() {
    return `FROM ${TABLES[this.base].source} t0 ${this.joins.join(' ')}`;
  }
}

const textOf = (sql) => `coalesce((${sql})::text, '${NONE}')`;
const boolText = (sql) => `CASE WHEN (${sql}) IS NULL THEN '${NONE}' WHEN (${sql}) THEN 'Yes' ELSE 'No' END`;
const keyOf = (e) => (e.type === 'bool' ? boolText(e.sql) : textOf(e.sql));

function measure(spec, b) {
  if (spec.fn === 'count') return 'count(*)';
  const e = b.expr(spec.field);
  if (spec.fn === 'distinct') return `count(DISTINCT ${e.sql})`;
  if (e.type !== 'number') throw new Error('Sum, average, median, lowest and highest need a number field');
  const v = `(${e.sql})::float8`;
  return { sum: `sum(${v})`, avg: `avg(${v})`, median: `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${v})`, min: `min(${v})`, max: `max(${v})` }[spec.fn];
}

function condition(f, b) {
  const e = b.expr(f.field);
  const ops = OPS[e.type] || OPS.text;
  if (!ops.includes(f.op)) throw new Error('That filter does not fit this field');
  const v = f.value == null ? '' : String(f.value).slice(0, 500);
  switch (f.op) {
    case 'empty': return `(${e.sql}) IS NULL`;
    case 'notempty': return `(${e.sql}) IS NOT NULL`;
    case 'is':
      if (e.type === 'bool') return `(${e.sql}) = ${b.param(v === 'Yes')}`;
      if (e.type === 'number') return `(${e.sql})::numeric = ${b.param(v)}::numeric`;
      return `(${e.sql})::text = ${b.param(v)}`;
    case 'not': return `((${e.sql}) IS NULL OR (${e.sql})::text <> ${b.param(v)})`;
    case 'contains': return `(${e.sql})::text ILIKE ${b.param('%' + v.replace(/[\\%_]/g, (c) => '\\' + c) + '%')}`;
    case 'ge':
    case 'le': {
      const cmp = f.op === 'ge' ? '>=' : '<=';
      if (e.type === 'number') return `(${e.sql})::numeric ${cmp} ${b.param(v)}::numeric`;
      if (e.type === 'date') return `(${e.sql})::date ${cmp} ${b.param(v)}::date`;
      return `(${e.sql})::text ${cmp} ${b.param(v)}`;
    }
    default: throw new Error('Unknown filter');
  }
}

function validate(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (!TABLES[s.base]) throw new Error('Choose a table to start from');
  const spec = {
    base: s.base,
    fn: FNS.includes(s.fn) ? s.fn : 'count',
    field: s.field || '',
    group: s.group || '',
    split: s.split || '',
    time: s.time || '',
    grain: GRAINS.includes(s.grain) ? s.grain : 'auto',
    top: Math.min(100, Math.max(1, Number(s.top) || 10)),
    filters: Array.isArray(s.filters) ? s.filters.filter((f) => f && f.field && f.op).slice(0, 20) : [],
  };
  if (spec.fn !== 'count' && !spec.field) throw new Error('Choose the field to calculate');
  for (const k of ['field', 'group', 'split', 'time']) if (spec[k]) resolve(spec.base, spec[k]);
  if (spec.time && resolve(spec.base, spec.time).type !== 'date') throw new Error('"Over time" needs a date field');
  return spec;
}

// A query over the starting table with the user's filters, plus optional extra conditions.
function build(spec, selectFn, extra = () => []) {
  const b = new Builder(spec.base);
  const where = spec.filters.map((f) => condition(f, b));
  const select = selectFn(b);
  where.push(...extra(b));
  return { b, text: `SELECT ${select} ${b.from()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` };
}
const run = async ({ b, text }, tail = '') => query(text + tail, b.params);

function sortGroups(spec, ref, list) {
  const r = resolve(spec.base, ref);
  if (r.part === 'weekday') return list.sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key));
  if (r.part || r.field.type === 'date') return list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return list.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || String(a.key).localeCompare(String(b.key)));
}
async function topKeys(spec, ref, limit) {
  const rows = await run(build(spec, (b) => `${keyOf(b.expr(ref))} AS k, ${measure(spec, b)} AS v`), ' GROUP BY 1');
  const list = sortGroups(spec, ref, rows.map((r) => ({ key: r.k, value: r.v })));
  return { keep: list.slice(0, limit), rest: list.slice(limit) };
}

const DAY = 864e5;
function autoGrain(lo, hi) {
  const days = (Date.parse(hi) - Date.parse(lo)) / DAY + 1;
  return days <= 31 ? 'day' : days <= 150 ? 'week' : days <= 800 ? 'month' : 'quarter';
}

async function runView(raw) {
  const spec = validate(raw);
  const out = { spec, additive: ADDITIVE.includes(spec.fn) };
  const [tot] = await run(build(spec, (b) => `count(*) AS n, ${measure(spec, b)} AS v`));
  out.rows = tot.n;
  out.total = tot.v;

  if (spec.group) {
    const { keep, rest } = await topKeys(spec, spec.group, spec.top);
    out.groups = keep;
    if (rest.length) {
      const other = out.additive
        ? rest.reduce((s, g) => s + (g.value || 0), 0)
        : (await run(build(spec, (b) => `${measure(spec, b)} AS v`, (b) => [`${keyOf(b.expr(spec.group))} <> ALL(${b.param(keep.map((g) => g.key))}::text[])`])))[0].v;
      out.groups.push({ key: OTHER, value: other, count: rest.length });
    }
  }
  if (spec.split) {
    const { keep, rest } = await topKeys(spec, spec.split, 6);
    out.splitKeys = keep.map((s) => s.key);
    if (rest.length) out.splitKeys.push(OTHER);
    if (out.groups && out.additive) {
      const rows = await run(build(spec, (b) => `${keyOf(b.expr(spec.group))} AS g, ${keyOf(b.expr(spec.split))} AS s, ${measure(spec, b)} AS v`), ' GROUP BY 1, 2');
      const shownGroups = new Set(out.groups.map((g) => g.key));
      for (const g of out.groups) {
        const mine = rows.filter((r) => (g.key === OTHER ? !shownGroups.has(r.g) : r.g === g.key));
        g.segs = out.splitKeys.map((k) => ({
          key: k,
          value: mine.filter((r) => (k === OTHER ? !out.splitKeys.includes(r.s) : r.s === k)).reduce((s, r) => s + (r.v || 0), 0),
        }));
      }
    }
  }
  if (spec.time) {
    const [span] = await run(build(spec, (b) => { const t = b.expr(spec.time).sql; return `min(${t})::date AS lo, max(${t})::date AS hi`; }));
    if (span.lo) {
      const grain = spec.grain === 'auto' ? autoGrain(span.lo, span.hi) : spec.grain;
      const keys = (await query(`SELECT generate_series(date_trunc('${grain}', $1::date), $2::date, interval '1 ${grain}')::date AS k`, [span.lo, span.hi])).map((r) => r.k);
      const dimRef = spec.split || spec.group;
      const lines = spec.split ? out.splitKeys : spec.group ? out.groups.map((g) => g.key) : ['__all'];
      const rows = await run(build(spec, (b) => `date_trunc('${grain}', ${b.expr(spec.time).sql})::date AS k, ${dimRef ? keyOf(b.expr(dimRef)) : `'__all'`} AS s, ${measure(spec, b)} AS v`,
        (b) => [`(${b.expr(spec.time).sql}) IS NOT NULL`]), ' GROUP BY 1, 2');
      const at = new Map(keys.map((k, i) => [k, i]));
      const shown = new Set(lines.filter((k) => k !== OTHER));
      const empty = out.additive || spec.fn === 'distinct' ? 0 : null;
      const series = lines.map((k) => ({ key: k, values: keys.map(() => empty) }));
      const byKey = new Map(series.map((s) => [s.key, s]));
      let otherNeedsQuery = false;
      for (const r of rows) {
        const i = at.get(r.k);
        if (i === undefined) continue;
        const name = r.s === '__all' || shown.has(r.s) ? r.s : OTHER;
        const s = byKey.get(name);
        if (!s) continue;
        if (name !== OTHER) s.values[i] = r.v; // one row per bucket and line
        else if (out.additive) s.values[i] = (s.values[i] || 0) + (r.v || 0);
        else otherNeedsQuery = true; // a median or average of "Other" needs its own query
      }
      if (otherNeedsQuery && byKey.has(OTHER)) {
        const oRows = await run(build(spec, (b) => `date_trunc('${grain}', ${b.expr(spec.time).sql})::date AS k, ${measure(spec, b)} AS v`,
          (b) => [`(${b.expr(spec.time).sql}) IS NOT NULL`, `${keyOf(b.expr(dimRef))} <> ALL(${b.param([...shown])}::text[])`]), ' GROUP BY 1');
        const o = byKey.get(OTHER);
        for (const r of oRows) if (at.has(r.k)) o.values[at.get(r.k)] = r.v;
      }
      out.time = { grain, keys, series };
    }
  }
  return out;
}

// The rows behind a value the user clicked, one page at a time.
async function records(raw, sel = {}, page = 1, size = 10) {
  const spec = validate(raw);
  const strings = (v) => (Array.isArray(v) ? v.map(String).slice(0, 200) : []);
  const extra = (b) => {
    const c = [];
    const match = (ref, key, notIn) => {
      if (!ref) return;
      const k = keyOf(b.expr(ref));
      if (key === OTHER) c.push(`${k} <> ALL(${b.param(strings(notIn))}::text[])`);
      else if (key !== undefined && key !== null) c.push(`${k} = ${b.param(String(key))}`);
    };
    match(spec.group, sel.group, sel.groupShown);
    match(spec.split, sel.split, sel.splitShown);
    if (sel.series !== undefined && sel.series !== '__all') match(spec.split || spec.group, sel.series, sel.seriesShown);
    if (sel.bucket && spec.time && GRAINS.includes(sel.grain)) c.push(`date_trunc('${sel.grain}', ${b.expr(spec.time).sql})::date = ${b.param(sel.bucket)}::date`);
    return c;
  };
  const cols = [];
  const sel_ = (b) => {
    const parts = [];
    for (const f of fieldsOf(spec.base).filter((x) => !x.rollup)) { parts.push(`t0.${f.col} AS "${f.col}"`); cols.push({ key: f.col, label: f.label, type: f.type }); }
    for (const [from, col, to, name] of LINKS) {
      if (from !== spec.base || !TABLES[to].display) continue;
      const a = b.alias([col]);
      parts.push(`${TABLES[to].display.replace(/\bt\./g, a + '.')} AS "${col}__name"`);
      cols.push({ key: col + '__name', label: name, type: 'text' });
    }
    parts.push('count(*) OVER () AS total_rows');
    return parts.join(', ');
  };
  const q = build(spec, sel_, extra);
  const dateCol = TABLES[spec.base].date;
  const rows = await run(q, ` ORDER BY t0.${dateCol} DESC NULLS LAST LIMIT ${Number(size)} OFFSET ${(Math.max(1, Number(page)) - 1) * Number(size)}`);
  return { columns: cols, total: rows[0]?.total_rows || 0, rows: rows.map(({ total_rows, ...r }) => r) };
}

let countsCache = null;
async function describeModel() {
  if (!countsCache || Date.now() - countsCache.at > 60_000) {
    const counts = {};
    await Promise.all(Object.entries(TABLES).map(async ([k, t]) => { counts[k] = (await query(`SELECT count(*) AS n FROM ${t.source} t`))[0].n; }));
    countsCache = { at: Date.now(), counts };
  }
  return {
    tables: Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [k, { label: t.label, rows: countsCache.counts[k], fields: fieldsOf(k).map(({ col, label, type, rollup }) => ({ col, label, type, rollup: !!rollup })) }])),
    links: LINKS.map(([from, col, to, name]) => ({ from, col, to, name })),
    fns: FNS, additive: ADDITIVE, ops: OPS, parts: PARTS, grains: GRAINS,
  };
}

// Distinct values of a field, for filter dropdowns.
async function values(base, ref) {
  if (!TABLES[base]) throw new Error('Unknown table');
  const b = new Builder(base);
  const e = b.expr(ref);
  const rows = await query(`SELECT ${keyOf(e)} AS v, count(*) AS n ${b.from()} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 300`, b.params);
  return rows.filter((r) => r.v !== NONE);
}

module.exports = { TABLES, LINKS, ROLLUPS, runView, records, describeModel, values, validate, resolve, OTHER };
