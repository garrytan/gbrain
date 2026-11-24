/**
 * Telemetry members (BrainEngine recordSearchTelemetry, readSearchStats, logMcpRequest, readMcpLogPruneCutoff,
 * pruneMcpRequestLogBatch, readClientOpUsage, readMcpRollupPrunedBefore, readMcpLifetimeUsage, readMcpRequestLogPage, logChatUsage,
 * readChatUsage). The store
 * keeps the `search_telemetry` rows, the MCP request log and its tally, and the chat usage ledger (rust/docs/store/telemetry.md). The store answers a timestamp as ISO text;
 * these members turn it into a Date, as PGLite's driver reads a `timestamptz`.
 */
import type {
  McpLifetimeUsageRow, McpRequestCountKind, McpTokenRequestCount, McpLogPruneBatch, McpLogPruneCutoff, McpOpUsageRow, McpRequestLogPage, McpRequestLogPageSpec, McpRequestLogRow, McpRollupPrunedBefore,
  SearchTelemetryBucket,
  SearchTelemetryRow, PendingWriteHealth,
} from '../../engine-sql/telemetry.ts';
import type { ChatUsageAggregateRow, ChatUsageLogRow, ChatUsageWindow } from '../../engine-sql/chat-usage.ts';
import { storeCall, type StoreMember } from './common.ts';

type StoreRow = Record<string, unknown>;

const toDate = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(String(value)));

/** Adds one bucket to its `(date, mode, intent)` row, or inserts it. */
export const recordSearchTelemetry: StoreMember<[bucket: SearchTelemetryBucket], void> = async (brain, bucket) => {
  await storeCall({ member: 'recordSearchTelemetry' }, () => brain.recordSearchTelemetry(bucket));
};

/** The sums per `(mode, intent)` of the rows dated on or after `cutoffDate`; timestamps stay text, as on PGLite. */
export const readSearchStats: StoreMember<[cutoffDate: string], SearchTelemetryRow[]> = (brain, cutoffDate) =>
  storeCall({ member: 'readSearchStats' }, () => brain.readSearchStats(cutoffDate ?? null));

/** Appends one request log row; `created_at` crosses as ISO text (a Date) or the caller's text. */
export const logMcpRequest: StoreMember<[row: McpRequestLogRow], void> = async (brain, row) => {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null;
  await storeCall({ member: 'logMcpRequest' }, () => brain.logMcpRequest({ ...row, created_at: created }));
};

/** The tally table's presence (always, in the store) and the cutoff `now - days`. */
export const readMcpLogPruneCutoff: StoreMember<[days: number], McpLogPruneCutoff> = async (brain, days) => {
  const row: StoreRow = await storeCall({ member: 'readMcpLogPruneCutoff' }, () => brain.readMcpLogPruneCutoff(days ?? null));
  return { rollup_present: row.rollup_present === true, cutoff: toDate(row.cutoff) };
};

/** One retention batch: deletes the oldest rows before the cutoff and adds them to the tally. */
export const pruneMcpRequestLogBatch: StoreMember<[cutoff: string, keepOperations: readonly string[], limit: number], McpLogPruneBatch> =
  async (brain, cutoff, keepOperations, limit) => {
    const row: StoreRow = await storeCall({ member: 'pruneMcpRequestLogBatch' },
      () => brain.pruneMcpRequestLogBatch(cutoff ?? null, keepOperations === null || keepOperations === undefined ? null : [...keepOperations], limit ?? null));
    return { deleted: Number(row.deleted), newest: toDate(row.newest) };
  };

/** Successful requests of the trailing `days` per token and operation; `last_seen` is a Date. */
export const readClientOpUsage: StoreMember<[days: number], McpOpUsageRow[]> = async (brain, days) => {
  const rows: McpOpUsageRow[] = await storeCall({ member: 'readClientOpUsage' }, () => brain.readClientOpUsage(days ?? null));
  return rows.map((r) => ({ ...r, last_seen: toDate(r.last_seen) }));
};

/** The newest pruned request time (null when nothing was pruned) and the store clock, as Dates. */
export const readMcpRollupPrunedBefore: StoreMember<[], McpRollupPrunedBefore> = async (brain) => {
  const row: StoreRow = await storeCall({ member: 'readMcpRollupPrunedBefore' }, () => brain.readMcpRollupPrunedBefore());
  return { pruned_before: toDate(row.pruned_before), now: toDate(row.now) };
};

/** Kept requests plus the pruned tally per asked token, in token byte order; `last_used_at` is a Date. */
export const readMcpLifetimeUsage: StoreMember<[tokenNames: readonly string[]], McpLifetimeUsageRow[]> = async (brain, tokenNames) => {
  const rows: StoreRow[] = await storeCall({ member: 'readMcpLifetimeUsage' },
    () => brain.readMcpLifetimeUsage(tokenNames === null || tokenNames === undefined ? null : [...tokenNames]));
  return rows.map((r) => ({ token_name: String(r.token_name), requests: Number(r.requests), last_used_at: toDate(r.last_used_at) }));
};

/** Appends one chat usage ledger row; `created_at` crosses as ISO text (a Date) or the caller's text, null for now. */
export const logChatUsage: StoreMember<[row: ChatUsageLogRow], void> = async (brain, row) => {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null;
  await storeCall({ member: 'logChatUsage' }, () => brain.logChatUsage({ ...row, created_at: created }));
};

/** The ledger sums per `(model, phase)` over the last `days` in cost order, and the first logged time as timestamp text. */
export const readChatUsage: StoreMember<[days: number], ChatUsageWindow> = async (brain, days) => {
  const out: { rows: StoreRow[]; logged_since: string | null } =
    await storeCall({ member: 'readChatUsage' }, () => brain.readChatUsage(days ?? null));
  const rows: ChatUsageAggregateRow[] = out.rows.map((r) => ({
    model: String(r.model), phase: r.phase === null || r.phase === undefined ? null : String(r.phase),
    calls: Number(r.calls), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
    cache_read_tokens: Number(r.cache_read_tokens), cache_write_tokens: Number(r.cache_write_tokens),
    cost_usd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd), unpriced_calls: Number(r.unpriced_calls),
  }));
  return { rows, logged_since: out.logged_since ?? null };
};

/** Request log rows of the last 24 hours: all, the traffic (no surface audit rows) or the failed traffic. */
export const countMcpRequestsLastDay: StoreMember<[kind: McpRequestCountKind], number> = async (brain, kind) =>
  Number(await storeCall({ member: 'countMcpRequestsLastDay' }, () => brain.countMcpRequestsLastDay(kind)));

/** One page of the request log, newest first, and the filtered total (the admin request list). */
export const readMcpRequestLogPage: StoreMember<[spec: McpRequestLogPageSpec], McpRequestLogPage> = async (brain, spec) => {
  const out = await storeCall({ member: 'readMcpRequestLogPage' }, () => brain.readMcpRequestLogPage({
    tokenName: spec.tokenName ?? null, operation: spec.operation ?? null, status: spec.status ?? null, limit: spec.limit, offset: spec.offset,
  })) as { rows: StoreRow[]; total: unknown };
  return {
    rows: out.rows.map(r => ({
      id: Number(r.id), token_name: (r.token_name ?? null) as string | null, agent_name: (r.agent_name ?? null) as string | null,
      operation: String(r.operation), latency_ms: r.latency_ms == null ? null : Number(r.latency_ms), status: String(r.status),
      params: r.params ?? null, error_message: (r.error_message ?? null) as string | null, created_at: toDate(r.created_at) as Date,
    })),
    total: Number(out.total),
  };
};

/** In-flight writes, the oldest one's age, and the pending writes of the last day that later failed. */
export const readPendingWriteHealth: StoreMember<[], PendingWriteHealth> = async (brain) => {
  const out = await storeCall({ member: 'readPendingWriteHealth' }, () => brain.readPendingWriteHealth()) as Record<string, unknown>;
  return {
    pending_writes: Number(out.pending_writes), oldest_pending_write_age_seconds: Number(out.oldest_pending_write_age_seconds),
    pending_writes_later_failed: Number(out.pending_writes_later_failed),
  };
};

/** Requests of the last 24 hours per asked token, in token byte order; a token with none has no row. */
export const countMcpRequestsLastDayByToken: StoreMember<[tokenNames: readonly string[]], McpTokenRequestCount[]> = async (brain, tokenNames) =>
  await storeCall({ member: 'countMcpRequestsLastDayByToken' }, () => brain.countMcpRequestsLastDayByToken([...tokenNames])) as McpTokenRequestCount[];
