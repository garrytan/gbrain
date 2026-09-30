import type { Migration } from './types.ts';

export const v062: Migration = {
  version: 62,
  name: 'oauth_clients_federated_read_backfill',
  // v0.34.1 (#876, F5 — codex outside-voice fix). Backfill federated_read
  // with explicit CASE so source_id IS NULL doesn't produce an ambiguous
  // array containing NULL. Three cases:
  //   - source_id IS NULL → '{}' (empty read scope; legacy unscoped
  //     clients lost their implicit fallback in v60 backfill to 'default',
  //     so this branch fires only when an operator explicitly NULL'd
  //     source_id after migration).
  //   - source_id IS NOT NULL → ARRAY[source_id] (read scope matches
  //     write scope, the pre-federation default).
  // Only fires on rows where federated_read is still the column default
  // ({}). Operators who hand-set federated_read keep their config.
  idempotent: true,
  sql: `
      UPDATE oauth_clients
      SET federated_read = CASE
        WHEN source_id IS NULL THEN '{}'::text[]
        ELSE ARRAY[source_id]
      END
      WHERE federated_read = '{}'::text[];
    `,
};
