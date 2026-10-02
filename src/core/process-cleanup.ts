/**
 * Process-cleanup registry.
 *
 * v0.41.6.0 D5 — registry + signal handlers so abnormal termination
 * (SIGTERM/SIGHUP/SIGPIPE, EPIPE on stdout, uncaughtException) releases
 * locks instead of leaking them for up to 30 minutes until the TTL
 * expires. Pre-v0.41.6.0, a full `gbrain sync` piped into `head` would
 * SIGPIPE gbrain, finally blocks wouldn't run, and the next sync would report
 * "Another sync is in progress" because the lock row was orphaned.
 *
 * (The flag name is spelled out rather than written literally: the CLI
 * flag-registry generator scans comments, so a bare double-dash token here
 * would be inherited as an accepted flag by every command that imports this
 * module. Pinned by `test/cli-flag-validation.test.ts`.)
 *
 * Design (per eng-review D7 + outside-voice F9-F11, 2026-05-24):
 *
 *  - Signal scope: SIGTERM, SIGHUP, SIGPIPE, uncaughtException,
 *    unhandledRejection. **NOT SIGINT** — gbrain has an existing
 *    SIGINT-via-AbortController path in cli.ts that propagates
 *    abort to in-flight operations (clean cancel). Installing cleanup
 *    on SIGINT here would preempt that flow. Lock release on user
 *    cancel belongs in the AbortController path, not in a parallel
 *    signal handler.
 *
 *  - Idempotent: callbacks run once. A second signal during the cleanup
 *    pass waits for that pass (bounded by its 3s deadline) before
 *    exiting, so it cannot exit ahead of the lock DELETE; users who want
 *    a forced exit can SIGKILL.
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
let cleanupPass: Promise<void> | null = null;
/** Refs to every listener attached by installSignalHandlers, keyed by
 *  target+event, so _resetForTests can DETACH them — without this, a test
 *  that installs and "resets" leaves a live SIGTERM→exit(143) listener on
 *  the shared bun test runner, and any later synthetic
 *  `process.emit('SIGTERM')` kills the entire suite. */
const installedListeners: Array<{
  target: NodeJS.Process | NodeJS.WriteStream;
  event: string;
  fn: (...args: never[]) => void;
}> = [];

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

function runCleanupPass(): Promise<void> {
  cleanupPass ??= runCleanupCallbacks();
  return cleanupPass;
}

async function runCleanupCallbacks(): Promise<void> {
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
 * (second call is NO-OP). MUST be called once from the CLI ENTRYPOINT —
 * inside cli.ts's `import.meta.main` seam, before main() dispatches —
 * and NOT at module load: a module-load install leaks a process-wide
 * SIGTERM→exit(143) handler into any process that merely imports cli.ts
 * (a bun test runner died mid-suite when a test emitted a synthetic
 * SIGTERM). The SIGINT AbortController path in cli.ts stays untouched —
 * we don't listen to SIGINT here.
 */
export function installSignalHandlers(opts: { keepServingOnLogEpipe?: boolean } = {}): void {
  if (installed) return;
  installed = true;
  // #5079: for `serve --http`, stdout/stderr are only log streams (the MCP
  // transport is the HTTP socket), so a closed log pipe must not stop the
  // server: the log write is dropped and it keeps serving. Everywhere else a
  // broken pipe still exits (for stdio `serve` it means the client left).
  const keepServing = opts.keepServingOnLogEpipe === true;

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

  const attach = (
    target: NodeJS.Process | NodeJS.WriteStream,
    event: string,
    fn: (...args: never[]) => void,
  ): void => {
    (target as NodeJS.Process).on(event as 'exit', fn as () => void);
    installedListeners.push({ target, event, fn });
  };

  attach(process, 'SIGTERM', () => handleSignal('SIGTERM'));
  attach(process, 'SIGHUP', () => handleSignal('SIGHUP'));
  // Bun delivers SIGPIPE on a broken pipe (Node ignores it by default and
  // surfaces only an EPIPE write error on the stream, handled below).
  attach(process, 'SIGPIPE', () => { if (!keepServing) handleSignal('SIGPIPE'); });

  attach(process, 'uncaughtException', (err: unknown) => {
    try { process.stderr.write(`[uncaughtException] ${err instanceof Error ? err.stack ?? err.message : err}\n`); }
    catch { /* stderr might be broken */ }
    void runCleanupPass().finally(() => process.exit(1));
  });
  attach(process, 'unhandledRejection', (reason: unknown) => {
    try { process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? reason.stack ?? reason.message : reason}\n`); }
    catch { /* stderr might be broken */ }
    void runCleanupPass().finally(() => process.exit(1));
  });

  // EPIPE on stdout — the canonical `gbrain sync | head -N` case. Route
  // through the cleanup pass so locks release BEFORE we exit.
  attach(process.stdout, 'error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' && !keepServing) {
      void triggerCleanupAndExit(0);
    }
  });
  // Same for stderr — less common but possible (e.g. `2>&1 | head` after
  // stderr was rerouted to stdout).
  attach(process.stderr, 'error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' && !keepServing) {
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
  // Detach every listener installSignalHandlers attached — clearing flags
  // alone leaves a live SIGTERM→exit(143) listener on the shared test-runner
  // process, which a later synthetic `process.emit('SIGTERM')` would trigger,
  // killing the whole suite.
  for (const { target, event, fn } of installedListeners) {
    (target as NodeJS.Process).off(event as 'exit', fn as () => void);
  }
  installedListeners.length = 0;
  installed = false;
  cleanupPass = null;
}
