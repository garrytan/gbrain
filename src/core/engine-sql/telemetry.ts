/**
 * Search telemetry and MCP usage statements: the search telemetry flush and window read (`search/telemetry.ts`) and
 * the per-client MCP usage read with its pruned-window probe (`mcp-usage.ts`), which ran through `engine.executeRaw`,
 * once for both engines.
 *
 * Every statement here ran on master from the caller named on its function. They keep master's text and run on
 * master's raw path (`exec.executeRaw`) unscoped, as before: these tables carry no source and no read policy. Each value
 * is a bound parameter. Each caller keeps its error handling: the flush still swallows every per-bucket error, and the
 * stats read still lets a capability refusal through (engine-capability-refusal.ts).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** One `(date, mode, intent)` search telemetry bucket the flush adds to its row (`date` is `YYYY-MM-DD`). */
export interface SearchTelemetryBucket {
  date: string;
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
}

/** The sums of one `(mode, intent)` over the read window; `first_seen` / `last_seen` are timestamp text. */
export interface SearchTelemetryRow extends Omit<SearchTelemetryBucket, 'date'> {
  first_seen: string;
  last_seen: string;
}

/** One `(token_name, operation)` count of successful MCP requests in the window; `last_seen` is the newest request. */
export interface McpOpUsageRow { token_name: string | null; operation: string; n: number | string; last_seen: unknown }

/** The newest pruned request time of the MCP request log (null when nothing was pruned) and the database clock. */
export interface McpRollupPrunedBefore { pruned_before: unknown; now: unknown }

const RECORD_SEARCH_TELEMETRY_SQL = `INSERT INTO search_telemetry
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
                 last_seen = now()`;

/** Adds one bucket to its `(date, mode, intent)` row, or inserts the row (`SearchTelemetryWriter.flush`, per bucket). */
export async function recordSearchTelemetry(exec: SqlExecutor, b: SearchTelemetryBucket): Promise<void> {
  await exec.executeRaw(RECORD_SEARCH_TELEMETRY_SQL, [
    b.date, b.mode, b.intent, b.count, b.sum_results, b.sum_tokens, b.sum_budget_dropped, b.cache_hit, b.cache_miss,
    b.sum_rank1_score, b.count_rank1, b.rank1_lt_solid, b.rank1_solid, b.rank1_high,
  ]);
}

/** The sums per `(mode, intent)` of the rows dated on or after `cutoffDate` (`YYYY-MM-DD`), in no set order (`readSearchStats`). */
export function readSearchStats(exec: LegacyUnscopedRead, cutoffDate: string): Promise<SearchTelemetryRow[]> {
  return exec.executeRaw<SearchTelemetryRow>(
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
}

/**
 * Successful MCP requests of the trailing `days` per token and operation, in no set order (`readClientOpUsage`).
 * The day count is bound and multiplied into a unit interval.
 */
export function readClientOpUsage(exec: LegacyUnscopedRead, days: number): Promise<McpOpUsageRow[]> {
  return exec.executeRaw<McpOpUsageRow>(
    `SELECT token_name, operation, count(*)::int AS n, max(created_at) AS last_seen
       FROM mcp_request_log
      WHERE created_at > now() - ($1::int * interval '1 day')
        AND token_name IS NOT NULL
        AND status IN ('success', 'success_with_warnings', 'accepted_pending')
      GROUP BY token_name, operation`,
    [days],
  );
}

/**
 * The newest `pruned_through` of the request log tally and the database clock (`readMcpUsageCoverage`). A brain
 * without the tally table (before its migration) never pruned: `pruned_before` is null, as master's probe answered.
 */
export async function readMcpRollupPrunedBefore(exec: LegacyUnscopedRead): Promise<McpRollupPrunedBefore> {
  const [probe] = await exec.executeRaw<{ present: boolean; now: unknown }>(
    "SELECT to_regclass('mcp_request_log_rollup') IS NOT NULL AS present, now() AS now");
  const [row] = probe?.present
    ? await exec.executeRaw<{ pruned_before: unknown }>('SELECT max(pruned_through) AS pruned_before FROM mcp_request_log_rollup')
    : [];
  return { pruned_before: row?.pruned_before ?? null, now: probe?.now ?? null };
}
