/**
 * v0.32.3 search-lite telemetry rollup writer.
 *
 * Architecture decision (D2 in the plan, [CDX-19]): per-process in-memory
 * bucket, flushed periodically (60s OR 100 calls, whichever first) AND on
 * process exit via beforeExit/SIGINT/SIGTERM with a 2-second timeout cap.
 * The search hot path NEVER waits on this write — `record()` is sync and
 * the flush is fire-and-forget.
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
 * tune`), not a financial ledger. The "lose last bucket on hard crash"
 * downside is documented in the methodology doc.
 */

import type { BrainEngine } from '../engine.ts';
import type { HybridSearchMeta } from '../types.ts';

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
}

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_THRESHOLD_CALLS = 100;
const FLUSH_EXIT_TIMEOUT_MS = 2_000;

/**
 * Per-process telemetry singleton. Each gbrain process (CLI, stdio MCP,
 * HTTP MCP) gets one instance. The flush timer and exit hooks are
 * installed lazily on the first `record()` call so importing this module
 * has no side effects.
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
  record(meta: HybridSearchMeta, opts: { results_count: number; tokens_estimate?: number } = { results_count: 0 }): void {
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
      };
      this.buckets.set(key, b);
    }

    b.count += 1;
    b.sum_results += Math.max(0, Math.floor(opts.results_count));
    b.sum_tokens += Math.max(0, Math.floor(opts.tokens_estimate ?? meta.token_budget?.used ?? 0));
    b.sum_budget_dropped += Math.max(0, Math.floor(meta.token_budget?.dropped ?? 0));
    if (meta.cache?.status === 'hit') b.cache_hit += 1;
    if (meta.cache?.status === 'miss') b.cache_miss += 1;

    this.pendingCount += 1;
    if (this.pendingCount >= FLUSH_THRESHOLD_CALLS) {
      void this.flush().catch(() => { /* swallow */ });
    }
  }

  /**
   * Drain the bucket map to the database. Idempotent; concurrent flushes
   * are coalesced via flushInFlight. The bucket map is swapped atomically
   * before the SQL write so new `record()` calls during flush land in a
   * fresh map.
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
                 (date, mode, intent, count, sum_results, sum_tokens, sum_budget_dropped, cache_hit, cache_miss, first_seen, last_seen)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
               ON CONFLICT (date, mode, intent) DO UPDATE SET
                 count = search_telemetry.count + EXCLUDED.count,
                 sum_results = search_telemetry.sum_results + EXCLUDED.sum_results,
                 sum_tokens = search_telemetry.sum_tokens + EXCLUDED.sum_tokens,
                 sum_budget_dropped = search_telemetry.sum_budget_dropped + EXCLUDED.sum_budget_dropped,
                 cache_hit = search_telemetry.cache_hit + EXCLUDED.cache_hit,
                 cache_miss = search_telemetry.cache_miss + EXCLUDED.cache_miss,
                 last_seen = now()`,
              [b.date, b.mode, b.intent, b.count, b.sum_results, b.sum_tokens, b.sum_budget_dropped, b.cache_hit, b.cache_miss],
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

  /** Stop the timer and uninstall exit hooks. Called from tests / shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buckets.clear();
    this.pendingCount = 0;
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

    const drainOnExit = () => {
      // 2-second cap. If flush takes longer (slow DB), we accept losing
      // the last bucket rather than hanging the process exit.
      const racing = Promise.race([
        this.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_EXIT_TIMEOUT_MS)),
      ]);
      void racing.catch(() => { /* swallow */ });
    };

    process.on('beforeExit', drainOnExit);
    // SIGTERM / SIGINT: best-effort drain. If the process is killed -9,
    // nothing we can do.
    process.once('SIGINT', drainOnExit);
    process.once('SIGTERM', drainOnExit);
  }
}

/** Module-level singleton, one per process. */
let _writer: TelemetryWriter | null = null;

export function getTelemetryWriter(): TelemetryWriter {
  if (!_writer) _writer = new TelemetryWriter();
  return _writer;
}

/**
 * Convenience entry point for hot-path callers. Wires the engine lazily
 * and records the call. Never throws.
 */
export function recordSearchTelemetry(
  engine: BrainEngine,
  meta: HybridSearchMeta,
  opts: { results_count: number; tokens_estimate?: number } = { results_count: 0 },
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

    for (const r of rows) {
      total_calls += r.count;
      cache_hits += r.cache_hit;
      cache_misses += r.cache_miss;
      total_results += r.sum_results;
      total_tokens += r.sum_tokens;
      total_budget_dropped += r.sum_budget_dropped;
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
    };
  } catch {
    // Table missing or query failed — return empty stats rather than throw.
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
    };
  }
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
