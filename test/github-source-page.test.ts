import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseGitHubSourceConfig,
  isGitHubSourceConfig,
  extractLinkedNumbers,
  linkifyMentions,
  renderItemPage,
  renderRepoCard,
  itemPagePath,
  repoCardPath,
  isPageFresh,
  isValidRepoName,
  linkNextUrl,
  type GitHubItemData,
} from '../src/core/github-source.ts';
import { extractGitHubItemRef } from '../src/commands/serve-http.ts';
import { GitHubClient } from '../src/core/github-source.ts';

function baseItemData(overrides: Partial<GitHubItemData> = {}): GitHubItemData {
  return {
    repo: 'acme/app',
    number: 42,
    kind: 'issue',
    detail: {
      number: 42,
      title: 'Fix the thing',
      state: 'open',
      state_reason: null,
      body: 'The thing is broken, see #7 and Closes #9.',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
      closed_at: null,
      labels: [{ name: 'bug' }, { name: 'p1' }],
      assignees: [{ login: 'alice' }],
      milestone: { title: 'v2', state: 'open' },
      html_url: 'https://github.com/acme/app/issues/42',
      user: { login: 'alice' },
    },
    comments: [
      { user: { login: 'bob' }, body: 'Can you also check #9?', created_at: '2026-08-01T01:00:00Z' },
    ],
    reviews: [],
    reviewComments: [],
    checks: null,
    linked: [9],
    ...overrides,
  };
}

describe('parseGitHubSourceConfig', () => {
  test('defaults for an empty config', () => {
    const cfg = parseGitHubSourceConfig({}, '/tmp/fallback');
    expect(cfg.tokenEnv).toBe('GH_TOKEN');
    expect(cfg.scope).toBe('auto');
    expect(cfg.repos).toEqual([]);
    expect(cfg.dir).toBe('/tmp/fallback');
    expect(cfg.includeInvolvement).toBe(true);
  });

  test('reads explicit fields and validates repo entries', () => {
    const cfg = parseGitHubSourceConfig(
      {
        kind: 'github',
        gh_token_env: 'GH_MY_TOKEN',
        gh_handle: 'veltr',
        gh_scope: 'repos',
        gh_repos: 'acme/app, acme/tool',
        gh_dir: '/data/gh',
        gh_involvement: false,
      },
      '/tmp/fallback',
    );
    expect(cfg.tokenEnv).toBe('GH_MY_TOKEN');
    expect(cfg.handle).toBe('veltr');
    expect(cfg.scope).toBe('repos');
    expect(cfg.repos).toEqual(['acme/app', 'acme/tool']);
    expect(cfg.dir).toBe('/data/gh');
    expect(cfg.includeInvolvement).toBe(false);
  });

  test('drops malformed repo entries', () => {
    const cfg = parseGitHubSourceConfig(
      { kind: 'github', gh_scope: 'repos', gh_repos: 'acme/app,not-a-repo' },
      '/tmp/fallback',
    );
    expect(cfg.repos).toEqual(['acme/app']);
  });

  test('isGitHubSourceConfig detects the kind', () => {
    expect(isGitHubSourceConfig({ kind: 'github' })).toBe(true);
    expect(isGitHubSourceConfig({ kind: 'other' })).toBe(false);
    expect(isGitHubSourceConfig({})).toBe(false);
  });
});

describe('extractLinkedNumbers', () => {
  test('finds Closes/Fixes/Resolves references', () => {
    expect(extractLinkedNumbers('Closes #12 and fixes #34, resolves #56')).toEqual([12, 34, 56]);
  });
  test('case-insensitive and deduped', () => {
    expect(extractLinkedNumbers('FIXES #7\nfixes #7 again')).toEqual([7]);
  });
  test('ignores bare mentions', () => {
    expect(extractLinkedNumbers('see #99 for context')).toEqual([]);
  });
});

describe('linkifyMentions', () => {
  test('links #n mentions to the item page', () => {
    const out = linkifyMentions('see #7 and #12 here', 'acme/app');
    expect(out).toContain('[[gh/acme/app/7|#7]]');
    expect(out).toContain('[[gh/acme/app/12|#12]]');
  });
  test('does not link inside words or hashes', () => {
    expect(linkifyMentions('C# code and #x', 'acme/app')).toBe('C# code and #x');
  });
});

describe('renderItemPage', () => {
  test('issue page frontmatter and body', () => {
    const page = renderItemPage(baseItemData());
    expect(page).toContain('kind: issue');
    expect(page).toContain('repo: "acme/app"');
    expect(page).toContain('number: 42');
    expect(page).toContain('state: open');
    expect(page).toContain('status: "open"');
    expect(page).toContain('milestone: "v2"');
    expect(page).toContain('labels:');
    expect(page).toContain('  - "bug"');
    expect(page).toContain('  - "p1"');
    expect(page).toContain('  - "alice"');
    expect(page).toContain('## Description');
    expect(page).toContain('[[gh/acme/app/9|#9]]');
    expect(page).toContain('## Comments');
    expect(page).toContain('### bob · 2026-08-01T01:00:00Z');
    expect(page).toContain('## Linked');
    expect(page).toContain('[[gh/acme/app/9|#9]]');
  });

  test('pr page carries merge and review state', () => {
    const page = renderItemPage(
      baseItemData({
        kind: 'pr',
        detail: {
          ...baseItemData().detail,
          state: 'closed',
          closed_at: '2026-08-03T00:00:00Z',
          merged: true,
          mergeable_state: null,
          review_decision: 'APPROVED',
          head: { sha: 'abc123', ref: 'feat/thing' },
        } as GitHubItemData['detail'],
        reviews: [{ user: { login: 'carol' }, state: 'APPROVED', body: 'LGTM', submitted_at: '2026-08-02T00:00:00Z' }],
      }),
    );
    expect(page).toContain('kind: pr');
    expect(page).toContain('status: "merged"');
    expect(page).toContain('merged: true');
    expect(page).toContain('head_ref: "feat/thing"');
    expect(page).toContain('## Reviews');
    expect(page).toContain('### carol · APPROVED · 2026-08-02T00:00:00Z');
  });

  test('open pr with checks emits check counts', () => {
    const page = renderItemPage(
      baseItemData({
        kind: 'pr',
        detail: {
          ...baseItemData().detail,
          state: 'open',
          merged: false,
          mergeable_state: 'clean',
          review_decision: 'CHANGES_REQUESTED',
          head: { sha: 'abc123', ref: 'feat/x' },
        } as GitHubItemData['detail'],
        checks: { pass: 3, fail: 1, pending: 2, failing: ['lint'] },
      }),
    );
    expect(page).toContain('checks_pass: 3');
    expect(page).toContain('checks_fail: 1');
    expect(page).toContain('checks_pending: 2');
    expect(page).toContain('**Checks:** 3 passing, 1 failing, 2 pending');
    expect(page).toContain('Failing: lint');
  });

  test('review comments carry file and line', () => {
    const page = renderItemPage(
      baseItemData({
        reviewComments: [
          {
            user: { login: 'dave' },
            body: 'off by one here',
            created_at: '2026-08-02T02:00:00Z',
            path: 'src/app.ts',
            line: 41,
            original_line: null,
          },
        ],
      }),
    );
    expect(page).toContain('## Review comments');
    expect(page).toContain('### dave · src/app.ts:41 · 2026-08-02T02:00:00Z');
  });
});

describe('renderRepoCard', () => {
  test('emits repo metadata', () => {
    const page = renderRepoCard('acme/app', {
      full_name: 'acme/app',
      private: true,
      archived: false,
      default_branch: 'main',
      description: 'The app',
    });
    expect(page).toContain('kind: repo');
    expect(page).toContain('repo: "acme/app"');
    expect(page).toContain('description: "The app"');
    expect(page).toContain('archived: false');
    expect(page).toContain('Default branch: main');
  });
});

describe('isValidRepoName', () => {
  test('accepts normal owner/name', () => {
    expect(isValidRepoName('acme/app')).toBe(true);
    expect(isValidRepoName('a.b-c_d/app')).toBe(true);
  });
  test('rejects dot segments and malformed shapes', () => {
    expect(isValidRepoName('../..')).toBe(false);
    expect(isValidRepoName('..')).toBe(false);
    expect(isValidRepoName('.')).toBe(false);
    expect(isValidRepoName('acme/..')).toBe(false);
    expect(isValidRepoName('/acme/app')).toBe(false);
    expect(isValidRepoName('acme/app/')).toBe(false);
    expect(isValidRepoName('acme')).toBe(false);
    expect(isValidRepoName('a/b/c')).toBe(false);
    expect(isValidRepoName('')).toBe(false);
  });
});

describe('linkNextUrl', () => {
  test('extracts rel=next from a Link header', () => {
    const header =
      '<https://api.github.com/repos/a/b/issues?page=2&per_page=100>; rel="next", ' +
      '<https://api.github.com/repos/a/b/issues?page=4&per_page=100>; rel="last"';
    expect(linkNextUrl(header)).toBe('https://api.github.com/repos/a/b/issues?page=2&per_page=100');
  });
  test('returns null when no next link exists', () => {
    expect(linkNextUrl('<https://x>; rel="last"')).toBeNull();
    expect(linkNextUrl('')).toBeNull();
  });
});

describe('fetchAllPages', () => {
  test('follows absolute Link URLs without double-prefixing the host', async () => {
    const calls: string[] = [];
    const client = new GitHubClient('tok', (async (u: string): Promise<Response> => {
      calls.push(u);
      const h = new Headers();
      if (calls.length === 1) {
        h.set('link', '<https://api.github.com/repos/a/b/issues?page=2&per_page=100>; rel="next"');
      }
      return new Response(JSON.stringify([{ n: calls.length }]), { status: 200, headers: h });
    }) as never);
    const out = await client.fetchAllPages<{ n: number }>('/repos/a/b/issues');
    expect(calls).toEqual([
      'https://api.github.com/repos/a/b/issues?per_page=100&page=1',
      'https://api.github.com/repos/a/b/issues?page=2&per_page=100',
    ]);
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('extractGitHubItemRef (webhook payload shapes)', () => {
  const repo = { full_name: 'acme/app' };
  test('issue event', () => {
    expect(extractGitHubItemRef({ repository: repo, issue: { number: 7 } })).toEqual({ repo: 'acme/app', number: 7, kind: 'issue' });
  });
  test('PR issue_comment event carries the PR inside issue.pull_request', () => {
    expect(
      extractGitHubItemRef({ repository: repo, issue: { number: 9, pull_request: {} } }),
    ).toEqual({ repo: 'acme/app', number: 9, kind: 'pr' });
  });
  test('pull_request review event', () => {
    expect(
      extractGitHubItemRef({ repository: repo, pull_request: { number: 12 } }),
    ).toEqual({ repo: 'acme/app', number: 12, kind: 'pr' });
  });
  test('check_run event nests linked PRs', () => {
    expect(
      extractGitHubItemRef({ repository: repo, check_run: { pull_requests: [{ number: 15 }] } }),
    ).toEqual({ repo: 'acme/app', number: 15, kind: 'pr' });
  });
  test('check_suite and workflow_run also nest linked PRs', () => {
    expect(
      extractGitHubItemRef({ repository: repo, check_suite: { pull_requests: [{ number: 16 }] } }),
    ).toEqual({ repo: 'acme/app', number: 16, kind: 'pr' });
    expect(
      extractGitHubItemRef({ repository: repo, workflow_run: { pull_requests: [{ number: 17 }] } }),
    ).toEqual({ repo: 'acme/app', number: 17, kind: 'pr' });
  });
  test('payload without an item reference resolves to null', () => {
    expect(extractGitHubItemRef({ repository: repo, check_run: { pull_requests: [] } })).toBeNull();
    expect(extractGitHubItemRef({ repository: repo, zen: 'hi' })).toBeNull();
    expect(extractGitHubItemRef({})).toBeNull();
  });
});

describe('paths and freshness', () => {
  test('item and card paths', () => {
    expect(itemPagePath('/base', 'acme/app', 7)).toBe(join('/base', 'gh', 'acme/app', '7.md'));
    expect(repoCardPath('/base', 'acme/app')).toBe(join('/base', 'gh', 'acme/app', 'index.md'));
  });

  test('isPageFresh compares stored vs API updated_at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-page-'));
    try {
      const p = join(dir, 'x.md');
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, '---\nupdated_at: "2026-08-02T00:00:00Z"\n---\nbody', 'utf-8');
      expect(isPageFresh(p, '2026-08-01T00:00:00Z')).toBe(true);
      expect(isPageFresh(p, '2026-08-02T00:00:00Z')).toBe(true);
      expect(isPageFresh(p, '2026-08-03T00:00:00Z')).toBe(false);
      expect(isPageFresh(join(dir, 'missing.md'), '2026-08-01T00:00:00Z')).toBe(false);
      expect(isPageFresh(join(dir, 'no-fm.md'), '2026-08-01T00:00:00Z')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
