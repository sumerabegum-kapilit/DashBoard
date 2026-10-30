// Headline numbers and the health rings.
import { d3, mk, fInt, f1, fPct, fChg } from './util.js';

const TILES = [
  ['completed', 'Completed', 'int', 'up', '#1d4ed8'],
  ['created', 'Created', 'int', null, '#2563eb'],
  ['points', 'Story points done', 'int', 'up', '#1e40af'],
  ['cycle_hours', 'Median cycle time (h)', 'dec', 'down', '#0369a1'],
  ['hours', 'Hours logged', 'int', null, '#0e7490'],
  ['open_now', 'Open now', 'int', null, '#1e3a8a'],
  ['overdue', 'Overdue now', 'int', null, '#b91c1c'],
  ['urgent', 'Critical or high, open', 'int', null, '#334155'],
];

export function kpiTiles(host, data, showChange) {
  host.replaceChildren();
  for (const [key, label, fmt, good, color] of TILES) {
    const tile = mk('div', 'kpi');
    tile.style.setProperty('--k', color);
    const v = data.kpis[key];
    tile.append(mk('span', 'kpi-label', label), mk('span', 'kpi-num', v == null ? '—' : fmt === 'dec' ? f1(v) : fInt(v)));
    const prev = data.kpis[key + '_prev'];
    if (showChange && prev !== undefined) {
      const chg = prev ? (v - prev) / prev : null;
      const line = mk('span', 'kpi-chg');
      const chip = mk('b', null, chg == null ? 'new' : fChg(chg));
      if (chg) chip.classList.add(good ? ((good === 'up' ? chg > 0 : chg < 0) ? 'good' : 'bad') : 'plain');
      line.append(chip, document.createTextNode(' vs previous period'));
      tile.append(line);
    }
    host.append(tile);
  }
}

// Good at 80% or more, watch from 50%, risk below.
const RINGS = [['on_time_share', 'On time'], ['owned_share', 'Has an owner'], ['estimated_share', 'Estimated'], ['ready_share', 'Ready to start']];
export function healthRings(host, data) {
  host.replaceChildren();
  const wrap = mk('div', 'health');
  host.append(wrap);
  for (const [key, label] of RINGS) {
    const v = data.health[key];
    const [word, color] = v == null ? ['', 'var(--muted-fill)'] : v >= 0.8 ? ['Good', 'var(--ok)'] : v >= 0.5 ? ['Watch', 'var(--warn)'] : ['Risk', 'var(--bad)'];
    const fig = mk('figure', 'gauge');
    const S = 112, R = 50;
    const svg = d3.select(fig).append('svg').attr('width', S).attr('height', S).attr('viewBox', `0 0 ${S} ${S}`).attr('role', 'img').attr('aria-label', `${label}: ${v == null ? 'no data' : fPct(v)}`);
    const arc = d3.arc().innerRadius(R - 10).outerRadius(R).startAngle(0).cornerRadius(5);
    const g = svg.append('g').attr('transform', `translate(${S / 2},${S / 2})`);
    g.append('path').attr('class', 'ring-bg').attr('d', arc({ endAngle: 2 * Math.PI }));
    if (v != null) g.append('path').style('fill', color).attr('d', arc({ endAngle: 2 * Math.PI * Math.min(1, Math.max(0.005, v)) }));
    g.append('text').attr('class', 'ring-num').attr('text-anchor', 'middle').attr('dy', '0.15em').text(v == null ? '—' : fPct(v));
    if (word) g.append('text').attr('class', 'ring-state').attr('text-anchor', 'middle').attr('dy', '1.75em').style('fill', color).text(word);
    fig.append(mk('figcaption', null, label));
    wrap.append(fig);
  }
}
