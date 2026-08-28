/**
 * Fix-path invalidation call sites for the monthly backup-coverage cache
 * (src/core/backup/status-file.ts invalidateBackupStatus):
 *
 *   1. workspace-push — the finish() choke point: EVERY successful push drops
 *      the cached verdict; failing/blocked/refused pushes and clean lock-skips
 *      leave it untouched. Pinned with REAL behavior: a tmp git repo + local
 *      bare origin (the workspace-push.serial.test.ts fixture idiom).
 *   2. sources harden — after the harden loop, a run that produced >=1 report
 *      invalidates; a run whose rows were all skipped (no git repo) does not.
 *      Pinned with REAL behavior via a stub engine + --dry-run (dry-run is
 *      fully offline: pull/verify skipped, --no-cron, writes suppressed).
 *   3. bootstrap repo — recordRepoInReceipt is module-private and driving the
 *      full `bootstrap repo` flow needs gh + a pushable GitHub remote, which
 *      is infeasible here. Pinned as an explicit SOURCE-TEXT contract instead
 *      (see the last describe block for why).
 *
 * Isolation: tmp HOME + GBRAIN_HOME per test, env save/restore, and the
 * __setBackupStatusPathForTests seam so the real ~/.gbrain is never touched.
 * GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 lets the SSRF-flagged push use the file
 * transport (same knob as workspace-push.serial.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { workspacePush, acquirePushLock } from '../src/core/workspace-push.ts';
import { runHarden } from '../src/commands/sources-harden.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  loadBackupStatus,
  saveBackupStatus,
  __setBackupStatusPathForTests,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const T = 60_000; // explicit per-test timeout — bun ignores bunfig.toml's key

// #2943: env: process.env is REQUIRED — Bun snapshots env at startup, so
// spawned git would otherwise be blind to beforeEach's HOME/GBRAIN_HOME swap.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}

const ENV_KEYS = [
  'HOME',
  'GBRAIN_HOME',
  'GBRAIN_GIT_ALLOW_FILE_TRANSPORT',
  'GBRAIN_ALLOW_UNVERIFIED_REMOTE',
  'GBRAIN_GITHUB_PAT',
  'GBRAIN_BACKUP_CHECK',
] as const;

let root: string;
let work: string;
let bare: string;
let statusPath: string;
let saved: Record<string, string | undefined> = {};
let savedExitCode: typeof process.exitCode;

function makePair(): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], {
    stdio: 'ignore', env: process.env,
  });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

/** A warn verdict to seed the cache with — generic ids only (privacy rule). */
function warnStatus(): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: new Date().toISOString(),
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall: 'warn',
    totals: { assets: 2, no_remote: 1, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0 },
    assets: [
      { kind: 'source_repo', id: 'wiki', state: 'no_remote', fix_argv: null },
      { kind: 'source_repo', id: 'notes', state: 'ok' },
    ],
  };
}

function seedWarnCache(): void {
  saveBackupStatus(warnStatus());
  expect(loadBackupStatus()).not.toBeNull(); // sanity: the seed took
}

/** A fully-healthy verdict: overall ok, zero failing, zero unpushed. */
function okStatus(over: Partial<BackupStatus['totals']> = {}): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: new Date().toISOString(),
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall: 'ok',
    totals: {
      assets: 1, no_remote: 0, unpushed: 0, failing: 0, recoverable_repos: 1, pages_at_risk: 0,
      ...over,
    },
    assets: [{ kind: 'source_repo', id: 'notes', state: 'ok' }],
  };
}

/** Mute console.log/console.error for the duration (runHarden is chatty). */
async function muted<TReturn>(fn: () => Promise<TReturn>): Promise<TReturn> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gb-backup-inv-'));
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  savedExitCode = process.exitCode;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir → effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  delete process.env.GBRAIN_ALLOW_UNVERIFIED_REMOTE;
  delete process.env.GBRAIN_GITHUB_PAT;
  delete process.env.GBRAIN_BACKUP_CHECK;
  statusPath = join(root, 'backup-status.json');
  __setBackupStatusPathForTests(statusPath);
  makePair();
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  _resetCliExitVerdictForTests();
  process.exitCode = savedExitCode;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('workspace-push finish() choke point', () => {
  test('a successful push invalidates the cached verdict', async () => {
    seedWarnCache();
    writeFileSync(join(work, 'note.md'), 'remember this\n');
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('pushed');
    expect(loadBackupStatus()).toBeNull();
    expect(existsSync(statusPath)).toBe(false); // the file itself is gone
  }, T);

  test('a successful push with NOTHING new to commit still invalidates (finish sees r.ok)', async () => {
    // Local ahead of origin by one prior commit; clean tree → committed:false
    // but the push succeeds — the coverage answer changed (unpushed→pushed).
    writeFileSync(join(work, 'ahead.md'), 'x\n');
    git(work, 'add', 'ahead.md');
    git(work, 'commit', '-qm', 'local-only');
    seedWarnCache();
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(false);
    expect(loadBackupStatus()).toBeNull();
  }, T);

  test('an OK cache with zero failing/unpushed SURVIVES a successful push (guarded invalidation)', async () => {
    // The routine healthy stop-push must not delete an ok cache every session —
    // that would defeat the monthly compute throttle for the healthiest cohort.
    const seed = okStatus();
    saveBackupStatus(seed);
    writeFileSync(join(work, 'note.md'), 'healthy session\n');
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('pushed');
    expect(loadBackupStatus()).toEqual(seed); // cache untouched
    expect(existsSync(statusPath)).toBe(true);
  }, T);

  test('an ok cache carrying unpushed>0 IS invalidated by a successful push (the push fixed it)', async () => {
    saveBackupStatus(okStatus({ unpushed: 1 }));
    writeFileSync(join(work, 'note.md'), 'catching up\n');
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(true);
    expect(loadBackupStatus()).toBeNull(); // unpushed→pushed changed the answer
  }, T);

  test('an ok cache carrying failing>0 IS invalidated by a successful push', async () => {
    saveBackupStatus(okStatus({ failing: 1 }));
    writeFileSync(join(work, 'note.md'), 'recovered\n');
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(true);
    expect(loadBackupStatus()).toBeNull();
  }, T);

  test('a blocked push (tracked deny match) does NOT invalidate', async () => {
    // NOTE: push_failed (unreachable origin) is untestable in this sandbox —
    // a /conductor/bin/git shim swallows subprocess exit codes — so the
    // failing-path pins use verdicts computed from git STDOUT (deny listing,
    // privacy ladder), which the shim passes through faithfully.
    writeFileSync(join(work, '.env'), 'SECRETISH=value\n');
    git(work, 'add', '.env');
    git(work, 'commit', '-qm', 'oops tracked env');
    seedWarnCache();
    const before = loadBackupStatus();
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('blocked_tracked_deny');
    expect(loadBackupStatus()).toEqual(before); // cache untouched
  }, T);

  test('a refused-visibility push does NOT invalidate (r.ok=false through finish)', async () => {
    seedWarnCache();
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: false });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('refused_visibility');
    expect(r.committed).toBe(true); // the local commit happened…
    expect(loadBackupStatus()).not.toBeNull(); // …but the cache stays
  }, T);

  test('a clean lock-skip never touches the cache (skip returns before finish)', async () => {
    seedWarnCache();
    const lock = acquirePushLock(work);
    expect(lock.acquired).toBe(true);
    try {
      writeFileSync(join(work, 'note.md'), 'racing\n');
      const r = await workspacePush({ dir: work, branch: 'main', allowUnverifiedRemote: true });
      // skipped_in_flight is ok:true (clean skip) but must NOT invalidate —
      // only the lock WINNER's eventual success changes the coverage answer.
      expect(r.ok).toBe(true);
      expect(r.status).toBe('skipped_in_flight');
      expect(loadBackupStatus()).not.toBeNull();
    } finally {
      if (lock.acquired) lock.handle.release();
    }
  }, T);
});

describe('sources harden — invalidation after the harden loop', () => {
  const rowEngine = (local_path: string): BrainEngine =>
    ({ executeRaw: async () => [{ id: 'wiki', local_path, config: null }] } as unknown as BrainEngine);

  test('a run that produced a report drops the cached verdict (dry-run, real repo)', async () => {
    seedWarnCache();
    // --dry-run --no-cron --no-verify keeps hardenBrainRepo fully offline and
    // write-free while still producing a DurabilityReport, which is exactly
    // the condition the invalidation call keys on (reports.length > 0).
    await muted(() => runHarden(rowEngine(work), ['wiki', '--dry-run', '--no-cron', '--no-verify', '--json']));
    expect(loadBackupStatus()).toBeNull();
  }, T);

  test('a run whose rows were ALL skipped (no git repo) leaves the cache alone', async () => {
    seedWarnCache();
    const plain = mkdtempSync(join(root, 'plain-')); // not a git repo → skipped
    await muted(() => runHarden(rowEngine(plain), ['wiki', '--dry-run', '--no-cron', '--no-verify', '--json']));
    expect(loadBackupStatus()).not.toBeNull(); // zero reports → no invalidation
  }, T);
});

describe('bootstrap repo — recordRepoInReceipt contract (source-text pin)', () => {
  // WHY source-text and not behavior: recordRepoInReceipt is module-private
  // to src/core/bootstrap/repo.ts, and the only public path to it is the full
  // `gbrain bootstrap repo` flow — which requires a gh binary, a GitHub-shaped
  // origin, and a repo-privacy verification ladder that cannot run in this
  // sandbox (the git shim also swallows subprocess exit codes). The REAL
  // behavior (invalidateBackupStatus deleting the cache file) is pinned above
  // via the workspace-push and harden paths, which share the same helper; this
  // test pins WHERE bootstrap-repo calls it.
  const repoSrc = () =>
    readFileSync(join(import.meta.dir, '..', 'src', 'core', 'bootstrap', 'repo.ts'), 'utf-8');

  function fnBody(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start); // module-level fn: first col-0 close
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  test('recordRepoInReceipt (post-push success) calls invalidateBackupStatus()', () => {
    expect(fnBody(repoSrc(), 'recordRepoInReceipt')).toContain('invalidateBackupStatus()');
  });

  test('recordPendingRepo (pre-push proof-of-intent) does NOT invalidate — nothing was fixed yet', () => {
    expect(fnBody(repoSrc(), 'recordPendingRepo')).not.toContain('invalidateBackupStatus');
  });
});
