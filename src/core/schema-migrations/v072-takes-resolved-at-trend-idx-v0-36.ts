import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v072: Migration = {
  version: 72,
  name: 'takes_resolved_at_trend_idx_v0_36',
  // v0.36.1.0 — F10 perf finding. Brier-trend aggregation queries
  // (90-day windowed scorecard) hit takes WHERE resolved_at IS NOT NULL.
  // Without this partial index, large takes tables do full scans even
  // when the resolved subset is small.
  //
  // Partial index because most takes are unresolved on fresh brains;
  // resolution is the sparse dimension. Engine-aware via handler since
  // Postgres benefits from CONCURRENTLY on large tables.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 71, 'takes_resolved_at_idx');
      await engine.runMigration(
        71,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS takes_resolved_at_idx
             ON takes (resolved_at DESC)
             WHERE resolved_at IS NOT NULL;`
      );
    } else {
      await engine.runMigration(
        71,
        `CREATE INDEX IF NOT EXISTS takes_resolved_at_idx
             ON takes (resolved_at DESC)
             WHERE resolved_at IS NOT NULL;`
      );
    }
  },
  transaction: false,
};
