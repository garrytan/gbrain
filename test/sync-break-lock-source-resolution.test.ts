/**
 * #4412 — `sync --break-lock` / `--force-break-lock` must break the lock of
 * the source the sync itself would use.
 *
 * Pre-fix, the break-lock branch hardcoded `sourceArg ?? 'default'` while the
 * sync path resolves through the full ambient chain (--source > GBRAIN_SOURCE
 * > dotfile > cwd > sole-non-default). Under GBRAIN_SOURCE=workspace (the
 * serve-delegation e2e harness, and any real install that scopes via env),
 * `gbrain sync --force-break-lock` inspected `gbrain-sync:default` — absent —
 * printed "nothing to break", exit 0, and left the DEAD holder's row on
 * `gbrain-sync:workspace`. The follow-up sync then refused for the 60s
 * takeover grace: exactly the Pin 4 failure in
 * test/e2e/sync-delegation-under-serve.serial.test.ts:263.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { hostname, tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSync } from '../src/commands/sync.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitSentinel';
  }
}

/** Run `runSync` with process.exit trapped; returns the exit code it requested. */
async function runSyncTrapped(args: string[], env: Record<string, string>): Promise<number> {
  const savedExit = process.exit;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  try {
    return await withEnv(env, async () => {
      await runSync(engine, args);
      return 0; // returned without exiting
    });
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  } finally {
    (process as unknown as { exit: typeof savedExit }).exit = savedExit;
  }
}

async function insertDeadLock(lockId: string): Promise<void> {
  // pid 999999 is above macOS/Linux default pid ranges — provably dead
  // (kill → ESRCH). Fresh timestamps model a just-SIGKILLed holder.
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, NOW(), NOW() + interval '30 minutes', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [lockId, 999999, hostname()],
  );
}

async function lockRows(): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM gbrain_cycle_locks ORDER BY id`,
  );
  return rows.map(r => r.id);
}

let srcDir: string;

beforeAll(async () => {
  srcDir = mkdtempSync(join(tmpdir(), 'gb-4412-src-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await addSource(engine, { id: 'workspace', localPath: srcDir, force: true });
}, 240_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (srcDir) rmSync(srcDir, { recursive: true, force: true });
}, 60_000);

describe('#4412 break-lock source resolution', () => {
  test('--force-break-lock under GBRAIN_SOURCE breaks THAT source\'s lock, not default', async () => {
    await engine.executeRaw(`DELETE FROM gbrain_cycle_locks`);
    await insertDeadLock('gbrain-sync:workspace');

    const code = await runSyncTrapped(
      ['--force-break-lock', '--yes'],
      { GBRAIN_SOURCE: 'workspace' },
    );
    expect(code).toBe(0);
    // Pre-fix: the row survived (the child inspected gbrain-sync:default).
    expect(await lockRows()).not.toContain('gbrain-sync:workspace');
  }, 60_000);

  test('an explicit --source still wins over the ambient chain', async () => {
    await engine.executeRaw(`DELETE FROM gbrain_cycle_locks`);
    await insertDeadLock('gbrain-sync:default');
    await insertDeadLock('gbrain-sync:workspace');

    const code = await runSyncTrapped(
      ['--force-break-lock', '--yes', '--source', 'default'],
      { GBRAIN_SOURCE: 'workspace' },
    );
    expect(code).toBe(0);
    const rows = await lockRows();
    expect(rows).not.toContain('gbrain-sync:default');
    expect(rows).toContain('gbrain-sync:workspace');
  }, 60_000);
});
