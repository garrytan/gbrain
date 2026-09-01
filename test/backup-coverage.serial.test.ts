/**
 * backup-coverage.test.ts — pins src/core/backup/coverage.ts:
 * computeBackupCoverage asset classification (source repos probed via real
 * tmp git fixtures, bootstrap workspace via the receipt file, db_only tiering
 * via gbrain.yml, the DB-only-brain worst case), the getBackupStatus cache
 * choke point (probed persists, probe-less never persists, failed compute
 * never clobbers), and the serve-side single-flight refresher.
 *
 * Engine is a minimal executeRaw stub cast to BrainEngine (no real PGLite);
 * loadAllSources + countLivePages are distinguished by SQL substring.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import {
  computeBackupCoverage,
  getBackupStatus,
  maybeRefreshBackupStatusInProcess,
  __resetBackupRefreshForTests,
} from '../src/core/backup/coverage.ts';
import { pushStatusPathForRoot } from '../src/core/workspace-push.ts';
import {
  saveBridgeState,
  SKILLPACK_BRIDGE_SCHEMA_VERSION,
} from '../src/core/skillpack/bridge-state.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  __setBackupIntervalForTests,
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  invalidateBackupStatus,
  loadBackupStatus,
  saveBackupStatus,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const ENV_KEYS = [
  'GBRAIN_HOME',
  'GBRAIN_BACKUP_CHECK',
  'GBRAIN_BACKUP_CHECK_DAYS',
  'GBRAIN_BRAIN_ID',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'GBRAIN_SOURCE',
  'GBRAIN_SKIP_STARTUP_HOOKS',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let statusPath: string;

const home = () => join(tmp, '.gbrain');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-bkcov-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // configDir() === tmp/.gbrain
  statusPath = join(home(), 'backup-status.json');
  __setBackupStatusPathForTests(statusPath);
  __setBackupNagStatePathForTests(join(home(), 'backup-nag-state.json'));
  __resetBackupRefreshForTests();
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  __resetBackupRefreshForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function g(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'user.name', 'Test User']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitFile(dir: string, name: string, content: string, msg: string): void {
  writeFileSync(join(dir, name), content);
  g(dir, ['add', '.']);
  g(dir, ['commit', '-m', msg]);
}

/** SourceRow shape per src/core/sources-load.ts:192-226. */
function srcRow(id: string, localPath: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    local_path: localPath,
    last_commit: null,
    last_sync_at: null,
    config: {},
    created_at: new Date(),
    archived: false,
    newest_content_at: null,
    ...extra,
  };
}

function stubEngine(opts: {
  kind?: 'pglite' | 'postgres';
  sources?: unknown[];
  pages?: number;
  onCall?: () => void;
} = {}): BrainEngine {
  return {
    kind: opts.kind ?? 'pglite',
    executeRaw: async (sql: string) => {
      opts.onCall?.();
      if (sql.includes('FROM pages')) return [{ n: opts.pages ?? 0 }];
      if (sql.includes('FROM sources')) return opts.sources ?? [];
      return [];
    },
  } as unknown as BrainEngine;
}

function writeReceipt(ws: string, extra: Record<string, unknown> = {}): void {
  const dir = join(home(), 'bootstrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'receipt.json'),
    JSON.stringify(
      {
        receipt_version: 1,
        workspace_dir: ws,
        source_id: 'workspace',
        agent_name: 'agent-example',
        created_at: new Date().toISOString(),
        created_by: 'test',
        brain_created_by_bootstrap: false,
        created_paths: [],
        registrations: [],
        ...extra,
      },
      null,
      2,
    ),
  );
}

/** Hand-built cache verdict that passes loadBackupStatus validation. */
function mkStatus(overall: 'ok' | 'warn', checkedAt: string): BackupStatus {
  const noRemote = overall === 'warn' ? 1 : 0;
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: checkedAt,
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall,
    totals: {
      assets: noRemote,
      no_remote: noRemote,
      unpushed: 0,
      failing: 0,
      recoverable_repos: 0,
      pages_at_risk: 0,
    },
    assets:
      overall === 'warn'
        ? [{ kind: 'source_repo', id: 'stale-example', state: 'no_remote', fix_argv: null }]
        : [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(fn: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

// ── Source-repo probing ──────────────────────────────────────────────────────

describe('computeBackupCoverage — source repos', () => {
  test('repo without origin → no_remote asset, overall warn', async () => {
    const repo = join(tmp, 'repo-a');
    initRepo(repo);
    commitFile(repo, 'a.md', 'hello', 'init');
    const engine = stubEngine({ sources: [srcRow('src-a', repo)] });

    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'source_repo');
    expect(asset).toBeDefined();
    expect(asset?.id).toBe('src-a');
    expect(asset?.state).toBe('no_remote');
    expect(asset?.detail).toContain('git remote add origin');
    expect(asset?.fix_argv).toBeNull(); // no bootstrap manifest → recipe only
    expect(s.overall).toBe('warn');
    expect(s.totals.no_remote).toBe(1);
  });

  test('repo one commit ahead of a local bare origin → unpushed, overall stays ok', async () => {
    const bare = join(tmp, 'bare.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'pipe', 'pipe'] });
    const work = join(tmp, 'work');
    initRepo(work);
    commitFile(work, 'a.md', 'baseline', 'baseline');
    g(work, ['remote', 'add', 'origin', bare]);
    g(work, ['push', '-u', 'origin', 'main']);
    commitFile(work, 'b.md', 'more', 'ahead commit');

    const engine = stubEngine({ sources: [srcRow('src-work', work)] });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'source_repo');
    expect(asset?.state).toBe('unpushed');
    expect(asset?.ahead).toBeGreaterThanOrEqual(1);
    expect(asset?.detail).toContain('ahead of origin/');
    expect(s.totals.unpushed).toBe(1);
    expect(s.totals.no_remote).toBe(0);
    expect(s.overall).toBe('ok'); // unpushed does NOT flip warn
  });

  test('localGitProbes:false → unknown assets and getBackupStatus never persists', async () => {
    const repo = join(tmp, 'repo-np');
    initRepo(repo);
    commitFile(repo, 'a.md', 'x', 'init');
    const engine = stubEngine({ sources: [srcRow('src-np', repo)] });

    const s = await getBackupStatus(engine, { localGitProbes: false });

    const asset = s.assets.find((a) => a.kind === 'source_repo');
    expect(asset?.state).toBe('unknown');
    expect(asset?.detail).toBe('probes_skipped');
    expect(existsSync(statusPath)).toBe(false); // probe-less computes are never persisted
  });

  test('archived + null-path sources are skipped; a MISSING local_path surfaces as an unknown asset', async () => {
    const repo = join(tmp, 'repo-archived');
    initRepo(repo);
    commitFile(repo, 'a.md', 'x', 'init');
    const engine = stubEngine({
      sources: [
        srcRow('archived-src', repo, { archived: true }),
        srcRow('ghost-src', join(tmp, 'no-such-dir')),
        srcRow('null-path-src', null),
      ],
    });

    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    // The most disk-loss-adjacent state of all: a registered path that is GONE
    // is surfaced ('unknown' — it may live on another machine), never silently
    // skipped. Archived and null-path rows still produce nothing.
    const repos = s.assets.filter((a) => a.kind === 'source_repo');
    expect(repos).toHaveLength(1);
    expect(repos[0]?.id).toBe('ghost-src');
    expect(repos[0]?.state).toBe('unknown');
    expect(repos[0]?.detail).toBe('local_path not found on this machine');
    expect(repos[0]?.fix_argv).toBeNull();
    expect(s.totals.assets).toBe(1); // the missing-path asset IS counted
    expect(s.overall).toBe('ok'); // unknown never flips warn
  });

  test('remote added but NOTHING pushed → no_remote (nothing pushed), overall warn', async () => {
    // The half-completed `git remote add` state: origin exists but
    // origin/<branch> is unresolvable — zero recoverable history on the
    // remote, so it must WARN, not read ok.
    const bare = join(tmp, 'never-pushed-origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'pipe', 'pipe'] });
    const work = join(tmp, 'never-pushed');
    initRepo(work);
    commitFile(work, 'a.md', 'unpushed history', 'init');
    g(work, ['remote', 'add', 'origin', bare]); // deliberately NO push

    const engine = stubEngine({ sources: [srcRow('src-never-pushed', work)] });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'source_repo');
    expect(asset?.id).toBe('src-never-pushed');
    expect(asset?.state).toBe('no_remote');
    expect(asset?.detail).toContain('nothing pushed');
    expect(asset?.detail).toContain('git push -u origin');
    expect(asset?.fix_argv).toBeNull();
    expect(s.overall).toBe('warn');
    expect(s.totals.no_remote).toBe(1);
    expect(s.totals.recoverable_repos).toBe(0); // nothing on the remote to recover
  });

  test('gbrain.yml storage.db_only tiering → info asset with the export fix', async () => {
    const repo = join(tmp, 'repo-tiered');
    initRepo(repo);
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - private/\n');
    commitFile(repo, 'a.md', 'x', 'init');
    const engine = stubEngine({ sources: [srcRow('tiered-src', repo)] });

    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'db_only');
    expect(asset).toBeDefined();
    expect(asset?.id).toBe('tiered-src');
    expect(asset?.state).toBe('info');
    expect(asset?.fix_argv).toEqual(['gbrain', 'export', '--dir', '<backup-dir>']);
  });
});

// ── DB-only brain + empty brain ──────────────────────────────────────────────

describe('computeBackupCoverage — db_content and empty brain', () => {
  test('pglite brain with pages but no sources/receipt → db_content no_remote, pages at risk', async () => {
    const engine = stubEngine({ kind: 'pglite', pages: 42 });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'db_content');
    expect(asset?.state).toBe('no_remote');
    expect(asset?.detail).toContain('42 pages');
    expect(asset?.fix_argv).toEqual(['gbrain', 'bootstrap', 'repo']);
    expect(s.totals.pages_at_risk).toBe(42);
    expect(s.overall).toBe('warn');
  });

  test('postgres brain with pages but no sources/receipt → db_content info, overall ok', async () => {
    const engine = stubEngine({ kind: 'postgres', pages: 42 });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'db_content');
    expect(asset?.state).toBe('info');
    expect(s.totals.pages_at_risk).toBe(0);
    expect(s.overall).toBe('ok');
  });

  test('empty brain (0 pages, no sources, no receipt) → ok and never warn', async () => {
    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    expect(s.overall).toBe('ok');
    expect(s.totals.assets).toBe(0);
    expect(s.totals.pages_at_risk).toBe(0);
    // Zero assets, or only info assets — never a warn-carrying state.
    expect(s.assets.every((a) => a.state === 'info')).toBe(true);
  });
});

// ── Bootstrap workspace via the receipt ─────────────────────────────────────

describe('computeBackupCoverage — bootstrap workspace', () => {
  test('receipt without repo_url → bootstrap_workspace no_remote names both bootstrap repo and attach, fix_argv null', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeReceipt(ws);

    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'bootstrap_workspace');
    expect(asset).toBeDefined();
    expect(asset?.id).toBe(ws);
    expect(asset?.state).toBe('no_remote');
    // This check is file-plane only (no git subprocess) so it can't tell an
    // empty/unconfigured origin (needs `bootstrap repo`) from an
    // already-pushed out-of-band one (needs `bootstrap attach`, since
    // `bootstrap repo` guaranteed-refuses with ORIGIN_NOT_EMPTY there — see
    // src/core/bootstrap/repo.ts). fix_argv stays null rather than advertise
    // a command that's wrong in the out-of-band case; the message names both.
    expect(asset?.fix_argv).toBeNull();
    expect(asset?.detail).toContain('no private repo yet');
    expect(asset?.detail).toContain('bootstrap repo');
    expect(asset?.detail).toContain('bootstrap attach');
    expect(s.overall).toBe('warn');
    expect(s.totals.no_remote).toBe(1);
  });

  test('receipt with repo_url and no failing push statuses → bootstrap_workspace ok', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeReceipt(ws, { repo_url: 'https://example.com/acme-example/brain.git' });

    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'bootstrap_workspace');
    expect(asset?.state).toBe('ok');
    expect(s.overall).toBe('ok');
    expect(s.totals.recoverable_repos).toBe(1);
  });
});

// ── getBackupStatus caching ──────────────────────────────────────────────────

describe('getBackupStatus — cache choke point', () => {
  test('probed compute persists; fresh cache short-circuits; forceRefresh recomputes', async () => {
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    const first = await getBackupStatus(stubEngine({}), { localGitProbes: true, now: t0 });
    expect(existsSync(statusPath)).toBe(true);
    expect(first.checked_at).toBe(t0.toISOString());
    expect(loadBackupStatus()?.checked_at).toBe(t0.toISOString());

    // Fresh cache is returned as-is: a throwing engine is never even touched,
    // and the persisted verdict is not clobbered.
    let throwCalls = 0;
    const throwing = {
      kind: 'pglite',
      executeRaw: async () => {
        throwCalls++;
        throw new Error('boom');
      },
    } as unknown as BrainEngine;
    const second = await getBackupStatus(throwing, {
      localGitProbes: true,
      now: new Date(t0.getTime() + 60_000),
    });
    expect(second.checked_at).toBe(first.checked_at);
    expect(throwCalls).toBe(0);
    expect(loadBackupStatus()?.checked_at).toBe(first.checked_at);

    // forceRefresh + working engine recomputes and re-persists.
    const t1 = new Date(t0.getTime() + 60 * 60 * 1000);
    const third = await getBackupStatus(stubEngine({}), {
      localGitProbes: true,
      now: t1,
      forceRefresh: true,
    });
    expect(third.checked_at).toBe(t1.toISOString());
    expect(loadBackupStatus()?.checked_at).toBe(t1.toISOString());
  });

  test('a failed compute never clobbers — the prior cached verdict is returned', async () => {
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    const first = await getBackupStatus(stubEngine({}), { localGitProbes: true, now: t0 });
    expect(loadBackupStatus()?.checked_at).toBe(first.checked_at);

    // Inject a mid-compute throw through the public API: an Invalid Date
    // makes computeBackupCoverage's checked_at serialization throw, so
    // getBackupStatus must fall back to the prior cache, not clobber it.
    const out = await getBackupStatus(stubEngine({}), {
      localGitProbes: true,
      forceRefresh: true,
      now: new Date('not-a-date'),
    });
    expect(out.checked_at).toBe(first.checked_at); // prior verdict returned
    expect(loadBackupStatus()?.checked_at).toBe(first.checked_at); // never clobbered

    // With no prior cache the same failure propagates to the caller.
    rmSync(statusPath, { force: true });
    await expect(
      getBackupStatus(stubEngine({}), {
        localGitProbes: true,
        forceRefresh: true,
        now: new Date('not-a-date'),
      }),
    ).rejects.toThrow();
  });
});

// ── countLivePages: an unestablished count is DEGRADED, never a fake zero ────

describe('computeBackupCoverage — pages count unestablished', () => {
  function pagesRowEngine(pagesRows: unknown[]): BrainEngine {
    return {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        if (sql.includes('FROM pages')) return pagesRows;
        if (sql.includes('FROM sources')) return [];
        return [];
      },
    } as unknown as BrainEngine;
  }

  test('empty rowset for the pages query → degraded verdict, never persisted', async () => {
    // Returning 0 would fabricate a "no pages at risk" all-clear; an empty
    // rowset is UNESTABLISHED and must degrade (and degraded never persists).
    const s = await getBackupStatus(pagesRowEngine([]), { localGitProbes: true, forceRefresh: true });
    expect(s.degraded).toBe(true);
    expect(s.totals.pages_at_risk).toBe(0);
    expect(s.assets.find((a) => a.kind === 'db_content')).toBeUndefined();
    expect(existsSync(statusPath)).toBe(false);
  });

  test('non-numeric n → degraded verdict, never persisted', async () => {
    const s = await getBackupStatus(pagesRowEngine([{ n: 'lots' }]), {
      localGitProbes: true,
      forceRefresh: true,
    });
    expect(s.degraded).toBe(true);
    expect(existsSync(statusPath)).toBe(false);
  });
});

// ── Host-brain scoping: the status cache has no brain dimension ──────────────

describe('getBackupStatus — host-brain cache scoping', () => {
  test('non-host GBRAIN_BRAIN_ID: computes fresh (never reads the cache) and never persists', async () => {
    // Seed a FRESH host warn cache (a minute old — well inside the interval,
    // but distinguishable from a same-millisecond fresh compute) — for the
    // host brain this would short-circuit the compute entirely.
    const hostCache = mkStatus('warn', new Date(Date.now() - 60_000).toISOString());
    saveBackupStatus(hostCache);

    process.env.GBRAIN_BRAIN_ID = 'some-team';
    const out = await getBackupStatus(stubEngine({}), { localGitProbes: true });

    // The mounted-brain call computed FRESH from the empty stub (ok), instead
    // of returning the host cache's warn…
    expect(out.overall).toBe('ok');
    expect(out.checked_at).not.toBe(hostCache.checked_at);
    // …and the pre-existing host cache is untouched (an empty mounted brain's
    // ok must never silence a real host warn).
    expect(loadBackupStatus()).toEqual(hostCache);

    // Unset restores normal behavior: the fresh host cache answers as-is.
    delete process.env.GBRAIN_BRAIN_ID;
    const back = await getBackupStatus(stubEngine({}), { localGitProbes: true });
    expect(back.checked_at).toBe(hostCache.checked_at);
    expect(back.overall).toBe('warn');
  });

  test('non-host brain + absent cache: a probed compute leaves the cache file absent', async () => {
    process.env.GBRAIN_BRAIN_ID = 'some-team';
    expect(existsSync(statusPath)).toBe(false);
    const out = await getBackupStatus(stubEngine({}), { localGitProbes: true, forceRefresh: true });
    expect(out.overall).toBe('ok');
    expect(out.degraded).toBeUndefined(); // a clean compute — just never saved
    expect(existsSync(statusPath)).toBe(false);
  });

  test("GBRAIN_BRAIN_ID='host' behaves exactly like unset (reads + persists)", async () => {
    process.env.GBRAIN_BRAIN_ID = 'host';
    const out = await getBackupStatus(stubEngine({}), { localGitProbes: true });
    expect(out.overall).toBe('ok');
    expect(existsSync(statusPath)).toBe(true);
    expect(loadBackupStatus()?.checked_at).toBe(out.checked_at);
  });
});

// ── Serve-side in-process refresher ──────────────────────────────────────────

describe('maybeRefreshBackupStatusInProcess', () => {
  test('absent cache → computes with probes and persists a serve-stamped verdict', async () => {
    const repo = join(tmp, 'repo-refresh');
    initRepo(repo);
    commitFile(repo, 'a.md', 'x', 'init');
    const engine = stubEngine({ sources: [srcRow('src-refresh', repo)] });

    expect(existsSync(statusPath)).toBe(false);
    maybeRefreshBackupStatusInProcess(engine);

    expect(await pollUntil(() => existsSync(statusPath))).toBe(true);
    const s = loadBackupStatus();
    expect(s?.computed_by).toBe('serve');
    expect(s?.overall).toBe('warn'); // fixture repo has no origin
    expect(s?.assets.some((a) => a.kind === 'source_repo' && a.state === 'no_remote')).toBe(true);
  });

  test('two synchronous calls single-flight into one compute', async () => {
    let calls = 0;
    const engine = stubEngine({ onCall: () => calls++ });

    maybeRefreshBackupStatusInProcess(engine);
    maybeRefreshBackupStatusInProcess(engine);

    expect(await pollUntil(() => existsSync(statusPath))).toBe(true);
    await sleep(100); // let any (wrongly) duplicated compute land
    // One compute = exactly two executeRaw calls (sources + pages), not four.
    expect(calls).toBe(2);
  });

  test('fresh ok cache → does nothing (engine never touched)', async () => {
    saveBackupStatus(mkStatus('ok', new Date().toISOString()));
    let calls = 0;
    const engine = stubEngine({ onCall: () => calls++ });

    maybeRefreshBackupStatusInProcess(engine);
    await sleep(150);

    expect(calls).toBe(0);
  });

  test('warn cache older than 24h → recomputes even though the cache is not interval-stale', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    saveBackupStatus(mkStatus('warn', old));
    let calls = 0;
    const engine = stubEngine({ onCall: () => calls++ });

    maybeRefreshBackupStatusInProcess(engine);

    expect(await pollUntil(() => loadBackupStatus()?.checked_at !== old)).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    const s = loadBackupStatus();
    expect(s?.overall).toBe('ok'); // the empty brain no longer warns
    expect(Date.parse(s!.checked_at)).toBeGreaterThan(Date.parse(old));
  });
});

// ── Dirty working tree, shared roots, non-repo paths ─────────────────────────

describe('computeBackupCoverage — dirty tree, shared git roots, non-repo paths', () => {
  test('origin-backed pushed repo with a modified tracked file → dirty, overall stays ok', async () => {
    const bare = join(tmp, 'dirty-bare.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'pipe', 'pipe'] });
    const work = join(tmp, 'dirty-work');
    initRepo(work);
    commitFile(work, 'a.md', 'clean state', 'baseline');
    g(work, ['remote', 'add', 'origin', bare]);
    g(work, ['push', '-u', 'origin', 'main']);
    writeFileSync(join(work, 'a.md'), 'modified but not committed'); // dirty, NOT ahead

    const engine = stubEngine({ sources: [srcRow('src-dirty', work)] });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'source_repo');
    expect(asset?.id).toBe('src-dirty');
    expect(asset?.state).toBe('dirty');
    expect(asset?.detail).toBe('uncommitted changes');
    expect(asset?.fix_argv).toBeNull();
    expect(s.overall).toBe('ok'); // dirty does NOT flip warn — only no_remote does
    expect(s.totals.no_remote).toBe(0);
    expect(s.totals.unpushed).toBe(0);
    // dirty is still recoverable_repos (origin exists; only the delta is at risk)
    expect(s.totals.recoverable_repos).toBe(1);
  });

  test('two sources in the SAME git repo (root + subdir) dedupe to ONE probed asset with joined ids', async () => {
    const repo = join(tmp, 'shared-root');
    initRepo(repo);
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'inner.md'), 'inner');
    commitFile(repo, 'a.md', 'x', 'init'); // commits a.md + docs/inner.md

    const engine = stubEngine({
      sources: [srcRow('root-src', repo), srcRow('sub-src', join(repo, 'docs'))],
    });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const repos = s.assets.filter((a) => a.kind === 'source_repo');
    expect(repos).toHaveLength(1); // one git root → one probed asset
    expect(repos[0]?.id).toBe('root-src, sub-src');
    expect(repos[0]?.state).toBe('no_remote'); // fixture repo has no origin
    expect(s.totals.no_remote).toBe(1); // counted once, not per source
    expect(s.overall).toBe('warn');
  });

  test('existing plain directory (not a git repo) → unknown/not_a_git_repo; memoized per path, one asset PER SOURCE', async () => {
    const plain = join(tmp, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'notes.md'), 'not under git');

    // Two sources at the SAME non-repo path: discovery is memoized (one
    // subprocess), but EVERY source at the known non-repo path still gets its
    // own asset row — the second source is no longer silently dropped.
    const engine = stubEngine({
      sources: [srcRow('plain-src', plain), srcRow('plain-src-dup', plain)],
    });
    const s = await computeBackupCoverage(engine, { localGitProbes: true });

    const repos = s.assets.filter((a) => a.kind === 'source_repo');
    expect(repos).toHaveLength(2);
    expect(repos.map((a) => a.id).sort()).toEqual(['plain-src', 'plain-src-dup']);
    for (const a of repos) {
      expect(a.state).toBe('unknown');
      expect(a.detail).toBe('not_a_git_repo');
      expect(a.fix_argv).toBeNull();
    }
    expect(s.overall).toBe('ok'); // unknown never flips warn
    expect(s.totals.no_remote).toBe(0);
  });
});

// ── Bootstrap workspace: failing push status ─────────────────────────────────

describe('computeBackupCoverage — bootstrap workspace failing push', () => {
  test('receipt WITH repo_url + a failing per-root push-status → failing asset with sanitized detail', async () => {
    const ws = join(tmp, 'ws-failing');
    mkdirSync(ws, { recursive: true }); // repoRoot must exist or the ghost filter drops the entry
    writeReceipt(ws, { repo_url: 'https://example.com/acme-example/brain.git' });

    // A failing per-root status via the real path helper (workspace-push.ts).
    // The reason carries hostile chars: sanitizePushReason must strip them
    // before the detail reaches any human/model-visible surface.
    const statusFile = pushStatusPathForRoot(ws);
    mkdirSync(join(home(), 'bootstrap'), { recursive: true });
    writeFileSync(
      statusFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        ok: false,
        reason: 'push failed: `rm -rf` $HOME \u0007beep',
        repoRoot: ws,
      }),
    );

    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'bootstrap_workspace');
    expect(asset).toBeDefined();
    expect(asset?.id).toBe(ws);
    expect(asset?.state).toBe('failing');
    // Sanitized: backticks/$ replaced, non-printables spaced, content kept.
    expect(asset?.detail).toContain('push failed');
    expect(asset?.detail).toContain("'rm -rf'");
    expect(asset?.detail).not.toContain('`');
    expect(asset?.detail).not.toContain('$');
    expect(asset?.detail).not.toContain('\u0007');
    expect(asset?.fix_argv).toEqual(['gbrain', 'sources', 'push', '--path', ws]);
    expect(s.totals.failing).toBe(1);
    expect(s.overall).toBe('ok'); // failing is not no_remote — the remote exists
    // A failing push means the remote is BEHIND: counting it recoverable would
    // overstate the recovery statement, so recoverable_repos excludes it.
    expect(s.totals.recoverable_repos).toBe(0);
  });

  test("a failing push status for a DIFFERENT root leaves the workspace ok", async () => {
    const ws = join(tmp, 'ws-healthy');
    mkdirSync(ws, { recursive: true });
    writeReceipt(ws, { repo_url: 'https://example.com/acme-example/brain.git' });

    // A failing status for some OTHER push-tracked repo (root exists, so the
    // ghost filter keeps the entry alive) — the workspace verdict reads ONLY
    // its own per-root status and must not inherit this failure.
    const other = join(tmp, 'other-root');
    mkdirSync(other, { recursive: true });
    mkdirSync(join(home(), 'bootstrap'), { recursive: true });
    writeFileSync(
      pushStatusPathForRoot(other),
      JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'push failed elsewhere', repoRoot: other }),
    );

    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    const asset = s.assets.find((a) => a.kind === 'bootstrap_workspace');
    expect(asset).toBeDefined();
    expect(asset?.state).toBe('ok');
    expect(s.totals.failing).toBe(0);
    expect(s.totals.recoverable_repos).toBe(1);
    expect(s.overall).toBe('ok');
  });
});

// ── Harness skills (bridge-state ledger) ─────────────────────────────────────

describe('computeBackupCoverage — harness_skills info row', () => {
  test('bridge state with one entry → one harness_skills info asset', async () => {
    // Written through the real saver so the fixture matches the BridgeState
    // schema loadBridgeState validates (schema_version + entries shape).
    saveBridgeState({
      schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION,
      entries: [
        {
          harness: 'claude-code',
          dest: join(tmp, 'harness-skills-dest'),
          last_persona: null,
          last_mode: 'full',
          written: { 'query-skill': { mode: 'full', files: { 'SKILL.md': 'abc123' } } },
          gbrain_version: '0.0.0-test',
          installed_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const s = await computeBackupCoverage(stubEngine({}), { localGitProbes: true });

    const rows = s.assets.filter((a) => a.kind === 'harness_skills');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('1 harness skill dir(s)');
    expect(rows[0]?.state).toBe('info');
    expect(rows[0]?.detail).toContain('installed copies');
    expect(rows[0]?.fix_argv).toBeNull();
    expect(s.overall).toBe('ok'); // info never warns
  });
});

describe('degraded verdict never clobbers a probed cache', () => {
  test('forceRefresh against a broken engine keeps the prior warn cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-bkc-degraded-'));
    const prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
    try {
      const warn: BackupStatus = {
        schema_version: BACKUP_STATUS_SCHEMA_VERSION,
        checked_at: new Date().toISOString(),
        gbrain_version: '0.0.0',
        interval_days: 30,
        computed_by: 'cli',
        overall: 'warn',
        totals: { assets: 1, no_remote: 1, unpushed: 0, failing: 0, recoverable_repos: 0, pages_at_risk: 0 },
        assets: [{ kind: 'source_repo', id: 'kept-repo', state: 'no_remote', fix_argv: null }],
      };
      saveBackupStatus(warn);
      const broken = {
        kind: 'pglite',
        executeRaw: async () => {
          throw new Error('engine down');
        },
      } as unknown as BrainEngine;
      const out = await getBackupStatus(broken, { localGitProbes: true, forceRefresh: true });
      // The degraded empty verdict is discarded in favor of the cached warn…
      expect(out.overall).toBe('warn');
      expect(out.assets[0]?.id).toBe('kept-repo');
      // …and the cache file itself is untouched (no clobber).
      expect(loadBackupStatus()?.overall).toBe('warn');
      // With NO cache, the degraded verdict is returned but never persisted.
      invalidateBackupStatus();
      const degraded = await getBackupStatus(broken, { localGitProbes: true, forceRefresh: true });
      expect(degraded.degraded).toBe(true);
      expect(loadBackupStatus()).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
