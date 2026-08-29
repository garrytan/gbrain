/**
 * F1 — SyncLockBusyError classifies as skipped-not-failed in BOTH consumers.
 *
 * The real seams (no stubs — a genuinely HELD per-source sync lock in PGLite
 * makes the real performSync throw the real SyncLockBusyError):
 *
 *   - src/commands/sync.ts:performSync wraps LockUnavailableError from
 *     withRefreshingLock into SyncLockBusyError(formatLockBusyMessage(...)).
 *   - Consumer 1 — the Minion 'sync' handler registered by
 *     registerBuiltinHandlers (src/commands/jobs.ts): catches
 *     SyncLockBusyError and RETURNS
 *     { skipped: true, reason: 'sync_in_progress', source_id } so the worker
 *     marks the job 'completed', never failed/dead.
 *   - Consumer 2 — runPhaseSync (src/core/cycle.ts, private; exercised
 *     through the real runCycle with phases: ['sync']): catches
 *     SyncLockBusyError and reports
 *     { phase: 'sync', status: 'skipped', details: { syncStatus: 'lock_busy' } }.
 *
 * Anti-vacuity: each consumer also has a red control — a NON-lock error
 * (vanished repo dir) propagates as a real failure ('dead' job / 'fail'
 * phase + 'failed' cycle), proving the classification CAN differ.
 *
 * Plus src/core/sync-lock.ts:formatLockBusyMessage — rich message names
 * holder pid/host and the `--break-lock --source` remediation; degrades to
 * the legacy message (no crash) when inspectLock throws.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJob } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { runCycle } from '../src/core/cycle.ts';
import { formatLockBusyMessage } from '../src/core/sync-lock.ts';
import { tryAcquireDbLock, syncLockId } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir, hostname } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
// MinionQueue.ensureSchema (called by worker.start()) reads config.version;
// resetPgliteState TRUNCATEs the config table, so we capture the migrated
// version once and re-seed it after every reset.
let schemaVersion: string | null = null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-f1-lock-busy-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);

async function waitForTerminal(queue: MinionQueue, id: number, timeoutMs = 45_000): Promise<MinionJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    if (job && TERMINAL.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not reach a terminal state within ${timeoutMs}ms`);
}

/** Run the real builtin-handler worker until the job terminates, then stop it. */
async function runJobToTerminal(job: MinionJob, queue: MinionQueue): Promise<MinionJob> {
  const worker = new MinionWorker(engine, { pollInterval: 50 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const workerPromise = worker.start();
  try {
    return await waitForTerminal(queue, job.id);
  } finally {
    worker.stop();
    await workerPromise;
  }
}

// ─── Consumer 1: Minion 'sync' job handler (src/commands/jobs.ts) ──────────

describe('minion sync handler — SyncLockBusyError is skipped, not failed', () => {
  test('held per-source sync lock → job completes with { skipped: true, reason: "sync_in_progress" }', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      // Real lock helper, real PGLite row: gbrain-sync:jobsrc held by THIS
      // (alive) pid, so performSync's acquire fails and the takeover path
      // refuses to steal from a live holder.
      const held = await tryAcquireDbLock(engine, syncLockId('jobsrc'));
      expect(held).not.toBeNull();
      try {
        const queue = new MinionQueue(engine);
        const job = await queue.add(
          'sync',
          { repoPath: repo, sourceId: 'jobsrc', pull: false },
          { max_attempts: 1 },
        );
        const terminal = await runJobToTerminal(job, queue);

        // The classification claim: the job is done, NOT failed/dead.
        expect(terminal.status).toBe('completed');
        // Pin the real constant strings from src/commands/jobs.ts.
        expect(terminal.result).toEqual({
          skipped: true,
          reason: 'sync_in_progress',
          source_id: 'jobsrc',
        });
        expect(terminal.error_text ?? null).toBeNull();
      } finally {
        await held!.release();
      }
    });
  }, 90_000);

  test('red control: a NON-lock error still fails the job (dead at max_attempts=1)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const queue = new MinionQueue(engine);
      // No lock held; the repo path does not exist, so performSync acquires
      // the lock fine and then throws a plain Error from git-root discovery.
      const job = await queue.add(
        'sync',
        { repoPath: '/nonexistent-gbrain-f1-red-control', pull: false },
        { max_attempts: 1 },
      );
      const terminal = await runJobToTerminal(job, queue);

      // Classification CAN differ: this consumer marks non-lock errors dead.
      expect(terminal.status).toBe('dead');
      expect(terminal.result ?? null).toBeNull();
      expect(terminal.error_text ?? '').not.toBe('');
      expect(terminal.error_text ?? '').not.toContain('sync_in_progress');
    });
  }, 90_000);
});

// ─── Consumer 2: cycle sync phase (src/core/cycle.ts runPhaseSync) ─────────
// runPhaseSync is module-private; the real seam is runCycle with
// phases: ['sync'] against the real performSync (no stubs).

describe('cycle sync phase — SyncLockBusyError is a skip, not a phase failure', () => {
  test('held per-source sync lock → phase skipped with details.syncStatus lock_busy', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const brainDir = makeGitRepo();
      // Register the dir as a source so resolveSourceForDir routes the sync
      // phase to this source's lock key (per-source lock routing pinned too).
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived, created_at)
         VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        ['cyclesrc', 'cyclesrc', brainDir],
      );
      const held = await tryAcquireDbLock(engine, syncLockId('cyclesrc'));
      expect(held).not.toBeNull();
      try {
        const report = await runCycle(engine, { brainDir, phases: ['sync'] });
        const sync = report.phases.find((p) => p.phase === 'sync');
        expect(sync).toBeDefined();
        // Pin the real constant strings from src/core/cycle.ts runPhaseSync.
        expect(sync!.status).toBe('skipped');
        expect(sync!.details.syncStatus).toBe('lock_busy');
        expect(sync!.summary).toBe('sync already in progress elsewhere — skipped');
        expect(sync!.error).toBeUndefined();
        // The skip never paints the whole cycle red.
        expect(report.status).not.toBe('failed');
      } finally {
        await held!.release();
      }
    });
  }, 90_000);

  test('red control: a NON-lock error still fails the phase (and the cycle)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const brainDir = makeGitRepo();
      rmSync(brainDir, { recursive: true, force: true });
      const report = await runCycle(engine, { brainDir, phases: ['sync'] });
      const sync = report.phases.find((p) => p.phase === 'sync');
      expect(sync).toBeDefined();
      // Classification CAN differ: same consumer, non-lock error → 'fail',
      // no lock_busy marker, structured error attached.
      expect(sync!.status).toBe('fail');
      expect(sync!.details.syncStatus).toBeUndefined();
      expect(sync!.error).toBeDefined();
      expect(report.status).toBe('failed');
    });
  }, 90_000);
});

// ─── formatLockBusyMessage (src/core/sync-lock.ts) ─────────────────────────

describe('formatLockBusyMessage', () => {
  test('names holder pid/host and includes --break-lock + --source remediation', async () => {
    const lockKey = syncLockId('msgsrc');
    const held = await tryAcquireDbLock(engine, lockKey);
    expect(held).not.toBeNull();
    try {
      const msg = await formatLockBusyMessage(engine, lockKey);
      expect(msg).toContain(`lock ${lockKey} held by pid ${process.pid} on ${hostname()}`);
      expect(msg).toContain('--break-lock');
      expect(msg).toContain(`gbrain sync --break-lock --source msgsrc`);
    } finally {
      await held!.release();
    }
  });

  test('degrades to the legacy message when inspectLock throws (no crash)', async () => {
    // A poisoned engine whose query path throws makes the REAL inspectLock
    // fail; formatLockBusyMessage must catch and fall back, never throw.
    const poisoned = {
      kind: 'pglite',
      db: {
        query: async () => {
          throw new Error('inspect boom');
        },
      },
    } as unknown as BrainEngine;
    const lockKey = syncLockId('msgsrc');
    const msg = await formatLockBusyMessage(poisoned, lockKey);
    expect(msg).toBe(
      `Another sync is in progress (lock ${lockKey} held). ` +
        `Wait for it to finish, or run 'gbrain doctor' if it has been more than 30 minutes.`,
    );
    // Control: the degraded message carries no holder detail / remediation.
    expect(msg).not.toContain('--break-lock');
    expect(msg).not.toContain(`pid ${process.pid}`);
  });
});
