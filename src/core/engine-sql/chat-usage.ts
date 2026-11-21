/**
 * Chat usage ledger statements: the engine sink's insert (`ai/chat-usage.ts` makeEngineChatUsageSink) and the
 * `get_usage` window read (`ops/usage.ts`), which ran through `engine.executeRaw`, once for both engines.
 *
 * `chat_usage_log` carries no source and no read policy, so the read runs unscoped, as on master. Each value is a bound
 * parameter. The callers keep their error handling: the sink stays fail-open, and get_usage still lets a capability
 * refusal through and reports any other error as a missing table.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/**
 * One `chat_usage_log` row. `created_at` defaults to the database clock; the sink never sets it (parity fixtures age a
 * row with it).
 */
export interface ChatUsageLogRow {
  model: string;
  provider: string | null;
  phase: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  created_at?: Date | string | null;
}

/**
 * The sums of one `(model, phase)` over the read window. `cost_usd` sums the priced calls and is null when every call
 * of the group is unpriced; `unpriced_calls` counts the calls with no price.
 */
export interface ChatUsageAggregateRow {
  model: string;
  phase: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  unpriced_calls: number;
}

/** The window sums and the first logged time of the whole ledger (timestamp text, null on an empty ledger). */
export interface ChatUsageWindow { rows: ChatUsageAggregateRow[]; logged_since: string | null }

const LOG_CHAT_USAGE_SQL = `INSERT INTO chat_usage_log
         (model, provider, phase, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`;

/** Appends one row to the chat usage ledger (the engine chat usage sink). */
export async function logChatUsage(exec: SqlExecutor, r: ChatUsageLogRow): Promise<void> {
  await exec.executeRaw(LOG_CHAT_USAGE_SQL, [
    r.model, r.provider, r.phase, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd,
    r.created_at ?? null,
  ]);
}

const READ_CHAT_USAGE_SQL = `SELECT chat_usage_log.model,
                chat_usage_log.phase,
                count(*)::int                                                 AS calls,
                sum(chat_usage_log.input_tokens)::float8                      AS input_tokens,
                sum(chat_usage_log.output_tokens)::float8                     AS output_tokens,
                sum(chat_usage_log.cache_read_tokens)::float8                 AS cache_read_tokens,
                sum(chat_usage_log.cache_write_tokens)::float8                AS cache_write_tokens,
                sum(chat_usage_log.cost_usd)::float8                          AS cost_usd,
                count(*) FILTER (WHERE chat_usage_log.cost_usd IS NULL)::int  AS unpriced_calls
         FROM chat_usage_log
         WHERE chat_usage_log.created_at >= now() - make_interval(days => $1)
         GROUP BY chat_usage_log.model, chat_usage_log.phase
         ORDER BY sum(chat_usage_log.cost_usd) DESC NULLS LAST,
                  chat_usage_log.model COLLATE "C",
                  chat_usage_log.phase COLLATE "C" NULLS FIRST`;

const num = (v: unknown): number => Number(v ?? 0);

/**
 * The sums per `(model, phase)` of the rows logged in the trailing `days` (`get_usage`), highest priced cost first,
 * unpriced groups last; equal costs break on model, then phase, in byte order with a null phase first (master's
 * statement had no tie order). `logged_since` is the first logged time of the whole ledger, not of the window.
 */
export async function readChatUsage(exec: LegacyUnscopedRead, days: number): Promise<ChatUsageWindow> {
  const rows = await exec.executeRaw<Record<string, unknown>>(READ_CHAT_USAGE_SQL, [days]);
  const [since] = await exec.executeRaw<{ since: string | null }>('SELECT min(created_at)::text AS since FROM chat_usage_log');
  return {
    rows: rows.map((r) => ({
      model: String(r.model),
      phase: (r.phase as string | null) ?? null,
      calls: num(r.calls),
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cache_read_tokens: num(r.cache_read_tokens),
      cache_write_tokens: num(r.cache_write_tokens),
      cost_usd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
      unpriced_calls: num(r.unpriced_calls),
    })),
    logged_since: since?.since ?? null,
  };
}
