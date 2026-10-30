# Dashboard studio

One dashboard engine for any data. Every number is answered by a single query engine that knows nothing
about tickets, sales or any other subject: a data source only describes its tables, fields and links, and
every dashboard feature works on it. It ships with two dummy data sets (Helpdesk and Sales) and needs no database.

## Run it

Requirements: Node.js 20 or later.

```powershell
cd D:\source\work\dashboard
npm install
npm start
```

Open http://localhost:3000.

| Setting (`.env`) | Meaning |
|---|---|
| `PORT` | Port of the studio (default 3000) |
| `STATE_FILE` | Where saved dashboards are kept (default `storage/state.json`); added sources and field edits go next to it in `storage/sources.json` and `storage/uploads/` |
| `APP_TIMEZONE` | Time zone for PostgreSQL sources you connect |
| `MAX_UPLOAD_MB` | Largest file that can be uploaded (default 2048 MB) |
| `LEGACY_SCRUMBAN=1` | Also serve the earlier ScrumBan pages (`/classic.html`), which read the ScrumBan database. Off by default |

## What people can do

- **Data sources:** Helpdesk (tickets, customers, agents, teams, categories, ticket activity) and Sales
  (orders, order lines, products, customers, reps) out of the box. Add more under **Data and fields → Add data**:
  upload CSV or JSON files of any size up to `MAX_UPLOAD_MB` (types and links such as `customer_id → customers`
  are found automatically; see "Large files" below),
  or connect a PostgreSQL database (tables, keys and foreign keys are read automatically; read-only).
- **Import many files at once** (Data and fields → Import files): pick files, a whole folder, or drop them. Each file
  becomes a table; the list shows the table names (shared words such as `olist_…_dataset` are dropped), refuses
  unsupported or empty files, flags tables already in the source (tick "Replace" to load one again), and imports the
  chosen ones one by one, continuing past any that fail. One file works the same way.
- **Model and relationships** (Power BI style): every table on one canvas with its keys (PK) and the columns that point
  elsewhere (FK), and lines between related columns marked `1` and `*`. Line styles tell apart relationships defined
  by the source (database foreign keys), found by the studio and confirmed, drawn by hand, and suggestions to review;
  many-to-many relationships are dotted. **Find relationships** profiles the data to pick each table's key and checks
  candidate relationships (same column names, `customer_id` next to a table called customers, matching types)
  against the values; nothing found is used until confirmed. Drag from a column's dot to another column to relate
  them by hand; click a line to change how rows meet (1:1, 1:*, *:1, *:*), switch it off or delete it. Tick tables
  to move or leave them out together; left-out tables keep their data and can be put back. Pan, zoom, search,
  auto-arrange and "key columns only" keep models with hundreds of tables usable.
- **Dashboards:** several per source; rename, duplicate, delete, download and open as a file, restore the
  starting ones, or **Build a dashboard from the data** for any table of any source.
- **Period and filters** for the whole dashboard: 7/30/90 days, 12 months, this year, all time, custom; compare
  with the previous period; filters on any field of any table. Widgets built on other tables are filtered
  through their links (a filter on Customers › Segment also filters ticket activity); a widget that cannot be
  reached says so in its footer.
- **Widgets:** number (with change, target, trend line), gauge, bars, columns, lollipop, radar, funnel, donut,
  pie, treemap, waffle, polar area, line, stacked area, stacked or grouped columns, step, dots, heat strip,
  heatmap of two groupings, scatter, summary table (several measures, sortable, bars in cells), table by
  period, records (choose and order columns from any linked table, sort, search, page), and text notes.
- **Editing** (✎ on a widget, or **+ Add widget**): table, up to six measures (count, total, average, median,
  lowest, highest, number of different, share of rows where…), each with its own conditions and, for lines over
  time, its own date (created vs resolved); group, split, top N with "Other", order; over time with any step
  and running totals; widget filters; which date the period applies to. The widget redraws while you choose.
- **Layout:** **Edit layout**, then drag a widget's title to move it and its corner to resize width and height on
  a 12-column grid that packs gaps. Quick chart switch, duplicate, show large and CSV download on every widget.
- **Click any value** to see its rows, or to filter the whole dashboard to it (or leave it out).
- **Data and fields:** rename tables and fields, change types and number formats, hide fields, choose each table's
  period date, and add calculated fields: time between two dates, arithmetic, number ranges, and grouping or
  renaming of values. Saved on the server and used by every dashboard.
- Light and dark themes; works down to phone width.

## How it is built

```
server/
  index.js            Express app: API routes and static files
  engine/schema.js    How any source is described; field paths through links, date parts and buckets
  engine/engine.js    The query engine: measures, groups, splits, "Other", time series, compare, filters, records
  engine/memory.js    Runs the engine's primitives over rows in memory (dummy data, uploads)
  engine/postgres.js  Runs them as SQL on PostgreSQL, and reads a database's own description
  engine/sqlite.js    Runs them as SQL on an SQLite file (uploaded data); sqlite-pool.js runs those queries in worker threads
  importer.js         Streams an upload to disk, works out column types, and loads it into SQLite in batches
  relations.js        The relationship model: finding keys and relationships, and the changes people make
  sources.js          The sources: dummy data, uploads, databases; saved field edits and calculated fields
  autodash.js         Builds a starting dashboard for any source from its description
  demo/               Dummy data generators (seeded, ending today) and their starter dashboards
  store.js            Saved dashboards per browser (JSON file)
  legacy.js, widgets.js, model.js, sql.js, db.js, window.js   The earlier ScrumBan pages (off by default)
public/
  index.html, css/studio.css, js/studio/*.js   The studio
  js/studio/model.js (model view), js/studio/bulk.js (importing files)
  js/charts.js, js/render.js, js/util.js        d3 charts shared with the earlier pages
tests/engine.test.js  Engine and API checks on the dummy data (no database needed)
```

### Relationships

Each source has a relationship model, saved in `storage/sources.json` (never in the data):

| Kind | Where it comes from | Can be |
|---|---|---|
| Defined by the source | PostgreSQL foreign keys, links declared in a dummy data set | hidden and put back |
| Found by the studio | **Find relationships** (and after each single upload) | confirmed, rejected, changed, switched off |
| Drawn by hand | dragging between two columns, or the New tab | changed, switched off, deleted |

How rows meet is worked out from the values: the side whose values are unique is the "one" side, and relationships
are stored from their "many" side. Charts follow many-to-one and one-to-one relationships, up to three steps. A
many-to-many relationship is shown but not followed, because every row would be counted several times; use a table
in between instead. A column can lead to one table only; a second relationship from the same column is marked
"not used". Rejected suggestions are not offered again (they are listed under "Hidden or rejected").

Finding relationships runs one profiling query per table and checks only candidates that names and types suggest,
looking up keys by name, so it scales with the number of columns rather than with every pair of tables: on a
300-table schema it took about 0.15 s and found all 630 relationships with no false ones.

### Large files

Uploads are built so their size does not matter to memory:

1. The browser sends the file itself as the request body (`XMLHttpRequest.send(file)`), which streams it from disk
   and shows how much has been sent. Nothing is read into the page's memory.
2. The server writes the body straight to a file (`storage/uploads/incoming-*.part`) and stops at `MAX_UPLOAD_MB`.
3. A background job reads that file as a stream twice: once to work out each column's type, once to write the rows
   into `storage/uploads/<source>/data.sqlite` in batches of 5,000, pausing between batches so the server keeps
   answering. The browser polls `GET /api/jobs/:id` for progress.
4. Queries run on the SQLite file in a pool of worker threads, so several widgets are answered at once on separate
   cores, and answers are cached per version of the source.

Accepted: CSV with comma, semicolon or tab (quoted fields may contain separators, quotes and line breaks;
`1,500.25` and `1,5` are both numbers), a JSON list of objects, or one JSON object per line.

Measured on this machine: a 143 MB CSV (1.3 million rows) imports in about 11 s; a 552 MB CSV (5 million rows) in
41 s with the server using at most about 320 MB of memory. A 13-widget dashboard on the 1.3 million rows loads in
about 4 s the first time and instantly after that; a single grouped query on 5 million rows takes 2–3 s.

### Adding another kind of database

The engine needs four primitives from an adapter (see the top of `server/engine/engine.js`):
`aggregate`, `span`, `records` and `count`. `memory.js` and `postgres.js` are the two examples; a MySQL or
SQL Server adapter is the same `Builder` with that dialect's date and text functions, plus a reader for its
catalogue. Nothing else changes.

### API

| Method and path | Returns |
|---|---|
| `GET /api/sources` | The sources |
| `GET /api/s/:source/schema` | Tables, fields (with borrowed totals and calculated fields), links, row counts |
| `POST /api/s/:source/query` `{ spec, ctx }` | A widget's numbers |
| `POST /api/s/:source/records` `{ spec, ctx, sel, page, size, columns, sort, dir, search }` | Rows, e.g. behind a clicked value |
| `POST /api/s/:source/values` `{ base, field, search }` | Values of a field, for filter lists |
| `GET /api/s/:source/starters`, `POST /api/s/:source/autodash` | Starting dashboards |
| `PUT /api/s/:source/overrides` | Save names, types, formats, hidden fields, calculated fields |
| `POST /api/sources/upload?filename=&label=&table=&sourceId=&replace=1&detect=0` (body: the file) | Starts an import; returns `{ job }`. A table name already in the source is refused unless `replace=1`; `detect=0` skips finding relationships (for several files at once) |
| `GET /api/s/:source/model` | Tables with keys, relationships (with kind, status, cardinality, confidence, whether charts follow them), left-out tables, layout |
| `POST /api/s/:source/model/<action>` | `detect`, `create` `{from,col,to,toCol}`, `edit` `{id,cardinality,status}`, `confirm` `{ids}`, `delete` `{ids}`, `unhide` `{sigs}`, `remove-tables` `{tables}`, `restore-tables` `{tables}`, `layout` `{positions}` |
| `GET /api/jobs/:id` | Import progress: `state` (receiving, reading, importing, indexing, done, error), `rows`, `total`, `sourceId` |
| `POST /api/sources/connect`, `DELETE /api/sources/:id` | Connect a database, remove a source |
| `GET/PUT /api/state` | Saved dashboards for one browser |

A spec: `{ base, measures: [{ fn, field, filters, time, label }], group, split, time, grain, top, other, sort, filters, dateField, cumulative }`.
A context: `{ range: { from, to }, filters: [{ table, field, op, value }], compare }`.

### Safety

- Only tables, fields and links in a source's description can be used; every value a person types is a query
  parameter, never part of the SQL text (tested). Database sessions are read-only with a 30-second limit.
- Connected databases: columns named like passwords, hashes, tokens or secrets are never read; e-mail, phone and
  address columns start hidden. The connection address is stored in `storage/sources.json`; use a read-only user.
- The data itself is never changed by the studio.

## Test

```powershell
npm test               # engine and API on the dummy data
npm run test:legacy    # the earlier ScrumBan API (needs the ScrumBan database)
```
