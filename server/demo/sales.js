// Dummy sales data: orders, order lines, products, customers and sales reps over the last two years.
const { rng, isoDay, msOf, todayUtc, personName, companyNames } = require('./rand');

const DAY = 864e5;
const CATALOG = {
  Laptops: [['Aero 13', 1099], ['Aero 15 Pro', 1699], ['Workmate 14', 849], ['Studio X', 2399]],
  Monitors: [['View 24', 189], ['View 27 QHD', 329], ['Ultra 34', 649]],
  Accessories: [['Dock USB-C', 149], ['Wireless mouse', 39], ['Mech keyboard', 119], ['Laptop sleeve', 29], ['Headset Pro', 99], ['Webcam 4K', 129]],
  Phones: [['Pulse 6', 699], ['Pulse 6 Max', 999], ['Pulse Lite', 399]],
  Software: [['Office suite (1 yr)', 99], ['Security plus (1 yr)', 59], ['Cloud backup (1 yr)', 79]],
  Services: [['Setup service', 149], ['Extended warranty', 199], ['On-site repair', 249]],
};
const BRANDS = { Laptops: 'Northwind', Monitors: 'Clearview', Accessories: 'Kitbag', Phones: 'Pulse', Software: 'Shieldsoft', Services: 'CareCo' };
const MARGIN = { Laptops: 0.18, Monitors: 0.22, Accessories: 0.45, Phones: 0.2, Software: 0.75, Services: 0.6 };
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];

function generate(today = todayUtc()) {
  const r = rng(424242);
  const end = msOf(today + ' 00:00');
  const days = 730;
  const start = end - (days - 1) * DAY;

  const products = [];
  for (const [cat, list] of Object.entries(CATALOG)) {
    for (const [name, price] of list) {
      products.push({ id: products.length + 1, name, category: cat, brand: BRANDS[cat], list_price: price, unit_cost: Math.round(price * (1 - MARGIN[cat]) * (0.95 + r.next() * 0.1)), launched: isoDay(new Date(start - r.int(-400, 600) * DAY)) });
    }
  }
  const reps = Array.from({ length: 18 }, (_, i) => ({ id: i + 1, name: personName(r), region: REGIONS[i % 5], team: i % 3 === 0 ? 'Enterprise' : i % 3 === 1 ? 'Mid-market' : 'Inside sales', quota: r.int(40, 120) * 10000, hired_on: isoDay(new Date(start - r.int(-200, 1500) * DAY)) }));
  const names = companyNames(r, 520);
  const customers = names.map((name, i) => ({ id: i + 1, name, type: r.weighted([['Business', 6], ['Education', 2], ['Government', 1], ['Consumer', 3]]), region: r.pick(REGIONS), city: r.pick(['Springfield', 'Riverton', 'Lakeside', 'Hillcrest', 'Fairview', 'Oakridge', 'Maplewood', 'Bayview']), since: isoDay(new Date(start - r.int(-500, 1200) * DAY)), loyalty: r.weighted([['Bronze', 5], ['Silver', 3], ['Gold', 1.5], ['Platinum', 0.5]]) }));

  const orders = [], lines = [];
  for (let d = 0; d < days; d++) {
    const dayMs = start + d * DAY;
    const date = new Date(dayMs);
    const wd = date.getUTCDay(), month = date.getUTCMonth();
    const season = 1 + (month === 10 ? 0.5 : month === 11 ? 0.7 : month === 7 ? 0.25 : 0) + 0.25 * (d / days);
    const n = r.poisson(5.2 * season * (wd === 0 ? 0.5 : wd === 6 ? 0.8 : 1));
    for (let i = 0; i < n; i++) {
      const customer = r.pick(customers);
      const rep = r.chance(0.8) ? r.pick(reps.filter((x) => x.region === customer.region)) : r.pick(reps);
      const channel = customer.type === 'Consumer' ? r.weighted([['Online', 7], ['Retail store', 4]]) : r.weighted([['Direct sales', 6], ['Online', 3], ['Partner', 2]]);
      const age = (end - dayMs) / DAY;
      let status = r.weighted([['Delivered', 85], ['Returned', 5], ['Cancelled', 4]]);
      if (age < 3) status = r.weighted([['Placed', 3], ['Shipped', 2]]);
      else if (age < 7 && status === 'Delivered') status = r.weighted([['Shipped', 1], ['Delivered', 2]]);
      const discount = customer.type === 'Business' || customer.type === 'Government' ? r.weighted([[0, 4], [0.05, 3], [0.1, 2], [0.15, 1]]) : r.weighted([[0, 7], [0.05, 2], [0.2, 1]]);
      const id = orders.length + 1;
      let revenue = 0, cost = 0;
      const nLines = 1 + r.poisson(customer.type === 'Consumer' ? 0.6 : 1.6);
      for (let k = 0; k < nLines; k++) {
        const p = r.weighted(products.map((x) => [x, x.category === 'Accessories' ? 3 : x.category === 'Services' ? 1 : 1.5]));
        const qty = customer.type === 'Consumer' ? 1 : r.weighted([[1, 5], [2, 3], [5, 2], [10, 1], [25, 0.4]]);
        const price = Math.round(p.list_price * (1 - discount) * 100) / 100;
        const lineRevenue = Math.round(price * qty * 100) / 100;
        const lineCost = p.unit_cost * qty;
        revenue += lineRevenue; cost += lineCost;
        lines.push({ id: lines.length + 1, order_id: id, product_id: p.id, quantity: qty, unit_price: price, revenue: lineRevenue, cost: lineCost, margin: Math.round((lineRevenue - lineCost) * 100) / 100 });
      }
      orders.push({
        id, number: 'SO-' + (50000 + id), order_date: isoDay(date), customer_id: customer.id, rep_id: rep.id, channel, status,
        payment: r.weighted([['Card', 5], ['Invoice', customer.type === 'Consumer' ? 0 : 5], ['Bank transfer', 2], ['Wallet', 2]]),
        discount_pct: discount * 100, revenue: Math.round(revenue * 100) / 100, gross_margin: Math.round((revenue - cost) * 100) / 100,
        ship_days: status === 'Cancelled' || status === 'Placed' ? null : Math.max(1, Math.round(r.logNormal(channel === 'Retail store' ? 1 : 3, 0.5))),
      });
    }
  }
  return { products, reps, customers, orders, lines };
}

const schema = {
  id: 'sales',
  label: 'Sales (dummy data)',
  description: 'Two years of orders for an electronics seller: order lines, products, customers and sales reps.',
  tables: {
    orders: {
      label: 'Orders', display: 'number', date: 'order_date',
      fields: {
        number: { label: 'Order number' }, order_date: { label: 'Order date', type: 'date' }, channel: { label: 'Channel' }, status: { label: 'Status' }, payment: { label: 'Payment method' },
        discount_pct: { label: 'Discount %', type: 'number', format: 'int' }, revenue: { label: 'Revenue', type: 'number', format: 'money' },
        gross_margin: { label: 'Gross margin', type: 'number', format: 'money' }, ship_days: { label: 'Days to ship', type: 'number', format: 'dec' },
      },
    },
    lines: {
      label: 'Order lines', display: null, date: 'order_id.order_date',
      fields: { quantity: { label: 'Quantity', type: 'number', format: 'int' }, unit_price: { label: 'Unit price', type: 'number', format: 'money' }, revenue: { label: 'Line revenue', type: 'number', format: 'money' }, cost: { label: 'Line cost', type: 'number', format: 'money' }, margin: { label: 'Line margin', type: 'number', format: 'money' } },
    },
    products: { label: 'Products', display: 'name', date: 'launched', fields: { name: { label: 'Product' }, category: { label: 'Category' }, brand: { label: 'Brand' }, list_price: { label: 'List price', type: 'number', format: 'money' }, unit_cost: { label: 'Unit cost', type: 'number', format: 'money' }, launched: { label: 'Launched', type: 'date' } } },
    customers: { label: 'Customers', display: 'name', date: 'since', fields: { name: { label: 'Customer' }, type: { label: 'Customer type' }, region: { label: 'Region' }, city: { label: 'City' }, loyalty: { label: 'Loyalty tier' }, since: { label: 'Customer since', type: 'date' } } },
    reps: { label: 'Sales reps', display: 'name', date: 'hired_on', fields: { name: { label: 'Sales rep' }, region: { label: 'Region' }, team: { label: 'Team' }, quota: { label: 'Yearly quota', type: 'number', format: 'money' }, hired_on: { label: 'Hired', type: 'date' } } },
  },
  links: [
    { from: 'orders', col: 'customer_id', to: 'customers', name: 'Customer' },
    { from: 'orders', col: 'rep_id', to: 'reps', name: 'Sales rep' },
    { from: 'lines', col: 'order_id', to: 'orders', name: 'Order' },
    { from: 'lines', col: 'product_id', to: 'products', name: 'Product' },
  ],
  rollups: [
    { table: 'orders', col: 'units', label: 'Units in order', from: 'lines', via: 'order_id', fn: 'sum', field: 'quantity', format: 'int' },
    { table: 'products', col: 'units_sold', label: 'Units sold', from: 'lines', via: 'product_id', fn: 'sum', field: 'quantity', format: 'int' },
    { table: 'products', col: 'revenue', label: 'Revenue', from: 'lines', via: 'product_id', fn: 'sum', field: 'revenue', format: 'money' },
    { table: 'customers', col: 'revenue', label: 'Revenue', from: 'orders', via: 'customer_id', fn: 'sum', field: 'revenue', format: 'money' },
    { table: 'reps', col: 'revenue', label: 'Revenue sold', from: 'orders', via: 'rep_id', fn: 'sum', field: 'revenue', format: 'money' },
  ],
};

module.exports = { schema, generate };
