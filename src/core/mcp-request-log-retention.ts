/**
 * Request-log retention (#6770 rewrite; proposed by @lubosxyz): the opt-in
 * prune of `mcp_request_log` rows older than
 * `cycle.purge.mcp_request_log_retention_days` (unset, 0 or off = off; never
 * fewer than 30 days, so every built-in 30-day usage window stays complete).
 *
 * Each batch is ONE statement: pick the oldest rows past the cutoff (index
 * order on created_at, FOR UPDATE SKIP LOCKED so two prunes never take the
 * same row), delete them, and add them to the per-token tally
 * `mcp_request_log_rollup` (count, newest time, pruned_through). A failed
 * tally rolls its delete back, so lifetime totals (kept rows plus the tally)
 * stay exact. Audit rows (AUDIT_LOG_OPERATIONS) are never pruned. A NULL
 * token_name counts under ''. The cutoff is fixed once per run.
 *
 * It runs in two places: the cycle purge phase (Postgres, and PGLite with no
 * live serve), and a resident hourly ticker in the process that holds a PGLite
 * brain's lock (`gbrain serve` and `gbrain serve --http`), under a small
 * wall-clock budget that yields between batches so live MCP traffic keeps the
 * single connection. Each run records its time, count and cap state
 * (`cycle.purge.mcp_request_log_last_prune`) for doctor's
 * `mcp_request_log_retention` check.
 *
 * Operational data only: it never touches git or page content, and a
 * repo-less brain behaves the same. Deletion caps growth; it does not shrink
 * a PGLite file that already grew (that needs VACUUM FULL).
 */
import type { BrainEngine } from './engine.ts';
import { AUDIT_LOG_OPERATIONS } from './mcp-usage.ts';

export const MCP_LOG_RETENTION_KEY = 'cycle.purge.mcp_request_log_retention_days';
export const MCP_LOG_LAST_PRUNE_KEY = 'cycle.purge.mcp_request_log_last_prune';
export const MIN_MCP_LOG_RETENTION_DAYS = 30;
export const MAX_MCP_LOG_RETENTION_DAYS = 3650;
export const MCP_LOG_PRUNE_BATCH = 2_000;
/** 200 batches of 2,000: at most 400,000 rows per run; the next run continues. */
export const MCP_LOG_PRUNE_MAX_BATCHES = 200;
export const MCP_LOG_PRUNE_TICK_MS = 60 * 60_000;
export const MCP_LOG_PRUNE_RESIDENT_BUDGET_MS = 3_000;

const OFF_VALUES = new Set(['', '0', 'off']);

/** Days in effect, or null when retention is off (unset, 0, off, or an unreadable value). */
export function parseMcpLogRetentionDays(raw: string | null | undefined): number | null {
  const text = raw?.trim().toLowerCase() ?? '';
  if (OFF_VALUES.has(text)) return null;
  const days = Number(text);
  return Number.isInteger(days) && days >= MIN_MCP_LOG_RETENTION_DAYS && days <= MAX_MCP_LOG_RETENTION_DAYS ? days : null;
}

/** `config set` refusal text, or null when the value is valid. */
export function mcpLogRetentionRefusal(value: string): string | null {
  if (OFF_VALUES.has(value.trim().toLowerCase()) || parseMcpLogRetentionDays(value) !== null) return null;
  return `${MCP_LOG_RETENTION_KEY} must be a whole number of days from ${MIN_MCP_LOG_RETENTION_DAYS} to ${MAX_MCP_LOG_RETENTION_DAYS} ` +
    `(or 0 / off for no retention); nothing was written. Example: gbrain config set ${MCP_LOG_RETENTION_KEY} 90`;
}

/** Retention in effect; a config read failure reads as off. */
export async function readMcpLogRetentionDays(engine: BrainEngine): Promise<number | null> {
  try { return parseMcpLogRetentionDays(await engine.getConfig(MCP_LOG_RETENTION_KEY)); } catch { return null; }
}

export interface McpLogPruneResult {
  deleted: number;
  /** True when the run stopped at its batch cap or wall-clock budget with rows still past the cutoff. */
  capped: boolean;
  skipped: 'no_rollup_table' | null;
  /** ISO time of the newest row this run pruned (null when it pruned nothing). */
  pruned_through: string | null;
}

export interface McpLogPruneOpts {
  batchSize?: number;
  maxBatches?: number;
  /** Stop after this much wall-clock time (the resident ticker); the cycle runs to the batch cap. */
  budgetMs?: number;
  /** Yield to the event loop between batches (the resident ticker shares PGLite's one connection). */
  yieldBetweenBatches?: boolean;
}

async function rollupTablePresent(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('mcp_request_log_rollup') IS NOT NULL AS present");
  return row?.present === true;
}

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

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

/** Prune rows older than `days` in bounded batches. Throws on a database error (each batch's statement rolls back whole). */
export async function pruneMcpRequestLog(engine: BrainEngine, days: number, opts: McpLogPruneOpts = {}): Promise<McpLogPruneResult> {
  if (!(await rollupTablePresent(engine))) {
    console.warn('[mcp-request-log] retention is on but mcp_request_log_rollup does not exist yet (run gbrain apply-migrations); nothing was pruned');
    return { deleted: 0, capped: false, skipped: 'no_rollup_table', pruned_through: null };
  }
  const batchSize = opts.batchSize ?? MCP_LOG_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? MCP_LOG_PRUNE_MAX_BATCHES;
  const started = Date.now();
  const [{ cutoff }] = await engine.executeRaw<{ cutoff: unknown }>("SELECT now() - ($1::int * interval '1 day') AS cutoff", [days]);
  const cutoffIso = iso(cutoff);
  const audit = [...AUDIT_LOG_OPERATIONS];
  let deleted = 0;
  let newest: string | null = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    const [row] = await engine.executeRaw<{ deleted: number; newest: unknown }>(PRUNE_BATCH_SQL, [cutoffIso, audit, batchSize]);
    const n = Number(row?.deleted ?? 0);
    deleted += n;
    const batchNewest = n > 0 && row?.newest ? iso(row.newest) : null;
    if (batchNewest !== null && (newest === null || batchNewest > newest)) newest = batchNewest;
    if (n < batchSize) return { deleted, capped: false, skipped: null, pruned_through: newest };
    if (opts.budgetMs !== undefined && Date.now() - started >= opts.budgetMs) break;
    if (opts.yieldBetweenBatches) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { deleted, capped: true, skipped: null, pruned_through: newest };
}

export interface McpLogLastPrune { at: string; deleted: number; capped: boolean }

/** The last recorded run, or null (never ran, or an unreadable record). */
export async function readLastMcpLogPrune(engine: BrainEngine): Promise<McpLogLastPrune | null> {
  try {
    const parsed = JSON.parse((await engine.getConfig(MCP_LOG_LAST_PRUNE_KEY)) ?? 'null') as Partial<McpLogLastPrune> | null;
    if (!parsed || typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
    return { at: parsed.at, deleted: Number(parsed.deleted) || 0, capped: parsed.capped === true };
  } catch { return null; }
}

/** One retention run: null when retention is off; records the run for doctor. Throws on a database error. */
export async function runMcpLogRetention(engine: BrainEngine, opts: McpLogPruneOpts = {}): Promise<McpLogPruneResult | null> {
  const days = await readMcpLogRetentionDays(engine);
  if (days === null) return null;
  const result = await pruneMcpRequestLog(engine, days, opts);
  if (!result.skipped) {
    await engine.setConfig(MCP_LOG_LAST_PRUNE_KEY, JSON.stringify({ at: new Date().toISOString(), deleted: result.deleted, capped: result.capped }));
  }
  return result;
}

/**
 * Lifetime requests and last use per token: the rows still in the log plus
 * the pruned tally, in one statement. Before the tally table exists, the log
 * alone (nothing was pruned).
 */
export async function lifetimeUsage(engine: BrainEngine, tokenNames: string[]): Promise<Map<string, { requests: number; last_used_at: string | null }>> {
  if (tokenNames.length === 0) return new Map();
  const kept = `SELECT token_name, count(*)::bigint AS n, max(created_at) AS newest FROM mcp_request_log WHERE token_name = ANY($1::text[]) GROUP BY token_name`;
  const rows = await engine.executeRaw<{ token_name: string; requests: string | number; last_used_at: unknown }>(
    (await rollupTablePresent(engine))
      ? `SELECT token_name, sum(n)::bigint AS requests, max(newest) AS last_used_at FROM (
           ${kept}
           UNION ALL
           SELECT token_name, requests, last_used_at FROM mcp_request_log_rollup WHERE token_name = ANY($1::text[])
         ) u GROUP BY token_name`
      : `SELECT token_name, n AS requests, newest AS last_used_at FROM (${kept}) k`,
    [tokenNames],
  );
  return new Map(rows.map((r) => [r.token_name, { requests: Number(r.requests), last_used_at: r.last_used_at ? iso(r.last_used_at) : null }]));
}

export interface McpLogPruneTickerOpts {
  tickMs?: number;
  budgetMs?: number;
  /** Owner veto for this tick (a delegated sync owns the event loop). */
  canRun?: () => boolean | Promise<boolean>;
  setInterval?: (fn: () => unknown, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface McpLogPruneTicker {
  tick(): Promise<McpLogPruneResult | null>;
  stop(): void;
}

/**
 * The lock owner's resident prune: PGLite only (Postgres brains prune in the
 * cycle purge phase). One run in flight at a time; its own unref'd timer.
 */
export function startMcpLogPruneTicker(engine: BrainEngine, opts: McpLogPruneTickerOpts = {}): McpLogPruneTicker {
  let inflight: Promise<McpLogPruneResult | null> | null = null;
  let stopped = false;
  const tick = async (): Promise<McpLogPruneResult | null> => {
    if (stopped || inflight || engine.kind !== 'pglite') return null;
    try { if (opts.canRun && !(await opts.canRun())) return null; } catch { return null; }
    inflight = runMcpLogRetention(engine, { budgetMs: opts.budgetMs ?? MCP_LOG_PRUNE_RESIDENT_BUDGET_MS, yieldBetweenBatches: true })
      .then((result) => {
        if (result && result.deleted > 0) opts.log?.(`[mcp-request-log] pruned ${result.deleted} request-log row(s) past retention${result.capped ? ' (more remain; the next tick continues)' : ''}`);
        return result;
      })
      .catch((e: unknown) => { opts.log?.(`[mcp-request-log] prune failed: ${e instanceof Error ? e.message : String(e)}`); return null; })
      .finally(() => { inflight = null; });
    return inflight;
  };
  const set = opts.setInterval ?? ((fn: () => unknown, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = engine.kind === 'pglite' ? set(() => tick(), opts.tickMs ?? MCP_LOG_PRUNE_TICK_MS) : null;
  (handle as { unref?: () => void } | null)?.unref?.();
  return { tick, stop: () => { stopped = true; if (handle !== null) clear(handle); } };
}
