const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Reads KEY=VALUE lines from .env (values already set in the environment win).
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(ROOT, '.env'));

const asOf = process.env.AS_OF || '';
if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('AS_OF must look like 2026-10-29');
const timezone = process.env.APP_TIMEZONE || 'Asia/Kolkata';
if (!/^[A-Za-z_+\-/0-9]+$/.test(timezone)) throw new Error('APP_TIMEZONE is not a valid time zone name');
const maxEntryMinutes = Number(process.env.MAX_ENTRY_MINUTES || 720);
if (!Number.isInteger(maxEntryMinutes) || maxEntryMinutes <= 0) throw new Error('MAX_ENTRY_MINUTES must be a whole number of minutes');

module.exports = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://scrum:scrum123@localhost:5432/scrum',
  timezone,
  maxEntryMinutes,
  asOf: asOf || null,
  stateFile: path.resolve(ROOT, process.env.STATE_FILE || 'storage/state.json'),
  // largest file people can upload, in MB
  maxUploadMb: Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 2048),
};
