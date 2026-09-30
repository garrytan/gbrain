import type { Migration } from './types.ts';

export const v025: Migration = {
  version: 25,
  name: 'pages_page_kind',
  // v0.19.0 Layer 3 — pages.page_kind distinguishes markdown vs code pages
  // at the DB level. Needed so orphans filter, link-extraction auto-link,
  // and query --lang can branch on kind without sniffing `type` or chunk
  // metadata. Existing rows backfill to 'markdown' (pre-v0.19.0 all pages
  // were markdown).
  //
  // Postgres: ADD COLUMN with DEFAULT is O(1) for nullable columns (no
  // rewrite). The CHECK constraint is added NOT VALID so the initial
  // statement does not scan the table, then VALIDATE CONSTRAINT runs
  // separately. Tables with millions of pages would otherwise hold a
  // write lock during the full scan.
  sqlFor: {
    postgres: `
        ALTER TABLE pages
          ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown';

        ALTER TABLE pages
          DROP CONSTRAINT IF EXISTS pages_page_kind_check;
        ALTER TABLE pages
          ADD CONSTRAINT pages_page_kind_check
          CHECK (page_kind IN ('markdown','code')) NOT VALID;
        ALTER TABLE pages VALIDATE CONSTRAINT pages_page_kind_check;
      `,
    pglite: `
        ALTER TABLE pages
          ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown'
          CHECK (page_kind IN ('markdown','code'));
      `,
  },
  sql: `
      ALTER TABLE pages
        ADD COLUMN IF NOT EXISTS page_kind TEXT NOT NULL DEFAULT 'markdown'
        CHECK (page_kind IN ('markdown','code'));
    `,
};
