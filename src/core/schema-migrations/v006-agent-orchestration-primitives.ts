import type { Migration } from './types.ts';

export const v006: Migration = {
  version: 6,
  name: 'agent_orchestration_primitives',
  sql: `
      -- Token accounting columns
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER NOT NULL DEFAULT 0;

      -- Update status constraint to include 'paused'
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_status;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_status
        CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused'));

      -- Inbox table (separate from job row for clean concurrency)
      CREATE TABLE IF NOT EXISTS minion_inbox (
        id          SERIAL PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
        sender      TEXT NOT NULL,
        payload     JSONB NOT NULL,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread ON minion_inbox (job_id) WHERE read_at IS NULL;
    `,
};
