/**
 * Schema pieces of the open-loop store that a migration and the store share
 * (leaf module: no engine import). `open_loops.counterparty_source_id`
 * (#5504, wave 14 P4.1) records which source the counterparty page the loop
 * resolved to lives in; NULL on rows written before it existed, which readers
 * treat as the loop's own source (the posture those rows were written under).
 */
export const OPEN_LOOPS_COUNTERPARTY_SOURCE_COLUMN_SQL =
  'ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS counterparty_source_id TEXT';

export const OPEN_LOOPS_COUNTERPARTY_SOURCE_INDEX = {
  name: 'open_loops_counterparty_source_idx',
  table: 'open_loops',
  sql: `CREATE INDEX IF NOT EXISTS open_loops_counterparty_source_idx
  ON open_loops (counterparty_source_id, counterparty_slug) WHERE status = 'open' AND counterparty_source_id IS NOT NULL`,
} as const;
