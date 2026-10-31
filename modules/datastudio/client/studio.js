// The data studio in the browser: one call puts it inside an element of the host's page.
//
//   import { mount } from '/analytics/assets/studio.js';
//   const studio = await mount(document.querySelector('#analytics'), { api: '/analytics/api' });
//
// Options (all optional except api):
//   api          where the module's API is mounted (createRouter), e.g. '/analytics/api'
//   headers      headers for every API call, or a function returning them (a token, a CSRF header)
//   credentials  fetch credentials mode (default 'same-origin')
//   source       show only this source (the source picker is hidden)
//   routing      'hash' (the studio's place is kept in the address, #/source/page) or 'memory' (default 'hash')
//   start        where to open, e.g. '/sales/model'
//   rail         false hides the studio's own side menu (the host navigates with handle.navigate)
//   title        name shown at the top of the side menu (default 'Data studio')
//   theme        'light', 'dark' or 'auto' (default: the person's last choice, else their system setting)
//   onNavigate   ({ source, page }) => void, told whenever the studio moves
//   assets, d3   where the studio's files and d3 are served (default: next to this file)
//
// Returns { navigate(path), path, destroy() }. One studio is shown per page at a time.
const HERE = new URL('.', import.meta.url).href;
let shown = null;

const SHELL = `
<div class="app">
  <aside class="rail">
    <div class="rail-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true">◆</span> <span id="ds-title"></span></div>
      <label class="rail-field"><span class="flabel">Data source</span><select id="ds-source" aria-label="Data source"></select></label>
      <div class="rail-head"><span class="flabel">Dashboards</span></div>
      <nav class="dash-nav" id="ds-dash-list" aria-label="Dashboards"></nav>
      <nav class="dash-nav" id="ds-pages" aria-label="Data model"></nav>
      <p class="note rail-note" id="ds-source-note"></p>
      <button type="button" class="btn small ghost" id="ds-theme" aria-label="Switch light or dark">◐ Light / dark</button>
    </div>
  </aside>
  <main class="main" id="ds-main"><p class="empty">Loading…</p></main>
</div>
<aside class="drawer" id="ds-drawer" hidden aria-label="Widget editor"></aside>
<dialog class="dlg" id="ds-modal"></dialog>
<div class="pop" id="ds-pop" role="menu" hidden></div>
<div class="toast" id="ds-toast" role="status" hidden></div>`;

function addCss(href) {
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = l.onerror = () => resolve();
    document.head.append(l);
  });
}
function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.append(s);
  });
}

export async function mount(element, options = {}) {
  const el = typeof element === 'string' ? document.querySelector(element) : element;
  if (!el) throw new Error('mount() needs an element to show the studio in');
  if (!options.api) throw new Error('mount() needs the address of the module API: { api: "/analytics/api" }');
  if (shown) shown.destroy();
  const assets = options.assets ? options.assets.replace(/\/?$/, '/') : HERE;
  await Promise.all([addCss(assets + 'studio.css'), window.d3 ? null : addScript(options.d3 || assets + 'vendor/d3.min.js')]);
  // the studio's modules read d3 when they load, so they load after it
  const [{ config }, util, core, main] = await Promise.all([import('./js/api.js'), import('./js/util.js'), import('./js/core.js'), import('./js/main.js')]);
  config.base = options.api.replace(/\/$/, '');
  config.headers = options.headers || {};
  config.credentials = options.credentials || 'same-origin';

  const root = document.createElement('div');
  root.className = 'ds-root' + (options.rail === false ? ' no-rail' : '');
  root.innerHTML = SHELL;
  root.querySelector('#ds-title').textContent = options.title || 'Data studio';
  el.replaceChildren(root);
  util.ui.root = root;
  core.app.root = root;
  core.nav.mode = options.routing === 'memory' ? 'memory' : 'hash';
  core.nav.path = options.start || '/';
  if (core.nav.mode === 'hash' && options.start && !location.hash) history.replaceState(null, '', '#' + options.start);

  await main.start(options);
  const handle = {
    navigate: (path) => core.nav.go(path),
    get path() { return core.nav.get(); },
    destroy() {
      main.stop();
      root.remove();
      if (shown === handle) shown = null;
    },
  };
  shown = handle;
  return handle;
}
