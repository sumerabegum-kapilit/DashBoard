// Tests for the data studio module. Run: node --test "test/*.test.js"
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const ds = require('..');
const { Builder: PgBuilder } = require('../server/providers/postgres');
const { shop, shopTables } = require('../examples/host-app/sample-data');

const TODAY = '2026-10-30';
const DATA = shop(TODAY);
const clone = (v) => JSON.parse(JSON.stringify(v));
const withRows = () => shopTables.map((t) => ({ ...clone(t), rows: clone(DATA[t.name]) }));
const sourceDef = (id, extra = {}) => ({ id, label: 'Shop', asOf: TODAY, tables: withRows(), ...extra });

// round every number deeply, so float sums from different engines compare equal
const roundDeep = (v) => {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
};
const byKey = (groups) => Object.fromEntries(groups.map((g) => [g.key, g.values[0]]));
const countBy = (rows, keyFn) => { const m = {}; for (const r of rows) { const k = keyFn(r); m[k] = (m[k] || 0) + 1; } return m; };
const sumBy = (rows, keyFn, valFn) => { const m = {}; for (const r of rows) { const k = keyFn(r); m[k] = (m[k] || 0) + valFn(r); } return m; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} != ${b}`);

const custById = new Map(DATA.customers.map((c) => [c.customer_id, c]));
const orderById = new Map(DATA.orders.map((o) => [o.order_id, o]));

// confirm the suggested order_lines relationships of a source
async function detectAndConfirm(studio, id) {
  const model = await studio.changeModel(id, 'detect');
  const want = model.rels.filter((r) => r.from === 'order_lines' && ((r.col === 'order_id' && r.to === 'orders') || (r.col === 'product_id' && r.to === 'products')));
  return studio.changeModel(id, 'confirm', { ids: want.map((r) => r.id) });
}

// ---------------------------------------------------------------------------
describe('registerSource from metadata + rows (memory)', () => {
  let studio;
  before(async () => {
    studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    await studio.registerSource({ id: 'shop2', asOf: TODAY, tables: clone(shopTables), provider: ds.memoryProvider(clone(DATA)) });
  });

  test('summary, schema tables and row counts', async () => {
    const list = await studio.listSources();
    assert.deepEqual(list.map((s) => s.id).sort(), ['shop', 'shop2']);
    assert.equal(list.find((s) => s.id === 'shop').kind, 'memory');
    for (const id of ['shop', 'shop2']) {
      const s = await studio.getSchema(id);
      assert.deepEqual(Object.keys(s.tables).sort(), ['customers', 'order_lines', 'orders', 'products']);
      assert.equal(s.tables.customers.rows, 300);
      assert.equal(s.tables.products.rows, 40);
      assert.equal(s.tables.orders.rows, 2500);
      assert.equal(s.tables.order_lines.rows, DATA.order_lines.length);
      assert.deepEqual(s.can, { model: true, dashboards: true });
      assert.equal(s.asOf, TODAY);
      // the declared foreign key column is hidden; the link is there
      assert.equal(s.tables.orders.fields.find((f) => f.col === 'customer_id').hidden, true);
      assert.ok(s.links.some((l) => l.from === 'orders' && l.col === 'customer_id' && l.to === 'customers'));
    }
  });

  test('declared foreign key shows in the model as origin db, followed', async () => {
    const m = await studio.getModel('shop');
    const fk = m.rels.find((r) => r.from === 'orders' && r.col === 'customer_id');
    assert.ok(fk);
    assert.equal(fk.origin, 'db');
    assert.equal(fk.to, 'customers');
    assert.equal(fk.toCol, 'customer_id');
    assert.equal(fk.status, 'active');
    assert.equal(fk.followed, true);
    assert.equal(fk.cardinality, 'N:1');
  });

  test('count orders by customer region equals a hand count', async () => {
    const want = countBy(DATA.orders, (o) => custById.get(o.customer_id).region);
    for (const id of ['shop', 'shop2']) {
      const res = await studio.query(id, { base: 'orders', group: 'customer_id.region' });
      assert.equal(res.rows, 2500);
      assert.deepEqual(res.total, [2500]);
      assert.deepEqual(byKey(res.groups), want);
      // auto sort: biggest first
      const vals = res.groups.map((g) => g.values[0]);
      assert.deepEqual(vals, vals.slice().sort((a, b) => b - a));
    }
  });

  test('sum, filters and records', async () => {
    const want = DATA.orders.filter((o) => o.status === 'Delivered').reduce((a, o) => a + o.total, 0);
    const res = await studio.query('shop', { base: 'orders', measures: [{ fn: 'sum', field: 'total' }], filters: [{ field: 'status', op: 'is', value: 'Delivered' }] });
    near(res.total[0], want);
    const rec = await studio.records('shop', { spec: { base: 'orders' }, size: 5, sort: 'total', dir: 'desc' });
    assert.equal(rec.total, 2500);
    assert.equal(rec.rows.length, 5);
    const ti = rec.columns.findIndex((c) => c.ref === 'total');
    assert.equal(rec.rows[0][ti], Math.max(...DATA.orders.map((o) => o.total)));
    const vals = await studio.values('shop', { base: 'orders', field: 'status' });
    assert.deepEqual(Object.fromEntries(vals.map((v) => [v.v, v.n])), countBy(DATA.orders, (o) => o.status));
  });

  test('bad input is rejected', async () => {
    await assert.rejects(studio.registerSource({ id: 'bad id!', tables: withRows() }));
    await assert.rejects(studio.registerSource({ id: 'nodata', tables: clone(shopTables) }), /data provider/);
    await assert.rejects(studio.query('shop', { base: 'nope' }), /Choose a table/);
    await assert.rejects(studio.query('missing', { base: 'orders' }), (e) => e.status === 404);
    await assert.rejects(studio.changeModel('shop', 'bogus'), (e) => e.status === 400);
  });

  test('refreshSource starts a new version', async () => {
    const v = studio.source('shop').version;
    studio.refreshSource('shop');
    assert.equal(studio.source('shop').version, v + 1);
    assert.throws(() => studio.refreshSource('nope'), (e) => e.status === 404);
  });
});

// ---------------------------------------------------------------------------
describe('relationship detection and multi-hop queries', () => {
  let studio;
  const ctx = { range: { from: '2026-07-01', to: '2026-09-30' } };
  before(async () => {
    studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
  });

  test('before detection, order_lines has no period date and a range is not applied', async () => {
    const s = await studio.getSchema('shop');
    assert.equal(s.tables.order_lines.date, null);
    const res = await studio.query('shop', { base: 'order_lines' }, ctx);
    assert.equal(res.range, null);
    assert.equal(res.total[0], DATA.order_lines.length);
    await assert.rejects(studio.query('shop', { base: 'order_lines', group: 'order_id.status' }), /Unknown link/);
  });

  test('detect suggests order_lines -> orders and -> products (N:1), not followed yet', async () => {
    const m = await studio.changeModel('shop', 'detect');
    const ol = m.rels.find((r) => r.from === 'order_lines' && r.col === 'order_id');
    const pr = m.rels.find((r) => r.from === 'order_lines' && r.col === 'product_id');
    for (const [r, to, toCol] of [[ol, 'orders', 'order_id'], [pr, 'products', 'product_id']]) {
      assert.ok(r, 'suggested ' + to);
      assert.equal(r.to, to);
      assert.equal(r.toCol, toCol);
      assert.equal(r.status, 'suggested');
      assert.equal(r.origin, 'auto');
      assert.equal(r.cardinality, 'N:1');
      assert.equal(r.coverage, 1);
      assert.equal(r.followed, false);
    }
    // the declared FK is not suggested again
    assert.equal(m.rels.filter((r) => r.from === 'orders' && r.col === 'customer_id').length, 1);
    assert.ok(m.detectedAt);
    // keys found from the data
    const keys = Object.fromEntries(m.tables.map((t) => [t.name, t.key]));
    assert.deepEqual(keys, { customers: 'customer_id', products: 'product_id', orders: 'order_id', order_lines: 'line_id' });
  });

  test('confirm makes them followed; 2-hop query matches a hand computation', async () => {
    const m = await detectAndConfirm(studio, 'shop');
    for (const col of ['order_id', 'product_id']) {
      const r = m.rels.find((x) => x.from === 'order_lines' && x.col === col);
      assert.equal(r.status, 'active');
      assert.equal(r.followed, true);
    }
    const want = sumBy(DATA.order_lines, (l) => custById.get(orderById.get(l.order_id).customer_id).segment, (l) => l.amount);
    const res = await studio.query('shop', { base: 'order_lines', measures: [{ fn: 'sum', field: 'amount' }], group: 'order_id.customer_id.segment' });
    const got = byKey(res.groups);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
    for (const k of Object.keys(want)) near(got[k], want[k], k);
    // products category: 1 hop through the confirmed relationship
    const wantQty = sumBy(DATA.order_lines, (l) => DATA.products.find((p) => p.product_id === l.product_id).category, (l) => l.quantity);
    const r2 = await studio.query('shop', { base: 'order_lines', measures: [{ fn: 'sum', field: 'quantity' }], group: 'product_id.category' });
    assert.deepEqual(byKey(r2.groups), wantQty);
  });

  test('after confirming, the order date applies to order_lines', async () => {
    const s = await studio.getSchema('shop');
    assert.equal(s.tables.order_lines.date, 'order_id.ordered_at');
    const res = await studio.query('shop', { base: 'order_lines', measures: [{ fn: 'sum', field: 'amount' }] }, ctx);
    assert.ok(res.range);
    const inRange = DATA.order_lines.filter((l) => { const d = orderById.get(l.order_id).ordered_at.slice(0, 10); return d >= ctx.range.from && d <= ctx.range.to; });
    assert.equal(res.rows, inRange.length);
    near(res.total[0], inRange.reduce((a, l) => a + l.amount, 0));
  });

  test('delete hides a relationship; a dismissed db FK stops being followed and can be unhidden', async () => {
    let m = await studio.getModel('shop');
    const fk = m.rels.find((r) => r.origin === 'db');
    m = await studio.changeModel('shop', 'delete', { ids: [fk.id] });
    assert.equal(m.rels.some((r) => r.origin === 'db'), false);
    assert.equal(m.hidden.length, 1);
    await assert.rejects(studio.query('shop', { base: 'orders', group: 'customer_id.region' }), /Unknown link/);
    m = await studio.changeModel('shop', 'unhide', { sigs: [m.hidden[0].sig] });
    assert.ok(m.rels.some((r) => r.origin === 'db' && r.followed));
  });

  test('remove-tables / restore-tables and layout', async () => {
    let m = await studio.changeModel('shop', 'remove-tables', { tables: ['products'] });
    assert.deepEqual(m.removed.map((t) => t.name), ['products']);
    assert.equal((await studio.getSchema('shop')).tables.products, undefined);
    m = await studio.changeModel('shop', 'restore-tables', { tables: ['products'] });
    assert.deepEqual(m.removed, []);
    assert.ok((await studio.getSchema('shop')).tables.products);
    assert.deepEqual(await studio.changeModel('shop', 'layout', { positions: { orders: { x: 10.4, y: 20 } } }), { saved: true });
    assert.deepEqual((await studio.getModel('shop')).layout.orders, { x: 10, y: 20 });
  });

  test('create a relationship by hand, then edit it', async () => {
    const s2 = ds.createStudio();
    await s2.registerSource(sourceDef('x'));
    let m = await s2.changeModel('x', 'create', { from: 'order_lines', col: 'order_id', to: 'orders', toCol: 'order_id' });
    const r = m.rels.find((x) => x.from === 'order_lines');
    assert.equal(r.origin, 'manual');
    assert.equal(r.cardinality, 'N:1');
    assert.equal(r.coverage, 1);
    assert.equal(r.followed, true);
    m = await s2.changeModel('x', 'edit', { id: r.id, status: 'inactive' });
    assert.equal(m.rels.find((x) => x.id === r.id).followed, false);
    await assert.rejects(s2.changeModel('x', 'create', { from: 'orders', col: 'customer_id', to: 'customers', toCol: 'customer_id' }), /already defined/);
  });
});

// ---------------------------------------------------------------------------
describe('sqlite provider gives the same answers as memory', () => {
  let studio, db;
  before(async () => {
    db = new DatabaseSync(':memory:');
    ds.sqliteFunctions(db);
    for (const t of shopTables) {
      db.exec(`CREATE TABLE "${t.name}" (${t.columns.map((c) => `"${c.name}"`).join(', ')})`);
      const ins = db.prepare(`INSERT INTO "${t.name}" VALUES (${t.columns.map(() => '?').join(', ')})`);
      db.exec('BEGIN');
      for (const r of DATA[t.name]) ins.run(...t.columns.map((c) => (typeof r[c.name] === 'boolean' ? (r[c.name] ? 1 : 0) : r[c.name] ?? null)));
      db.exec('COMMIT');
    }
    studio = ds.createStudio();
    await studio.registerSource(sourceDef('mem'));
    await studio.registerSource({ id: 'sql', asOf: TODAY, tables: clone(shopTables), provider: ds.sqliteProvider({ query: (sql, params) => db.prepare(sql).all(params) }) });
    await detectAndConfirm(studio, 'mem');
    await detectAndConfirm(studio, 'sql');
  });
  after(() => db.close());

  test('same schema counts and detected model', async () => {
    const a = await studio.getSchema('mem'), b = await studio.getSchema('sql');
    assert.equal(b.kind, 'sqlite');
    for (const t of Object.keys(a.tables)) assert.equal(b.tables[t].rows, a.tables[t].rows);
    const strip = (m) => m.rels.map(({ id, from, col, to, toCol, status, cardinality, origin, followed, coverage }) => ({ id, from, col, to, toCol, status, cardinality, origin, followed, coverage })).sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(strip(await studio.getModel('sql')), strip(await studio.getModel('mem')));
  });

  const range = { from: '2026-04-01', to: '2026-09-30' };
  const cases = [
    ['group', { base: 'orders', group: 'customer_id.region' }],
    ['top + other', { base: 'orders', measures: [{ fn: 'sum', field: 'total' }], group: 'customer_id', top: 8 }],
    ['group + split', { base: 'orders', group: 'channel', split: 'status', measures: [{ fn: 'avg', field: 'total' }] }],
    ['split with other', { base: 'orders', group: 'customer_id.region', split: 'customer_id', splitTop: 3 }],
    ['time series by month', { base: 'orders', time: 'ordered_at', grain: 'month', measures: [{ fn: 'sum', field: 'total' }] }],
    ['time series with split', { base: 'order_lines', time: 'order_id.ordered_at', grain: 'quarter', split: 'product_id.category' }],
    ['median', { base: 'order_lines', measures: [{ fn: 'median', field: 'amount' }, { fn: 'min', field: 'amount' }, { fn: 'max', field: 'quantity' }], group: 'order_id.customer_id.segment' }],
    ['rate', { base: 'orders', measures: [{ fn: 'rate', filters: [{ field: 'paid', op: 'is', value: 'Yes' }] }], group: 'channel' }],
    ['distinct', { base: 'orders', measures: [{ fn: 'distinct', field: 'customer_id' }], group: 'status' }],
    ['filters', { base: 'orders', group: 'status', filters: [{ field: 'total', op: 'ge', value: '500' }, { field: 'customer_id.segment', op: 'in', value: ['Enterprise', 'Mid-market'] }, { field: 'channel', op: 'not', value: 'Partner' }] }],
    ['contains + date parts', { base: 'orders', group: 'ordered_at|weekday', filters: [{ field: 'customer_id.name', op: 'contains', value: 'leaf' }] }],
    ['bool group', { base: 'orders', group: 'paid', measures: [{ fn: 'count' }, { fn: 'sum', field: 'total' }] }],
  ];
  const ctxs = [
    ['no ctx', undefined],
    ['range + compare + dashboard filter', { range, compare: true, filters: [{ table: 'customers', field: 'region', op: 'is', value: 'North' }] }],
  ];
  for (const [name, spec] of cases) {
    for (const [cname, ctx] of ctxs) {
      test(`${name} (${cname})`, async () => {
        const a = await studio.query('mem', spec, ctx);
        const b = await studio.query('sql', spec, ctx);
        assert.deepEqual(roundDeep(b), roundDeep(a));
        assert.ok(a.rows > 0);
      });
    }
  }

  test('a hand-checked compare total', async () => {
    const res = await studio.query('sql', { base: 'orders' }, { range, compare: true });
    const inR = (o, f, t) => o.ordered_at.slice(0, 10) >= f && o.ordered_at.slice(0, 10) <= t;
    assert.equal(res.total[0], DATA.orders.filter((o) => inR(o, range.from, range.to)).length);
    // 183 days before 2026-04-01: 2025-09-30 .. 2026-03-31
    assert.equal(res.prevTotal[0], DATA.orders.filter((o) => inR(o, '2025-09-30', '2026-03-31')).length);
  });

  test('records and values agree', async () => {
    const body = { spec: { base: 'orders', group: 'status' }, sel: { group: 'Returned' }, size: 20, sort: 'total', dir: 'asc', columns: ['order_id', 'total', 'paid', 'customer_id.region'] };
    const a = await studio.records('mem', body), b = await studio.records('sql', body);
    assert.deepEqual(roundDeep(b), roundDeep(a));
    assert.equal(a.total, DATA.orders.filter((o) => o.status === 'Returned').length);
    const va = await studio.values('mem', { base: 'orders', field: 'customer_id.segment' });
    assert.deepEqual(await studio.values('sql', { base: 'orders', field: 'customer_id.segment' }), va);
  });
});

// ---------------------------------------------------------------------------
describe('display overrides and calculated columns', () => {
  let studio, before0;
  before(async () => {
    studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    before0 = clone(studio.source('shop').provider.data.orders);
  });

  test('rename, hide, reorder and a bins column', async () => {
    const maps = await studio.setOverrides('shop', {
      tables: {
        orders: {
          label: 'Sales orders',
          fields: { total: { label: 'Order total' }, channel: { hidden: true }, nope: { label: 'x' } },
          calcs: [
            { col: 'total_band', label: 'Total band', kind: 'bins', of: 'total', edges: [1000, 100] },
            { col: 'bad_diff', kind: 'diff', a: 'total', b: 'status', unit: 'days' },
          ],
          order: ['total_band', 'total', 'order_id', 'unknown', 'total'],
        },
        ghost: { label: 'no such table' },
      },
    });
    const t = maps.tables.find((x) => x.name === 'orders');
    assert.equal(t.label, 'Sales orders');
    assert.equal(t.removed, false);
    assert.deepEqual(t.columns.map((c) => c.name), ['total_band', 'total', 'order_id', 'customer_id', 'ordered_at', 'status', 'channel', 'paid']);
    assert.deepEqual(t.columns.map((c) => c.order), [0, 1, 2, 3, 4, 5, 6, 7]);
    const col = (n) => t.columns.find((c) => c.name === n);
    assert.equal(col('total').label, 'Order total');
    assert.equal(col('channel').hidden, true);
    assert.equal(col('total_band').calculated, true);
    assert.equal(col('total_band').type, 'text');
    assert.equal(col('bad_diff'), undefined, 'a diff of non-dates is not applicable');
    assert.ok(!maps.tables.some((x) => x.name === 'ghost'));
    const saved = studio.source('shop').overrides.tables.orders;
    assert.deepEqual(saved.order, ['total_band', 'total', 'order_id']);
    assert.equal(saved.calcs.length, 1);

    const s = await studio.getSchema('shop');
    assert.equal(s.tables.orders.label, 'Sales orders');
    assert.equal(s.tables.orders.fields[0].col, 'total_band');
  });

  test('queries use the calculated column; labels follow the overrides', async () => {
    const band = (v) => (v < 100 ? 'under 100' : v < 1000 ? '100–1000' : '1000+');
    const res = await studio.query('shop', { base: 'orders', group: 'total_band' });
    assert.deepEqual(byKey(res.groups), countBy(DATA.orders, (o) => band(o.total)));
    // bins keep their natural order
    assert.deepEqual(res.groups.map((g) => g.key), ['under 100', '100–1000', '1000+'].filter((k) => res.groups.some((g) => g.key === k)));
    const r2 = await studio.query('shop', { base: 'orders', measures: [{ fn: 'sum', field: 'total' }] });
    assert.equal(r2.measures[0].label, 'Total of order total');
    const r3 = await studio.query('shop', { base: 'orders' });
    assert.equal(r3.measures[0].label, 'Number of sales orders');
  });

  test('the data itself is untouched', () => {
    assert.deepEqual(studio.source('shop').provider.data.orders, before0);
    assert.ok(!('total_band' in studio.source('shop').provider.data.orders[0]));
    assert.ok(!('total_band' in DATA.orders[0]));
  });

  test('a renamed table shows original and display names in mappings after being removed', async () => {
    await studio.changeModel('shop', 'remove-tables', { tables: ['orders'] });
    const t = (await studio.getMappings('shop')).tables.find((x) => x.name === 'orders');
    assert.equal(t.removed, true);
    assert.equal(t.label, 'Sales orders');
    await studio.changeModel('shop', 'restore-tables', { tables: ['orders'] });
  });

  test('overrides survive re-registering the source', async () => {
    await studio.registerSource(sourceDef('shop'));
    const s = await studio.getSchema('shop');
    assert.equal(s.tables.orders.label, 'Sales orders');
  });
});

// ---------------------------------------------------------------------------
describe('dashboards', () => {
  const dash = (id, n = 1) => ({ id, title: id, widgets: Array.from({ length: n }, (_, i) => ({ id: 'w' + i, spec: { base: 'orders' } })) });

  test('shared scope: save, get, saveDashboard, deleteDashboard', async () => {
    const studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    assert.deepEqual(await studio.getDashboards('shop'), { dashboards: [], current: null });
    assert.deepEqual(await studio.saveDashboards('shop', { dashboards: [{ ...dash('a'), rangeValue: 'x' }], current: 'a' }), { saved: true });
    let all = await studio.getDashboards('shop', { id: 'someone' });
    assert.deepEqual(all.dashboards, [dash('a')]);
    assert.equal(all.current, 'a');
    assert.ok(all.savedAt);
    await studio.saveDashboard('shop', dash('b', 2));
    await studio.saveDashboard('shop', dash('a', 3));
    all = await studio.getDashboards('shop');
    assert.deepEqual(all.dashboards.map((d) => [d.id, d.widgets.length]), [['a', 3], ['b', 2]]);
    assert.deepEqual(await studio.getDashboard('shop', 'b'), dash('b', 2));
    await assert.rejects(studio.getDashboard('shop', 'zzz'), (e) => e.status === 404);
    assert.deepEqual(await studio.deleteDashboard('shop', 'a'), { deleted: true });
    all = await studio.getDashboards('shop');
    assert.deepEqual(all.dashboards.map((d) => d.id), ['b']);
    assert.equal(all.current, null);
  });

  test('user scope keeps each user apart', async () => {
    const studio = ds.createStudio({ dashboardScope: 'user' });
    await studio.registerSource(sourceDef('shop'));
    await studio.saveDashboard('shop', dash('ann-1'), { id: 'ann' });
    await studio.saveDashboard('shop', dash('bob-1'), 'bob');
    assert.deepEqual((await studio.getDashboards('shop', { id: 'ann' })).dashboards.map((d) => d.id), ['ann-1']);
    assert.deepEqual((await studio.getDashboards('shop', 'bob')).dashboards.map((d) => d.id), ['bob-1']);
    assert.deepEqual((await studio.getDashboards('shop', { id: 'carl' })).dashboards, []);
    assert.deepEqual((await studio.getDashboards('shop')).dashboards, []);
  });

  test('validation errors are 400', async () => {
    const studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    const is400 = (e) => e.status === 400;
    await assert.rejects(studio.saveDashboards('shop', {}), is400);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: 'x' }), is400);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: [{ id: 'a' }] }), is400);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: [{ id: 3, widgets: [] }] }), is400);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: Array.from({ length: 201 }, (_, i) => dash('d' + i, 0)) }), is400);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: [{ id: 'big', widgets: [{ blob: 'x'.repeat(4.5 * 1024 * 1024) }] }] }), is400);
    await assert.rejects(studio.saveDashboard('shop', { title: 'no id' }), is400);
    await assert.rejects(studio.saveDashboards('nope', { dashboards: [] }), (e) => e.status === 404);
  });

  test('starters: host dashboards, or one built from the data', async () => {
    const studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    await studio.registerSource(sourceDef('given', { dashboards: [dash('host')] }));
    assert.deepEqual(await studio.starters('given'), [dash('host')]);
    const [auto] = await studio.starters('shop');
    assert.equal(typeof auto.title, 'string');
    assert.ok(Array.isArray(auto.widgets) && auto.widgets.length > 0);
    // every generated widget runs
    for (const w of auto.widgets) if (w.spec) await studio.query('shop', w.spec);
    const one = await studio.buildDashboard('shop', 'customers');
    assert.ok(Array.isArray(one.widgets));
  });
});

// ---------------------------------------------------------------------------
describe('permissions', () => {
  // viewers may look; admins may change; nobody but admins sees "secret"
  const authorize = ({ user, action, source }) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (source === 'secret') return false;
    return action === 'view';
  };
  const viewer = { id: 'v', role: 'viewer' }, admin = { id: 'a', role: 'admin' };
  let studio;
  before(async () => {
    studio = ds.createStudio({ authorize });
    await studio.registerSource(sourceDef('shop'));
    await studio.registerSource(sourceDef('secret'));
  });

  test('listSources only shows what a user may see', async () => {
    assert.deepEqual((await studio.listSources(viewer)).map((s) => s.id), ['shop']);
    assert.deepEqual((await studio.listSources(admin)).map((s) => s.id).sort(), ['secret', 'shop']);
    assert.deepEqual(await studio.listSources(null), []);
  });

  test('model changes and dashboard saves are 403 for viewers', async () => {
    const is403 = (e) => e.status === 403;
    await assert.rejects(studio.changeModel('shop', 'detect', {}, viewer), is403);
    await assert.rejects(studio.setOverrides('shop', { tables: {} }, viewer), is403);
    await assert.rejects(studio.importConfig('shop', { module: 'datastudio' }, viewer), is403);
    await assert.rejects(studio.saveDashboards('shop', { dashboards: [] }, viewer), is403);
    await assert.rejects(studio.saveDashboard('shop', { id: 'x', widgets: [] }, viewer), is403);
    await assert.rejects(studio.deleteDashboard('shop', 'x', viewer), is403);
    await assert.rejects(studio.query('secret', { base: 'orders' }, {}, viewer), is403);
    await assert.rejects(studio.getSchema('shop', null), is403);
    // viewers can still read
    assert.equal((await studio.query('shop', { base: 'orders' }, {}, viewer)).total[0], 2500);
    assert.deepEqual((await studio.getSchema('shop', viewer)).can, { model: false, dashboards: false });
    assert.deepEqual((await studio.getSchema('shop', admin)).can, { model: true, dashboards: true });
    await studio.changeModel('shop', 'detect', {}, admin);
    await studio.saveDashboard('shop', { id: 'x', widgets: [] }, admin);
  });

  test('an authorize hook that throws denies', async () => {
    const s = ds.createStudio({ authorize: () => { throw new Error('boom'); } });
    await s.registerSource(sourceDef('shop'));
    await assert.rejects(s.getSchema('shop'), (e) => e.status === 403);
    assert.equal(await s.can(null, 'delete-everything', 'shop'), false);
  });
});

// ---------------------------------------------------------------------------
describe('HTTP router and assets', () => {
  const express = require('express');
  let server, base, studio;
  before(async () => {
    studio = ds.createStudio({
      authorize: ({ user, action }) => !!user && (action === 'view' || user.role === 'admin'),
    });
    await studio.registerSource(sourceDef('shop'));
    const app = express();
    app.use((req, res, next) => {
      const h = req.get('x-user');
      if (h) { const [id, role] = h.split(':'); req.user = { id, role }; }
      next();
    });
    app.use('/api', ds.createRouter(studio, { userOf: (req) => req.user, onError: () => {} }));
    app.use('/assets', ds.studioAssets());
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const call = async (method, path, user, body) => {
    const res = await fetch(base + path, { method, headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };

  test('sources list and schema can-flags', async () => {
    let r = await call('GET', '/api/sources', 'v:viewer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((s) => s.id), ['shop']);
    r = await call('GET', '/api/sources', null);
    assert.deepEqual(r.body, []);
    r = await call('GET', '/api/sources/shop/schema', 'v:viewer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.can, { model: false, dashboards: false });
    assert.equal(r.body.tables.orders.rows, 2500);
    r = await call('GET', '/api/sources/shop/schema', 'a:admin');
    assert.deepEqual(r.body.can, { model: true, dashboards: true });
  });

  test('query', async () => {
    const r = await call('POST', '/api/sources/shop/query', 'v:viewer', { spec: { base: 'orders', group: 'customer_id.region' } });
    assert.equal(r.status, 200);
    assert.deepEqual(byKey(r.body.groups), countBy(DATA.orders, (o) => custById.get(o.customer_id).region));
    const bad = await call('POST', '/api/sources/shop/query', 'v:viewer', { spec: { base: 'orders', group: 'nope' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Unknown field/);
  });

  test('model detect: 403 for viewers, works for admins', async () => {
    let r = await call('POST', '/api/sources/shop/model/detect', 'v:viewer', {});
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'You may not change the data model of this source' });
    r = await call('POST', '/api/sources/shop/model/detect', 'a:admin', {});
    assert.equal(r.status, 200);
    assert.ok(r.body.rels.some((x) => x.from === 'order_lines' && x.col === 'order_id' && x.status === 'suggested'));
    r = await call('GET', '/api/sources/shop/model', 'v:viewer');
    assert.equal(r.status, 200);
    r = await call('POST', '/api/sources/shop/model/explode', 'a:admin', {});
    assert.equal(r.status, 400);
  });

  test('404s', async () => {
    let r = await call('GET', '/api/sources/nope/schema', 'a:admin');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Unknown data source' });
    r = await call('GET', '/api/nothing-here', 'a:admin');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Unknown address' });
    r = await call('GET', '/api/sources/shop/dashboards/missing', 'a:admin');
    assert.equal(r.status, 404);
  });

  test('dashboards PUT/GET', async () => {
    const d = { dashboards: [{ id: 'main', title: 'Main', widgets: [{ id: 'w1', spec: { base: 'orders' } }] }], current: 'main' };
    let r = await call('PUT', '/api/sources/shop/dashboards', 'v:viewer', d);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'You may not change the dashboards of this source' });
    r = await call('PUT', '/api/sources/shop/dashboards', 'a:admin', d);
    assert.deepEqual([r.status, r.body], [200, { saved: true }]);
    r = await call('GET', '/api/sources/shop/dashboards', 'v:viewer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.dashboards, d.dashboards);
    r = await call('PUT', '/api/sources/shop/dashboards/second', 'a:admin', { title: 'Second', widgets: [] });
    assert.deepEqual(r.body, { id: 'second', title: 'Second', widgets: [] });
    r = await call('GET', '/api/sources/shop/dashboards/second', 'v:viewer');
    assert.equal(r.body.title, 'Second');
    r = await call('DELETE', '/api/sources/shop/dashboards/second', 'a:admin');
    assert.deepEqual(r.body, { deleted: true });
    r = await call('PUT', '/api/sources/shop/dashboards', 'a:admin', { nope: 1 });
    assert.equal(r.status, 400);
  });

  test('config export over HTTP', async () => {
    const r = await call('GET', '/api/sources/shop/config', 'a:admin');
    assert.equal(r.status, 200);
    assert.equal(r.body.module, 'datastudio');
    assert.equal(r.body.source, 'shop');
  });

  test('a data provider error is a 500 with a generic message', async () => {
    const s = ds.createStudio();
    await s.registerSource({ id: 'broken', tables: clone(shopTables), provider: ds.sqliteProvider({ query: () => { throw Object.assign(new Error('secret db detail'), { code: 'ECONN' }); } }) });
    const app = express();
    app.use('/api', ds.createRouter(s, { onError: () => {} }));
    const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/sources/broken/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: { base: 'orders' } }) });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.doesNotMatch(body.error, /secret db detail/);
    } finally { await new Promise((r) => srv.close(r)); }
  });

  test('studio assets are served', async () => {
    for (const p of ['/assets/studio.js', '/assets/studio.css', '/assets/vendor/d3.min.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.ok((await res.text()).length > 0, p);
    }
    assert.equal((await fetch(base + '/assets/nope.js')).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('exportConfig / importConfig', () => {
  test('round trip into a second studio', async () => {
    const storeA = ds.memoryStore();
    const a = ds.createStudio({ store: storeA });
    await a.registerSource(sourceDef('shop'));
    await detectAndConfirm(a, 'shop');
    await a.setOverrides('shop', { tables: { orders: { label: 'Sales', fields: { status: { label: 'State' } }, calcs: [{ col: 'net', kind: 'arith', a: 'total', op: '*', b: 0.8 }] } } });
    await a.saveDashboard('shop', { id: 'd1', widgets: [{ id: 'w', spec: { base: 'order_lines', group: 'order_id.customer_id.segment' } }] });
    const cfg = await a.exportConfig('shop');
    assert.equal(cfg.module, 'datastudio');
    assert.equal(cfg.version, 1);

    const storeB = ds.memoryStore();
    const b = ds.createStudio({ store: storeB });
    await b.registerSource(sourceDef('shop'));
    await assert.rejects(b.importConfig('shop', { module: 'other' }), (e) => e.status === 400);
    assert.deepEqual(await b.importConfig('shop', JSON.parse(JSON.stringify(cfg))), { imported: true });

    assert.deepEqual(await b.getMappings('shop'), await a.getMappings('shop'));
    const rels = async (s) => (await s.getModel('shop')).rels.map(({ id, status, followed }) => ({ id, status, followed }));
    assert.deepEqual(await rels(b), await rels(a));
    assert.deepEqual((await b.getDashboards('shop')).dashboards, (await a.getDashboards('shop')).dashboards);
    const spec = { base: 'order_lines', measures: [{ fn: 'sum', field: 'amount' }], group: 'order_id.customer_id.segment' };
    assert.deepEqual(await b.query('shop', spec), await a.query('shop', spec));
    const net = await b.query('shop', { base: 'orders', measures: [{ fn: 'sum', field: 'net' }] });
    near(net.total[0], DATA.orders.reduce((s, o) => s + o.total * 0.8, 0));

    // saved in B's store, so a third studio on the same store has it too
    assert.ok((await storeB.keys('source:shop:')).length >= 3);
    const c = ds.createStudio({ store: storeB });
    await c.registerSource(sourceDef('shop'));
    assert.equal((await c.getSchema('shop')).tables.orders.label, 'Sales');
    assert.deepEqual(await rels(c), await rels(a));
  });
});

// ---------------------------------------------------------------------------
describe('SQL safety', () => {
  const EVIL = ["x'; DROP TABLE orders; --", 'Robert"); DELETE FROM customers; --', "2026-01-01' OR '1'='1"];

  test('postgres Builder puts typed values in params, never in SQL text', async () => {
    const studio = ds.createStudio();
    await studio.registerSource(sourceDef('shop'));
    await studio.setOverrides('shop', { tables: { orders: { calcs: [{ col: 'grp', kind: 'map', of: 'status', groups: { [EVIL[0]]: EVIL[1], Delivered: 'Done' }, rest: EVIL[2] }] } } });
    const S = studio.source('shop').schema;
    for (const v of EVIL) {
      const b = new PgBuilder(S, 'orders');
      const conds = [
        { field: 'status', op: 'is', value: v },
        { field: 'status', op: 'not', value: v },
        { field: 'customer_id.region', op: 'contains', value: v },
        { field: 'channel', op: 'in', value: [v, 'Online'] },
        { field: 'channel', op: 'notin', value: [v] },
        { field: 'total', op: 'ge', value: v },
        { field: 'ordered_at', op: 'between', value: [v, v] },
        { field: 'ordered_at', op: 'le', value: v },
        { field: 'ordered_at', op: 'bucket', value: { grain: 'month', key: v } },
        { field: 'paid', op: 'is', value: v },
        { field: 'grp', op: 'is', value: v },
      ];
      const sql = [...conds.map((c) => b.cond(c)), b.measure({ fn: 'count', filters: [{ field: 'status', op: 'is', value: v }] }), b.key({ ref: 'grp' }), b.from()].join(' ');
      for (const e of EVIL) assert.ok(!sql.includes(e), `"${e}" leaked into SQL: ${sql}`);
      assert.ok(!sql.includes('DROP') && !sql.includes('DELETE'));
      assert.ok(b.params.some((p) => p === v || (Array.isArray(p) && p.includes(v)) || (typeof p === 'string' && p.includes(v))));
      assert.throws(() => b.key({ ref: 'ordered_at', grain: "month'); DROP TABLE x; --" }), /Unknown time step/);
    }
  });

  test('the whole query path through postgresProvider keeps values out of SQL text', async () => {
    const seen = [];
    const studio = ds.createStudio();
    await studio.registerSource({ id: 'pg', asOf: TODAY, tables: clone(shopTables), provider: ds.postgresProvider({ query: async (text, params) => { seen.push({ text, params }); return []; } }) });
    const v = EVIL[0];
    await studio.query('pg', { base: 'orders', group: 'status', split: 'channel', time: 'ordered_at', filters: [{ field: 'status', op: 'is', value: v }, { field: 'customer_id.name', op: 'contains', value: v }] },
      { range: { from: '2026-01-01', to: '2026-03-31' }, compare: true, filters: [{ table: 'customers', field: 'region', op: 'in', value: [v] }] });
    await studio.records('pg', { spec: { base: 'orders' }, search: v });
    await studio.values('pg', { base: 'orders', field: 'status', search: v });
    assert.ok(seen.length > 3);
    for (const { text, params } of seen) {
      assert.ok(!text.includes(v) && !text.includes('DROP'), text);
      assert.ok(Array.isArray(params));
    }
    assert.ok(seen.some(({ params }) => JSON.stringify(params).includes('DROP TABLE')));
  });

  test('sqlite provider: injection attempts are inert', async () => {
    const db = new DatabaseSync(':memory:');
    ds.sqliteFunctions(db);
    db.exec('CREATE TABLE t (id, name)');
    db.exec("INSERT INTO t VALUES ('1', 'a'), ('2', 'b')");
    const s = ds.createStudio();
    await s.registerSource({ id: 's', tables: [{ name: 't', primaryKey: 'id', columns: ['id', 'name'] }], provider: ds.sqliteProvider({ query: (sql, p) => db.prepare(sql).all(p) }) });
    const res = await s.query('s', { base: 't', filters: [{ field: 'name', op: 'is', value: "a' OR '1'='1" }] });
    assert.equal(res.total[0], 0);
    await s.query('s', { base: 't', filters: [{ field: 'name', op: 'contains', value: "'); DROP TABLE t; --" }] });
    assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 2);
    db.close();
  });
});

describe('stores', () => {
  test('memoryStore copies values; null removes', async () => {
    const st = ds.memoryStore();
    const v = { a: [1] };
    await st.set('k', v);
    v.a.push(2);
    assert.deepEqual(await st.get('k'), { a: [1] });
    await st.set('k', null);
    assert.equal(await st.get('k'), undefined);
  });

  test('jsonFileStore persists to disk', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
    const file = path.join(dir, 'sub', 'cfg.json');
    try {
      const st = ds.jsonFileStore(file);
      await st.set('source:x:model', { rels: [] });
      assert.deepEqual(await ds.jsonFileStore(file).get('source:x:model'), { rels: [] });
      assert.deepEqual(await ds.jsonFileStore(file).keys('source:'), ['source:x:model']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
