import type { Migration } from './types.ts';
import { BELIEF_HISTORY_INDEX_SCHEMA_SQL } from '../belief/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// W3 history text index (docs/architecture/historical-retrieval.md section 4):
// three derived tables for retrieval as recorded at an instant, plus the
// per-source build state behind the index cut. Additive and empty: nothing
// rewrites data on upgrade. A source with ledger history from before this
// migration has no state row, so every instant refuses
// `history_index_incomplete` until `gbrain beliefs history-index --apply`.
export const v257: Migration = {
  version: 257,
  name: 'belief_history_index',
  idempotent: true,
  sql: BELIEF_HISTORY_INDEX_SCHEMA_SQL,
};
