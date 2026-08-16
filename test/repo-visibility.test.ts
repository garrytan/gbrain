/**
 * repo-visibility.ts — parser union, gh-403 classification, the full ladder
 * verdict matrix [D4]/[D14], and the private-only verdict cache [D11].
 * Everything injected (runner + fetchImpl + env) — no network, no gh, no git.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anonProbeUrl,
  classifyGh403,
  githubOwnerRepoString,
  parseGithubOwnerRepo,
  readCachedPrivateVerdict,
  verifyRepoVisibility,
  writeVisibilityCache,
  type ExecRunner,
  type RepoVisibilityVerdict,
} from '../src/core/repo-visibility.ts';

const URL_GH = 'https://github.com/acme-example/widget-co.git';

// ── Fake IO ─────────────────────────────────────────────────────────────────

/** Runner keyed on the binary: gh → opts.gh, git ls-remote → opts.git. */
function fakeRunner(opts: {
  gh?: { code: number; stdout?: string; stderr?: string };
  git?: { code: number; stderr?: string };
}): ExecRunner {
  return async (argv: string[]) => {
    if (argv[0] === 'gh') {
      const r = opts.gh ?? { code: 127, stderr: 'ENOENT' };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    const r = opts.git ?? { code: 0 };
    return { code: r.code, stdout: r.code === 0 ? 'abc123\tHEAD\n' : '', stderr: r.stderr ?? '' };
  };
}

function fakeFetch(res: {
  status: number;
  contentType?: string;
  wwwAuthenticate?: string;
  githubRequestId?: boolean;
  body?: string;
  throws?: boolean;
}): typeof fetch {
  return (async () => {
    if (res.throws) throw new Error('network unreachable');
    const headers = new Headers();
    if (res.contentType) headers.set('content-type', res.contentType);
    if (res.wwwAuthenticate) headers.set('www-authenticate', res.wwwAuthenticate);
    if (res.githubRequestId) headers.set('x-github-request-id', 'ABCD:1234');
    return new Response(res.body ?? '', { status: res.status, headers });
  }) as unknown as typeof fetch;
}

const GH_ADVERTISEMENT = '001e# service=git-upload-pack\n0000';
const PROXY_403 = 'gh: HTTP 403 {"message":"GitHub access to this repository is not enabled for this session. Use add_repo to request access."}';
const GITHUB_403 = 'gh: HTTP 403 {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest"}';

// ── Parser union ────────────────────────────────────────────────────────────

describe('parseGithubOwnerRepo (canonical union grammar)', () => {
  test.each([
    ['https://github.com/a/b', 'a', 'b'],
    ['https://github.com/a/b.git', 'a', 'b'],
    ['https://github.com/a/b/', 'a', 'b'],
    ['git@github.com:a/b.git', 'a', 'b'],
    ['git@github.com:a/b', 'a', 'b'],
    ['ssh://git@github.com/a/b', 'a', 'b'],
    ['ssh://git@github.com/a/b.git/', 'a', 'b'],
    ['  https://github.com/a/b.git  ', 'a', 'b'],
  ])('%s → %s/%s', (url, owner, repo) => {
    expect(parseGithubOwnerRepo(url)).toEqual({ owner, repo });
    expect(githubOwnerRepoString(url)).toBe(`${owner}/${repo}`);
  });

  test.each([['https://gitlab.com/a/b'], ['/tmp/origin.git'], ['git@example.com:a/b.git'], ['']])(
    '%s → null',
    (url) => {
      expect(parseGithubOwnerRepo(url)).toBeNull();
    },
  );
});

describe('anonProbeUrl', () => {
  test('github forms normalize to the canonical .git/info/refs URL', () => {
    const want = 'https://github.com/a/b.git/info/refs?service=git-upload-pack';
    expect(anonProbeUrl('https://github.com/a/b')).toBe(want);
    expect(anonProbeUrl('git@github.com:a/b.git')).toBe(want);
    expect(anonProbeUrl('ssh://git@github.com/a/b')).toBe(want);
  });
  test('non-github https appends info/refs; ssh/file get null', () => {
    expect(anonProbeUrl('https://git.example.com/a/b.git/')).toBe(
      'https://git.example.com/a/b.git/info/refs?service=git-upload-pack',
    );
    expect(anonProbeUrl('git@example.com:a/b.git')).toBeNull();
    expect(anonProbeUrl('/tmp/origin.git')).toBeNull();
  });
});

// ── 403 classification ──────────────────────────────────────────────────────

describe('classifyGh403', () => {
  test('GitHub-shaped JSON (message + documentation_url) → github', () => {
    expect(classifyGh403(GITHUB_403)).toBe('github');
  });
  test('session-scoping / proxy phrases → proxy', () => {
    expect(classifyGh403(PROXY_403)).toBe('proxy');
    expect(classifyGh403('x-deny-reason: host_not_allowed')).toBe('proxy');
    expect(classifyGh403('remote: access denied by the git proxy: repo is not in this session')).toBe('proxy');
  });
  test('bare text → unknown', () => {
    expect(classifyGh403('HTTP 403 Forbidden')).toBe('unknown');
  });
});

// ── Ladder verdict matrix ───────────────────────────────────────────────────

async function ladder(opts: {
  url?: string;
  gh?: { code: number; stdout?: string; stderr?: string };
  git?: { code: number; stderr?: string };
  probe?: Parameters<typeof fakeFetch>[0];
  env?: Record<string, string | undefined>;
}): Promise<RepoVisibilityVerdict> {
  return verifyRepoVisibility({
    originUrl: opts.url ?? URL_GH,
    runner: fakeRunner({ ...(opts.gh ? { gh: opts.gh } : {}), ...(opts.git ? { git: opts.git } : {}) }),
    fetchImpl: fakeFetch(opts.probe ?? { status: 500 }),
    env: opts.env ?? {},
    timeoutMs: 2_000,
  });
}

describe('verifyRepoVisibility — verdict matrix', () => {
  test('rung 1 REST true → private/rest (CRITICAL regression parity with the old probe)', async () => {
    const v = await ladder({ gh: { code: 0, stdout: 'true\n' } });
    expect(v.verdict).toBe('private');
    expect(v.verdict === 'private' && v.via).toBe('rest');
  });

  test('rung 1 REST false → public/rest, refuse (CRITICAL regression parity)', async () => {
    const v = await ladder({ gh: { code: 0, stdout: 'false\n' } });
    expect(v.verdict).toBe('public');
  });

  test('gh missing (127) → git rungs: ls-remote ok + github-attributed 401 → private/git-protocol', async () => {
    const v = await ladder({
      gh: { code: 127, stderr: 'ENOENT' },
      git: { code: 0 },
      probe: { status: 401, wwwAuthenticate: 'Basic realm="GitHub"', githubRequestId: true },
    });
    expect(v.verdict).toBe('private');
    expect(v.verdict === 'private' && v.via).toBe('git-protocol');
  });

  test('[D14] github origin: a 401 with ONLY a www-authenticate challenge (RFC-mandated on every 401, middleboxes included) is NOT attribution → unverifiable', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 401, wwwAuthenticate: 'Basic realm="corp-proxy"' },
    });
    expect(v.verdict).toBe('unverifiable');
  });

  test('[D14] non-github origin: a 401 challenge is NOT trustable attribution (a middlebox 401s identically) → unverifiable, fail-closed', async () => {
    const v = await ladder({
      url: 'https://git.example.com/team/brain.git',
      git: { code: 0 },
      probe: { status: 401, wwwAuthenticate: 'Basic realm="git"' },
    });
    expect(v.verdict).toBe('unverifiable');
  });

  test('proxy-403 REST → git rungs, and the rung log names the proxy', async () => {
    const v = await ladder({
      gh: { code: 1, stderr: PROXY_403 },
      git: { code: 0 },
      probe: { status: 401, wwwAuthenticate: 'Basic realm="GitHub"', githubRequestId: true },
    });
    expect(v.verdict).toBe('private');
    expect(v.rungs.map((r) => r.outcome).join(' ')).toContain('egress proxy');
  });

  test('[D14] un-attributed 401 (middlebox) → unverifiable, NEVER private', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 401 }, // no www-authenticate, no github headers
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.detail).toContain('un-attributed');
  });

  test('404 with x-github-request-id counts as attributed for github origins', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 404, githubRequestId: true },
    });
    expect(v.verdict).toBe('private');
  });

  test('[D4] 200 with advertisement proof (content-type) → public/git-protocol', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 200, contentType: 'application/x-git-upload-pack-advertisement' },
    });
    expect(v.verdict).toBe('public');
  });

  test('[D4] 200 with pkt-line body proof (no content-type) → public', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 200, body: GH_ADVERTISEMENT },
    });
    expect(v.verdict).toBe('public');
  });

  test('[D4] 200 WITHOUT proof (SSO login HTML) → unverifiable, never a false PUBLIC', async () => {
    const v = await ladder({
      url: 'https://git.example.com/team/brain.git',
      git: { code: 0 },
      probe: { status: 200, contentType: 'text/html', body: '<html>Sign in</html>' },
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.detail).toContain('advertisement');
  });

  test('200 with proof behind a credential-injecting proxy → unverifiable + actionable message', async () => {
    const v = await ladder({
      gh: { code: 1, stderr: PROXY_403 },
      git: { code: 0 },
      probe: { status: 200, contentType: 'application/x-git-upload-pack-advertisement' },
      env: { GH_TOKEN: 'proxy-injected' },
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.detail).toContain('GBRAIN_ALLOW_UNVERIFIED_REMOTE');
  });

  test('ls-remote failure → unverifiable ("a push would fail anyway")', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 128, stderr: 'fatal: could not read Username' },
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.detail).toContain('push would fail');
  });

  test('anon probe network error → unverifiable with rung log', async () => {
    const v = await ladder({ gh: { code: 127 }, git: { code: 0 }, probe: { status: 0, throws: true } });
    expect(v.verdict).toBe('unverifiable');
    expect(v.rungs.some((r) => r.rung === 'anon-refs' && r.outcome.includes('network error'))).toBe(true);
  });

  test('ssh non-github origin: readable but no probe surface → unverifiable', async () => {
    const v = await ladder({ url: 'git@example.com:team/brain.git', git: { code: 0 }, probe: { status: 200 } });
    expect(v.verdict).toBe('unverifiable');
    expect(v.rungs.some((r) => r.outcome.includes('no https probe surface'))).toBe(true);
  });

  test('anon probe answering an unexpected status (500) → unverifiable, names the status', async () => {
    const v = await ladder({
      gh: { code: 127 },
      git: { code: 0 },
      probe: { status: 500 },
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.detail).toContain('HTTP 500');
    expect(v.detail).toContain('GBRAIN_ALLOW_UNVERIFIED_REMOTE');
  });

  test('rung timeout is recorded and degrades to unverifiable, never hangs', async () => {
    const hangingRunner: ExecRunner = () => new Promise(() => {}); // never resolves
    const v = await verifyRepoVisibility({
      originUrl: URL_GH,
      runner: hangingRunner,
      fetchImpl: fakeFetch({ status: 500 }),
      env: {},
      timeoutMs: 50,
    });
    expect(v.verdict).toBe('unverifiable');
    expect(v.rungs.some((r) => r.outcome.includes('timeout'))).toBe(true);
  });
});

// ── Verdict cache [D11] ─────────────────────────────────────────────────────

describe('visibility cache (private-only, TTL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-cache-'));
  const path = join(dir, 'visibility-cache.json');
  const privateVerdict: RepoVisibilityVerdict = { verdict: 'private', via: 'rest', detail: 'x', rungs: [] };
  const publicVerdict: RepoVisibilityVerdict = { verdict: 'public', via: 'rest', detail: 'x', rungs: [] };

  test('private verdict round-trips within TTL; expired entry misses', () => {
    const t0 = Date.now();
    writeVisibilityCache(URL_GH, privateVerdict, { now: t0, path });
    expect(readCachedPrivateVerdict(URL_GH, { now: t0 + 60_000, path })?.verdict).toBe('private');
    expect(readCachedPrivateVerdict(URL_GH, { now: t0 + 61 * 60_000, path })).toBeNull();
  });

  test('public and unverifiable verdicts are NEVER written', () => {
    rmSync(path, { force: true });
    writeVisibilityCache(URL_GH, publicVerdict, { path });
    writeVisibilityCache(URL_GH, { verdict: 'unverifiable', detail: 'x', rungs: [] }, { path });
    expect(readCachedPrivateVerdict(URL_GH, { path })).toBeNull();
  });

  test('corrupt cache file is a miss, and the next write recovers it', () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(readCachedPrivateVerdict(URL_GH, { path })).toBeNull();
    const t0 = Date.now();
    writeVisibilityCache(URL_GH, privateVerdict, { now: t0, path });
    expect(readCachedPrivateVerdict(URL_GH, { now: t0, path })?.verdict).toBe('private');
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });

  test('expired entries are pruned on write', () => {
    const t0 = Date.now();
    rmSync(path, { force: true });
    writeVisibilityCache('https://github.com/a/old.git', privateVerdict, { now: t0 - 2 * 60 * 60_000, path });
    writeVisibilityCache(URL_GH, privateVerdict, { now: t0, path });
    const map = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(map)).toEqual([URL_GH]);
  });
});
