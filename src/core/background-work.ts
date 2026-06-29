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
 *   register (at module import) ─┐
 *     last-retrieved (order 1)   │
 *     facts          (order 0)   ├─► Map<name, drainer>
 *     search-cache   (order 2)   │
 *     eval-capture   (order 3)   ┘
 *                                      │  CLI exit
 *                                      ▼
 *   drainAllBackgroundWorkForCliExit ──► sort by (order, name)
 *                                          for each: await drain(timeoutMs)
 *                                                    if unfinished>0 && abort:
 *                                                       await abort()   ◄─ facts shutdown()
 *                                      ▼
 *                                  engine.disconnect()  (caller)
 *
 * Registration MUST live in the enqueue-owning module (so "module not imported
 * ⇒ no work enqueued ⇒ nothing to drain" holds). The Map is keyed by name so a
 * re-import / test mock REPLACES rather than duplicating (an array would
 * double-register).
 */

export interface BackgroundWorkDrainer {
  /** Stable identity; also the Map key (idempotent registration). */
  name: string;
  /**
   * Explicit drain order — lower runs first. Facts is 0 so its abort-path DB
   * `logIngest` gets the freshest live-engine window before the fast
   * last-retrieved / search-cache drains. Ties break by name for determinism.
   */
  order: number;
  /** Resolve when in-flight work settles OR the bound elapses; report leftovers. */
  drain(timeoutMs: number): Promise<{ unfinished: number }>;
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
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const ordered = [...drainers.values()].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  for (const d of ordered) {
    try {
      const { unfinished } = await d.drain(timeoutMs);
      if (unfinished > 0 && d.abort) {
        // codex #9: AWAIT — the facts:absorb job writes its absorb-log to the
        // DB on settle; the abort must finish against a live engine before the
        // caller disconnects.
        await d.abort();
      }
    } catch {
      /* best-effort; never block disconnect on one sink's failure */
    }
  }
}
