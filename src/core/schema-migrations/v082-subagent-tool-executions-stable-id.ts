import type { Migration } from './types.ts';

export const v082: Migration = {
  version: 82,
  name: 'subagent_tool_executions_stable_id',
  // (master v0.38.1.0; see end of conflict marker block for full body)
  idempotent: true,
  sql: `
      ALTER TABLE subagent_tool_executions
        ADD COLUMN IF NOT EXISTS ordinal INTEGER,
        ADD COLUMN IF NOT EXISTS gbrain_tool_use_id UUID;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'subagent_tool_executions_stable_id'
        ) THEN
          ALTER TABLE subagent_tool_executions
            ADD CONSTRAINT subagent_tool_executions_stable_id
            UNIQUE (job_id, message_idx, ordinal);
        END IF;
      END$$;
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE subagent_tool_executions
          ADD COLUMN IF NOT EXISTS ordinal INTEGER;
        ALTER TABLE subagent_tool_executions
          ADD COLUMN IF NOT EXISTS gbrain_tool_use_id UUID;
        ALTER TABLE subagent_tool_executions
          DROP CONSTRAINT IF EXISTS subagent_tool_executions_stable_id;
        ALTER TABLE subagent_tool_executions
          ADD CONSTRAINT subagent_tool_executions_stable_id
          UNIQUE (job_id, message_idx, ordinal);
      `,
  },
};
