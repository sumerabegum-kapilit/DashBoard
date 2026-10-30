// Seeded random numbers, so the dummy data is the same on every start.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    // [[value, weight], ...]
    weighted: (pairs) => {
      const total = pairs.reduce((s, p) => s + p[1], 0);
      let x = next() * total;
      for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; }
      return pairs[pairs.length - 1][0];
    },
    normal: (mean = 0, sd = 1) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    logNormal: (median, spread) => median * Math.exp(spread * r.normal()),
    poisson: (lambda) => { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= next(); } while (p > L); return k - 1; },
  };
  return r;
}

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => d.toISOString().slice(0, 10);
const stampOf = (ms) => { const d = new Date(ms); return `${isoDay(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const msOf = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
const todayUtc = () => isoDay(new Date());

const FIRST = ['Aarav', 'Maya', 'Liam', 'Priya', 'Noah', 'Sofia', 'Ethan', 'Zara', 'Lucas', 'Ananya', 'Mateo', 'Chloe', 'Arjun', 'Isla', 'Omar', 'Hana', 'Leo', 'Fatima', 'Kai', 'Elena', 'Ravi', 'Grace', 'Diego', 'Meera', 'Felix', 'Amara', 'Jonas', 'Leila', 'Ivan', 'Nora', 'Sana', 'Theo', 'Yuki', 'Kofi', 'Aisha', 'Marco'];
const LAST = ['Sharma', 'Okafor', 'Silva', 'Nguyen', 'Müller', 'Patel', 'Rossi', 'Kim', 'Haddad', 'Johansson', 'Reddy', 'García', 'Cohen', 'Mensah', 'Tanaka', 'Dubois', 'Iyer', 'Novak', 'Costa', 'Ahmed', 'Brown', 'Kowalski', 'Lopez', 'Rao'];
const personName = (r) => `${r.pick(FIRST)} ${r.pick(LAST)}`;

const CO_A = ['Blue', 'North', 'Bright', 'Silver', 'Green', 'Swift', 'Prime', 'Clear', 'Red', 'Urban', 'Peak', 'Nova', 'Atlas', 'Ever', 'Solid', 'Open', 'True', 'Iron', 'Cloud', 'Sun'];
const CO_B = ['river', 'stone', 'leaf', 'path', 'wave', 'line', 'field', 'bridge', 'gate', 'harbor', 'forge', 'point', 'light', 'works', 'grid', 'nest', 'spring', 'ridge'];
const CO_C = ['Labs', 'Retail', 'Health', 'Logistics', 'Systems', 'Foods', 'Finance', 'Studio', 'Group', 'Partners', 'Energy', 'Learning', 'Motors', 'Media'];
function companyNames(r, n) {
  const seen = new Set();
  const out = [];
  while (out.length < n) {
    const name = `${r.pick(CO_A)}${r.pick(CO_B)} ${r.pick(CO_C)}`;
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

module.exports = { rng, pad, isoDay, stampOf, msOf, todayUtc, personName, companyNames };
