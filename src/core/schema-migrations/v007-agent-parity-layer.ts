import type { Migration } from './types.ts';

export const v007: Migration = {
  version: 7,
  name: 'agent_parity_layer',
  sql: `
      -- Subagent primitives + BullMQ parity columns
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS max_children INTEGER;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS remove_on_complete BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS remove_on_fail BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

      -- Tighten constraints (drop-then-add for idempotency)
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_depth_nonnegative;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_depth_nonnegative CHECK (depth >= 0);
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_max_children_positive;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_max_children_positive CHECK (max_children IS NULL OR max_children > 0);
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_timeout_positive;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_timeout_positive CHECK (timeout_ms IS NULL OR timeout_ms > 0);

      -- Bounded scan for handleTimeouts
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at)
        WHERE status = 'active' AND timeout_at IS NOT NULL;

      -- O(children) child-count check in add()
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status)
        WHERE parent_job_id IS NOT NULL;

      -- Idempotency: enforce "only one job per key" at the DB layer
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      -- Fast lookup of child_done messages for readChildCompletions
      CREATE INDEX IF NOT EXISTS idx_minion_inbox_child_done ON minion_inbox (job_id, sent_at)
        WHERE (payload->>'type') = 'child_done';

      -- Attachment manifest (BYTEA inline + forward-compat storage_uri)
      CREATE TABLE IF NOT EXISTS minion_attachments (
        id            SERIAL PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        content       BYTEA,
        storage_uri   TEXT,
        size_bytes    INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uniq_minion_attachments_job_filename UNIQUE (job_id, filename),
        CONSTRAINT chk_attachment_storage CHECK (content IS NOT NULL OR storage_uri IS NOT NULL),
        CONSTRAINT chk_attachment_size CHECK (size_bytes >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_minion_attachments_job ON minion_attachments (job_id);

      -- TOAST tuning: store attachment bytes out-of-line, skip compression.
      -- Attachments are usually already-compressed formats; compression burns CPU for no win.
      DO $$
      BEGIN
        ALTER TABLE minion_attachments ALTER COLUMN content SET STORAGE EXTERNAL;
      EXCEPTION WHEN OTHERS THEN
        -- PGLite may not support SET STORAGE EXTERNAL. Storage tuning is an optimization, not correctness.
        NULL;
      END $$;
    `,
};
