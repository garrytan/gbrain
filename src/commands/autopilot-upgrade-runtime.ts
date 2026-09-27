/** Runtime safety checks for the daemon's unattended upgrade window. */
import type { BrainEngine } from '../core/engine.ts';
import type { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';
import { inspectLock } from '../core/db-lock.ts';
import { execFileSync } from 'node:child_process';
import { currentCliInvocation } from '../core/current-cli-invocation.ts';
import { clearPendingUpgrade, pendingUpgradeExists } from '../core/autopilot-upgrade-pending.ts';
import { sourceUpgradeIncomplete } from '../core/source-upgrade-guard.ts';

/** Ambiguous queue or lock state is busy. */
export async function computeAutopilotIdle(engine: BrainEngine, engineType: string): Promise<boolean> {
  try {
    if (await inspectLock(engine, 'gbrain-cycle')) return false;
    if (engineType !== 'postgres') return true;
    const rows = await (engine as any).executeRaw?.(
      `SELECT count(*)::int AS n FROM minion_jobs WHERE status IN ('active','waiting')`,
    );
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return Number((rows as Array<{ n: number }>)[0]?.n) === 0;
  } catch {
    return false;
  }
}

/** Quiesce the managed worker before mutating a source checkout. */
export async function drainUpgradeWorker(worker: ChildWorkerSupervisor | null): Promise<void> {
  if (!worker) return;
  worker.killChild('SIGTERM');
  await worker.awaitChildExit(35_000);
  if (worker.childAlive) {
    worker.killChild('SIGKILL');
    await worker.awaitChildExit(5_000);
    if (worker.childAlive) throw new Error('managed worker did not stop before upgrade');
  }
}

/** A failed child may be retried when the supervised entrypoint is unchanged. */
export function clearPendingIfUnchanged(version: string): boolean {
  try {
    const current = currentCliInvocation(['--version']);
    const observed = execFileSync(current.file, current.args, { encoding: 'utf8', timeout: 10_000 }).trim().replace(/^gbrain\s*/i, '');
    if (observed !== version) return false;
    clearPendingUpgrade();
    return true;
  } catch {
    return false;
  }
}

/** Package managers may leave a partial install even when version is unchanged. */
export function mayRetryUnchangedInstall(method: string): boolean {
  return method === 'binary' || method === 'bun-link';
}

/** Failure reporting must not hide an incomplete swap. */
export function stopOnUpgradeReportFailure(swapStarted = false): boolean {
  try { return swapStarted || sourceUpgradeIncomplete() || pendingUpgradeExists(); }
  catch { return true; }
}
