// Reads the period, time step and project from a request.
const { GRAINS } = require('./sql');

const DAY = 864e5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function autoGrain(from, to) {
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : days <= 730 ? 'month' : 'quarter';
}

function readWindow(q, meta) {
  let from = DATE.test(q.from || '') ? q.from : meta.minDate;
  let to = DATE.test(q.to || '') ? q.to : meta.asOf;
  if (from > to) [from, to] = [to, from];
  const grain = GRAINS.includes(q.grain) ? q.grain : autoGrain(from, to);
  const project = UUID.test(q.project || '') ? q.project : null;
  return { from, to, grain, project, asOf: meta.asOf };
}

module.exports = { readWindow, autoGrain, DATE, UUID };
