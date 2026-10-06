import type { Migration } from './types.ts';
import { CORE_EDIT_NOTICES_SCHEMA_SQL } from '../core-memory-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Always-loaded core memory: remote edits to core pages are recorded here so
// the owner sees and acknowledges them (src/core/persistence/core-guard.ts).
// New empty table, so its index builds inline on both engines.
export const v213: Migration = {
  version: 213,
  name: 'core_edit_notices',
  idempotent: true,
  sql: CORE_EDIT_NOTICES_SCHEMA_SQL,
};
