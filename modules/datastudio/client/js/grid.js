// A 12-column board. Widgets are placed in order and packed densely so gaps fill up;
// in edit mode they can be dragged to a new place and resized in width and height from the corner.
import { mk } from './core.js';

export const COLS = 12;
export const ROW = 64; // px per height unit; keep in step with --row in studio.css
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// opts: { widgets, editing, mountWidget(w, el) -> { redraw }, onMove(fromId, toIndex), onResize(id, w, h) }
export function mountGrid(host, opts) {
  const grid = mk('div', 'grid' + (opts.editing ? ' editing' : ''));
  host.replaceChildren(grid);
  const cards = new Map();
  let dragId = null;

  opts.widgets.forEach((w, index) => {
    const el = mk('article', 'widget');
    el.dataset.id = w.id;
    el.style.gridColumn = `span ${clamp(w.w || 4, 1, COLS)}`;
    el.style.gridRow = `span ${clamp(w.h || 4, 1, 16)}`;
    grid.append(el);
    const api = opts.mountWidget(w, el, index);
    cards.set(w.id, { el, api });

    if (!opts.editing) return;
    const handle = el.querySelector('.w-head');
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      dragId = w.id;
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* optional */ }
    });
    handle.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearMarks(); });
    const after = (e) => { const r = el.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
    el.addEventListener('dragover', (e) => {
      if (!dragId || dragId === w.id) return;
      e.preventDefault();
      const a = after(e);
      el.classList.toggle('drop-after', a);
      el.classList.toggle('drop-before', !a);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!dragId || dragId === w.id) return;
      e.preventDefault();
      const id = dragId;
      const others = opts.widgets.filter((x) => x.id !== id);
      const to = others.findIndex((x) => x.id === w.id) + (after(e) ? 1 : 0);
      dragId = null;
      clearMarks();
      opts.onMove(id, to);
    });

    const rz = mk('div', 'w-resize');
    rz.title = 'Drag to resize';
    el.append(rz);
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
      const rowGap = parseFloat(getComputedStyle(grid).rowGap) || 12;
      const colW = (grid.clientWidth - gap * (COLS - 1)) / COLS;
      const sw = clamp(w.w || 4, 1, COLS), sh = clamp(w.h || 4, 1, 16), sx = e.clientX, sy = e.clientY;
      let nw = sw, nh = sh;
      const tip = mk('span', 'size-tip', `${sw} × ${sh}`);
      el.append(tip);
      try { rz.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
      el.classList.add('resizing');
      const move = (ev) => {
        nw = clamp(Math.round(sw + (ev.clientX - sx) / (colW + gap)), 1, COLS);
        nh = clamp(Math.round(sh + (ev.clientY - sy) / (ROW + rowGap)), 1, 16);
        el.style.gridColumn = `span ${nw}`;
        el.style.gridRow = `span ${nh}`;
        tip.textContent = `${nw} × ${nh}`;
      };
      const up = () => {
        rz.removeEventListener('pointermove', move);
        rz.removeEventListener('pointerup', up);
        rz.removeEventListener('pointercancel', up);
        el.classList.remove('resizing');
        tip.remove();
        if (nw !== sw || nh !== sh) {
          // the next resize of this widget starts from its new size
          w.w = nw;
          w.h = nh;
          opts.onResize(w.id, nw, nh);
        }
      };
      rz.addEventListener('pointermove', move);
      rz.addEventListener('pointerup', up);
      rz.addEventListener('pointercancel', up);
    });
  });
  function clearMarks() { for (const x of grid.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after'); }

  // Redraw a widget when its size changes (window resized, menu collapsed, widget resized).
  // The widget box is watched, not its body: the body changes width when a scrollbar comes and goes,
  // and redrawing on that would loop. Changes smaller than a scrollbar are ignored.
  const sizes = new Map();
  const ro = new ResizeObserver((entries) => {
    for (const en of entries) {
      const card = en.target;
      if (!card.isConnected) continue; // replaced while being edited
      const id = card.dataset.id;
      const now = { w: en.contentRect.width, h: en.contentRect.height };
      const prev = sizes.get(id);
      if (!prev) { sizes.set(id, now); continue; }
      if (Math.abs(prev.w - now.w) < 24 && Math.abs(prev.h - now.h) < 24) continue;
      sizes.set(id, now);
      clearTimeout(card._t);
      card._t = setTimeout(() => cards.get(id) && cards.get(id).api.redraw(), 160);
    }
  });
  for (const { el } of cards.values()) ro.observe(el);
  return { destroy: () => ro.disconnect(), cards };
}
