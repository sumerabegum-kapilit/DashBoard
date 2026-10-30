// Saved layouts and views, kept in a JSON file next to the app (never in the database).
// Each browser gets its own id, so people sharing the server keep their own choices.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const KEYS = ['cards', 'views', 'board', 'filters', 'draft', 'studio'];
const MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

let cache = null;
let writing = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch (e) {
    cache = {};
  }
  return cache;
}

function get(client) {
  if (!ID.test(client || '')) throw new Error('Unknown browser id');
  return load()[client] || {};
}

function set(client, key, value) {
  if (!ID.test(client || '')) throw new Error('Unknown browser id');
  if (!KEYS.includes(key)) throw new Error('Unknown setting');
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_BYTES) throw new Error('That setting is too large to save');
  const all = load();
  all[client] = { ...(all[client] || {}), [key]: value, updatedAt: new Date().toISOString() };
  // write to a temporary file and swap it in, one write at a time
  writing = writing.then(() => {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    const tmp = config.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
    fs.renameSync(tmp, config.stateFile);
  }).catch((err) => console.error('Could not save settings:', err.message));
  return writing;
}

module.exports = { get, set, KEYS };
