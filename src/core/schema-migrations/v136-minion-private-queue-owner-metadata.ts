import type { Migration } from './types.ts';

export const v136: Migration = {
  version: 136,
  name: 'minion_private_queue_owner_metadata',
  // issue #4332: durable ownership/liveness metadata for parent-owned
  // dream-inline queues. Startup recovery uses these columns to cancel only
  // orphaned private queues (terminal/missing owner or expired lease), never
  // live queues and never legacy unowned rows.
  idempotent: true,
  sql: `
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_token TEXT;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_lease_until TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_recovery
        ON minion_jobs (queue, private_queue_lease_until)
        WHERE queue LIKE 'dream-inline-%'
          AND status IN ('waiting','active','delayed','waiting-children','paused');
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_owner
        ON minion_jobs (private_queue_owner_job_id)
        WHERE private_queue_owner_job_id IS NOT NULL;
    `,
};
