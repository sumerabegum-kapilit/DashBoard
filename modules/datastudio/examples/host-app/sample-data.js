// Sample data for the example host application (and the module's tests): a small shop, seeded so it is
// the same on every start, ending today. Some foreign keys are declared, as a database would report them;
// others (order lines) are left for the module to find and offer for review.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

function shop(today = new Date().toISOString().slice(0, 10)) {
  const r = rng(99);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const end = Date.parse(today + 'T23:59:00Z'), start = end - 540 * DAY;
  const regions = ['North', 'South', 'East', 'West'];
  const customers = Array.from({ length: 300 }, (_, i) => ({ customer_id: `C${1000 + i}`, name: `${pick(['Blue', 'Green', 'Swift', 'Prime', 'Clear', 'North'])}${pick(['leaf', 'stone', 'wave', 'path'])} ${pick(['Ltd', 'Group', 'Labs', 'Retail'])} ${i}`, segment: pick(['Enterprise', 'Mid-market', 'Small business', 'Small business']), region: pick(regions), joined_on: stamp(start - r() * 400 * DAY).slice(0, 10) }));
  const cats = ['Laptops', 'Monitors', 'Accessories', 'Software', 'Services'];
  const products = Array.from({ length: 40 }, (_, i) => { const c = cats[i % 5]; const price = Math.round((c === 'Laptops' ? 900 : c === 'Monitors' ? 250 : c === 'Software' ? 80 : c === 'Services' ? 150 : 40) * (0.7 + r() * 0.8)); return { product_id: `P${100 + i}`, product_name: `${c.slice(0, -1)} ${i}`, category: c, list_price: price }; });
  const orders = [], lines = [];
  for (let i = 0; i < 2500; i++) {
    const at = start + Math.pow(r(), 0.8) * (end - start);
    const c = pick(customers);
    const status = end - at < 3 * DAY ? pick(['Placed', 'Shipped']) : pick(['Delivered', 'Delivered', 'Delivered', 'Delivered', 'Returned', 'Cancelled']);
    const id = `O${50000 + i}`;
    let total = 0;
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const p = pick(products), qty = 1 + Math.floor(r() * (c.segment === 'Enterprise' ? 10 : 3));
      const amount = Math.round(p.list_price * qty * (1 - (c.segment === 'Enterprise' ? 0.1 : 0)) * 100) / 100;
      total += amount;
      lines.push({ line_id: `${id}-${k + 1}`, order_id: id, product_id: p.product_id, quantity: qty, amount });
    }
    orders.push({ order_id: id, customer_id: c.customer_id, ordered_at: stamp(at), status, channel: pick(['Online', 'Online', 'Partner', 'Direct']), total: Math.round(total * 100) / 100, paid: status !== 'Cancelled' });
  }
  orders.sort((a, b) => a.ordered_at.localeCompare(b.ordered_at));
  return { customers, products, orders, order_lines: lines };
}

// The metadata a host would read from its database: names, types, keys, the foreign keys it declares.
const shopTables = [
  { name: 'customers', primaryKey: 'customer_id', columns: [{ name: 'customer_id', type: 'varchar' }, { name: 'name', type: 'varchar' }, { name: 'segment', type: 'varchar' }, { name: 'region', type: 'varchar' }, { name: 'joined_on', type: 'date' }] },
  { name: 'products', primaryKey: 'product_id', columns: [{ name: 'product_id', type: 'varchar' }, { name: 'product_name', type: 'varchar' }, { name: 'category', type: 'varchar' }, { name: 'list_price', type: 'numeric', format: 'money' }] },
  {
    name: 'orders', primaryKey: 'order_id', dateColumn: 'ordered_at',
    columns: [{ name: 'order_id', type: 'varchar' }, { name: 'customer_id', type: 'varchar' }, { name: 'ordered_at', type: 'timestamp' }, { name: 'status', type: 'varchar' }, { name: 'channel', type: 'varchar' }, { name: 'total', type: 'numeric', format: 'money' }, { name: 'paid', type: 'boolean' }],
    foreignKeys: [{ column: 'customer_id', references: { table: 'customers', column: 'customer_id' } }],
  },
  // no foreign keys declared here: the module finds order_id and product_id and offers them for review
  { name: 'order_lines', label: 'Order lines', primaryKey: 'line_id', dateColumn: 'order_id.ordered_at', columns: [{ name: 'line_id', type: 'varchar' }, { name: 'order_id', type: 'varchar' }, { name: 'product_id', type: 'varchar' }, { name: 'quantity', type: 'integer' }, { name: 'amount', type: 'numeric', format: 'money' }] },
];

module.exports = { shop, shopTables };
