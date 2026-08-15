/**
 * Worker exit classifier — single source of truth for "is this exit a crash?"
 *
 * Three call sites consume this rule:
 *   1. `ChildWorkerSupervisor` (in-process, restart-policy decision)
 *   2. `gbrain doctor` (audit-log read, supervisor health surface)
 *   3. `gbrain jobs supervisor status` (audit-log read, CLI status)
 *
 * The supervisor reads Node's `child.on('exit', (code, signal) => …)` callback
 * shape; doctor and jobs read the audit-log JSON shape. JSON.stringify drops
 * `undefined` keys, so audit events surface missing exit codes as `code: null`
 * (or with the key absent). The helper signature accepts the audit-shape;
 * call sites that have Node's raw shape must normalize first (see
 * `child-worker-supervisor.ts` for the wrapping pattern).
 *
 * Rule: `code === 0` is a clean exit (graceful shutdown, watchdog drain,
 * queue completion). Everything else — non-zero integer, null, undefined,
 * missing key — counts as a crash. The default is "crash" so a corrupted
 * or pre-schema event row doesn't get silently demoted into the clean-restart
 * bucket.
 *
 * Pure function. No side effects, no I/O.
 */

export type WorkerExitEvent = {
  /**
   * The worker process's numeric exit code, as serialized in the audit JSON.
   * `null` means the process was killed by a signal (no exit code), or the
   * field was missing from the event row. Both are treated as crashes.
   */
  code?: number | null;
};

export type WorkerExitClassification = 'crash' | 'clean_exit';

export function classifyWorkerExit(event: WorkerExitEvent): WorkerExitClassification {
  return event.code === 0 ? 'clean_exit' : 'crash';
}
