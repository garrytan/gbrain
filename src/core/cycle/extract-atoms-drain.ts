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
 * the loop logic is unit-testable. Its only static imports are pure text
 * sanitizers (#4730). The wiring helper `runExtractAtomsDrainForSource`
 * (below) builds the real deps; it uses DYNAMIC imports so the pure-loop unit
 * tests don't drag in db-lock / cycle.
 */

import type { BrainEngine } from '../engine.ts';
import type { ExtractAtomsOpts } from './extract-atoms.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import { redactFindings } from '../secret-scan.ts';
import { ensureWellFormed, truncateUtf8 } from '../text-safe.ts';

/** #4730: bounded operator-facing failure detail; totals stay exact above the cap. */
export const MAX_DRAIN_FAILURE_RECORDS = 25;
/** Matches the repo's audit/error-summary privacy cap. */
export const MAX_DRAIN_FAILURE_SOURCE_CHARS = 256;
export const MAX_DRAIN_FAILURE_REASON_CHARS = 200;

/**
 * #4730: one preserved per-item failure. `failure_count` remains the exact
 * total; `failures` holds up to MAX_DRAIN_FAILURE_RECORDS of these in batch
 * order, and `omitted_failure_count` reconciles the difference — the cap is
 * reported, never silently applied.
 */
export interface ExtractAtomsDrainFailure {
  /** One-based batch number within this bounded drain window. */
  batch: number;
  /** Stable page slug / transcript locator emitted by runPhaseExtractAtoms (sanitized). */
  source: string;
  /** Bounded, sanitized failure reason (secrets/connection info redacted). */
  reason: string;
}

/**
 * Sanitize operator-facing failure text: secret + connection-string redaction,
 * well-formed UTF-8, collapsed whitespace, bounded length. Locators and
 * reasons both route through here so neither can carry an unbounded provider
 * payload or credentials into `--json` output / job results.
 */
function sanitizeFailureText(raw: string, maxChars: number): string {
  const secretRedacted = redactFindings(raw, { highEntropy: true }).text;
  const connectionRedacted = redactConnectionInfo(secretRedacted);
  return truncateUtf8(
    ensureWellFormed(connectionRedacted).replace(/\s+/g, ' ').trim(),
    maxChars,
  );
}

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
   *
   * #4539: `failureCount` (per-item failures in this batch) and `firstError`
   * (a representative failure message) let the drain surface WHY a run
   * stopped/underperformed. #4730: `failures` preserves the phase's per-item
   * `{source, reason}` records so a mixed-failure batch is fully
   * reconcilable from `--json` — pre-#4730 everything but ONE representative
   * error was dropped and the operator had to re-run the work to see the
   * other reasons.
   *
   * `ctx.shouldStop` is the window checkpoint: the batch consults it before
   * starting each item and defers the rest once it returns true, reporting
   * them as `deferred` (still due — nothing is stamped). `completed` is the
   * number of items the batch finished (atoms persisted or zero-yield
   * settled). Both are optional for adapters that predate the checkpoint.
   */
  runBatch: (ctx: { shouldStop: () => boolean }) => Promise<{
    extracted: number;
    skipped: number;
    completed?: number;
    deferred?: number;
    providerFailure?: boolean;
    failureCount?: number;
    firstError?: string;
    failures?: Array<{ source: string; reason: string }>;
  }>;
  /** Count remaining eligible-but-unextracted pages, or null on query error. */
  countRemaining: () => Promise<number | null>;
  /**
   * Count live transcript work still due (not in the page backlog), or null on
   * error. Optional for adapters without transcripts; absent counts as 0. The
   * drain's continue/stop and `drained` decisions use pages + transcripts, so a
   * run never reports `drained` while deferred transcripts are still due.
   */
  countPendingTranscripts?: () => Promise<number | null>;
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
  /** Live transcripts still pending after the window (not in `remaining`). null if the count errored. */
  transcripts_remaining: number | null;
  /** Batches actually processed. */
  batches: number;
  /** Work items finished across every batch (atoms persisted or zero-yield settled). */
  items_completed: number;
  /**
   * Work items a batch left unstarted because the window elapsed mid-batch.
   * They were not touched, so they stay eligible (pages count toward
   * `remaining`) for the next run.
   */
  items_deferred: number;
  /** Why the loop stopped: drained | window | no_progress | max_batches | provider_failure. */
  stopped: 'drained' | 'window' | 'no_progress' | 'max_batches' | 'provider_failure';
  /**
   * #4539: total per-item failures across every batch in this run. 0 for a
   * clean run. Included in `--json` verbatim; dream.ts prints a stderr line
   * when non-zero so the operator sees WHY the drain underperformed.
   */
  failure_count: number;
  /**
   * #4730: bounded per-item failure details, in batch order, capped at
   * MAX_DRAIN_FAILURE_RECORDS. Locators and reasons are sanitized (secret +
   * connection-info redaction, bounded length). Rides `--json` verbatim.
   */
  failures: ExtractAtomsDrainFailure[];
  /**
   * #4730: failures beyond the record cap (or reported by count only, with
   * no per-item detail). `failure_count === failures.length +
   * omitted_failure_count` always holds, so the cap is visible, never silent.
   */
  omitted_failure_count: number;
  /**
   * #4539: representative failure message from the most recent batch that
   * reported one (`source: reason`), or null for a clean run.
   */
  last_error: string | null;
}

/**
 * #3813: the Minion handler's provider_failure throw IS the job's error_text
 * once it dead-letters, so it carries the representative `last_error` (already
 * secret-redacted + bounded above) — a missing provider key is a one-line
 * diagnosis instead of an opaque batches/remaining.
 */
/**
 * True when a drain left work undone and the caller should run again: any
 * non-ok status (provider failure), a page or transcript count that failed
 * (null) or is non-zero, or items deferred by the window. The CLI exit code
 * and the Minion continuation both read this, so they cannot disagree.
 */
export function drainLeftWorkDue(
  result: Pick<ExtractAtomsDrainResult, 'status' | 'remaining' | 'transcripts_remaining' | 'items_deferred'>,
): boolean {
  return result.status !== 'ok'
    || result.remaining === null || result.remaining > 0
    || result.transcripts_remaining === null || result.transcripts_remaining > 0
    || result.items_deferred > 0;
}

export function formatDrainProviderFailure(
  result: Pick<ExtractAtomsDrainResult, 'batches' | 'remaining' | 'last_error'>,
): string {
  return (
    `extract-atoms-drain: all provider calls failed this batch ` +
    `(batches=${result.batches}, remaining=${result.remaining ?? '?'})` +
    `${result.last_error ? `; last error: ${result.last_error}` : ''} — retrying`
  );
}

/** Pages + live transcripts still due; null when either count failed. */
async function pendingWork(deps: ExtractAtomsDrainDeps): Promise<number | null> {
  const pages = await deps.countRemaining();
  const transcripts = deps.countPendingTranscripts ? await deps.countPendingTranscripts() : 0;
  return pages === null || transcripts === null ? null : pages + transcripts;
}

function countOrZero(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
    let itemsCompleted = 0;
    let itemsDeferred = 0;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';
    // issue #3218: latched once any batch reports providerFailure — drives
    // the returned `status`, independent of how `stopped` reads after the
    // final (possibly overriding) remaining-count check below.
    let providerFailure = false;
    // #4539: accumulate per-item failure visibility across batches.
    let failureCount = 0;
    // #4730: bounded typed per-item records (batch order, sanitized).
    const failures: ExtractAtomsDrainFailure[] = [];
    let lastError: string | null = null;

    while (deps.now() < deadline) {
      if (batches >= maxBatches) { stopped = 'max_batches'; break; }

      const before = await pendingWork(deps);
      if (before === 0) { stopped = 'drained'; break; }

      // The window is enforced INSIDE the batch too: one batch is up to the
      // page-discovery budget plus every live transcript, each an LLM call,
      // so checking only between batches let a single batch run far past the
      // window (and past a Minion job timeout, losing the final result).
      const r = await deps.runBatch({ shouldStop: () => deps.now() >= deadline });
      extracted += r.extracted;
      skipped += r.skipped;
      batches++;
      const batchDeferred = countOrZero(r.deferred);
      itemsCompleted += countOrZero(r.completed);
      itemsDeferred += batchDeferred;
      // #4730: preserve typed per-item records (bounded, sanitized) while
      // keeping failure_count exact and reconcilable — count-only adapters
      // (the #4539 shape) still contribute to the total via failureCount.
      const batchFailures = Array.isArray(r.failures)
        ? r.failures.filter(
            (f): f is { source: string; reason: string } =>
              f != null &&
              typeof f === 'object' &&
              typeof f.source === 'string' &&
              typeof f.reason === 'string',
          )
        : [];
      const reportedFailureCount =
        typeof r.failureCount === 'number' && Number.isFinite(r.failureCount) && r.failureCount > 0
          ? Math.floor(r.failureCount)
          : 0;
      failureCount += Math.max(reportedFailureCount, batchFailures.length);
      for (const f of batchFailures) {
        if (failures.length >= MAX_DRAIN_FAILURE_RECORDS) break;
        failures.push({
          batch: batches,
          source: sanitizeFailureText(f.source, MAX_DRAIN_FAILURE_SOURCE_CHARS),
          reason: sanitizeFailureText(f.reason, MAX_DRAIN_FAILURE_REASON_CHARS),
        });
      }
      const representative = batchFailures[0];
      if (representative) {
        lastError =
          `${sanitizeFailureText(representative.source, MAX_DRAIN_FAILURE_SOURCE_CHARS)}: ` +
          `${sanitizeFailureText(representative.reason, MAX_DRAIN_FAILURE_REASON_CHARS)}`;
      } else if (typeof r.firstError === 'string' && r.firstError.trim()) {
        // #4539 compatibility: count-only adapters still surface their
        // representative error — through the SAME sanitizer as the typed
        // records (secret/DSN redaction, whitespace collapse, bounded), so a
        // provider payload cannot ride the fallback path into --json output.
        lastError = sanitizeFailureText(
          r.firstError,
          MAX_DRAIN_FAILURE_SOURCE_CHARS + 2 + MAX_DRAIN_FAILURE_REASON_CHARS,
        );
      }
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

      // The batch hit the window checkpoint and left items unstarted. Stop
      // here so the zero-progress check below can't misread a cut batch as
      // no_progress.
      if (batchDeferred > 0) { stopped = 'window'; break; }

      // Stop if a batch made zero forward progress — extraction is failing or
      // everything left is ineligible (e.g. all skipped). Prevents a hot loop
      // that spends budget without draining.
      //
      // #2144: a zero-ATOM batch can still be progress — tombstoned
      // zero-yield pages shrink the backlog without producing atoms. Only
      // stop when the backlog count genuinely didn't move.
      if (r.extracted === 0 && r.skipped === 0) {
        const after = await pendingWork(deps);
        if (after === null || before === null || after >= before) { stopped = 'no_progress'; break; }
      }
    }

    const remaining = await deps.countRemaining();
    const transcriptsRemaining = deps.countPendingTranscripts ? await deps.countPendingTranscripts() : 0;
    // issue #3218 (codex P2): don't let a final remaining===0 recount
    // overwrite 'provider_failure' back to 'drained' — that would report the
    // contradictory {status: 'provider_failure', stopped: 'drained'} and
    // mislead the CLI/JSON consumer (dream.ts prints both fields verbatim).
    // status already takes precedence for the Minion handler's retry
    // decision; keep `stopped` consistent with it once a failure latched.
    // Drained only when neither pool has work due and nothing was deferred:
    // `remaining` counts pages, so it alone cannot see deferred transcripts.
    if (!providerFailure && remaining === 0 && transcriptsRemaining === 0 && itemsDeferred === 0) stopped = 'drained';
    return {
      phase: 'extract_atoms',
      status: providerFailure ? 'provider_failure' : 'ok',
      extracted,
      skipped,
      remaining,
      transcripts_remaining: transcriptsRemaining,
      batches,
      items_completed: itemsCompleted,
      items_deferred: itemsDeferred,
      stopped,
      failure_count: failureCount,
      failures,
      omitted_failure_count: failureCount - failures.length,
      last_error: lastError,
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
  /** Test seam: clock for the window deadline. Production: Date.now. */
  _now?: () => number;
  /** Test seam: extra phase options (e.g. `_chat`, `_transcripts`) merged into each batch. */
  _phase?: Pick<ExtractAtomsOpts, '_chat' | '_transcripts'>;
}

export async function runExtractAtomsDrainForSource(
  engine: BrainEngine,
  opts: DrainForSourceOpts,
): Promise<ExtractAtomsDrainResult> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { runPhaseExtractAtoms, countExtractAtomsBacklog, countPendingTranscripts, discoverTranscriptCorpus } =
    await import('./extract-atoms.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');

  const extractionSourceId = opts.sourceId ?? 'default';
  const lockId = cycleLockIdFor(opts.sourceId);
  // Read the transcript corpus from disk ONCE per drain. File contents are
  // hash-keyed, so the cached list stays valid; what changes between batches
  // is DB liveness (atom rows, tombstones), which every batch and every
  // pending count still re-checks. A file added mid-drain waits for the next
  // drain, which is fine under the single-hold lock.
  let corpus: Promise<Array<{ filePath: string; content: string; contentHash: string }>> | undefined =
    opts._phase?._transcripts ? Promise.resolve(opts._phase._transcripts) : undefined;
  const transcriptCorpus = () =>
    (corpus ??= discoverTranscriptCorpus(engine, extractionSourceId, { brainDir: opts.brainDir }));

  return runExtractAtomsDrain(
    {
      withLock: (work) => withRefreshingLock(engine, lockId, work, { ttlMinutes: 5 }),
      runBatch: async ({ shouldStop }) => {
        const r = await runPhaseExtractAtoms(engine, {
          ...opts._phase,
          _transcripts: await transcriptCorpus(),
          sourceId: extractionSourceId,
          dryRun: false,
          brainDir: opts.brainDir,
          shouldStop,
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
        // #4730: carry EVERY per-item failure up as a typed {source, reason}
        // record (the pure loop bounds + sanitizes them) instead of the
        // #4539 collapse to count + one representative error — a mixed
        // three-failure batch used to be unrecoverable from `--json`.
        const typedFailures = failures
          .filter(
            (f): f is { source: string; error: string } =>
              f != null &&
              typeof f === 'object' &&
              typeof (f as { source?: unknown }).source === 'string' &&
              typeof (f as { error?: unknown }).error === 'string',
          )
          .map(({ source, error }) => ({ source, reason: error }));
        const deferred = Number(d.pages_deferred ?? 0) + Number(d.transcripts_deferred ?? 0);
        return {
          extracted: Number(d.atoms_extracted ?? 0),
          skipped: Number(d.duplicates_skipped ?? 0),
          completed: itemsSucceeded,
          deferred,
          // Every attempted item failed AND the batch was not cut by the window.
          // A cut after one (often transient) failure is ordinary deferral —
          // the rest never ran, so there is no outage-level evidence. A real
          // auth/billing halt breaks the phase loop without deferring, so it
          // still lands here.
          providerFailure: failures.length > 0 && itemsSucceeded === 0 && deferred === 0,
          failureCount: failures.length,
          failures: typedFailures,
        };
      },
      countRemaining: () => countExtractAtomsBacklog(engine, extractionSourceId),
      countPendingTranscripts: async () => countPendingTranscripts(engine, extractionSourceId, {
        brainDir: opts.brainDir, _transcripts: await transcriptCorpus(),
      }),
      now: opts._now ?? Date.now,
      onBatch: opts.onBatch,
    },
    { windowMs: opts.windowSeconds * 1000, maxBatches: opts.maxBatches },
  );
}

// ─── Background continuation (Minion lane) ──────────────────────────────────
//
// A window-cut drain job used to complete like a finished one, so deferred
// work waited for autopilot's next daily slot. The handler now chains ONE
// continuation job when the run made forward progress and left work due,
// bounded by MAX_DRAIN_CONTINUATIONS per chain AND by the same daily spend
// cap + fairness autopilot's dispatch obeys (extract-atoms-auto-drain.ts).
// Every other case reports why no continuation was queued, so the job result
// never implies more than it did.

/** Longest continuation chain one submitted drain may start. */
export const MAX_DRAIN_CONTINUATIONS = 8;

/** Why a continuation was blocked by spend policy, with the numbers that decided it. */
export interface DrainBudgetBlock {
  queued: false;
  reason: 'auto_drain_disabled' | 'daily_cap' | 'reserved_for_other_sources' | 'budget_unknown' | 'cap_lock_busy';
  max_usd_per_day?: number;
  max_jobs_today?: number;
  jobs_today?: number | null;
  reserved_for_other_sources?: string[];
}

export type DrainContinuation =
  | { queued: true; job_id: number; depth: number }
  | { queued: false; reason: 'drained' | 'no_forward_progress' | 'continuation_limit' | 'not_window_cut' | 'submit_failed'; error?: string }
  | DrainBudgetBlock;

export async function queueDrainContinuation(
  engine: BrainEngine,
  job: { id: number; data: Record<string, unknown> },
  result: ExtractAtomsDrainResult,
): Promise<DrainContinuation> {
  if (!drainLeftWorkDue(result)) return { queued: false, reason: 'drained' };
  // no_progress / provider_failure stops must not self-chain: they would spin.
  if (result.status !== 'ok' || (result.stopped !== 'window' && result.stopped !== 'max_batches')) {
    return { queued: false, reason: 'not_window_cut' };
  }
  if (result.items_completed === 0) return { queued: false, reason: 'no_forward_progress' };
  const depth = typeof job.data.continuation_depth === 'number' ? job.data.continuation_depth : 0;
  if (depth >= MAX_DRAIN_CONTINUATIONS) return { queued: false, reason: 'continuation_limit' };
  const idempotencyKey = `extract-atoms-drain:continuation:${job.id}`;
  try {
    // A retried parent reports the continuation it already created; the
    // budget check below would otherwise count that very job against itself.
    const [existing] = await engine.executeRaw<{ id: number }>(
      'SELECT id FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1', [idempotencyKey]);
    if (existing) return { queued: true, job_id: Number(existing.id), depth: depth + 1 };
    const policyMod = await import('./extract-atoms-auto-drain.ts');
    const { MinionQueue } = await import('../minions/queue.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : 'default';
    // Spend + fairness gate, under the same lock autopilot's dispatch holds.
    const gated = await policyMod.withDrainCapLock(engine, async (): Promise<DrainContinuation> => {
      const policy = await policyMod.readAutoDrainPolicy(engine);
      const budget = { max_usd_per_day: policy.maxUsdPerDay, max_jobs_today: policy.maxJobsToday };
      if (!policy.enabled) return { queued: false, reason: 'auto_drain_disabled', ...budget };
      const today = await policyMod.countDrainJobsToday(engine, policy.utcDay);
      if (today === null) return { queued: false, reason: 'budget_unknown', ...budget, jobs_today: null };
      if (today >= policy.maxJobsToday) return { queued: false, reason: 'daily_cap', ...budget, jobs_today: today };
      // Fairness: never take a slot another due source needs for its first drain today.
      const others = await policyMod.sourcesAwaitingDrain(engine, policy,
        { excludeSourceId: sourceId, limit: policy.maxJobsToday - today });
      if (today + others.length >= policy.maxJobsToday) {
        return { queued: false, reason: 'reserved_for_other_sources', ...budget, jobs_today: today,
          reserved_for_other_sources: others.map(o => o.id) };
      }
      const [parent] = await engine.executeRaw<{ max_attempts: number | null; timeout_ms: number | null; queue: string | null }>(
        'SELECT max_attempts, timeout_ms, queue FROM minion_jobs WHERE id = $1', [job.id]);
      const next = await new MinionQueue(engine).add(
        'extract-atoms-drain',
        { ...job.data, continuation_of: job.id, continuation_depth: depth + 1 },
        {
          // One continuation per parent even if the parent's handler is retried.
          idempotency_key: idempotencyKey,
          ...(parent?.queue ? { queue: parent.queue } : {}),
          ...(parent?.max_attempts ? { max_attempts: parent.max_attempts } : {}),
          ...(parent?.timeout_ms ? { timeout_ms: parent.timeout_ms } : {}),
        },
        { allowProtectedSubmit: true },
      );
      return { queued: true, job_id: next.id, depth: depth + 1 };
    });
    return gated?.value ?? { queued: false, reason: 'cap_lock_busy' };
  } catch (e) {
    return { queued: false, reason: 'submit_failed', error: sanitizeFailureText(e instanceof Error ? e.message : String(e), MAX_DRAIN_FAILURE_REASON_CHARS) };
  }
}
