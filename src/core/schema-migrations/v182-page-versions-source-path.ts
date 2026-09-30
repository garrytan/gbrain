import type { Migration } from './types.ts';

export const v182: Migration = {
  // #5393: a version records the page's canonical file (source_path) when it
  // was taken, so persistence.unbound_write=database_only judges revert_version
  // on the version being written as well as the current page row. Nullable,
  // no backfill: older versions never recorded it and read as file-less
  // (bootstrap-coverage: column-only).
  // Keep in sync with src/schema.sql (regenerate the engine blobs with
  // build:schema).
  version: 182,
  name: 'page_versions_source_path',
  idempotent: true,
  sql: `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS source_path TEXT;`,
};
