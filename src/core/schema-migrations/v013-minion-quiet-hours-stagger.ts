import type { Migration } from './types.ts';

export const v013: Migration = {
  version: 13,
  name: 'minion_quiet_hours_stagger',
  // Adds quiet-hours gating + deterministic stagger to Minions.
  sql: `
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS quiet_hours JSONB;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS stagger_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_stagger_key
        ON minion_jobs(stagger_key) WHERE stagger_key IS NOT NULL;
    `,
};
