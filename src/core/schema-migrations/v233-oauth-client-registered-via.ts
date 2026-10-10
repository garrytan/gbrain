import type { Migration } from './types.ts';

// #6202: marks self-registered (DCR) OAuth clients so the owner can pick the
// client's source at its first consent. NULL for operator-registered clients
// and for every row that exists before this migration, so those keep today's
// read-only consent. No index and no backfill: only new DCR registrations
// write 'dcr'. Migration-only like min_trust (trust-tiers): fresh installs get
// the column from this migration too, so an upgraded brain and a fresh one end
// with the same column order.
export const v233: Migration = {
  version: 233,
  name: 'oauth_client_registered_via',
  idempotent: true,
  sql: `
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS registered_via TEXT
      CHECK (registered_via IN ('dcr'));
  `,
};
