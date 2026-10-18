import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same table.
//
// Wave B segmented pages (src/core/page-window/segmented.ts): the size and
// sha256 of a get_page view of a segmented page, per page revision, view
// ('read' line count; 'markdown' total bytes, lines and sha256) and audience,
// so paging a large page's markdown to its end streams it once instead of
// once per window. Sizes and hashes only: no page text is stored. A row is a
// cache: it is used only while its byte total matches the page's stored sums,
// rows of older revisions are dropped when a new one is written, and rows go
// with their page (ON DELETE CASCADE). DDL only, nothing to backfill.
export const v253: Migration = {
  version: 253,
  name: 'page_view_digests',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_view_digests (
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      view TEXT NOT NULL CHECK (view IN ('read','markdown')),
      audience TEXT NOT NULL CHECK (audience IN ('trusted','remote')),
      total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
      total_lines BIGINT NOT NULL CHECK (total_lines >= 0),
      sha256 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (page_id, revision, view, audience)
    );
  `,
};
