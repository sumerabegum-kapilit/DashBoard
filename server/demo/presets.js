// Starter dashboards for the dummy data sets. They are plain widget lists, the same as any dashboard
// a person builds, so every one of them can be changed, moved, resized or deleted.
const W = (id, title, w, h, chart, spec, opts = {}) => ({ id, title, w, h, chart, spec, opts });
const OPEN = { field: 'status', op: 'in', value: ['New', 'Open', 'Pending customer', 'On hold'] };
const count = { fn: 'count' };

const helpdesk = [
  {
    title: 'Support overview', range: { preset: '90d' }, compare: true,
    widgets: [
      W('k1', 'Tickets created', 3, 2, 'kpi', { base: 'tickets', measures: [{ ...count, label: 'Tickets created' }], time: 'created_at' }, { good: 'up', spark: true }),
      W('k2', 'Median first response', 3, 2, 'kpi', { base: 'tickets', measures: [{ fn: 'median', field: 'first_response_minutes', format: 'minutes' }], time: 'created_at' }, { good: 'down', spark: true }),
      W('k3', 'SLA breached', 3, 2, 'kpi', { base: 'tickets', measures: [{ fn: 'rate', filters: [{ field: 'sla_breached', op: 'is', value: 'Yes' }], label: 'Share breaching SLA' }], time: 'created_at' }, { good: 'down', target: 0.12, spark: true }),
      W('k4', 'Customer satisfaction', 3, 2, 'gauge', { base: 'tickets', measures: [{ fn: 'avg', field: 'satisfaction', label: 'Average rating' }] }, { min: 1, max: 5, target: 4.2, good: 'up' }),
      W('c1', 'Created vs resolved', 8, 4, 't:line', { base: 'tickets', measures: [{ ...count, label: 'Created' }, { ...count, label: 'Resolved', time: 'resolved_at' }], time: 'created_at', grain: 'week' }),
      W('c2', 'Open backlog by status', 4, 4, 'donut', { base: 'tickets', measures: [count], group: 'status', filters: [OPEN], dateField: '-' }),
      W('c3', 'Tickets by priority and channel', 6, 4, 'bar', { base: 'tickets', measures: [count], group: 'priority', split: 'channel' }),
      W('c4', 'Average resolution time by category', 6, 4, 'bar', { base: 'tickets', measures: [{ fn: 'avg', field: 'resolution_hours', format: 'hours' }], group: 'category_id.name', top: 14 }),
      W('c5', 'When tickets arrive', 12, 4, 'matrix', { base: 'tickets', measures: [count], group: 'created_at|weekday', split: 'created_at|hour', splitTop: 24, other: false }),
      W('c6', 'Agent scorecard', 12, 6, 'pivot', {
        base: 'tickets', group: 'agent_id.name', top: 30, sort: 'value-desc',
        measures: [{ ...count, label: 'Tickets' }, { ...count, label: 'Resolved', filters: [{ field: 'resolved_at', op: 'notempty' }] },
          { fn: 'median', field: 'resolution_hours', label: 'Median hours to resolve', format: 'hours' }, { fn: 'avg', field: 'satisfaction', label: 'Satisfaction' },
          { fn: 'rate', filters: [{ field: 'sla_breached', op: 'is', value: 'Yes' }], label: 'SLA breached' }],
      }, { bars: true }),
      W('c7', 'Tickets by customer region', 4, 4, 'treemap', { base: 'tickets', measures: [count], group: 'customer_id.region' }),
      W('c8', 'Satisfaction by customer segment', 4, 4, 'column', { base: 'tickets', measures: [{ fn: 'avg', field: 'satisfaction' }], group: 'customer_id.segment' }),
      W('c9', 'Channel mix over time', 4, 4, 't:area', { base: 'tickets', measures: [count], group: 'channel', time: 'created_at', grain: 'month' }),
      W('r1', 'Open urgent and high tickets', 12, 6, 'records', { base: 'tickets', measures: [count], filters: [OPEN, { field: 'priority', op: 'in', value: ['Urgent', 'High'] }], dateField: '-' },
        { columns: ['number', 'subject', 'priority', 'status', 'created_at', 'due_at', 'sla_breached', 'customer_id.name', 'customer_id.segment', 'agent_id.name'], pageSize: 10 }),
    ],
  },
  {
    title: 'Team and workload', range: { preset: '30d' }, compare: true,
    widgets: [
      W('n1', 'About this page', 12, 1, 'text', { base: 'tickets', measures: [count] }, { text: 'Who is doing the work and where time goes. Click any bar to see the tickets behind it, or to filter the whole page by it.' }),
      W('t1', 'Minutes worked by team', 6, 4, 'bar', { base: 'events', measures: [{ fn: 'sum', field: 'minutes_spent', format: 'minutes' }], group: 'agent_id.team_id.name' }),
      W('t2', 'Activity by kind over time', 6, 4, 't:stack', { base: 'events', measures: [count], group: 'kind', time: 'at' }),
      W('t3', 'Open tickets per agent', 6, 5, 'bar', { base: 'tickets', measures: [count], group: 'agent_id.name', filters: [OPEN], dateField: '-', top: 15 }),
      W('t4', 'Escalations by category', 6, 5, 'lollipop', { base: 'tickets', measures: [{ ...count, filters: [{ field: 'escalated', op: 'is', value: 'Yes' }], label: 'Escalated tickets' }], group: 'category_id.name' }),
      W('t5', 'Team by agent level', 6, 4, 'column', { base: 'tickets', measures: [count], group: 'team_id.name', split: 'agent_id.level' }),
      W('t6', 'Median resolution time by category group', 6, 4, 'radar', { base: 'tickets', measures: [{ fn: 'median', field: 'resolution_hours', format: 'hours' }], group: 'category_id.group' }),
    ],
  },
];

const sales = [
  {
    title: 'Sales overview', range: { preset: '365d' }, compare: true,
    widgets: [
      W('k1', 'Revenue', 3, 2, 'kpi', { base: 'orders', measures: [{ fn: 'sum', field: 'revenue' }], time: 'order_date' }, { good: 'up', spark: true }),
      W('k2', 'Orders', 3, 2, 'kpi', { base: 'orders', measures: [count], time: 'order_date' }, { good: 'up', spark: true }),
      W('k3', 'Average order value', 3, 2, 'kpi', { base: 'orders', measures: [{ fn: 'avg', field: 'revenue' }], time: 'order_date' }, { good: 'up', spark: true }),
      W('k4', 'Returned or cancelled', 3, 2, 'kpi', { base: 'orders', measures: [{ fn: 'rate', filters: [{ field: 'status', op: 'in', value: ['Returned', 'Cancelled'] }], label: 'Share returned or cancelled' }], time: 'order_date' }, { good: 'down', spark: true }),
      W('c1', 'Revenue by channel over time', 8, 4, 't:stack', { base: 'orders', measures: [{ fn: 'sum', field: 'revenue' }], group: 'channel', time: 'order_date', grain: 'month' }),
      W('c2', 'Revenue by product category', 4, 4, 'donut', { base: 'lines', measures: [{ fn: 'sum', field: 'revenue' }], group: 'product_id.category' }),
      W('c3', 'Top customers', 4, 5, 'bar', { base: 'orders', measures: [{ fn: 'sum', field: 'revenue' }], group: 'customer_id.name', top: 12, other: false }),
      W('c4', 'Units sold by product', 4, 5, 'treemap', { base: 'lines', measures: [{ fn: 'sum', field: 'quantity' }], group: 'product_id.name', top: 15 }),
      W('c5', 'Margin by region', 4, 5, 'column', { base: 'orders', measures: [{ fn: 'sum', field: 'gross_margin' }], group: 'customer_id.region', split: 'customer_id.type' }),
      W('c6', 'Revenue by region and month', 12, 4, 'matrix', { base: 'orders', measures: [{ fn: 'sum', field: 'revenue' }], group: 'customer_id.region', split: 'order_date|month', splitTop: 24, other: false, sort: 'label-asc' }),
      W('c7', 'Sales rep scorecard', 12, 6, 'pivot', {
        base: 'orders', group: 'rep_id.name', top: 30, sort: 'value-desc',
        measures: [{ fn: 'sum', field: 'revenue', label: 'Revenue' }, { ...count, label: 'Orders' }, { fn: 'avg', field: 'revenue', label: 'Average order' },
          { fn: 'avg', field: 'discount_pct', label: 'Average discount %' }, { fn: 'distinct', field: 'customer_id.name', label: 'Customers' }],
      }, { bars: true }),
      W('r1', 'Latest orders', 12, 6, 'records', { base: 'orders', measures: [count] }, { columns: ['number', 'order_date', 'status', 'channel', 'customer_id.name', 'rep_id.name', 'revenue', 'gross_margin', 'discount_pct'], pageSize: 10 }),
    ],
  },
];

module.exports = { helpdesk, sales };
