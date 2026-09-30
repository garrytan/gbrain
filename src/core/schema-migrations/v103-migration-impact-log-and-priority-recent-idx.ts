import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v103: Migration = {
  version: 103,
  name: 'migration_impact_log_and_priority_recent_idx',
  // v0.41.18.0 (gbrain onboard wave, A6 + A25 + A13 + codex #9 + #10):
  // (1) migration_impact_log table — onboard --history backbone with
  //     attribution columns (job_id, source_id, brain_id, started_at,
  //     idempotency_key) so concurrent runs don't misattribute deltas.
  // (2) content_chunks_stale_idx partial index — supports
  //     `embed --stale` + `--priority recent` (outer ORDER BY
  //     p.updated_at DESC uses existing idx_pages_updated_at_desc).
  //
  // Slot history: originally v100, bumped to v103 after master merge.
  // Engine-aware split: Postgres uses CREATE INDEX CONCURRENTLY +
  // invalid-remnant pre-drop; PGLite uses plain CREATE INDEX.
  transaction: false,
  sql: '',
  handler: async (engine) => {
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS migration_impact_log (
          id BIGSERIAL PRIMARY KEY,
          remediation_id TEXT NOT NULL,
          metric_name TEXT NOT NULL,
          metric_before NUMERIC,
          metric_after NUMERIC,
          job_id BIGINT REFERENCES minion_jobs(id) ON DELETE SET NULL,
          source_id TEXT,
          brain_id TEXT,
          started_at TIMESTAMPTZ,
          idempotency_key TEXT,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          applied_by TEXT,
          details JSONB DEFAULT '{}'::jsonb
        );
      `;
    await engine.runMigration(103, createTableSql);
    await engine.runMigration(
      103,
      `CREATE INDEX IF NOT EXISTS migration_impact_log_remediation_idx
           ON migration_impact_log(remediation_id, applied_at DESC);`
    );
    await engine.runMigration(
      103,
      `CREATE INDEX IF NOT EXISTS migration_impact_log_attribution_idx
           ON migration_impact_log(job_id, source_id) WHERE job_id IS NOT NULL;`
    );

    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 103, 'content_chunks_stale_idx');
      await engine.runMigration(
        103,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS content_chunks_stale_idx
             ON content_chunks (page_id, chunk_index)
             WHERE embedding IS NULL;`
      );
    } else {
      await engine.runMigration(
        103,
        `CREATE INDEX IF NOT EXISTS content_chunks_stale_idx
             ON content_chunks (page_id, chunk_index)
             WHERE embedding IS NULL;`
      );
    }
  },
};
