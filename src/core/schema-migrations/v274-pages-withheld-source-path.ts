import type { Migration } from './types.ts';

export const v274: Migration = {
  // Git-canonical G7a follow-up: a strict page turning private has its file
  // removed by a door commit and its origin cleared in the same publication
  // (git-declared.ts declareStrictPublication). The path it had is kept here,
  // so the page is never read as a never-filed derive-phase page and writes
  // its file back at that path when it turns world again; the publication that
  // writes the file clears it. Nullable, no backfill, no index (read per page;
  // bootstrap-coverage: column-only). Fresh installs get it from this
  // migration too (not src/schema.sql), so fresh and upgraded brains share
  // pages column ordinals.
  version: 274,
  name: 'pages_withheld_source_path',
  idempotent: true,
  sql: `
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS withheld_source_path TEXT;
  `,
};
