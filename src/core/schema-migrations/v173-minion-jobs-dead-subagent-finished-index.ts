import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v173: Migration = {
  // Paid-loop breaker (dream-breaker.ts) and its doctor check count dead
  // subagent submissions by finish time over the last 24 h.
  version: 173, name: 'minion_jobs_dead_subagent_finished_index', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 173, 'idx_minion_jobs_dead_subagent_finished');
    await engine.runMigration(173, `CREATE INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF NOT EXISTS idx_minion_jobs_dead_subagent_finished
        ON minion_jobs (finished_at) WHERE name = 'subagent' AND status = 'dead'`);
  },
};
