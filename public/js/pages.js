// The standard pages: which cards each shows. Every card can be moved, resized, hidden and redrawn.
export const PAGES = [
  {
    id: 'overview', label: 'Overview', kpis: true,
    cards: [
      { id: 'ov-trends', title: 'Trends', widget: 'trends', w: 4, views: 'timeNoStack', chips: true, shapes: true },
      { id: 'ov-health', title: 'Health right now', special: 'health', w: 2 },
      { id: 'ov-status', title: 'All work by status', widget: 'status', w: 3, views: 'category', view: 'donut' },
      { id: 'ov-priority', title: 'Open work by priority', widget: 'priority_open', w: 3, views: 'category' },
      { id: 'ov-projects', title: 'Projects with the most open work', widget: 'top_projects', w: 3, views: 'category' },
      { id: 'ov-people', title: 'Open work per person', widget: 'open_per_person', w: 3, views: 'category' },
      { id: 'ov-throughput', title: 'Throughput by work item type', widget: 'throughput_by_type', w: 3, views: 'time', view: 'stack', chips: true },
      { id: 'ov-cfd', title: 'Cumulative flow', widget: 'cfd', w: 3, views: 'time', view: 'area', chips: true },
      { id: 'ov-cycle', title: 'How long work takes', widget: 'cycle_buckets', w: 3, views: 'category' },
      { id: 'ov-bugs', title: 'Bugs reported vs fixed', widget: 'bugs', w: 3, views: 'timeNoStack', chips: true },
      { id: 'ov-heat', title: 'When the team works', widget: 'activity_heat', w: 6, views: 'heat' },
    ],
  },
  {
    id: 'delivery', label: 'Delivery & flow',
    cards: [
      { id: 'dl-throughput', title: 'Throughput by work item type', widget: 'throughput_by_type', w: 6, views: 'time', view: 'stack', chips: true },
      { id: 'dl-backlog', title: 'Open and overdue work over time', widget: 'open_overdue', w: 3, views: 'timeNoStack', chips: true },
      { id: 'dl-cfd', title: 'Cumulative flow', widget: 'cfd', w: 3, views: 'time', view: 'area', chips: true },
      { id: 'dl-cycle', title: 'How long work takes', widget: 'cycle_buckets', w: 3, views: 'category' },
      { id: 'dl-age', title: 'Age of open work', widget: 'age_buckets', w: 3, views: 'category' },
    ],
  },
  {
    id: 'projects', label: 'Projects',
    cards: [
      { id: 'pj-bars', title: 'Projects with the most open work', widget: 'top_projects', w: 6, views: 'category' },
      { id: 'pj-table', title: 'Project health', table: 'projects', w: 6 },
    ],
  },
  {
    id: 'team', label: 'Team',
    cards: [
      { id: 'tm-open', title: 'Open work per person', widget: 'open_per_person', w: 3, views: 'category' },
      { id: 'tm-done', title: 'Completed per person', widget: 'done_per_person', w: 3, views: 'category' },
      { id: 'tm-hours', title: 'Hours logged by the top 4 people', widget: 'hours_trend', w: 3, views: 'time', chips: true },
      { id: 'tm-hours-total', title: 'Hours logged per person', widget: 'hours_per_person', w: 3, views: 'category' },
      { id: 'tm-roles', title: 'Team roles', widget: 'roles', w: 6, views: 'category', view: 'donut' },
    ],
  },
  {
    id: 'sprints', label: 'Sprints',
    cards: [
      { id: 'sp-status', title: 'Sprint status', widget: 'sprint_status', w: 3, views: 'category', view: 'donut' },
      { id: 'sp-points', title: 'Story points per sprint', widget: 'sprint_points', w: 3, views: 'compare' },
      { id: 'sp-table', title: 'All sprints', table: 'sprints', w: 6 },
    ],
  },
  {
    id: 'quality', label: 'Quality & risk',
    cards: [
      { id: 'ql-bugs', title: 'Bugs reported vs fixed', widget: 'bugs', w: 6, views: 'timeNoStack', chips: true },
      { id: 'ql-overdue', title: 'Overdue work by project', widget: 'overdue_by_project', w: 3, views: 'category' },
      { id: 'ql-ready', title: 'Ready-to-start checks done', widget: 'readiness', w: 3, views: 'compare' },
      { id: 'ql-invest', title: 'User story quality ratings', widget: 'invest', w: 6, views: 'compare' },
    ],
  },
  {
    id: 'activity', label: 'Activity',
    cards: [
      { id: 'ac-heat', title: 'When the team works', widget: 'activity_heat', w: 6, views: 'heat' },
      { id: 'ac-trend', title: 'Activity over time', widget: 'activity_trend', w: 4, views: 'time', chips: true },
      { id: 'ac-people', title: 'Most active people', widget: 'active_people', w: 2, views: 'category' },
    ],
  },
  { id: 'build', label: 'Build a view', special: 'build' },
  { id: 'mine', label: 'My dashboard', special: 'mine' },
];
