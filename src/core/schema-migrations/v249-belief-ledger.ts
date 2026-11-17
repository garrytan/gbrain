import type { Migration } from './types.ts';
import { BELIEF_FACTS_STREAM_INDEX, BELIEF_LEDGER_SCHEMA_SQL, BELIEF_SOURCE_COLUMNS_SQL } from '../belief/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Belief ledger (W1, docs/designs/BELIEF_LEDGER.md): the append-only
// `belief_events` table with its page lifetimes, commit marks, bulk retiering
// manifest and purge redaction register (src/core/belief/schema.ts, also in
// both blobs), plus the migration-only `sources.purge_epoch` counter. Additive
// and empty: nothing appends until `gbrain beliefs enable` baselines a source.
// The handler builds the facts index the batch state read uses (online on Postgres).
export const v249: Migration = {
  version: 249,
  name: 'belief_ledger',
  idempotent: true,
  sql: `${BELIEF_LEDGER_SCHEMA_SQL}
    ${BELIEF_SOURCE_COLUMNS_SQL}
  `,
  handler: async engine => { await buildIndexOnline(engine, 249, BELIEF_FACTS_STREAM_INDEX, { notice: migrationNotice }); },
};
