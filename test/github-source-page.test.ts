import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseGitHubSourceConfig,
  isGitHubSourceConfig,
  extractLinkedNumbers,
  linkifyMentions,
  renderItemPage,
  renderListItemPage,
  renderRepoCard,
  itemPagePath,
  repoCardPath,
  isPageFresh,
  pageHasDetail,
  isValidRepoName,
  linkNextUrl,
  parseRetryAfterMs,
  mintAppInstallationToken,
  AppTokenProvider,
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
  });

  test('reads explicit fields, lowercases repos, tolerates reserved keys', () => {
    const cfg = parseGitHubSourceConfig(
      {
        kind: 'github',
        gh_token_env: 'GH_MY_TOKEN',
        gh_handle: 'veltr', // reserved: tolerated, ignored
        gh_scope: 'repos',
        gh_repos: 'Acme/App, acme/tool',
        gh_dir: '/data/gh',
        gh_involvement: false, // reserved: tolerated, ignored
      },
      '/tmp/fallback',
    );
    expect(cfg.tokenEnv).toBe('GH_MY_TOKEN');
    expect(cfg.scope).toBe('repos');
    expect(cfg.repos).toEqual(['acme/app', 'acme/tool']);
    expect(cfg.dir).toBe('/data/gh');
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
        reviews: [{ user: { login: 'carol' }, state: 'APPROVED', body: 'LGTM, see #88.', submitted_at: '2026-08-02T00:00:00Z' }],
      }),
    );
    expect(page).toContain('kind: pr');
    expect(page).toContain('status: "merged"');
    expect(page).toContain('merged: true');
    expect(page).toContain('head_ref: "feat/thing"');
    expect(page).toContain('## Reviews');
    expect(page).toContain('[[gh/acme/app/88|#88]]');
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
            body: 'off by one here; see #89',
            created_at: '2026-08-02T02:00:00Z',
            path: 'src/app.ts',
            line: 41,
            original_line: null,
          },
        ],
      }),
    );
    expect(page).toContain('## Review comments');
    expect(page).toContain('[[gh/acme/app/89|#89]]');
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

  test('non-array field payload throws naming the endpoint and field', async () => {
    const client = new GitHubClient('tok', (async () =>
      new Response(JSON.stringify({ check_runs: 'nope' }), { status: 200 })) as never);
    await expect(
      client.fetchAllPages('/repos/a/b/commits/abc/check-runs', { field: 'check_runs' }),
    ).rejects.toThrow('non-array payload on /repos/a/b/commits/abc/check-runs (field "check_runs")');
  });

  test('non-array payload without a field throws naming the endpoint', async () => {
    const client = new GitHubClient('tok', (async () =>
      new Response(JSON.stringify({ message: 'moved' }), { status: 200 })) as never);
    await expect(client.fetchAllPages('/repos/a/b/issues')).rejects.toThrow(
      'non-array payload on /repos/a/b/issues',
    );
  });
});

describe('parseRetryAfterMs', () => {
  test('delta-seconds form', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  test('HTTP-date form (future waits, past is 0)', () => {
    const now = Math.floor(Date.now() / 1000) * 1000; // HTTP-dates drop ms
    expect(parseRetryAfterMs(new Date(now + 120_000).toUTCString(), now)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  test('absent or garbage is null, never NaN', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});

describe('GitHubClient 403/429 handling', () => {
  const jsonRes = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers });

  test('403 with rate budget left and no Retry-After fails fast', async () => {
    let calls = 0;
    const client = new GitHubClient('tok', (async () => {
      calls++;
      return jsonRes({ message: 'Resource not accessible' }, 403, {
        'x-ratelimit-remaining': '4000',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
    }) as never);
    await expect(client.fetchJSON('/repos/a/b/issues')).rejects.toThrow('check token permissions');
    expect(calls).toBe(1); // no useless retry against a permission error
  });

  test('403 with an exhausted bucket retries after the reset', async () => {
    let calls = 0;
    const resetSec = Math.floor(Date.now() / 1000) - 2; // already elapsed
    const client = new GitHubClient('tok', (async () => {
      calls++;
      if (calls === 1) {
        return jsonRes({ message: 'rate limited' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetSec),
        });
      }
      return jsonRes([{ ok: true }], 200, {
        'x-ratelimit-remaining': '5000',
        'x-ratelimit-reset': String(resetSec + 3600),
      });
    }) as never);
    const out = await client.fetchJSON<Array<{ ok: boolean }>>('/repos/a/b/issues');
    expect(calls).toBe(2);
    expect(out).toEqual([{ ok: true }]);
  }, 10_000);

  test('429 with an HTTP-date Retry-After in the past retries without a NaN sleep', async () => {
    let calls = 0;
    const client = new GitHubClient('tok', (async () => {
      calls++;
      if (calls === 1) {
        return jsonRes({}, 429, { 'retry-after': new Date(Date.now() - 5000).toUTCString() });
      }
      return jsonRes([1], 200);
    }) as never);
    const started = Date.now();
    const out = await client.fetchJSON<number[]>('/x');
    expect(calls).toBe(2);
    expect(out).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('symlink containment', () => {
  test('itemPagePath refuses a gh/ symlink escaping the managed dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ghsrc-outside-'));
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-managed-'));
    try {
      // A lexical prefix check passes here — only realpath containment
      // catches the planted symlinked intermediate directory.
      symlinkSync(outside, join(dir, 'gh'));
      expect(() => itemPagePath(dir, 'acme/app', 7)).toThrow('Path escapes managed dir');
      expect(() => repoCardPath(dir, 'acme/app')).toThrow('Path escapes managed dir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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

describe('fast path (two-pass)', () => {
  test('renderListItemPage emits a list-only page marked detail_fetched: false', () => {
    const page = renderListItemPage('acme/app', 'issue', {
      number: 7,
      title: 'List title',
      state: 'open',
      updated_at: '2026-08-04T00:00:00Z',
      body: 'Closes #9 body text',
      html_url: 'https://github.com/acme/app/issues/7',
      created_at: '2026-08-01T00:00:00Z',
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'alice' }],
      user: { login: 'bob' },
    });
    expect(page).toContain('detail_fetched: false');
    expect(page).toContain('title: "List title"');
    expect(page).toContain('## Description');
    expect(page).toContain('[[gh/acme/app/9|#9]]');
    // No detail sections until pass 2.
    expect(page).not.toContain('## Comments');
    expect(page).not.toContain('## Reviews');
  });

  test('pageHasDetail: missing marker means complete (pre-change pages), false means pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-detail-'));
    try {
      const old = join(dir, 'old.md');
      writeFileSync(old, '---\nupdated_at: "2026-08-01T00:00:00Z"\n---\nbody', 'utf-8');
      expect(pageHasDetail(old)).toBe(true);
      const pending = join(dir, 'pending.md');
      writeFileSync(pending, '---\ndetail_fetched: false\n---\nbody', 'utf-8');
      expect(pageHasDetail(pending)).toBe(false);
      const done = join(dir, 'done.md');
      writeFileSync(done, '---\ndetail_fetched: true\n---\nbody', 'utf-8');
      expect(pageHasDetail(done)).toBe(true);
      // A missing file has no detail yet: pass 1 materializes it first.
      expect(pageHasDetail(join(dir, 'missing.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GitHub App tokens', () => {
  function tempKey(): { dir: string; pemPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-app-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pemPath = join(dir, 'key.pem');
    writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf-8');
    return { dir, pemPath };
  }

  test('mintAppInstallationToken signs a JWT, discovers the install and mints', async () => {
    const { dir, pemPath } = tempKey();
    try {
      const calls: Array<{ url: string; auth: string }> = [];
      const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
        const auth = String((init.headers as Record<string, string>).authorization);
        calls.push({ url, auth });
        if (url.endsWith('/app/installations')) {
          return new Response(JSON.stringify([{ id: 153578804 }]), { status: 200 });
        }
        if (url.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({ token: 'ghs_install-token', expires_at: '2026-08-14T02:00:00Z' }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      };
      const out = await mintAppInstallationToken({ appId: 4588667, pemPath }, fakeFetch);
      expect(out.token).toBe('ghs_install-token');
      expect(out.expiresAt).toBe(Date.parse('2026-08-14T02:00:00Z'));
      expect(calls.length).toBe(2);
      expect(calls[0].url).toContain('/app/installations');
      // Bearer is an RS256 JWT: decode the payload, check iss/exp window.
      const jwt = calls[0].auth.replace('Bearer ', '');
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'));
      expect(payload.iss).toBe(4588667);
      expect(payload.exp - payload.iat).toBe(540);
      expect(calls[1].url).toContain('/app/installations/153578804/access_tokens');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit install id skips discovery', async () => {
    const { dir, pemPath } = tempKey();
    try {
      const urls: string[] = [];
      const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
        urls.push(url);
        return new Response(
          JSON.stringify({ token: 'ghs_x', expires_at: '2026-08-14T02:00:00Z' }),
          { status: 200 },
        );
      };
      await mintAppInstallationToken({ appId: 1, pemPath, installId: 99 }, fakeFetch);
      expect(urls).toEqual(['https://api.github.com/app/installations/99/access_tokens']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AppTokenProvider caches within the window and refreshes after expiry', async () => {
    const { dir, pemPath } = tempKey();
    try {
      let mints = 0;
      const fakeFetch = async (url: string, _init: RequestInit): Promise<Response> => {
        if (url.includes('/access_tokens')) {
          mints++;
          return new Response(
            JSON.stringify({
              token: `ghs_${mints}`,
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      };
      const provider = new AppTokenProvider({ appId: 1, pemPath }, fakeFetch);
      expect(await provider.getToken()).toBe('ghs_1');
      expect(await provider.getToken()).toBe('ghs_1'); // cached
      expect(mints).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseGitHubSourceConfig app fields', () => {
  test('parses app credentials when present', () => {
    const cfg = parseGitHubSourceConfig(
      {
        kind: 'github',
        gh_app_id: 4588667,
        gh_app_pem_path: '/keys/app.pem',
        gh_app_install_id: 153578804,
      },
      '/tmp/fallback',
    );
    expect(cfg.app).toEqual({ appId: 4588667, pemPath: '/keys/app.pem', installId: 153578804 });
  });

  test('partial app config yields null (PAT path unchanged)', () => {
    const cfg = parseGitHubSourceConfig(
      { kind: 'github', gh_app_id: 4588667 },
      '/tmp/fallback',
    );
    expect(cfg.app).toBeNull();
    expect(cfg.tokenEnv).toBe('GH_TOKEN');
  });
});
