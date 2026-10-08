import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

/**
 * #6222/#6254: index the reconcile "no other page claims this file" census
 * (`assertSoleFileClaim`, persistence/reconcile-state.ts). It looked up every
 * page whose recorded path or file URI shares the file's name with a regexp
 * over the whole source, about five times per reconciled page (458 ms per call
 * at 490k pages). The expressions here are byte-identical to the census
 * predicates. Postgres builds each index CONCURRENTLY, one statement per call,
 * after dropping an INVALID leftover; PGLite builds them inline.
 */
export const PAGES_RECONCILE_NAME_INDEXES = [
  { name: 'pages_source_path_name_idx', table: 'pages',
    sql: `CREATE INDEX IF NOT EXISTS pages_source_path_name_idx
      ON pages (source_id, (regexp_replace(replace(btrim(source_path), chr(92), '/'), '^.*/', '')))
      WHERE source_path IS NOT NULL` },
  { name: 'pages_file_uri_name_idx', table: 'pages',
    sql: `CREATE INDEX IF NOT EXISTS pages_file_uri_name_idx
      ON pages (source_id, (regexp_replace(source_uri, '^.*/', '')))
      WHERE source_uri LIKE 'file:%'` },
] as const;

export const v219: Migration = {
  version: 219,
  name: 'pages_reconcile_name_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    for (const index of PAGES_RECONCILE_NAME_INDEXES) {
      await buildIndexOnline(engine, 219, index, { notice: migrationNotice });
    }
  },
};
