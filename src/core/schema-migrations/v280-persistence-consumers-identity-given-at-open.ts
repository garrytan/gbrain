import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// A host that opens an engine from settings alone (src/core/engine-open.ts)
// names the host identity its consumer publishes under; no `host.json` is
// minted for it, so its heartbeat row has no file path and no persistence
// home to record. Both columns become nullable: null means the identity was
// given at open, a path means it was read from that file. Rows written by
// older consumers are unchanged. No row is read or written here.
export const v280: Migration = {
  version: 280,
  name: 'persistence_consumers_identity_given_at_open',
  idempotent: true,
  sql: `ALTER TABLE persistence_consumers ALTER COLUMN host_json_path DROP NOT NULL;
ALTER TABLE persistence_consumers ALTER COLUMN persistence_home DROP NOT NULL;`,
};
