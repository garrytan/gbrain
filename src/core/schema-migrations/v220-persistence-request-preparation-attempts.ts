import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6278: how many times a write request's preparation was cut off (a
// `preparation_deadline` release, or the reclaim of a claim that expired
// while its owner was preparing). The consumer finishes a request that
// reaches `persistence.max_preparation_attempts` as `failed` with
// `preparation_stalled` instead of claiming it again, so one stuck
// preparation cannot stall a catch-up on every pass. Existing rows start at 0;
// a commit resets the counter. The column is also in the `persistence_requests`
// CREATE TABLE of src/schema.sql for fresh installs; no index references it.
export const v220: Migration = {
  version: 220,
  name: 'persistence_request_preparation_attempts',
  idempotent: true,
  sql: `
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS preparation_attempts integer NOT NULL DEFAULT 0 CHECK (preparation_attempts >= 0);
  `,
};
