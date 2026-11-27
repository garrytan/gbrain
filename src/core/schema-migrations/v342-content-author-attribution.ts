import type { Migration } from './types.ts';
import { CONTENT_AUTHOR_SCHEMA_SQL } from '../persistence/content-author-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-4056: pages.content_author / content_author_hash record who wrote the page's live text, and a trigger clears them
// when a statement changes the text without declaring an author (persistence/content-author-schema.ts). Both columns are
// nullable with no default, so ADD COLUMN changes only the catalog; an older binary leaves them NULL and the trigger keeps
// its writes honest. The backfill is v343, in its own transaction, so this lock on pages ends with the DDL.
export const v342: Migration = {
  version: 342,
  name: 'content_author_attribution',
  idempotent: true,
  sql: CONTENT_AUTHOR_SCHEMA_SQL,
};
