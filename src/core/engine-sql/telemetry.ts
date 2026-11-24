/**
 * Search telemetry and MCP usage statements: the search telemetry flush and window read (`search/telemetry.ts`),
 * the per-client MCP usage read with its pruned-window probe (`mcp-usage.ts`), the MCP request log insert (the
 * request, surface, access-admin, webhook, memory setting audit and legacy HTTP transport rows), the request log
 * retention prune and the lifetime usage read (`mcp-request-log-retention.ts`), which ran through
 * `engine.executeRaw`, once for both engines.
 *
 * Every statement here ran on master from the caller named on its function. They keep master's text and run on
 * master's raw path (`exec.executeRaw`) unscoped, as before: these tables carry no source and no read policy. Each value
 * is a bound parameter. Each caller keeps its error handling: the flush still swallows every per-bucket error, and the
 * stats read still lets a capability refusal through (engine-capability-refusal.ts).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { joinFragments, renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

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

/**
 * One `mcp_request_log` row. `error_message` and `params` (a JSON object, or null) default to null. `created_at`
 * defaults to the database clock; the callers never set it (parity fixtures age a row with it).
 */
export interface McpRequestLogRow {
  token_name: string | null;
  agent_name: string | null;
  operation: string;
  latency_ms: number | null;
  status: string;
  error_message?: string | null;
  params?: unknown;
  created_at?: Date | string | null;
}

/** Whether the request log tally table exists, and the retention cutoff `now() - days` on the database clock. */
export interface McpLogPruneCutoff { rollup_present: boolean; cutoff: unknown }

/** One retention batch: the rows it deleted and the newest `created_at` among them (null when none). */
export interface McpLogPruneBatch { deleted: number; newest: unknown }

/** One token's lifetime request count (kept log rows plus the pruned tally) and its newest request time. */
export interface McpLifetimeUsageRow { token_name: string; requests: number; last_used_at: unknown }

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

const LOG_MCP_REQUEST_SQL = `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, created_at, params)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8::jsonb)`;

/**
 * Appends one row to the MCP request log (the MCP request, tools/list, webhook, surface change, access admin and
 * memory setting audit rows). `params` binds as JSONB through executeRawJsonb, never as JSON text. On a transaction's
 * executor the row commits with the transaction, as the memory setting audit needs.
 */
export async function logMcpRequest(exec: SqlExecutor, row: McpRequestLogRow): Promise<void> {
  await executeRawJsonb(exec, LOG_MCP_REQUEST_SQL, [
    row.token_name, row.agent_name, row.operation, row.latency_ms, row.status, row.error_message ?? null,
    row.created_at ?? null,
  ], [row.params ?? null]);
}

/**
 * The retention prune's first read: whether `mcp_request_log_rollup` exists (a brain before its migration has none,
 * and the prune skips) and the cutoff `now() - days`, fixed once per run (`pruneMcpRequestLog`).
 */
export async function readMcpLogPruneCutoff(exec: SqlExecutor, days: number): Promise<McpLogPruneCutoff> {
  const [row] = await exec.executeRaw<{ rollup_present: boolean; cutoff: unknown }>(
    "SELECT to_regclass('mcp_request_log_rollup') IS NOT NULL AS rollup_present, now() - ($1::int * interval '1 day') AS cutoff",
    [days],
  );
  return { rollup_present: row?.rollup_present === true, cutoff: row?.cutoff ?? null };
}

const PRUNE_BATCH_SQL = `
WITH victims AS MATERIALIZED (
  SELECT id FROM mcp_request_log
   WHERE created_at < $1::timestamptz AND operation <> ALL($2::text[])
   ORDER BY created_at
   LIMIT $3
   FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM mcp_request_log l USING victims v WHERE l.id = v.id
  RETURNING l.token_name, l.created_at
), agg AS (
  SELECT COALESCE(token_name, '') AS token_name, count(*)::bigint AS n, max(created_at) AS newest
    FROM deleted GROUP BY 1
), tallied AS (
  INSERT INTO mcp_request_log_rollup AS r (token_name, requests, last_used_at, pruned_through)
  SELECT token_name, n, newest, newest FROM agg
  ON CONFLICT (token_name) DO UPDATE SET
    requests = r.requests + EXCLUDED.requests,
    last_used_at = GREATEST(r.last_used_at, EXCLUDED.last_used_at),
    pruned_through = GREATEST(r.pruned_through, EXCLUDED.pruned_through)
  RETURNING 1
)
SELECT (SELECT count(*) FROM deleted)::int AS deleted, (SELECT max(created_at) FROM deleted) AS newest, (SELECT count(*) FROM tallied)::int AS tallied`;

/**
 * One retention batch, in ONE statement: the oldest `limit` rows created before `cutoff` whose operation is not in
 * `keepOperations` (index order on created_at, FOR UPDATE SKIP LOCKED so two prunes never take the same row) are
 * deleted and added to the per-token tally (count, newest time, pruned_through; a NULL token counts under ''). A
 * failed tally rolls its delete back.
 */
export async function pruneMcpRequestLogBatch(
  exec: SqlExecutor, cutoff: string, keepOperations: readonly string[], limit: number,
): Promise<McpLogPruneBatch> {
  const [row] = await exec.executeRaw<{ deleted: number; newest: unknown }>(PRUNE_BATCH_SQL, [cutoff, [...keepOperations], limit]);
  return { deleted: Number(row?.deleted ?? 0), newest: row?.newest ?? null };
}

// Two whole static statements (no composed text, so the $1 stays a plain placeholder): the kept rows plus the tally,
// and the kept rows alone for a brain that predates the tally table.
const LIFETIME_WITH_ROLLUP_SQL = `SELECT token_name, sum(n)::bigint AS requests, max(newest) AS last_used_at FROM (
    SELECT token_name, count(*)::bigint AS n, max(created_at) AS newest
      FROM mcp_request_log WHERE token_name = ANY($1::text[]) GROUP BY token_name
    UNION ALL
    SELECT token_name, requests, last_used_at FROM mcp_request_log_rollup WHERE token_name = ANY($1::text[])
  ) u GROUP BY token_name ORDER BY token_name COLLATE "C"`;
const LIFETIME_KEPT_ONLY_SQL = `SELECT token_name, count(*)::bigint AS requests, max(created_at) AS last_used_at
    FROM mcp_request_log WHERE token_name = ANY($1::text[]) GROUP BY token_name ORDER BY token_name COLLATE "C"`;

/**
 * Lifetime requests and last use per asked token (`lifetimeUsage`, the `gbrain auth` and admin dashboard totals): the
 * rows still in the request log, every status and operation, plus the pruned tally. A brain without the tally table
 * (before its migration) never pruned, so the log alone answers. A null token row never matches; the tally keeps
 * those under `''`, which matches only when `''` is asked. Rows come in token byte order (master's statement had no
 * order; its only caller keys the rows). `requests` is a number on every driver.
 */
export async function readMcpLifetimeUsage(exec: LegacyUnscopedRead, tokenNames: readonly string[]): Promise<McpLifetimeUsageRow[]> {
  const [probe] = await exec.executeRaw<{ present: boolean }>("SELECT to_regclass('mcp_request_log_rollup') IS NOT NULL AS present");
  const rows = await exec.executeRaw<{ token_name: string; requests: number | string; last_used_at: unknown }>(
    probe?.present === true ? LIFETIME_WITH_ROLLUP_SQL : LIFETIME_KEPT_ONLY_SQL,
    [[...tokenNames]],
  );
  return rows.map((r) => ({ token_name: r.token_name, requests: Number(r.requests), last_used_at: r.last_used_at ?? null }));
}

/** Which request log rows `countMcpRequestsLastDay` counts: every row, the traffic (no surface audit rows), or the failed traffic. */
export type McpRequestCountKind = 'all' | 'traffic' | 'errors';

const REQUEST_COUNT_SQL: Record<McpRequestCountKind, string> = {
  all: "SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'",
  traffic: "SELECT count(*)::int as count FROM mcp_request_log WHERE operation != 'surface_change' AND created_at > now() - interval '24 hours'",
  errors: "SELECT count(*)::int as count FROM mcp_request_log WHERE status NOT IN ('success', 'success_with_warnings', 'accepted_pending') AND operation != 'surface_change' AND created_at > now() - interval '24 hours'",
};

/**
 * The admin dashboard's request counts over the last 24 hours (`/admin/api/stats`, `/admin/api/health-indicators`): `all`
 * counts every row, `traffic` leaves out the surface audit rows (operator actions, not traffic), `errors` is the traffic
 * whose status is not a success or an admitted pending write.
 */
export async function countMcpRequestsLastDay(exec: LegacyUnscopedRead, kind: McpRequestCountKind): Promise<number> {
  const rows = await exec.executeRaw<{ count: number | string }>(REQUEST_COUNT_SQL[kind]);
  return Number(rows[0]?.count ?? 0);
}

/**
 * The pending-write health of `/admin/api/health-indicators` (#5249), byte for byte as the SqlQuery tag in
 * serve-http-admin-api.ts sent it at 982540fd6e: the writes still in flight with the age of the oldest, and the writes
 * reported as pending in the last 24 hours that later ended without committing.
 */
export const PENDING_WRITE_HEALTH_SQL = {
  pending: `SELECT count(*)::int AS count,
    COALESCE(floor(extract(epoch FROM now() - min(created_at))), 0)::int AS oldest_age_seconds
    FROM persistence_requests WHERE state IN ('queued', 'deferred', 'running', 'recovering')`,
  later_failed: `SELECT count(DISTINCT r.id)::int AS count FROM mcp_request_log l
    JOIN persistence_requests r ON r.request_id::text = l.params->>'write_request_id'
    WHERE l.status = 'accepted_pending' AND l.created_at > now() - interval '24 hours'
      AND r.state IN ('conflict', 'failed', 'cancelled')`,
} as const;

/** How many writes are in flight, how old the oldest is in whole seconds (0 with none), and how many pending writes of the last day later failed. */
export interface PendingWriteHealth {
  pending_writes: number;
  oldest_pending_write_age_seconds: number;
  pending_writes_later_failed: number;
}

/** The admin dashboard's pending-write health; reads `persistence_requests` and the request log of the last 24 hours. */
export async function readPendingWriteHealth(exec: LegacyUnscopedRead): Promise<PendingWriteHealth> {
  const [pending] = await exec.executeRaw<{ count: number | string; oldest_age_seconds: number | string }>(PENDING_WRITE_HEALTH_SQL.pending);
  const [laterFailed] = await exec.executeRaw<{ count: number | string }>(PENDING_WRITE_HEALTH_SQL.later_failed);
  return {
    pending_writes: Number(pending?.count ?? 0),
    oldest_pending_write_age_seconds: Number(pending?.oldest_age_seconds ?? 0),
    pending_writes_later_failed: Number(laterFailed?.count ?? 0),
  };
}

/** The filters and the page of `/admin/api/requests`; a null or absent filter reads every row. */
export interface McpRequestLogPageSpec {
  tokenName?: string | null;
  operation?: string | null;
  status?: string | null;
  limit: number;
  offset: number;
}

/** One request log row as the admin request list shows it; `agent_name` falls back to the token name. */
export interface McpRequestLogPageRow {
  id: number;
  token_name: string | null;
  agent_name: string | null;
  operation: string;
  latency_ms: number | null;
  status: string;
  params: unknown;
  error_message: string | null;
  created_at: Date;
}

/** One page of the request log, newest first, and how many rows the filters match. */
export interface McpRequestLogPage { rows: McpRequestLogPageRow[]; total: number }

/**
 * The request list of `/admin/api/requests`, byte for byte as serve-http-admin-api.ts built it at 0b8fde313c (newest first, the highest id first on a tie): each
 * filter present adds `AND <column> = $N` in the order token, operation, status, then the page's LIMIT and OFFSET.
 */
export function mcpRequestLogPageSql(spec: McpRequestLogPageSpec): { list: string; count: string; params: string[] } {
  const filters: SqlFragment[] = [];
  if (spec.tokenName != null) filters.push(sqlFragment`AND token_name = ${spec.tokenName}`);
  if (spec.operation != null) filters.push(sqlFragment`AND operation = ${spec.operation}`);
  if (spec.status != null) filters.push(sqlFragment`AND status = ${spec.status}`);
  const filterSql = joinFragments(filters, ' ');
  // The page's LIMIT and OFFSET values are bound by the caller after the filter values; sentinels keep their slots.
  const list = renderFragment(sqlFragment`SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
                operation, latency_ms, status, params, error_message, created_at
         FROM mcp_request_log
         WHERE 1=1 ${filterSql}
         ORDER BY created_at DESC, id DESC LIMIT ${0} OFFSET ${0}`);
  const count = renderFragment(sqlFragment`SELECT count(*)::int as total FROM mcp_request_log
         WHERE 1=1 ${filterSql}`);
  return { list: list.text, count: count.text, params: count.params as string[] };
}

/** One page of the request log for the admin request list (newest first) and the filtered total. */
export async function readMcpRequestLogPage(exec: LegacyUnscopedRead, spec: McpRequestLogPageSpec): Promise<McpRequestLogPage> {
  const { list, count, params } = mcpRequestLogPageSql(spec);
  const rows = await exec.executeRaw<Omit<McpRequestLogPageRow, 'id' | 'created_at'> & { id: number | string; created_at: Date | string }>(
    list, [...params, spec.limit, spec.offset]);
  const [total] = await exec.executeRaw<{ total: number | string }>(count, params);
  return {
    rows: rows.map(r => ({
      id: Number(r.id), token_name: r.token_name, agent_name: r.agent_name, operation: r.operation,
      latency_ms: r.latency_ms == null ? null : Number(r.latency_ms), status: r.status, params: r.params ?? null,
      error_message: r.error_message ?? null, created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    })),
    total: Number(total?.total ?? 0),
  };
}

/** One asked token's request count of the last 24 hours. */
export interface McpTokenRequestCount {
  token_name: string;
  requests: number;
}

const REQUESTS_BY_TOKEN_SQL = `SELECT token_name, count(*)::int AS requests FROM mcp_request_log
    WHERE token_name = ANY($1::text[]) AND created_at > now() - interval '24 hours' GROUP BY token_name ORDER BY token_name COLLATE "C"`;

/** Requests of the last 24 hours per asked token (the agents list's "requests today"); a token with none has no row. */
export async function countMcpRequestsLastDayByToken(exec: LegacyUnscopedRead, tokenNames: readonly string[]): Promise<McpTokenRequestCount[]> {
  const rows = await exec.executeRaw<{ token_name: string; requests: number | string }>(REQUESTS_BY_TOKEN_SQL, [[...tokenNames]]);
  return rows.map(r => ({ token_name: r.token_name, requests: Number(r.requests) }));
}
