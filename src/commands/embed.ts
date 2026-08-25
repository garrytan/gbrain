import type { BrainEngine } from '../core/engine.ts';
import { currentEmbeddingSignature } from '../core/embedding.ts';
import type { ChunkInput } from '../core/types.ts';
import { carryChunkMetadata, probeEmbedder } from '../core/embed-stale.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../core/embedding-input-limit.ts';
import { createProgress, type ProgressReporter } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { assertEmbeddingEnabled } from '../core/embedding-dim-check.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../core/embedding-invalidation.ts';
import { loadConfig } from '../core/config.ts';
import { slog, serr } from '../core/console-prefix.ts';
import { filterOutEmbedSkipped } from '../core/embed-skip.ts';
import { runSlidingPool } from '../core/worker-pool.ts';
import { isAborted, anySignal, AbortError } from '../core/abort-check.ts';
import { type DbPacer, createDbPacer, createNoopPacer, observed } from '../core/db-pacer.ts';
import {
  resolvePaceMode,
  loadPaceModeConfig,
  readPaceEnv,
  type PaceKeyOverrides,
} from '../core/pace-mode.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../core/db-lock.ts';
import { embedBackfillLockId } from '../core/embed-backfill-lock.ts';
import { AITransientError } from '../core/ai/errors.ts';
import { wrapChunkTextsForStoredMode } from '../core/embedding-context.ts';
import {
  restampIfDemotedToTitleTier,
  embedBatchWithBackoff,
  isEmbedRetriableError,
  isTransientNetworkEmbedError,
  type EmbedBatchWithBackoffOpts,
} from '../core/embed-retry.ts';

// Peeled to src/core/embed-retry.ts (core→commands layering fix: core modules
// import-file.ts / embed-stale.ts consume these, and a commands module in
// their value closure risks a real ESM cycle). Façade rule: embed.ts keeps
// re-exporting its historical surface so import sites and tests never chase
// the peel.
export {
  restampIfDemotedToTitleTier,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_FALLBACK_MS,
  RATE_LIMIT_PAD_MS,
  RATE_LIMIT_JITTER,
  detect429FromCause,
  detectGatewayErrorFromCause,
  parseRetryDelayMs,
  RATE_LIMIT_ATTEMPT_FLOOR_MS,
  _setRateLimitFloorsForTests,
  rateLimitDelayMs,
  abortableSleep,
  embedBatchWithBackoff,
  TRANSIENT_NET_BASE_MS,
  TRANSIENT_NET_MAX_MS,
  transientBackoffMs,
  isTransientNetworkEmbedError,
} from '../core/embed-retry.ts';
export type { EmbedBatchWithBackoffOpts } from '../core/embed-retry.ts';

/** #3037: cap failure samples so a corpus-wide outage doesn't bloat --json. */
const FAILURE_SAMPLE_CAP = 10;

/**
 * #3037: record embed failures on the run result. `chunkCount` is the number
 * of chunks left un-embedded by this failure (1 for page-level errors where
 * the chunk count isn't known at the catch site).
 */
function recordFailure(result: EmbedResult, chunkCount: number, slug: string, e: unknown): void {
  result.failures += chunkCount;
  if (result.failure_samples.length < FAILURE_SAMPLE_CAP) {
    result.failure_samples.push(`${slug}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface EmbedOpts {
  /** Embed ALL pages (every chunk). */
  all?: boolean;
  /** Embed only stale chunks (missing embedding). */
  stale?: boolean;
  /** Embed specific pages by slug. */
  slugs?: string[];
  /** Embed a single page. */
  slug?: string;
  /**
   * v0.31.12: scope to a specific source. When set, only pages from this
   * source are embedded. When omitted, all sources are processed (but
   * source_id is still threaded correctly per-page via Page.source_id).
   */
  sourceId?: string;
  /**
   * Dry run: enumerate what WOULD be embedded (stale chunk counts)
   * without calling the embedding model or writing to the engine.
   * Safe to call with no API key. Used by runCycle's dryRun propagation.
   */
  dryRun?: boolean;
  /**
   * Optional progress callback. Called after each page. CLI wrappers
   * supply a reporter.tick()-backed implementation; Minion handlers
   * supply a job.updateProgress()-backed one so per-job progress lives
   * in the DB where `gbrain jobs get` can read it.
   */
  onProgress?: (done: number, total: number, embedded: number) => void;
  /**
   * v0.41.18.0 (A13): override the hardcoded PAGE_SIZE=2000 page-batch.
   * Smaller batches give finer progress granularity; larger batches
   * reduce per-batch coordination cost. Caps internally to 10K to
   * keep memory bounded.
   */
  batchSize?: number;
  /**
   * v0.41.18.0 (A13): when 'recent', walks the stale-chunk pool in
   * page.updated_at DESC order (recent-modified pages first) instead
   * of the legacy stable (page_id, chunk_index) order. Threads through
   * to listStaleChunks orderBy='updated_desc'. Backed by the
   * content_chunks_stale_idx partial + idx_pages_updated_at_desc indexes
   * (v100).
   */
  priority?: 'recent';
  /**
   * v0.41.18.0 (A13): catch-up mode removes the wall-clock cap and loops
   * until countStaleChunks() returns 0. Used by `gbrain embed --stale
   * --catch-up` and by the embed-catch-up Minion handler that the onboard
   * remediation submits on big stale backlogs.
   */
  catchUp?: boolean;
  /**
   * #1737: cooperative-abort signal from the Minions worker (wall-clock
   * timeout, lock loss, SIGTERM). When it fires, the embed loops break
   * cleanly with partial progress preserved so the autopilot cycle's
   * finally can release `gbrain_cycle_locks` instead of running for the
   * full 10-15 min embed phase after the job was already killed. Composed
   * with the internal wall-clock budget timer via `anySignal`.
   */
  signal?: AbortSignal;
  /**
   * DB-contention pacing (paced-backfill). Raw inputs resolved in
   * runEmbedCore via env > config > bundle (env beats config = incident
   * escape hatch). `perCallMode` is from `--pace[=mode]`; `perCall` from
   * `--pace-max-concurrency` etc. Absent ⇒ resolves from env/config (so a
   * queued job paced by config alone still throttles). Mode `off` ⇒ no-op.
   */
  pace?: {
    perCallMode?: string;
    perCall?: PaceKeyOverrides;
  };
  /**
   * When the pace overrides were SERIALIZED from a background-job payload (not
   * typed at an interactive CLI), resolve them at the config tier so
   * `GBRAIN_PACE_*` on the worker still overrides at execution (Codex P2). Set
   * by the `embed` job handler; unset for interactive CLI runs.
   */
  paceFromBackground?: boolean;
  /**
   * E-2 (paced-backfill): single-flight the stale run by taking the SAME
   * per-source lock the `embed-backfill` minion handler uses, so a hand-run CLI
   * backfill and a queued job can't grind the same source at once (closing the
   * NULL→non-NULL upsert race window that paced — longer — runs widen). Set
   * ONLY by the CLI (`runEmbed`); the minion path already locks. All-source
   * runs lock every source in sorted order. dryRun skips it.
   */
  singleFlight?: boolean;
  /**
   * #394: suppress human stdout summaries (the `[dry-run] Would embed ...` /
   * `Embedded N chunks ...` slog lines). Set by structured-output callers —
   * the cycle's embed phase (dream --json must keep stdout JSON-clean per
   * docs/progress-events.md) reports counts via its own PhaseResult instead.
   * Errors/warnings still go to stderr regardless.
   */
  quiet?: boolean;
  /**
   * #3391: widen signature-drift invalidation to pages with NO recorded
   * embedding_signature (pre-v108). By default those are grandfathered
   * (never invalidated) so a routine upgrade doesn't surprise-re-embed a
   * whole corpus — but after a provider/model swap the grandfather clause
   * silently leaves them in the OLD embedding space, mixing two vector
   * spaces in one index. `gbrain migrate embeddings` and
   * `gbrain embed --stale --include-null-signature` set this.
   */
  includeNullSignature?: boolean;
  /**
   * Migration-hardening: locks the CALLER already holds (the migration
   * orchestrator acquires the per-source embed-backfill locks up front, before
   * the schema transition, and holds them through the drain). When set with
   * `singleFlight`, the drain does NOT re-acquire the same keys — re-acquiring
   * would always fail against our own holder and misreport `lock_skipped`
   * ("Migration paused") on every run. Ownership stays with the caller: this
   * function refreshes them (heartbeat) but never releases them.
   */
  heldLocks?: DbLockHandle[];
}

/**
 * Structured result from a library-level embed run.
 *
 * In dryRun mode, `embedded = 0` and `would_embed` holds the count of
 * stale chunks that WOULD have been sent to the embedding model. In
 * non-dryRun mode, `embedded` holds the real count and `would_embed = 0`.
 * `skipped` counts chunks that already had embeddings (nothing to do).
 */
export interface EmbedResult {
  /** Chunks newly embedded in this run (0 in dryRun). */
  embedded: number;
  /** Chunks with pre-existing embeddings, skipped. */
  skipped: number;
  /** Chunks that would be embedded if not for dryRun (0 in non-dryRun). */
  would_embed: number;
  /** Total chunks considered across all processed pages. */
  total_chunks: number;
  /** Number of pages processed (whether or not they had stale chunks). */
  pages_processed: number;
  /**
   * #3037: chunks that FAILED to embed this run (batch failures + per-chunk
   * isolation failures). Callers must not read total silence as success:
   * `src/cli.ts` turns `failures > 0` into a non-zero exit verdict (mirrors
   * the `import` errors>0 guard), and structured consumers (--json, minion
   * handlers) can surface it. 0 on a clean run. Additive field.
   */
  failures: number;
  /**
   * #3037: up to 10 `slug: error-message` samples of what failed, so the
   * operator gets a diagnosis without scrolling stderr. Capped so a
   * corpus-wide outage doesn't bloat structured output. Additive field.
   */
  failure_samples: string[];
  /** True if this run was a dry-run. */
  dryRun: boolean;
  /**
   * Chunkless-page safety net (`--stale` only): pages with non-empty
   * content but zero `content_chunks` rows that this run chunked (or, in
   * dryRun, would chunk) so their new NULL-embedding chunks fold into the
   * SAME pass. 0 on a healthy brain. Additive field — see
   * `ChunklessPageRow` for the detection rationale.
   */
  chunkless_pages_healed: number;
  /**
   * Set when a single-flight run did NO work because another backfill holds
   * the per-source embed lock. A hard-killed (SIGKILL/crash) run leaves its
   * lock behind for up to EMBED_BACKFILL_LOCK_TTL_MIN — callers that promise
   * "re-run to resume" (migrate embeddings) use this to say so instead of
   * misreporting embed failures.
   */
  lock_skipped?: boolean;
  /**
   * Set when the single-flight lock heartbeat discovered the lock was stolen
   * (refresh matched 0 rows) or kept erroring: mutual exclusion is gone, so
   * the drain ABORTED with partial progress banked rather than racing the
   * new holder. Resumable — re-run the same command once the other holder
   * finishes (the fenced refresh means we can never steal it back silently).
   */
  lock_lost?: boolean;
  /**
   * E1 (paced-backfill): end-of-run pacing telemetry. Present ONLY when pacing
   * was active (enabled bundle). The number the operator could not get from an
   * external wrapper ("zero pauses" ≠ "queue safe").
   */
  pacing?: {
    maxConcurrency: number;
    /** In-band latency samples folded into the EWMA. */
    samples: number;
    /** Final EWMA of observed DB-op latency (ms), or null if no samples. */
    ewmaMs: number | null;
    /** Cumulative cooperative-sleep time (ms). */
    totalSleptMs: number;
    /** Number of cooperative sleeps. */
    sleeps: number;
    /** High-water mark of acquirers blocked on the permit (sync path). */
    maxWaiters: number;
  };
}

/**
 * Library-level embed. Throws on validation errors; per-page embed failures
 * are logged to stderr but do not throw (matches the existing CLI semantics
 * for batch runs). Safe to call from Minions handlers — no process.exit.
 *
 * Returns EmbedResult with accurate counts so callers (runCycle, sync
 * auto-embed step) can report embeddings in their own structured output.
 */
/**
 * Tagged error class thrown when the schema column dim disagrees with
 * the gateway's resolved dim. Caught by `runEmbed` (the CLI wrapper) to
 * emit a paste-ready recipe instead of raw Postgres errors page by page.
 *
 * v0.37 fix wave (Lane D.2 + CDX2-9). Pre-fix the worker pool ran the
 * whole queue past the first dim mismatch because per-page errors were
 * silently logged + skipped. Now `runEmbedCore` pre-flights at entry +
 * the worker pool catches per-page mismatches and surfaces them.
 */
export class EmbeddingDimMismatchError extends Error {
  readonly kind = 'embedding_dim_mismatch' as const;
  constructor(public readonly recipeMessage: string) {
    super(recipeMessage);
    this.name = 'EmbeddingDimMismatchError';
  }
}

/**
 * Pre-flight check: read the actual schema column dim and compare to the
 * gateway's resolved dim. Throws `EmbeddingDimMismatchError` on mismatch
 * so the entry-point catch surfaces the recipe. Catches the headline
 * fresh-install bug class at the very first invocation instead of letting
 * the worker pool hammer N pages with raw 22000 errors.
 */
async function preflightDimMismatch(engine: BrainEngine, dryRun: boolean): Promise<void> {
  if (dryRun) return; // dry-run never embeds, no risk
  const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
  const { getEmbeddingDimensions, getEmbeddingModel } = await import('../core/ai/gateway.ts');
  let existing;
  try {
    existing = await readContentChunksEmbeddingDim(engine);
  } catch {
    return; // probe failure shouldn't block embed; the worker pool will surface real errors
  }
  if (!existing.exists || existing.dims === null) return;
  let resolvedDims: number;
  let resolvedModel: string;
  try {
    resolvedDims = getEmbeddingDimensions();
    resolvedModel = getEmbeddingModel();
  } catch {
    return; // gateway unconfigured — worker pool will error informatively
  }
  if (existing.dims === resolvedDims) return;
  const databasePath = (engine as { _savedConfig?: { database_path?: string } })._savedConfig?.database_path;
  const recipe = embeddingMismatchMessage({
    currentDims: existing.dims,
    requestedDims: resolvedDims,
    requestedModel: resolvedModel,
    source: 'embed',
    engineKind: engine.kind,
    databasePath,
  });
  throw new EmbeddingDimMismatchError(recipe);
}

export async function runEmbedCore(engine: BrainEngine, opts: EmbedOpts): Promise<EmbedResult> {
  // v0.37.10.0 T7 (D9): refuse cleanly when init persisted the deferred-setup
  // sentinel. Skipped in dryRun mode so plan-mode introspection still works.
  if (!opts.dryRun) {
    assertEmbeddingEnabled(loadConfig());
  }

  // v0.41.6.0 D1: preflight embedding credentials. Skipped in dryRun mode
  // so plan-mode introspection still works (no provider calls needed).
  //
  // runEmbedCore is a LIBRARY function called from both the CLI (runEmbed)
  // and the cycle (runCycle's embed phase + autopilot-cycle handler). THROW
  // EmbeddingCredentialError so the cycle's per-phase try/catch can
  // gracefully fail-the-phase without killing the worker process. The CLI
  // wrapper at src/commands/embed.ts:runEmbed catches and exits.
  if (!opts.dryRun) {
    const { validateEmbeddingCreds } = await import('../core/embed-preflight.ts');
    validateEmbeddingCreds();
  }

  // v0.37.11.0 (Lane D.2): pre-flight dim-mismatch check. Catches the headline
  // fresh-install bug class before the worker pool spends 20 parallel calls
  // hitting raw Postgres dimension errors.
  await preflightDimMismatch(engine, !!opts.dryRun);

  const result: EmbedResult = {
    embedded: 0,
    skipped: 0,
    would_embed: 0,
    total_chunks: 0,
    pages_processed: 0,
    failures: 0,
    failure_samples: [],
    dryRun: !!opts.dryRun,
    chunkless_pages_healed: 0,
  };

  if (opts.slugs && opts.slugs.length > 0) {
    for (const s of opts.slugs) {
      if (isAborted(opts.signal)) break; // #1737: stop the per-slug loop on abort
      try {
        await embedPage(engine, s, !!opts.dryRun, result, opts.sourceId, opts.signal, opts.quiet);
      } catch (e: unknown) {
        if (isAborted(opts.signal)) break; // shutdown, not a failure
        // #3037: a page-level error (not found, DB write) must not exit 0.
        // Chunk-level embed failures are counted inside embedPage; this
        // counts the page itself (chunk count unknown at this site).
        recordFailure(result, 1, s, e);
        serr(`  Error embedding ${s}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return result;
  }
  if (opts.all || opts.stale) {
    // E-2 (paced-backfill): CLI single-flight. Take the SAME per-source lock as
    // the embed-backfill minion handler so a hand-run backfill and a queued job
    // are mutually exclusive per source. All-source runs lock every source in
    // sorted (deterministic) order to avoid acquire-order deadlock. Released in
    // the finally below. Skipped for dryRun and when the caller didn't opt in
    // (cycle / catch-up / sync-auto-embed callers never single-flight).
    //
    // Migration hardening: when the caller ALREADY holds the locks
    // (opts.heldLocks — the migrate-embeddings orchestrator acquires them
    // before the schema transition), use those instead of re-acquiring — a
    // re-acquire would always fail against our own holder and misreport
    // lock_skipped. Ownership stays with the caller (no release here).
    const sfLocks: DbLockHandle[] = [];
    const callerHeld = opts.heldLocks !== undefined && opts.heldLocks.length > 0;
    if (callerHeld === false && opts.singleFlight && opts.stale && !opts.dryRun) {
      let lockSourceIds: string[];
      if (opts.sourceId) {
        lockSourceIds = [opts.sourceId];
      } else {
        try {
          const rows = await engine.listAllSources();
          lockSourceIds = rows.map((r) => r.id).sort();
        } catch {
          lockSourceIds = [];
        }
      }
      for (const sid of lockSourceIds) {
        let lock: DbLockHandle | null = null;
        try {
          lock = await tryAcquireDbLock(engine, embedBackfillLockId(sid), 60);
        } catch {
          // Fail-open: a lock-subsystem error must not crash a backfill. Drop
          // single-flight for this run (release what we took) and proceed.
          for (const h of sfLocks) {
            try { await h.release(); } catch { /* best-effort */ }
          }
          sfLocks.length = 0;
          break;
        }
        if (!lock) {
          // Another backfill (CLI or job) holds this source. Release what we
          // took and bail cleanly rather than racing the upsert path.
          for (const h of sfLocks) {
            try { await h.release(); } catch { /* best-effort */ }
          }
          serr(`  [embed] another backfill is already running for source "${sid}"; skipping (single-flight).`);
          result.lock_skipped = true;
          return result;
        }
        sfLocks.push(lock);
      }
    }

    // Lock heartbeat (round-2 C3/#5): the TTL is 60 minutes and million-chunk
    // drains run longer, so without refresh another process could steal the
    // lock mid-drain and mutual exclusion silently ends. Refresh every 5
    // minutes; a refresh that returns false (fenced predicate matched 0 rows
    // = stolen/released) or that keeps THROWING (3 consecutive transient
    // errors) aborts the drain — continuing without the lock is the one
    // thing this machinery exists to prevent. Covers both our own sfLocks
    // and caller-held locks (the migration's).
    const activeLocks: DbLockHandle[] = callerHeld ? [...(opts.heldLocks ?? [])] : sfLocks;
    const lockAbort = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Test seam: default 5 min; tests shrink it to exercise the loss path.
    const heartbeatMs = Number(process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS) > 0
      ? Number(process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS)
      : 5 * 60 * 1000;
    if (activeLocks.length > 0 && !opts.dryRun) {
      let consecutiveErrors = 0;
      let beating = false;
      heartbeat = setInterval(() => {
        if (beating) return; // a slow tick must not stack
        beating = true;
        void (async () => {
          try {
            if (lockAbort.signal.aborted) return;
            for (const h of activeLocks) {
              const ok = await h.refresh();
              if (!ok) {
                result.lock_lost = true;
                serr('  [embed] single-flight lock was stolen or released mid-run; aborting the drain (partial progress is banked — re-run to resume).');
                if (heartbeat !== undefined) clearInterval(heartbeat);
                lockAbort.abort();
                return;
              }
            }
            consecutiveErrors = 0;
          } catch {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 3) {
              result.lock_lost = true;
              serr('  [embed] lock heartbeat failed 3 consecutive times; aborting the drain rather than running without mutual exclusion.');
              if (heartbeat !== undefined) clearInterval(heartbeat);
              lockAbort.abort();
            }
          } finally {
            beating = false;
          }
        })();
      }, heartbeatMs);
    }
    const drainSignal = anySignal(lockAbort.signal, opts.signal);

    // Resolve DB-contention pacing (env > config > bundle; env is the
    // incident escape hatch). dryRun skips it — no writes to pace. A
    // disabled bundle yields a no-op pacer (zero overhead on the hot path).
    let pacer: DbPacer = createNoopPacer();
    let paceMaxConcurrency: number | undefined;
    if (!opts.dryRun) {
      try {
        const cfg = await loadPaceModeConfig(engine);
        const { envMode, envOverrides } = readPaceEnv();
        // Codex P2: an interactive CLI flag (--pace) is the most immediate
        // intent and sits at the per-call tier (beats env). But a flag
        // SERIALIZED into a background job payload must sit at the CONFIG tier
        // so GBRAIN_PACE_* on the worker can still override it at execution
        // (incident escape hatch). paceFromBackground distinguishes the two.
        const fromBg = !!opts.paceFromBackground;
        const knobs = resolvePaceMode({
          mode: fromBg ? (opts.pace?.perCallMode ?? cfg.mode) : cfg.mode,
          configOverrides: fromBg
            ? { ...cfg.configOverrides, ...(opts.pace?.perCall ?? {}) }
            : cfg.configOverrides,
          envMode,
          envOverrides,
          perCallMode: fromBg ? undefined : opts.pace?.perCallMode,
          perCall: fromBg ? undefined : opts.pace?.perCall,
        });
        if (knobs.enabled) {
          pacer = createDbPacer({ bundle: knobs });
          paceMaxConcurrency = knobs.maxConcurrency;
        }
      } catch {
        // Fail-open: pacing must never break a backfill.
        pacer = createNoopPacer();
      }
    }
    try {
      await embedAll(engine, !!opts.stale, !!opts.dryRun, result, opts.onProgress, opts.sourceId, {
        batchSize: opts.batchSize,
        priority: opts.priority,
        catchUp: opts.catchUp,
        pacer,
        paceMaxConcurrency,
        quiet: opts.quiet,
        includeNullSignature: opts.includeNullSignature,
      }, drainSignal);
    } catch (e) {
      // A heartbeat-triggered abort is a clean, resumable stop (lock_lost is
      // already set + explained on stderr) — not an error to propagate.
      if (!(result.lock_lost && e instanceof AbortError)) throw e;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      // E1: surface pacing telemetry (human + structured) when pacing was on.
      const snap = pacer.snapshot();
      if (snap.enabled) {
        result.pacing = {
          maxConcurrency: snap.maxConcurrency,
          samples: snap.sampleCount,
          ewmaMs: snap.ewmaMs,
          totalSleptMs: snap.totalSleptMs,
          sleeps: snap.sleepCount,
          maxWaiters: snap.maxWaiters,
        };
        serr(
          `  [embed] pacing: cap=${snap.maxConcurrency} samples=${snap.sampleCount} ` +
            `ewma=${snap.ewmaMs === null ? 'n/a' : Math.round(snap.ewmaMs) + 'ms'} ` +
            `slept=${snap.totalSleptMs}ms/${snap.sleepCount}`,
        );
      }
      pacer.dispose();
      // E-2: release single-flight locks (reverse order). Best-effort; the
      // lock TTL is the backstop if a release fails.
      for (const h of sfLocks.reverse()) {
        try { await h.release(); } catch { /* best-effort; TTL covers it */ }
      }
    }
    return result;
  }
  if (opts.slug) {
    await embedPage(engine, opts.slug, !!opts.dryRun, result, opts.sourceId, opts.signal, opts.quiet);
    return result;
  }
  throw new Error('No embed target specified. Pass { slug }, { slugs }, { all }, or { stale }.');
}

/**
 * Parse the `--pace` family from a CLI arg list. Returns ONLY the explicit
 * overrides (CX5: never the full resolved bundle) so they can be serialized
 * into a background-job payload and re-resolved (env > config > bundle) at
 * execution. Returns undefined when no pace flag is present.
 *
 * Recognized: `--pace` (bare ⇒ balanced), `--pace=<mode>`,
 * `--pace-max-concurrency=<n>` / `--pace-max-concurrency <n>`.
 */
export function parsePaceArgs(
  args: string[],
): { perCallMode?: string; perCall?: PaceKeyOverrides } | undefined {
  let perCallMode: string | undefined;
  let perCall: PaceKeyOverrides | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pace') {
      perCallMode = 'balanced';
    } else if (a.startsWith('--pace=')) {
      perCallMode = a.slice('--pace='.length) || 'balanced';
    } else if (a.startsWith('--pace-max-concurrency=')) {
      const n = parseInt(a.slice('--pace-max-concurrency='.length), 10);
      if (Number.isFinite(n) && n >= 1) (perCall ??= {}).maxConcurrency = n;
    } else if (a === '--pace-max-concurrency') {
      const n = parseInt(args[i + 1] ?? '', 10);
      if (Number.isFinite(n) && n >= 1) (perCall ??= {}).maxConcurrency = n;
      i++; // consume the value token so positional parsing can't read it as a slug (Codex P2)
    }
  }
  if (perCallMode === undefined && perCall === undefined) return undefined;
  return { ...(perCallMode !== undefined && { perCallMode }), ...(perCall && { perCall }) };
}

/**
 * Keyless brains: does this invocation qualify for the stale-mode CLEAN
 * refusal (zero-failure result → exit 0)? The documented always-current chain
 * for external agent schedulers is `gbrain sync ... && gbrain embed --stale`
 * (docs/guides/live-sync.md, INSTALL_FOR_AGENTS.md Step 7) — a hard exit 1
 * here broke that chain on every brain installed keyless (init's no-embedding
 * mode), which docs/operations/headless-install.md calls a first-class
 * supported end state whose embed paths "refuse cleanly". Same class as
 * sync's resolveNoEmbed sentinel (sync.ts), same remedy. Deliberately NARROW:
 * only the stale spelling (the chain's). An explicit slug, a slugs list, or
 * the all flag is an explicit request for something impossible on a keyless
 * brain and keeps exiting 1 via EmbeddingDisabledError. Note the slugs-list
 * exclusion mirrors the dispatch precedence below: a slugs flag wins over
 * stale, so a combined invocation is an explicit-slugs run, not a stale run.
 */
export function isKeylessStaleRefusal(args: string[], embeddingDisabled: boolean | undefined): boolean {
  return args.includes('--stale')
    && !args.includes('--all')
    && !args.includes('--slugs')
    && !args.includes('--dry-run')
    && embeddingDisabled === true;
}

export async function runEmbed(engine: BrainEngine, args: string[]): Promise<EmbedResult | undefined> {
  // Keyless clean refusal — see isKeylessStaleRefusal. Checked BEFORE the
  // background block so we never queue a job that can only fail. stderr only;
  // stdout stays empty like every other embed outcome (embed has no JSON
  // result surface — do not invent one here).
  if (isKeylessStaleRefusal(args, loadConfig()?.embedding_disabled)) {
    process.stderr.write(
      '[embed] Embeddings are disabled on this brain (keyless install). '
      + 'Nothing to backfill; keyword search keeps working. '
      + 'Enable later: set embedding_model via gbrain config, then re-run gbrain init with the force flag.\n',
    );
    return {
      embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0,
      pages_processed: 0, failures: 0, failure_samples: [], dryRun: false,
      chunkless_pages_healed: 0,
    };
  }

  // v0.36+ T7: --background submits via Minion queue, returns job_id to
  // stdout, exits. Same semantics in TTY and cron (D9).
  if (args.includes('--background')) {
    const { maybeBackground } = await import('../core/cli-options.ts');
    const backgrounded = await maybeBackground({
      engine,
      args,
      jobName: 'embed',
      paramBuilder: (cleanArgs) => {
        const slugsI = cleanArgs.indexOf('--slugs');
        const srcI = cleanArgs.indexOf('--source');
        const bsI = cleanArgs.indexOf('--batch-size');
        const bsRaw = bsI >= 0 ? parseInt(cleanArgs[bsI + 1] ?? '', 10) : NaN;
        const prI = cleanArgs.indexOf('--priority');
        return {
          all: cleanArgs.includes('--all'),
          stale: cleanArgs.includes('--stale'),
          dryRun: cleanArgs.includes('--dry-run'),
          slugs: slugsI >= 0 ? cleanArgs.slice(slugsI + 1).filter(a => !a.startsWith('--')) : undefined,
          sourceId: srcI >= 0 ? cleanArgs[srcI + 1] : undefined,
          // Background parity (D7): these four used to be silently DROPPED,
          // degrading the documented recovery command to a plain stale run.
          catchUp: cleanArgs.includes('--catch-up'),
          includeNullSignature: cleanArgs.includes('--include-null-signature'),
          ...(Number.isFinite(bsRaw) && bsRaw > 0 && { batchSize: Math.min(10_000, bsRaw) }),
          ...(prI >= 0 && cleanArgs[prI + 1] === 'recent' && { priority: 'recent' }),
          // CX1+CX5: carry explicit pace overrides into the `embed` job payload
          // (the job name CLI --background actually submits). The handler
          // re-resolves env > config > bundle at execution.
          ...(parsePaceArgs(cleanArgs) && { pace: parsePaceArgs(cleanArgs) }),
        };
      },
      source: 'cli',
    });
    if (backgrounded) return;
    // PGLite degraded to inline — fall through.
  }

  const slugsIdx = args.indexOf('--slugs');
  const all = args.includes('--all');
  const stale = args.includes('--stale');
  const dryRun = args.includes('--dry-run');
  // v0.31.12: --source <id> scopes to a single source.
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  // v0.41.18.0 (A13): --batch-size N, --priority recent, --catch-up flags.
  const batchSizeIdx = args.indexOf('--batch-size');
  const batchSizeRaw = batchSizeIdx >= 0 ? args[batchSizeIdx + 1] : undefined;
  const batchSize = batchSizeRaw ? Math.max(1, Math.min(10_000, parseInt(batchSizeRaw, 10) || 0)) : undefined;
  const priorityIdx = args.indexOf('--priority');
  const priorityRaw = priorityIdx >= 0 ? args[priorityIdx + 1] : undefined;
  const priority = priorityRaw === 'recent' ? 'recent' as const : undefined;
  const catchUp = args.includes('--catch-up');
  // #3391: re-embed pages that predate the embedding_signature stamp too.
  const includeNullSignature = args.includes('--include-null-signature');
  const pace = parsePaceArgs(args);

  let opts: EmbedOpts;
  if (slugsIdx >= 0) {
    opts = { slugs: args.slice(slugsIdx + 1).filter(a => !a.startsWith('--')), dryRun, sourceId, batchSize, priority, catchUp };
  } else if (all || stale) {
    // E-2: CLI-only single-flight for stale runs (the minion path locks itself).
    opts = { all, stale, dryRun, sourceId, batchSize, priority, catchUp, ...(pace && { pace }), ...(stale && { singleFlight: true }), ...(includeNullSignature && { includeNullSignature: true }) };
  } else {
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) {
      serr('Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...] [--dry-run] [--batch-size N] [--priority recent] [--catch-up] [--include-null-signature]');
      process.exit(1);
    }
    opts = { slug, dryRun, sourceId, batchSize, priority, catchUp };
  }

  // CLI path: wire a reporter so --progress-json / --quiet / TTY rendering
  // all work. Minion handlers call runEmbedCore directly with their own
  // onProgress (see jobs.ts).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let progressStarted = false;
  opts.onProgress = (done, total, _embedded) => {
    if (!progressStarted) {
      progress.start('embed.pages', total);
      progressStarted = true;
    }
    progress.tick(1);
  };

  try {
    const result = await runEmbedCore(engine, opts);
    if (progressStarted) progress.finish();
    // #3037: loud end-of-run summary so failures are visible even when the
    // per-page stderr lines scrolled away. cli.ts turns failures>0 into a
    // non-zero exit verdict.
    if (result.failures > 0) {
      serr(`[embed] ${result.failures} chunk(s) failed to embed. First error: ${result.failure_samples[0] ?? 'unknown'}`);
    }
    return result;
  } catch (e) {
    if (progressStarted) progress.finish();
    // v0.41.6.0 D1: preflight throws EmbeddingCredentialError; surface the
    // paste-ready userMessage instead of the bare exception text.
    const { EmbeddingCredentialError } = await import('../core/embed-preflight.ts');
    if (e instanceof EmbeddingCredentialError) {
      serr('');
      serr(e.userMessage);
      serr('');
    } else if (e instanceof EmbeddingDimMismatchError) {
      // D.2: surface dim-mismatch failures with the paste-ready recipe
      // instead of the raw Postgres error message.
      serr('\n' + e.recipeMessage + '\n');
    } else {
      serr(e instanceof Error ? e.message : String(e));
    }
    process.exit(1);
  }
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  dryRun: boolean,
  result: EmbedResult,
  sourceId?: string,
  signal?: AbortSignal,
  quiet?: boolean,
) {
  const opts = sourceId ? { sourceId } : undefined;
  const page = await engine.getPage(slug, opts);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }

  // Get existing chunks or create new ones.
  // In dryRun, we still chunk the text locally to count what WOULD be
  // embedded — but we never write chunks or call the embedding model.
  let chunks = await engine.getChunks(slug, opts);
  if (chunks.length === 0) {
    const inputs: ChunkInput[] = [];
    // #4530: respect the active embedding model's per-input token limit.
    const chunkOpts = { maxTokens: resolveMaxChunkTokens() };
    if (page.compiled_truth.trim()) {
      for (const c of chunkText(page.compiled_truth, chunkOpts)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
      }
    }
    if (page.timeline.trim()) {
      for (const c of chunkText(page.timeline, chunkOpts)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'timeline' });
      }
    }

    if (dryRun) {
      // Count what chunking WOULD produce, without writing.
      result.total_chunks += inputs.length;
      result.would_embed += inputs.length;
      result.pages_processed++;
      return;
    }

    if (inputs.length > 0) {
      await engine.upsertChunks(slug, inputs, opts);
      chunks = await engine.getChunks(slug, opts);
    }
  }

  // Embed chunks without embeddings. embedding_is_null is the stored-vector
  // truth: a schema rebuild NULLs vectors without touching embedded_at, so
  // keying on embedded_at alone silently no-ops ("all chunks already
  // embedded") on a rebuild-darkened page. Older callers that selected chunks
  // without the boolean fall back to embedded_at.
  const toEmbed = chunks.filter(c => !c.embedded_at || c.embedding_is_null === true);
  result.total_chunks += chunks.length;
  result.skipped += chunks.length - toEmbed.length;

  if (toEmbed.length === 0) {
    if (!quiet) slog(`${slug}: all ${chunks.length} chunks already embedded`);
    result.pages_processed++;
    return;
  }

  if (dryRun) {
    result.would_embed += toEmbed.length;
    result.pages_processed++;
    return;
  }

  // #3507: embed with the page's STORED wrapping convention (title-tier
  // contextual prefix when the page was embedded wrapped), not raw
  // chunk_text — otherwise a re-embed silently strips the contextual
  // prefixes the sync path applied. fenced_code chunks stay unwrapped.
  // #3037: per-chunk failure isolation — one bad chunk must not leave the
  // page's sibling chunks NULL. The wrapped texts (computed once) feed the
  // fan-out too, so an isolation retry never strips the prefixes. Total
  // embed failure is recorded here (where the chunk count is known) and
  // swallowed: the page stays NULL exactly as before, but the run now
  // reports it (result.failures → non-zero exit) instead of pretending
  // success. Abort (shutdown) still propagates.
  let embeddings: (Float32Array | null)[];
  let failed = 0;
  let firstError: unknown;
  try {
    ({ embeddings, failed, firstError } = await embedPageTexts(
      wrapChunkTextsForStoredMode(page, toEmbed),
      signal ? { abortSignal: signal } : {},
    ));
  } catch (e: unknown) {
    if (isAborted(signal)) throw e;
    recordFailure(result, toEmbed.length, slug, e);
    result.pages_processed++;
    serr(`  Error embedding ${slug}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const embeddingMap = new Map<number, Float32Array>();
  for (let j = 0; j < toEmbed.length; j++) {
    const emb = embeddings[j];
    if (emb) embeddingMap.set(toEmbed[j].chunk_index, emb);
  }
  const updated: ChunkInput[] = chunks.map(c => preserveCodeMetadata(c, {
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    embedding: embeddingMap.get(c.chunk_index),
    token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
  }));

  await engine.upsertChunks(slug, updated, opts);
  // v0.41.31: stamp provenance so a later model/dims swap is detectable as
  // stale. embedPage is the per-slug path used by `gbrain embed <slug>` AND
  // by `gbrain sync`'s post-import embed step (runEmbedCore({slugs})).
  // Guard: only stamp when EVERY chunk was (re)embedded this pass. If some
  // chunks were preserved from a prior embed (unknown/old provenance), the
  // page is mixed — don't claim it's current. `embed --all` fully re-embeds
  // such a page and then stamps it. #3037: a partial failure leaves failed
  // chunks NULL, so don't stamp then either.
  if (failed === 0 && toEmbed.length === chunks.length) {
    // D9 honesty: no stamp when the gateway is unconfigured — a wrong
    // signature is worse than none (NULL = unknown provenance).
    const stampSig = currentEmbeddingSignature();
    if (stampSig) {
      await engine.setPageEmbeddingSignature(slug, { sourceId, signature: stampSig });
    }
    // #3507: a fully re-embedded per_chunk_synopsis page landed at the
    // title tier — keep the stamped mode honest.
    await restampIfDemotedToTitleTier(engine, page, slug, page.source_id);
  }
  result.embedded += toEmbed.length - failed;
  if (failed > 0) {
    recordFailure(result, failed, slug, firstError);
    serr(`  ${slug}: ${failed} chunk(s) failed to embed; embedded the other ${toEmbed.length - failed}`);
  }
  result.pages_processed++;
  if (!quiet) slog(`${slug}: embedded ${toEmbed.length - failed} chunks`);
}

/**
 * Carry per-chunk metadata — modality (the W0 fix: its omission flipped
 * image chunks to text) plus the code fields (language, symbol_name,
 * symbol_type, line range, parent scope, doc comment, qualified name) — from
 * a loaded Chunk back into a ChunkInput destined for upsertChunks. The
 * shared carryChunkMetadata list (core/embed-stale.ts) is authoritative.
 *
 * Issue #769: every re-embed used to strip these fields, and upsertChunks
 * overwrites (does not COALESCE) the metadata columns from EXCLUDED, so
 * each pass clobbered code-def's primary index to NULL. Pulling the
 * preservation into one helper keeps the three re-embed call sites
 * (embedPage, embedAll non-stale, embedAllStale) in lock-step.
 */
function preserveCodeMetadata(loaded: any, base: ChunkInput): ChunkInput {
  // W0 fix-wave (Tier-1 #3, CONFIRMED): delegate to the single shared carry
  // list. This local copy was missing `modality`, so every CLI re-embed path
  // (embedPage, embedAll, embedAllStale) flipped image chunks to
  // modality='text' — upsertChunks overwrites from EXCLUDED — silently
  // zeroing image retrieval until the next full import. The minion twin in
  // core/embed-stale.ts carried it correctly; one list now serves both.
  return carryChunkMetadata(loaded, base);
}

async function embedAll(
  engine: BrainEngine,
  staleOnly: boolean,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
  sourceId?: string,
  staleOpts?: {
    batchSize?: number;
    priority?: 'recent';
    catchUp?: boolean;
    /** DB-contention pacer (paced-backfill); no-op when pacing is off. */
    pacer?: DbPacer;
    /** Resolved concurrency cap (E-1: the worker count, no separate permit). */
    paceMaxConcurrency?: number;
    /** #394: suppress human stdout summaries (structured-output callers). */
    quiet?: boolean;
    /** #3391: lift the NULL-signature grandfather clause (see EmbedOpts). */
    includeNullSignature?: boolean;
  },
  signal?: AbortSignal,
) {
  // v0.41.31: current embedding provenance signature. Stamped onto pages
  // when their chunks are (re)embedded so a later model/dimension swap is
  // detectable as stale.
  // null when the gateway is unconfigured: skip stamping + signature-widened
  // invalidation entirely (a wrong stamp is worse than none — D9 honesty).
  const signature = currentEmbeddingSignature() ?? undefined;
  // ─────────────────────────────────────────────────────────────
  // Stale-only fast path: avoid the listPages + per-page getChunks
  // bomb that pulled every page row + every chunk's embedding column
  // (~76 MB on a 1.5K-page brain) only to client-side-filter for
  // chunks where embedding IS NULL. The new path issues one SQL
  // pre-check + at most one slug-grouped SELECT excluding the
  // (always-null on stale rows) embedding column. On a 100%-embedded
  // brain (the autopilot common case) we exit after ~50 bytes wire.
  //
  // For --all (staleOnly=false) we keep the original behavior — the
  // user is explicitly asking to re-embed everything, including
  // chunks that already have embeddings.
  // ─────────────────────────────────────────────────────────────
  if (staleOnly) {
    // D7: thread sourceId so `gbrain embed --stale --source X` actually scopes.
    // v0.41.18.0 (A13): thread batchSize/priority/catchUp into the stale path.
    // #1737: thread the external abort signal so the cycle embed phase bails.
    return await embedAllStale(engine, sourceId, dryRun, result, onProgress, staleOpts, signature, signal);
  }

  // --all path: pacer (no-op when off). E-1: lower the worker count to the
  // resolved cap instead of adding a separate permit.
  const pacer = staleOpts?.pacer ?? createNoopPacer();

  // v0.31.12: when sourceId is set, scope listPages to that source.
  // v0.41 (D8 + Codex r2 #11): apply embed-skip filter via the shared
  // helper so the `--all` path honors `frontmatter.embed_skip` the same
  // way the `--stale` path does. Without this filter, `gbrain embed --all`
  // (common after model swaps) re-embeds every soft-blocked page,
  // defeating the soft-block. Filtering JS-side here mirrors the SQL-side
  // filter that listStaleChunks/countStaleChunks apply on --stale.
  const allPages = await engine.listPages({ limit: 100000, ...(sourceId && { sourceId }) });
  const pages = filterOutEmbedSkipped(allPages);
  const skippedByEmbedSkip = allPages.length - pages.length;
  if (skippedByEmbedSkip > 0) {
    serr(`[embed] skipped ${skippedByEmbedSkip} page(s) with frontmatter.embed_skip set`);
  }
  let processed = 0;

  // Concurrency limit for parallel page embedding.
  // Each worker pulls pages from a shared queue and makes independent
  // embedBatch calls to OpenAI + upsertChunks to the engine.
  //
  // Default 20: keeps us well under OpenAI's embedding RPM limit
  // (3000+/min for tier 1 = 50+/sec, 20 parallel is safely below) and
  // avoids overwhelming postgres connection pools. Users can tune via
  // GBRAIN_EMBED_CONCURRENCY env var based on their tier/infra.
  // Paced runs lower this to the resolved cap (the real lever vs pooler-slot
  // starvation); unpaced keeps the env/default 20. Codex P2: only ever LOWER —
  // never raise above an operator's existing env cap.
  const BASE_CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  const CONCURRENCY = staleOpts?.paceMaxConcurrency
    ? Math.min(BASE_CONCURRENCY, staleOpts.paceMaxConcurrency)
    : BASE_CONCURRENCY;

  async function embedOnePage(page: typeof pages[number]) {
    // #1737: bail before doing any work for this page if the run was aborted.
    if (isAborted(signal)) return;
    // v0.31.12: thread source_id from the page row so getChunks/upsertChunks
    // target the correct (source_id, slug) row, not the 'default' source.
    const pageSourceId = page.source_id;
    const pageOpts = pageSourceId ? { sourceId: pageSourceId } : undefined;
    const chunks = await observed(pacer, () => engine.getChunks(page.slug, pageOpts));
    const toEmbed = chunks; // staleOnly path handled above via embedAllStale

    result.total_chunks += chunks.length;
    result.skipped += chunks.length - toEmbed.length;

    if (toEmbed.length === 0) {
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    if (dryRun) {
      result.would_embed += toEmbed.length;
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    try {
      // #3507: reproduce the page's stored wrapping convention (see embedPage).
      // #3037: per-chunk failure isolation — one bad chunk costs one chunk,
      // not the whole page's siblings. The wrapped texts feed the fan-out
      // too, so an isolation retry never strips the contextual prefixes.
      const { embeddings, failed, firstError } = await embedPageTexts(
        wrapChunkTextsForStoredMode(page, toEmbed),
        signal ? { abortSignal: signal } : {},
      );
      // Build a map of new embeddings by chunk_index
      const embeddingMap = new Map<number, Float32Array>();
      for (let j = 0; j < toEmbed.length; j++) {
        const emb = embeddings[j];
        if (emb) embeddingMap.set(toEmbed[j].chunk_index, emb);
      }
      // Preserve ALL chunks, only update embeddings for stale ones.
      // preserveCodeMetadata threads code-chunk metadata (#769) so re-embed
      // doesn't clobber language/symbol_name/symbol_type to NULL.
      const updated: ChunkInput[] = chunks.map(c => preserveCodeMetadata(c, {
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: embeddingMap.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await observed(pacer, () => engine.upsertChunks(page.slug, updated, pageOpts));
      // v0.41.31: stamp embedding provenance so a later model swap is
      // detectable as stale. #3037: not on partial failure — failed chunks
      // stay NULL under unknown provenance. D9: no stamp without a gateway
      // (signature undefined) — a wrong stamp is worse than none.
      if (failed === 0) {
        if (signature) {
          await observed(pacer, () =>
            engine.setPageEmbeddingSignature(page.slug, { sourceId: pageSourceId, signature }),
          );
        }
        // #3507: --all fully re-embeds; a per_chunk_synopsis page landed at
        // the title tier — keep the stamped mode honest. #3037: gated on
        // failed === 0 — a partially-failed page was NOT fully re-embedded,
        // so restamping would make contextual_retrieval_mode lie again
        // (the exact #3461 bug).
        await observed(pacer, () =>
          restampIfDemotedToTitleTier(engine, page, page.slug, pageSourceId),
        );
      }
      result.embedded += toEmbed.length - failed;
      if (failed > 0) {
        recordFailure(result, failed, page.slug, firstError);
        serr(`\n  ${page.slug}: ${failed} chunk(s) failed to embed; embedded the other ${toEmbed.length - failed}`);
      }
    } catch (e: unknown) {
      // #3037: count the darkened page so the run can't exit 0 (abort is a
      // shutdown, not a failure).
      if (!isAborted(signal)) recordFailure(result, toEmbed.length, page.slug, e);
      serr(`\n  Error embedding ${page.slug}: ${e instanceof Error ? e.message : e}`);
    }

    processed++;
    result.pages_processed++;
    onProgress?.(processed, pages.length, result.embedded);
    // Cooperative DB-contention pace between pages (no-op when unpaced).
    try {
      await pacer.pace(signal);
    } catch (e) {
      if (!(e instanceof AbortError)) throw e;
    }
  }

  // v0.41.15.0: sliding worker pool extracted into src/core/worker-pool.ts.
  // Throughput characteristics unchanged from the prior inline pool — N
  // workers atomically claim the next page; the helper is the canonical
  // primitive. embedOnePage handles its own per-page errors via try/catch
  // and stderr log (no rethrow), so we don't need failures[] here and
  // omitting onError means the default 'continue' policy applies cleanly
  // even though no errors should reach the pool's catch.
  await runSlidingPool({
    items: pages,
    workers: CONCURRENCY,
    ...(signal && { signal }), // #1737: pool stops claiming pages once aborted
    onItem: (page) => embedOnePage(page),
    failureLabel: (page) => page.slug,
  });

  // Stdout summary preserved for scripts/tests that grep for counts.
  if (!staleOpts?.quiet) {
    if (dryRun) {
      slog(`[dry-run] Would embed ${result.would_embed} chunks across ${pages.length} pages`);
    } else {
      slog(`Embedded ${result.embedded} chunks across ${pages.length} pages`);
    }
  }
}

/**
 * Chunkless-page safety net for `embed --stale`. `listStaleChunks` /
 * `countStaleChunks` only ever look at `content_chunks` rows where
 * `embedding IS NULL` — a page written directly via `putPage` that never
 * went through chunking (e.g. an enrichment-generated entity stub) has NO
 * chunk row at all, so it is invisible to that scan forever, even after
 * unlimited `embed --stale` runs.
 *
 * This sweep finds pages with non-empty content (`compiled_truth` and/or
 * `timeline` — both are chunked independently, mirroring `embedPage`'s
 * chunkless branch) and zero `content_chunks` rows
 * (`engine.listChunklessPagesWithContent`, which already excludes
 * quarantined + embed_skip pages — both intentionally chunkless). The new
 * chunk rows land with `embedding = NULL`, so they flow into the SAME
 * `embed --stale` pass via the existing cursor below — no separate embed
 * step needed here.
 *
 * dryRun chunks locally (a pure, in-memory operation) to report an
 * accurate count without writing anything, matching embedPage's dry-run
 * contract (including `pages_processed`, which embedPage's own dry-run
 * branch increments for exactly this "examined, didn't write" case).
 *
 * Race note (review catch, three rounds — ACCEPTED RESIDUAL RISK, not
 * fully closed): between listing a page and writing its chunks, a
 * concurrent writer (sync, another `put_page`) could change or chunk the
 * SAME page. Two mitigations, both bounded — full atomicity (a
 * transaction/version-guarded conditional write inside `upsertChunks`)
 * would need a new engine primitive shared by every `upsertChunks` caller,
 * which is out of scope for a chunkless-page safety net:
 *   1. Immediately before writing, re-fetch the LIVE page via `getPage`
 *      and build `inputs` from ITS CURRENT content, not the batch-list
 *      snapshot — closes the "content changed but still chunkless"
 *      sub-case, not just the "chunks appeared" one.
 *   2. Re-check `getChunks` right after that same fetch — skip (don't
 *      overwrite) if chunks now exist AT THE TIME OF THE CHECK.
 * What this does NOT close: a writer that inserts chunks in the gap
 * BETWEEN step 2's check and the `upsertChunks` call immediately below it
 * (no intervening `await` other than that one call, but `upsertChunks`
 * itself is not conditioned on the check — this is still check-then-write,
 * not compare-and-swap) can still have its chunks overwritten — HONESTLY:
 * `upsertChunks` treats its input as the full desired chunk set for that
 * page and deletes any existing chunk_index absent from it, so a
 * concurrent writer's chunks landing in that exact gap CAN be replaced
 * with this sweep's stale-content chunks (embedding NULL). This is the
 * SAME check-then-write window `embedPage`'s existing single-page
 * chunkless branch already ships with today (that branch doesn't even
 * have step 2's re-check) — no new race CLASS is introduced, and the
 * window here is a single sequential getPage+getChunks+upsertChunks
 * instead of spanning a whole batch. The blast radius is bounded: the
 * page is NOT deleted or corrupted, just re-chunked from a stale
 * snapshot, and the NEXT write to that page (sync, another edit) that
 * actually chunks it restores correct content — this sweep's own
 * predicate is idempotent and doesn't compound the drift. Closing this
 * fully (true atomicity) is tracked as a follow-up, not blocking this
 * safety net.
 *
 * Per-page failure isolation (review catch): one malformed/oversized
 * chunkless page must not abort the sweep and, with it, the entire
 * `--stale` run before the normal NULL-embedding pass even starts — that
 * would make the safety net WORSE than the bug it fixes. Each page's
 * work is try/caught; a failure is recorded (`EmbedResult.failures` +
 * `failure_samples`, same convention as every other embed failure path)
 * and the sweep moves on.
 *
 * Bounded, keyset-paginated (like listStalePagesForExtraction) — a safety
 * net for a rare drift case, not the primary bulk-chunking path. `BATCH_SIZE`
 * is deliberately small (unlike the 2000-chunk-row default elsewhere in
 * this file): each row here carries a FULL page body (`compiled_truth` +
 * `timeline`), so a large batch of large pages is a real memory/latency
 * concern the metadata-only `listStaleChunks` rows never had (review
 * catch). It still respects the caller's pacer (no-op when pacing is off)
 * and a soft wall-clock cap (`GBRAIN_EMBED_TIME_BUDGET_MS`) so a
 * pathologically large damaged brain can't run this sweep unbounded — it
 * heals what it can and reports the rest for the next `embed --stale` run
 * (the SQL predicate is idempotent; nothing here requires finishing in one
 * pass). `startedAt` is shared with the caller's overall run clock (review
 * catch) — healing and the main stale loop draw from ONE combined budget
 * window, not two independent 30-minute ones. `catchUp` mirrors the main
 * loop's own `--catch-up` handling: removes the cap entirely (the keyset
 * cursor still terminates on its own; `signal` remains the abort path).
 */
async function healChunklessPages(
  engine: BrainEngine,
  sourceId: string | undefined,
  dryRun: boolean,
  result: EmbedResult,
  quiet: boolean | undefined,
  signal: AbortSignal | undefined,
  pacer: DbPacer | undefined,
  startedAt: number,
  catchUp: boolean,
): Promise<void> {
  const BATCH_SIZE = 50;
  const BUDGET_MS: number | null = catchUp
    ? null
    : parseInt(process.env.GBRAIN_EMBED_TIME_BUDGET_MS || `${30 * 60 * 1000}`, 10);
  const activePacer = pacer ?? createNoopPacer();
  let afterPageId: number | undefined;
  let pagesHealed = 0;
  let budgetExceeded = false;

  const buildInputs = (compiledTruth: string, timeline: string): ChunkInput[] => {
    const inputs: ChunkInput[] = [];
    // #4530: respect the active embedding model's per-input token limit.
    const chunkOpts = { maxTokens: resolveMaxChunkTokens() };
    if (compiledTruth.trim()) {
      for (const c of chunkText(compiledTruth, chunkOpts)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
      }
    }
    if (timeline.trim()) {
      for (const c of chunkText(timeline, chunkOpts)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'timeline' });
      }
    }
    return inputs;
  };
  // BUDGET_MS === null means catch-up: no wall-clock cap on this sweep,
  // mirroring the main stale loop's own --catch-up handling below.
  const overBudget = (): boolean => BUDGET_MS != null && Date.now() - startedAt > BUDGET_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isAborted(signal)) break;
    if (overBudget()) { budgetExceeded = true; break; }
    const batch = await observed(activePacer, () => engine.listChunklessPagesWithContent({
      batchSize: BATCH_SIZE,
      ...(afterPageId != null && { afterPageId }),
      ...(sourceId && { sourceId }),
    }));
    if (batch.length === 0) break;
    afterPageId = batch[batch.length - 1].id;

    for (const page of batch) {
      if (isAborted(signal)) break;
      if (overBudget()) { budgetExceeded = true; break; }

      try {
        if (dryRun) {
          // dryRun never writes, so there's no live-refetch race to close —
          // chunk the listed snapshot directly (matches embedPage's own
          // dry-run, which chunks whatever getPage returned at call time).
          const inputs = buildInputs(page.compiled_truth, page.timeline);
          // Whitespace-only content (SQL prefilter is `<> ''`, not
          // trim-aware) chunks to nothing — matches embedPage's contract.
          if (inputs.length === 0) continue;
          result.total_chunks += inputs.length;
          result.would_embed += inputs.length;
          result.pages_processed++;
          pagesHealed++;
          continue;
        }

        // Re-fetch the LIVE page + re-check chunks immediately before
        // writing (see race note above): chunk CURRENT content, and skip
        // rather than clobber if a concurrent writer already chunked this
        // page since we listed it.
        const [livePage, stillChunkless] = await Promise.all([
          observed(activePacer, () => engine.getPage(page.slug, { sourceId: page.source_id })),
          observed(activePacer, () => engine.getChunks(page.slug, { sourceId: page.source_id })),
        ]);
        if (!livePage || stillChunkless.length > 0) continue;
        const inputs = buildInputs(livePage.compiled_truth, livePage.timeline);
        if (inputs.length === 0) continue;

        await observed(activePacer, () =>
          engine.upsertChunks(page.slug, inputs, { sourceId: page.source_id }),
        );
        pagesHealed++;
        try {
          await activePacer.pace(signal);
        } catch (e) {
          if (!(e instanceof AbortError)) throw e;
        }
      } catch (e) {
        if (isAborted(signal)) break;
        recordFailure(result, 1, page.slug, e);
        serr(`\n  [embed] chunkless-page heal failed for ${page.slug}: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (budgetExceeded || batch.length < BATCH_SIZE) break;
  }

  result.chunkless_pages_healed = pagesHealed;
  if (pagesHealed > 0 && !quiet) {
    if (dryRun) {
      serr(`[embed] [dry-run] would chunk ${pagesHealed} page(s) with non-empty content but zero content_chunks rows`);
    } else {
      serr(`[embed] chunked ${pagesHealed} page(s) that had non-empty content but zero content_chunks rows (embedding them in this pass)`);
    }
  }
  if (budgetExceeded && !quiet) {
    serr(`[embed] chunkless-page sweep hit its time budget (${BUDGET_MS}ms) with more pages left; re-run embed --stale to continue healing them`);
  }
}

/**
 * SQL-side stale path: replaces the listPages + per-page getChunks
 * walk with a count + slug-grouped SELECT. Preserves the existing
 * functional contract (every chunk where embedding IS NULL gets
 * embedded; nothing else is touched) without paying egress on
 * already-embedded chunks.
 *
 * Why a separate function: the staleOnly path doesn't need
 * listPages at all and groups by slug differently. Forking the
 * function makes the read-bytes path explicit and keeps the --all
 * path verbatim from prior behavior.
 *
 * Staleness predicate: `embedding IS NULL`. We deliberately do NOT
 * use `embedded_at IS NULL` here — the bulk-import path can leave
 * embedded_at populated while embedding is NULL (see upsertChunks
 * consistency notes), and `embedding IS NULL` is the truth source
 * for "this chunk needs an embedding".
 */
async function embedAllStale(
  engine: BrainEngine,
  sourceId: string | undefined,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
  staleOpts?: {
    batchSize?: number;
    priority?: 'recent';
    catchUp?: boolean;
    /** DB-contention pacer (paced-backfill); no-op when pacing is off. */
    pacer?: DbPacer;
    /** Resolved concurrency cap (E-1: the worker count, no separate permit). */
    paceMaxConcurrency?: number;
    /** #394: suppress human stdout summaries (structured-output callers). */
    quiet?: boolean;
    /** #3391: lift the NULL-signature grandfather clause (see EmbedOpts). */
    includeNullSignature?: boolean;
  },
  signature?: string,
  externalSignal?: AbortSignal,
) {
  // Shared wall-clock anchor (review catch): the healing sweep below and the
  // main stale loop's own budget timer (further down) both measure against
  // this SAME start time, so a run's total wall-clock spend stays capped at
  // ONE `GBRAIN_EMBED_TIME_BUDGET_MS` window instead of summing two
  // independent 30-minute budgets.
  const overallStartedAt = Date.now();

  // D7: thread sourceId so source-scoped runs only count + visit
  // that source's NULL embeddings.
  const sourceOpt = sourceId ? { sourceId } : undefined;
  const includeNullSig = !!staleOpts?.includeNullSignature;

  // Chunkless-page safety net: pre-flight count mirrors the countStaleChunks
  // short-circuit just below — a healthy brain pays one extra SELECT
  // count(*) and does no further work. Only when pages are actually found
  // do we pay for the keyset-paginated chunk sweep. Chunking here (before
  // countStaleChunks) means any newly-written NULL-embedding chunks flow
  // into the SAME pass via the existing cursor.
  const chunklessCount = await engine.countChunklessPagesWithContent(sourceOpt);
  if (chunklessCount > 0) {
    await healChunklessPages(
      engine, sourceId, dryRun, result, staleOpts?.quiet, externalSignal, staleOpts?.pacer,
      overallStartedAt, !!staleOpts?.catchUp,
    );
  }
  // Review catch: an abort during healing must stop the run HERE, before
  // falling through into invalidateStaleSignatureEmbeddings below (which —
  // pre-existing, unchanged by this PR — does not itself check
  // externalSignal). Without this, a caller-cancelled run could still NULL
  // out signature-drifted embeddings and exit, leaving retrieval degraded.
  if (isAborted(externalSignal)) return;

  // v0.41.31: re-embed pages whose embedding_signature drifted (model/dims
  // swap). dry-run must NOT mutate, so it counts signature-stale via the
  // widened predicate; a live run NULLs them first so the existing
  // NULL-embedding cursor (listStaleChunks) picks them up unchanged.
  // Guarded (#4306): embed_skip pages keep their retained vectors — every
  // stale selector excludes them, so NULLing them here (the migrate
  // embeddings drain path included) would be permanent loss.
  //
  // #4283: NULLing is conditional on a WORKING embedder. The drift pre-count
  // keeps the probe's one embed call off the no-drift common path; a failed
  // probe (bad key, unreachable provider, wrong-dims model) skips the
  // invalidation so a misresolved config can't strip vectors it can never
  // replace. validateEmbeddingCreds at runEmbedCore entry is a static env
  // check only — the probe is the live proof.
  if (!dryRun && signature) {
    let signatureDrift = 0;
    try {
      const wide = await engine.countStaleChunks({
        ...sourceOpt, signature, ...(includeNullSig && { includeNullSignature: true }),
      });
      const nullOnly = await engine.countStaleChunks(sourceOpt);
      signatureDrift = wide - nullOnly;
    } catch {
      // Pre-count is best-effort; fall through as "no drift" (no NULLing).
    }
    let invalidated = 0;
    if (signatureDrift > 0) {
      const probeOk = await probeEmbedder(
        (texts, fnOpts) => embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }),
        signature,
        externalSignal,
      );
      if (probeOk) {
        invalidated = await invalidateStaleSignatureEmbeddingsGuarded(engine, {
          signature,
          ...(sourceId && { sourceId }),
          ...(includeNullSig && { includeNullSignature: true }),
        });
      } else {
        serr(
          `  [embed] WARNING: ${signatureDrift} chunk(s) drifted from signature ${signature} but the ` +
          `embedder probe failed — SKIPPING invalidation (existing vectors preserved). ` +
          `Check embedding provider config/credentials.`,
        );
      }
    }
    if (invalidated > 0 && !staleOpts?.quiet) {
      slog(`[embed] invalidated ${invalidated} chunk(s) embedded under a prior model signature`);
    }
    // #3391: the grandfather clause keeps NULL-signature pages on their OLD
    // vectors — two embedding spaces mixed in one index. Loud stderr warning
    // with the fix, instead of silent retrieval degradation.
    //
    // Deliberately NOT gated on `invalidated > 0`: the original bug report's
    // shape is a brain where EVERY embedded page predates the signature stamp,
    // so nothing drifts, nothing is invalidated — and pre-fix that brain got
    // no warning AND no work, the exact silent case #3391 is about. The probe
    // below computes the left-behind count directly, which is 0 on a healthy
    // brain, so an unaffected run stays quiet.
    if (!includeNullSig) {
      try {
        const wide = await engine.countStaleChunks({ ...sourceOpt, signature, includeNullSignature: true });
        const narrow = await engine.countStaleChunks({ ...sourceOpt, signature });
        const leftBehind = wide - narrow;
        if (leftBehind > 0) {
          serr(
            `  [embed] WARNING: ${leftBehind} embedded chunk(s) sit on pages with no recorded ` +
            `embedding signature and were NOT invalidated — they remain in the previous model's ` +
            `embedding space. Re-run with --include-null-signature (or use ` +
            `\`gbrain migrate embeddings\`) to re-embed them.`,
          );
        }
      } catch {
        // The warning probe is best-effort; never break the embed run.
      }
    }
  }

  // #4246: invalidate chunks whose embedding was computed from a PREVIOUS
  // chunk_text revision (embedded_text_hash <> md5(chunk_text)) so content
  // edits flow through the NULL cursor. NOT probe-gated: the blast radius is
  // bounded by real content edits (config-independent, unlike signature
  // drift) and those vectors point at stale text either way. NULL hash
  // (pre-v133 rows) is grandfathered.
  if (!dryRun) {
    try {
      const drifted = await engine.invalidateContentDriftEmbeddings(sourceId ? { sourceId } : undefined);
      if (drifted > 0 && !staleOpts?.quiet) {
        slog(`[embed] invalidated ${drifted} chunk(s) whose text changed after embedding (content drift)`);
      }
    } catch {
      // Best-effort (pre-v133 schema mid-upgrade); the NULL-only loop still runs.
    }
  }

  // Pre-flight: 0 stale chunks → nothing to do, no further DB reads.
  // dry-run includes signature-drift in the count without mutating.
  const staleCount = await engine.countStaleChunks(
    dryRun && signature
      ? { ...sourceOpt, signature, ...(includeNullSig && { includeNullSignature: true }) }
      : sourceOpt,
  );
  if (staleCount === 0) {
    if (!staleOpts?.quiet) {
      if (dryRun) {
        // dryRun never writes, so a healed-but-hypothetical chunkless page's
        // chunks never land in content_chunks and staleCount can't see them
        // — report result.would_embed (already includes them) instead of a
        // bare "0 chunks" that would contradict the returned EmbedResult.
        if (result.would_embed > 0) {
          slog(`[dry-run] Would embed ${result.would_embed} chunks (0 stale found; ${result.chunkless_pages_healed} chunkless page(s) would be chunked)`);
        } else {
          slog('[dry-run] Would embed 0 chunks (0 stale found)');
        }
      } else {
        slog('Embedded 0 chunks (0 stale found)');
      }
    }
    return;
  }

  if (dryRun) {
    result.would_embed += staleCount;
    result.total_chunks += staleCount;
    // No progress event: a dry run reads a count and processes zero pages, so
    // there is no page total to report. The previous synthetic onProgress(1,1,0)
    // made `embed.pages` claim total:1 next to a summary naming a much larger
    // stale count. docs/progress-events.md allows omitting `total` when it is
    // not known up front; it does not allow asserting a wrong one.
    //
    // Log result.would_embed (staleCount + any chunkless-page-healing
    // contribution from above), not the bare staleCount — otherwise this
    // line understates the total whenever chunkless pages were also found.
    if (!staleOpts?.quiet) {
      const chunklessNote = result.chunkless_pages_healed > 0
        ? `, including ${result.chunkless_pages_healed} chunkless page(s)`
        : '';
      slog(`[dry-run] Would embed ${result.would_embed} stale chunks${chunklessNote}`);
    }
    return;
  }

  // v0.33.3: cursor-paginated stale loading. Instead of pulling all 48K+
  // rows in one query (which times out on Supabase's 2-min pooler timeout),
  // we page through 2000 rows at a time via keyset pagination on
  // (page_id, chunk_index). Each query finishes in <1s.
  // v0.41.18.0 (A13): --batch-size N CLI flag overrides hardcoded 2000 default.
  const PAGE_SIZE = staleOpts?.batchSize ?? 2000;
  // Paced runs lower concurrency to the resolved cap (E-1: worker count IS the
  // lever on this single pool, no separate permit). Codex P2: pacing only ever
  // LOWERS concurrency — never raise above an operator's existing env cap.
  const BASE_CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  const CONCURRENCY = staleOpts?.paceMaxConcurrency
    ? Math.min(BASE_CONCURRENCY, staleOpts.paceMaxConcurrency)
    : BASE_CONCURRENCY;
  const pacer = staleOpts?.pacer ?? createNoopPacer();

  // D3 + D3a + D8: wall-clock budget. 30 min default; env override.
  // #1946: --catch-up removes the wall-clock cap. The prior code set BUDGET_MS =
  // Number.MAX_SAFE_INTEGER and passed it to setTimeout — but setTimeout's delay
  // is a 32-bit signed int, so MAX_SAFE_INTEGER (9e15) overflows and the timer
  // fires almost immediately, aborting catch-up after a single batch. The fix is
  // to NOT arm the timer in catch-up at all: the keyset pass below terminates on
  // its own (the (page_id, chunk_index) cursor advances monotonically), and
  // SIGINT / worker-abort still propagate via externalSignal.
  const BUDGET_MS: number | null = staleOpts?.catchUp
    ? null
    : parseInt(process.env.GBRAIN_EMBED_TIME_BUDGET_MS || `${30 * 60 * 1000}`, 10);
  const budgetController = new AbortController();
  // Shares overallStartedAt with the chunkless-page healing sweep above
  // (review catch) so the two phases draw from ONE combined budget window
  // instead of each getting a fresh 30 minutes.
  const budgetStart = overallStartedAt;
  let budgetTimer = BUDGET_MS != null
    ? setTimeout(() => budgetController.abort(), Math.max(0, budgetStart + BUDGET_MS - Date.now()))
    : undefined;
  // E-4 (paced-backfill): the budget measures WORK, not waiting. After each
  // batch, re-arm the timer to fire at start + BUDGET + total-paced-sleep, so a
  // contended DB that spends time in pace() sleeps converges instead of exiting
  // having embedded little. No-op when unpaced (totalSleptMs stays 0) or in
  // catch-up (no budget timer).
  const rearmBudgetForPacing = (): void => {
    if (BUDGET_MS == null) return;
    const slept = pacer.snapshot().totalSleptMs;
    if (budgetTimer) clearTimeout(budgetTimer);
    const fireInMs = budgetStart + BUDGET_MS + slept - Date.now();
    budgetTimer = setTimeout(() => budgetController.abort(), Math.max(0, fireInMs));
  };
  const budgetSignal = budgetController.signal;
  // #1737: the effective signal fires when EITHER the internal wall-clock
  // budget OR the caller's abort (worker timeout / lock loss / SIGTERM) fires.
  // Replaces bare budgetSignal at every loop/pool/embed check below so the
  // autopilot cycle's embed phase stops within one batch (~2s) of being
  // killed instead of running the full 10-15 min and wedging the cycle lock.
  const effectiveSignal = anySignal(budgetSignal, externalSignal);

  // v0.41.18.0 (A13): --priority recent threads orderBy='updated_desc' to
  // listStaleChunks. Composite cursor tracks (updated_at, page_id, chunk_index)
  // instead of just (page_id, chunk_index); first-page cursor is sentinel
  // (null, 0, -1).
  const orderBy: 'page_id' | 'updated_desc' = staleOpts?.priority === 'recent'
    ? 'updated_desc'
    : 'page_id';

  let totalProcessedPages = 0;
  let afterPageId = 0;
  let afterChunkIndex = -1;
  let afterUpdatedAt: string | null = null;
  let totalChunksLoaded = 0;
  let budgetExitNotified = false;
  // #1946 (OV2a) + #3037: embed failures are tracked on result.failures so
  // the catch-up warning below AND the CLI exit verdict both see them.

  // E-3 (paced-backfill): bounded end-of-run re-entry. A longer paced run gives
  // a live writer (sync / put_page) more time to insert NEW stale rows BEHIND
  // the keyset cursor (TODOS:2301). When the cursor exhausts, re-scan from the
  // start — capped at MAX_REENTRIES AND requiring forward progress (a pass that
  // embeds 0 while count>0 stops) so a writer outrunning embed can't spin
  // forever.
  const MAX_REENTRIES = 3;
  let reentries = 0;
  let lastReentryEmbedded = 0;
  const maybeReenter = async (): Promise<boolean> => {
    // Scoped to PACED runs: pacing lengthens the run, which is what widens the
    // behind-cursor window. Unpaced runs keep prior (single-pass) behavior.
    if (!pacer.snapshot().enabled) return false;
    if (effectiveSignal.aborted) return false;
    if (reentries >= MAX_REENTRIES) return false;
    const remaining = await engine.countStaleChunks(sourceOpt);
    if (remaining === 0) return false;
    if (result.embedded === lastReentryEmbedded) return false; // no forward progress
    lastReentryEmbedded = result.embedded;
    reentries++;
    afterPageId = 0;
    afterChunkIndex = -1;
    afterUpdatedAt = null;
    serr(`\n  [embed] re-entry ${reentries}/${MAX_REENTRIES}: ${remaining} stale chunk(s) appeared during the run; rescanning from start.`);
    return true;
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (effectiveSignal.aborted) {
        if (!budgetExitNotified) {
          const why = budgetSignal.aborted
            ? `wall-clock budget (${BUDGET_MS}ms) exceeded`
            : 'aborted by caller (job timeout / lock loss / shutdown)';
          serr(`\n  [embed] ${why}; exiting cleanly. Re-run picks up via partial index.`);
          budgetExitNotified = true;
        }
        break;
      }

      const batch = await observed(pacer, () =>
        engine.listStaleChunks({
          batchSize: PAGE_SIZE,
          afterPageId,
          afterChunkIndex,
          ...(orderBy === 'updated_desc' && {
            orderBy,
            afterUpdatedAt,
          }),
          ...(sourceId && { sourceId }),
        }),
      );
      if (batch.length === 0) {
        if (await maybeReenter()) continue;
        break;
      }
      totalChunksLoaded += batch.length;

      // Advance cursor to last row in this batch.
      const last = batch[batch.length - 1];
      afterPageId = last.page_id;
      afterChunkIndex = last.chunk_index;
      if (orderBy === 'updated_desc') {
        // engine returns `updated_at` as Date or ISO string; normalize to ISO.
        const lastRow = last as unknown as { updated_at?: string | Date | null };
        const u = lastRow.updated_at;
        afterUpdatedAt = u instanceof Date ? u.toISOString()
          : typeof u === 'string' ? u
          : null;
      }

      // Group by composite key (source_id::slug).
      const byKey = new Map<string, typeof batch>();
      for (const row of batch) {
        const key = `${row.source_id}::${row.slug}`;
        const list = byKey.get(key);
        if (list) list.push(row);
        else byKey.set(key, [row]);
      }

      const keys = Array.from(byKey.keys());
      result.total_chunks += batch.length;

      async function embedOneKey(key: string) {
        const stale = byKey.get(key)!;
        const keySourceId = stale[0]?.source_id ?? 'default';
        const slug = stale[0].slug;
        try {
          // #3507: fetch the page row for its title + stored CR mode so the
          // re-embed reproduces the page's wrapping convention instead of
          // silently stripping contextual prefixes — `embed --stale` is the
          // NORMAL post-model-migration path, so raw-text embedding here
          // quietly converted whole corpora to the unwrapped convention.
          const pageRow = await observed(pacer, () => engine.getPage(slug, { sourceId: keySourceId }));
          // #3037: per-chunk failure isolation — one bad chunk costs one
          // chunk, not the whole page's siblings. The wrapped texts feed the
          // fan-out too, so an isolation retry never strips the prefixes.
          const { embeddings, failed, firstError } = await embedPageTexts(
            wrapChunkTextsForStoredMode(pageRow, stale),
            { abortSignal: effectiveSignal },
          );
          // Re-fetch existing chunks and merge to avoid deleting non-stale chunks.
          const existing = await observed(pacer, () => engine.getChunks(slug, { sourceId: keySourceId }));
          const staleIdxToEmbedding = new Map<number, Float32Array>();
          for (let j = 0; j < stale.length; j++) {
            const emb = embeddings[j];
            if (emb) staleIdxToEmbedding.set(stale[j].chunk_index, emb);
          }
          // preserveCodeMetadata threads code-chunk metadata (#769) so the
          // autopilot --stale path doesn't clobber language/symbol_name/etc
          // to NULL on every cycle.
          const merged: ChunkInput[] = existing.map(c => preserveCodeMetadata(c, {
            chunk_index: c.chunk_index,
            chunk_text: c.chunk_text,
            chunk_source: c.chunk_source,
            embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
            token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
          }));
          await observed(pacer, () => engine.upsertChunks(slug, merged, { sourceId: keySourceId }));
          // v0.41.31: stamp provenance after the page's chunks are embedded —
          // but only when EVERY chunk was stale (fully re-embedded this pass).
          // A partially-stale page keeps preserved chunks of unknown/old
          // provenance, so don't claim it's current. (After invalidate, a
          // signature-drifted page IS fully stale → this stamps it.)
          // #3037: not on partial failure — failed chunks stay NULL.
          if (signature && failed === 0 && stale.length === existing.length) {
            await observed(pacer, () =>
              engine.setPageEmbeddingSignature(slug, { sourceId: keySourceId, signature }),
            );
          }
          // #3507: a FULLY re-embedded per_chunk_synopsis page landed at the
          // title tier — keep the stamped mode honest. Partially-stale pages
          // stay stamped as-is (mixed provenance; reindex sweeps fix them).
          // #3037: `failed === 0` is part of "fully re-embedded" — if the
          // per-chunk isolation left some chunks NULL, restamping would make
          // contextual_retrieval_mode lie again (the exact #3461 bug).
          if (failed === 0 && stale.length === existing.length) {
            await observed(pacer, () =>
              restampIfDemotedToTitleTier(engine, pageRow, slug, keySourceId),
            );
          }
          result.embedded += stale.length - failed;
          if (failed > 0) {
            recordFailure(result, failed, slug, firstError);
            serr(`\n  ${slug}: ${failed} chunk(s) failed to embed; embedded the other ${stale.length - failed}`);
          }
        } catch (e: unknown) {
          // Budget/abort-fired cancellations are expected on the way out; don't
          // spam per-page "Error embedding" lines when we're shutting down.
          if (effectiveSignal.aborted) return;
          recordFailure(result, stale.length, slug, e);
          serr(`\n  Error embedding ${slug}: ${e instanceof Error ? e.message : e}`);
        }
        totalProcessedPages++;
        result.pages_processed++;
        // Use staleCount as the estimated total for progress (not exact after
        // pagination starts, but directionally correct).
        onProgress?.(totalProcessedPages, Math.ceil(staleCount / PAGE_SIZE) * keys.length, result.embedded);
        // Cooperative DB-contention pace between keys (no-op when unpaced).
        // E-4 (Codex P1): pace() is subject to the EXTERNAL abort only, NOT the
        // wall-clock budget — a contended DB's sleep must not be cut by the
        // budget timer before its time is credited. Re-arm the budget right
        // after each sleep so accrued sleep never eats into work time.
        try {
          await pacer.pace(externalSignal);
          rearmBudgetForPacing();
        } catch (e) {
          if (!(e instanceof AbortError)) throw e;
        }
      }

      // v0.41.15.0: migrated to shared runSlidingPool. The pool checks
      // its `signal` argument before each claim (mirrors the pre-migration
      // `!budgetSignal.aborted` gate) AND threads abort into in-flight
      // onItem via the local-abort composition for D13. embedOneKey
      // already handles its own per-key errors via try/catch + stderr.
      await runSlidingPool({
        items: keys,
        workers: CONCURRENCY,
        signal: effectiveSignal,
        onItem: (key) => embedOneKey(key),
        failureLabel: (key) => key,
      });

      // E-4: extend the work budget by any paced-sleep time accrued this batch.
      rearmBudgetForPacing();

      // If we got fewer rows than PAGE_SIZE, we've reached the end.
      if (batch.length < PAGE_SIZE) {
        if (await maybeReenter()) continue;
        break;
      }
    }
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (!staleOpts?.quiet) slog(`Embedded ${result.embedded} chunks across ${totalProcessedPages} pages`);

  // #1946 (OV2a): a catch-up pass that completed without being aborted but left
  // chunks unembedded means those chunks are stuck (a non-transient embed
  // failure), not that we ran out of time. Surface it loudly so it doesn't read
  // as a clean run — re-running won't help until the underlying failure is fixed.
  if (staleOpts?.catchUp && !effectiveSignal.aborted && result.failures > 0) {
    const remaining = await engine.countStaleChunks(
      signature
        ? { signature, ...(sourceId ? { sourceId } : {}), ...(includeNullSig && { includeNullSignature: true }) }
        : (sourceId ? { sourceId } : undefined),
    );
    if (remaining > 0) {
      serr(`\n  [embed] catch-up finished but ${remaining} chunk(s) remain stale after ${result.failures} embed failure(s). These are not embeddable as-is; re-running won't clear them until the underlying error is resolved.`);
    }
  }
}

/** Walk the cause chain (like detect429FromCause) for the first HTTP status. */
function statusFromCause(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    cur = obj.cause;
  }
  return undefined;
}

/**
 * #3037: embed one page's chunk texts with per-chunk failure isolation.
 *
 * All three embed paths used to send a page's chunks in ONE
 * embedBatch call, so one bad chunk (e.g. an oversized chunk the provider
 * 400s) left EVERY sibling chunk NULL — an ~8.6x blast radius. This wrapper
 * tries the batch first (the cheap, common path), and only on a
 * PERMANENT-looking batch failure retries once per chunk so one bad chunk
 * costs one chunk.
 *
 * Cost bounding — when we do NOT fan out (rethrow instead):
 *   - 429 / rate limit: embedBatchWithBackoff already retried with backoff;
 *     fanning out N single-chunk calls would hammer the same limiter N-fold.
 *   - AITransientError (5xx / network / unknown, per normalizeAIError): the
 *     batch CONTENT isn't the problem, so isolation can't help — during an
 *     outage it would just multiply failing calls per page.
 *   - 401/403 (auth): nothing chunk-specific; every call would fail.
 * When we DO fan out (permanent request-shaped 4xx like 400/413/422), the
 * per-chunk pass happens at most ONCE per page per run and re-spends roughly
 * the same tokens the failed batch would have — bounded, no recursion. A
 * fresh 429 arising DURING the fan-out still gets the normal backoff (each
 * single-chunk call goes through embedBatchWithBackoff).
 *
 * Throws when nothing could be embedded (total failure — same contract as
 * the pre-#3037 single batch call). Returns `null` at the index of each
 * failed chunk otherwise.
 */
async function embedPageTexts(
  texts: string[],
  opts: EmbedBatchWithBackoffOpts = {},
): Promise<{ embeddings: (Float32Array | null)[]; failed: number; firstError?: unknown }> {
  try {
    return { embeddings: await embedBatchWithBackoff(texts, opts), failed: 0 };
  } catch (e: unknown) {
    if (opts.abortSignal?.aborted) throw e; // shutdown, not a chunk problem
    if (texts.length <= 1) throw e; // nothing to isolate
    // #3374 — network-transient exhaustion isn't chunk-specific either:
    // fanning out during an outage multiplies failing calls per page.
    if (isEmbedRetriableError(e) || isTransientNetworkEmbedError(e) || e instanceof AITransientError) throw e;
    const status = statusFromCause(e);
    if (status === 401 || status === 403) throw e;

    const embeddings: (Float32Array | null)[] = [];
    let failed = 0;
    let firstError: unknown;
    for (const t of texts) {
      try {
        const single = await embedBatchWithBackoff([t], opts);
        embeddings.push(single[0] ?? null);
        if (single[0] === undefined) { failed++; firstError ??= e; }
      } catch (chunkErr: unknown) {
        if (opts.abortSignal?.aborted) throw chunkErr;
        embeddings.push(null);
        failed++;
        firstError ??= chunkErr;
      }
    }
    if (failed === texts.length) throw firstError ?? e; // total failure: pre-#3037 contract
    return { embeddings, failed, firstError };
  }
}
