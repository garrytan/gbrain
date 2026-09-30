import type { Migration } from './types.ts';

export const v063: Migration = {
  version: 63,
  name: 'oauth_clients_federated_read_validate',
  // v0.34.1 (#876): post-backfill validation. Every client with a
  // non-NULL source_id should now have its source_id reflected in
  // federated_read. Fail loud if backfill missed a row — points at a
  // logic bug in v62's WHERE clause.
  idempotent: true,
  sql: `
      DO $$
      DECLARE
        bad_count INT;
      BEGIN
        SELECT count(*) INTO bad_count FROM oauth_clients
          WHERE source_id IS NOT NULL
            AND NOT (source_id = ANY(federated_read));
        IF bad_count > 0 THEN
          RAISE EXCEPTION 'oauth_clients has % rows where source_id is not in federated_read after v62 backfill. This is a bug in v62 — re-run gbrain apply-migrations --force-retry 62.', bad_count;
        END IF;
      END $$;
    `,
};
