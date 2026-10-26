import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Segmented version retention (page-state/versions.ts pruneSegmentedVersions)
// reads a page's closed manifest rows by generation range: the rows a kept
// version's generation pins are those closed after it, up to the next newer
// kept generation, so each closed row is read once whatever the number of
// versions. Without this index a prune read every manifest row of the page and
// joined each closed row to every kept version. Partial, so live rows (gen_to
// NULL) are not in it; built online (CONCURRENTLY on Postgres); an interrupted
// build leaves an INVALID index that the next initSchema drops and rebuilds.
export const PAGE_BODY_MANIFEST_CLOSED_INDEX = {
  name: 'page_body_manifest_closed',
  table: 'page_body_manifest',
  sql: 'CREATE INDEX IF NOT EXISTS page_body_manifest_closed ON page_body_manifest (page_id, gen_to) WHERE gen_to IS NOT NULL',
};

export const v277: Migration = {
  version: 277,
  name: 'page_body_manifest_closed_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 277, PAGE_BODY_MANIFEST_CLOSED_INDEX, { notice: migrationNotice });
  },
};
