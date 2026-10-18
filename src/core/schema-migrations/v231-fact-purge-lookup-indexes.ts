import type { Migration } from './types.ts';
import { FACT_PURGES_ALL_SUBJECTS_INDEX, FACT_PURGES_SUBJECT_INDEX } from '../facts/purge-schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Page snapshots stopped aggregating every subject-'*' fact purge tombstone
// (page-state/snapshot.ts): they read a page's own tombstones, a count/latest
// marker for the '*' ones and, only for a text with fence rows, the '*'
// tombstones naming those rows. fact_purges' primary key leads with
// visibility, so all three scanned the source's whole ledger. These indexes
// make them index probes (facts/purge-schema.ts). Postgres builds them
// CONCURRENTLY, one at a time; PGLite inline. Tombstone ledgers are small.
export const v231: Migration = {
  version: 231,
  name: 'fact_purge_lookup_indexes',
  idempotent: true,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 231, FACT_PURGES_SUBJECT_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 231, FACT_PURGES_ALL_SUBJECTS_INDEX, { notice: migrationNotice });
  },
};
