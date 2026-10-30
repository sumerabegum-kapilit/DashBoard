// Dummy helpdesk data: tickets, customers, agents, teams, categories and ticket activity over the last 12 months.
// The numbers hang together: urgent tickets are answered faster, skilled agents resolve sooner,
// slow or late tickets get lower satisfaction, weekends are quiet and volume grows over the year.
const { rng, isoDay, stampOf, msOf, todayUtc, personName, companyNames } = require('./rand');

const HOUR = 36e5;
const DAY = 864e5;

const TEAMS = [['Billing', 'Billing'], ['Technical support', 'Technical'], ['Onboarding', 'Onboarding'], ['Accounts', 'Accounts'], ['Escalations', 'Technical']];
const CATEGORIES = [
  ['Invoice question', 'Billing', 0, 6], ['Refund request', 'Billing', 0, 18], ['Payment failed', 'Billing', 0, 8],
  ['Login problem', 'Technical', 1, 5], ['Bug report', 'Technical', 1, 40], ['Slow performance', 'Technical', 1, 30],
  ['Integration / API', 'Technical', 1, 36], ['Data import', 'Technical', 1, 20],
  ['Access and permissions', 'Account', 3, 6], ['Plan change', 'Account', 3, 10], ['Cancellation', 'Account', 3, 24],
  ['Setup help', 'Product', 2, 12], ['How-to question', 'Product', 2, 4], ['Feature request', 'Product', 2, 60],
];
const SUBJECTS = {
  'Invoice question': ['Invoice shows the wrong amount', 'Need a copy of last invoice', 'VAT number missing on invoice', 'Question about proration'],
  'Refund request': ['Charged twice this month', 'Refund for unused seats', 'Cancelled but still billed'],
  'Payment failed': ['Card declined on renewal', 'Bank transfer not matched', 'Payment page error'],
  'Login problem': ['Cannot log in after reset', 'SSO redirect loops', '2FA code not arriving', 'Account locked'],
  'Bug report': ['Export button does nothing', 'Dashboard shows blank chart', 'Wrong totals in report', 'Error 500 when saving'],
  'Slow performance': ['Pages take 20s to load', 'Search is very slow', 'Timeouts during peak hours'],
  'Integration / API': ['Webhook not firing', 'API returns 429 too often', 'Salesforce sync stopped', 'OAuth token expires early'],
  'Data import': ['CSV import fails at row 1200', 'Dates imported in wrong format', 'Duplicate records after import'],
  'Access and permissions': ['Add a new admin', 'User cannot see project', 'Remove leaver access'],
  'Plan change': ['Upgrade to Business plan', 'Add 20 more seats', 'Switch to annual billing'],
  Cancellation: ['Want to cancel subscription', 'Downgrade at renewal', 'Close our account'],
  'Setup help': ['Help with first workspace', 'Configure email domain', 'Set up team roles'],
  'How-to question': ['How to share a report', 'How to bulk edit', 'How to set reminders', 'Where are audit logs'],
  'Feature request': ['Dark mode please', 'Custom fields on forms', 'More chart types', 'Mobile offline mode'],
};
const PRIORITY = [['Low', 30], ['Medium', 42], ['High', 21], ['Urgent', 7]];
const SLA_HOURS = { Low: 120, Medium: 72, High: 24, Urgent: 8 };
const FIRST_RESPONSE_MIN = { Low: 300, Medium: 150, High: 50, Urgent: 15 };
const SPEED = { Low: 1.3, Medium: 1, High: 0.6, Urgent: 0.35 };
const CHANNELS = [['Email', 38], ['Web form', 24], ['Chat', 22], ['Phone', 11], ['Social media', 5]];
const REGIONS = [['North America', ['United States', 'Canada']], ['Europe', ['Germany', 'United Kingdom', 'France', 'Netherlands', 'Spain']], ['Asia Pacific', ['India', 'Singapore', 'Australia', 'Japan']], ['Latin America', ['Brazil', 'Mexico', 'Chile']], ['Middle East and Africa', ['United Arab Emirates', 'South Africa', 'Nigeria']]];
const INDUSTRIES = ['Software', 'Retail', 'Healthcare', 'Finance', 'Education', 'Manufacturing', 'Logistics', 'Media'];
const PLANS = [['Free', 18, 0], ['Starter', 34, 49], ['Business', 32, 299], ['Enterprise', 16, 1890]];
const LOCATIONS = ['Bengaluru', 'Manila', 'Lisbon', 'Austin', 'Kraków'];

function generate(today = todayUtc()) {
  const r = rng(20261030);
  // "now" is the current moment for today's data, so nothing is resolved in the future
  const end = today === todayUtc() ? Date.now() : msOf(today + ' 23:59');
  const start = msOf(today + ' 00:00') - 364 * DAY;

  const teams = TEAMS.map(([name], i) => ({ id: i + 1, name, manager: personName(r), created_at: isoDay(new Date(start - r.int(200, 900) * DAY)) }));

  const agents = [];
  const levelOf = (t) => (t === 'Escalations' ? 'L3' : r.weighted([['L1', 5], ['L2', 3], ['L3', 1]]));
  teams.forEach((t) => {
    const n = t.name === 'Technical support' ? 8 : t.name === 'Escalations' ? 3 : 5;
    for (let i = 0; i < n; i++) {
      agents.push({
        id: agents.length + 1, name: personName(r), team_id: t.id, level: levelOf(t.name), location: r.pick(LOCATIONS),
        shift: r.weighted([['Morning', 5], ['Afternoon', 4], ['Night', 1]]), hired_on: isoDay(new Date(start - r.int(-200, 1500) * DAY)),
        active: r.chance(0.92), skill: Math.round((0.7 + r.next() * 0.7) * 100) / 100,
      });
    }
  });

  const categories = CATEGORIES.map(([name, group, team, base], i) => ({ id: i + 1, name, group, team_id: team + 1, typical_hours: base }));

  const names = companyNames(r, 420);
  const customers = names.map((name, i) => {
    const [region, countries] = r.weighted(REGIONS.map((x, k) => [x, [34, 30, 22, 8, 6][k]]));
    const plan = r.weighted(PLANS.map((p) => [p, p[1]]));
    const seats = plan[0] === 'Enterprise' ? r.int(150, 2000) : plan[0] === 'Business' ? r.int(20, 200) : plan[0] === 'Starter' ? r.int(3, 25) : r.int(1, 3);
    return {
      id: i + 1, name, region, country: r.pick(countries), industry: r.pick(INDUSTRIES), plan: plan[0],
      segment: seats >= 200 ? 'Enterprise' : seats >= 25 ? 'Mid-market' : 'Small business', seats,
      monthly_revenue: plan[2] ? Math.round(plan[2] * Math.max(1, seats / 10) * (0.8 + r.next() * 0.4)) : 0,
      signed_up: isoDay(new Date(start - r.int(-300, 1400) * DAY)), active: r.chance(0.9),
    };
  });
  // bigger customers write in more often
  const custWeights = customers.map((c) => [c, c.segment === 'Enterprise' ? 6 : c.segment === 'Mid-market' ? 3 : 1]);

  const tickets = [];
  const events = [];
  const agentsByTeam = (teamId) => agents.filter((a) => a.team_id === teamId && a.active);
  for (let d = 0; d < 365; d++) {
    const dayMs = start + d * DAY;
    const wd = new Date(dayMs).getUTCDay();
    const growth = 0.75 + 0.5 * (d / 365);
    const seasonal = 1 + 0.15 * Math.sin((d / 365) * 2 * Math.PI * 2);
    const n = r.poisson(9.5 * growth * seasonal * (wd === 0 || wd === 6 ? 0.32 : wd === 1 ? 1.2 : 1));
    for (let i = 0; i < n; i++) {
      const hour = wd === 0 || wd === 6 ? r.int(8, 20) : r.weighted([[7, 2], [8, 5], [9, 9], [10, 11], [11, 11], [12, 8], [13, 8], [14, 10], [15, 10], [16, 9], [17, 6], [18, 4], [19, 3], [20, 2], [21, 1], [22, 1], [2, 1]]);
      const created = dayMs + hour * HOUR + r.int(0, 59) * 6e4;
      if (created > end) continue;
      const cat = r.weighted(categories.map((c) => [c, c.name === 'How-to question' ? 14 : c.name === 'Bug report' ? 11 : c.name === 'Login problem' ? 10 : c.name === 'Feature request' ? 4 : 6]));
      const customer = r.weighted(custWeights);
      let priority = r.weighted(PRIORITY);
      if (customer.segment === 'Enterprise' && priority === 'Low') priority = 'Medium';
      if (cat.name === 'Feature request') priority = r.chance(0.8) ? 'Low' : 'Medium';
      const escalated = cat.group === 'Technical' && (priority === 'Urgent' || r.chance(0.07));
      const team = escalated ? 5 : cat.team_id;
      const agent = r.chance(0.97) ? r.pick(agentsByTeam(team)) : null;
      const skill = agent ? agent.skill : 1;
      const frMin = Math.max(2, Math.round(r.logNormal(FIRST_RESPONSE_MIN[priority], 0.8) * (hour >= 19 || hour < 7 ? 2.5 : 1)));
      const resHours = Math.max(0.3, r.logNormal(cat.typical_hours * SPEED[priority] * (escalated ? 1.8 : 1) / skill, 0.75));
      const age = (end - created) / HOUR;
      const firstResponse = agent && frMin / 60 < age ? created + frMin * 6e4 : null;
      const resolvedAt = agent && resHours < age && resHours * HOUR + created < end ? created + resHours * HOUR : null;
      const due = created + SLA_HOURS[priority] * HOUR;
      let status;
      if (resolvedAt) status = (end - resolvedAt) / DAY > 4 ? 'Closed' : 'Resolved';
      else if (!firstResponse) status = 'New';
      else status = r.weighted([['Open', 5], ['Pending customer', 3], ['On hold', 1]]);
      const breached = resolvedAt ? resolvedAt > due : end > due;
      const reopened = resolvedAt ? r.weighted([[0, 88], [1, 10], [2, 2]]) : 0;
      let satisfaction = null;
      if (resolvedAt && r.chance(0.46)) {
        const score = 4.6 - (breached ? 1.2 : 0) - Math.min(1.2, resHours / 80) - reopened * 0.6 + r.normal(0, 0.7);
        satisfaction = Math.min(5, Math.max(1, Math.round(score)));
      }
      const id = tickets.length + 1;
      tickets.push({
        id, number: 'HD-' + (10000 + id), subject: r.pick(SUBJECTS[cat.name]), status, priority, channel: r.weighted(CHANNELS),
        category_id: cat.id, customer_id: customer.id, agent_id: agent ? agent.id : null, team_id: team,
        created_at: stampOf(created), first_response_at: firstResponse ? stampOf(firstResponse) : null,
        resolved_at: resolvedAt ? stampOf(resolvedAt) : null, due_at: stampOf(due),
        first_response_minutes: firstResponse ? frMin : null, resolution_hours: resolvedAt ? Math.round(resHours * 10) / 10 : null,
        sla_breached: breached, escalated, reopened, satisfaction,
      });
      // activity on the ticket: replies, notes and status changes until it was resolved (or until today)
      const until = resolvedAt || end;
      const steps = 1 + r.poisson(resolvedAt ? 2.5 : 1.5);
      for (let k = 0; k < steps; k++) {
        const at = created + ((until - created) * (k + 1)) / (steps + 1);
        const kind = k === 0 && firstResponse ? 'Agent reply' : r.weighted([['Agent reply', 4], ['Customer reply', 4], ['Internal note', 2], ['Status change', 2]]);
        const byAgent = kind !== 'Customer reply';
        events.push({
          id: events.length + 1, ticket_id: id, kind, agent_id: byAgent && agent ? agent.id : null, at: stampOf(at),
          minutes_spent: byAgent && kind !== 'Status change' ? Math.max(1, Math.round(r.logNormal(12, 0.6))) : null,
          public: kind !== 'Internal note',
        });
      }
    }
  }
  return { teams, agents: agents.map(({ skill, ...a }) => a), categories, customers, tickets, events };
}

const schema = {
  id: 'helpdesk',
  label: 'Helpdesk (dummy data)',
  description: 'Support tickets for a software company over the last 12 months: customers, agents, teams, categories and every reply.',
  tables: {
    tickets: {
      label: 'Tickets', display: 'number', date: 'created_at',
      fields: {
        number: { label: 'Ticket number' }, subject: { label: 'Subject' }, status: { label: 'Status' }, priority: { label: 'Priority' }, channel: { label: 'Channel' },
        created_at: { label: 'Created', type: 'date', time: true }, first_response_at: { label: 'First response', type: 'date', time: true },
        resolved_at: { label: 'Resolved', type: 'date', time: true }, due_at: { label: 'SLA due', type: 'date', time: true },
        first_response_minutes: { label: 'First response (minutes)', type: 'number', format: 'int' },
        resolution_hours: { label: 'Resolution time (hours)', type: 'number', format: 'dec' },
        sla_breached: { label: 'SLA breached', type: 'bool' }, escalated: { label: 'Escalated', type: 'bool' },
        reopened: { label: 'Times reopened', type: 'number', format: 'int' }, satisfaction: { label: 'Satisfaction (1–5)', type: 'number', format: 'dec' },
      },
    },
    customers: {
      label: 'Customers', display: 'name', date: 'signed_up',
      fields: {
        name: { label: 'Customer' }, region: { label: 'Region' }, country: { label: 'Country' }, industry: { label: 'Industry' }, plan: { label: 'Plan' },
        segment: { label: 'Segment' }, seats: { label: 'Seats', type: 'number', format: 'int' }, monthly_revenue: { label: 'Monthly revenue', type: 'number', format: 'money' },
        signed_up: { label: 'Signed up', type: 'date' }, active: { label: 'Active', type: 'bool' },
      },
    },
    agents: {
      label: 'Agents', display: 'name', date: 'hired_on',
      fields: { name: { label: 'Agent' }, level: { label: 'Level' }, location: { label: 'Location' }, shift: { label: 'Shift' }, hired_on: { label: 'Hired', type: 'date' }, active: { label: 'Active', type: 'bool' } },
    },
    teams: { label: 'Teams', display: 'name', date: 'created_at', fields: { name: { label: 'Team' }, manager: { label: 'Manager' }, created_at: { label: 'Created', type: 'date' } } },
    categories: { label: 'Categories', display: 'name', date: null, fields: { name: { label: 'Category' }, group: { label: 'Category group' }, typical_hours: { label: 'Typical hours', type: 'number', format: 'dec' } } },
    events: {
      label: 'Ticket activity', display: null, date: 'at',
      fields: { kind: { label: 'Activity' }, at: { label: 'When', type: 'date', time: true }, minutes_spent: { label: 'Minutes spent', type: 'number', format: 'int' }, public: { label: 'Visible to customer', type: 'bool' } },
    },
  },
  links: [
    { from: 'tickets', col: 'customer_id', to: 'customers', name: 'Customer' },
    { from: 'tickets', col: 'agent_id', to: 'agents', name: 'Agent' },
    { from: 'tickets', col: 'team_id', to: 'teams', name: 'Team' },
    { from: 'tickets', col: 'category_id', to: 'categories', name: 'Category' },
    { from: 'agents', col: 'team_id', to: 'teams', name: 'Team' },
    { from: 'categories', col: 'team_id', to: 'teams', name: 'Default team' },
    { from: 'events', col: 'ticket_id', to: 'tickets', name: 'Ticket' },
    { from: 'events', col: 'agent_id', to: 'agents', name: 'Agent' },
  ],
  rollups: [
    { table: 'tickets', col: 'minutes_worked', label: 'Minutes worked on ticket', from: 'events', via: 'ticket_id', fn: 'sum', field: 'minutes_spent', format: 'int' },
    { table: 'agents', col: 'minutes_worked', label: 'Minutes worked', from: 'events', via: 'agent_id', fn: 'sum', field: 'minutes_spent', format: 'int' },
  ],
};

module.exports = { schema, generate };
