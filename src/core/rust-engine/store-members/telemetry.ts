/**
 * Search telemetry members (BrainEngine recordSearchTelemetry, readSearchStats). The store keeps the
 * `search_telemetry` rows (rust/docs/store/telemetry.md). The MCP usage reads (readClientOpUsage,
 * readMcpRollupPrunedBefore) are not served: no typed member writes the MCP request log yet, so they refuse as
 * master's executeRaw did.
 */
import type { SearchTelemetryBucket, SearchTelemetryRow } from '../../engine-sql/telemetry.ts';
import { storeCall, type StoreMember } from './common.ts';

/** Adds one bucket to its `(date, mode, intent)` row, or inserts it. */
export const recordSearchTelemetry: StoreMember<[bucket: SearchTelemetryBucket], void> = async (brain, bucket) => {
  await storeCall({ member: 'recordSearchTelemetry' }, () => brain.recordSearchTelemetry(bucket));
};

/** The sums per `(mode, intent)` of the rows dated on or after `cutoffDate`; timestamps stay text, as on PGLite. */
export const readSearchStats: StoreMember<[cutoffDate: string], SearchTelemetryRow[]> = (brain, cutoffDate) =>
  storeCall({ member: 'readSearchStats' }, () => brain.readSearchStats(cutoffDate ?? null));
