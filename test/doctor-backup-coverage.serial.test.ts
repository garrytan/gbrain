/**
 * doctor/checks/backup-coverage.ts — checkBackupCoverage.
 *
 * Pins the D4 trust boundary: git probes against DB-supplied local_path run
 * ONLY on the trusted local doctor path (localOnly: true). The remote surface
 * is a cache-only, AGGREGATE-ONLY reader — it must never spawn git, never
 * touch the engine, and never surface asset ids / local paths (counts only).
 *
 * Isolation: tmp GBRAIN_HOME (configDir() appends '.gbrain'), the status-file
 * path seams, real tmp git fixtures (no-origin repo; origin-backed clean repo
 * pushed to a local bare — file transport, no network), and a minimal engine
 * stub cast to BrainEngine that serves `sources` / `pages` via executeRaw.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkBackupCoverage } from '../src/commands/doctor/checks/backup-coverage.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  __setBackupIntervalForTests,
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  saveBackupStatus,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_BACKUP_CHECK', 'GBRAIN_BACKUP_CHECK_DAYS'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let statusFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-bkcov-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // configDir() === join(tmp, '.gbrain')
  statusFile = join(tmp, 'state', 'backup-status.json');
  __setBackupStatusPathForTests(statusFile);
  __setBackupNagStatePathForTests(join(tmp, 'state', 'backup-nag-state.json'));
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function git(dir: string, args: string[]): void {
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 },
  );
}

/** Local git repo with one commit and NO origin remote. */
function makeNoOriginRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: ['ignore', 'ignore', 'ignore'] });
  writeFileSync(join(dir, 'note.md'), '# hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Clean repo pushed to a local bare origin (file transport — no network). */
function makeHealthyRepo(name: string): string {
  const dir = makeNoOriginRepo(name);
  const bare = join(tmp, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'ignore', 'ignore'] });
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  return dir;
}

/** Minimal engine stub (dispatch-response-meta idiom) — never a real PGLite. */
function makeEngine(sourcePaths: Array<{ id: string; local_path: string }>, pageCount = 0): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string) => {
      if (/FROM sources/i.test(sql)) {
        return sourcePaths.map((s) => ({
          id: s.id,
          name: s.id,
          local_path: s.local_path,
          last_commit: null,
          last_sync_at: null,
          config: '{}',
          created_at: new Date(),
          archived: false,
          newest_content_at: null,
        }));
      }
      if (/FROM pages/i.test(sql)) return [{ n: pageCount }];
      throw new Error(`unexpected sql in stub: ${sql}`);
    },
  } as unknown as BrainEngine;
}

/** Engine stub that throws on ANY property access — the remote-path trust pin. */
function makeThrowingEngine(): BrainEngine {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`engine touched on remote/disabled path: ${String(prop)}`);
      },
    },
  ) as unknown as BrainEngine;
}

function makeWarnCache(assetId: string): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: new Date(Date.now() - 60_000).toISOString(),
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall: 'warn',
    totals: { assets: 1, no_remote: 1, unpushed: 0, failing: 0, recoverable_repos: 0, pages_at_risk: 0 },
    assets: [{ kind: 'source_repo', id: assetId, state: 'no_remote', detail: 'fixture', fix_argv: null }],
  };
}

// ── Local (trusted) path: probes run ─────────────────────────────────────────

describe('checkBackupCoverage — localOnly (trusted, probes run)', () => {
  test('no-origin source repo → warn naming the asset, points at gbrain backup status', async () => {
    const repo = makeNoOriginRepo('src-a');
    const check = await checkBackupCoverage(makeEngine([{ id: 'src-a', local_path: repo }]), {
      localOnly: true,
    });

    expect(check.name).toBe('backup_coverage');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain backup status');
    expect(check.message).toContain('src-a');
    expect(check.message).toContain('no git remote');

    const details = check.details as { totals: BackupStatus['totals']; computed_by: string };
    expect(details.totals.no_remote).toBe(1);
    expect(details.computed_by).toBe('doctor');
    // Probed compute persists the verdict cache (getBackupStatus discipline).
    expect(existsSync(statusFile)).toBe(true);
  });

  test('healthy repo (origin, pushed, clean) → ok with recoverable count', async () => {
    const repo = makeHealthyRepo('src-b');
    const check = await checkBackupCoverage(makeEngine([{ id: 'src-b', local_path: repo }], 3), {
      localOnly: true,
    });

    expect(check.name).toBe('backup_coverage');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('1 knowledge repo(s) git-backed');
    expect(check.message).toContain('last checked');

    const details = check.details as { totals: BackupStatus['totals'] };
    expect(details.totals.recoverable_repos).toBe(1);
    expect(details.totals.no_remote).toBe(0);
  });
});

// ── Remote (untrusted) path: cache-only reader, zero git, zero engine ────────

describe('checkBackupCoverage — remote surface (no localOnly)', () => {
  test('no cache → ok, "not checked from this surface", engine untouched', async () => {
    const check = await checkBackupCoverage(makeThrowingEngine(), {});
    expect(check.name).toBe('backup_coverage');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not checked from this surface');
    expect(check.message).toContain('gbrain backup check');
  });

  test('warn cache → AGGREGATE-ONLY warn from cache; zero git subprocesses, zero engine calls', async () => {
    // Trust pin (D4): the cached asset id points at a REAL git repo dir. If
    // the remote path probed git or touched the engine, the throwing engine
    // stub would blow up. And the remote surface is aggregate-only: the
    // message carries COUNTS ('N of M'), never the asset id / local path.
    const repo = makeNoOriginRepo('real-repo-dir');
    saveBackupStatus(makeWarnCache(repo));

    const check = await checkBackupCoverage(makeThrowingEngine(), {});

    expect(check.name).toBe('backup_coverage');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 of 1'); // aggregate counts
    expect(check.message).not.toContain(repo); // NEVER the asset id / local path
    expect(check.message).not.toContain('real-repo-dir');
    expect(check.message).toContain('gbrain backup status');

    const details = check.details as { note?: string; computed_by?: string; cache_age?: string };
    expect(details.note).toBe('cache-only (remote surface never probes git; aggregate counts only)');
    expect(details.computed_by).toBeUndefined(); // remote details drop provenance
    expect(typeof details.cache_age).toBe('string');
  });

  test('ok cache → ok from cache with the cache-only note', async () => {
    saveBackupStatus({
      ...makeWarnCache('unused'),
      overall: 'ok',
      totals: { assets: 1, no_remote: 0, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0 },
      assets: [{ kind: 'source_repo', id: 'unused', state: 'ok' }],
    });
    const check = await checkBackupCoverage(makeThrowingEngine(), {});
    expect(check.status).toBe('ok');
    expect(check.message).toContain('1 knowledge repo(s) git-backed');
    expect((check.details as { note?: string }).note).toBe(
      'cache-only (remote surface never probes git; aggregate counts only)',
    );
  });
});

// ── Kill switch ───────────────────────────────────────────────────────────────

describe('checkBackupCoverage — GBRAIN_BACKUP_CHECK=0', () => {
  test('disabled → ok with "disabled" message, no probes, no engine, no cache write', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    const check = await checkBackupCoverage(makeThrowingEngine(), { localOnly: true });
    expect(check.name).toBe('backup_coverage');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('disabled');
    // Early return: no compute ran, so nothing was persisted.
    expect(existsSync(statusFile)).toBe(false);
  });

  test('disabled shadows even a stale warn cache on the remote surface', async () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    saveBackupStatus(makeWarnCache('anything'));
    const check = await checkBackupCoverage(makeThrowingEngine(), {});
    expect(check.status).toBe('ok');
    expect(check.message).toContain('disabled');
  });
});

// ── Local catch branch: getBackupStatus rethrows, checker degrades to warn ───

describe('checkBackupCoverage — localOnly catch branch', () => {
  test('compute throws with NO cache → warn "backup coverage unreadable", nothing persisted', async () => {
    // Verified against the source: a throwing engine alone only DEGRADES the
    // verdict (loadAllSources/countLivePages catch internally — no throw). To
    // make getBackupStatus itself throw through the public API, inject an
    // Invalid Date (checked_at serialization throws mid-compute — the same
    // idiom as backup-coverage.serial.test.ts). With NO cache to fall back
    // to, getBackupStatus rethrows and the checker's try/catch owns it.
    const throwing = {
      kind: 'pglite',
      executeRaw: async () => {
        throw new Error('engine down');
      },
    } as unknown as BrainEngine;

    expect(existsSync(statusFile)).toBe(false);
    const check = await checkBackupCoverage(throwing, {
      localOnly: true,
      now: new Date('not-a-date'),
    });

    expect(check).toEqual({
      name: 'backup_coverage',
      status: 'warn',
      message: 'backup coverage unreadable',
    });
    // The failed compute never persisted anything (no clobber, no cache).
    expect(existsSync(statusFile)).toBe(false);
  });

  test('broken compute WITH a cache → the cached verdict is returned, not the unreadable warn', async () => {
    // The sibling path: with a cache present, getBackupStatus never surfaces
    // the failure (a fresh cache short-circuits; even a failed compute falls
    // back to the prior verdict) — the checker renders the cached verdict.
    const cache = makeWarnCache('cached-asset-src');
    saveBackupStatus(cache);
    const throwing = {
      kind: 'pglite',
      executeRaw: async () => {
        throw new Error('engine down');
      },
    } as unknown as BrainEngine;

    const check = await checkBackupCoverage(throwing, {
      localOnly: true,
      now: new Date('not-a-date'),
    });

    expect(check.status).toBe('warn');
    expect(check.message).toContain('cached-asset-src'); // local surface names assets
    expect(check.message).not.toBe('backup coverage unreadable');
  });
});
