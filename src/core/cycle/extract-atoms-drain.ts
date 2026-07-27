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

export interface ExtractAtomsDrainDeps {
  /**
   * Run the loop body while holding the cycle lock. Implemented by the caller
   * via `withRefreshingLock`. MUST throw when the lock is held by another
   * process (e.g. `LockUnavailableError`) — the drain lets that propagate so
   * the caller can report `cycle_already_running` and exit, matching the
   * routine cycle's skip contract.
   */
  withLock: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Process one bounded batch (rediscovers eligibility). Returns counts, plus
   * `providerFailure` (issue #3218) when EVERY item the batch attempted threw
   * (zero items succeeded, at least one failure) — i.e. the batch's warning
   * result was actually a total provider outage, not a partial/no-op batch.
   * Omit/false for the ordinary partial-success or nothing-to-do cases.
   */
  runBatch: () => Promise<{ extracted: number; skipped: number; providerFailure?: boolean }>;
  /** Count remaining eligible-but-unextracted pages, or null on query error. */
  countRemaining: () => Promise<number | null>;
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
}

export interface ExtractAtomsDrainResult {
  phase: 'extract_atoms';
  /**
   * issue #3218: 'provider_failure' when any batch reported `providerFailure`
   * (every item it attempted errored). The Minion handler throws on this
   * status so the durable job retries instead of completing over a backlog
   * that made zero forward progress. Partial-success batches (>=1 item
   * succeeded) always report 'ok', unchanged from before.
   */
  status: 'ok' | 'provider_failure';
  extracted: number;
  skipped: number;
  /** Eligible pages still pending after the window. null if the count errored. */
  remaining: number | null;
  /** Batches actually processed. */
  batches: number;
  /** Why the loop stopped: drained | window | no_progress | max_batches | provider_failure. */
  stopped: 'drained' | 'window' | 'no_progress' | 'max_batches' | 'provider_failure';
}

export async function runExtractAtomsDrain(
  deps: ExtractAtomsDrainDeps,
  opts: ExtractAtomsDrainOpts,
): Promise<ExtractAtomsDrainResult> {
  const maxBatches = opts.maxBatches ?? 1000;
  return deps.withLock(async () => {
    const deadline = deps.now() + opts.windowMs;
    let extracted = 0;
    let skipped = 0;
    let batches = 0;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';
    // issue #3218: latched once any batch reports providerFailure — drives
    // the returned `status`, independent of how `stopped` reads after the
    // final (possibly overriding) remaining-count check below.
    let providerFailure = false;

    while (deps.now() < deadline) {
      if (batches >= maxBatches) { stopped = 'max_batches'; break; }

      const before = await deps.countRemaining();
      if (before === 0) { stopped = 'drained'; break; }

      const r = await deps.runBatch();
      extracted += r.extracted;
      skipped += r.skipped;
      batches++;
      deps.onBatch?.({ batch: batches, extracted: r.extracted, remaining: before });

      // issue #3218: every item this batch attempted failed (0 succeeded, >=1
      // error) — a total provider outage, not ordinary no-op/partial progress.
      // Stop immediately (same hot-loop guard as no_progress below) and flag
      // it so the caller can retry via its own policy instead of treating the
      // drain as a clean completion.
      if (r.providerFailure) {
        providerFailure = true;
        stopped = 'provider_failure';
        break;
      }

      // Stop if a batch made zero forward progress — extraction is failing or
      // everything left is ineligible (e.g. all skipped). Prevents a hot loop
      // that spends budget without draining.
      //
      // #2144: a zero-ATOM batch can still be progress — tombstoned
      // zero-yield pages shrink the backlog without producing atoms. Only
      // stop when the backlog count genuinely didn't move.
      if (r.extracted === 0 && r.skipped === 0) {
        const after = await deps.countRemaining();
        if (after === null || before === null || after >= before) { stopped = 'no_progress'; break; }
      }
    }

    const remaining = await deps.countRemaining();
    // issue #3218 (codex P2): don't let a final remaining===0 recount
    // overwrite 'provider_failure' back to 'drained' — that would report the
    // contradictory {status: 'provider_failure', stopped: 'drained'} and
    // mislead the CLI/JSON consumer (dream.ts prints both fields verbatim).
    // status already takes precedence for the Minion handler's retry
    // decision; keep `stopped` consistent with it once a failure latched.
    if (!providerFailure && remaining === 0) stopped = 'drained';
    return {
      phase: 'extract_atoms',
      status: providerFailure ? 'provider_failure' : 'ok',
      extracted,
      skipped,
      remaining,
      batches,
      stopped,
    };
  });
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
      withLock: (work) => withRefreshingLock(engine, lockId, work, { ttlMinutes: 5 }),
      runBatch: async () => {
        const r = await runPhaseExtractAtoms(engine, {
          sourceId: extractionSourceId,
          dryRun: false,
          brainDir: opts.brainDir,
        });
        const d = (r.details ?? {}) as Record<string, unknown>;
        // issue #3218: `r.status` collapses to 'warn' whether ONE item failed
        // (partial success — leave the drain's existing ok/no_progress path
        // alone) or EVERY item failed (a total provider outage the drain
        // adapter was silently swallowing). Re-derive the total-failure case
        // from the per-item counts `runPhaseExtractAtoms` already returns:
        // >=1 failure AND zero items successfully processed (transcripts_processed
        // + pages_processed both 0 means every attempted `chat()` call threw —
        // items that succeed with 0 atoms still count as processed, so this
        // does not fire on "provider fine, nothing extractable").
        const failures = Array.isArray(d.failures) ? d.failures : [];
        const itemsSucceeded =
          Number(d.transcripts_processed ?? 0) + Number(d.pages_processed ?? 0);
        return {
          extracted: Number(d.atoms_extracted ?? 0),
          skipped: Number(d.duplicates_skipped ?? 0),
          providerFailure: failures.length > 0 && itemsSucceeded === 0,
        };
      },
      countRemaining: () => countExtractAtomsBacklog(engine, extractionSourceId),
      now: Date.now,
      onBatch: opts.onBatch,
    },
    { windowMs: opts.windowSeconds * 1000, maxBatches: opts.maxBatches },
  );
}
