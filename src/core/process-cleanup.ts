/**
 * Process-cleanup registry.
 *
 * v0.41.6.0 D5 — registry + signal handlers so abnormal termination
 * (SIGTERM/SIGHUP/SIGPIPE, EPIPE on stdout, uncaughtException) releases
 * locks instead of leaking them for up to 30 minutes until the TTL
 * expires. Pre-v0.41.6.0, `gbrain sync --full | head -20` would SIGPIPE
 * gbrain, finally blocks wouldn't run, and the next sync would report
 * "Another sync is in progress" because the lock row was orphaned.
 *
 * Design (per eng-review D7 + outside-voice F9-F11, 2026-05-24):
 *
 *  - Signal scope: SIGTERM, SIGHUP, SIGPIPE, uncaughtException,
 *    unhandledRejection. **NOT SIGINT** — gbrain has an existing
 *    SIGINT-via-AbortController path at cli.ts:254 that propagates
 *    abort to in-flight operations (clean cancel). Installing cleanup
 *    on SIGINT here would preempt that flow. Lock release on user
 *    cancel belongs in the AbortController path, not in a parallel
 *    signal handler.
 *
 *  - Idempotent: a second signal during the cleanup pass is a NO-OP.
 *    First pass runs to its 3s deadline; users who want a forced exit
 *    can SIGKILL.
 *
 *  - Single ownership: `tryAcquireDbLock` auto-registers; the returned
 *    handle's `release()` deregisters. `withRefreshingLock` just
 *    consumes the handle as a normal caller (it calls tryAcquireDbLock
 *    internally, so the registration happens there). No double-register.
 *
 *  - Best-effort: cleanup callbacks run via Promise.allSettled with a
 *    3s deadline. Throws don't block other callbacks. Engine pool
 *    already closed → DELETE fails silently → process exits anyway.
 *
 *  - Normal exit path unchanged: try/finally in `tryAcquireDbLock` and
 *    `withRefreshingLock` already releases on normal completion;
 *    deregister-before-release is atomic in single-threaded JS so no
 *    double-DELETE.
 */

const CLEANUP_DEADLINE_MS = 3_000;

interface CleanupEntry {
  name: string;
  fn: () => Promise<void>;
}

const registry = new Map<symbol, CleanupEntry>();
let installed = false;
let cleanupInFlight = false;

/**
 * Register a cleanup callback. Returns a deregister handle (idempotent
 * on second call). Cleanup callbacks fire on abnormal termination only;
 * normal completion uses the caller's own try/finally.
 *
 * Names are for diagnostic stderr output if the callback throws; pick
 * something human-readable.
 */
export function registerCleanup(name: string, fn: () => Promise<void>): () => void {
  const key = Symbol(name);
  registry.set(key, { name, fn });
  let deregistered = false;
  return () => {
    if (deregistered) return;
    deregistered = true;
    registry.delete(key);
  };
}

/**
 * Read the currently registered cleanup count. Test seam.
 *
 * @internal
 */
export function _registeredCleanupCountForTests(): number {
  return registry.size;
}

/**
 * Manually trigger the cleanup pass + exit. Used by the EPIPE-on-stdout
 * handler so a broken pipe routes through cleanup instead of immediate
 * `process.exit(0)` (per outside-voice F10 / eng-review D13 fold-in).
 */
export async function triggerCleanupAndExit(code: number): Promise<void> {
  await runCleanupPass();
  process.exit(code);
}

async function runCleanupPass(): Promise<void> {
  if (cleanupInFlight) return; // Idempotent: second signal during cleanup is NO-OP.
  cleanupInFlight = true;

  const entries = Array.from(registry.values());
  if (entries.length === 0) return;

  const deadline = new Promise<'deadline'>((resolve) => {
    const t = setTimeout(() => resolve('deadline'), CLEANUP_DEADLINE_MS);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

  const cleanupAll = Promise.allSettled(
    entries.map(async (e) => {
      try { await e.fn(); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try { process.stderr.write(`[process-cleanup] ${e.name}: ${msg}\n`); }
        catch { /* even stderr might be broken */ }
        throw err;
      }
    }),
  );

  await Promise.race([cleanupAll, deadline]);
}

/**
 * Install signal handlers + the EPIPE-on-stdout handler. Idempotent
 * (second call is NO-OP). MUST be called once at CLI module load AFTER
 * any existing signal handlers (so we don't preempt the SIGINT
 * AbortController at cli.ts:254 — we don't listen to SIGINT here, but
 * documenting the install order keeps future maintainers aware).
 */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  const handleSignal = (signal: NodeJS.Signals) => {
    void runCleanupPass().finally(() => {
      // Match GNU `kill` exit-code convention: 128 + signal number for
      // signal-terminated processes. The actual integer doesn't matter
      // much (shells generally use it as advisory); the goal is "exit
      // promptly after cleanup".
      const code = signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : signal === 'SIGPIPE' ? 141 : 1;
      process.exit(code);
    });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGHUP', () => handleSignal('SIGHUP'));
  // SIGPIPE in Node is rarely raised directly (Node ignores it by default
  // and surfaces an EPIPE write error on the stream instead). Listen anyway
  // for environments where it does fire.
  process.on('SIGPIPE', () => handleSignal('SIGPIPE'));

  process.on('uncaughtException', (err) => {
    try { process.stderr.write(`[uncaughtException] ${err instanceof Error ? err.stack ?? err.message : err}\n`); }
    catch { /* stderr might be broken */ }
    void runCleanupPass().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    try { process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack ?? reason.message : reason}\n`); }
    catch { /* stderr might be broken */ }
    void runCleanupPass().finally(() => process.exit(1));
  });

  // EPIPE on stdout — the canonical `gbrain sync | head -N` case. Route
  // through the cleanup pass so locks release BEFORE we exit.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      void triggerCleanupAndExit(0);
    }
  });
  // Same for stderr — less common but possible (e.g. `2>&1 | head` after
  // stderr was rerouted to stdout).
  process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      // No stderr means no useful logs on the way out; still cleanup.
      void triggerCleanupAndExit(0);
    }
  });
}

/**
 * Test-only: reset all module state so the handler can re-install with
 * a clean slate. NEVER call from production code.
 *
 * @internal
 */
export function _resetForTests(): void {
  registry.clear();
  installed = false;
  cleanupInFlight = false;
}
