import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Large-pages hardening (b)/(c): a managed write's transient interruptions (a
// statement the database ended with SQLSTATE 57014, or a publication cancelled at
// `persistence.publication_ceiling_ms`) get their own budget
// (`persistence.max_transient_retries`, persistence/transient-retry.ts) instead of
// `preparation_attempts`. `transient_interruptions` counts them; each one schedules
// the request's next claim at `next_attempt_at` (bounded exponential backoff), and
// a claim skips a queued row until then. Column-only, no backfill: existing rows
// start at 0 and NULL (claimable now). Like v217 and v220 the columns are
// migration-created (the `persistence_requests` CREATE TABLE of src/schema.sql
// carries only the original columns) and no index references them. No CHECK on
// the counter: on Postgres an inline CHECK validates every existing row under the
// ACCESS EXCLUSIVE lock the ALTER takes, and only an increment ever writes it.
export const v261: Migration = {
  version: 261,
  name: 'persistence_request_transient_retries',
  idempotent: true,
  sql: `
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS transient_interruptions integer NOT NULL DEFAULT 0;
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
  `,
};
