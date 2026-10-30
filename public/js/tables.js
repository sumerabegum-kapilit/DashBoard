// Tables that page, sort and search on the server, 10 rows at a time.
import { get, qs } from './api.js';
import { mk, button, fInt, fPct, f1 } from './util.js';

const TABLES = {
  projects: {
    url: '/api/table/projects', search: true, sort: 'open',
    columns: [
      ['project', 'Project', 'text'], ['type', 'Type', 'cap'], ['open', 'Open', 'int'], ['overdue', 'Overdue', 'hot'], ['blocked', 'Blocked', 'hot'],
      ['urgent', 'Critical/high', 'int'], ['created', 'Created', 'int'], ['completed', 'Completed', 'int'], ['done_share', 'Done overall', 'pct'],
      ['hours', 'Hours', 'dec'], ['people', 'People on open work', 'int'],
    ],
  },
  sprints: {
    url: '/api/table/sprints', search: false, sort: null,
    columns: [
      ['sprint', 'Sprint', 'text'], ['status', 'Status', 'status'], ['start_date', 'Start', 'text'], ['end_date', 'End', 'text'],
      ['items', 'Items', 'int'], ['items_done', 'Items done', 'int'], ['points', 'Points', 'dec'], ['points_done', 'Points done', 'dec'],
    ],
  },
};
const memory = {};

export function serverTable(host, kind, filters) {
  const def = TABLES[kind];
  const st = (memory[kind] = memory[kind] || { page: 1, sort: def.sort, dir: 'desc', search: '' });
  host.replaceChildren();
  const wrap = mk('div', 'server-table');
  if (def.search) {
    const s = document.createElement('input');
    s.type = 'search';
    s.placeholder = 'Search';
    s.value = st.search;
    s.setAttribute('aria-label', 'Search');
    let t;
    s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.search = s.value.trim(); st.page = 1; load(); }, 250); });
    wrap.append(s);
  }
  const scroll = mk('div', 'scroll');
  const table = mk('table', 'table');
  scroll.append(table);
  const pager = mk('div', 'pager');
  wrap.append(scroll, pager);
  host.append(wrap);

  async function load() {
    table.classList.add('loading');
    try {
      const data = await get(`${def.url}?${qs({ ...filters, page: st.page, size: 10, sort: st.sort, dir: st.dir, search: st.search })}`);
      draw(data);
    } catch (e) {
      table.replaceChildren(mk('caption', 'error', e.message));
    } finally {
      table.classList.remove('loading');
    }
  }
  function cell(type, v, row) {
    if (v == null) return mk('td', null, '—');
    if (type === 'int') return mk('td', null, fInt(v));
    if (type === 'dec') return mk('td', null, f1(v));
    if (type === 'pct') return mk('td', null, fPct(v));
    if (type === 'hot') return mk('td', v ? 'hot' : null, fInt(v));
    if (type === 'cap') return mk('td', 'cap', v);
    if (type === 'status') return mk('td', row.stale ? 'cap hot' : 'cap', row.stale ? v + ' (past end date)' : v);
    return mk('td', null, String(v));
  }
  function draw(data) {
    table.replaceChildren();
    const hr = mk('tr');
    for (const [key, label] of def.columns) {
      const th = mk('th');
      if (def.sort) {
        th.setAttribute('aria-sort', st.sort === key ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        th.append(button(label, 'sort', () => {
          st.dir = st.sort === key && st.dir === 'desc' ? 'asc' : st.sort === key ? 'desc' : key === 'project' || key === 'type' ? 'asc' : 'desc';
          st.sort = key;
          st.page = 1;
          load();
        }));
      } else th.textContent = label;
      hr.append(th);
    }
    const head = mk('thead'); head.append(hr); table.append(head);
    const body = mk('tbody');
    for (const row of data.rows) {
      const tr = mk('tr');
      for (const [key, , type] of def.columns) tr.append(cell(type, row[key], row));
      body.append(tr);
    }
    if (!data.rows.length) { const tr = mk('tr'); const td = mk('td', 'empty', 'No rows match.'); td.colSpan = def.columns.length; tr.append(td); body.append(tr); }
    table.append(body);
    const last = Math.max(1, Math.ceil(data.total / 10));
    const from = data.total ? (st.page - 1) * 10 + 1 : 0, to = Math.min(data.total, st.page * 10);
    const prev = button('‹ Previous', 'btn', () => { st.page--; load(); });
    prev.disabled = st.page <= 1;
    const next = button('Next ›', 'btn', () => { st.page++; load(); });
    next.disabled = st.page >= last;
    pager.replaceChildren(prev, next, mk('span', 'note', `${fInt(from)}–${fInt(to)} of ${fInt(data.total)} · page ${st.page} of ${last}`));
  }
  load();
}
