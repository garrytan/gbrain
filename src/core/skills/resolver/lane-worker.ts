/**
 * Starts the hook lane's worker thread (hook-worker.ts). The CLI's lane fast
 * path (src/cli.ts) calls it before it loads the lane itself, so the worker's
 * start-up and module loading run beside the CLI's; the lane then takes that
 * worker instead of starting its own. It imports nothing but worker_threads.
 *
 * A compiled binary bundles src/ under a virtual root (/$bunfs/root/, ~BUN on
 * Windows) and carries hook-worker.ts as a second entrypoint at its
 * src-relative path (every release build passes it); the bundle's own
 * import.meta.url is the binary, so the path is taken from there.
 */
import { Worker } from 'node:worker_threads';

export const WORKER_SRC_PATH = 'core/skills/resolver/hook-worker.ts';
const workerEntry = (): string | URL => (/[\\/](\$bunfs|~BUN)[\\/]/.test(import.meta.url) ? Bun.main.replace(/[^\\/]*$/, '') + WORKER_SRC_PATH : new URL('./hook-worker.ts', import.meta.url));

let started: Worker | null = null;
let failed = false;

/** Start the worker (once per process). Null when it cannot start; the lane then reports skill_resolver_internal. */
export function startLaneWorker(env: NodeJS.ProcessEnv = process.env): Worker | null {
  if (started) return started;
  try {
    started = new Worker(workerEntry(), { workerData: { stall: env.GBRAIN_TEST_SKILL_LANE_STALL } });
    started.unref();
    started.on('error', () => { failed = true; });
    started.on('exit', () => { failed = true; });
  } catch { started = null; }
  return started;
}

/** True once the started worker has failed or exited, which can happen before the lane is ready to listen. */
export const laneWorkerFailed = (): boolean => failed;
