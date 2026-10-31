// Checks the query engine on the dummy data against numbers worked out by hand from the same rows,
// and the API around it. No database is needed: run with  npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
process.env.STATE_FILE = path.join(tmp, 'state.json');
const test = require('node:test');
const assert = require('node:assert');
const { finalize, bucketOf } = require('../server/engine/schema');
const { MemoryAdapter } = require('../server/engine/memory');
const { Builder } = require('../server/engine/postgres');
const E = require('../server/engine/engine');
const helpdesk = require('../server/demo/helpdesk');
const presets = require('../server/demo/presets');

const TODAY = '2026-10-30';
const data = helpdesk.generate(TODAY);
const S = finalize(helpdesk.schema);
const src = { schema: S, adapter: new MemoryAdapter(S, data) };
const byId = (t) => new Map(data[t].map((r) => [r.id, r]));
const customers = byId('customers'), tickets = byId('tickets');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const countBy = (rows, key) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) || 0) + 1), new Map());

test('counts per group and "Other" add up to the hand count', async () => {
  const res = await E.runView(src, { base: 'tickets', measures: [{ fn: 'count' }], group: 'category_id.name', top: 5 });
  const cats = byId('categories');
  const want = countBy(data.tickets, (t) => cats.get(t.category_id).name);
  assert.strictEqual(res.total[0], data.tickets.length);
  for (const g of res.groups.filter((x) => x.key !== '__other')) assert.strictEqual(g.values[0], want.get(g.key), g.key);
  const other = res.groups.find((g) => g.key === '__other');
  const shown = res.groups.filter((g) => g.key !== '__other').reduce((s, g) => s + g.values[0], 0);
  assert.strictEqual(other.values[0], data.tickets.length - shown);
  assert.deepStrictEqual(res.groups.slice(0, 5).map((g) => g.values[0]), [...want.values()].sort((a, b) => b - a).slice(0, 5));
});

test('averages, medians and shares per group match the rows', async () => {
  const res = await E.runView(src, {
    base: 'tickets', group: 'priority',
    measures: [{ fn: 'avg', field: 'resolution_hours' }, { fn: 'median', field: 'first_response_minutes' }, { fn: 'rate', filters: [{ field: 'sla_breached', op: 'is', value: 'Yes' }] }],
  });
  for (const g of res.groups) {
    const rows = data.tickets.filter((t) => t.priority === g.key);
    const res_h = rows.map((t) => t.resolution_hours).filter((v) => v != null);
    near(g.values[0], res_h.reduce((a, b) => a + b, 0) / res_h.length, 'average ' + g.key);
    const fr = rows.map((t) => t.first_response_minutes).filter((v) => v != null).sort((a, b) => a - b);
    near(g.values[1], (fr[Math.floor((fr.length - 1) / 2)] + fr[Math.ceil((fr.length - 1) / 2)]) / 2, 'median ' + g.key);
    near(g.values[2], rows.filter((t) => t.sla_breached).length / rows.length, 'share ' + g.key);
  }
});

test('a dashboard filter on another table reaches through the links', async () => {
  // ticket activity has no customer; it reaches customers through the ticket
  const ctx = { filters: [{ table: 'customers', field: 'segment', op: 'in', value: ['Enterprise'] }] };
  const res = await E.runView(src, { base: 'events', measures: [{ fn: 'count' }] }, ctx);
  const want = data.events.filter((e) => customers.get(tickets.get(e.ticket_id).customer_id).segment === 'Enterprise').length;
  assert.strictEqual(res.total[0], want);
  assert.deepStrictEqual(res.ignored, []);
  // teams cannot reach customers, so the filter is reported as not applied
  const teams = await E.runView(src, { base: 'teams', measures: [{ fn: 'count' }] }, ctx);
  assert.strictEqual(teams.total[0], data.teams.length);
  assert.strictEqual(teams.ignored.length, 1);
});

test('period, previous period and the time series agree', async () => {
  const ctx = { range: { from: '2026-08-01', to: '2026-10-30' }, compare: true, asOf: TODAY };
  const res = await E.runView(src, { base: 'tickets', measures: [{ fn: 'count' }], time: 'created_at', grain: 'week' }, ctx);
  const inRange = (from, to) => data.tickets.filter((t) => t.created_at.slice(0, 10) >= from && t.created_at.slice(0, 10) <= to).length;
  assert.strictEqual(res.total[0], inRange('2026-08-01', '2026-10-30'));
  assert.strictEqual(res.prevTotal[0], inRange('2026-05-02', '2026-07-31'));
  assert.strictEqual(res.time.series[0].values.reduce((a, b) => a + b, 0), res.total[0]);
  assert.strictEqual(res.time.keys[0], bucketOf('2026-08-01', 'week'));
});

test('each measure can count by its own date (created vs resolved)', async () => {
  const res = await E.runView(src, { base: 'tickets', measures: [{ fn: 'count' }, { fn: 'count', time: 'resolved_at' }], time: 'created_at', grain: 'month' });
  const [created, resolved] = res.time.series;
  const month = '2026-09-01';
  const i = res.time.keys.indexOf(month);
  assert.strictEqual(created.values[i], data.tickets.filter((t) => t.created_at.startsWith('2026-09')).length);
  assert.strictEqual(resolved.values[i], data.tickets.filter((t) => t.resolved_at && t.resolved_at.startsWith('2026-09')).length);
});

test('split cells are measured directly, "Other" included', async () => {
  const res = await E.runView(src, { base: 'tickets', measures: [{ fn: 'avg', field: 'satisfaction' }], group: 'channel', split: 'priority', splitTop: 2 });
  const g = res.groups[0];
  const shown = res.splitKeys.filter((k) => k !== '__other');
  const rows = data.tickets.filter((t) => t.channel === g.key && !shown.includes(t.priority) && t.satisfaction != null);
  near(g.segs.find((s) => s.key === '__other').value, rows.reduce((a, t) => a + t.satisfaction, 0) / rows.length, 'other cell');
});

test('the rows behind a clicked value are exactly those counted', async () => {
  const spec = { base: 'tickets', measures: [{ fn: 'count' }], group: 'created_at|weekday', time: 'created_at', grain: 'month' };
  const res = await E.runView(src, spec);
  const sat = res.groups.find((g) => g.key === 'Sat');
  const rec = await E.records(src, spec, {}, { sel: { group: 'Sat', groupShown: res.groups.map((g) => g.key) } });
  assert.strictEqual(rec.total, sat.values[0]);
  const i = res.time.keys.length - 2;
  const bucket = await E.records(src, spec, {}, { sel: { bucket: res.time.keys[i], grain: 'month', series: 'Sat', seriesShown: res.groups.map((g) => g.key) } });
  assert.strictEqual(bucket.total, res.time.series.find((s) => s.key === 'Sat').values[i]);
  assert.ok(rec.columns.some((c) => c.ref === 'customer_id.name' && c.label === 'Customer'));
});

test('calculated fields: time between dates, ranges and regrouped values', async () => {
  const S2 = finalize(helpdesk.schema, { tables: { tickets: { calcs: [
    { col: 'hours_open', label: 'Hours open', kind: 'diff', a: 'created_at', b: 'resolved_at', unit: 'hours' },
    { col: 'speed', label: 'Speed', kind: 'bins', of: 'resolution_hours', edges: [4, 24] },
    { col: 'urgency', label: 'Urgency', kind: 'map', of: 'priority', groups: { Urgent: 'Hot', High: 'Hot' }, rest: 'Normal' },
  ] } } });
  const s2 = { schema: S2, adapter: new MemoryAdapter(S2, data) };
  const res = await E.runView(s2, { base: 'tickets', measures: [{ fn: 'count' }, { fn: 'max', field: 'hours_open' }], group: 'speed' });
  assert.deepStrictEqual(res.groups.map((g) => g.key), ['under 4', '4–24', '24+', '(none)']);
  assert.strictEqual(res.groups[0].values[0], data.tickets.filter((t) => t.resolution_hours != null && t.resolution_hours < 4).length);
  const hot = await E.runView(s2, { base: 'tickets', measures: [{ fn: 'count' }], filters: [{ field: 'urgency', op: 'in', value: ['Hot'] }] });
  assert.strictEqual(hot.total[0], data.tickets.filter((t) => ['Urgent', 'High'].includes(t.priority)).length);
});

test('unknown fields, links and unfitting filters are refused', async () => {
  await assert.rejects(E.runView(src, { base: 'tickets', group: 'password' }), /Unknown field/);
  await assert.rejects(E.runView(src, { base: 'tickets', group: 'nope_id.name' }), /Unknown link/);
  await assert.rejects(E.runView(src, { base: 'nope' }), /Choose a table/);
  await assert.rejects(E.runView(src, { base: 'tickets', measures: [{ fn: 'sum', field: 'status' }] }), /number field/);
  await assert.rejects(E.runView(src, { base: 'tickets', filters: [{ field: 'status', op: 'ge', value: 'x' }] }), /does not fit/);
});

test('SQL for a database never contains the values people type', () => {
  const sneaky = "x'); DROP TABLE tickets; --";
  const S3 = finalize({ ...helpdesk.schema, tables: Object.fromEntries(Object.entries(helpdesk.schema.tables).map(([k, t]) => [k, { ...t, sqlName: ['public', k] }])) });
  const b = new Builder(S3, 'tickets');
  const sql = [b.cond({ field: 'subject', op: 'contains', value: sneaky }), b.cond({ field: 'customer_id.region', op: 'in', value: [sneaky] }), b.measure({ fn: 'count', filters: [{ field: 'status', op: 'is', value: sneaky }] })].join(' ');
  assert.ok(!sql.includes('DROP'), sql);
  assert.ok(b.params.some((p) => String(p).includes('DROP')));
  assert.match(b.from(), /LEFT JOIN "public"."customers" t1 ON t1."id" = t0."customer_id"/);
});

// ---- the HTTP API ----
let server, base;
test.before(async () => {
  const { app, ready } = require('../server/index');
  await ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  server.close();
  for (const s of require('../server/sources').list()) { const src = require('../server/sources').get(s.id); if (src.adapter.close) await src.adapter.close(); }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const call = async (method, url, body, expect = 200) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json();
  assert.strictEqual(r.status, expect, url + ' -> ' + JSON.stringify(out).slice(0, 300));
  return out;
};

test('every starter and built widget runs on both dummy sources', async () => {
  const sources = await call('GET', '/api/sources');
  assert.deepStrictEqual(sources.map((s) => s.id), ['helpdesk', 'sales']);
  for (const s of sources) {
    const dashes = [...(presets[s.id] || []), await call('POST', `/api/s/${s.id}/autodash`, {})];
    for (const d of dashes) {
      for (const w of d.widgets) {
        if (w.chart === 'text') continue;
        const ctx = { range: { from: '2026-01-01', to: TODAY }, compare: true };
        if (w.chart === 'records') await call('POST', `/api/s/${s.id}/records`, { spec: w.spec, ctx, columns: w.opts.columns });
        else assert.ok((await call('POST', `/api/s/${s.id}/query`, { spec: w.spec, ctx })).measures.length, w.title);
      }
    }
  }
});

// uploads are streamed as the request body and imported in the background; this waits for the job
async function upload(text, query) {
  const r = await fetch(`${base}/api/sources/upload?${new URLSearchParams(query)}`, { method: 'POST', body: text });
  const { job, error } = await r.json();
  assert.ok(job, error);
  for (;;) {
    const j = await (await fetch(`${base}/api/jobs/${job}`)).json();
    if (j.state === 'done') return j.sourceId;
    if (j.state === 'error') throw new Error(j.error);
    await new Promise((res) => setTimeout(res, 50));
  }
}

test('an uploaded CSV becomes a source, and links found from column names wait for confirmation', async () => {
  const people = 'id,name,team\n1,Ana,Red\n2,Bo,Blue\n';
  const jobs = 'job,person_id,hours,done,day,note\nA,1,"1,5",yes,2026-10-01,"says ""hi"", twice"\nB,1,2,no,2026-10-02,\nC,2,"1,004.5",yes,2026-10-02 14:30,"line\nbreak"\n';
  const id = await upload(people, { filename: 'persons.csv', label: 'Test upload' });
  assert.strictEqual(await upload(jobs, { filename: 'jobs.csv', sourceId: id }), id);
  // the link is suggested from the names and values, and only used once confirmed
  const model = await call('GET', `/api/s/${id}/model`);
  const sug = model.rels.filter((r) => r.status === 'suggested');
  assert.deepStrictEqual(sug.map((r) => `${r.from}.${r.col}->${r.to}.${r.toCol} ${r.cardinality}`), ['jobs.person_id->persons.id N:1']);
  assert.strictEqual((await call('GET', `/api/s/${id}/schema`)).links.length, 0);
  await call('POST', `/api/s/${id}/model/confirm`, { ids: sug.map((r) => r.id) });
  const schema = await call('GET', `/api/s/${id}/schema`);
  assert.deepStrictEqual(schema.links.map((l) => `${l.from}.${l.col}->${l.to}.${l.toCol}`), ['jobs.person_id->persons.id']);
  const types = Object.fromEntries(schema.tables.jobs.fields.map((f) => [f.col, f.type]));
  assert.deepStrictEqual([types.hours, types.done, types.day, types.note], ['number', 'bool', 'date', 'text']);
  const res = await call('POST', `/api/s/${id}/query`, { spec: { base: 'jobs', measures: [{ fn: 'sum', field: 'hours' }], group: 'person_id.team' } });
  assert.deepStrictEqual(res.groups.map((g) => [g.key, g.values[0]]), [['Blue', 1004.5], ['Red', 3.5]]);
  const rec = await call('POST', `/api/s/${id}/records`, { spec: { base: 'jobs' }, columns: ['job', 'note', 'done'], sort: 'job', dir: 'asc' });
  assert.deepStrictEqual(rec.rows, [['A', 'says "hi", twice', true], ['B', null, false], ['C', 'line\nbreak', true]]);
  // JSON, one object per line, added to the same source
  await upload('{"id": 7, "name": "Cy", "team": "Red"}\n{"id": 8, "name": "Di", "team": null}\n', { filename: 'more.ndjson', sourceId: id });
  assert.strictEqual((await call('GET', `/api/s/${id}/schema`)).tables.more.rows, 2);
  await assert.rejects(upload('just a header\n', { filename: 'empty.csv', sourceId: id }), /no rows/);
  await call('DELETE', `/api/sources/${id}`);
  await call('GET', `/api/s/${id}/schema`, null, 400);
});

test('the on-disk engine (SQLite) answers exactly like the in-memory one', async () => {
  const { importFile, newJob } = require('../server/importer');
  const { SqliteAdapter } = require('../server/engine/sqlite');
  const dir = path.join(tmp, 'same');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(data)) {
    const file = path.join(dir, name + '.ndjson');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    await importFile(newJob({}), { file, format: 'json', dir, name });
  }
  const raw = { ...helpdesk.schema, tables: Object.fromEntries(Object.entries(helpdesk.schema.tables).map(([k, t]) => [k, { ...t, sqlName: ['t_' + k] }])) };
  const calcs = { tables: { tickets: { calcs: [{ col: 'speed', label: 'Speed', kind: 'bins', of: 'resolution_hours', edges: [4, 24] }, { col: 'wait', label: 'Wait', kind: 'diff', a: 'created_at', b: 'first_response_at', unit: 'minutes' }] } } };
  const SQ = finalize(raw, calcs), SM = finalize(helpdesk.schema, calcs);
  const disk = { schema: SQ, adapter: new SqliteAdapter(SQ, path.join(dir, 'data.sqlite')) };
  const mem = { schema: SM, adapter: new MemoryAdapter(SM, data) };
  const ctx = { range: { from: '2026-05-01', to: '2026-10-30' }, compare: true, asOf: TODAY, filters: [{ table: 'customers', field: 'region', op: 'notin', value: ['Europe'] }] };
  const specs = [
    { base: 'tickets', measures: [{ fn: 'count' }, { fn: 'median', field: 'resolution_hours' }, { fn: 'rate', filters: [{ field: 'sla_breached', op: 'is', value: 'Yes' }] }, { fn: 'distinct', field: 'customer_id.name' }], group: 'agent_id.team_id.name', split: 'priority', splitTop: 2, top: 3 },
    { base: 'tickets', measures: [{ fn: 'count' }], group: 'created_at|weekday', split: 'created_at|hour', splitTop: 24, other: false },
    { base: 'tickets', measures: [{ fn: 'avg', field: 'satisfaction' }], group: 'speed', time: 'created_at', grain: 'week', cumulative: true },
    { base: 'tickets', measures: [{ fn: 'count' }, { fn: 'count', time: 'resolved_at' }], time: 'created_at', grain: 'month' },
    { base: 'events', measures: [{ fn: 'sum', field: 'minutes_spent' }, { fn: 'max', field: 'ticket_id.wait' }], group: 'ticket_id.customer_id.segment', filters: [{ field: 'kind', op: 'contains', value: 'reply' }] },
    { base: 'customers', measures: [{ fn: 'avg', field: 'n__tickets__customer_id' }], group: 'plan', filters: [{ field: 'signed_up', op: 'ge', value: '2024-01-01' }] },
  ];
  const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
  try {
    for (const spec of specs) assert.deepStrictEqual(round(await E.runView(disk, spec, ctx)), round(await E.runView(mem, spec, ctx)), JSON.stringify(spec).slice(0, 120));
    const sel = { sel: { group: 'Mon' }, columns: ['number', 'created_at', 'sla_breached', 'customer_id.name'], sort: 'created_at', size: 20 };
    assert.deepStrictEqual(await E.records(disk, specs[1], ctx, sel), await E.records(mem, specs[1], ctx, sel));
  } finally {
    await disk.adapter.close();
  }
});

test('saved field names and types apply to every query', async () => {
  await call('PUT', '/api/s/helpdesk/overrides', { tables: { tickets: { label: 'Cases', fields: { channel: { label: 'Source' } }, calcs: [{ col: 'calc_x', label: 'Fast', kind: 'bins', of: 'resolution_hours', edges: [8] }] } } });
  const schema = await call('GET', '/api/s/helpdesk/schema');
  assert.strictEqual(schema.tables.tickets.label, 'Cases');
  assert.ok(schema.tables.tickets.fields.some((f) => f.col === 'calc_x' && f.type === 'text'));
  const res = await call('POST', '/api/s/helpdesk/query', { spec: { base: 'tickets', measures: [{ fn: 'count' }], group: 'channel' } });
  assert.strictEqual(res.labels.group, 'Source');
  await call('PUT', '/api/s/helpdesk/overrides', { tables: {} });
});

// ---- relationships (server/relations.js) ----
const { olistLike } = require('./fixtures/olist-like');
const modelCall = (id, action, body) => call('POST', `/api/s/${id}/model/${action}`, body || {});
const pairOf = (r) => `${r.from}.${r.col}>${r.to}.${r.toCol} ${r.cardinality}`;
const rowsOf = (text) => text.trim().split('\n').slice(1).map((l) => l.split(','));

test('several files: keys and relationships are found from names and values, and wait for review', async () => {
  const files = olistLike(500);
  const names = { customers: 'olist_customers_dataset.csv', orders: 'olist_orders_dataset.csv', order_items: 'olist_order_items_dataset.csv', products: 'olist_products_dataset.csv', sellers: 'olist_sellers_dataset.csv', geolocation: 'olist_geolocation_dataset.csv', translation: 'product_category_name_translation.csv' };
  let id = null;
  for (const [table, file] of Object.entries(names)) id = await upload(files[file], { filename: file, table, label: 'Olist test', detect: '0', ...(id ? { sourceId: id } : {}) });
  // the same table twice is refused, unless replacing it is asked for
  await assert.rejects(upload(files[names.orders], { filename: 'orders.csv', table: 'orders', sourceId: id }), /already in this source/);
  await upload(files[names.orders], { filename: 'orders.csv', table: 'orders', sourceId: id, replace: '1', detect: '0' });

  const m = await modelCall(id, 'detect');
  const keys = Object.fromEntries(m.tables.map((t) => [t.name, t.key]));
  assert.deepStrictEqual(keys, { customers: 'customer_id', orders: 'order_id', order_items: null, products: 'product_id', sellers: 'seller_id', geolocation: null, translation: 'product_category_name' });
  assert.deepStrictEqual(m.rels.filter((r) => r.cardinality !== 'N:M').map(pairOf).sort(), [
    'order_items.order_id>orders.order_id N:1', 'order_items.product_id>products.product_id N:1', 'order_items.seller_id>sellers.seller_id N:1',
    'orders.customer_id>customers.customer_id N:1', 'products.product_category_name>translation.product_category_name N:1',
  ]);
  assert.ok(m.rels.every((r) => r.status === 'suggested' && r.origin === 'auto' && !r.followed));
  assert.ok(m.rels.some((r) => r.cardinality === 'N:M' && /zip_code_prefix/.test(r.col)), 'zip codes are offered as many to many');

  const after = await modelCall(id, 'confirm', { ids: m.rels.map((r) => r.id) });
  assert.ok(after.rels.filter((r) => r.cardinality !== 'N:M').every((r) => r.followed));
  assert.ok(after.rels.filter((r) => r.cardinality === 'N:M').every((r) => !r.followed), 'many to many is never joined');
  // a chart two relationships away matches a count by hand
  const state = new Map(rowsOf(files[names.customers]).map((r) => [r[0], r[4]]));
  const custOf = new Map(rowsOf(files[names.orders]).map((r) => [r[0], r[1]]));
  const want = new Map();
  for (const r of rowsOf(files[names.order_items])) { const s = state.get(custOf.get(r[0])); want.set(s, (want.get(s) || 0) + 1); }
  const res = await call('POST', `/api/s/${id}/query`, { spec: { base: 'order_items', measures: [{ fn: 'count' }], group: 'order_id.customer_id.customer_state' } });
  assert.deepStrictEqual(Object.fromEntries(res.groups.map((g) => [g.key, g.values[0]])), Object.fromEntries(want));
  // a lookup table keyed by text works too
  const cat = await call('POST', `/api/s/${id}/query`, { spec: { base: 'order_items', measures: [{ fn: 'count' }], group: 'product_id.product_category_name.product_category_name_english' } });
  assert.strictEqual(cat.groups.reduce((s, g) => s + g.values[0], 0), rowsOf(files[names.order_items]).length);
  assert.ok(!cat.groups.some((g) => g.key === '(none)'));

  // ---- drawn by hand: written from the many side, checked against the data ----
  const drawn = await modelCall(id, 'create', { from: 'customers', col: 'customer_id', to: 'orders', toCol: 'customer_id' });
  assert.strictEqual(drawn.rels.filter((r) => r.from === 'orders' && r.col === 'customer_id').length, 1, 'the same pair is not related twice');
  const states = await modelCall(id, 'create', { from: 'customers', col: 'customer_state', to: 'sellers', toCol: 'seller_state' });
  const nm = states.rels.find((r) => r.origin === 'manual' && r.col === 'customer_state');
  assert.strictEqual(nm.cardinality, 'N:M');
  await assert.rejects(modelCall(id, 'edit', { id: nm.id, cardinality: 'N:1' }), /repeat/);
  const hidden = await modelCall(id, 'delete', { ids: [nm.id] });
  assert.ok(!hidden.rels.some((r) => r.id === nm.id) && hidden.hidden.some((h) => h.col === 'customer_state'));
  assert.ok(!(await modelCall(id, 'detect')).rels.some((r) => r.col === 'customer_state'), 'a deleted relationship is not offered again');
  await assert.rejects(modelCall(id, 'create', { from: 'customers', col: 'nope', to: 'orders', toCol: 'order_id' }), /Unknown column/);

  // ---- leaving tables out: their relationships go, the data stays ----
  const out = await modelCall(id, 'remove-tables', { tables: ['sellers'] });
  assert.deepStrictEqual(out.removed.map((t) => t.name), ['sellers']);
  assert.ok(!out.rels.some((r) => r.to === 'sellers' || r.from === 'sellers'));
  assert.ok(!(await call('GET', `/api/s/${id}/schema`)).tables.sellers);
  await assert.rejects(upload(files[names.sellers], { filename: 'sellers.csv', table: 'sellers', sourceId: id }), /already in this source/);
  const back = await modelCall(id, 'restore-tables', { tables: ['sellers'] });
  assert.strictEqual(back.tables.find((t) => t.name === 'sellers').rows, rowsOf(files[names.sellers]).length);
  assert.ok((await modelCall(id, 'detect')).rels.some((r) => r.to === 'sellers' && r.status === 'suggested'));
  await modelCall(id, 'layout', { positions: { orders: { x: 120, y: 340 } } });
  assert.deepStrictEqual((await call('GET', `/api/s/${id}/model`)).layout.orders, { x: 120, y: 340 });
  await call('DELETE', `/api/sources/${id}`);
});

test('relationships defined by the source show as such and can be hidden and put back', async () => {
  const m = await call('GET', '/api/s/helpdesk/model');
  const db = m.rels.filter((r) => r.origin === 'db');
  assert.strictEqual(db.length, helpdesk.schema.links.length);
  assert.ok(db.every((r) => r.status === 'active' && r.followed));
  const r = db.find((x) => x.from === 'tickets' && x.col === 'customer_id');
  await assert.rejects(modelCall('helpdesk', 'edit', { id: r.id, cardinality: '1:1' }), /cannot be changed/);
  const hidden = await modelCall('helpdesk', 'delete', { ids: [r.id] });
  assert.ok(!(await call('GET', '/api/s/helpdesk/schema')).links.some((l) => l.from === 'tickets' && l.col === 'customer_id'));
  await call('POST', '/api/s/helpdesk/query', { spec: { base: 'tickets', group: 'customer_id.region' } }, 400);
  await modelCall('helpdesk', 'unhide', { sigs: hidden.hidden.map((h) => h.sig) });
  const res = await call('POST', '/api/s/helpdesk/query', { spec: { base: 'tickets', group: 'customer_id.region' } });
  // the server's dummy data ends today, so compare with its own row count rather than a fixed day's
  const rows = (await call('GET', '/api/s/helpdesk/schema')).tables.tickets.rows;
  assert.strictEqual(res.groups.reduce((s, g) => s + g.values[0], 0), rows);
});

test('finding relationships among 150 tables stays quick and exact', async () => {
  const relations = require('../server/relations');
  const raw = { tables: {}, links: [] };
  const rows = {};
  const dims = Array.from({ length: 20 }, (_, i) => `thing${i}`);
  for (const d of dims) {
    raw.tables[`dim_${d}`] = { key: 'id', syntheticKey: true, fields: { [`${d}_id`]: { type: 'text' }, [`${d}_name`]: { type: 'text' } } };
    rows[`dim_${d}`] = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), [`${d}_id`]: `${d}-${i}`, [`${d}_name`]: `name ${i}` }));
  }
  let expected = 0;
  for (let k = 0; k < 130; k++) {
    const refs = [...new Set([dims[k % 20], dims[(k * 7 + 3) % 20]])];
    expected += refs.length;
    raw.tables[`fact_${k}`] = { key: 'id', syntheticKey: true, fields: Object.fromEntries([[`fact${k}_id`, { type: 'text' }], ...refs.map((d) => [`${d}_id`, { type: 'text' }]), ['amount', { type: 'number' }]]) };
    rows[`fact_${k}`] = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), [`fact${k}_id`]: `f${k}-${i}`, ...Object.fromEntries(refs.map((d) => [`${d}_id`, `${d}-${(i * 7) % 40}`])), amount: i }));
  }
  const S = finalize(raw);
  const src = { raw, schema: S, adapter: new MemoryAdapter(S, rows), kind: 'upload' };
  const t = Date.now();
  const m = await relations.detect(src, relations.emptyModel());
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.strictEqual(m.rels.length, expected, m.rels.filter((r) => !r.to.startsWith('dim_')).map(pairOf).slice(0, 5).join('; '));
  assert.ok(m.rels.every((r) => r.cardinality === 'N:1' && r.to.startsWith('dim_') && r.col === r.toCol));
});
