import type { Migration } from './types.ts';
import { MEMORY_PURGE_GUARD_SQL, MEMORY_PURGE_SCHEMA_SQL } from '../facts/purge-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// `forget --purge` and page purge (#5575 Part C): text-free purge ledgers
// (fact_purges, take_purges, page_purges), the derivation edge table purge
// walks to hide derived rows (derivation_inputs, needs_rederive), and the
// guards that raise typed purged_content when purged content is written
// again. New empty tables, so their indexes build inline on both engines.
export const v228: Migration = {
  version: 228,
  name: 'memory_purge',
  idempotent: true,
  sql: MEMORY_PURGE_SCHEMA_SQL + MEMORY_PURGE_GUARD_SQL,
};
