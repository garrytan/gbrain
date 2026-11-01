import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-218: the GIN indexes behind member reads (page_readers, v282) and folder
// rules (folder_rule_ids, v283). Those migrations add the columns inside their
// transactions, which hold ACCESS EXCLUSIVE on pages until commit; a plain
// CREATE INDEX there would scan every page under that lock (the partial
// predicate on a new, all-NULL column still reads the heap). Built online here
// instead (CONCURRENTLY on Postgres); an interrupted build leaves an INVALID
// index that the next initSchema drops and rebuilds. Not in schema.sql, like
// v270.
export const PAGES_PAGE_READERS_INDEX = {
  name: 'pages_page_readers_gin',
  table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS pages_page_readers_gin ON pages USING gin (page_readers) WHERE page_readers IS NOT NULL',
};

export const PAGES_FOLDER_RULE_IDS_INDEX = {
  name: 'pages_folder_rule_ids_gin',
  table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS pages_folder_rule_ids_gin ON pages USING gin (folder_rule_ids) WHERE folder_rule_ids IS NOT NULL',
};

export const v284: Migration = {
  version: 284,
  name: 'access_page_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 284, PAGES_PAGE_READERS_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 284, PAGES_FOLDER_RULE_IDS_INDEX, { notice: migrationNotice });
  },
};
