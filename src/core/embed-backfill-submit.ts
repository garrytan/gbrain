/**
 * Single submission entry point for the `embed-backfill` minion job
 * (v0.40 Federated Sync v2 — D19).
 *
 * Every automatic caller routes through `submitEmbedBackfill`:
 *   - Parallel sync --all completion (D18)
 *   - Extended `sync` handler (D22, auto_embed_backfill)
 *   - POST /webhooks/github
 *   - `sources federate` / `unfederate` flip hook
 *   - `gbrain sync trigger`
 *   - autopilot per-source dispatch (when source is stale and degraded)
 * Explicit `jobs submit` / MCP submissions route through MinionQueue's public
 * admission gate instead, with explicit CLI follow mode as the inline-worker exception.
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
 *   1. Worker-surface gate. PGLite has no persistent worker, so it refuses
 *      instead of accepting a job that cannot drain after submission returns.
 *   2. Per-source cooldown (default 10min). Refuses submission if the most
 *      recent embed-backfill for this source finished or is still active
 *      inside the window.
 *   3. Per-source 24h rolling spend cap (default $25). Computed from the
 *      embed-backfill-tagged rows in the budget audit JSONL. Refuses
 *      submission when spend has hit the cap.
 *
 *   4. Stall cap (#6803). Backs off, then refuses, while the source's last
 *      backfills failed identically with nothing embedded and its blockers
 *      have not changed since (embed-backfill-stall.ts).
 *
 * Both bounds are config-overridable:
 *   - `embed.backfill_cooldown_min`        (default 10)
 *   - `embed.backfill_max_usd_per_source_24h`  (default 25)
 *
 * Returns a tagged-union status so callers can render the right user signal
 * (`gbrain sources status`, webhook response body, sync completion banner).
 */
import type { BrainEngine } from './engine.ts';
import { cliRenderContext, noticeBlock, renderNotice, type Notice, type RenderedNotice } from './agent-output.ts';
import { getCompanyBrainProfile } from './company-brain/profile.ts';
import { loadConfig } from './config.ts';
import { embeddingsDisabled } from './embedding-disabled.ts';
import { opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';
import { embedBackfillWorkerSurface } from './minions/embed-backfill-admission.ts';
import { MinionQueue } from './minions/queue.ts';
import { EMBED_BACKFILL_STALL_LIMIT, readEmbedBackfillBlockers, readEmbedBackfillStall } from './embed-backfill-stall.ts';
import { parseUsdLimit, resolveSpendPosture, type SpendPosture } from './spend-posture.ts';

export const COOLDOWN_CONFIG_KEY = 'embed.backfill_cooldown_min';
export const SPEND_CAP_CONFIG_KEY = 'embed.backfill_max_usd_per_source_24h';

const DEFAULT_COOLDOWN_MIN = 10;
const DEFAULT_SPEND_CAP_USD = 25;

export type SubmitEmbedBackfillResult =
  | { status: 'submitted'; jobId: number; spendCapBypassed: false }
  | { status: 'submitted'; jobId: number; spendCapBypassed: true; spend24hUsd: number }
  | { status: 'cooldown'; reason: 'active_or_waiting'; cooldownRemainingSeconds: null }
  | { status: 'cooldown'; reason: 'recently_finished'; cooldownRemainingSeconds: number }
  | { status: 'spend_capped'; spend24hUsd: number; spendCapUsd: number }
  /** #6803: the last EMBED_BACKFILL_STALL_LIMIT backfills failed identically with nothing embedded, and nothing has changed since. */
  | { status: 'stalled'; failures: number; remaining: number; blocked: number; lastFailedAt: string }
  | { status: 'no_worker_surface'; engineKind: 'pglite' | 'unknown' }
  /** The brain is keyless by choice: nothing to embed. `notice` is set only the first time for this brain state. */
  | { status: 'embedding_disabled'; notice: Notice | null };

export type SubmitEmbedBackfillStatus = SubmitEmbedBackfillResult['status'];

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

export const EMBED_BACKFILL_SKIP_REPORTED_KEY = 'embed.backfill_skip_reported';

/**
 * GBRA-133 (latency 6.9): a brain keyless by choice (`init --no-embedding`)
 * runs no embed-backfill. Every automatic submitter and the handler stop here
 * instead of draining each stale chunk against no embedding model (one failure
 * per page, three attempts, the worker held for minutes). Returns null when
 * embedding is on. The embed_backfill_skipped notice is returned once per brain
 * state: the first skip records it under EMBED_BACKFILL_SKIP_REPORTED_KEY, and
 * a check that finds embedding on clears the record, so a brain that turns
 * keyless again is told again.
 */
export async function keylessEmbedBackfill(engine: BrainEngine): Promise<{ notice: Notice | null } | null> {
  const reported = await engine.getConfig(EMBED_BACKFILL_SKIP_REPORTED_KEY).catch(() => null);
  if (!await embeddingsDisabled(engine)) {
    if (reported !== null) await engine.unsetConfig(EMBED_BACKFILL_SKIP_REPORTED_KEY).catch(() => undefined);
    return null;
  }
  if (reported === 'embedding_disabled') return { notice: null };
  await engine.setConfig(EMBED_BACKFILL_SKIP_REPORTED_KEY, 'embedding_disabled').catch(() => undefined);
  const { embeddingEnablement } = await import('./readiness.ts');
  const enable = embeddingEnablement({ engine: engine.kind, ...(loadConfig() ?? {}), embedding_disabled: true });
  return { notice: { code: 'embed_backfill_skipped', kind: 'info',
    why: 'Embedding is disabled on this brain (keyless by choice), so no embed-backfill runs and search stays keyword-only; nothing is failing.',
    fix: { ...enable, why: `Keyless is a valid choice and needs nothing. To turn on semantic search instead: ${enable.why}` } } };
}

/** A job's report of the keyless notice: one block on stderr, and the wire form its result carries. */
export function reportKeylessNotice(notice: Notice): RenderedNotice {
  const rendered = renderNotice(notice, cliRenderContext());
  process.stderr.write(`${noticeBlock(rendered)}\n`);
  return rendered;
}

export async function submitEmbedBackfill(
  engine: BrainEngine,
  sourceId: string,
  opts: SubmitEmbedBackfillOpts,
): Promise<SubmitEmbedBackfillResult> {
  // PGLite has no persistent worker process: a queued job cannot be drained
  // after this submission call returns. Refuse before reading gates or writing
  // a row so the undrainable job cannot also cooldown-block a later attempt.
  const surface = embedBackfillWorkerSurface(engine);
  if (surface.status === 'no_worker_surface') return surface;
  const keyless = await keylessEmbedBackfill(engine);
  if (keyless) return { status: 'embedding_disabled', notice: keyless.notice };
  if (await getCompanyBrainProfile(engine, sourceId)) throw opError('source_profile_no_backfill', 'This source profile disables automatic embedding backfill. Enable enrichment only through a separate explicit action.',
    `Source ${sourceId} uses the company-brain import profile, which never queues embedding backfill; keyword search keeps working. Embedding it is a separate action the user approves; do not edit the stored profile.`,
    { docs: 'docs/guides/company-brain-ingestion.md#what-stays-opt-in',
      fix: readFix(`Shows source ${sourceId}'s profile and import state, read-only.`, { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] }) });

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
    if (lastJob[0].status === 'active' || lastJob[0].status === 'waiting' || lastJob[0].status === 'delayed') {
      // Active or waiting has no truthful retry countdown; keep the payload
      // required and explicit instead of omitting a branch-dependent field.
      return { status: 'cooldown', reason: 'active_or_waiting', cooldownRemainingSeconds: null };
    }
    if (lastJob[0].finished_at) {
      const finishedMs = new Date(lastJob[0].finished_at).getTime();
      const ageMs = now - finishedMs;
      const cooldownMs = cooldownMin * 60 * 1000;
      if (ageMs < cooldownMs) {
        return {
          status: 'cooldown',
          reason: 'recently_finished',
          cooldownRemainingSeconds: Math.ceil((cooldownMs - ageMs) / 1000),
        };
      }
    }
  }

  // ── #6803: identical no-progress failures ───────────────────
  // Back off (cooldown x2 per identical failure) and stop at the stall limit
  // while the source's blockers are exactly what the failed runs recorded.
  // A different fingerprint (new stale chunks, a blocker repaired or added)
  // re-arms the next submission; a run that embedded something or completed
  // already ended the streak.
  const stall = await readEmbedBackfillStall(engine, sourceId);
  if (stall && (await readEmbedBackfillBlockers(engine, sourceId, stall.signature)).fingerprint === stall.fingerprint) {
    if (stall.failures >= EMBED_BACKFILL_STALL_LIMIT) {
      return { status: 'stalled', failures: stall.failures, remaining: stall.remaining, blocked: stall.blocked, lastFailedAt: stall.last_finished_at.toISOString() };
    }
    const backoffMs = cooldownMin * 60_000 * 2 ** stall.failures;
    const ageMs = now - stall.last_finished_at.getTime();
    if (ageMs < backoffMs) {
      return { status: 'cooldown', reason: 'recently_finished', cooldownRemainingSeconds: Math.ceil((backoffMs - ageMs) / 1000) };
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
    : { status: 'submitted', jobId: job.id, spendCapBypassed: false };
}

/** Round timestamp down to the nearest `bucketMs` boundary. */
function bucketize(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs);
}
