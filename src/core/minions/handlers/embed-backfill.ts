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
 *   - D6: BudgetTracker enforces per-job spend cap (default $10/job). Goes
 *     through `withBudgetTracker` so `gateway.embed()` auto-composes via
 *     AsyncLocalStorage. On `BudgetExhausted` throw, partial progress is
 *     preserved (chunks already embedded stay embedded; remaining stays NULL).
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
import { BudgetTracker, BudgetExhausted } from '../../budget/budget-tracker.ts';
import { withBudgetTracker } from '../../ai/gateway.ts';
import { embedStaleForSource } from '../../embed-stale.ts';
import { currentEmbeddingSignature } from '../../embedding.ts';
import { type DbPacer, createDbPacer, createNoopPacer } from '../../db-pacer.ts';
import { resolvePaceMode, loadPaceModeConfig, readPaceEnv } from '../../pace-mode.ts';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { parseUsdLimit, usdLimitToCap, resolveSpendPosture } from '../../spend-posture.ts';

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
async function readMaxUsd(engine: BrainEngine): Promise<number | undefined> {
  const posture = await resolveSpendPosture(engine);
  if (posture === 'tokenmax') return undefined;
  const raw = await engine.getConfig('embed.backfill_max_usd');
  return usdLimitToCap(parseUsdLimit(raw, DEFAULT_MAX_USD_PER_JOB));
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

export function makeEmbedBackfillHandler(engine: BrainEngine) {
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
        spentUsd: 0,
      };
    }

    // D6: budget-tracked execution. Gateway calls inside withBudgetTracker
    // auto-compose via AsyncLocalStorage; if pricing pushes cumulative spend
    // past the cap, gateway throws BudgetExhausted BEFORE the next API call.
    const capUsd = await readMaxUsd(engine);
    const tracker = new BudgetTracker({
      maxCostUsd: capUsd,
      label: `embed-backfill:${sourceId}`,
    });

    // paced-backfill: resolve env > config > bundle (env = incident escape
    // hatch). No-op when off. This is the prod path that originally starved
    // the supervisor, so pacing it is the headline win.
    const { pacer, concurrency } = await resolveBackfillPacer(engine, job.data);

    try {
      const result = await withBudgetTracker(tracker, async () =>
        embedStaleForSource(engine, sourceId, {
          batchSize,
          signal: job.signal,
          pacer,
          ...(concurrency !== undefined && { concurrency }),
          // v0.41.31: re-embed pages whose model signature drifted + stamp
          // provenance as chunks land.
          embeddingSignature: currentEmbeddingSignature(),
          onProgress: ({ embedded, chunksProcessed, cursor }) => {
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

      if (result.aborted) {
        return {
          status: 'aborted',
          sourceId,
          embedded: result.embedded,
          chunksProcessed: result.chunksProcessed,
          pagesProcessed: result.pagesProcessed,
          spentUsd: tracker.totalSpent,
        };
      }
      return {
        status: 'success',
        sourceId,
        embedded: result.embedded,
        chunksProcessed: result.chunksProcessed,
        pagesProcessed: result.pagesProcessed,
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
          spentUsd: tracker.totalSpent,
          budgetCapUsd: capUsd,
        };
      }
      throw err;
    } finally {
      pacer.dispose();
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
