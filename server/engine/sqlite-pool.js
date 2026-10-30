// Runs SQLite queries in worker threads. SQLite in Node is synchronous, so a query on millions of rows
// would stop the server while it runs; in workers, several widgets are answered at once on separate
// cores and the server keeps answering everything else (such as upload progress).
const os = require('os');
const { Worker } = require('worker_threads');

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = 1; PRAGMA cache_size = -32768; PRAGMA temp_store = MEMORY;');
db.aggregate('median_of', {
  start: () => [],
  step: (acc, v) => { if (v !== null && v !== undefined) acc.push(Number(v)); return acc; },
  result: (acc) => {
    if (!acc.length) return null;
    acc.sort((a, b) => a - b);
    const h = (acc.length - 1) / 2;
    return (acc[Math.floor(h)] + acc[Math.ceil(h)]) / 2;
  },
});
const statements = new Map();
parentPort.on('message', ({ id, sql, params, close }) => {
  // closing the connection before the thread ends releases the file (Windows keeps it locked otherwise)
  if (close) { statements.clear(); db.close(); parentPort.close(); return; }
  try {
    let st = statements.get(sql);
    if (!st) { st = db.prepare(sql); if (statements.size < 500) statements.set(sql, st); }
    parentPort.postMessage({ id, rows: st.all(params) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
`;

const SIZE = Math.min(4, Math.max(2, os.cpus().length - 1));

class SqlitePool {
  constructor(file, size = SIZE) {
    this.file = file;
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
  }
  spawn() {
    const w = new Worker(WORKER, { eval: true, workerData: { file: this.file } });
    w.busy = null;
    w.on('message', (m) => {
      const job = this.pending.get(m.id);
      this.pending.delete(m.id);
      w.busy = null;
      if (job) {
        if (m.error) { const err = new Error(m.error); err.code = 'SQLITE'; job.reject(err); } else job.resolve(m.rows);
      }
      if (!this.closed) this.next();
    });
    w.on('error', (err) => {
      if (w.busy) { const job = this.pending.get(w.busy); this.pending.delete(w.busy); if (job) job.reject(Object.assign(err, { code: 'SQLITE' })); }
      this.workers = this.workers.filter((x) => x !== w);
      this.next();
    });
    w.unref();
    this.workers.push(w);
    return w;
  }
  next() {
    if (this.closed) return;
    while (this.queue.length) {
      let w = this.workers.find((x) => !x.busy);
      if (!w && this.workers.length < this.size) w = this.spawn();
      if (!w) return;
      const job = this.queue.shift();
      w.busy = job.id;
      w.postMessage({ id: job.id, sql: job.sql, params: job.params });
    }
  }
  all(sql, params) {
    if (this.closed) return Promise.reject(new Error('This source was just reloaded; try again'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, sql, params });
      this.next();
    });
  }
  // Waits for running queries, then lets each worker close its connection and end.
  close() {
    this.closed = true;
    for (const job of this.queue) { const p = this.pending.get(job.id); this.pending.delete(job.id); if (p) p.reject(new Error('This source was just reloaded; try again')); }
    this.queue = [];
    return Promise.all(this.workers.map((w) => new Promise((done) => {
      const end = () => { w.once('exit', done); w.postMessage({ close: true }); setTimeout(() => w.terminate(), 30000).unref(); };
      if (!w.busy) return end();
      w.once('message', () => setImmediate(end));
    })));
  }
}

module.exports = { SqlitePool };
