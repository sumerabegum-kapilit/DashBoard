// Boards of cards people can drag, resize, hide and switch to another chart type.
// layout: { [cardId]: { o: order, w: width out of 6, h: hidden, v: chart type, off: lines turned off, shapes } }
import { mk, button, selectBox, clamp } from './util.js';
import { VIEWS } from './render.js';

export function mountBoard(host, opts) {
  const { cards, getLayout, setLayout, renderBody, removeLabel = 'Hide card', onRemove, tools = true } = opts;
  host.replaceChildren();
  const layout = () => getLayout() || {};
  const patch = (id, p) => { const l = { ...layout() }; l[id] = { ...(l[id] || {}), ...p }; setLayout(l); };

  if (tools) {
    const bar = mk('div', 'board-tools');
    const showAll = button('Show hidden cards', 'btn', () => {
      const l = { ...layout() };
      for (const c of cards) if (l[c.id]) l[c.id] = { ...l[c.id], h: false };
      setLayout(l);
      apply();
    });
    bar.append(mk('span', 'note', 'Drag ⠿ to move · drag the corner to resize'), showAll,
      button('Reset layout', 'btn', () => { const l = { ...layout() }; for (const c of cards) delete l[c.id]; setLayout(l); apply(); rerenderAll(); }));
    host.append(bar);
    opts.showAllButton = showAll;
  }
  const grid = mk('div', 'board');
  host.append(grid);

  const els = new Map();
  const ordered = () => cards.slice().sort((a, b) => (layout()[a.id]?.o ?? cards.indexOf(a)) - (layout()[b.id]?.o ?? cards.indexOf(b)));
  const moveTo = (id, index) => {
    const list = ordered().filter((c) => c.id !== id);
    list.splice(clamp(index, 0, list.length), 0, cards.find((c) => c.id === id));
    const l = { ...layout() };
    list.forEach((c, k) => { l[c.id] = { ...(l[c.id] || {}), o: k }; });
    setLayout(l);
    apply();
  };

  function apply() {
    const l = layout();
    let hidden = 0;
    cards.forEach((c, i) => {
      const e = els.get(c.id);
      const s = l[c.id] || {};
      e.card.style.order = String(s.o ?? i);
      e.card.style.gridColumn = 'span ' + (s.w || c.w || 3);
      e.card.hidden = !!s.h;
      if (s.h) hidden++;
      if (e.view) e.view.value = s.v || c.view || VIEWS[c.views][0][0];
    });
    if (opts.showAllButton) opts.showAllButton.disabled = hidden === 0;
  }
  const draw = (c) => {
    const e = els.get(c.id);
    if (e.card.hidden) return;
    const s = layout()[c.id] || {};
    renderBody(c, e.body, e.extra, { ...s, v: s.v || c.view || (c.views ? VIEWS[c.views][0][0] : null) }, () => draw(c), (p) => { patch(c.id, p); draw(c); });
  };
  const rerenderAll = () => cards.forEach(draw);

  let dragId = null;
  for (const c of cards) {
    const card = mk('article', 'card');
    card.dataset.id = c.id;
    const bar = mk('div', 'card-bar');
    const handle = mk('div', 'card-drag');
    handle.draggable = true;
    handle.title = 'Drag to move';
    handle.append(mk('span', 'grip', '⠿'), mk('h2', null, c.title));
    const toolsEl = mk('div', 'card-tools');
    let view = null;
    if (c.views) {
      view = selectBox(VIEWS[c.views], c.view, (v) => { patch(c.id, { v }); draw(c); }, { label: 'Chart type' });
      toolsEl.append(view);
    }
    toolsEl.append(
      button('◀', 'tool', () => moveTo(c.id, ordered().indexOf(c) - 1), 'Move earlier'),
      button('▶', 'tool', () => moveTo(c.id, ordered().indexOf(c) + 1), 'Move later'),
      button('✕', 'tool', () => { if (onRemove) onRemove(c); else { patch(c.id, { h: true }); apply(); } }, removeLabel),
    );
    bar.append(handle, toolsEl);
    const extra = mk('div', 'card-extra');
    const body = mk('div', 'card-body');
    const rz = mk('div', 'resize');
    rz.title = 'Drag to resize';
    card.append(bar, extra, body, rz);
    grid.append(card);
    els.set(c.id, { card, body, extra, view });

    handle.addEventListener('dragstart', (e) => {
      dragId = c.id;
      card.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* optional */ }
    });
    handle.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); clearMarks(); });
    const after = (e) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === c.id) return;
      e.preventDefault();
      const a = after(e);
      card.classList.toggle('over-after', a);
      card.classList.toggle('over-before', !a);
    });
    card.addEventListener('dragleave', () => card.classList.remove('over-before', 'over-after'));
    card.addEventListener('drop', (e) => {
      if (!dragId || dragId === c.id) return;
      e.preventDefault();
      const id = dragId;
      dragId = null;
      clearMarks();
      const rest = ordered().filter((x) => x.id !== id);
      moveTo(id, rest.indexOf(c) + (after(e) ? 1 : 0));
    });
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
      const colW = (grid.clientWidth - gap * 5) / 6;
      const start = layout()[c.id]?.w || c.w || 3, sx = e.clientX;
      let span = start;
      try { rz.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
      card.classList.add('resizing');
      const move = (ev) => { span = clamp(Math.round(start + (ev.clientX - sx) / (colW + gap)), 2, 6); card.style.gridColumn = 'span ' + span; };
      const up = () => {
        rz.removeEventListener('pointermove', move);
        rz.removeEventListener('pointerup', up);
        rz.removeEventListener('pointercancel', up);
        card.classList.remove('resizing');
        if (span !== start) { patch(c.id, { w: span }); draw(c); }
      };
      rz.addEventListener('pointermove', move);
      rz.addEventListener('pointerup', up);
      rz.addEventListener('pointercancel', up);
    });
  }
  function clearMarks() { for (const x of grid.querySelectorAll('.over-before, .over-after')) x.classList.remove('over-before', 'over-after'); }

  apply();
  rerenderAll();

  // redraw a card when its width changes (window resized, menu collapsed)
  const widths = new Map();
  const ro = new ResizeObserver((entries) => {
    for (const en of entries) {
      const id = en.target.closest('.card').dataset.id;
      const w = Math.round(en.contentRect.width);
      const prev = widths.get(id);
      widths.set(id, w);
      if (prev !== undefined && Math.abs(prev - w) > 24) { const c = cards.find((x) => x.id === id); clearTimeout(en.target._t); en.target._t = setTimeout(() => draw(c), 150); }
    }
  });
  for (const e of els.values()) ro.observe(e.body);
  return { rerenderAll, destroy: () => ro.disconnect() };
}
