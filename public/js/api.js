// Talks to the server. Every chart is fetched once per period and project, then reused.
const cache = new Map();

async function asJson(res) {
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `The server answered ${res.status}.`);
  return body;
}
export async function get(url, { fresh = false } = {}) {
  if (!fresh && cache.has(url)) return cache.get(url);
  const p = fetch(url).then(asJson);
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
export async function post(url, data) {
  return asJson(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }));
}
export async function put(url, data) {
  return asJson(await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }));
}
export const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
export const clearCache = () => cache.clear();
