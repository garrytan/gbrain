/**
 * `embed-backfill` minion handler (v0.40 Federated Sync v2).
 *
 * Decouples embedding from the sync pipeline so:
 *   - `gbrain sync --all` finishes fast (pages searchable via keyword
 *     immediately), embed-backfill catches up async (D18).
 *   - Webhook-driven syncs don't block on Voyage rate limits (D5 + D18).
 *   - Fresh-source onboarding (federate a 50K-page repo) doesn't make
 *     the user wait for ~$3-$10 of embedding before the sync "completes."
 *
 * The handler is the run-side companion to `submitEmbedBackfill` in
 * `src/core/embed-backfill-submit.ts`. The submit-side gate (D19) handles
 * cross-call rate-limiting (10min cooldown + 24h $25 rolling cap); this
 * handler handles within-run safety:
 *
 *   - D2: per-source DB lock (`gbrain-embed-backfill:<source>`) prevents
 *     two embed-backfill jobs for the same source from running concurrently.
 *     If a second job claims while the first is mid-loop, it returns
 *     `already_in_progress` cleanly and the lock is the source of truth.
 *
 *   - D6: BudgetTracker enforces per-job spend cap (default $10/job). The
 *     default cap is skipped when the configured embedding model has no
 *     built-in or operator-declared price; an explicit numeric cap stays
 *     fail-closed. Goes through `withBudgetTracker` so `gateway.embed()`
 *     auto-composes via AsyncLocalStorage. On `BudgetExhausted` throw, partial
 *     progress is preserved (chunks already embedded stay embedded; remaining
 *     stays NULL).
 *
 *   - D15.1: parent-job linkage is INTENTIONALLY OMITTED. The submit-side
 *     helper does not pass `parent_job_id` — the queue's parent-child
 *     semantics flip the parent into `waiting-children` and fail completion.
 *     Sync handlers are short-lived; embed-backfill outlives them by design.
 *
 *   - try/finally ALWAYS releases the per-source lock. Aborted runs leave
 *     the next call free to claim.
 */
import { tryAcquireDbLock } from '../../db-lock.ts';
import {
  BudgetTracker,
  BudgetExhausted,
  isModelPriceable,
  loadPricingOverrides,
  type PricingOverrides,
} from '../../budget/budget-tracker.ts';
import { getEmbeddingModel, withBudgetTracker } from '../../ai/gateway.ts';
import { embedStaleForSource } from '../../embed-stale.ts';
import { createEmbedStallWatchdog, resolveEmbedStallAbortSeconds } from '../../embed-stall.ts';
import { currentEmbeddingSignature } from '../../embedding.ts';
import { type DbPacer, createDbPacer, createNoopPacer } from '../../db-pacer.ts';
import { resolvePaceMode, loadPaceModeConfig, readPaceEnv } from '../../pace-mode.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { parseUsdLimit, usdLimitToCap, resolveSpendPosture } from '../../spend-posture.ts';
import { recordMinionJobSpend } from '../../minion-spend.ts';

import { embedBackfillLockId, EMBED_BACKFILL_LOCK_TTL_MIN } from '../../embed-backfill-lock.ts';

const DEFAULT_MAX_USD_PER_JOB = 10;

export interface EmbedBackfillJobData {
  sourceId: string;
  batchSize?: number;
  /** Audit string from the submitter (e.g. 'webhook', 'federation_flip'). */
  reason?: string;
}

export interface EmbedBackfillResult {
  status: 'success' | 'already_in_progress' | 'budget_exhausted' | 'aborted';
  sourceId: string;
  embedded: number;
  chunksProcessed: number;
  pagesProcessed: number;
  /**
   * #4283: chunks whose embeddings this run NULLed (signature/content drift).
   * The zero-embed honesty gate below keys on it; surfacing it in the result
   * row lets external samplers audit null-vs-write balance per run.
   */
  invalidated: number;
  /** #4283: set when drifted chunks existed but the embedder probe failed. */
  invalidationSkipped?: 'embedder_probe_failed';
  /** $USD spent inside this job (from BudgetTracker.totalSpent). */
  spentUsd: number;
  /** Set when status === 'budget_exhausted'. */
  budgetCapUsd?: number;
}

/**
 * Resolve a DB-contention pacer from env > config > bundle for the prod
 * backfill path. Fail-open: any error → no-op pacer (pacing never breaks a
 * backfill). Returns the pacer + the resolved concurrency cap (E-1: the
 * worker count for embedStaleForSource's single pool, no separate permit).
 */
async function resolveBackfillPacer(
  engine: BrainEngine,
  jobData: Record<string, unknown>,
): Promise<{ pacer: DbPacer; concurrency?: number }> {
  try {
    const cfg = await loadPaceModeConfig(engine);
    const { envMode, envOverrides } = readPaceEnv();
    const jobPace = (jobData.pace && typeof jobData.pace === 'object'
      ? jobData.pace
      : {}) as { perCallMode?: string; perCall?: Record<string, number | boolean> };
    // Codex P2: serialized job pace sits at the CONFIG tier (job choice beats
    // standing config, but env beats both) so GBRAIN_PACE_* on the worker is a
    // real incident escape hatch for an already-queued job.
    const knobs = resolvePaceMode({
      mode: jobPace.perCallMode ?? cfg.mode,
      configOverrides: { ...cfg.configOverrides, ...(jobPace.perCall ?? {}) },
      envMode,
      envOverrides,
    });
    if (!knobs.enabled) return { pacer: createNoopPacer() };
    return { pacer: createDbPacer({ bundle: knobs }), concurrency: knobs.maxConcurrency };
  } catch {
    return { pacer: createNoopPacer() };
  }
}

/**
 * Resolve the per-job budget cap (USD) for the BudgetTracker.
 *
 * v0.42.42.0 (#2139): returns `undefined` = "no cap" (which BudgetTracker
 * treats as cap-absent) when the config is `off`/`unlimited`/`none` OR when
 * `spend.posture=tokenmax`. NEVER returns Infinity (that would pass through as
 * a real ceiling and serialize to `null` in audit rows). Spend is still
 * ledgered by the tracker either way — posture removes the ceiling, not the
 * accounting. `0`/garbage fall back to the $10 default.
 */
interface BackfillBudgetCap {
  maxCostUsd: number | undefined;
  defaulted: boolean;
  /**
   * The config key was PRESENT but unparsable ("ten", "garbage"). The
   * operator intended a cap, so the $10 default applies AND is never
   * droppable for unpriced models — degrading a typo'd cap to uncapped
   * would silently defeat explicit intent (adversarial review of #4571).
   */
  misconfigured: boolean;
}

function isExplicitFiniteUsdLimit(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

async function readMaxUsd(engine: BrainEngine): Promise<BackfillBudgetCap> {
  const posture = await resolveSpendPosture(engine);
  if (posture === 'tokenmax') return { maxCostUsd: undefined, defaulted: false, misconfigured: false };
  const raw = await engine.getConfig('embed.backfill_max_usd');
  const parsed = parseUsdLimit(raw, DEFAULT_MAX_USD_PER_JOB);
  const explicit = isExplicitFiniteUsdLimit(raw);
  const present = !(raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''));
  const isOff = typeof raw === 'string' && raw.trim().toLowerCase() === 'off';
  return {
    maxCostUsd: usdLimitToCap(parsed),
    defaulted: parsed === DEFAULT_MAX_USD_PER_JOB && !explicit,
    misconfigured: present && !explicit && !isOff,
  };
}

function currentBackfillEmbeddingModel(): string | null {
  try {
    return getEmbeddingModel();
  } catch {
    return null;
  }
}

function capForModel(
  cap: BackfillBudgetCap,
  modelId: string | null,
  pricingOverrides: PricingOverrides | undefined,
): number | undefined {
  if (cap.maxCostUsd === undefined) return undefined;
  if (cap.misconfigured) {
    // Present-but-garbage value: the operator INTENDED a cap. Keep the $10
    // default and never drop it — a typo must not degrade to uncapped spend.
    console.error(
      `[embed-backfill] embed.backfill_max_usd is set but not a positive ` +
        `number; keeping the $${DEFAULT_MAX_USD_PER_JOB} default cap (fail-closed). ` +
        `Fix the value or set it to 'off' to remove the ceiling.`,
    );
    return cap.maxCostUsd;
  }
  if (cap.defaulted && modelId && !isModelPriceable(modelId, 'embed', pricingOverrides)) {
    console.error(
      `[embed-backfill] model "${modelId}" is not in the pricing maps; ` +
        `running without the default per-job cost gate. Add pricing.overrides ` +
        `or set embed.backfill_max_usd to an explicit numeric cap to fail closed.`,
    );
    return undefined;
  }
  return cap.maxCostUsd;
}

/** Validate + extract typed job params. Throws on malformed input. */
function parseParams(data: Record<string, unknown>): EmbedBackfillJobData {
  const sourceId = data.sourceId;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error('embed-backfill: data.sourceId is required and must be a non-empty string');
  }
  const batchSize =
    typeof data.batchSize === 'number' && data.batchSize > 0
      ? data.batchSize
      : undefined;
  const reason =
    typeof data.reason === 'string' ? data.reason : undefined;
  return { sourceId, batchSize, reason };
}

export function makeEmbedBackfillHandler(
  engine: BrainEngine,
  // Test seam: inject the stale-drain so the honesty gates below are unit-
  // testable without a fake gateway. Production callers leave it unset.
  deps: { runStale?: typeof embedStaleForSource } = {},
) {
  const runStale = deps.runStale ?? embedStaleForSource;
  return async function embedBackfillHandler(
    job: MinionJobContext,
  ): Promise<EmbedBackfillResult> {
    const { sourceId, batchSize } = parseParams(job.data);

    // D2: per-source lock at handler entry. The submit-side cooldown (D19)
    // prevents most contention but this is the run-side safety net.
    const lockKey = embedBackfillLockId(sourceId);
    const lock = await tryAcquireDbLock(engine, lockKey, EMBED_BACKFILL_LOCK_TTL_MIN);
    if (!lock) {
      return {
        status: 'already_in_progress',
        sourceId,
        embedded: 0,
        chunksProcessed: 0,
        pagesProcessed: 0,
        invalidated: 0,
        spentUsd: 0,
      };
    }

    // D6: budget-tracked execution. Gateway calls inside withBudgetTracker
    // auto-compose via AsyncLocalStorage; if pricing pushes cumulative spend
    // past the cap, gateway throws BudgetExhausted BEFORE the next API call.
    const pricingOverrides = await loadPricingOverrides(engine);
    const cap = await readMaxUsd(engine);
    const capUsd = capForModel(cap, currentBackfillEmbeddingModel(), pricingOverrides);
    const tracker = new BudgetTracker({
      maxCostUsd: capUsd,
      label: `embed-backfill:${sourceId}`,
      pricingOverrides,
    });

    // paced-backfill: resolve env > config > bundle (env = incident escape
    // hatch). No-op when off. This is the prod path that originally starved
    // the supervisor, so pacing it is the headline win.
    const { pacer, concurrency } = await resolveBackfillPacer(engine, job.data);

    // #4599: this handler is the auto-queued production backfill — the lane
    // most likely to hit the wedged-drain shape (pool exhaustion) — and it
    // bypasses runEmbedCore's watchdog. Arm one here: progress = banked
    // cursor movement (embedded + chunksProcessed); on stall, abort the
    // drain through the same signal the operator abort uses, then THROW so
    // the queue marks the job failed and the resumable cursor re-runs it.
    const stallSeconds = resolveEmbedStallAbortSeconds();
    const drainAbort = new AbortController();
    const onJobAbort = () => drainAbort.abort();
    if (job.signal?.aborted) drainAbort.abort();
    job.signal?.addEventListener('abort', onJobAbort, { once: true });
    let progressCounter = 0;
    const watchdog = stallSeconds > 0
      ? createEmbedStallWatchdog({ thresholdSeconds: stallSeconds, readProgress: () => progressCounter })
      : undefined;
    let stalled = false;
    void watchdog?.stalled.then(() => {
      stalled = true;
      drainAbort.abort();
    });

    try {
      const result = await withBudgetTracker(tracker, async () =>
        runStale(engine, sourceId, {
          batchSize,
          signal: drainAbort.signal,
          pacer,
          ...(concurrency !== undefined && { concurrency }),
          // v0.41.31: re-embed pages whose model signature drifted + stamp
          // provenance as chunks land. D9: omitted when the gateway is
          // unconfigured (null) — the drain falls back to NULL-embedding-only
          // staleness instead of stamping a wrong signature.
          ...(currentEmbeddingSignature() !== null && { embeddingSignature: currentEmbeddingSignature()! }),
          onProgress: ({ embedded, chunksProcessed, cursor }) => {
            // Banked forward progress feeds the stall watchdog's clock.
            progressCounter = embedded + chunksProcessed;
            // Fire-and-forget; updateProgress returns a Promise but the
            // handler is sync inside the loop.
            void job.updateProgress({
              embedded,
              chunksProcessed,
              cursor,
              spentUsd: tracker.totalSpent,
            });
          },
        }),
      );

      if (stalled) {
        // Watchdog abort, not an operator abort: fail the job so the queue's
        // retry/dead-letter machinery sees it; the cursor is banked, so the
        // next run resumes. Mirrors assertEmbedNotStalled's contract.
        throw new Error(
          `stall_timeout: no banked backfill progress for ${stallSeconds}s ` +
            `(embedded=${result.embedded}, chunksProcessed=${result.chunksProcessed}); aborted and resumable`,
        );
      }
      if (result.aborted) {
        return {
          status: 'aborted',
          sourceId,
          embedded: result.embedded,
          chunksProcessed: result.chunksProcessed,
          pagesProcessed: result.pagesProcessed,
          invalidated: result.invalidated,
          ...(result.invalidationSkipped && { invalidationSkipped: result.invalidationSkipped }),
          spentUsd: tracker.totalSpent,
        };
      }
      // #4283 honesty gate: a completed drain that embedded NOTHING while
      // having work to do (it NULLed vectors, or it pulled stale chunks) is a
      // broken-embedder run, not a success. Throw so the queue marks the job
      // failed — pre-fix this shape reported `status: "success"` twelve runs
      // in a row while an entire corpus sat stripped. NULLed chunks stay NULL
      // for the next (fixed-config) run to pick up.
      if (result.embedded === 0 && (result.invalidated > 0 || result.chunksProcessed > 0)) {
        throw new Error(
          `embed-backfill: embedded 0 of ${result.chunksProcessed} processed chunk(s) ` +
          `(${result.invalidated} invalidated) for source "${sourceId}" — refusing to report success. ` +
          `Check embedding provider config/credentials on the worker.`,
        );
      }
      return {
        status: 'success',
        sourceId,
        embedded: result.embedded,
        chunksProcessed: result.chunksProcessed,
        pagesProcessed: result.pagesProcessed,
        invalidated: result.invalidated,
        ...(result.invalidationSkipped && { invalidationSkipped: result.invalidationSkipped }),
        spentUsd: tracker.totalSpent,
      };
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        // Partial progress preserved: already-embedded chunks stay embedded;
        // remaining stays NULL for the next run to pick up.
        return {
          status: 'budget_exhausted',
          sourceId,
          embedded: 0, // Tracker doesn't track per-chunk count
          chunksProcessed: 0,
          pagesProcessed: 0,
          invalidated: 0, // Unknown — the drain's counters are lost with the throw
          spentUsd: tracker.totalSpent,
          budgetCapUsd: capUsd,
        };
      }
      throw err;
    } finally {
      watchdog?.stop();
      job.signal?.removeEventListener('abort', onJobAbort);
      pacer.dispose();
      // Settle this run's LLM/embedding spend against the originating OAuth
      // client (job.data.client_id when run_onboard submitted the job; NULL
      // for local submissions — the row still lands for global accounting).
      // Covers every exit path — success, aborted, budget_exhausted, throw.
      // Best-effort: spend telemetry must never fail the job (recordSpend
      // swallows write failures; this guard swallows the rest). Ceil so
      // sub-cent spend still counts against the per-client daily cap.
      if (tracker.totalSpent > 0) {
        try {
          await recordMinionJobSpend(engine, { id: job.id, data: job.data }, {
            operation: 'embed-backfill',
            spendCents: Math.ceil(tracker.totalSpent * 100),
          });
        } catch { /* never block the job on ledger writes */ }
      }
      // ALWAYS release. Aborts, throws, budget-exhaust — all paths unwind here.
      try {
        await lock.release();
      } catch {
        // Lock release best-effort; TTL fallback covers the case where the
        // row was already cleared by a parallel writer.
      }
    }
  };
}
