// "My dashboard": saved views pinned as cards that can be dragged, resized, redrawn or removed.
import { read, write } from './state.js';
import { mk, button } from './util.js';
import { mountBoard } from './cards.js';
import { render, VIEWS } from './render.js';
import { loadModel, getSaved, runSpec, drawResult, payloadOf, describe, selection, recordsPanel, CHARTS } from './viewbuilder.js';

VIEWS.builder = CHARTS;

export async function mountMine(host) {
  host.replaceChildren(mk('p', 'empty', 'Loading…'));
  try { await loadModel(); } catch (e) { host.replaceChildren(mk('p', 'error', e.message)); return; }
  const views = getSaved();
  const board = read('board', []).filter((b) => views.some((v) => v.id === b.id));
  host.replaceChildren();
  if (!board.length) {
    const box = mk('section', 'card empty-board');
    box.append(mk('h3', null, 'Nothing pinned yet'), mk('p', 'note', 'Open Build a view, make or open a view, and press "Add to My dashboard". It will appear here as a card you can drag, resize and redraw.'),
      button('Go to Build a view', 'btn primary', () => { location.hash = 'build'; }));
    host.append(box);
    return;
  }
  const boardHost = mk('div');
  const drill = mk('div');
  host.append(boardHost, drill);
  const cards = board.map((b) => {
    const v = views.find((x) => x.id === b.id);
    return { id: b.id, title: v.title || describe(v), w: b.w || 3, views: 'builder', view: v.chart, spec: v };
  });
  const layoutOf = () => read('cards', {}).mine;
  mountBoard(boardHost, {
    cards,
    getLayout: layoutOf,
    setLayout: (l) => write('cards', { ...read('cards', {}), mine: l }),
    removeLabel: 'Remove from My dashboard',
    onRemove: (c) => { write('board', read('board', []).filter((b) => b.id !== c.id)); mountMine(host); },
    renderBody: async (c, body, extra, s) => {
      const spec = { ...c.spec, chart: s.v || c.spec.chart };
      body.classList.add('loading');
      try {
        const res = await runSpec(spec);
        const pick = (p) => {
          const sel = selection(res, spec, p);
          let page = 1;
          const show = () => recordsPanel(drill, spec, sel, page, (n) => { page = n; show(); }, () => drill.replaceChildren())
            .then((panel) => panel && panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
          show();
        };
        if (spec.chart === 'table') {
          const data = payloadOf(res);
          if (data) render(body, data, 'table', { onPick: (p) => pick(data.kind === 'time' ? { index: p.index } : { group: p.name }) });
          else body.replaceChildren(mk('p', 'empty', 'Pick a grouping for this view in Build a view.'));
        } else drawResult(body, res, spec, pick);
      } catch (e) {
        body.replaceChildren(mk('p', 'error', e.message));
      } finally {
        body.classList.remove('loading');
      }
    },
  });
}
