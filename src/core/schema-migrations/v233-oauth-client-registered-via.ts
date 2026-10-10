import type { Migration } from './types.ts';

// #6202: marks self-registered (DCR) OAuth clients so the owner can pick the
// client's source at its first consent. NULL for operator-registered clients
// and for every row that exists before this migration, so those keep today's
// read-only consent. No index and no backfill: only new DCR registrations
// write 'dcr'. Migration-only like min_trust (trust-tiers): fresh installs get
// the column from this migration too, so an upgraded brain and a fresh one end
// with the same column order. The CHECK is added NOT VALID (no scan under the
// ADD) and validated separately, the trust-tiers pattern for this table.
export const v233: Migration = {
  version: 233,
  name: 'oauth_client_registered_via',
  idempotent: true,
  sql: `
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS registered_via TEXT;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_clients_registered_via_check' AND conrelid = 'oauth_clients'::regclass) THEN
        ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_registered_via_check CHECK (registered_via IN ('dcr')) NOT VALID;
      END IF;
    END $do$;
    ALTER TABLE oauth_clients VALIDATE CONSTRAINT oauth_clients_registered_via_check;
  `,
};
