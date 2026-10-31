// The data studio as a service: everything the module does, as plain async functions, with no HTTP and
// no knowledge of where data lives. The host registers sources (table metadata + a data provider) and
// gives the module a store for what people configure and an authorize() hook for who may do what.
// http.js puts these functions behind an Express router; hosts on another framework call them directly.
const { finalize, publicSchema, resolve, checkCalc, TYPES } = require('./engine/schema');
const engine = require('./engine/engine');
const relations = require('./relations');
const autodash = require('./autodash');
const { normalizeTables, normalizeRows, memoryProvider, FORMATS } = require('./input');
const { memoryStore } = require('./stores');

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACTIONS = ['view', 'model', 'dashboards'];
const MAX_DASHBOARDS_BYTES = 4 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

// An error the host and the browser should see as it is, with an HTTP status.
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {object} options
 * @param {object} [options.store]        get(key)/set(key, value), see stores.js (default: in memory)
 * @param {function} [options.authorize]  ({ user, action: 'view'|'model'|'dashboards', source }) => boolean | Promise<boolean>
 * @param {'shared'|'user'} [options.dashboardScope]  one set of dashboards per source, or one per user
 * @param {number} [options.cacheSize]    answers kept per process (default 500)
 */
function createStudio(options = {}) {
  const store = options.store || memoryStore();
  const authorize = options.authorize || (() => true);
  const scope = options.dashboardScope === 'user' ? 'user' : 'shared';
  const cacheSize = options.cacheSize ?? 500;
  const sources = new Map();
  const answers = new Map();
  const key = (id, what) => `source:${id}:${what}`;

  // ---- permissions ----
  async function can(user, action, id) {
    if (!ACTIONS.includes(action)) return false;
    try { return !!(await authorize({ user: user || null, action, source: id })); } catch (e) { return false; }
  }
  async function guard(user, action, id) {
    const src = sources.get(id);
    if (!src) throw fail(404, 'Unknown data source');
    if (!(await can(user, 'view', id)) || (action !== 'view' && !(await can(user, action, id)))) {
      throw fail(403, action === 'view' ? 'You may not see this data source' : action === 'model' ? 'You may not change the data model of this source' : 'You may not change the dashboards of this source');
    }
    return src;
  }

  // ---- sources ----
  function build(src) {
    src.schema = finalize({ ...src.raw, id: src.id, label: src.label, description: src.description }, src.overrides, src.model);
    // a table's period date may run through a relationship that is no longer there
    for (const [t, def] of Object.entries(src.schema.tables)) {
      if (!def.date) continue;
      let ok = false;
      try { ok = resolve(src.schema, t, def.date).type === 'date'; } catch (e) { /* not reachable any more */ }
      if (!ok) def.date = null;
    }
    src.adapter = src.provider.create(src.schema);
    src.version = (src.version || 0) + 1;
    src.counts = null;
    return src;
  }

  /** Adds a source, or replaces it with new metadata or data; what people configured is kept. */
  async function registerSource(def) {
    if (!def || !ID.test(def.id || '')) throw new Error('A source needs an id of letters, digits, "-" or "_"');
    const { raw, rows } = normalizeTables(def.tables);
    const provider = def.provider || (rows ? memoryProvider(rows) : null);
    if (!provider || typeof provider.create !== 'function') throw new Error(`The source "${def.id}" needs a data provider, or rows in its tables`);
    if (provider.kind === 'memory') provider.data = normalizeRows(raw, { ...(rows || {}), ...(provider.data || {}) });
    const old = sources.get(def.id);
    const src = {
      id: def.id, label: String(def.label || def.id), description: String(def.description || ''), raw, provider,
      asOf: def.asOf || null, starters: Array.isArray(def.dashboards) ? def.dashboards : null, version: old ? old.version : 0,
      overrides: (await store.get(key(def.id, 'overrides'))) || { tables: {} },
      model: relations.normalize(await store.get(key(def.id, 'model'))),
    };
    sources.set(src.id, build(src));
    return summary(src);
  }
  function unregisterSource(id) { return sources.delete(id); }
  /** Tell the module the data behind a source changed (answers are no longer reused). */
  function refreshSource(id) {
    const src = sources.get(id);
    if (!src) throw fail(404, 'Unknown data source');
    build(src);
  }
  const summary = (s) => ({ id: s.id, label: s.label, description: s.description, tables: Object.keys(s.schema.tables).length, asOf: s.asOf || today(), kind: s.provider.kind || 'custom' });
  async function listSources(user) {
    const out = [];
    for (const s of sources.values()) if (await can(user, 'view', s.id)) out.push(summary(s));
    return out;
  }
  const asOf = (src) => src.asOf || today();
  async function counts(src) {
    if (!src.counts || Date.now() - src.counts.at > 60_000) {
      const c = {};
      await Promise.all(Object.keys(src.schema.tables).map(async (t) => { try { c[t] = await src.adapter.count(t); } catch (e) { c[t] = null; } }));
      src.counts = { at: Date.now(), c };
    }
    return src.counts.c;
  }

  // ---- reading ----
  async function getSchema(id, user) {
    const src = await guard(user, 'view', id);
    return {
      ...publicSchema(src.schema, await counts(src)), kind: src.provider.kind || 'custom', asOf: asOf(src), overrides: src.overrides, formats: FORMATS,
      can: { model: await can(user, 'model', id), dashboards: await can(user, 'dashboards', id) },
    };
  }
  const ctxOf = (src, ctx) => {
    const c = ctx || {};
    return { range: c.range || null, filters: Array.isArray(c.filters) ? c.filters : [], compare: !!c.compare, asOf: asOf(src) };
  };
  // answers are kept per version of a source: any change to its description or data starts a new one
  function cached(src, kind, body, run) {
    if (!cacheSize) return run();
    const k = `${src.id}:${src.version}:${kind}:${JSON.stringify(body)}`;
    if (answers.has(k)) { const v = answers.get(k); answers.delete(k); answers.set(k, v); return v; }
    const p = Promise.resolve().then(run);
    answers.set(k, p);
    p.catch(() => answers.delete(k));
    while (answers.size > cacheSize) answers.delete(answers.keys().next().value);
    return p;
  }
  /** A widget's numbers. spec and ctx are described in README "Views". */
  async function query(id, spec, ctx, user) {
    const src = await guard(user, 'view', id);
    return cached(src, 'q', [spec, ctx], () => engine.runView(src, spec, ctxOf(src, ctx)));
  }
  async function records(id, body = {}, user) {
    const src = await guard(user, 'view', id);
    return cached(src, 'r', body, () => engine.records(src, body.spec, ctxOf(src, body.ctx), { sel: body.sel, page: body.page, size: body.size, columns: body.columns, sort: body.sort, dir: body.dir, search: body.search }));
  }
  async function values(id, body = {}, user) {
    const src = await guard(user, 'view', id);
    return engine.values(src, body.base, body.field, body.search);
  }

  // ---- names, columns and calculated columns (display mappings; the data is never changed) ----
  /** Original names next to display names, for every table and column. */
  async function getMappings(id, user) {
    const src = await guard(user, 'view', id);
    return {
      tables: Object.entries(src.raw.tables).map(([t, def]) => {
        const S = src.schema.tables[t];
        return {
          name: t, sqlName: def.sqlName, label: S ? S.label : (src.overrides.tables[t] || {}).label || def.label, removed: !S,
          columns: Object.entries(S ? S.fields : def.fields).map(([c, f], i) => ({ name: c, label: f.label, type: f.type, format: f.format || '', hidden: !!f.hidden, order: i, calculated: !!f.calc })),
        };
      }),
    };
  }
  /** Saves display names, types, formats, hidden columns, column order and calculated columns. */
  async function setOverrides(id, body, user) {
    const src = await guard(user, 'model', id);
    const out = { tables: {} };
    for (const [t, o] of Object.entries((body && body.tables) || {})) {
      const raw = src.raw.tables[t];
      if (!raw || !o || typeof o !== 'object') continue;
      const clean = {};
      if (o.label) clean.label = String(o.label).slice(0, 80);
      if (o.date !== undefined) clean.date = o.date ? String(o.date) : null;
      if (o.display && (raw.fields[o.display] || (o.calcs || []).some((c) => c.col === o.display))) clean.display = o.display;
      clean.fields = {};
      for (const [col, f] of Object.entries(o.fields || {})) {
        if (!raw.fields[col] || !f) continue;
        const cf = {};
        if (f.label) cf.label = String(f.label).slice(0, 80);
        if (TYPES.includes(f.type)) cf.type = f.type;
        if (FORMATS.includes(f.format)) cf.format = f.format;
        if (typeof f.hidden === 'boolean') cf.hidden = f.hidden;
        clean.fields[col] = cf;
      }
      const fieldsNow = Object.fromEntries(Object.entries(raw.fields).map(([c, f]) => [c, { ...f, ...(clean.fields[c] || {}) }]));
      clean.calcs = (Array.isArray(o.calcs) ? o.calcs.slice(0, 50) : []).filter((c) => c && !raw.fields[c.col] && checkCalc(c, fieldsNow)).map((c) => ({ ...c, label: String(c.label || c.col).slice(0, 80) }));
      if (Array.isArray(o.order)) clean.order = o.order.map(String).filter((c, i, a) => a.indexOf(c) === i && (raw.fields[c] || clean.calcs.some((x) => x.col === c))).slice(0, 500);
      out.tables[t] = clean;
    }
    src.overrides = out;
    build(src);
    await store.set(key(id, 'overrides'), out);
    return getMappings(id, user);
  }

  // ---- relationships ----
  async function getModel(id, user) {
    const src = await guard(user, 'view', id);
    return relations.describe(src, src.model, await counts(src));
  }
  /** detect | create | edit | confirm | delete | unhide | remove-tables | restore-tables | layout */
  async function changeModel(id, action, body = {}, user) {
    const src = await guard(user, 'model', id);
    const m = src.model;
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const names = Array.isArray(body.tables) ? body.tables.map(String) : [];
    let next;
    switch (action) {
      case 'detect': next = await relations.detect(src, m); break;
      case 'create': next = (await relations.create(src, m, body)).model; break;
      case 'edit': next = (await relations.edit(src, m, String(body.id), body)).model; break;
      case 'confirm': next = relations.confirm(m, ids); break;
      case 'delete': next = relations.remove(src, m, ids); break;
      case 'unhide': next = relations.unhide(m, Array.isArray(body.sigs) ? body.sigs.map(String) : []); break;
      case 'remove-tables': next = relations.removeTables(src, m, names); break;
      case 'restore-tables': next = relations.restoreTables(m, names); break;
      case 'layout': next = relations.setLayout(m, body.positions); break;
      default: throw fail(400, 'Unknown change: ' + action);
    }
    src.model = next;
    build(src);
    await store.set(key(id, 'model'), next);
    return action === 'layout' ? { saved: true } : relations.describe(src, next, await counts(src));
  }

  // ---- dashboards ----
  const dashKey = (id, user) => key(id, `dashboards:${scope === 'user' ? (user && (user.id ?? user)) || 'anonymous' : 'shared'}`);
  /** { dashboards: [...], current } as saved, or { dashboards: [], current: null } */
  async function getDashboards(id, user) {
    await guard(user, 'view', id);
    return (await store.get(dashKey(id, user))) || { dashboards: [], current: null };
  }
  async function saveDashboards(id, body, user) {
    await guard(user, 'dashboards', id);
    const list = body && Array.isArray(body.dashboards) ? body.dashboards : null;
    if (!list || list.length > 200) throw fail(400, 'Expected { dashboards: [...] } (at most 200)');
    for (const d of list) if (!d || typeof d.id !== 'string' || !Array.isArray(d.widgets)) throw fail(400, 'Each dashboard needs an id and a list of widgets');
    const value = { dashboards: list.map(({ rangeValue, ...d }) => d), current: typeof body.current === 'string' ? body.current : null, savedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_DASHBOARDS_BYTES) throw fail(400, 'These dashboards are too large to save');
    await store.set(dashKey(id, user), value);
    return { saved: true };
  }
  /** One dashboard by its id, and saving or deleting one: for hosts that manage dashboards themselves. */
  async function getDashboard(id, dashId, user) {
    const { dashboards } = await getDashboards(id, user);
    const d = dashboards.find((x) => x.id === dashId);
    if (!d) throw fail(404, 'Unknown dashboard');
    return d;
  }
  async function saveDashboard(id, dashboard, user) {
    const all = await getDashboards(id, user);
    if (!dashboard || typeof dashboard.id !== 'string') throw fail(400, 'A dashboard needs an id');
    const list = all.dashboards.some((d) => d.id === dashboard.id) ? all.dashboards.map((d) => (d.id === dashboard.id ? dashboard : d)) : [...all.dashboards, dashboard];
    await saveDashboards(id, { dashboards: list, current: all.current || dashboard.id }, user);
    return dashboard;
  }
  async function deleteDashboard(id, dashId, user) {
    const all = await getDashboards(id, user);
    await saveDashboards(id, { dashboards: all.dashboards.filter((d) => d.id !== dashId), current: all.current === dashId ? null : all.current }, user);
    return { deleted: true };
  }
  /** Starting dashboards: the host's, or one built from the data. */
  async function starters(id, user) {
    const src = await guard(user, 'view', id);
    if (src.starters) return src.starters;
    return [await autodash.generate(src, await counts(src))];
  }
  async function buildDashboard(id, table, user) {
    const src = await guard(user, 'view', id);
    return autodash.generate(src, await counts(src), table);
  }

  // ---- a source's whole configuration, to copy between environments ----
  async function exportConfig(id, user) {
    const src = await guard(user, 'view', id);
    return { module: 'datastudio', version: 1, source: id, overrides: src.overrides, model: src.model, dashboards: await getDashboards(id, user) };
  }
  async function importConfig(id, cfg, user) {
    const src = await guard(user, 'model', id);
    if (!cfg || cfg.module !== 'datastudio') throw fail(400, 'That is not a data studio configuration');
    if (cfg.overrides) await setOverrides(id, cfg.overrides, user);
    if (cfg.model) { src.model = relations.normalize(cfg.model); build(src); await store.set(key(id, 'model'), src.model); }
    if (cfg.dashboards && Array.isArray(cfg.dashboards.dashboards)) await saveDashboards(id, cfg.dashboards, user);
    return { imported: true };
  }

  return {
    registerSource, unregisterSource, refreshSource, listSources, can,
    getSchema, query, records, values,
    getMappings, setOverrides,
    getModel, changeModel,
    getDashboards, saveDashboards, getDashboard, saveDashboard, deleteDashboard, starters, buildDashboard,
    exportConfig, importConfig,
    /** the registered source, for advanced use (tests, custom routes) */
    source: (id) => sources.get(id),
  };
}

module.exports = { createStudio, ACTIONS };
