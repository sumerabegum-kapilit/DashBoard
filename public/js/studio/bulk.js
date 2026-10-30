// Importing files: one, many, or a whole folder (picked or dropped). The files found are listed with the
// table each becomes, so people can choose which to import, rename them, and see files that cannot be
// imported or would duplicate a table. Each file is streamed to the server on its own (any size); when
// all are in, the studio looks for relationships between them once and opens the model to review them.
import { app, mk, button, select, input, check, get, post } from './core.js';
import { toast } from '../util.js';

const SUPPORTED = /\.(csv|tsv|txt|json|ndjson|jsonl)$/i;
const colName = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40);
const mb = (n) => (n / 1048576).toLocaleString(undefined, { maximumFractionDigits: n < 10485760 ? 1 : 0 }) + ' MB';

// Table names from file names, without the words every file shares ("olist_…_dataset.csv" -> "customers").
function tableNames(files) {
  const names = files.map((f) => colName(f.name.replace(/\.[^.]+$/, '')) || 'data');
  if (names.length < 2) return names;
  const strip = (list, at) => {
    const word = (n) => (at === 'start' ? n.split('_')[0] : n.split('_').pop());
    const counts = new Map();
    for (const n of list) if (n.includes('_')) counts.set(word(n), (counts.get(word(n)) || 0) + 1);
    const common = [...counts].filter(([, c]) => c >= 2 && c / list.length >= 0.6).map(([w]) => w);
    return list.map((n) => {
      if (!n.includes('_') || !common.includes(word(n))) return n;
      const parts = n.split('_');
      return (at === 'start' ? parts.slice(1) : parts.slice(0, -1)).join('_');
    });
  };
  const tidy = strip(strip(names, 'start'), 'end');
  // keep the full names if tidying would make two the same
  return new Set(tidy).size === new Set(names).size ? tidy : names;
}

// Files inside dropped folders
async function filesFromDrop(items) {
  const out = [];
  const walk = async (entry, path) => {
    if (!entry) return;
    if (entry.isFile) { out.push(await new Promise((res, rej) => entry.file((f) => res(Object.assign(f, { relPath: path + f.name })), rej))); return; }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path + entry.name + '/');
      }
    }
  };
  for (const it of items) await walk(it.webkitGetAsEntry && it.webkitGetAsEntry(), '');
  return out;
}

export function importCard(hooks) {
  const card = mk('div', 'add-card import-card');
  const uploads = app.sources.filter((s) => s.kind === 'upload');
  const max = (app.schema.maxUploadMb || 2048) * 1048576;
  let target = uploads.some((s) => s.id === app.source) ? app.source : '';
  let label = '';
  let rows = [];
  let existing = new Set();
  let busy = false;

  const pickFiles = document.createElement('input');
  pickFiles.type = 'file';
  pickFiles.multiple = true;
  pickFiles.accept = '.csv,.tsv,.txt,.json,.ndjson,.jsonl,text/csv,application/json';
  pickFiles.hidden = true;
  pickFiles.setAttribute('aria-label', 'Files');
  const pickFolder = document.createElement('input');
  pickFolder.type = 'file';
  pickFolder.webkitdirectory = true;
  pickFolder.multiple = true;
  pickFolder.hidden = true;
  pickFolder.setAttribute('aria-label', 'Folder');
  pickFiles.addEventListener('change', () => { add([...pickFiles.files]); pickFiles.value = ''; });
  pickFolder.addEventListener('change', () => { add([...pickFolder.files]); pickFolder.value = ''; });

  const drop = mk('div', 'dropzone');
  drop.append(mk('b', null, 'Drop files or a folder here'), mk('span', 'note', 'or'),
    button('Choose files', 'btn small', () => pickFiles.click()), button('Choose a folder', 'btn small', () => pickFolder.click()), pickFiles, pickFolder);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const items = [...(e.dataTransfer.items || [])];
    add(items.length && items[0].webkitGetAsEntry ? await filesFromDrop(items) : [...e.dataTransfer.files]);
  });

  const into = mk('div');
  const list = mk('div', 'import-list');
  const status = mk('p', 'note');
  const bar = mk('progress', 'upload-progress');
  bar.max = 1;
  bar.hidden = true;
  const go = button('Import', 'btn primary', () => run());
  card.append(mk('h3', null, 'Import files'),
    mk('p', 'note', `One file, many files, or a folder of them: CSV (comma, semicolon or tab), a JSON list of rows, or one JSON object per line, up to ${mb(max)} each. Each file becomes a table. Files are streamed to the server and stored in a database file there, so large files work. Afterwards the studio looks for relationships between the tables and shows them for review.`),
    drop, into, list, go, bar, status);

  async function loadExisting() {
    existing = new Set();
    if (!target) return;
    try {
      const m = await get(`/api/s/${target}/model`, { fresh: true });
      for (const t of [...m.tables, ...m.removed]) existing.add(t.name);
    } catch (e) { /* treat as empty */ }
  }
  function add(files) {
    const known = new Set(rows.map((r) => r.file.webkitRelativePath || r.file.relPath || r.file.name));
    const fresh = files.filter((f) => !known.has(f.webkitRelativePath || f.relPath || f.name) && !/^\./.test(f.name));
    if (!label && fresh[0]) { const p = fresh[0].webkitRelativePath || fresh[0].relPath || ''; if (p.includes('/')) label = p.split('/')[0]; }
    const all = [...rows.map((r) => r.file), ...fresh];
    const names = tableNames(all.filter((f) => SUPPORTED.test(f.name)));
    let k = 0;
    rows = all.map((f) => {
      const old = rows.find((r) => r.file === f);
      const ok = SUPPORTED.test(f.name);
      const name = ok ? names[k++] : '';
      return old ? { ...old, name: old.renamed ? old.name : name } : { file: f, name, checked: true, replace: false, renamed: false, state: '' };
    });
    draw();
  }
  // which rows can be imported, and why not
  function assess() {
    const seen = new Map();
    for (const r of rows) {
      r.problem = !SUPPORTED.test(r.file.name) ? 'Not a supported file' : !r.file.size ? 'Empty file' : r.file.size > max ? `Larger than ${mb(max)}` : !r.name ? 'Needs a table name' : '';
      r.dupe = '';
      if (!r.problem) {
        if (seen.has(r.name)) r.dupe = 'Same table name as another file';
        else if (existing.has(r.name) && !r.replace) r.dupe = 'Already in this source';
        seen.set(r.name, true);
      }
    }
  }
  function draw() {
    assess();
    into.replaceChildren(row2('Into', select([['', 'A new source'], ...uploads.map((s) => [s.id, s.label])], target, async (v) => { target = v; await loadExisting(); draw(); }, { label: 'Import into' }),
      target ? mk('span') : input('text', label, (v) => { label = v; }, { placeholder: 'Name of the new source', label: 'Name of the new source', live: true })));
    list.replaceChildren();
    if (!rows.length) { go.disabled = true; go.textContent = 'Import'; return; }
    const head = mk('div', 'import-head');
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.setAttribute('aria-label', 'Select all files');
    const usable = rows.filter((r) => !r.problem);
    all.checked = usable.length > 0 && usable.every((r) => r.checked);
    all.addEventListener('change', () => { for (const r of usable) r.checked = all.checked; draw(); });
    head.append(all, mk('span', null, `${rows.length} file${rows.length > 1 ? 's' : ''}`), button('Clear', 'btn small', () => { rows = []; label = ''; draw(); }));
    list.append(head);
    const scroll = mk('div', 'import-rows');
    for (const r of rows) {
      const el = mk('div', 'import-row' + (r.problem ? ' bad' : r.dupe ? ' dupe' : ''));
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.disabled = !!r.problem || busy;
      box.checked = !r.problem && r.checked && !r.dupe;
      box.setAttribute('aria-label', `Import ${r.file.name}`);
      box.addEventListener('change', () => { r.checked = box.checked; if (box.checked && r.dupe === 'Already in this source') r.replace = true; draw(); });
      const name = input('text', r.name, (v) => { r.name = colName(v); r.renamed = true; r.checked = true; draw(); }, { label: `Table name for ${r.file.name}` });
      name.disabled = !!r.problem || busy;
      const info = mk('div', 'import-info');
      info.append(mk('span', 'import-file', r.file.webkitRelativePath || r.file.relPath || r.file.name), mk('span', 'note', mb(r.file.size)));
      const state = mk('span', 'import-state ' + (r.state === 'done' ? 'ok' : r.state === 'failed' ? 'bad' : ''), r.message || r.problem || r.dupe || 'Ready');
      el.append(box, info, name, state);
      if (r.dupe === 'Already in this source' || r.replace) el.append(check('Replace', r.replace, (v) => { r.replace = v; r.checked = v; draw(); }));
      scroll.append(el);
    }
    list.append(scroll);
    const n = rows.filter((r) => !r.problem && r.checked && !r.dupe).length;
    go.disabled = busy || !n;
    go.textContent = `Import ${n} table${n === 1 ? '' : 's'}`;
  }
  function row2(label, ...controls) {
    const l = mk('div', 'frow');
    l.append(mk('span', 'flabel', label), ...controls);
    return l;
  }

  async function run() {
    const todo = rows.filter((r) => !r.problem && r.checked && !r.dupe);
    if (!todo.length) return;
    busy = true;
    bar.hidden = false;
    let sourceId = target || null;
    let done = 0, failed = 0;
    for (const r of rows) if (todo.includes(r)) { r.state = 'waiting'; r.message = 'Waiting'; }
    draw();
    for (const [i, r] of todo.entries()) {
      r.state = 'running';
      try {
        const id = await uploadFile(r.file, { label: label || (target ? '' : todo[0].name), table: r.name, sourceId, replace: r.replace, detect: '0' }, (text, part) => {
          r.message = text;
          status.textContent = `${i + 1} of ${todo.length}: ${r.file.name}. ${text}`;
          bar.value = (i + (part ?? 0.5)) / todo.length;
          const el = list.querySelectorAll('.import-row')[rows.indexOf(r)];
          if (el) el.querySelector('.import-state').textContent = text;
        });
        sourceId = sourceId || id;
        r.state = 'done';
        r.message = 'Imported';
        existing.add(r.name);
        done++;
      } catch (e) {
        r.state = 'failed';
        r.message = e.message;
        failed++;
      }
      r.checked = false;
      draw();
    }
    busy = false;
    if (!sourceId) { status.textContent = 'Nothing could be imported.'; bar.hidden = true; draw(); return; }
    status.textContent = `${done} imported${failed ? `, ${failed} failed (see the list)` : ''}. Looking for relationships…`;
    bar.removeAttribute('value');
    try { await post(`/api/s/${sourceId}/model/detect`, {}); } catch (e) { toast('Relationships could not be looked for: ' + e.message); }
    await hooks.refreshSources();
    bar.hidden = true;
    status.textContent = `${done} imported${failed ? `, ${failed} failed` : ''}.`;
    if (failed) { draw(); toast(`${failed} file${failed > 1 ? 's' : ''} could not be imported; the reasons are in the list.`); }
    hooks.openSource(sourceId, 'model');
  }

  loadExisting().then(draw);
  return card;
}

// Sends a file of any size: the browser streams it from disk (no copy in memory), shows how much has
// been sent, then follows the server while it reads and imports the rows. Resolves with the source id.
function uploadFile(f, { label, table, sourceId, replace, detect }, onProgress) {
  const params = new URLSearchParams({ filename: f.name, label: label || '', table: table || '' });
  if (sourceId) params.set('sourceId', sourceId);
  if (replace) params.set('replace', '1');
  if (detect) params.set('detect', detect);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sources/upload?' + params);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(`Sending ${mb(e.loaded)} of ${mb(f.size)}…`, e.lengthComputable ? (e.loaded / e.total) * 0.5 : null);
    xhr.onerror = () => reject(new Error('The upload failed. Check the connection to the server.'));
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      if (xhr.status !== 200 || !body) return reject(new Error((body && body.error) || `The server answered ${xhr.status}.`));
      follow(body.job, f.size, onProgress).then(resolve, reject);
    };
    xhr.send(f);
  });
}
async function follow(id, size, onProgress) {
  for (;;) {
    const j = await (await fetch('/api/jobs/' + id)).json();
    if (j.error && !j.state) throw new Error(j.error);
    if (j.state === 'error') throw new Error(j.error);
    if (j.state === 'done') return j.sourceId;
    if (j.state === 'receiving') onProgress(`Saving on the server… ${mb(j.received)}`, size ? (j.received / size) * 0.5 : null);
    if (j.state === 'reading') onProgress(`Working out the columns… ${j.rows.toLocaleString()} rows read`, size ? 0.5 + (j.read / size) * 0.2 : null);
    if (j.state === 'importing') onProgress(`Importing ${j.rows.toLocaleString()} of ${j.total.toLocaleString()} rows…`, 0.7 + (j.rows / j.total) * 0.28);
    if (j.state === 'indexing') onProgress(`Indexing ${j.rows.toLocaleString()} rows…`, 0.98);
    if (j.state === 'relating') onProgress('Looking for relationships…', 0.99);
    await new Promise((r) => setTimeout(r, j.state === 'receiving' ? 300 : 500));
  }
}
