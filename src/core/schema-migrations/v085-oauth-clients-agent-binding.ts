import type { Migration } from './types.ts';

export const v085: Migration = {
  version: 85,
  name: 'oauth_clients_agent_binding',
  // (master v0.38.1.0 — full body in merged region)
  idempotent: true,
  sql: `
      ALTER TABLE oauth_clients
        ADD COLUMN IF NOT EXISTS bound_tools TEXT[] NULL,
        ADD COLUMN IF NOT EXISTS bound_source_id TEXT NULL,
        ADD COLUMN IF NOT EXISTS bound_brain_id TEXT NULL,
        ADD COLUMN IF NOT EXISTS bound_slug_prefixes TEXT[] NULL,
        ADD COLUMN IF NOT EXISTS bound_max_concurrent INTEGER NOT NULL DEFAULT 1;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_oauth_clients_bound_source'
        ) THEN
          BEGIN
            ALTER TABLE oauth_clients
              ADD CONSTRAINT fk_oauth_clients_bound_source
              FOREIGN KEY (bound_source_id)
              REFERENCES sources(id) ON DELETE SET NULL;
          EXCEPTION WHEN others THEN
            NULL;
          END;
        END IF;
      END$$;
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE oauth_clients
          ADD COLUMN IF NOT EXISTS bound_tools TEXT[] NULL;
        ALTER TABLE oauth_clients
          ADD COLUMN IF NOT EXISTS bound_source_id TEXT NULL;
        ALTER TABLE oauth_clients
          ADD COLUMN IF NOT EXISTS bound_brain_id TEXT NULL;
        ALTER TABLE oauth_clients
          ADD COLUMN IF NOT EXISTS bound_slug_prefixes TEXT[] NULL;
        ALTER TABLE oauth_clients
          ADD COLUMN IF NOT EXISTS bound_max_concurrent INTEGER NOT NULL DEFAULT 1;
      `,
  },
};
