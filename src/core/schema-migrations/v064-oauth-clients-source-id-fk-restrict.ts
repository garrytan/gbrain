import type { Migration } from './types.ts';

export const v064: Migration = {
  version: 64,
  name: 'oauth_clients_source_id_fk_restrict',
  // v0.34.1 (#876): flip the source_id FK from ON DELETE SET NULL (v60
  // posture) to ON DELETE RESTRICT now that federated_read provides
  // the alternative scope-loss path. Pre-fix, deleting a source could
  // silently widen any oauth_client to super-reader (source_id → NULL).
  // Post-flip, source delete is refused if any client references it;
  // the operator's path is "revoke or re-scope the clients first."
  idempotent: true,
  sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'oauth_clients_source_id_fkey'
        ) THEN
          ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_source_id_fkey;
        END IF;
        ALTER TABLE oauth_clients
          ADD CONSTRAINT oauth_clients_source_id_fkey
          FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT;
      END $$;
    `,
};
