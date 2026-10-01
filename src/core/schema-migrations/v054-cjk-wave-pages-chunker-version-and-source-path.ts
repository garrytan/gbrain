import type { Migration } from './types.ts';

export const v054: Migration = {
  version: 54,
  name: 'cjk_wave_pages_chunker_version_and_source_path',
  // v0.32.7 CJK fix wave. Two new columns on `pages` so the post-upgrade
  // reindex sweep can find markdown pages built by the old chunker AND so
  // sync's delete/rename code can resolve frontmatter-fallback slugs by
  // path (CJK files where path → slug is non-derivable).
  //
  //   chunker_version: bumped to 2 in this release. New imports populate
  //     it; existing rows inherit DEFAULT 1. `gbrain reindex --markdown`
  //     walks `WHERE chunker_version < 2 AND page_kind = 'markdown'`
  //     and re-imports each, bumping the column.
  //
  //   source_path: import-time repo-relative path. Lets sync's delete/
  //     rename resolve fallback slugs (`小米.md` w/ frontmatter slug →
  //     non-path-derivable). NULL for pre-migration rows; populated on
  //     next import / reindex.
  //
  // Both columns engine-agnostic. Partial indexes scope to the rows
  // we actually query (markdown-only chunker_version; non-NULL source_path).
  idempotent: true,
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS chunker_version SMALLINT NOT NULL DEFAULT 1;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_path TEXT;

      CREATE INDEX IF NOT EXISTS pages_chunker_version_idx
        ON pages (chunker_version) WHERE page_kind = 'markdown';

      CREATE INDEX IF NOT EXISTS pages_source_path_idx
        ON pages (source_path) WHERE source_path IS NOT NULL;
    `,
};
