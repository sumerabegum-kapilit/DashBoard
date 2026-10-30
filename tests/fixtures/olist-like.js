// Files shaped like the Kaggle "Brazilian E-Commerce Public Dataset by Olist": several CSV files whose
// keys are named after the table (customer_id, order_id ...), never "id", with shared prefixes and suffixes
// in the file names, a two-column key (order items), and zip codes shared by several tables (many-to-many).
// Small and seeded, for tests.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const csv = (head, rows) => [head.join(','), ...rows.map((r) => r.map((v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';

function olistLike(n = 400) {
  const r = rng(7);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const hex = (i, p) => (p + i.toString(16).padStart(8, '0') + 'a1b2c3d4e5f60718').slice(0, 32);
  const zips = Array.from({ length: 60 }, (_, i) => 1000 + i * 37);
  const states = ['SP', 'RJ', 'MG', 'RS', 'PR', 'BA'];
  const cats = ['beleza_saude', 'informatica_acessorios', 'esporte_lazer', 'moveis_decoracao', 'utilidades_domesticas'];
  const customers = Array.from({ length: Math.round(n * 0.8) }, (_, i) => [hex(i, 'c'), hex(i, 'u'), pick(zips), pick(['sao paulo', 'rio de janeiro', 'curitiba']), pick(states)]);
  const sellers = Array.from({ length: 40 }, (_, i) => [hex(i, 's'), pick(zips), pick(['campinas', 'santos']), pick(states)]);
  const products = Array.from({ length: 120 }, (_, i) => [hex(i, 'p'), pick(cats), 20 + Math.floor(r() * 60), Math.floor(r() * 5000)]);
  const orders = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2017, 0, 1) + Math.floor(r() * 600) * 864e5 + Math.floor(r() * 86400) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    return [hex(i, 'o'), pick(customers)[0], pick(['delivered', 'delivered', 'delivered', 'shipped', 'canceled']), d];
  });
  const items = [], payments = [], reviews = [];
  for (const o of orders) {
    const k = 1 + Math.floor(r() * 3);
    for (let j = 1; j <= k; j++) items.push([o[0], j, pick(products)[0], pick(sellers)[0], (10 + r() * 300).toFixed(2), (5 + r() * 30).toFixed(2)]);
    payments.push([o[0], 1, pick(['credit_card', 'boleto', 'voucher']), 1 + Math.floor(r() * 10), (20 + r() * 500).toFixed(2)]);
    if (r() < 0.9) reviews.push([hex(reviews.length, 'r'), o[0], 1 + Math.floor(r() * 5), r() < 0.3 ? 'Muito bom, "recomendo"' : '']);
  }
  const geo = [];
  for (const z of zips) for (let k = 0; k < 3; k++) geo.push([z, (-23 + r()).toFixed(5), (-46 + r()).toFixed(5), pick(['sao paulo', 'campinas']), pick(states)]);
  return {
    'olist_customers_dataset.csv': csv(['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'], customers),
    'olist_sellers_dataset.csv': csv(['seller_id', 'seller_zip_code_prefix', 'seller_city', 'seller_state'], sellers),
    'olist_products_dataset.csv': csv(['product_id', 'product_category_name', 'product_name_lenght', 'product_weight_g'], products),
    'olist_orders_dataset.csv': csv(['order_id', 'customer_id', 'order_status', 'order_purchase_timestamp'], orders),
    'olist_order_items_dataset.csv': csv(['order_id', 'order_item_id', 'product_id', 'seller_id', 'price', 'freight_value'], items),
    'olist_order_payments_dataset.csv': csv(['order_id', 'payment_sequential', 'payment_type', 'payment_installments', 'payment_value'], payments),
    'olist_order_reviews_dataset.csv': csv(['review_id', 'order_id', 'review_score', 'review_comment_message'], reviews),
    'olist_geolocation_dataset.csv': csv(['geolocation_zip_code_prefix', 'geolocation_lat', 'geolocation_lng', 'geolocation_city', 'geolocation_state'], geo),
    'product_category_name_translation.csv': csv(['product_category_name', 'product_category_name_english'], cats.map((c) => [c, c.replace(/_/g, ' ')])),
  };
}

module.exports = { olistLike };
