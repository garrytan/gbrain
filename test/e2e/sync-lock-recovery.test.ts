/**
 * v0.41.6.0 D3 + D5 E2E — lock recovery scenarios.
 *
 * Combined coverage for the abnormal-termination + lock-owner-message +
 * --break-lock flows that need real subprocess + shared DB state. Skips
 * gracefully when DATABASE_URL is unset.
 *
 * Scenarios:
 *   1. Concurrent sync: second exits with PID + age + --break-lock hint
 *      (per eng-review D10).
 *   2. SIGTERM during sync (lock observed held first): exit 143, lock row
 *      deleted (per process-cleanup registry contract).
 *   3. Output pipe closed mid-sync (lock observed held first): the
 *      broken-pipe cleanup route exits early, deletes the lock row, and the
 *      next sync runs without "Another sync is in progress".
 *   4. --break-lock with dead local PID: clears the row.
 *   5. --break-lock with alive local PID: refuses with --force-break-lock hint.
 *   6. --force-break-lock with alive PID: clears (with warning).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync, spawn } from 'child_process';
import { tmpdir, hostname } from 'os';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { tryAcquireDbLock, inspectLock } from '../../src/core/db-lock.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping lock-recovery E2E (DATABASE_URL not set)');

const CLI = ['bun', 'run', join(import.meta.dir, '..', '..', 'src', 'cli.ts')];

let tmpHome: string;
let repoDir: string;

beforeAll(async () => {
  if (skip) return;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-lock-recovery-e2e-'));
  await setupDB();
});

afterAll(async () => {
  if (skip) return;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  if (repoDir) { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } }
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-lock-recovery-repo-'));
  mkdirSync(join(repoDir, 'people'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(repoDir, 'people', `alice-example-${i}.md`), [
      '---', 'type: person', `title: Alice Example ${i}`, '---', '',
      `Placeholder person ${i} for lock-recovery E2E.`,
    ].join('\n'));
  }
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir });

  // Clean up any leftover lock rows from prior runs.
  const eng = getEngine();
  try { await (eng as any).sql`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:%'`; } catch { /* */ }
});

function runCli(args: string[], env: Record<string, string | undefined> = {}): { code: number; stdout: string; stderr: string } {
  const fullEnv: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    GBRAIN_HOME: tmpHome,
    DATABASE_URL: process.env.DATABASE_URL!,
    ...env,
  };
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    env: fullEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describeE2E('v0.41.6.0 — sync lock recovery scenarios', () => {
  test('--break-lock refuses when no lock row exists (clean message, exit 0)', () => {
    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not held|nothing to break/i);
  });

  test('--break-lock + --all is accepted and iterates sources (self-heal, no longer refused)', () => {
    // v0.41.13.0 (T4 + D1) intentionally DROPPED the old --all refusal so cron
    // can self-heal every source in one call: runBreakLock now widens to
    // iterate sources when --all is set (sync.ts ~2550). This test pins that
    // shipped contract. Deterministic: with no active sources OR only
    // unlocked ones, every per-source break is a no-op and the exit is 0.
    const result = runCli(['sync', '--break-lock', '--all']);
    const out = result.stdout + result.stderr;
    expect(result.code).toBe(0);
    // The combination must NOT be rejected anymore.
    expect(out).not.toMatch(/cannot be combined with --all/);
    // It took the accepted iterate/no-sources path.
    expect(out).toMatch(/No active sources to break-lock against|is not held \(nothing to break\)|Broke lock/i);
  });

  test('lock-busy error message includes PID + hostname + age + --break-lock hint', async () => {
    // Acquire a lock from THIS process so the row exists for the subprocess to see.
    const eng = getEngine();
    const lockKey = 'gbrain-sync:default';
    const handle = await tryAcquireDbLock(eng, lockKey);
    expect(handle).not.toBeNull();

    try {
      const result = runCli(['sync', '--repo', repoDir, '--full', '--yes', '--no-embed']);
      expect(result.code).not.toBe(0);
      const msg = result.stderr + result.stdout;
      expect(msg).toMatch(new RegExp(`pid ${process.pid}`));
      expect(msg).toMatch(/started \d+/);
      expect(msg).toMatch(/--break-lock/);
    } finally {
      await handle!.release();
    }
  });

  test('--break-lock with TTL-expired row clears the lock', async () => {
    const eng = getEngine();
    // Insert a TTL-expired row with a fake PID on this host.
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', 99999, ${hostname()}, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/broke lock.*ttl_expired/i);

    // Lock row should be gone.
    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).toBeNull();
  });

  test('--break-lock with alive local PID refuses with --force-break-lock hint', async () => {
    const eng = getEngine();
    // Use OUR pid → guaranteed alive on this host.
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', ${process.pid}, ${hostname()}, NOW(), NOW() + INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--break-lock', '--source', 'default']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refusing to break lock/);
    expect(result.stderr).toMatch(/--force-break-lock/);

    // Lock row should still exist.
    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).not.toBeNull();

    // Cleanup.
    await (eng as any).sql`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-sync:default'`;
  });

  test('--force-break-lock clears even when holder PID is alive (with warning)', async () => {
    const eng = getEngine();
    await (eng as any).sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES ('gbrain-sync:default', ${process.pid}, ${hostname()}, NOW(), NOW() + INTERVAL '30 minutes')
    `;

    const result = runCli(['sync', '--force-break-lock', '--source', 'default']);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/[Ff]orce-broke lock|WARNING/);

    const snap = await inspectLock(eng, 'gbrain-sync:default');
    expect(snap).toBeNull();
  });

  // Both abnormal-termination cases below observe the boundary before acting:
  // the lock row carries the child's PID AND the child has printed import
  // progress (so the lock's cleanup callback is registered). A run that never
  // reaches that point fails instead of passing vacuously. The bulk repo keeps
  // the sync busy long enough that "exited early" is observable: a child that
  // finished the whole import did not take the abnormal-exit path.
  const BULK_FILES = 1000;

  function makeBulkRepo(dirName: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-lock-recovery-bulk-'));
    mkdirSync(join(dir, dirName), { recursive: true });
    for (let i = 0; i < BULK_FILES; i++) {
      writeFileSync(join(dir, dirName, `note-${i}.md`), `---\ntype: note\ntitle: Bulk note ${i}\n---\n\nPlaceholder note ${i}.\n`);
    }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'bulk'], { cwd: dir });
    return dir;
  }

  async function startSyncAtLockBoundary(dir: string, opts: { importStarted: boolean } = { importStarted: true }) {
    const eng = getEngine();
    const child = spawn(CLI[0], [...CLI.slice(1), 'sync', '--repo', dir, '--full', '--yes', '--no-embed'], {
      env: { ...process.env, GBRAIN_HOME: tmpHome, DATABASE_URL: process.env.DATABASE_URL! } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', d => { stderr += d; });
    child.stdout!.on('data', () => {});
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
    });
    const deadline = Date.now() + 30_000;
    let lockHeld = false;
    const atBoundary = () => lockHeld && (!opts.importStarted || /\[import\.files\] \d+\//.test(stderr));
    while (!exit && Date.now() < deadline && !atBoundary()) {
      if (!lockHeld) {
        const snap = await inspectLock(eng, 'gbrain-sync:default');
        lockHeld = !!snap && snap.holder_pid === child.pid;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    if (exit || !atBoundary()) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`sync never reached the held-lock boundary (lockHeld=${lockHeld}, exit=${JSON.stringify(exit)}):\n${stderr.slice(-2000)}`);
    }
    return { child, exited, stderr: () => stderr };
  }

  async function importedCount(dirName: string): Promise<number> {
    const rows = await (getEngine() as any).sql`SELECT count(*)::int AS n FROM pages WHERE slug LIKE ${dirName + '/%'}`;
    return rows[0].n;
  }

  test('SIGTERM during sync releases the lock', async () => {
    const dir = makeBulkRepo('sigterm-bulk');
    try {
      const run = await startSyncAtLockBoundary(dir);
      run.child.kill('SIGTERM');
      const exit = await run.exited;

      expect(exit.code, run.stderr().slice(-2000)).toBe(143);
      expect(await inspectLock(getEngine(), 'gbrain-sync:default')).toBeNull();
      expect(await importedCount('sigterm-bulk')).toBeLessThan(BULK_FILES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('closing the output pipe as soon as the lock row appears still releases the lock', async () => {
    // The early close delivers a second broken-pipe signal while the first
    // cleanup pass is still deleting the lock row; that signal must wait for
    // the pass instead of exiting ahead of the DELETE.
    const dir = makeBulkRepo('lock-row-pipe-bulk');
    try {
      const run = await startSyncAtLockBoundary(dir, { importStarted: false });
      run.child.stdout!.destroy();
      run.child.stderr!.destroy();
      const exit = await run.exited;

      expect([0, 141] as Array<number | null>).toContain(exit.code);
      expect(await inspectLock(getEngine(), 'gbrain-sync:default')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('closing the output pipe mid-sync routes through cleanup and releases the lock', async () => {
    const dir = makeBulkRepo('sigpipe-bulk');
    try {
      const run = await startSyncAtLockBoundary(dir);
      run.child.stdout!.destroy();
      run.child.stderr!.destroy();
      const exit = await run.exited;

      // Bun raises SIGPIPE (handler exits 141); runtimes that surface EPIPE
      // on the stream instead take triggerCleanupAndExit(0). Either way the
      // child must stop early and leave no lock row behind.
      expect([0, 141] as Array<number | null>).toContain(exit.code);
      expect(await importedCount('sigpipe-bulk')).toBeLessThan(BULK_FILES);
      expect(await inspectLock(getEngine(), 'gbrain-sync:default')).toBeNull();

      const next = runCli(['sync', '--repo', repoDir, '--full', '--yes', '--no-embed']);
      expect(next.stdout + next.stderr).not.toMatch(/Another sync is in progress/);
      expect(next.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
