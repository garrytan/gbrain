/**
 * Telemetry members (BrainEngine recordSearchTelemetry, readSearchStats, logMcpRequest, readMcpLogPruneCutoff,
 * pruneMcpRequestLogBatch, readClientOpUsage, readMcpRollupPrunedBefore). The store keeps the `search_telemetry`
 * rows, the MCP request log and its tally (rust/docs/store/telemetry.md). The store answers a timestamp as ISO text;
 * these members turn it into a Date, as PGLite's driver reads a `timestamptz`.
 */
import type {
  McpLogPruneBatch, McpLogPruneCutoff, McpOpUsageRow, McpRequestLogRow, McpRollupPrunedBefore, SearchTelemetryBucket,
  SearchTelemetryRow,
} from '../../engine-sql/telemetry.ts';
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
