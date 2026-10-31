# Data studio

A reusable module that adds data modeling, relationship mapping and dashboards to an existing Node.js application. The host application hands it table descriptions and a way to read the rows. In return it provides:

- **A data model**: tables, columns and the relationships between them. Relationships come from foreign keys, from automatic detection over the data, or from people drawing them by hand.
- **Display mappings**: display names for tables and columns, types, number formats, hidden columns, column order and calculated columns. The original names and the data are never changed.
- **Dashboards and visualizations**: widgets with about 25 chart types, dashboard filters, a period picker, comparison with the previous period, drill-down to records, and CSV download.

It has two parts: a server part (a plain service plus an optional Express router) and a browser part (one `mount()` call).

### What it deliberately does not do

The host application owns these. The module never does them:

- **No database connections.** The module never opens a connection, reads credentials or creates a pool. SQL providers call a `query` function that the host passes in.
- **No uploads or ingestion.** There is no file upload, CSV import or ETL. The host loads data however it already does and tells the module when the data changed.
- **No database management.** It never creates, alters or writes tables. It only issues `SELECT` statements. "Removing" a table or "deleting" a relationship in the studio only hides it in the studio's own configuration.
- **No users or sign-in.** The host tells the module who the user is and answers an `authorize()` hook.

---

## Folder layout

```
datastudio/
  index.js                    public exports
  package.json
  server/
    service.js                createStudio(): everything the module does, as async functions
    http.js                   createRouter() (Express API) and studioAssets() (browser files)
    input.js                  table metadata contract, typeOf(), memoryProvider()
    stores.js                 memoryStore(), jsonFileStore()
    relations.js              relationship model: detection, manual relationships, cardinality
    autodash.js               builds a starting dashboard from the data
    providers/
      postgres.js             postgresProvider(), introspectPostgres()
      sqlite.js               sqliteProvider(), sqliteFunctions()
    engine/
      engine.js               view validation and query engine (adapter primitives)
      memory.js               in-memory adapter
      schema.js               schema, overrides, calculated columns, field references
  client/
    studio.js                 mount(): the browser entry point (ES module)
    studio.css                generated, scoped stylesheet (do not edit by hand)
    css/                      style sources (base.css, studio.css, module.css)
    js/                       the studio's browser modules
  scripts/
    build-css.js              regenerates client/studio.css from client/css
  examples/host-app/          a complete sample integration
  test/                       tests (npm test)
```

---

## Installation

The module is not published to a registry (`"private": true`). Copy the folder into your project, for example to `modules/datastudio`, then install its one dependency (`d3`, served to the browser).

Either install inside the module folder:

```sh
cd modules/datastudio
npm install
```

Or add it to the host as a local dependency so its dependencies install with the host:

```sh
npm install ./modules/datastudio
```

**Express** is an optional peer dependency (`>=4.18`). Install it in the host if you use `createRouter()` or `studioAssets()`. If the module cannot `require('express')` from its own location (for example, because it sits outside the host's `node_modules` tree), pass the host's copy explicitly: `createRouter(studio, { express })` and `studioAssets({ express })`.

Node.js 18 or later is required. The example app needs Node 22.5 or later because it uses `node:sqlite`.

---

## Quick start

### Server

```js
const express = require('express');
const datastudio = require('./modules/datastudio');

const studio = datastudio.createStudio({
  store: datastudio.jsonFileStore('./data/studio-config.json'),
  authorize: ({ user, action }) => {
    if (!user) return false;
    if (action === 'view') return true;
    if (action === 'dashboards') return ['admin', 'analyst'].includes(user.role);
    return user.role === 'admin'; // 'model'
  },
});

await studio.registerSource({
  id: 'sales',
  label: 'Sales',
  tables: [
    { name: 'customers', primaryKey: 'id', columns: [{ name: 'id', type: 'number' }, { name: 'name', type: 'text' }, { name: 'region', type: 'text' }],
      rows: [{ id: 1, name: 'Ada', region: 'North' }] },
    { name: 'orders', primaryKey: 'id', dateColumn: 'ordered_at',
      columns: [{ name: 'id', type: 'number' }, { name: 'customer_id', type: 'number' }, { name: 'ordered_at', type: 'date' }, { name: 'total', type: 'number', format: 'money' }],
      foreignKeys: [{ column: 'customer_id', references: { table: 'customers', column: 'id' } }],
      rows: [{ id: 10, customer_id: 1, ordered_at: '2026-10-01', total: 120 }] },
  ],
});

const app = express();
// ... the host's own authentication sets req.user ...
app.use('/analytics/api', datastudio.createRouter(studio, { userOf: (req) => req.user }));
app.use('/analytics/assets', datastudio.studioAssets());
app.listen(3000);
```

### Browser

```html
<div id="analytics" style="--ds-height: calc(100vh - 52px)"></div>
<script type="module">
  import { mount } from '/analytics/assets/studio.js';
  const studio = await mount(document.getElementById('analytics'), { api: '/analytics/api' });
</script>
```

`mount()` loads `studio.css` and d3 from the same place as `studio.js`.

---

## Table metadata contract

A source is registered with `studio.registerSource(def)`. This is the input contract (from `server/input.js`):

```js
{
  id: 'sales',                          // required: letters, digits, "-" or "_" (max 64 characters)
  label: 'Sales',                       // optional display name (default: id)
  description: '...',                   // optional
  asOf: '2026-10-30',                   // optional "data as of" date (default: today)
  tables: [{
    name: 'orders',                     // identifier used in field paths: letters, digits, underscore
    label: 'Orders',                    // optional display name (default: prettified name)
    sqlName: ['public', 'orders'],      // optional, for SQL providers (default: name)
    primaryKey: 'order_id',             // optional
    dateColumn: 'ordered_at',           // optional: the date the dashboard period applies to
    displayColumn: 'number',            // optional: the column that names a row
    columns: [{ name, type, label, format, hidden, time }],
    foreignKeys: [{ column: 'customer_id', references: { table: 'customers', column: 'customer_id' }, name: 'Customer' }],
    rows: [...]                         // optional: the rows, for the in-memory provider
  }],
  provider: memoryProvider(...) | postgresProvider({ query }) | sqliteProvider({ query }) | yourOwn,
  dashboards: [...]                     // optional starting dashboards (else one is built from the data)
}
```

Rules and defaults:

- **Names.** Table and column names must match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. A column can also be given as a plain string (`'region'`), which is the same as `{ name: 'region' }`.
- **Types.** A column's `type` is one of `text`, `number`, `date` or `bool`, or a database type name. `typeOf()` maps database types to the module's types:
  - anything containing `bool` becomes `bool`
  - `timestamp`, `datetime` or `time` becomes `date` with `time: true`
  - `date` becomes `date`
  - `int`, `serial`, `numeric`, `decimal`, `real`, `double`, `float`, `money` or `number` becomes `number`
  - everything else becomes `text`
- **Formats.** `format` is one of `''`, `auto`, `int`, `dec`, `money`, `pct`, `hours`, `minutes` or `days`. Unknown values are dropped.
- **Hidden columns.** `hidden` defaults to `true` for foreign key columns and `false` for others. Hidden columns stay usable but are left out of field lists.
- **`primaryKey`** is used only if it names a listed column. Composite keys are not supported.
- **`displayColumn`** defaults to the first visible text column named `name`, `title`, `label`, `number` or `code`. If there is none, it is the first visible text column.
- **`dateColumn`** defaults to the first date column whose name matches `created|date|day|time|_at$`. If none matches, it is the first date column. Pass `null` for "no period date".
- **Foreign keys** must point at listed tables and columns, or registration throws.
- **Providers.** If `provider` is omitted, every table needs `rows`, and an in-memory provider is used.
- **Re-registering.** Calling `registerSource` again with the same `id` replaces the metadata and provider. Everything people configured (overrides, model, dashboards) is kept, because it is loaded from the store.

How rows are normalized (in-memory provider only): values are converted per column type before the first query.

| Column type | What a value becomes |
| --- | --- |
| `number` | `Number(v)`, or `null` if the result is not finite |
| `bool` | booleans are kept as they are; `true`, `yes`, `y` and `1` (any case) become `true`; anything else becomes `false` |
| `date` | `'YYYY-MM-DD'` or `'YYYY-MM-DD HH:MM'` text. `Date` objects are read in UTC. Anything else becomes `null`. |
| `text` | `String(v)`. Objects become JSON text. |

`null`, `undefined` and `''` all become `null`. Keys in a row that are not listed as columns are dropped.

Other calls:

- `studio.unregisterSource(id)` removes a source from the running process. Nothing is deleted from the store.
- `typeOf(t)` is exported if you want to map your own type names. It returns `{ type, time }`.

---

## Data providers

A provider is `{ kind, create(schema) => adapter }`. Four options:

### 1. In memory: `memoryProvider(rowsByTable)`

Use this when the host already has the rows (from a file, an API or a report). Either put `rows` on each table, or pass them separately:

```js
await studio.registerSource({
  id: 'targets',
  tables: [{ name: 'targets', columns: ['region', { name: 'month', type: 'date' }, { name: 'target', type: 'number' }] }],
  provider: datastudio.memoryProvider({ targets: rowsFromSomewhere }),
});
```

All aggregation runs in the Node process, so this suits small to medium data sets.

### 2. PostgreSQL: `postgresProvider({ query })`

The host passes its own `query(text, params)` function, using `$1, $2 ...` positional parameters. It may return an array of rows or a `pg` result with `.rows`. The host keeps control of connections, credentials, read-only roles and statement timeouts.

```js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.ANALYTICS_DB_URL }); // ideally a read-only role
const query = (text, params) => pool.query(text, params).then((r) => r.rows);

const tables = await datastudio.introspectPostgres(query, 'public');
await studio.registerSource({
  id: 'erp',
  label: 'ERP',
  tables,
  provider: datastudio.postgresProvider({ query }),
});
```

`introspectPostgres(query, schemaName = 'public')` reads `information_schema` and returns tables in the input format above, ready for `registerSource`. It works as follows:

- It includes base tables and views.
- It sets `sqlName: [schema, table]`, single-column primary keys and foreign keys between the included tables.
- It **skips** columns whose names look secret: `password`, `hash`, `secret`, `token`, `salt`, `otp`, `api_key` and `private`.
- It **hides** columns that look personal (`email`, `phone`, `mobile`, `address`, `birth`, `ssn`, `tax_id`) and `uuid` columns.
- It skips columns whose type is not a number, date or timestamp, boolean, or text-like type.

You can filter or edit the returned array before registering it.

User-typed values always go in as query parameters. Table and column names come from the metadata and are quoted.

### 3. SQLite: `sqliteProvider({ query })`

The host passes `query(sql, params)`:

- `params` is an **object of named parameters** (`{ p1: ..., p2: ... }`), written `$p1`, `$p2` in the SQL.
- The function must return an array of row objects.

Medians use an aggregate function named `median_of`. Register it once on the connection with `sqliteFunctions(db)`. This works with `node:sqlite` and `better-sqlite3`, which both have `db.aggregate`.

SQLite has no native date or boolean type, so store data this way:

- dates as `'YYYY-MM-DD'` or `'YYYY-MM-DD HH:MM'` text
- booleans as `1`/`0`
- numbers as numbers

`node:sqlite` (Node 22.5+):

```js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./shop.db', { readOnly: true });
datastudio.sqliteFunctions(db);
await studio.registerSource({
  id: 'shop',
  tables: shopTables, // your table metadata
  provider: datastudio.sqliteProvider({ query: (sql, params) => db.prepare(sql).all(params) }),
});
```

`better-sqlite3`:

```js
const Database = require('better-sqlite3');
const db = new Database('./shop.db', { readonly: true });
datastudio.sqliteFunctions(db);
// better-sqlite3 takes named parameters without the "$" prefix in the object, matching { p1, p2 }
const provider = datastudio.sqliteProvider({ query: (sql, params) => db.prepare(sql).all(params) });
```

`sqlName` may be schema-qualified for both SQL providers, e.g. `['public', 'orders']` (PostgreSQL) or `['main', 'orders']` (SQLite, including attached databases).

### 4. A custom provider

Write an object `{ kind, create(schema) }`, where `create` returns an adapter. The engine calls six methods on the adapter:

| Method | Returns | Used for |
| --- | --- | --- |
| `aggregate(base, { dims, measures, where })` | `[{ k: [keyText per dim], vs: [value per measure], n: rowCount }]` | every chart number |
| `span(base, ref, where)` | `{ lo, hi }`: first and last date, `'YYYY-MM-DD'` | time axes |
| `records(base, { where, columns, sort, dir, search, offset, limit })` | `{ total, rows: [[value per column]] }` | drill-down and records tables |
| `count(base)` | number of rows | row counts in the UI |
| `profile(table, cols)` | `{ rows, cols: { [col]: { filled, distinct } } }` | relationship detection only |
| `coverage(from, col, to, toCol, limit = 5000)` | `{ values, found }`: how many of up to `limit` distinct values of `from.col` exist in `to.toCol`, compared as text | relationship detection only |

`profile` and `coverage` are needed only for relationship detection and for hand-drawn relationships. If you leave them out, those features fail: detection catches the error per table or candidate and finds nothing, and creating or editing a relationship returns an error.

The adapter receives the finished schema (`server/engine/schema.js`). That schema has tables, fields (including calculated `calc` fields), `links` and automatic `rollups`. The adapter must implement these conventions:

- **Field references** are paths of link columns from the base table, with an optional date part after a bar, for example `customer_id.region` or `created_at|month`. `require('<module>/server/engine/schema').resolve(schema, base, ref)` resolves one for you.
- **Dims** are `{ ref, grain? }`. With a `grain` (`day`, `week`, `month`, `quarter` or `year`), the key is the bucket start as `'YYYY-MM-DD'`, and weeks start on Monday.
- **Key text.** Keys are text:
  - `'(none)'` for empty values
  - `'Yes'`/`'No'` for booleans
  - `'YYYY-MM-DD'` for dates
  - date parts: `day` `YYYY-MM-DD`, `month` `YYYY-MM`, `quarter` `YYYY Qn`, `year` `YYYY`, `weekday` `Mon`..`Sun`, `hour` `HH`
- **Measures** are `{ fn, field, filters }`, where `fn` is one of `count`, `sum`, `avg`, `median`, `min`, `max`, `distinct` or `rate`. `rate` means rows matching `filters` divided by all rows. For the other functions, `filters` restricts which rows are counted (a conditional aggregate).
- **Where conditions** are `{ field, op, value }`. On top of the user ops (see [Views](#views-spec-reference)), the engine itself uses these:
  - `in` / `notin`, with a list of key texts
  - `between`, with `[from, to]` dates
  - `bucket`, with `{ grain, key }`

The simplest custom provider loads rows from wherever they live and delegates to the in-memory adapter:

```js
const { MemoryAdapter } = require('./modules/datastudio/server/engine/memory');
const myProvider = {
  kind: 'my-api',
  create(schema) { return new MemoryAdapter(schema, cachedRowsByTable); }, // rows already normalized
};
```

For a real backend, use `server/providers/postgres.js` as the reference implementation. Its `Builder` class covers joins, calculated columns, rollups, date parts and every filter op.

---

## Storage

What people configure is kept in a **store**. A store is any object with these async methods:

```js
{
  async get(key) { /* the saved value, or undefined */ },
  async set(key, value) { /* save a JSON-serializable value; null removes it */ },
  async keys(prefix) { /* optional: list keys starting with prefix */ },
}
```

The keys are:

| Key | Content |
| --- | --- |
| `source:<id>:overrides` | display names, types, formats, hidden columns, column order, calculated columns, period date and display column per table |
| `source:<id>:model` | the relationship model: relationships, dismissed relationships, removed tables, layout, profile and detected keys |
| `source:<id>:dashboards:shared` | dashboards, when `dashboardScope: 'shared'` |
| `source:<id>:dashboards:<userId>` | dashboards per user, when `dashboardScope: 'user'` (`user.id`, else `user` itself, else `anonymous`) |

Two stores are built in:

- **`memoryStore(initial = {})`**: a `Map`, lost on restart and not shared between processes. This is the default.
- **`jsonFileStore(file)`**: one JSON file, loaded once, then written whole through a temporary file and a rename, one write at a time. It suits a single process.

For several processes or servers, write a small store over your own database or Redis:

```js
const store = {
  async get(key) { const r = await db.query('SELECT value FROM studio_config WHERE key = $1', [key]); return r.rows[0]?.value; },
  async set(key, value) {
    if (value === null) return db.query('DELETE FROM studio_config WHERE key = $1', [key]);
    await db.query('INSERT INTO studio_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
  },
};
```

Overrides and the model are read from the store when a source is registered. Dashboards are read on every request.

---

## Permissions

`createStudio({ authorize })` takes a hook:

```js
authorize: async ({ user, action, source }) => boolean
```

- `user` is whatever the host passes in: `userOf(req)` over HTTP, or the last argument of a service call. It is `null` when there is no user.
- `action` is `'view'`, `'model'` or `'dashboards'`.
- `source` is the source id.
- If the hook throws, the answer counts as "no".

Without an `authorize` hook, everything is allowed.

| Action | Allows |
| --- | --- |
| `view` | listing the source, reading schema, mappings, model, dashboards and starters, running queries, records and value lists, exporting configuration. **Every other action also requires `view`.** |
| `model` | `setOverrides` (names, types, formats, hidden columns, order, calculated columns), every `changeModel` action (detect, create, edit, confirm, delete, unhide, remove and restore tables, layout), and `importConfig` |
| `dashboards` | saving, creating, changing and deleting dashboards |

Denied requests return HTTP 403. Unknown sources return 404. `getSchema` returns `can: { model, dashboards }` for the current user, and the browser UI hides or disables what the user may not do:

- without `model`, the model view and the tables page are read-only
- without `dashboards`, there is no "Add widget", no editing, no widget menu changes, and changes are not saved

`importConfig` needs `model`, and also `dashboards` if the file contains dashboards.

---

## HTTP API reference

`createRouter(studio, opts)` returns an Express router. It parses JSON bodies up to 5 MB.

| Option | Default | Purpose |
| --- | --- | --- |
| `userOf(req)` | `req.user \|\| null` | the signed-in user, passed to `authorize()` |
| `express` | `require('express')` | the host's Express, if it cannot be required from the module folder |
| `onError(err, req)` | `console.error` | logging for server-side (5xx) errors |

Paths are relative to where the router is mounted. `:id` is the source id.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/sources` | none | `[{ id, label, description, tables, asOf, kind }]` for sources the user may view |
| GET | `/sources/:id/schema` | none | `{ id, label, description, tables, links, parts, grains, maxHops, kind, asOf, overrides, formats, can: { model, dashboards } }` |
| GET | `/sources/:id/mappings` | none | `{ tables: [{ name, sqlName, label, removed, columns: [{ name, label, type, format, hidden, order, calculated }] }] }` |
| PUT | `/sources/:id/overrides` | `{ tables: { [table]: { label, date, display, fields: { [col]: { label, type, format, hidden } }, calcs: [...], order: [...] } } }` | the new mappings |
| POST | `/sources/:id/query` | `{ spec, ctx }` | the view result: `{ spec, measures, labels, rows, total, prevTotal?, groups?, groupCount?, splitKeys?, time?, range, ignored }` |
| POST | `/sources/:id/records` | `{ spec, ctx, sel, page, size, columns, sort, dir, search }` | `{ columns: [{ ref, label, type, format }], sort, dir, page, size, total, rows }` |
| POST | `/sources/:id/values` | `{ base, field, search }` | `[{ v, n }]`: up to 300 values with counts |
| GET | `/sources/:id/model` | none | `{ tables, removed, rels, hidden, layout, detectedAt }` |
| POST | `/sources/:id/model/:action` | see below | the new model (`{ saved: true }` for `layout`) |
| GET | `/sources/:id/starters` | none | the starting dashboards (the host's, or one generated from the data) |
| POST | `/sources/:id/autodash` | `{ table? }` | a generated dashboard |
| GET | `/sources/:id/dashboards` | none | `{ dashboards, current, savedAt? }` |
| PUT | `/sources/:id/dashboards` | `{ dashboards: [...], current }` (at most 200 dashboards and 4 MB) | `{ saved: true }` |
| GET | `/sources/:id/dashboards/:dash` | none | one dashboard |
| PUT | `/sources/:id/dashboards/:dash` | a dashboard (`id` is taken from the path) | the saved dashboard |
| DELETE | `/sources/:id/dashboards/:dash` | none | `{ deleted: true }` |
| GET | `/sources/:id/config` | none | the exported configuration |
| PUT | `/sources/:id/config` | an exported configuration | `{ imported: true }` |

Any other path returns 404 `{ error: 'Unknown address' }`.

Model actions (`POST /sources/:id/model/:action`):

| Action | Body |
| --- | --- |
| `detect` | none: profiles the data and adds suggested relationships |
| `create` | `{ from, col, to, toCol, name? }`: a relationship drawn by hand, active immediately |
| `edit` | `{ id, status?: 'active'\|'inactive', name?, cardinality?: 'N:1'\|'1:N'\|'1:1'\|'N:M' }` |
| `confirm` | `{ ids: [...] }`: turns suggestions into active relationships |
| `delete` | `{ ids: [...] }`: hides relationships for good (including database-defined ones) |
| `unhide` | `{ sigs: [...] }`: brings hidden relationships back |
| `remove-tables` | `{ tables: [...] }`: leaves tables out of the studio |
| `restore-tables` | `{ tables: [...] }` |
| `layout` | `{ positions: { [table]: { x, y } } }` |

Every dashboard needs a string `id` and a `widgets` array.

**Errors** are JSON `{ error: message }`. The status is decided as follows:

1. An error with a `status` property (403, 404 or 400 from the service) uses that status.
2. Otherwise, an error with a `code` property, such as a driver error from the host's database, returns 500.
3. Otherwise, a plain `Error`, such as a validation message from the engine, returns 400 with its message.
4. Anything else returns 500.

For 5xx errors, the message is replaced with "The data could not be read. See the server log for details." and `onError` is called, so database details never reach the browser.

`studioAssets({ express?, maxAge? })` serves the `client/` folder and `vendor/d3.min.js` (d3 from `node_modules`). If d3 cannot be found, that path returns 404, and you can pass the `d3` option to `mount()` instead.

---

## Service API (without Express)

Every route is a thin call to the service. The user is always the last argument.

```js
const studio = createStudio({ store, authorize, dashboardScope, cacheSize });

await studio.registerSource(def);              // -> summary
studio.unregisterSource(id);                   // -> boolean
studio.refreshSource(id);                      // data changed: drop cached answers
await studio.listSources(user);
await studio.can(user, action, id);            // -> boolean

await studio.getSchema(id, user);
await studio.query(id, spec, ctx, user);
await studio.records(id, { spec, ctx, sel, page, size, columns, sort, dir, search }, user);
await studio.values(id, { base, field, search }, user);

await studio.getMappings(id, user);
await studio.setOverrides(id, overrides, user);

await studio.getModel(id, user);
await studio.changeModel(id, action, body, user);

await studio.getDashboards(id, user);
await studio.saveDashboards(id, { dashboards, current }, user);
await studio.getDashboard(id, dashId, user);
await studio.saveDashboard(id, dashboard, user);
await studio.deleteDashboard(id, dashId, user);
await studio.starters(id, user);
await studio.buildDashboard(id, table, user);

await studio.exportConfig(id, user);
await studio.importConfig(id, config, user);

studio.source(id);                             // the internal source object (advanced use)
```

`createStudio` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `store` | `memoryStore()` | where configuration is kept |
| `authorize` | allow everything | the permission hook |
| `dashboardScope` | `'shared'` | `'shared'`: one set of dashboards per source; `'user'`: one set per user |
| `cacheSize` | `500` | query and records answers kept per process (LRU); `0` turns caching off |

Errors meant for the person carry `err.status`. Wrapping the service in another framework only takes a few lines. Here it is with Fastify:

```js
const send = (fn) => async (req, reply) => {
  try { return await fn(req, req.user); }
  catch (err) {
    const status = err.status || (err.code ? 500 : err instanceof Error ? 400 : 500);
    if (status >= 500) req.log.error(err);
    reply.code(status);
    return { error: status >= 500 ? 'The data could not be read.' : err.message };
  }
};
fastify.get('/analytics/api/sources', send((req, u) => studio.listSources(u)));
fastify.get('/analytics/api/sources/:id/schema', send((req, u) => studio.getSchema(req.params.id, u)));
fastify.post('/analytics/api/sources/:id/query', send((req, u) => studio.query(req.params.id, req.body.spec, req.body.ctx, u)));
// ... one line per route in the table above
```

Serve the browser files by pointing your static file handler at `datastudio.clientDir`. Serve `node_modules/d3/dist/d3.min.js` at `<assets>/vendor/d3.min.js`, or pass `d3:` to `mount()`.

The service is also handy from the host's own code. For example, to show a number on a home page:

```js
const r = await studio.query('shop', { base: 'orders', measures: [{ fn: 'sum', field: 'total' }, { fn: 'count' }] },
  { range: { from: '2026-10-01', to: '2026-10-30' } }, req.user);
// r.total -> [revenue, orderCount]
```

---

## Browser mounting

```js
import { mount } from '/analytics/assets/studio.js';
const handle = await mount(elementOrSelector, options);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `api` | **required** | where `createRouter` is mounted, for example `'/analytics/api'` |
| `headers` | `{}` | headers for every API call, or a function that returns them (a bearer token, a CSRF header) |
| `credentials` | `'same-origin'` | fetch credentials mode (use `'include'` for a cross-origin API with cookies) |
| `source` | none | show only this source and hide the source picker |
| `routing` | `'hash'` | `'hash'` keeps the studio's place in `location.hash` (`#/source/page`); `'memory'` leaves the URL alone |
| `start` | `'/'` | where to open, for example `'/sales/model'` |
| `rail` | shown | `false` hides the studio's side menu, so the host navigates with `handle.navigate` |
| `title` | `'Data studio'` | name at the top of the side menu |
| `theme` | the person's last choice, else the system setting | `'light'`, `'dark'` or `'auto'` |
| `onNavigate` | none | `({ source, page }) => void`, called whenever the studio moves |
| `assets` | the folder `studio.js` was loaded from | where `studio.css` and `vendor/d3.min.js` are served |
| `d3` | `<assets>/vendor/d3.min.js` | URL of d3 (skipped if `window.d3` already exists) |

The returned handle:

```js
handle.navigate('/sales/model');   // pages: '/<source>/<dashboardId>', '/<source>/model', '/<source>/data'
handle.path;                       // the current path
handle.destroy();                  // unmount and remove listeners
```

Notes:

- **Routing.** Use `routing: 'memory'` if the host already uses the URL hash for its own router. In hash mode, the studio reads and writes `location.hash`.
- **Without the rail.** With `rail: false`, build your own menu and call `handle.navigate()`. Use `onNavigate` to keep your menu in sync.
- **One studio per page.** Mounting again destroys the previous one. Call `destroy()` when the host hides the studio, as the example app does.
- **Credentials.** API calls use `fetch` with `headers` and `credentials` as given. GET answers are cached in the page.

### Styling and theming

- All styles in `client/studio.css` are scoped to `.ds-root`, the element `mount()` creates inside your element. The studio's styles do not leak into the host page, and host styles only reach the studio if they target it.
- **Height.** Set `--ds-height` on the mount element. It defaults to `100vh`. Example: `#analytics { --ds-height: calc(100vh - 52px); }` for a 52 px host header.
- **Colors and fonts** are CSS variables defined on `.ds-root`, such as `--accent`, `--bg`, `--panel`, `--fg`, `--fg-muted`, `--line`, `--c0`..`--c7` (series colors), `--font` and `--radius`. To override them, use a selector more specific than `.ds-root`:

  ```css
  #analytics .ds-root { --accent: #b45309; --font: "Inter", sans-serif; }
  #analytics .ds-root[data-theme="dark"] { --accent: #f59e0b; }
  ```

- **Dark mode** follows `prefers-color-scheme` unless `data-theme="light"` or `"dark"` is set on `.ds-root`. The `theme` option and the studio's own toggle set it. The toggle saves the choice in `localStorage` as `datastudio-theme`.
- **Editing styles.** Edit the sources in `client/css/*.css`, then run `npm run build:css` inside the module to regenerate `client/studio.css`. Do not edit `studio.css` by hand.

---

## Features for end users

**Model and relationships** (`/<source>/model`, needs `model` to change anything)

- A diagram of tables with row counts, keys and relationships. Tables can be dragged, and the positions are saved.
- **Detect relationships** profiles key-like columns, picks primary keys and checks candidate relationships against the data. Candidates come from:
  - the same column name as another table's key
  - a column named after a table, such as `customer_id` pointing to `customers`
  - a suffix that matches another table's key
  - shared key-like names

  Candidates where at least 60% of values are found become **suggestions** with a confidence score and a reason.
- Confirm suggestions, draw relationships by hand, rename them, change their cardinality or switch them between active and inactive. Delete hides a relationship for good; hidden ones can be brought back.
- Leave tables out of the studio, or restore them.

**Relationship model.** Each relationship has:

- an **origin**: `db` (foreign keys from the metadata, never stored, always re-read from the source), `auto` (detected) or `manual` (drawn)
- a **status**: `suggested`, `active` or `inactive`. Database-defined ones can also be `hidden`.
- a **cardinality**: `N:1`, `1:1` or `N:M`. It is decided by the data: the side whose values are unique is the "one" side.

Only **active `N:1` and `1:1`** relationships (plus database links that are not hidden) are followed in queries. `N:M` relationships are shown in the model, but they are never joined, because joining them would double-count.

**Tables and columns** (`/<source>/data`, needs `model` to change anything)

- Rename tables and columns, change types and formats, hide or show columns, and reorder columns.
- Choose each table's period date and the column that names its rows.
- Add calculated columns:
  - `diff`: time between two dates, in minutes, hours or days
  - `arith`: `+ - * /` over number columns or constants
  - `bins`: a number grouped into ranges, for example `under 4`, `4–24`, `24+`
  - `map`: text values renamed or merged into groups, with an optional "rest" group

**Dashboards and widgets**

- Several dashboards per source: create, duplicate, rename, delete, or "Restore the starting dashboards". "Build one for me" generates a dashboard for a chosen table.
- Widgets are laid out on a 6-column grid. Each widget can be edited, duplicated, removed, shown large, or downloaded as CSV.
- Chart types:
  - **Number:** Number (KPI, optional trend line), Gauge
  - **Compare:** Bars, Columns, Lollipop, Radar, Funnel
  - **Share:** Donut, Pie, Treemap, Waffle, Polar area
  - **Over time:** Line, Stacked area, Stacked columns, Grouped columns, Step line, Dots, Heat strip
  - **Two groupings:** Heatmap (matrix)
  - **Two measures:** Scatter
  - **Tables:** Summary table (pivot), Table by period, Records
  - **Other:** Text note

  The editor greys out charts that do not fit the widget's data and gives the reason.
- **Filters**:
  - dashboard-wide filters set on any table, applied to every widget that can reach that table through relationships (widgets that cannot reach it list the filter as ignored)
  - per-widget filters
  - conditions inside a measure, such as "count of tickets where priority is Urgent"
- **Period** and **Compare with previous period**. The period applies to each table's date. Compare shows the previous period of the same length, as totals and per group.
- **Drill-down**: click a bar, slice or point to see the records behind it, paged and searchable.

---

## Views (spec reference)

A widget's data is a **spec** run against a **context**. The engine validates every spec (`validate()` in `server/engine/engine.js`).

```js
spec = {
  base: 'orders',                 // required: the starting table
  measures: [{                    // 1-6 measures (default: [{ fn: 'count' }])
    fn: 'sum',                    // count | sum | avg | median | min | max | distinct | rate
    field: 'total',               // required except for count and rate; sum/avg/median/min/max need a number field
    filters: [cond],              // up to 8: a conditional measure; rate requires at least one ("which rows count as yes")
    time: 'shipped_at',           // optional date for this measure's own time line (multiple measures, no grouping)
    label: 'Revenue',             // optional
    format: 'money',              // optional
  }],
  group: 'customer_id.region',    // optional grouping field
  split: 'status',                // optional second grouping (if there is no group or time, it becomes the group)
  time: 'ordered_at',             // optional "over time" date field
  grain: 'auto',                  // auto | day | week | month | quarter | year
  top: 10,                        // groups shown (1-100); the rest becomes "Other"
  splitTop: 6,                    // splits shown (1-24)
  other: true,                    // false drops the "Other" bucket
  sort: 'auto',                   // auto | value-desc | value-asc | label-asc | label-desc
  cumulative: false,              // running total over time
  dateField: '',                  // which date the dashboard period applies to; '' = the table's date, '-' = none
  filters: [cond],                // up to 20
}

cond = { field, op, value }
```

Filter ops by field type:

| Type | Ops |
| --- | --- |
| text | `is`, `not`, `in`, `notin`, `contains`, `empty`, `notempty` |
| number | `ge`, `le`, `is`, `not`, `empty`, `notempty`, `in`, `notin` |
| date | `ge`, `le`, `between` (`[from, to]`), `empty`, `notempty` |
| bool | `is` (`'Yes'`/`'No'`), `in`, `notin` |

**Field references** follow links from the base table, up to 3 hops, for example `order_id.customer_id.region`. A date can carry a part after a bar: `ordered_at|month`. The parts are `day`, `month`, `quarter`, `year`, `weekday` and `hour`. Automatic rollups such as `n__orders__customer_id` (the number of orders per customer) are available as number fields on the table that is pointed at.

**Context:**

```js
ctx = {
  range: { from: '2026-10-01', to: '2026-10-30' },             // the dashboard period (YYYY-MM-DD)
  filters: [{ table: 'customers', field: 'region', op: 'in', value: ['North'] }],
  compare: true,                                                // also compute the previous period
}
```

Results for the same source version, spec and context are cached per process. See `cacheSize`.

---

## Display names stay separate from original names

Everything set on the Tables and columns page is stored as **overrides** next to the source. Overrides cover labels, types, formats, hidden columns, order, calculated columns, period date and display column. They never touch the data or the metadata the host registered:

- `getMappings(id)` (`GET /sources/:id/mappings`) lists, for every table and column, the **original name** (`name`, plus `sqlName` for tables) next to the **display label**, type, format, hidden flag, order and whether it is calculated. Tables left out of the model are listed with `removed: true`.
- Field references in specs and dashboards always use original names, so renaming a column never breaks a dashboard.
- Overrides are applied when the schema is built (`finalize()` in `server/engine/schema.js`). Calculated columns are computed at query time, in SQL or in memory.
- `setOverrides` replaces all overrides of a source at once. Send the full set.

Overrides that no longer fit are dropped when saved, for example a column that disappeared or a calculated column whose inputs changed type.

---

## Refreshing data

When the data behind a source changes, for example after a nightly import, call:

```js
studio.refreshSource('shop');
```

This starts a new version of the source, so cached answers are no longer reused, and resets the row counts (which are otherwise kept for 60 seconds).

For **in-memory** sources, the rows are copied and normalized at registration. To load new rows, call `registerSource` again with the same `id`. Configuration is kept.

When the **metadata** changes, for example new tables or columns, call `registerSource` again as well.

---

## Exporting and importing configuration

Copy a source's configuration between environments, for example from staging to production:

```js
const cfg = await studio.exportConfig('shop', user);
// { module: 'datastudio', version: 1, source: 'shop', overrides, model, dashboards }
await otherStudio.importConfig('shop', cfg, user);
```

Over HTTP, use `GET` and `PUT /sources/:id/config`. Import requires the `model` permission, and also `dashboards` if the file has dashboards.

With `dashboardScope: 'user'`, export and import cover the calling user's dashboards only. Database-defined relationships are not part of the export; they come from the source's metadata.

---

## Running the example

```sh
cd modules/datastudio
npm install
npm install express          # if not already available
node examples/host-app/server.js   # or: npm run example
```

Open http://localhost:3300. The example needs Node 22.5 or later for `node:sqlite`, and the `PORT` environment variable overrides the port. It shows:

- a SQLite source read through the host's own connection
- an in-memory source
- a `jsonFileStore` in `examples/host-app/data/studio-config.json`
- role-based `authorize`
- the studio mounted under the host's header with `--ds-height`
- a host endpoint that calls `studio.query`
- an admin-only reload that calls `refreshSource`

Pick the user in the page header:

| User | Role | Permissions |
| --- | --- | --- |
| alice | admin | everything |
| bob | analyst | view and dashboards |
| carol | viewer | view only |

## Running tests

```sh
cd modules/datastudio
npm test        # node --test "test/*.test.js"
```

---

## Limitations

- **PostgreSQL 13 or newer** is needed by the PostgreSQL provider (it uses `trim_scale` so numbers group as `4`, not `4.00`, as in the other providers).
- Dates and times returned by a PostgreSQL driver as `Date` objects are written in the Node server's local time zone; run the host in the time zone you report in, or return dates as text from your query function.

- **Many-to-many relationships are not followed.** They are shown in the model only. To use them, model the bridge table and its two `N:1` relationships.
- **Composite keys cannot be link targets.** A relationship goes from one column to one column with unique values. `introspectPostgres` ignores composite primary keys.
- **Identifiers** (table and column names) must be letters, digits and underscores, and must not start with a digit. For other names, create a database view or alias, or use `sqlName` with a clean `name`. Calculated column names must be lowercase.
- **One link per column.** A column can lead to one table only. If several relationships leave the same column, the first one wins.
- **At most 3 hops** in a field reference.
- **Storage and caching are per process.** The in-memory store is not shared across processes and is lost on restart, and `jsonFileStore` assumes a single writer. Use a database-backed store for several processes. The answer cache and row counts are also per process: call `refreshSource` in each process, or set `cacheSize: 0`.
- **In-memory provider.** All rows are held and aggregated in the Node process.
- **SQLite provider.** Only the first `sqlName` element is used, and dates must be stored as ISO text.
