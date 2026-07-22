/**
 * Single submission entry point for the `embed-backfill` minion job
 * (v0.40 Federated Sync v2 — D19).
 *
 * Every caller routes through `submitEmbedBackfill`:
 *   - Parallel sync --all completion (D18)
 *   - Extended `sync` handler (D22, auto_embed_backfill)
 *   - POST /webhooks/github
 *   - `sources federate` / `unfederate` flip hook
 *   - `gbrain sync trigger`
 *   - autopilot per-source dispatch (when source is stale and degraded)
 *
 * Why centralize: D2 added a per-source DB lock at handler entry. That
 * protects against double-RUN but not double-SUBMIT — a webhook storm could
 * still queue 20 embed-backfill jobs, each one waking, acquiring the lock,
 * finding it busy, completing as `already_in_progress`. Net effect: zero
 * wasted Voyage spend (D6 budget cap), but high queue churn. Worse, even if
 * the lock held, a 30-second idempotency bucket only coalesces SUBMITS within
 * the same window. Multi-hour push activity racks up unbounded calls.
 *
 * D19 layered defenses (composed here):
 *   1. Per-source cooldown (default 10min). Refuses submission if the most
 *      recent embed-backfill for this source finished or is still active
 *      inside the window.
 *   2. Per-source 24h rolling spend cap (default $25). Computed from the
 *      embed-backfill-tagged rows in the budget audit JSONL. Refuses
 *      submission when spend has hit the cap.
 *
 * Both bounds are config-overridable:
 *   - `embed.backfill_cooldown_min`        (default 10)
 *   - `embed.backfill_max_usd_per_source_24h`  (default 25)
 *
 * Returns a tagged-union status so callers can render the right user signal
 * (`gbrain sources status`, webhook response body, sync completion banner).
 */
import type { BrainEngine } from './engine.ts';
import { MinionQueue } from './minions/queue.ts';
import { parseUsdLimit, resolveSpendPosture, type SpendPosture } from './spend-posture.ts';

export const COOLDOWN_CONFIG_KEY = 'embed.backfill_cooldown_min';
export const SPEND_CAP_CONFIG_KEY = 'embed.backfill_max_usd_per_source_24h';

const DEFAULT_COOLDOWN_MIN = 10;
const DEFAULT_SPEND_CAP_USD = 25;

export type SubmitEmbedBackfillStatus =
  | 'submitted'
  | 'cooldown'
  | 'spend_capped';

export interface SubmitEmbedBackfillResult {
  status: SubmitEmbedBackfillStatus;
  /** Set when status === 'submitted'. */
  jobId?: number;
  /** Set when status === 'cooldown'. Seconds remaining until cooldown lifts. */
  cooldownRemainingSeconds?: number;
  /** Set when status === 'spend_capped'. Dollars spent in the 24h window. */
  spend24hUsd?: number;
  /** Set when status === 'spend_capped'. Active cap. */
  spendCapUsd?: number;
  /**
   * Set true when `spend.posture=tokenmax` waved the job past the 24h spend
   * cap (#2139). The spend is still LEDGERED by the per-job BudgetTracker —
   * posture removes the ceiling, not the accounting. Cooldown is NOT bypassed
   * (it's queue-churn protection, not a spend gate).
   */
  spendCapBypassed?: boolean;
}

export interface SubmitEmbedBackfillOpts {
  /** Logged into the job's data row for audit. */
  reason: string;
  /** Override cooldown lookup (tests). */
  cooldownMinOverride?: number;
  /** Override spend-cap lookup (tests). */
  spendCapUsdOverride?: number;
  /** Override the 24h spend aggregator (tests). Returns spend in USD. */
  spend24hFn?: (engine: BrainEngine, sourceId: string) => Promise<number>;
  /** Override `Date.now` (tests). */
  nowMs?: number;
  /** Job priority. Default 5 (lower than autopilot's 0; above default jobs). */
  priority?: number;
  /** Override the resolved spend posture (tests). Default: read from config. */
  postureOverride?: SpendPosture;
}

/**
 * Default 24h-spend aggregator. Reads completed embed-backfill rows in
 * `minion_jobs` and sums their token usage × known-price proxy. We
 * deliberately do NOT read the budget-tracker audit JSONL — the file
 * lives on the worker's local disk and may not be present on the
 * machine submitting the job (e.g. a remote MCP serve-http process).
 *
 * The minion_jobs.tokens_input/output columns ARE populated by the
 * subagent flow but NOT by the embed flow (gateway.embed doesn't go
 * through the chat-completion roll-up). For v0.40 we use a job-COUNT
 * proxy capped at the daily limit: 1 job ≈ default-cap-share. Accepts
 * imprecision in exchange for cross-process visibility.
 *
 * A precise rolling-spend tracker is filed as a v0.41 TODO.
 */
async function defaultSpend24hForSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<number> {
  // Conservative proxy: count jobs that completed (or are running) in the
  // 24h window. Each is treated as worth `DEFAULT_SPEND_CAP_USD / 25` ($1)
  // toward the cap — i.e. 25 jobs in 24h saturate the default cap.
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM minion_jobs
      WHERE name = 'embed-backfill'
        AND data->>'sourceId' = $1
        AND status IN ('active', 'completed')
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [sourceId],
  );
  const jobCount = rows[0]?.n ?? 0;
  return jobCount * 1; // $1 / job placeholder; configurable in a later wave.
}

/**
 * Look up an integer-valued config key with sane defaults.
 * Returns `def` on missing / NaN / non-positive.
 */
async function readIntConfig(
  engine: BrainEngine,
  key: string,
  def: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === null || raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export async function submitEmbedBackfill(
  engine: BrainEngine,
  sourceId: string,
  opts: SubmitEmbedBackfillOpts,
): Promise<SubmitEmbedBackfillResult> {
  const now = opts.nowMs ?? Date.now();
  const cooldownMin =
    opts.cooldownMinOverride ??
    (await readIntConfig(engine, COOLDOWN_CONFIG_KEY, DEFAULT_COOLDOWN_MIN));
  // v0.42.42.0 (#2139): spend cap honors `off`/`unlimited`/`none` → Infinity.
  // `0` still falls back to the default (off semantics ≠ 0).
  const spendCap =
    opts.spendCapUsdOverride ??
    (raw => parseUsdLimit(raw, DEFAULT_SPEND_CAP_USD))(await engine.getConfig(SPEND_CAP_CONFIG_KEY));
  const posture = opts.postureOverride ?? (await resolveSpendPosture(engine));

  // ── Source-level cooldown ─────────────────────────────────────
  // Block re-submission if (a) an embed-backfill is currently active for this
  // source, OR (b) the most-recent embed-backfill finished within the
  // cooldown window.
  const lastJob = await engine.executeRaw<{
    finished_at: Date | null;
    status: string;
  }>(
    `SELECT finished_at, status
       FROM minion_jobs
      WHERE name = 'embed-backfill'
        AND data->>'sourceId' = $1
      ORDER BY id DESC LIMIT 1`,
    [sourceId],
  );

  if (lastJob[0]) {
    if (lastJob[0].status === 'active' || lastJob[0].status === 'waiting') {
      // Active or waiting: no cooldown-remaining number (would be misleading).
      return { status: 'cooldown' };
    }
    if (lastJob[0].finished_at) {
      const finishedMs = new Date(lastJob[0].finished_at).getTime();
      const ageMs = now - finishedMs;
      const cooldownMs = cooldownMin * 60 * 1000;
      if (ageMs < cooldownMs) {
        return {
          status: 'cooldown',
          cooldownRemainingSeconds: Math.ceil((cooldownMs - ageMs) / 1000),
        };
      }
    }
  }

  // ── 24h rolling spend cap ─────────────────────────────────────
  // v0.42.42.0 (#2139): `spend.posture=tokenmax` waves past the cap (the
  // operator declared cost isn't the constraint). The per-job BudgetTracker
  // still ledgers the spend — posture removes the ceiling, not the accounting.
  // An `off`/`unlimited` cap (Infinity) is likewise never tripped.
  const spend24hFn = opts.spend24hFn ?? defaultSpend24hForSource;
  const spend24h = await spend24hFn(engine, sourceId);
  const spendCapBypassed = posture === 'tokenmax' && spend24h >= spendCap;
  if (spend24h >= spendCap && !spendCapBypassed) {
    return {
      status: 'spend_capped',
      spend24hUsd: spend24h,
      spendCapUsd: spendCap,
    };
  }

  // ── Submission ────────────────────────────────────────────────
  const queue = new MinionQueue(engine);
  const job = await queue.add(
    'embed-backfill',
    { sourceId, batchSize: 500, reason: opts.reason },
    {
      priority: opts.priority ?? 5,
      idempotency_key: `embed-backfill:${sourceId}:${bucketize(now, 5 * 60_000)}`,
      maxWaiting: 1,
    },
  );

  return spendCapBypassed
    ? { status: 'submitted', jobId: job.id, spendCapBypassed: true, spend24hUsd: spend24h }
    : { status: 'submitted', jobId: job.id };
}

/** Round timestamp down to the nearest `bucketMs` boundary. */
function bucketize(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs);
}
