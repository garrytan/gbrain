// Privacy-clean demo dataset for `gbrain sources demo github`.
// Generic alice-example placeholders only (AGENTS.md privacy rule: never
// commit real names of people, companies, or funds into public artifacts).
// No network, no token, no brain: the demo renders these through the same
// pure render functions the live sync uses.

import type { GitHubItemData } from '../core/github-source.ts';

export interface DemoRepo {
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  description: string | null;
}

export const DEMO_REPOS: DemoRepo[] = [
  {
    full_name: 'alice-example/sample-app',
    private: false,
    archived: false,
    default_branch: 'main',
    description: 'Example web app used to demonstrate the gbrain github source',
  },
  {
    full_name: 'alice-example/docs-site',
    private: false,
    archived: false,
    default_branch: 'main',
    description: 'Example documentation site for the sample-app project',
  },
];

const ALICE = { login: 'alice' };
const BOB = { login: 'bob' };

// PR detail objects carry RawPullDetail fields (merged, mergeable_state,
// review_decision, head). RawPullDetail is not exported, so mirror its
// shape structurally here (assignability to RawIssueDetail is structural).
type PullDetail = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  milestone: { title: string; state: string } | null;
  html_url: string;
  user: { login: string } | null;
  draft: boolean;
  merged: boolean;
  mergeable_state: string | null;
  review_decision: string | null;
  head: { sha: string; ref: string };
};

const PR_27_DETAIL: PullDetail = {
  number: 27,
  title: 'Add dark mode toggle',
  state: 'closed',
  state_reason: null,
  body: 'Adds a theme toggle to the header and persists the choice in localStorage.\n\nCloses #12 (button alignment fell out of the same layout pass).',
  created_at: '2026-07-04T08:00:00Z',
  updated_at: '2026-07-06T16:45:00Z',
  closed_at: '2026-07-06T16:45:00Z',
  labels: [{ name: 'enhancement' }],
  assignees: [ALICE],
  milestone: { title: 'v0.2.0', state: 'open' },
  html_url: 'https://github.com/alice-example/sample-app/pull/27',
  user: ALICE,
  draft: false,
  merged: true,
  mergeable_state: 'clean',
  review_decision: 'approved',
  head: { sha: '9f8c2a1b', ref: 'alice/dark-mode' },
};

const PR_28_DETAIL: PullDetail = {
  number: 28,
  title: 'Bump sample-app to v0.2.0',
  state: 'open',
  state_reason: null,
  body: 'Release prep: version bump and changelog entries.',
  created_at: '2026-07-07T09:00:00Z',
  updated_at: '2026-07-07T09:00:00Z',
  closed_at: null,
  labels: [{ name: 'release' }],
  assignees: [],
  milestone: { title: 'v0.2.0', state: 'open' },
  html_url: 'https://github.com/alice-example/sample-app/pull/28',
  user: ALICE,
  draft: true,
  merged: false,
  mergeable_state: 'dirty',
  review_decision: null,
  head: { sha: 'c41d2e99', ref: 'alice/release-v0.2.0' },
};

export const DEMO_ITEMS: GitHubItemData[] = [
  {
    repo: 'alice-example/sample-app',
    number: 12,
    kind: 'issue',
    detail: {
      number: 12,
      title: 'Fix button alignment in the header',
      state: 'open',
      state_reason: null,
      body: 'The sign-in button is misaligned on narrow viewports.\n\nSteps to reproduce:\n1. Open the landing page at 800px width\n2. Scroll to the header\n3. Observe the button overlapping the nav links',
      created_at: '2026-07-01T10:00:00Z',
      updated_at: '2026-07-03T14:30:00Z',
      closed_at: null,
      labels: [{ name: 'bug' }, { name: 'good first issue' }],
      assignees: [ALICE],
      milestone: { title: 'v0.2.0', state: 'open' },
      html_url: 'https://github.com/alice-example/sample-app/issues/12',
      user: BOB,
    },
    comments: [
      {
        user: ALICE,
        body: 'I can reproduce this at 800px. The flex container is missing `gap` on small screens.',
        created_at: '2026-07-02T09:15:00Z',
      },
      {
        user: BOB,
        body: 'Proposed fix in #27. Review appreciated.',
        created_at: '2026-07-03T14:30:00Z',
      },
    ],
    reviews: [],
    reviewComments: [],
    checks: null,
    linked: [27],
  },
  {
    repo: 'alice-example/sample-app',
    number: 27,
    kind: 'pr',
    detail: PR_27_DETAIL,
    comments: [
      {
        user: BOB,
        body: 'Toggle works. Nice touch persisting the choice.',
        created_at: '2026-07-06T15:00:00Z',
      },
    ],
    reviews: [
      {
        user: BOB,
        state: 'APPROVED',
        body: 'LGTM. Ship it.',
        submitted_at: '2026-07-06T15:10:00Z',
      },
    ],
    reviewComments: [
      {
        user: BOB,
        body: 'Minor: use `prefers-reduced-motion` here too.',
        created_at: '2026-07-06T14:20:00Z',
        path: 'src/components/theme-toggle.ts',
        line: 41,
        original_line: null,
      },
    ],
    checks: {
      pass: 2,
      fail: 1,
      pending: 0,
      failing: ['sample-app / lint (windows-latest)'],
    },
    linked: [12],
  },
  {
    repo: 'alice-example/sample-app',
    number: 28,
    kind: 'pr',
    detail: PR_28_DETAIL,
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: { pass: 0, fail: 0, pending: 3, failing: [] },
    linked: [],
  },
  {
    repo: 'alice-example/docs-site',
    number: 3,
    kind: 'issue',
    detail: {
      number: 3,
      title: 'Add contributing guide link to the sidebar',
      state: 'open',
      state_reason: null,
      body: 'The docs site should link the CONTRIBUTING.md from the sidebar navigation.',
      created_at: '2026-07-08T11:00:00Z',
      updated_at: '2026-07-08T11:00:00Z',
      closed_at: null,
      labels: [{ name: 'docs' }],
      assignees: [],
      milestone: null,
      html_url: 'https://github.com/alice-example/docs-site/issues/3',
      user: BOB,
    },
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: null,
    linked: [],
  },
  {
    repo: 'alice-example/sample-app',
    number: 33,
    kind: 'issue',
    detail: {
      number: 33,
      title: 'Investigate flaky e2e test',
      state: 'open',
      state_reason: null,
      body: null,
      created_at: '2026-07-09T09:00:00Z',
      updated_at: '2026-07-09T09:00:00Z',
      closed_at: null,
      labels: [{ name: 'bug' }, { name: 'test-flake' }],
      assignees: [BOB],
      milestone: { title: 'v0.3.0', state: 'open' },
      html_url: 'https://github.com/alice-example/sample-app/issues/33',
      user: ALICE,
    },
    comments: [],
    reviews: [],
    reviewComments: [],
    checks: null,
    linked: [],
  },
];
