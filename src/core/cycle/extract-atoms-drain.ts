/**
 * issue #1678 — bounded single-hold drain for extract_atoms.
 *
 * The operator/agent escape hatch for a backlog the routine cycle won't touch
 * (pack-gated off) or can't keep up with. Design per Codex #8/#9/#10:
 *
 *  - SINGLE continuous lock hold (no release/reacquire between batches). The
 *    caller wraps the loop in `withRefreshingLock(cycleLockIdFor(sourceId))` —
 *    the SAME lock id the routine cycle uses for that source — so the two
 *    genuinely contend (no source-vs-legacy lock mismatch) and there's no
 *    release-gap where autopilot/sync could mutate pages mid-drain (which would
 *    let the drain extract atoms from stale content).
 *  - REDISCOVER eligibility each batch (the injected `runBatch` re-runs the
 *    NOT-EXISTS-on-source_hash discovery), so stale content simply doesn't
 *    match — no cross-window cursor of page lists.
 *  - BOUNDED by a wallclock window; reports `remaining` so a cron/agent loop
 *    knows whether to run again.
 *
 * Pure over injected deps: no DB, no LLM, no lock primitive imported here, so
 * the loop logic is unit-testable. The wiring helper `runExtractAtomsDrainForSource`
 * (below) builds the real deps; it uses DYNAMIC imports so this module's static
 * graph stays empty and the pure-loop unit tests don't drag in db-lock / cycle.
 */

import type { BrainEngine } from '../engine.ts';
import { anySignal } from '../abort-check.ts';

/** Fresh cleanup budget for the lock release after the window signal fires. */
const LOCK_RELEASE_GRACE_MS = 5_000;

export interface ExtractAtomsDrainDeps {
  /**
   * Run the loop body while holding the cycle lock. Implemented by the caller
   * via `withRefreshingLock`. MUST throw when the lock is held by another
   * process (e.g. `LockUnavailableError`) — the drain lets that propagate so
   * the caller can report `cycle_already_running` and exit, matching the
   * routine cycle's skip contract. The signal bounds lock acquisition too.
   */
  withLock: <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T>;
  /** Process one batch. The signal fires at the drain wallclock deadline. */
  runBatch: (signal: AbortSignal) => Promise<{ extracted: number; skipped: number }>;
  /** Count remaining eligible-but-unextracted pages, or null on query error. */
  countRemaining: (signal: AbortSignal) => Promise<number | null>;
  /** Injectable clock. Production: Date.now. */
  now: () => number;
  /** Optional progress sink (one line per batch). */
  onBatch?: (info: { batch: number; extracted: number; remaining: number | null }) => void;
}

export interface ExtractAtomsDrainOpts {
  /** Wallclock budget in ms. The loop stops after this elapses. */
  windowMs: number;
  /** Hard cap on batches (belt-and-suspenders against a 0-progress loop). Default 1000. */
  maxBatches?: number;
  /** External caller cancellation (worker timeout / shutdown). */
  abortSignal?: AbortSignal;
}

export interface ExtractAtomsDrainResult {
  phase: 'extract_atoms';
  status: 'ok';
  extracted: number;
  skipped: number;
  /** Eligible pages still pending after the window. null if the count errored. */
  remaining: number | null;
  /** Batches actually processed. */
  batches: number;
  /** Why the loop stopped: drained | window | no_progress | max_batches. */
  stopped: 'drained' | 'window' | 'no_progress' | 'max_batches';
}

export async function runExtractAtomsDrain(
  deps: ExtractAtomsDrainDeps,
  opts: ExtractAtomsDrainOpts,
): Promise<ExtractAtomsDrainResult> {
  const maxBatches = opts.maxBatches ?? 1000;
  const deadline = deps.now() + opts.windowMs;
  // #2750: the window used to be checked only BETWEEN batches, so one slow
  // batch (sequential LLM calls) or a hung lock/count/write overran it without
  // bound (observed window=120s → 282.5s). A real-time deadline signal now
  // cancels (Postgres) or abandons (PGLite, cooperative) whatever is in
  // flight; the injected clock still drives loop-boundary checks so the pure
  // loop stays unit-testable.
  const signal = anySignal(
    AbortSignal.timeout(Math.max(1, opts.windowMs)),
    opts.abortSignal,
  );
  const result: ExtractAtomsDrainResult = await deps.withLock(async () => {
    let extracted = 0;
    let skipped = 0;
    let batches = 0;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';

    while (deps.now() < deadline && !signal.aborted) {
      if (batches >= maxBatches) { stopped = 'max_batches'; break; }

      let before: number | null;
      try {
        before = await deps.countRemaining(signal);
      } catch (err) {
        if (signal.aborted) break;
        throw err;
      }
      if (before === 0) { stopped = 'drained'; break; }

      // The backlog count consumed the same wallclock budget — re-check so a
      // slow count can't hand the batch a window that already expired.
      if (deps.now() >= deadline || signal.aborted) break;

      let r: { extracted: number; skipped: number };
      try {
        r = await deps.runBatch(signal);
      } catch (err) {
        if (signal.aborted) break;
        throw err;
      }
      extracted += r.extracted;
      skipped += r.skipped;
      batches++;
      deps.onBatch?.({ batch: batches, extracted: r.extracted, remaining: before });

      // A deadline abort inside the batch can surface as zero progress;
      // window exhaustion wins over the generic no_progress label.
      if (deps.now() >= deadline || signal.aborted) break;

      // Stop if a batch made zero forward progress — extraction is failing or
      // everything left is ineligible (e.g. all skipped). Prevents a hot loop
      // that spends budget without draining.
      if (r.extracted === 0 && r.skipped === 0) { stopped = 'no_progress'; break; }
    }

    // After the window elapsed, don't spend more unbounded time on a final
    // count — report remaining as unknown instead of overrunning further.
    const windowElapsed = signal.aborted || deps.now() >= deadline;
    let remaining: number | null = null;
    if (!windowElapsed) {
      try {
        remaining = await deps.countRemaining(signal);
      } catch (err) {
        if (!signal.aborted) throw err;
      }
    }
    if (remaining === 0) stopped = 'drained';
    return { phase: 'extract_atoms', status: 'ok', extracted, skipped, remaining, batches, stopped };
  }, signal);
  // Internal window expiry is a normal partial result. An EXTERNAL abort
  // (worker cancel/timeout/shutdown) must reject so Minion records the abort.
  if (opts.abortSignal?.aborted) throw opts.abortSignal.reason;
  return result;
}

// ─── Shared wiring helper (v0.42.x #1685 DECISION 5A) ──────────────────────
//
// ONE drain path, three callers: `gbrain dream --phase extract_atoms --drain`
// (dream.ts), the `extract-atoms-drain` Minion handler (jobs.ts), and the
// autopilot auto-drain submission (which routes through the handler). Before
// this helper the lock/batch/count wiring lived inline in dream.ts:482; a second
// copy in the handler would let lock id / window default / defer-on-lock-busy
// drift. Keeping the wiring here means those three callers can't diverge.
//
// Imports are dynamic so the pure `runExtractAtomsDrain` above stays cheap to
// import in unit tests (no db-lock / cycle / extract-atoms in the static graph).
//
// `LockUnavailableError` is NOT caught here — the pure loop's `withLock`
// (withRefreshingLock) throws it and it propagates to the caller, because each
// caller reports the busy-lock case differently (dream → exit 3;
// handler → `{ deferred: true }`). That matches the contract documented on
// `ExtractAtomsDrainDeps.withLock`.

export interface DrainForSourceOpts {
  /**
   * The RESOLVED source id, or `undefined` for the legacy unscoped cycle.
   * `undefined` → `cycleLockIdFor(undefined)` = the bare `gbrain-cycle` lock the
   * unscoped routine cycle holds; a real id → `gbrain-cycle:<id>`. Either way the
   * drain and the routine cycle for THIS source genuinely contend (Codex #9).
   * The extraction/backlog source is `sourceId ?? 'default'`.
   */
  sourceId: string | undefined;
  /** Wallclock budget in seconds. */
  windowSeconds: number;
  /** Brain checkout dir, threaded to `runPhaseExtractAtoms` (optional — DB-only ok). */
  brainDir?: string;
  /** Hard batch cap (belt-and-suspenders). */
  maxBatches?: number;
  /** Optional per-batch progress sink (stderr line in dream; job progress in the handler). */
  onBatch?: ExtractAtomsDrainDeps['onBatch'];
  /** Worker cancellation / shutdown signal (Minion `job.signal`). */
  abortSignal?: AbortSignal;
}

export async function runExtractAtomsDrainForSource(
  engine: BrainEngine,
  opts: DrainForSourceOpts,
): Promise<ExtractAtomsDrainResult> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { runPhaseExtractAtoms, countExtractAtomsBacklog } = await import('./extract-atoms.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');

  const extractionSourceId = opts.sourceId ?? 'default';
  const lockId = cycleLockIdFor(opts.sourceId);

  return runExtractAtomsDrain(
    {
      withLock: (work, signal) => withRefreshingLock(engine, lockId, work, {
        ttlMinutes: 5,
        signal,
        releaseTimeoutMs: LOCK_RELEASE_GRACE_MS,
      }),
      runBatch: async (signal) => {
        const r = await runPhaseExtractAtoms(engine, {
          sourceId: extractionSourceId,
          dryRun: false,
          brainDir: opts.brainDir,
          abortSignal: signal,
        });
        const d = (r.details ?? {}) as Record<string, unknown>;
        return {
          extracted: Number(d.atoms_extracted ?? 0),
          skipped: Number(d.duplicates_skipped ?? 0),
        };
      },
      countRemaining: (signal) => countExtractAtomsBacklog(engine, extractionSourceId, signal),
      now: Date.now,
      onBatch: opts.onBatch,
    },
    {
      windowMs: opts.windowSeconds * 1000,
      maxBatches: opts.maxBatches,
      abortSignal: opts.abortSignal,
    },
  );
}
