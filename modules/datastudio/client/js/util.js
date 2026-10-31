// Shared helpers: formats, colours, DOM.
export const d3 = window.d3;

export const fInt = d3.format(',');
export const f1 = d3.format(',.1f');
export const fPct = d3.format('.0%');
export const fChg = d3.format('+.0%');
export const fCompact = (v) => (Math.abs(v) >= 10000 ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : fInt(Math.round(v * 10) / 10));
export const fmtOf = (kind) => {
  if (kind === 'hours') return (v) => fInt(Math.round(v)) + ' h';
  if (kind === 'pct') return fPct;
  if (kind === 'dec') return (v) => f1(v);
  return (v) => (Number.isInteger(v) ? fInt(v) : f1(v));
};

export const parseDay = (s) => new Date(s + 'T00:00:00Z');
export const isoDay = (d) => d.toISOString().slice(0, 10);
const fDay = d3.utcFormat('%b %-d');
const fMonth = d3.utcFormat('%b %Y');
export const fFull = d3.utcFormat('%b %-d, %Y');
const quarter = (d) => 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
export const tickFor = (grain) => (k) => {
  const d = parseDay(k);
  return grain === 'year' ? String(d.getUTCFullYear()) : grain === 'quarter' ? quarter(d) : grain === 'month' ? fMonth(d) : fDay(d);
};
export const titleFor = (grain) => (k) => (grain === 'week' ? 'Week of ' + fFull(parseDay(k)) : grain === 'day' ? fFull(parseDay(k)) : tickFor(grain)(k));

// Names from the database shown as words: user_story -> User story
export const pretty = (s) => {
  if (s == null) return '—';
  const t = String(s).replace(/[._]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const PRETTY_DIMS = ['priority', 'type', 'role', 'action', 'area', 'dimension', 'rating', 'overdue', 'done'];
export const labelFor = (dim, name) => (PRETTY_DIMS.includes(dim) ? pretty(name) : name);

// Colours: one blue family, red only for problems. Variables have light and dark values in app.css.
export const C = (i) => `var(--c${((i % 8) + 8) % 8})`;
export const MUTED = 'var(--muted-fill)';
const FIXED = {
  status: { 'To Do': 0, 'In Progress': 3, 'In Review': 6, Blocked: 7, Done: 2 },
  priority: { critical: 7, high: 2, medium: 0, low: 6 },
  type: { task: 0, user_story: 1, bug: 7, epic: 4, sub_task: 3, technical_story: 5, spike: 6 },
  column: { Backlog: 0, 'In Progress': 3, 'In Review': 6, Done: 2 },
  sprint_status: { Future: 0, Active: 3, 'Active, past end date': 7, Closed: 2 },
};
const SEMANTIC = {
  overdue: { overdue: 'var(--bad)', on_time: C(0) },
  done: { done: C(2), not_done: MUTED },
  rating: { met: 'var(--ok)', partially_met: 'var(--warn)', not_met: 'var(--bad)' },
};
export function colorFor(dim, name, i) {
  if (name === '__other' || name === 'Other') return MUTED;
  if (SEMANTIC[dim] && SEMANTIC[dim][name]) return SEMANTIC[dim][name];
  if (FIXED[dim] && FIXED[dim][name] !== undefined) return C(FIXED[dim][name]);
  return C(i);
}

export function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
export function button(text, cls, onClick, label) {
  const b = mk('button', cls || 'btn', text);
  b.type = 'button';
  if (label) { b.title = label; b.setAttribute('aria-label', label); }
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function selectBox(options, value, onChange, opts = {}) {
  const s = document.createElement('select');
  if (opts.label) s.setAttribute('aria-label', opts.label);
  if (opts.blank !== undefined) s.append(new Option(opts.blank, ''));
  for (const o of options) {
    if (o.group) {
      const g = document.createElement('optgroup');
      g.label = o.group;
      for (const [v, t] of o.items) g.append(new Option(t, v));
      s.append(g);
    } else {
      const opt = new Option(o[1], o[0]);
      if (opts.disabled && opts.disabled(o[0])) opt.disabled = true;
      s.append(opt);
    }
  }
  s.value = value == null ? '' : String(value);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
export function field(label, control) {
  const l = mk('label', 'field');
  l.append(mk('span', 'field-label', label), control);
  return l;
}
// The element the studio is mounted in; set by mount(). Everything the studio shows lives inside it.
export const ui = { root: document };
export function toast(text) {
  const t = ui.root.querySelector('#ds-toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
