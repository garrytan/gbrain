import type { Migration } from './types.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5983: the managed writer guard read a row's source from its source_id key
// whenever the key existed. A brain whose tags / timeline_entries / takes carry
// a nullable source_id column (not created by gbrain; every value NULL) had
// every coordinated INSERT/UPDATE there refused as writer_coordinator_required.
// Page children now always resolve their source through pages, so a column
// gbrain does not own can neither block nor authorize a write. Replaces only
// the function: the triggers already call it, and re-creating them would take
// ACCESS EXCLUSIVE locks on the largest tables of a live brain.
export const v197: Migration = {
  version: 197,
  name: 'managed_guard_null_source_fallback',
  idempotent: true,
  sql: MANAGED_WRITER_GUARD_FUNCTION_SQL,
};
