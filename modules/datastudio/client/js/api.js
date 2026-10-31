// Talks to the module's API. The address it lives at, and any headers the host needs (a token, a CSRF
// header), are set once by mount() in config. Answers to GET requests are reused unless asked fresh.
export const config = { base: '', headers: {}, credentials: 'same-origin' };
const cache = new Map();

const urlOf = (url) => (/^https?:/.test(url) ? url : config.base + url);
const headers = (extra) => ({ ...(typeof config.headers === 'function' ? config.headers() : config.headers), ...extra });
async function asJson(res) {
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `The server answered ${res.status}.`);
  return body;
}
export async function get(url, { fresh = false } = {}) {
  if (!fresh && cache.has(url)) return cache.get(url);
  const p = fetch(urlOf(url), { headers: headers(), credentials: config.credentials }).then(asJson);
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const send = (method) => async (url, data) => asJson(await fetch(urlOf(url), { method, headers: headers({ 'content-type': 'application/json' }), credentials: config.credentials, body: JSON.stringify(data) }));
export const post = send('POST');
export const put = send('PUT');
export const del = send('DELETE');
export const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
export const clearCache = () => cache.clear();
