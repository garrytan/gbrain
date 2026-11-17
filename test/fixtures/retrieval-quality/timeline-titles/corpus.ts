/**
 * Pages with titles and dated timelines for the title arm's local-caller
 * predicate (#7082). Every name is a placeholder. Several pages hold a query's
 * words only in their timeline, so the title arm (which reads title lexemes)
 * and the keyword arm (which reads compiled-truth and timeline chunks) find
 * different pages for the same query. Data only: the tests seed it.
 */
export interface TimelineTitlePage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
}

export const TIMELINE_TITLE_PAGES: TimelineTitlePage[] = [
  { slug: 'people/alice-example', type: 'person', title: 'Alice Example', compiled_truth: 'Founder and chief executive of Acme Example.',
    timeline: '- 2026-03-02: board meeting at Acme Example\n- 2026-05-14: zircon quarry visit with Bob Example\n- 2026-09-01: quarterly planning review' },
  { slug: 'people/bob-example', type: 'person', title: 'Bob Example', compiled_truth: 'Geologist who advises on quarry sites.',
    timeline: '- 2026-05-14: zircon quarry visit\n- 2026-07-20: shared the board meeting notes' },
  { slug: 'people/carol-example', type: 'person', title: 'Carol Example', compiled_truth: 'Investor at Fund A.',
    timeline: '- 2026-04-11: fundraise call with Alice Example\n- 2026-08-30: board meeting observer' },
  { slug: 'people/dan-example', type: 'person', title: 'Dan Example', compiled_truth: 'Engineer on the settlement team.',
    timeline: '- 2026-06-03: kelmit protocol rollout\n- 2026-10-07: on call for the launch' },
  { slug: 'companies/acme-example', type: 'company', title: 'Acme Example', compiled_truth: 'Industrial company that runs survey projects.',
    timeline: '- 2026-03-02: board meeting approved the zircon quarry budget\n- 2026-10-07: launch of the survey program' },
  { slug: 'projects/zircon-quarry-survey', type: 'project', title: 'Zircon Quarry Survey', compiled_truth: 'Survey of the northern quarry for zircon deposits.',
    timeline: '- 2026-05-14: site visit' },
  { slug: 'meetings/2026-03-02-acme-board-meeting', type: 'meeting', title: 'Acme Board Meeting, March', compiled_truth: 'Minutes of the March board meeting.', timeline: '' },
  { slug: 'meetings/2026-07-20-board-meeting', type: 'meeting', title: 'Board Meeting, July', compiled_truth: 'Minutes: hiring and the planning calendar.', timeline: '' },
  { slug: 'concepts/quarterly-planning', type: 'concept', title: 'Quarterly Planning', compiled_truth: 'How the team runs its quarterly planning review.',
    timeline: '- 2026-09-01: planning review held' },
  { slug: 'deals/acme-example-fundraise', type: 'deal', title: 'Acme Example Fundraise', compiled_truth: 'Series A fundraise led by Fund A.',
    timeline: '- 2026-04-11: first call' },
  { slug: 'notes/nastel-ledger', type: 'note', title: 'Nastel Ledger', compiled_truth: 'Ledger design notes for settlement.',
    timeline: '- 2026-06-03: adopted the kelmit protocol for settlement' },
  { slug: 'notes/october-launch-checklist', type: 'note', title: 'October Launch Checklist', compiled_truth: 'Checklist for the survey program launch.',
    timeline: '- 2026-10-07: launch day' },
  { slug: 'notes/hiring-plan', type: 'note', title: 'Hiring Plan', compiled_truth: 'Roles to fill before the next planning cycle.', timeline: '' },
  { slug: 'notes/settlement-design', type: 'note', title: 'Settlement Design', compiled_truth: 'How payments settle between ledgers.', timeline: '' },
];

/** Queries whose words sit in titles, in timelines, or in both. */
export const TIMELINE_TITLE_QUERIES: string[] = [
  'zircon quarry',
  'board meeting',
  'Acme Example',
  'kelmit protocol',
  'quarterly planning review',
  'launch',
  'Alice Example',
  'fundraise',
  'Nastel Ledger',
  '2026-10-07 launch',
];
