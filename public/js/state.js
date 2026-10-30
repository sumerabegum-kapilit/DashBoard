// Saved choices (card layouts, views, My dashboard, filters), kept on the server per browser.
import { get, put } from './api.js';

const ID_KEY = 'scrumban-client-id';
let clientId = null;
try { clientId = localStorage.getItem(ID_KEY); } catch (e) { /* storage blocked */ }
if (!clientId) {
  clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem(ID_KEY, clientId); } catch (e) { /* this browser session only */ }
}

const state = {};
const timers = {};

export async function loadState() {
  try { Object.assign(state, await get('/api/state?client=' + clientId, { fresh: true })); } catch (e) { console.warn('Could not load saved settings:', e.message); }
}
export const read = (key, fallback) => (state[key] === undefined ? fallback : state[key]);
export function write(key, value) {
  state[key] = value;
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    put('/api/state', { client: clientId, key, value }).catch((e) => console.warn('Could not save settings:', e.message));
  }, 400);
}
