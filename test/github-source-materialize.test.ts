import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runGitHubSync, type GitHubSourceConfig } from '../src/core/github-source.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ── Fixture: a tiny GitHub API backed by a mutable "database" ───────────────

interface FixtureItem {
  number: number;
  kind: 'issue' | 'pr';
  state: 'open' | 'closed';
  updated_at: string;
  merged?: boolean;
  head?: { sha: string; ref: string };
  body: string;
  labels: string[];
  assignees: string[];
  comments: { user: string; body: string; created_at: string }[];
  reviews: { user: string; state: string; body: string; submitted_at: string }[];
  checks?: { pass: number; fail: number; pending: number; failing: string[] };
}

const REPO = 'acme/app';

function makeFixture(): { items: Map<number, FixtureItem>; calls: string[]; failIssuesList: boolean; failDetailItems: Set<number> } {
  const items = new Map<number, FixtureItem>([
    [1, {
      number: 1,
      kind: 'issue',
      state: 'open',
      updated_at: '2026-08-01T00:00:00Z',
      body: 'Broken, relates to #2.',
      labels: ['bug'],
      assignees: ['alice'],
      comments: [{ user: 'bob', body: 'Repro found.', created_at: '2026-08-01T01:00:00Z' }],
      reviews: [],
    }],
    [2, {
      number: 2,
      kind: 'pr',
      state: 'open',
      updated_at: '2026-08-02T00:00:00Z',
      body: 'Closes #1.',
      labels: [],
      assignees: [],
      comments: [],
      reviews: [{ user: 'carol', state: 'APPROVED', body: 'LGTM', submitted_at: '2026-08-02T01:00:00Z' }],
      head: { sha: 'abc123', ref: 'feat/fix' },
      checks: { pass: 2, fail: 1, pending: 0, failing: ['lint'] },
    }],
    [3, {
      number: 3,
      kind: 'pr',
      state: 'closed',
      updated_at: '2026-07-30T00:00:00Z',
      body: 'Old merged work.',
      labels: [],
      assignees: [],
      comments: [],
      reviews: [],
      merged: true,
    }],
  ]);
  return { items, calls: [], failIssuesList: false, failDetailItems: new Set() };
}

function buildFetch(fx: { items: Map<number, FixtureItem>; calls: string[]; failIssuesList: boolean; failDetailItems: Set<number> }) {
  const { items, calls } = fx;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname;
    const since = u.searchParams.get('since');
    calls.push(path);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '4900',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });

    if (path === '/user/repos') {
      return json([{ full_name: REPO, private: true, archived: false, default_branch: 'main', description: 'The app' }]);
    }
    if (path === `/repos/${REPO}`) {
      return json({ full_name: REPO, private: true, archived: false, default_branch: 'main', description: 'The app' });
    }
    if (path === `/repos/${REPO}/issues` || path === `/repos/${REPO}/issues?state=all`) {
      if (fx.failIssuesList) return json({ message: 'gone' }, 404);
      const list = [...items.values()]
        .filter((it) => !since || it.updated_at > since)
        .map((it) => ({
          number: it.number,
          title: `Item ${it.number}`,
          state: it.state,
          updated_at: it.updated_at,
          ...(it.kind === 'pr' ? { pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${it.number}` } } : {}),
        }));
      return json(list);
    }
    if (path === `/repos/${REPO}/pulls` && u.searchParams.get('state') === 'open') {
      return json(
        [...items.values()]
          .filter((it) => it.kind === 'pr' && it.state === 'open')
          .map((it) => ({ number: it.number, title: `Item ${it.number}`, state: it.state, updated_at: it.updated_at, head: it.head })),
      );
    }
    const issueMatch = path.match(/^\/repos\/acme\/app\/issues\/(\d+)$/);
    const issueCommentsMatch = path.match(/^\/repos\/acme\/app\/issues\/(\d+)\/comments$/);
    const pullMatch = path.match(/^\/repos\/acme\/app\/pulls\/(\d+)$/);
    const pullReviewsMatch = path.match(/^\/repos\/acme\/app\/pulls\/(\d+)\/reviews$/);
    const pullCommentsMatch = path.match(/^\/repos\/acme\/app\/pulls\/(\d+)\/comments$/);
    const checksMatch = path.match(/^\/repos\/acme\/app\/commits\/([0-9a-f]+)\/check-runs$/);
    const statusMatch = path.match(/^\/repos\/acme\/app\/commits\/([0-9a-f]+)\/status$/);

    if (issueMatch) {
      const it = items.get(Number(issueMatch[1]));
      if (!it) return json({ message: 'not found' }, 404);
      if (fx.failDetailItems.has(it.number)) return json({ message: 'gone' }, 404);
      return json({
        number: it.number,
        title: `Item ${it.number}`,
        state: it.state,
        state_reason: null,
        body: it.body,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: it.updated_at,
        closed_at: it.state === 'closed' ? '2026-07-31T00:00:00Z' : null,
        labels: it.labels.map((name) => ({ name })),
        assignees: it.assignees.map((login) => ({ login })),
        milestone: null,
        html_url: `https://github.com/${REPO}/issues/${it.number}`,
        user: { login: 'alice' },
      });
    }
    if (issueCommentsMatch) {
      const it = items.get(Number(issueCommentsMatch[1]));
      if (!it) return json({ message: 'not found' }, 404);
      return json(it.comments.map((c) => ({ user: { login: c.user }, body: c.body, created_at: c.created_at })));
    }
    if (pullMatch) {
      const it = items.get(Number(pullMatch[1]));
      if (!it) return json({ message: 'not found' }, 404);
      return json({
        number: it.number,
        title: `Item ${it.number}`,
        state: it.state,
        body: it.body,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: it.updated_at,
        closed_at: it.state === 'closed' ? '2026-07-31T00:00:00Z' : null,
        labels: [],
        assignees: [],
        milestone: null,
        html_url: `https://github.com/${REPO}/pull/${it.number}`,
        user: { login: 'alice' },
        merged: it.merged ?? false,
        mergeable_state: 'clean',
        review_decision: it.reviews.length > 0 ? it.reviews[0].state : 'NONE',
        draft: false,
        head: it.head ?? { sha: '', ref: '' },
      });
    }
    if (pullReviewsMatch) {
      const it = items.get(Number(pullReviewsMatch[1]));
      if (!it) return json({ message: 'not found' }, 404);
      return json(it.reviews.map((r) => ({ user: { login: r.user }, state: r.state, body: r.body, submitted_at: r.submitted_at })));
    }
    if (pullCommentsMatch) {
      return json([]);
    }
    if (checksMatch || statusMatch) {
      const it = [...items.values()].find(
        (v) => (checksMatch !== null && v.head?.sha === checksMatch[1]) || (statusMatch !== null && v.head?.sha === statusMatch[1]),
      );
      if (!it || !it.checks) return json(checksMatch ? { total_count: 0, check_runs: [] } : { state: 'success', statuses: [] });
      const runState = (conclusion: string) => ({ status: 'completed', conclusion });
      const runs = {
        pass: it.checks.pass,
        fail: it.checks.fail,
        pending: it.checks.pending,
        failing: it.checks.failing,
      };
      const check_runs = [
        ...Array.from({ length: runs.pass }, () => ({ name: 'ok-job', status: 'completed', conclusion: 'success' })),
        ...Array.from({ length: runs.fail }, (_, i) => ({ name: runs.failing[i] ?? 'bad-job', status: 'completed', conclusion: 'failure' })),
        ...Array.from({ length: runs.pending }, () => ({ name: 'run-job', status: 'in_progress', conclusion: null })),
      ];
      void runState;
      return json(checksMatch ? { total_count: check_runs.length, check_runs } : { state: 'pending', statuses: [] });
    }
    return json({ message: 'unhandled ' + path }, 404);
  };
}

function makeCfg(dir: string): GitHubSourceConfig {
  return {
    tokenEnv: 'GH_TOKEN',
    app: null,
    scope: 'repos',
    repos: [REPO],
    dir,
  };
}

async function insertSource(engine: PGLiteEngine, dir: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    ['ghsrc', 'gh', dir, JSON.stringify({ kind: 'github', gh_token_env: 'GH_TOKEN', gh_scope: 'repos', gh_repos: REPO })],
  );
}

async function pageSlugs(engine: PGLiteEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'ghsrc' AND deleted_at IS NULL ORDER BY slug`,
  );
  return rows.map((r) => r.slug);
}

describe('github-source materialize', () => {
  test('bootstrap imports all items, sweep is a no-op, delta picks up changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-sync-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        // 1) Full bootstrap.
        const first = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        expect(first.added).toBe(4); // 3 items + repo card
        expect(first.deleted).toBe(0);
        expect(await pageSlugs(engine)).toEqual([
          'gh/acme/app/1',
          'gh/acme/app/2',
          'gh/acme/app/3',
          'gh/acme/app/index',
        ]);

        // Page content landed with the right fields.
        const prPage = readFileSync(join(dir, 'gh', REPO, '2.md'), 'utf-8');
        expect(prPage).toContain('kind: pr');
        expect(prPage).toContain('checks_fail: 1');
        expect(prPage).toContain('Failing: lint');
        expect(prPage).toContain('[[gh/acme/app/1|#1]]');
        const issuePage = readFileSync(join(dir, 'gh', REPO, '1.md'), 'utf-8');
        expect(issuePage).toContain('### bob · 2026-08-01T01:00:00Z');

        // State file advanced.
        const state = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { last_sweep_at: string; repos: string[] };
        expect(state.last_sweep_at).toBe('2026-08-02T00:00:00Z');
        expect(state.repos).toEqual([REPO]);

        // Sources row touched.
        const row = await engine.executeRaw<{ last_sync_at: string | null }>(`SELECT last_sync_at FROM sources WHERE id = 'ghsrc'`);
        expect(row[0].last_sync_at).not.toBeNull();

        // 2) Sweep with nothing changed: only the open PR is re-fetched
        // (check state can change without bumping updated_at); issues and
        // closed PRs stay skipped.
        const callsBefore = fx.calls.length;
        const second = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc' }, fetchImpl);
        expect(second.status).toBe('synced');
        expect(second.modified).toBe(1);
        expect(second.pagesAffected).toEqual(['gh/acme/app/2']);
        const newDetailCalls = fx.calls.slice(callsBefore).filter((c) => /\/issues\/\d+$|\/pulls\/\d+$/.test(c));
        expect(newDetailCalls.length).toBeGreaterThan(0);
        expect(newDetailCalls.every((c) => c.endsWith('/2'))).toBe(true);

        // 3) One item changes upstream; sweep picks it up (plus the
        // always-refreshed open PR).
        fx.items.get(1)!.updated_at = '2026-08-04T00:00:00Z';
        const third = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc' }, fetchImpl);
        expect(third.status).toBe('synced');
        expect(third.modified).toBe(2);
        expect(third.pagesAffected).toContain('gh/acme/app/1');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('webhook item refresh updates exactly one item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-item-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        fx.items.get(3)!.body = 'Amended after merge.';
        fx.items.get(3)!.updated_at = '2026-08-05T00:00:00Z';
        const before = fx.calls.length;
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          makeCfg(dir),
          { sourceId: 'ghsrc', githubItem: { repo: REPO, number: 3, kind: 'pr' } },
          fetchImpl,
        );
        expect(res.modified).toBe(1);
        expect(res.pagesAffected).toEqual(['gh/acme/app/3']);
        // Only the item endpoints were hit (plus scope discovery).
        const itemCalls = fx.calls.slice(before).filter((c) => /\/issues\/3$|\/pulls\/3($|\/)/.test(c));
        expect(itemCalls.length).toBeGreaterThan(0);
        const page = readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8');
        expect(page).toContain('Amended after merge.');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deleted webhook item removes its page without fetching a missing item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-item-delete-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        const before = fx.calls.length;
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          { ...makeCfg(dir), repos: [REPO.toUpperCase()] },
          { sourceId: 'ghsrc', githubItem: { repo: REPO.toUpperCase(), number: 3, kind: 'pr', deleted: true } },
          fetchImpl,
        );
        expect(res.deleted).toBe(1);
        expect(fx.calls.length).toBe(before);
        expect(await pageSlugs(engine)).not.toContain('gh/acme/app/3');
        expect(existsSync(join(dir, 'gh', REPO, '3.md'))).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('import rejection preserves page and sweep cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-import-fail-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        const oldPage = readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8');
        fx.items.get(3)!.body = 'x'.repeat(5_000_001);
        fx.items.get(3)!.updated_at = '2026-08-07T00:00:00Z';
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          makeCfg(dir),
          { sourceId: 'ghsrc', noExtract: true, noEmbed: true },
          fetchImpl,
        );
        expect(res.status).toBe('partial');
        expect(res.failedFiles).toBeGreaterThan(0);
        expect(readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8')).toBe(oldPage);
        const state = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { last_sweep_at: string };
        expect(state.last_sweep_at).toBe('2026-08-02T00:00:00Z');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('webhook import rejection preserves existing page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-webhook-fail-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        const oldPage = readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8');
        fx.items.get(3)!.body = 'x'.repeat(5_000_001);
        await expect(runGitHubSync(
          engine,
          'ghsrc',
          makeCfg(dir),
          { sourceId: 'ghsrc', noExtract: true, noEmbed: true, githubItem: { repo: REPO, number: 3, kind: 'pr' } },
          fetchImpl,
        )).rejects.toThrow('File too large');
        expect(readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8')).toBe(oldPage);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('item refresh outside scope is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-scope-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          makeCfg(dir),
          { sourceId: 'ghsrc', githubItem: { repo: 'other/org', number: 1, kind: 'issue' } },
          fetchImpl,
        );
        expect(res.status).toBe('up_to_date');
        expect(res.added + res.modified).toBe(0);
        expect(existsSync(join(dir, 'gh', 'other', 'org', '1.md'))).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('newly added repo gets history bootstrap despite source cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-new-repo-'));
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const path = u.pathname;
      const json = (body: unknown): Response => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '9999999999' },
      });
      calls.push(url);
      if (path === '/repos/acme/one/issues') return json([]);
      if (path === '/repos/acme/one/pulls') return json([]);
      if (path === '/repos/acme/one') return json({ full_name: 'acme/one', private: false, archived: false, default_branch: 'main', description: null });
      if (path === '/repos/acme/two/issues') {
        if (u.searchParams.has('since')) return json([]);
        return json([{
          number: 7,
          title: 'Historical issue',
          state: 'open',
          updated_at: '2026-08-01T00:00:00Z',
          body: 'Existing before repo was added.',
          html_url: 'https://github.com/acme/two/issues/7',
          created_at: '2026-07-01T00:00:00Z',
          labels: [],
          assignees: [],
          milestone: null,
          user: { login: 'alice' },
        }]);
      }
      if (path === '/repos/acme/two/pulls') return json([]);
      if (path === '/repos/acme/two') return json({ full_name: 'acme/two', private: false, archived: false, default_branch: 'main', description: null });
      if (path === '/repos/acme/two/issues/7') return json({
        number: 7,
        title: 'Historical issue',
        state: 'open',
        state_reason: null,
        body: 'Existing before repo was added.',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        closed_at: null,
        labels: [],
        assignees: [],
        milestone: null,
        html_url: 'https://github.com/acme/two/issues/7',
        user: { login: 'alice' },
      });
      if (path === '/repos/acme/two/issues/7/comments') return json([]);
      return new Response(JSON.stringify({ message: 'unexpected ' + path }), { status: 404 });
    };
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', { ...makeCfg(dir), repos: ['acme/one'] }, {
          sourceId: 'ghsrc', full: true, noExtract: true, noEmbed: true,
        }, fetchImpl);
        const res = await runGitHubSync(engine, 'ghsrc', { ...makeCfg(dir), repos: ['acme/one', 'acme/two'] }, {
          sourceId: 'ghsrc', noExtract: true, noEmbed: true,
        }, fetchImpl);
        expect(res.added).toBe(2); // new item plus new repo card
        expect(await pageSlugs(engine)).toContain('gh/acme/two/7');
        const newRepoIssuesCall = calls.find((url) => url.includes('/repos/acme/two/issues?'));
        expect(newRepoIssuesCall).toBeDefined();
        expect(newRepoIssuesCall).not.toContain('since=');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('full reconcile deletes pages for vanished items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-recon-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        // Item 3 disappears upstream entirely.
        fx.items.delete(3);
        const res = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        expect(res.deleted).toBe(1);
        const slugs = await pageSlugs(engine);
        expect(slugs).not.toContain('gh/acme/app/3');
        expect(existsSync(join(dir, 'gh', REPO, '3.md'))).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delta sweep picks up a closed PR that changed upstream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-closedpr-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        // Closed PR 3 gets a comment upstream.
        fx.items.get(3)!.updated_at = '2026-08-06T00:00:00Z';
        fx.items.get(3)!.comments = [{ user: 'bob', body: 'Post-merge follow-up.', created_at: '2026-08-06T00:00:00Z' }];
        const res = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc' }, fetchImpl);
        // 2 = the changed closed PR + the always-refreshed open PR 2.
        expect(res.modified).toBe(2);
        expect(res.pagesAffected).toContain('gh/acme/app/3');
        const page = readFileSync(join(dir, 'gh', REPO, '3.md'), 'utf-8');
        expect(page).toContain('Post-merge follow-up.');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a repo that errors mid-reconcile keeps its pages (no bulk-delete on API failure)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-fail-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        const before = await pageSlugs(engine);
        expect(before.length).toBe(4);
        // The repo's issue list now fails; a full reconcile must NOT purge its pages.
        fx.failIssuesList = true;
        const res = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        expect(res.status).toBe('partial');
        expect(res.deleted).toBe(0);
        expect(await pageSlugs(engine)).toEqual(before);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed item does not advance the sweep cursor and is retried next run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-cursor-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        // Item 1's detail fetch fails during bootstrap.
        fx.failDetailItems.add(1);
        const partial = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        expect(partial.status).toBe('partial');
        expect(partial.failedFiles).toBeGreaterThan(0);
        // Pass 1 still materialized a list page for item 1 (fast path);
        // the failed detail fetch leaves it marked detail_fetched: false.
        expect(existsSync(join(dir, 'gh', REPO, '1.md'))).toBe(true);
        expect(readFileSync(join(dir, 'gh', REPO, '1.md'), 'utf-8')).toContain('detail_fetched: false');
        // Items 2 and 3 imported despite the failure.
        expect(existsSync(join(dir, 'gh', REPO, '2.md'))).toBe(true);
        expect(existsSync(join(dir, 'gh', REPO, '3.md'))).toBe(true);
        // Cursor must NOT have advanced past the failed item.
        const state = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { last_sweep_at?: string };
        expect(state.last_sweep_at ?? '').toBe('');

        // Failure clears; the next sweep re-enumerates from the old cursor,
        // retries item 1's detail fetch and upgrades the page.
        fx.failDetailItems.delete(1);
        const retry = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc' }, fetchImpl);
        expect(retry.status).toBe('synced');
        // Item 1 upgrades to full detail; item 2 is an open PR re-rendered
        // every sweep (check state).
        expect(retry.modified).toBe(2);
        expect(retry.added).toBe(0);
        expect(readFileSync(join(dir, 'gh', REPO, '1.md'), 'utf-8')).toContain('detail_fetched: true');
        const state2 = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { last_sweep_at?: string };
        expect(state2.last_sweep_at).toBe('2026-08-02T00:00:00Z');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('open PR check changes are picked up even when updated_at is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-checks-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true }, fetchImpl);
        // Checks flip to green; the PR's updated_at does NOT move, so the
        // since-filtered issues list never lists it — the open-PR union must.
        fx.items.get(2)!.checks = { pass: 3, fail: 0, pending: 0, failing: [] };
        const res = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc' }, fetchImpl);
        expect(res.pagesAffected).toContain('gh/acme/app/2');
        const page = readFileSync(join(dir, 'gh', REPO, '2.md'), 'utf-8');
        expect(page).toContain('checks_pass: 3');
        expect(page).toContain('checks_fail: 0');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a repo that fails its sweep is not state-listed and bootstraps on the next run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-failed-repo-'));
    const calls: string[] = [];
    let failTwo = true;
    const fetchImpl = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const path = u.pathname;
      calls.push(url);
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
        status,
        headers: { 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '9999999999' },
      });
      if (path === '/repos/acme/one/issues') return json([]);
      if (path === '/repos/acme/one/pulls') return json([]);
      if (path === '/repos/acme/one') return json({ full_name: 'acme/one', private: false, archived: false, default_branch: 'main', description: null });
      if (path === '/repos/acme/two/issues') {
        if (failTwo) return json({ message: 'boom' }, 500);
        if (u.searchParams.has('since')) return json([]);
        return json([{
          number: 7,
          title: 'Historical issue',
          state: 'open',
          updated_at: '2026-08-01T00:00:00Z',
          body: 'Existed before the repo ever swept successfully.',
          html_url: 'https://github.com/acme/two/issues/7',
          created_at: '2026-07-01T00:00:00Z',
          labels: [],
          assignees: [],
          milestone: null,
          user: { login: 'alice' },
        }]);
      }
      if (path === '/repos/acme/two/pulls') return json([]);
      if (path === '/repos/acme/two') return json({ full_name: 'acme/two', private: false, archived: false, default_branch: 'main', description: null });
      if (path === '/repos/acme/two/issues/7') return json({
        number: 7,
        title: 'Historical issue',
        state: 'open',
        state_reason: null,
        body: 'Existed before the repo ever swept successfully.',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        closed_at: null,
        labels: [],
        assignees: [],
        milestone: null,
        html_url: 'https://github.com/acme/two/issues/7',
        user: { login: 'alice' },
      });
      if (path === '/repos/acme/two/issues/7/comments') return json([]);
      return new Response(JSON.stringify({ message: 'unexpected ' + path }), { status: 404 });
    };
    const cfg = { ...makeCfg(dir), repos: ['acme/one', 'acme/two'] };
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        // Sweep 1: acme/one succeeds and advances the cursor; acme/two fails.
        // It must NOT enter state.repos — that would mark it bootstrapped.
        await runGitHubSync(engine, 'ghsrc', { ...cfg, repos: ['acme/one'] }, { sourceId: 'ghsrc', full: true, noExtract: true, noEmbed: true }, fetchImpl);
        const partial = await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, fetchImpl);
        expect(partial.status).toBe('partial');
        const state1 = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { repos: string[] };
        expect(state1.repos).toEqual(['acme/one']);

        // Sweep 2: acme/two recovers and gets a since-less history bootstrap
        // despite the source cursor being ahead of its items.
        failTwo = false;
        const res = await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, fetchImpl);
        expect(res.added).toBe(2); // historical item + repo card
        expect(await pageSlugs(engine)).toContain('gh/acme/two/7');
        const twoIssueLists = calls.filter((u) => u.includes('/repos/acme/two/issues?'));
        expect(twoIssueLists.some((u) => !u.includes('since='))).toBe(true);
        const state2 = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { repos: string[] };
        expect(state2.repos).toEqual(['acme/one', 'acme/two']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('webhook single-item refresh does not persist discovered scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-webhook-scope-'));
    const fx = makeFixture();
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        // Auto scope + mixed-case webhook payload: the refresh materializes
        // the lowercase page but must NOT write state.repos — only a
        // successful sweep may mark a repo as bootstrapped.
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          { ...makeCfg(dir), scope: 'auto', repos: [] },
          { sourceId: 'ghsrc', githubItem: { repo: 'Acme/App', number: 1, kind: 'issue' } },
          fetchImpl,
        );
        expect(res.modified).toBe(1);
        expect(existsSync(join(dir, 'gh', 'acme/app', '1.md'))).toBe(true);
        expect(existsSync(join(dir, '.github-source.json'))).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mixed-case discovery materializes lowercase paths and state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-case-'));
    const fx = makeFixture();
    const inner = buildFetch(fx);
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === '/user/repos') {
        // Canonical GitHub casing differs from the lowercase page layout.
        return new Response(
          JSON.stringify([{ full_name: 'Acme/App', private: true, archived: false, default_branch: 'main', description: 'The app' }]),
          { status: 200, headers: { 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '9999999999' } },
        );
      }
      return inner(url, init);
    };
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        const res = await runGitHubSync(
          engine,
          'ghsrc',
          { ...makeCfg(dir), scope: 'auto', repos: [] },
          { sourceId: 'ghsrc', full: true },
          fetchImpl,
        );
        expect(res.added).toBe(4);
        expect(existsSync(join(dir, 'gh', 'acme/app', '1.md'))).toBe(true);
        // The slug namespace and the state file both carry the folded form
        // (the FS may be case-insensitive, so paths can't pin casing).
        expect(await pageSlugs(engine)).toContain('gh/acme/app/1');
        const state = JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { repos: string[] };
        expect(state.repos).toEqual(['acme/app']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('large PGLite sync refuses an undrainable embed-backfill job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghsrc-embed-defer-'));
    const fx = makeFixture();
    for (let n = 10; n < 111; n++) {
      fx.items.set(n, {
        number: n,
        kind: 'issue',
        state: 'open',
        updated_at: '2026-08-01T00:00:00Z',
        body: `Filler issue ${n}.`,
        labels: [],
        assignees: [],
        comments: [],
        reviews: [],
      });
    }
    const fetchImpl = buildFetch(fx);
    try {
      await insertSource(engine, dir);
      await withEnv({ GH_TOKEN: 'test-token' }, async () => {
        const res = await runGitHubSync(engine, 'ghsrc', makeCfg(dir), { sourceId: 'ghsrc', full: true, noExtract: true }, fetchImpl);
        expect(res.added).toBeGreaterThan(100);
        expect(res.embedded).toBe(0); // inline embed skipped by the size gate
        const jobs = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs WHERE name = 'embed-backfill'`,
        );
        expect(jobs).toEqual([]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
