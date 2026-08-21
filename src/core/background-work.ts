/**
 * v0.42.20.0 (#1762 / #1745 / #1775 reliability wave) — process background-work
 * registry. Single source of truth for "drain every fire-and-forget sink before
 * the CLI exits / disconnects."
 *
 * WHY THIS EXISTS (rule-of-four): four independent fire-and-forget sinks each
 * write to the DB after an op returns its response —
 *   - `last-retrieved.ts`     UPDATE pages.last_retrieved_at   (#1247/#1269/#1290)
 *   - `facts/queue.ts`        facts:absorb Haiku job + logIngest (#1762)
 *   - `search/hybrid.ts`      query_cache write
 *   - `eval-capture.ts`       eval_candidates INSERT
 * On PGLite, if `engine.disconnect()` nulls `_db` while one of these is in
 * flight, the sink's "not connected" error path re-pumps via queueMicrotask and
 * spins `db.close()` into a 100%-CPU busy-loop that pins the single-writer lock
 * (the #1762 incident). The fix is to DRAIN every sink before disconnect. A
 * registry (not a hand-written N-call helper) makes that structural: a future
 * 5th sink that registers is auto-drained, and the drain is invoked from THREE
 * exit points (op-dispatch success finally, op-dispatch error catch, CLI_ONLY
 * finally) without repeating the sink list at each.
 *
 *   register (at module import) ──┐
 *     facts            (order 0)  │
 *     last-retrieved   (order 1)  │
 *     search-cache     (order 2)  ├─► Map<name, drainer>
 *     eval-capture     (order 3)  │
 *     volunteer-events (order 4)  │
 *     search-telemetry (order 5)  ┘   (#4143 — was the unregistered 5th sink)
 *                                      │  CLI exit                │ engine.disconnect() (#4143)
 *                                      ▼                          ▼
 *   drainAllBackgroundWorkForCliExit   drainBackgroundWorkBeforeDisconnect
 *      mode 'exit', abort allowed         mode 'disconnect', NO abort
 *              └───────────► sort by (order, name) ◄───────────┘
 *                              for each: await drain(timeoutMs, mode)
 *                                        if unfinished>0 && abort && allowAbort:
 *                                           await abort()   ◄─ facts shutdown()
 *
 * Registration MUST live in the enqueue-owning module (so "module not imported
 * ⇒ no work enqueued ⇒ nothing to drain" holds). The Map is keyed by name so a
 * re-import / test mock REPLACES rather than duplicating (an array would
 * double-register).
 */

/**
 * Which exit point is draining (#4143). 'exit' = CLI teardown, engine still
 * live afterward until the caller disconnects — sinks may flush residual
 * buffers. 'disconnect' = an engine is mid-disconnect (its handle may already
 * be nulled) — sinks must only await IN-FLIGHT work settling and must not
 * start new writes (a lossy buffer stays lossy here by design).
 *
 * NOTE: this module stays a zero-import leaf ON PURPOSE — both engines import
 * it statically (check-engine-dynamic-import files), so any import added here
 * risks a cycle. The warn below is a local once-per-process Set, not
 * utils.warnOncePerProcess, for exactly that reason.
 */
export type BackgroundWorkDrainMode = 'exit' | 'disconnect';

/**
 * Shared teardown budgets (#4284). This module is the natural home: it is the
 * zero-import leaf that every teardown participant (both engines,
 * cli-force-exit, process-watchdog) already imports, so budget numbers defined
 * here cannot drift between the components that must agree on them.
 */

/**
 * setTimeout delay ceiling: Node/Bun overflow-clamp anything above 2^31−1 to
 * ~1ms (TimeoutOverflowWarning), so an oversized delay must be clamped to
 * mean "longer bound", never an instant spurious fire.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Per-sink bound for one drain pass (the `runDrainers` default below). */
export const SINK_DRAIN_TIMEOUT_MS = 2000;

/**
 * #4143/#4284 — the in-loop bound for PGlite.close() inside disconnect().
 * Read per call (not module load) so tests and incident responders can set
 * GBRAIN_PGLITE_CLOSE_TIMEOUT_MS without subprocess gymnastics; floor 1s,
 * ceiling 2^31−1. Lives here (not in the engine) so cli-force-exit's
 * computed teardown deadline budgets the SAME bound the engine will actually
 * honor — a hardcoded copy drifted the moment the bound became tunable.
 * HONEST SCOPE lives at the close site in pglite-engine.ts: this bound
 * catches a close that still YIELDS; a wedged loop needs the out-of-band
 * watchdog.
 */
export function pgliteCloseTimeoutMs(): number {
  return Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(1000, Number(process.env.GBRAIN_PGLITE_CLOSE_TIMEOUT_MS ?? '') || 5000),
  );
}

export interface BackgroundWorkDrainer {
  /** Stable identity; also the Map key (idempotent registration). */
  name: string;
  /**
   * Explicit drain order — lower runs first. Facts is 0 so its abort-path DB
   * `logIngest` gets the freshest live-engine window before the fast
   * last-retrieved / search-cache drains. Ties break by name for determinism.
   */
  order: number;
  /**
   * Resolve when in-flight work settles OR the bound elapses; report leftovers.
   * `mode` (#4143) tells the sink whether residual buffers may flush ('exit',
   * engine still live) or only in-flight work may be awaited ('disconnect').
   * Pre-#4143 drainers that ignore the parameter keep their exact behavior.
   */
  drain(timeoutMs: number, mode: BackgroundWorkDrainMode): Promise<{ unfinished: number }>;
  /**
   * Optional hard-stop for stragglers (facts-queue: `shutdown()`). AWAITED by
   * the registry so the aborted job's DB write settles against a live engine
   * BEFORE the caller disconnects. Only invoked when `drain` reports unfinished.
   */
  abort?(): Promise<void>;
}

const drainers = new Map<string, BackgroundWorkDrainer>();

/** Register (or replace, by name) a fire-and-forget sink drainer. */
export function registerBackgroundWorkDrainer(d: BackgroundWorkDrainer): void {
  drainers.set(d.name, d);
}

/**
 * Number of registered sinks. Used by `finishCliTeardown` (cli-force-exit.ts)
 * to COMPUTE its backstop deadline from the bounds it guards — a 5th sink
 * registering automatically widens the deadline instead of silently making
 * the worst-case bounded drain exceed a static number (#2084 eng-review D9).
 */
export function backgroundWorkSinkCount(): number {
  return drainers.size;
}

/**
 * Test seam — registers a drainer and returns an unregister handle. Preferred
 * over a blunt reset: real sink modules register at import time and won't re-run
 * that top-level side effect on a second import, so a global clear would
 * silently drop the production drainers for the rest of the test process.
 */
export function __registerDrainerForTest(d: BackgroundWorkDrainer): () => void {
  drainers.set(d.name, d);
  return () => { drainers.delete(d.name); };
}

/** Test seam — snapshot of registered drainer names (sorted), for assertions. */
export function __listDrainerNamesForTest(): string[] {
  return [...drainers.keys()].sort();
}

/**
 * CLI-EXIT-ONLY. `abort()` is a permanent process-level state change on a sink
 * (the facts queue's `shutdown()` sets `shuttingDown=true` for the process
 * lifetime). NEVER call this in a long-lived process (`gbrain serve`). Drains
 * every registered sink before `engine.disconnect()` so a PGLite `db.close()`
 * can't race in-flight work into the re-pump busy-loop (#1762).
 *
 * Best-effort and non-throwing: one sink's failure never blocks the others or
 * the subsequent disconnect.
 */
export async function drainAllBackgroundWorkForCliExit(opts?: { timeoutMs?: number }): Promise<void> {
  await runDrainers(opts?.timeoutMs ?? SINK_DRAIN_TIMEOUT_MS, { allowAbort: true, mode: 'exit' });
}

/**
 * ENGINE-DISCONNECT drain (#4143). Called by BOTH engines' `disconnect()` so
 * an in-flight fire-and-forget statement settles before the underlying handle
 * closes — PGLite's `close()` deadlocks PERMANENTLY (close's promise AND the
 * in-flight query's promise never settle) when a statement is in flight.
 * Unlike the CLI-exit drain this NEVER calls `abort()` (a permanent
 * process-level state change, wrong for a long-lived `gbrain serve` that
 * disconnects one engine) and passes mode 'disconnect' so sinks skip residual
 * buffer flushes (new writes would fail against the already-nulled handle
 * anyway — that failing fast is intended, not a bug).
 *
 * Best-effort and non-throwing; O(~0) when every sink's fast path is empty,
 * which is the ordinary case for the hundreds of test `afterEach(disconnect)`
 * hooks.
 */
export async function drainBackgroundWorkBeforeDisconnect(opts?: { timeoutMs?: number }): Promise<void> {
  await runDrainers(opts?.timeoutMs ?? SINK_DRAIN_TIMEOUT_MS, { allowAbort: false, mode: 'disconnect' });
}

const warnedOnce = new Set<string>();

async function runDrainers(
  timeoutMs: number,
  opts: { allowAbort: boolean; mode: BackgroundWorkDrainMode },
): Promise<void> {
  const ordered = [...drainers.values()].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  for (const d of ordered) {
    try {
      const { unfinished } = await d.drain(timeoutMs, opts.mode);
      if (unfinished > 0 && d.abort && opts.allowAbort) {
        // codex #9: AWAIT — the facts:absorb job writes its absorb-log to the
        // DB on settle; the abort must finish against a live engine before the
        // caller disconnects.
        await d.abort();
      } else if (unfinished > 0 && !opts.allowAbort) {
        // #4143: a silent partial drain at disconnect is the invisible-failure
        // class this registry exists to kill — say it once per sink.
        const key = `drain-unfinished:${d.name}`;
        if (!warnedOnce.has(key)) {
          warnedOnce.add(key);
          console.error(`[background-work] sink '${d.name}' still had ${unfinished} unfinished item(s) after the ${timeoutMs}ms disconnect drain`);
        }
      }
    } catch {
      /* best-effort; never block disconnect on one sink's failure */
    }
  }
}
