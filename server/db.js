const { Pool, types } = require('pg');
const config = require('./config');

// Dates stay as 'YYYY-MM-DD' text; numeric and bigint (counts) become numbers.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // Every session counts dates in the app's time zone and is read-only, so the dashboard can never change data.
  options: `-c timezone=${config.timezone} -c default_transaction_read_only=on -c statement_timeout=30000`,
});

pool.on('error', (err) => console.error('Database connection error:', err.message));

async function query(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

module.exports = { pool, query };
