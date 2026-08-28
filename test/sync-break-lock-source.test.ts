/**
 * #4412 — `gbrain sync --break-lock` / `--force-break-lock` must resolve the
 * target source through the SAME tiers as the sync path (flag → GBRAIN_SOURCE
 * env → dotfile → local_path → ...), not a bare `--source argv ?? 'default'`
 * fallback.
 *
 * Pre-fix, a crashed env/dotfile-resolved sync (e.g. the serve-delegated sync
 * holding gbrain-sync:workspace in sync-delegation-under-serve Pin 3/4) told
 * the operator to re-run `gbrain sync --break-lock`; the break-lock branch
 * then "successfully" broke the absent gbrain-sync:default while the real
 * lock stayed dead-held through the 60s takeover grace, so the follow-up
 * sync still refused with exit 1.
 *
 * Test isolation: canonical PGLite block (R3 + R4); env via withEnv (R1);
 * no subprocesses.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hostname } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSync } from '../src/commands/sync.ts';

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
  // Also clear gbrain_cycle_locks since resetPgliteState focuses on user data
  // and the lock table is per-test state we want fresh.
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks', []);
});

// Insert a gbrain-sync:<sourceId> lock row held by a dead pid, acquired NOW —
// inside the 60s takeover grace, the exact state a SIGKILLed sync leaves.
async function insertDeadHeldLock(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes', NOW())`,
    [`gbrain-sync:${sourceId}`, 999999, hostname()],
  );
}

async function lockExists(sourceId: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
    [`gbrain-sync:${sourceId}`],
  );
  return rows.length > 0;
}

/** Run runSync(args) with process.exit + console.log captured. */
async function runSyncCaptured(args: string[]): Promise<{ exitCode: number | undefined; out: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origExit = process.exit;
  let exitCode: number | undefined;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  (process.exit as unknown as (code?: number) => void) = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as never;
  try {
    await runSync(engine, args);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
  }
  return { exitCode, out: logs.join('\n') };
}

describe("#4412 — break-lock resolves source through sync's own tiers", () => {
  test("GBRAIN_SOURCE-resolved: --force-break-lock breaks the env source's lock, not gbrain-sync:default", async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('workspace', 'workspace')`);
    await insertDeadHeldLock('workspace');

    const { exitCode } = await withEnv({ GBRAIN_SOURCE: 'workspace' }, () =>
      runSyncCaptured(['--force-break-lock', '--yes']),
    );

    expect(exitCode).toBe(0);
    // Pre-fix red: the branch targeted gbrain-sync:default (absent), printed
    // the wedge hint, exited 0 — and the workspace row survived dead-held.
    expect(await lockExists('workspace')).toBe(false);
  });

  test('explicit --source still wins over env and needs no registered source row', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('workspace', 'workspace')`);
    await insertDeadHeldLock('workspace');
    // 'other' is deliberately NOT in sources: breaking a deleted source's
    // leftover lock via explicit --source must keep working (no existence
    // assertion on the flag path).
    await insertDeadHeldLock('other');

    const { exitCode } = await withEnv({ GBRAIN_SOURCE: 'workspace' }, () =>
      runSyncCaptured(['--force-break-lock', '--source', 'other', '--yes']),
    );

    expect(exitCode).toBe(0);
    expect(await lockExists('other')).toBe(false);
    expect(await lockExists('workspace')).toBe(true);
  });
});
