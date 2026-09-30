import type { Migration } from './types.ts';

export const v061: Migration = {
  version: 61,
  name: 'oauth_clients_federated_read_column',
  // v0.34.1 (#876): add federated_read TEXT[] for the read-side
  // federation feature. source_id (v60) is the WRITE-authority axis;
  // federated_read is the READ-scope axis. A client can write to ONE
  // source while reading from N (a "WeCare L3 dept" client writes to
  // dept-x and reads dept-x + parent canon + shared canon).
  //
  // Default '{}' (empty array) on column add — pre-existing rows get
  // backfilled in v62 with an explicit CASE so the array reflects the
  // client's current scope rather than the column default.
  idempotent: true,
  sql: `
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_read TEXT[] NOT NULL DEFAULT '{}';
    `,
};
