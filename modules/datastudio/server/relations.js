// The relationship model of a source (part of the data studio module), Power BI style: which column of which table points at which
// column of another, how many rows meet on each side, and where the relationship came from.
//
// model (saved per source through the host's store, see service.js) = {
//   rels:      [{ id, from, col, to, toCol, origin: 'auto'|'manual', status: 'suggested'|'active'|'inactive',
//                 cardinality: 'N:1'|'1:1'|'N:M', confidence, coverage, reason, name }],
//   dismissed: [signature]        relationships hidden or rejected (also hides database-defined ones)
//   removed:   [table]            tables left out of the studio (the data itself is never touched)
//   layout:    { table: { x, y } }  where each table sits in the model view
//   profile:   { table: { rows, cols: { col: { filled, distinct } } } }, keys: { table: col }
// }
// Database-defined relationships are not stored: they come from the source each time (foreign keys,
// declared links), so they stay right if the database changes. Only 'N:1' and '1:1' relationships can be
// followed in queries (engine/schema.js); 'N:M' ones are shown, not joined, as joining them double-counts.
const crypto = require('crypto');
const { pretty, sigOf, FOLLOWED } = require('./engine/schema');

const KEYISH = /(^|_)(id|key|code|no|num|nr|number|uuid|guid|ref|sku|prefix)$/i;
const CONCURRENCY = 8;
const MAX_CHECKS = 4000;
const idOf = (sig) => crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12);
const emptyModel = () => ({ rels: [], dismissed: [], removed: [], layout: {}, profile: {}, keys: {} });
const normalize = (m) => ({ ...emptyModel(), ...(m || {}) });

// ---- the stored columns of a table: its key, its fields and the columns its links leave from ----
function columnsOf(raw, t) {
  const def = raw.tables[t];
  const cols = new Map();
  if (def.key && !def.syntheticKey && !def.fields[def.key]) cols.set(def.key, { col: def.key, label: pretty(def.key), type: 'key' });
  for (const [c, f] of Object.entries(def.fields)) if (!f.calc) cols.set(c, { col: c, label: f.label || pretty(c), type: f.type || 'text' });
  for (const l of raw.links || []) if (l.from === t && !cols.has(l.col)) cols.set(l.col, { col: l.col, label: pretty(l.col), type: 'key' });
  for (const l of raw.links || []) if (l.to === t && l.toCol && !cols.has(l.toCol)) cols.set(l.toCol, { col: l.toCol, label: pretty(l.toCol), type: 'key' });
  return [...cols.values()];
}
const comparable = (a, b) => a === b || a === 'key' || b === 'key' || ((a === 'text' || a === 'number') && (b === 'text' || b === 'number'));

// Words shared by most table names ("olist", "dataset") say nothing; what is left names the table.
function stems(names) {
  const df = new Map();
  for (const n of names) for (const w of new Set(n.split('_'))) df.set(w, (df.get(w) || 0) + 1);
  const noise = (w) => names.length >= 3 && df.get(w) / names.length > 0.4;
  return new Map(names.map((n) => {
    const words = n.split('_').filter((w) => w && !noise(w));
    return [n, (words.length ? words : n.split('_')).join('_')];
  }));
}
const singular = (w) => w.replace(/ies$/, 'y').replace(/(s|x|z|ch|sh)es$/, '$1').replace(/([^s])s$/, '$1');

async function inBatches(items, fn, size = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---- finding keys and relationships ----
// Profiles the columns that could be keys, picks each table's primary key, then checks candidate
// relationships against the data. Candidates come from names (same column name, "customer_id" next to
// a table called customers) and types, through lookups by name, so hundreds of tables stay quick.
async function detect(src, modelIn) {
  const model = normalize(modelIn);
  const raw = src.raw;
  const tables = Object.keys(src.schema.tables);
  const A = src.adapter;
  const cols = new Map(tables.map((t) => [t, columnsOf(raw, t)]));
  const nameCount = new Map();
  for (const t of tables) for (const c of cols.get(t)) nameCount.set(c.col, (nameCount.get(c.col) || 0) + 1);

  // 1. profile key-like columns: one query per table
  const profiled = await inBatches(tables, async (t) => {
    const list = cols.get(t).filter((c, i) => c.type !== 'date' && c.type !== 'bool' && (c.type === 'key' || KEYISH.test(c.col) || nameCount.get(c.col) > 1 || i === 0)).slice(0, 30).map((c) => c.col);
    try { return [t, await A.profile(t, list)]; } catch (e) { return [t, null]; }
  });
  model.profile = {};
  for (const [t, p] of profiled) if (p) model.profile[t] = p;
  const unique = (t, c) => { const p = model.profile[t]; const x = p && p.cols[c]; return !!x && p.rows > 0 && x.filled === p.rows && x.distinct === p.rows; };
  const profiledCol = (t, c) => !!(model.profile[t] && model.profile[t].cols[c]);

  // 2. primary keys
  const stem = stems(tables);
  const typeOf = (t, c) => (cols.get(t).find((x) => x.col === c) || {}).type;
  model.keys = {};
  for (const t of tables) {
    const def = raw.tables[t];
    const s = singular(stem.get(t));
    const all = cols.get(t).map((c) => c.col);
    const options = all.filter((c) => unique(t, c));
    // a unique first column also counts (a lookup table keyed by a name, such as a category)
    const rank = (c) => (c === def.key && !def.syntheticKey ? 0 : c === 'id' ? 1 : c === `${s}_id` || c === `${stem.get(t)}_id` ? 2 : /_id$/.test(c) ? 3 : KEYISH.test(c) ? 4 : c === all[0] && typeOf(t, c) === 'text' ? 4.5 : 5);
    options.sort((a, b) => rank(a) - rank(b));
    if (options.length && rank(options[0]) < 5) model.keys[t] = options[0];
    else if (def.key && !def.syntheticKey) model.keys[t] = def.key;
  }

  // 3. candidates by name
  const known = new Set([...(raw.links || []).map((l) => sigOf({ ...l, toCol: l.toCol || (raw.tables[l.to] || {}).key })), ...model.dismissed, ...model.rels.filter((r) => r.status !== 'suggested').map(sigOf)]);
  const byKeyName = new Map(), byStem = new Map();
  for (const [t, k] of Object.entries(model.keys)) {
    if (!byKeyName.has(k)) byKeyName.set(k, []);
    byKeyName.get(k).push(t);
    for (const name of new Set([stem.get(t), singular(stem.get(t)), t, singular(t)])) { if (!byStem.has(name)) byStem.set(name, []); byStem.get(name).push(t); }
  }
  const cands = new Map();
  const add = (from, col, to, toCol, score, why, both = false) => {
    if (from === to && col === toCol) return;
    if (!comparable(typeOf(from, col), typeOf(to, toCol))) return;
    const r = { from, col, to, toCol };
    const sig = sigOf(r);
    if (known.has(sig) || known.has(sigOf({ from: to, col: toCol, to: from, toCol: col }))) return;
    const prev = cands.get(sig);
    if (!prev || prev.score < score) cands.set(sig, { ...r, score, why, both });
  };
  for (const t of tables) {
    for (const { col: c } of cols.get(t)) {
      // the same column name as another table's key: orders.customer_id -> customers.customer_id
      if (c !== 'id') for (const to of byKeyName.get(c) || []) if (to !== t) add(t, c, to, c, 0.95, `same column name "${c}"`);
      // a name made of a table's name: tickets.customer_id -> customers.id
      const m = /^(.+?)_(id|key|code|no|number|ref)$/.exec(c);
      if (m) {
        for (const to of byStem.get(m[1]) || byStem.get(singular(m[1])) || []) {
          if (to === t) continue;
          const k = model.keys[to];
          if (k) add(t, c, to, k, k === c ? 0.95 : 0.9, `"${c}" names the table ${raw.tables[to].label || to}`);
        }
      }
      // ends with another table's key: seller_customer_id -> customers.customer_id
      for (const [k, list] of byKeyName) if (k.length >= 6 && k !== c && c.endsWith('_' + k)) for (const to of list) if (to !== t) add(t, c, to, k, 0.7, `"${c}" ends with "${k}"`);
    }
  }
  // columns that are not keys but share a key-like meaning: zip codes in customers and in geolocation
  const cores = new Map();
  for (const t of tables) {
    const own = [stem.get(t), singular(stem.get(t))];
    for (const { col: c } of cols.get(t)) {
      if (!KEYISH.test(c) || unique(t, c) || !profiledCol(t, c)) continue;
      // a column that already leads to a key (region_id -> regions) meets other such columns through that
      // key; only columns no table is keyed by are paired directly (zip codes in customers and geolocation)
      if (byKeyName.has(c) || [...cands.values()].some((x) => x.from === t && x.col === c && !x.both)) continue;
      let core = c;
      for (const p of own) if (core.startsWith(p + '_')) core = core.slice(p.length + 1);
      if (!cores.has(core)) cores.set(core, []);
      cores.get(core).push([t, c]);
    }
  }
  for (const [core, list] of cores) {
    if (core.split('_').length < 2 && core.length < 6) continue;
    const group = list.slice(0, 8);
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) if (group[i][0] !== group[j][0]) add(group[i][0], group[i][1], group[j][0], group[j][1], 0.6, `both are "${core}"`, true);
  }

  // 4. check each candidate against the data
  const list = [...cands.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CHECKS);
  const checked = await inBatches(list, async (c) => {
    try {
      const there = await A.coverage(c.from, c.col, c.to, c.toCol);
      if (!c.both) return { ...c, ...there };
      // for two columns that are not keys, either side may hold the full list (zip codes: geolocation)
      const back = await A.coverage(c.to, c.toCol, c.from, c.col);
      const share = (x) => (x.values ? x.found / x.values : 0);
      return share(back) > share(there) ? { ...c, from: c.to, col: c.toCol, to: c.from, toCol: c.col, ...back } : { ...c, ...there };
    } catch (e) { return null; }
  });
  const found = [];
  for (const c of checked) {
    if (!c || !c.values) continue;
    const share = c.found / c.values;
    if (share < 0.6) continue;
    const toUnique = unique(c.to, c.toCol), fromUnique = unique(c.from, c.col);
    // the "one" side is the side whose values are unique; write relationships from the many side
    let rel = { from: c.from, col: c.col, to: c.to, toCol: c.toCol };
    if (!toUnique && fromUnique) rel = { from: c.to, col: c.toCol, to: c.from, toCol: c.col };
    const cardinality = toUnique && fromUnique ? '1:1' : toUnique || fromUnique ? 'N:1' : 'N:M';
    const sig = sigOf(rel);
    if (known.has(sig)) continue;
    found.push({
      ...rel, id: idOf(sig), origin: 'auto', status: 'suggested', cardinality,
      confidence: Math.round(c.score * Math.min(1, share / 0.95) * 100) / 100, coverage: Math.round(share * 1000) / 1000,
      reason: `${c.why[0].toUpperCase()}${c.why.slice(1)}; ${share >= 0.995 ? 'every' : Math.round(share * 100) + '% of'} value${share >= 0.995 ? '' : 's'} found in ${raw.tables[rel.to].label || rel.to}`,
      name: pretty(singular(stem.get(rel.to))),
    });
  }
  // a pair of columns is offered once: a one-to-one found from both ends keeps the direction that points
  // at the table the column is named after (payments.order_id -> orders, not the other way)
  const named = (r) => { const m = /^(.+?)_(id|key|code|no|number|ref)$/.exec(r.toCol); return m && [stem.get(r.to), singular(stem.get(r.to))].includes(m[1]) ? 1 : 0; };
  found.sort((a, b) => b.confidence - a.confidence || named(b) - named(a));
  const pairs = new Set();
  const best = new Map();
  for (const r of found) {
    const pair = [r.from + '.' + r.col, r.to + '.' + r.toCol].sort().join('|');
    if (pairs.has(pair)) continue;
    // a column can lead to one table only: keep the most likely (many-to-many ones are kept as they are)
    const k = r.cardinality === 'N:M' ? sigOf(r) : r.from + '.' + r.col;
    if (best.has(k)) continue;
    pairs.add(pair);
    best.set(k, r);
  }
  model.rels = [...model.rels.filter((r) => r.status !== 'suggested'), ...best.values()];
  model.detectedAt = new Date().toISOString();
  return model;
}

// ---- the model as the browser sees it ----
function describe(src, modelIn, counts = {}) {
  const model = normalize(modelIn);
  const raw = src.raw;
  const S = src.schema;
  const followed = new Set(S.links.map((l) => sigOf(l)));
  const dbRels = (raw.links || []).map((l) => {
    const r = { from: l.from, col: l.col, to: l.to, toCol: l.toCol || (raw.tables[l.to] || {}).key || 'id' };
    const sig = sigOf(r);
    const p = model.profile[r.from];
    const oneToOne = p && p.cols[r.col] && p.rows && p.cols[r.col].distinct === p.rows && p.cols[r.col].filled === p.rows;
    return { ...r, id: 'db-' + idOf(sig), origin: 'db', status: model.dismissed.includes(sig) ? 'hidden' : 'active', cardinality: oneToOne ? '1:1' : 'N:1', name: l.name, reason: l.reason || 'Defined by the data source' };
  });
  const rels = [...dbRels.filter((r) => r.status !== 'hidden'), ...model.rels].map((r) => ({
    ...r,
    followed: followed.has(sigOf(r)) && S.tables[r.from] && S.tables[r.to] ? true : false,
  }));
  const fromCols = new Set(rels.filter((r) => r.status !== 'inactive').map((r) => r.from + '.' + r.col));
  const tables = Object.keys(S.tables).map((t) => {
    const key = model.keys[t] || (raw.tables[t].syntheticKey ? null : raw.tables[t].key);
    return {
      name: t, label: S.tables[t].label, rows: counts[t] ?? (model.profile[t] || {}).rows ?? null, key,
      columns: columnsOf(raw, t).map((c) => ({ ...c, label: (S.tables[t].fields[c.col] || {}).label || c.label, pk: c.col === key, fk: fromCols.has(t + '.' + c.col) })),
    };
  });
  return {
    tables,
    removed: model.removed.filter((t) => raw.tables[t]).map((t) => ({ name: t, label: raw.tables[t].label || pretty(t) })),
    rels: rels.filter((r) => S.tables[r.from] && S.tables[r.to]),
    hidden: dbRels.filter((r) => r.status === 'hidden').concat(model.dismissed.filter((s) => !dbRels.some((d) => sigOf(d) === s)).map((s) => {
      const m = /^(.+)\.(.+)>(.+)\.(.+)$/.exec(s);
      return m ? { id: 'x-' + idOf(s), sig: s, from: m[1], col: m[2], to: m[3], toCol: m[4], origin: 'dismissed' } : null;
    }).filter(Boolean)).map((r) => ({ ...r, sig: r.sig || sigOf(r) })),
    layout: model.layout,
    detectedAt: model.detectedAt || null,
  };
}

// ---- changes people make ----
function check(src, t, c) {
  if (!src.schema.tables[t]) throw new Error(`Unknown table: ${t}`);
  if (!columnsOf(src.raw, t).some((x) => x.col === c)) throw new Error(`Unknown column: ${t}.${c}`);
}
async function sides(src, r) {
  const [a, b] = await Promise.all([src.adapter.profile(r.from, [r.col]), src.adapter.profile(r.to, [r.toCol])]);
  const u = (p, c) => p.rows > 0 && p.cols[c].distinct === p.cols[c].filled && p.cols[c].filled === p.rows;
  return { fromUnique: u(a, r.col), toUnique: u(b, r.toCol) };
}
// A relationship drawn by hand, written from its many side; the data decides how many rows meet.
async function create(src, modelIn, body) {
  const model = normalize(modelIn);
  let r = { from: String(body.from || ''), col: String(body.col || ''), to: String(body.to || ''), toCol: String(body.toCol || '') };
  check(src, r.from, r.col);
  check(src, r.to, r.toCol);
  if (r.from === r.to && r.col === r.toCol) throw new Error('Choose two different columns');
  const { fromUnique, toUnique } = await sides(src, r);
  if (!toUnique && fromUnique) r = { from: r.to, col: r.toCol, to: r.from, toCol: r.col };
  const cardinality = toUnique && fromUnique ? '1:1' : toUnique || fromUnique ? 'N:1' : 'N:M';
  const sig = sigOf(r);
  if ((src.raw.links || []).some((l) => sigOf({ ...l, toCol: l.toCol || src.raw.tables[l.to].key }) === sig && !model.dismissed.includes(sig))) throw new Error('That relationship is already defined by the data source');
  const cov = await src.adapter.coverage(r.from, r.col, r.to, r.toCol).catch(() => null);
  const rel = {
    ...r, id: idOf(sig), origin: 'manual', status: 'active', cardinality, name: String(body.name || pretty(r.col.replace(/_(id|key|code)$/, '')) || r.to).slice(0, 60),
    coverage: cov && cov.values ? Math.round((cov.found / cov.values) * 1000) / 1000 : null,
    reason: 'Drawn by hand' + (cov && cov.values ? `; ${Math.round((cov.found / cov.values) * 100)}% of values found` : ''),
  };
  model.rels = model.rels.filter((x) => sigOf(x) !== sig && sigOf(x) !== sigOf({ from: r.to, col: r.toCol, to: r.from, toCol: r.col }));
  model.dismissed = model.dismissed.filter((s) => s !== sig);
  model.rels.push(rel);
  return { model, rel };
}
async function edit(src, modelIn, id, patch) {
  const model = normalize(modelIn);
  const i = model.rels.findIndex((r) => r.id === id);
  if (i < 0) throw new Error('Relationships defined by the data source cannot be changed; hide them instead');
  let r = { ...model.rels[i] };
  if (patch.status && ['active', 'inactive'].includes(patch.status)) r.status = patch.status;
  if (patch.name) r.name = String(patch.name).slice(0, 60);
  if (patch.cardinality) {
    let card = patch.cardinality;
    if (card === '1:N') { r = { ...r, from: r.to, col: r.toCol, to: r.from, toCol: r.col }; card = 'N:1'; }
    if (!['N:1', '1:1', 'N:M'].includes(card)) throw new Error('Unknown cardinality');
    if (card !== 'N:M') {
      const { fromUnique, toUnique } = await sides(src, r);
      if (!toUnique) throw new Error(`Values of ${r.to}.${r.toCol} repeat, so it cannot be the "one" side`);
      if (card === '1:1' && !fromUnique) throw new Error(`Values of ${r.from}.${r.col} repeat, so this cannot be one-to-one`);
    }
    r.cardinality = card;
    r.id = idOf(sigOf(r));
  }
  if (r.origin === 'auto' && r.status === 'suggested' && patch.status === undefined) r.status = 'active';
  model.rels[i] = r;
  return { model, rel: r };
}
function confirm(modelIn, ids) {
  const model = normalize(modelIn);
  const want = new Set(ids);
  model.rels = model.rels.map((r) => (want.has(r.id) && r.status === 'suggested' ? { ...r, status: 'active' } : r));
  return model;
}
// Deleting hides it for good: database-defined ones stop being used, suggestions are not offered again.
function remove(src, modelIn, ids) {
  const model = normalize(modelIn);
  const all = describe(src, model).rels;
  for (const id of ids) {
    const r = all.find((x) => x.id === id);
    if (!r) continue;
    const sig = sigOf(r);
    model.rels = model.rels.filter((x) => x.id !== id);
    if (!model.dismissed.includes(sig)) model.dismissed.push(sig);
  }
  return model;
}
function unhide(modelIn, sigs) {
  const model = normalize(modelIn);
  model.dismissed = model.dismissed.filter((s) => !sigs.includes(s));
  return model;
}
// Tables left out of the studio; their relationships go with them. Nothing is deleted from the data.
function removeTables(src, modelIn, list) {
  const model = normalize(modelIn);
  const names = list.filter((t) => src.raw.tables[t]);
  model.removed = [...new Set([...model.removed, ...names])];
  model.rels = model.rels.filter((r) => !names.includes(r.from) && !names.includes(r.to));
  for (const t of names) { delete model.layout[t]; delete model.profile[t]; delete model.keys[t]; }
  return model;
}
function restoreTables(modelIn, list) {
  const model = normalize(modelIn);
  model.removed = model.removed.filter((t) => !list.includes(t));
  return model;
}
function setLayout(modelIn, positions) {
  const model = normalize(modelIn);
  for (const [t, p] of Object.entries(positions || {}).slice(0, 2000)) {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) model.layout[t] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return model;
}

module.exports = { emptyModel, normalize, columnsOf, detect, describe, create, edit, confirm, remove, unhide, removeTables, restoreTables, setLayout, FOLLOWED };
