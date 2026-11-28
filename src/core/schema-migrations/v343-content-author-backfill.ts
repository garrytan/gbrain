import type { Migration } from './types.ts';
import { CONTENT_AUTHOR_BACKFILL_SQL } from '../persistence/content-author-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-4056: stamps the content author (v342) on existing importer and connector pages the previous rule trusted, unless a
// remote writer is on record for the page (persistence/content-author-schema.ts CONTENT_AUTHOR_BACKFILL_SQL). It runs after
// v342 committed, so the scan takes only row locks on the pages it stamps and page reads continue. Re-running it touches
// only rows still unstamped.
export const v343: Migration = {
  version: 343,
  name: 'content_author_backfill',
  idempotent: true,
  sql: CONTENT_AUTHOR_BACKFILL_SQL,
};
