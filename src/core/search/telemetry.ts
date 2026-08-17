/**
 * v0.32.3 search-lite telemetry rollup writer.
 *
 * Architecture decision (D2 in the plan, [CDX-19]): per-process in-memory
 * bucket, flushed on a best-effort basis (60s timer, or FLUSH_THRESHOLD_CALLS
 * records — the latter is a trigger, not a guarantee: a threshold-crossing
 * record that arrives while a flush is in flight coalesces onto it and does
 * not drain the new bucket, so a buffer can exceed the threshold). There is
 * deliberately NO flush hook on raw process exit — `ensureExitHook` below
 * documents why the beforeExit/SIGINT/SIGTERM drain was removed. Since #4143
 * this module registers with the background-work registry (order 5): the CLI's
 * BOUNDED teardown drain ('exit' mode) flushes residual buckets against the
 * still-live engine, and `engine.disconnect()`'s drain ('disconnect' mode)
 * awaits only the IN-FLIGHT flush — an in-flight statement racing PGLite's
 * `close()` deadlocked the whole process permanently (this was the
 * unregistered 5th sink the registry's own module doc warned about).
 * Consequence: a hard kill or an abandoned snapshot still loses data, and
 * anything buffered at engine disconnect is dropped by design. The search hot
 * path NEVER waits on this write — `record()` is sync and the flush is
 * fire-and-forget.
 *
 * Schema math per [CDX-17]: rows are sums + counts only, NEVER averages.
 * Read-time derives averages. ON CONFLICT DO UPDATE adds raw values so two
 * gbrain processes flushing the same (date, mode, intent) tuple accumulate
 * correctly.
 *
 * The bucket map is keyed by `${date}::${mode}::${intent}`. Date is the
 * UTC ISO date (YYYY-MM-DD). Cross-midnight calls land in distinct buckets
 * automatically.
 *
 * Per-process bucketing means stdio MCP, HTTP MCP, and CLI processes each
 * maintain their own buffers. Stats are directional, not exact — acceptable
 * because the consumer is the operator (or an agent running `gbrain search
 * tune`), not a financial ledger. Loss still happens on hard kills, on drains
 * that exceed their bound, and at engine disconnect (buffered-but-not-flushed
 * rows are dropped there by design). Weigh that when reading counts from a
 * process class that dies unclean often.
 */

import type { BrainEngine } from '../engine.ts';
import type { HybridSearchMeta } from '../types.ts';
import { registerBackgroundWorkDrainer, type BackgroundWorkDrainMode } from '../background-work.ts';

interface Bucket {
  date: string;
  mode: string;
  intent: string;
  count: number;
  sum_results: number;
  sum_tokens: number;
  sum_budget_dropped: number;
  cache_hit: number;
  cache_miss: number;
  // T7 — rank-1 base_score drift signal (aggregate, NOT per-query rows, D10).
  // sum/count derive the mean; 3 coarse buckets give a distribution shape.
  sum_rank1_score: number;
  count_rank1: number;
  rank1_lt_solid: number;  // base_score < 0.6
  rank1_solid: number;     // 0.6 <= base_score < 0.85
  rank1_high: number;      // base_score >= 0.85
}

// T7 — coarse rank-1 score bands (mirror evidence.ts SOLID/HIGH floors).
const RANK1_SOLID_FLOOR = 0.6;
const RANK1_HIGH_FLOOR = 0.85;

/**
 * WP2/T3 — reserved `mode` value for the empty-result cause rollup. Rides
 * the existing (date, mode, intent) PK with ZERO new DDL: rows keyed
 * (date, 'empty_result', <cause>) count empty responses by cause, and
 * readSearchStats diverts them out of the call/intent/mode aggregates.
 * Never collides with real modes ('conservative'|'balanced'|'tokenmax'|
 * 'unset'). Bounded growth: 3 causes × 365 days ≈ 1.1k rows/year.
 */
export const EMPTY_RESULT_MODE = 'empty_result';

export type EmptyResultCause = 'vector_disabled' | 'budget_dropped_all' | 'keyword_zero';

/**
 * WP2/T3 — why did this search return zero results? Precedence: a budget
 * that dropped everything (only reachable with GBRAIN_SEARCH_SALVAGE=off;
 * the minKeep failsafe otherwise returns 1) beats vector-unavailability
 * beats "healthy pipeline, keyword found nothing".
 */
export function classifyEmptyResultCause(meta: HybridSearchMeta): EmptyResultCause {
  const tb = meta.token_budget;
  if (
    (tb && tb.kept === 0 && tb.dropped > 0) ||
    meta.degraded?.some((d) => d.stage === 'budget_dropped_all')
  ) {
    return 'budget_dropped_all';
  }
  if (!meta.vector_enabled) return 'vector_disabled';
  return 'keyword_zero';
}

const FLUSH_INTERVAL_MS = 60_000;
/** Exported for the #4143 regression pin — the disconnect-hang test must fire
 * the flush on its EXACT boundary, not a hard-coded copy that drifts. */
export const FLUSH_THRESHOLD_CALLS = 100;

/**
 * Per-process telemetry singleton. Each gbrain process (CLI, stdio MCP,
 * HTTP MCP) gets one instance. The flush timer is installed lazily by the
 * first `setEngine()` call, not by `record()`, so importing this module has
 * no side effects and a caller can wire an engine without recording. No exit
 * hooks are installed — see `ensureExitHook`.
 */
class TelemetryWriter {
  private buckets = new Map<string, Bucket>();
  private pendingCount = 0;
  private engine: BrainEngine | null = null;
  private timer: NodeJS.Timeout | null = null;
  private exitHookInstalled = false;
  private flushInFlight: Promise<void> | null = null;

  /** Wire the engine. Called once per process at search-time. Subsequent calls are a no-op. */
  setEngine(engine: BrainEngine): void {
    if (!this.engine) {
      this.engine = engine;
      this.ensureExitHook();
      this.ensureTimer();
    }
  }

  /**
   * Record a search call. Sync — never blocks the hot path. Returns
   * immediately after bumping the in-memory bucket. Flush is async +
   * fire-and-forget.
   */
  record(meta: HybridSearchMeta, opts: { results_count: number; tokens_estimate?: number; rank1_score?: number } = { results_count: 0 }): void {
    const date = nowDate();
    const mode = meta.mode ?? 'unset';
    const intent = meta.intent ?? 'unset';
    const key = `${date}::${mode}::${intent}`;

    let b = this.buckets.get(key);
    if (!b) {
      b = {
        date,
        mode,
        intent,
        count: 0,
        sum_results: 0,
        sum_tokens: 0,
        sum_budget_dropped: 0,
        cache_hit: 0,
        cache_miss: 0,
        sum_rank1_score: 0,
        count_rank1: 0,
        rank1_lt_solid: 0,
        rank1_solid: 0,
        rank1_high: 0,
      };
      this.buckets.set(key, b);
    }

    b.count += 1;
    b.sum_results += Math.max(0, Math.floor(opts.results_count));
    b.sum_tokens += Math.max(0, Math.floor(opts.tokens_estimate ?? meta.token_budget?.used ?? 0));
    b.sum_budget_dropped += Math.max(0, Math.floor(meta.token_budget?.dropped ?? 0));
    if (meta.cache?.status === 'hit') b.cache_hit += 1;
    if (meta.cache?.status === 'miss') b.cache_miss += 1;
    // T7 — rank-1 base_score drift signal. Only counts queries that returned
    // a result (rank1_score present + finite).
    if (typeof opts.rank1_score === 'number' && Number.isFinite(opts.rank1_score)) {
      const s = opts.rank1_score;
      b.sum_rank1_score += s;
      b.count_rank1 += 1;
      if (s < RANK1_SOLID_FLOOR) b.rank1_lt_solid += 1;
      else if (s < RANK1_HIGH_FLOOR) b.rank1_solid += 1;
      else b.rank1_high += 1;
    }

    // WP2/T3 — empty-result cause rollup. Cache HITS are excluded: an empty
    // hit slice is an offset-past-end artifact, not a retrieval failure.
    if (opts.results_count === 0 && meta.cache?.status !== 'hit') {
      this.recordEmptyResult(date, classifyEmptyResultCause(meta));
    }

    this.pendingCount += 1;
    if (this.pendingCount >= FLUSH_THRESHOLD_CALLS) {
      void this.flush().catch(() => { /* swallow */ });
    }
  }

  /**
   * Bump the reserved (date, EMPTY_RESULT_MODE, cause) bucket. Only `count`
   * carries signal on these rows — every other column stays 0 and the flush
   * SQL is unchanged (zero new DDL).
   */
  private recordEmptyResult(date: string, cause: EmptyResultCause): void {
    const key = `${date}::${EMPTY_RESULT_MODE}::${cause}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        date,
        mode: EMPTY_RESULT_MODE,
        intent: cause,
        count: 0,
        sum_results: 0,
        sum_tokens: 0,
        sum_budget_dropped: 0,
        cache_hit: 0,
        cache_miss: 0,
        sum_rank1_score: 0,
        count_rank1: 0,
        rank1_lt_solid: 0,
        rank1_solid: 0,
        rank1_high: 0,
      };
      this.buckets.set(key, b);
    }
    b.count += 1;
  }

  /**
   * Drain the bucket map to the database. Idempotent; concurrent flushes
   * are coalesced via flushInFlight — a caller arriving mid-flush awaits the
   * running write and does NOT get its own drain, so whatever it buffered
   * waits for the next trigger. The bucket map is swapped atomically before
   * the SQL write so new `record()` calls during flush land in a fresh map;
   * that swap is also why an uncommitted snapshot is unrecoverable if the
   * process exits mid-write.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.engine || this.buckets.size === 0) {
      this.pendingCount = 0;
      return;
    }

    // Swap the map: a new record() call during flush goes into the new map.
    const snapshot = this.buckets;
    this.buckets = new Map();
    this.pendingCount = 0;

    const engine = this.engine;
    this.flushInFlight = (async () => {
      try {
        for (const b of snapshot.values()) {
          try {
            await engine.executeRaw(
              `INSERT INTO search_telemetry
                 (date, mode, intent, count, sum_results, sum_tokens, sum_budget_dropped, cache_hit, cache_miss,
                  sum_rank1_score, count_rank1, rank1_lt_solid, rank1_solid, rank1_high, first_seen, last_seen)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
               ON CONFLICT (date, mode, intent) DO UPDATE SET
                 count = search_telemetry.count + EXCLUDED.count,
                 sum_results = search_telemetry.sum_results + EXCLUDED.sum_results,
                 sum_tokens = search_telemetry.sum_tokens + EXCLUDED.sum_tokens,
                 sum_budget_dropped = search_telemetry.sum_budget_dropped + EXCLUDED.sum_budget_dropped,
                 cache_hit = search_telemetry.cache_hit + EXCLUDED.cache_hit,
                 cache_miss = search_telemetry.cache_miss + EXCLUDED.cache_miss,
                 sum_rank1_score = search_telemetry.sum_rank1_score + EXCLUDED.sum_rank1_score,
                 count_rank1 = search_telemetry.count_rank1 + EXCLUDED.count_rank1,
                 rank1_lt_solid = search_telemetry.rank1_lt_solid + EXCLUDED.rank1_lt_solid,
                 rank1_solid = search_telemetry.rank1_solid + EXCLUDED.rank1_solid,
                 rank1_high = search_telemetry.rank1_high + EXCLUDED.rank1_high,
                 last_seen = now()`,
              [b.date, b.mode, b.intent, b.count, b.sum_results, b.sum_tokens, b.sum_budget_dropped, b.cache_hit, b.cache_miss,
               b.sum_rank1_score, b.count_rank1, b.rank1_lt_solid, b.rank1_solid, b.rank1_high],
            );
          } catch {
            // swallow — telemetry write must never break the hot path.
            // Per-bucket isolation: one bad row doesn't lose the others.
          }
        }
      } finally {
        this.flushInFlight = null;
      }
    })();
    return this.flushInFlight;
  }

  /**
   * Stop the timer and drop the buffer. Test-only in practice: the sole
   * caller is `_resetTelemetryWriterForTest`. Nothing in production shuts
   * the writer down — processes exit and the buffer goes with them.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buckets.clear();
    this.pendingCount = 0;
    // #4143: tests start clean — never inherit a prior case's in-flight write.
    this.flushInFlight = null;
  }

  /** #4143 — the in-flight flush promise, if any (drain path; never creates work). */
  pendingFlush(): Promise<void> | null {
    return this.flushInFlight;
  }

  /** #4143 — whether any bucket is buffered (drain path fast-check). */
  hasBuffered(): boolean {
    return this.buckets.size > 0;
  }

  /** Test-only — read the current bucket count without draining. */
  bucketCountForTest(): number {
    return this.buckets.size;
  }

  /** Test-only — read a specific bucket (returns null if absent). */
  bucketForTest(date: string, mode: string, intent: string): Readonly<Bucket> | null {
    return this.buckets.get(`${date}::${mode}::${intent}`) ?? null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => { /* swallow */ });
    }, FLUSH_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive on its own.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private ensureExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;

    // Lossy by design: skip the buffered drain entirely on process exit.
    //
    // The earlier implementation installed `process.on('beforeExit', drainOnExit)`
    // with an inner `Promise.race([flush(), setTimeout(2000)])`. That enqueued
    // new async work AFTER the event loop had emptied, which kept the process
    // alive past beforeExit — short-lived CLI invocations (`gbrain query "the"`
    // exiting after 100ms of work) ended up waiting on the DB write to settle.
    // On a slow or busy PGLite, the write never settled and the CLI hung
    // forever. That deadlock surfaced as the `test/e2e/claw-test.test.ts`
    // hang (the harness spawns short-lived gbrain queries that should exit
    // in <1s but never did).
    //
    // Resolution per [CDX-19]: the periodic flush timer (unref'd) handles
    // long-running processes (HTTP MCP server, autopilot, jobs work). For
    // short-lived CLI invocations, telemetry buffering of one search call
    // is acceptable to lose. Stats are directional, not exact.
    //
    // The signal handlers (SIGINT / SIGTERM) also drop — kill -TERM should
    // exit immediately, not block on a DB write that may never complete.
  }

  // Test-only, and currently unreferenced: no test calls it and
  // `_resetTelemetryWriterForTest` uses `stop()`. Despite the name it is not
  // a no-op and is not wired to any exit path — it just forces a flush.
  flushOnExitForTest(): Promise<void> {
    return this.flush().catch(() => { /* swallow */ });
  }
}

/** Module-level singleton, one per process. */
let _writer: TelemetryWriter | null = null;

export function getTelemetryWriter(): TelemetryWriter {
  if (!_writer) _writer = new TelemetryWriter();
  return _writer;
}

/**
 * #4143 — background-work drain for the telemetry sink.
 *
 * 'disconnect' mode: await ONLY the in-flight flush (its statement settles
 * against the still-open raw handle; any FURTHER statement it issues fails
 * fast on the engine's already-nulled handle and is swallowed per-bucket).
 * Residual buckets are deliberately dropped — the buffer is lossy by design.
 *
 * 'exit' mode (CLI teardown, engine still live): after the in-flight flush,
 * also flush residual buckets so a short-lived CLI invocation's calls land.
 *
 * O(1) when nothing is pending. Bounded, non-throwing; `unfinished` counts
 * what the bound abandoned.
 */
export async function awaitPendingTelemetryFlush(
  timeoutMs = 2000,
  mode: BackgroundWorkDrainMode = 'disconnect',
): Promise<{ unfinished: number }> {
  const w = _writer;
  if (!w) return { unfinished: 0 };
  const inFlight = w.pendingFlush();
  const wantsResidual = mode === 'exit' && w.hasBuffered();
  if (!inFlight && !wantsResidual) return { unfinished: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('telemetry-drain-timeout');
  const bound = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
    timer.unref?.();
  });
  try {
    if (inFlight) {
      const r = await Promise.race([inFlight.catch(() => undefined), bound]);
      if (r === timedOut) return { unfinished: 1 };
    }
    if (mode === 'exit' && w.hasBuffered()) {
      const r = await Promise.race([w.flush().catch(() => undefined), bound]);
      if (r === timedOut) return { unfinished: 1 };
    }
    return { unfinished: 0 };
  } catch {
    return { unfinished: 1 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// #4143: register with the background-work registry so BOTH exit points drain
// this sink (orders 0-4 are facts / last-retrieved / search-cache /
// eval-capture / volunteer-events). Registration lives here, the
// enqueue-owning module, per the registry's contract.
registerBackgroundWorkDrainer({
  name: 'search-telemetry',
  order: 5,
  drain: (timeoutMs, mode) => awaitPendingTelemetryFlush(timeoutMs, mode),
});

/**
 * Convenience entry point for hot-path callers. Wires the engine lazily
 * and records the call. Never throws.
 */
export function recordSearchTelemetry(
  engine: BrainEngine,
  meta: HybridSearchMeta,
  opts: { results_count: number; tokens_estimate?: number; rank1_score?: number } = { results_count: 0 },
): void {
  try {
    const w = getTelemetryWriter();
    w.setEngine(engine);
    w.record(meta, opts);
  } catch {
    // swallow — telemetry is best-effort.
  }
}

/**
 * Read aggregated stats over a window. Read-time derives averages from
 * sums + counts so writers can ON CONFLICT-add freely.
 */
export interface StatsWindow {
  total_calls: number;
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number;
  avg_results: number;
  avg_tokens: number;
  total_budget_dropped: number;
  intent_distribution: Record<string, number>;
  mode_distribution: Record<string, number>;
  window_days: number;
  oldest_seen?: string;
  newest_seen?: string;
  // T7 — rank-1 base_score drift signal. avg_rank1_score is the headline the
  // doctor/operator watches for downward drift; the 3 buckets give shape.
  avg_rank1_score: number | null; // null when no rank-1 samples
  rank1_count: number;
  rank1_distribution: { lt_solid: number; solid: number; high: number };
  // WP2/T3 — empty-result responses by cause (vector_disabled /
  // budget_dropped_all / keyword_zero). Diverted from the reserved
  // EMPTY_RESULT_MODE rows; never counted in total_calls or the
  // intent/mode distributions.
  empty_results: { total: number; by_cause: Record<string, number> };
}

export async function readSearchStats(
  engine: BrainEngine,
  opts: { days?: number } = {},
): Promise<StatsWindow> {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const cutoffDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  try {
    const rows = await engine.executeRaw<{
      mode: string;
      intent: string;
      count: number;
      sum_results: number;
      sum_tokens: number;
      sum_budget_dropped: number;
      cache_hit: number;
      cache_miss: number;
      sum_rank1_score: number;
      count_rank1: number;
      rank1_lt_solid: number;
      rank1_solid: number;
      rank1_high: number;
      first_seen: string;
      last_seen: string;
    }>(
      `SELECT mode, intent,
              SUM(count)::int             AS count,
              SUM(sum_results)::int       AS sum_results,
              SUM(sum_tokens)::int        AS sum_tokens,
              SUM(sum_budget_dropped)::int AS sum_budget_dropped,
              SUM(cache_hit)::int         AS cache_hit,
              SUM(cache_miss)::int        AS cache_miss,
              COALESCE(SUM(sum_rank1_score), 0)::float8 AS sum_rank1_score,
              COALESCE(SUM(count_rank1), 0)::int        AS count_rank1,
              COALESCE(SUM(rank1_lt_solid), 0)::int     AS rank1_lt_solid,
              COALESCE(SUM(rank1_solid), 0)::int        AS rank1_solid,
              COALESCE(SUM(rank1_high), 0)::int         AS rank1_high,
              MIN(first_seen)::text       AS first_seen,
              MAX(last_seen)::text        AS last_seen
       FROM search_telemetry
       WHERE date >= $1
       GROUP BY mode, intent`,
      [cutoffDate],
    );

    let total_calls = 0;
    let cache_hits = 0;
    let cache_misses = 0;
    let total_results = 0;
    let total_tokens = 0;
    let total_budget_dropped = 0;
    const intent_distribution: Record<string, number> = {};
    const mode_distribution: Record<string, number> = {};
    let oldest_seen: string | undefined;
    let newest_seen: string | undefined;
    let sum_rank1 = 0;
    let count_rank1 = 0;
    let r1_lt = 0;
    let r1_solid = 0;
    let r1_high = 0;
    let empty_total = 0;
    const empty_by_cause: Record<string, number> = {};

    for (const r of rows) {
      // WP2/T3 — reserved empty-result rows carry cause in the intent slot;
      // divert them so they never skew calls/averages/distributions.
      if (r.mode === EMPTY_RESULT_MODE) {
        empty_total += r.count;
        empty_by_cause[r.intent] = (empty_by_cause[r.intent] ?? 0) + r.count;
        continue;
      }
      total_calls += r.count;
      cache_hits += r.cache_hit;
      cache_misses += r.cache_miss;
      total_results += r.sum_results;
      total_tokens += r.sum_tokens;
      total_budget_dropped += r.sum_budget_dropped;
      sum_rank1 += r.sum_rank1_score;
      count_rank1 += r.count_rank1;
      r1_lt += r.rank1_lt_solid;
      r1_solid += r.rank1_solid;
      r1_high += r.rank1_high;
      intent_distribution[r.intent] = (intent_distribution[r.intent] ?? 0) + r.count;
      mode_distribution[r.mode] = (mode_distribution[r.mode] ?? 0) + r.count;
      if (r.first_seen && (!oldest_seen || r.first_seen < oldest_seen)) oldest_seen = r.first_seen;
      if (r.last_seen && (!newest_seen || r.last_seen > newest_seen)) newest_seen = r.last_seen;
    }

    const probe_total = cache_hits + cache_misses;
    return {
      total_calls,
      cache_hits,
      cache_misses,
      cache_hit_rate: probe_total > 0 ? cache_hits / probe_total : 0,
      avg_results: total_calls > 0 ? total_results / total_calls : 0,
      avg_tokens: total_calls > 0 ? total_tokens / total_calls : 0,
      total_budget_dropped,
      intent_distribution,
      mode_distribution,
      window_days: days,
      oldest_seen,
      newest_seen,
      avg_rank1_score: count_rank1 > 0 ? sum_rank1 / count_rank1 : null,
      rank1_count: count_rank1,
      rank1_distribution: { lt_solid: r1_lt, solid: r1_solid, high: r1_high },
      empty_results: { total: empty_total, by_cause: empty_by_cause },
    };
  } catch {
    // Best-effort by design: a pre-v0.32.3 brain WITHOUT the search_telemetry
    // table shows "0 searches" (with the coverage caveat explaining low/zero
    // counts), NOT a crash — a long-standing contract pinned by
    // test/search-telemetry.test.ts and relied on by the CLI dashboard. The
    // search_stats op wraps this in withRelationGuard for OTHER unexpected
    // relation errors, but the missing-telemetry-table case is intentionally
    // graceful, not 'unavailable'. (Reverted an over-eager gap-closure rethrow
    // that broke this contract for the CLI + dashboard to satisfy a P2 finding.)
    return {
      total_calls: 0,
      cache_hits: 0,
      cache_misses: 0,
      cache_hit_rate: 0,
      avg_results: 0,
      avg_tokens: 0,
      total_budget_dropped: 0,
      intent_distribution: {},
      mode_distribution: {},
      window_days: days,
      avg_rank1_score: null,
      rank1_count: 0,
      rank1_distribution: { lt_solid: 0, solid: 0, high: 0 },
      empty_results: { total: 0, by_cause: {} },
    };
  }
}

/**
 * Coverage disclosure for `readSearchStats()` consumers (`gbrain search
 * stats` / `gbrain search tune`). This documents the buffering behavior
 * from the module header above — it changes NO behavior, it only gives
 * display layers a single source of truth for the caveat text instead of
 * each caller re-describing (and risking drift on) the flush mechanics.
 *
 * Short-lived CLI invocations (a single `gbrain query "..."` call) don't
 * reach the 60s timer or the 100-call threshold, but since #4143 the CLI's
 * bounded teardown drain flushes their buffer in 'exit' mode before the
 * engine disconnects, so a clean exit IS recorded. What still drops: hard
 * kills (SIGKILL, crash), a drain that exceeds its bound, and anything
 * buffered when an engine disconnects outside the CLI teardown path.
 * Long-lived processes (`gbrain serve`, stdio/HTTP MCP, `gbrain jobs work`)
 * are additionally covered by the periodic flush.
 */
export const TELEMETRY_COVERAGE_NOTE =
  'Counts are most complete for long-lived processes (gbrain serve, MCP stdio/HTTP, ' +
  'gbrain jobs work). Short-lived CLI invocations flush their buffer during the ' +
  'bounded CLI teardown drain (#4143), so a clean exit is recorded; a hard kill, a ' +
  'drain that exceeds its bound, or an engine disconnect mid-buffer still drops the ' +
  'remainder — see search/telemetry.ts for the buffering design.';

/**
 * Short, single-line form of {@link TELEMETRY_COVERAGE_NOTE} for human CLI
 * output (the long form is better suited to `--json`'s `reason` field).
 * Every human-facing caveat in `gbrain search stats`/`gbrain search tune`
 * reuses this literal string instead of paraphrasing it, so the wording
 * cannot drift between call sites.
 */
export const TELEMETRY_COVERAGE_CAVEAT =
  'Coverage favors long-lived processes (gbrain serve, MCP, jobs work); CLI search ' +
  'calls are flushed on clean exit, but hard kills and over-bound drains still drop.';

export interface TelemetryCoverage {
  /** Whether a lone short-lived CLI search call is counted (#4143: flushed by the bounded teardown drain on clean exit). */
  cli_invocations: 'recorded_on_clean_exit';
  reason: string;
}

/** Machine-readable form of {@link TELEMETRY_COVERAGE_NOTE} for `--json` output. */
export function telemetryCoverage(): TelemetryCoverage {
  return { cli_invocations: 'recorded_on_clean_exit', reason: TELEMETRY_COVERAGE_NOTE };
}

function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Test-only — reset the module-level singleton between test cases. */
export function _resetTelemetryWriterForTest(): void {
  if (_writer) {
    _writer.stop();
    _writer = null;
  }
}

// ---------------------------------------------------------------------------
// v0.40.4 graph-signals observability (moved from src/commands/search.ts in
// the CLI→MCP gap-closure wave so the `search_stats` op and the CLI share it).
// ---------------------------------------------------------------------------

export interface GraphSignalsStatsSection {
  enabled: boolean;
  source: 'config' | 'mode_default';
  failures_count: number;
  /** Failure-reason breakdown across the window (truncated to top reasons). */
  failures_by_reason: Record<string, number>;
}

export async function readGraphSignalsStats(engine: BrainEngine, days: number): Promise<GraphSignalsStatsSection> {
  // Resolve graph_signals on/off. Mirrors the resolution chain in
  // src/commands/doctor/checks/graph-embedding.ts:checkGraphSignalsCoverage.
  // v0.40.4 codex F1: case-insensitive + trim parity with
  // loadOverridesFromConfig (mode.ts). Without this, search-stats would
  // silently report the opposite of what the parser actually enables on
  // values like 'TRUE' or 'True'.
  const cfg = await engine.getConfig('search.graph_signals').catch(() => null);
  let enabled: boolean;
  let source: 'config' | 'mode_default';
  if (cfg !== null && cfg !== undefined) {
    const v = cfg.trim().toLowerCase();
    enabled = v === 'true' || v === '1';
    source = 'config';
  } else {
    const modeRaw = await engine.getConfig('search.mode').catch(() => null);
    const modeVal = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
    const mode = modeVal === 'conservative' || modeVal === 'tokenmax' ? modeVal : 'balanced';
    enabled = mode !== 'conservative';
    source = 'mode_default';
  }

  let failures_count = 0;
  const failures_by_reason: Record<string, number> = {};
  try {
    const { readRecentGraphSignalsFailures } = await import('./graph-signals.ts');
    const events = readRecentGraphSignalsFailures(days);
    failures_count = events.length;
    // The failure event schema has error_summary (not a reason field) —
    // bucket by the first word of the summary so operators see e.g.
    // "ECONNREFUSED" / "timeout" / "permission" at a glance.
    for (const e of events) {
      const firstWord = (e.error_summary ?? '').split(/[\s:]+/)[0]?.slice(0, 32) || 'unknown';
      failures_by_reason[firstWord] = (failures_by_reason[firstWord] ?? 0) + 1;
    }
  } catch {
    // Audit reader is best-effort. Missing module / corrupt files →
    // count stays 0, search-stats still renders.
  }

  return { enabled, source, failures_count, failures_by_reason };
}
