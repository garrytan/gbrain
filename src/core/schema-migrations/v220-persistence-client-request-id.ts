import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// F6 (Cat 40 Hard): a write op accepts any opaque request_id and journals the
// deterministic UUIDv5 it maps to. persistence_requests gains client_request_id,
// the string the client sent, stored outside the intent digest so receipts echo
// it after a restart or compaction. Column-only and nullable (NULL when the
// client sent a UUID or nothing); like v198 it is migration-created on PGLite
// and no index references it (lookups map the string to its UUID first).
export const v220: Migration = {
  version: 220,
  name: 'persistence_client_request_id',
  idempotent: true,
  sql: `
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS client_request_id text;`,
};
