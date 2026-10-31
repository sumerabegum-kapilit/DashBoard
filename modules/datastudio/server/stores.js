// Where the module keeps what people configure: display names, hidden and ordered columns, calculated
// columns, relationships and dashboards. A store is any object with two async methods:
//
//   get(key)          -> the saved value, or undefined
//   set(key, value)   -> saves a JSON-serialisable value (null removes it)
//
// Keys look like "source:<id>:overrides", "source:<id>:model", "source:<id>:dashboards:<scope>".
// Give the module your own (a table in your database, Redis ...) or use one of these two.
const fs = require('fs');
const path = require('path');

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function memoryStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    async get(key) { return copy(m.get(key)); },
    async set(key, value) { if (value === null) m.delete(key); else m.set(key, copy(value)); },
    async keys(prefix = '') { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

// One JSON file, written whole and swapped in, one write at a time.
function jsonFileStore(file) {
  let data = null;
  let writing = Promise.resolve();
  const load = () => {
    if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; } }
    return data;
  };
  return {
    async get(key) { return copy(load()[key]); },
    async set(key, value) {
      const all = load();
      if (value === null) delete all[key]; else all[key] = copy(value);
      const body = JSON.stringify(all, null, 1);
      writing = writing.then(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', body);
        fs.renameSync(file + '.tmp', file);
      });
      return writing;
    },
    async keys(prefix = '') { return Object.keys(load()).filter((k) => k.startsWith(prefix)); },
  };
}

module.exports = { memoryStore, jsonFileStore };
