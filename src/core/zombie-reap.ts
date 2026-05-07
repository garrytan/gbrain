/**
 * Reap zombie child processes.
 *
 * Bun (like Node) only auto-reaps child processes when a SIGCHLD handler is
 * installed. Without this, child processes spawned by the worker (embed
 * batches, shell jobs, sub-agents) become zombies when they exit,
 * accumulating in the PID table and (in the original production cascade)
 * holding phantom DB connection slots.
 *
 * A no-op handler is sufficient — the runtime calls waitpid() internally as
 * long as a listener is registered. EventEmitter does NOT dedupe listeners by
 * reference; the includes() check below is what prevents duplicate listeners
 * across hot-import scenarios (test harnesses re-importing modules in the
 * same process).
 */

const reapHandler = () => {};

export function installSigchldHandler(): void {
  // SIGCHLD is POSIX-only. On Windows, `process.on('SIGCHLD', ...)` throws
  // "ENOTSUP" because Windows doesn't have signals. Guard by platform so a
  // future Windows port of any gbrain CLI doesn't crash at boot.
  if (process.platform === 'win32') return;
  if (!process.listeners('SIGCHLD').includes(reapHandler)) {
    process.on('SIGCHLD', reapHandler);
  }
}

/**
 * Test-only: removes the handler so other test files in the same shard
 * process don't observe a pre-installed listener. Call from `afterAll` in
 * `test/zombie-reap.test.ts`.
 */
export function _uninstallSigchldHandlerForTests(): void {
  process.removeListener('SIGCHLD', reapHandler);
}
