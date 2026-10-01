import type { Migration } from './types.ts';

export const v095: Migration = {
  version: 95,
  name: 'links_link_source_check_includes_mentions',
  // v0.41.18.0 Part B (migration #1 of #1409): widen the link_source
  // CHECK constraint to admit 'mentions' for auto-linked body-text
  // mentions from `gbrain extract links --by-mention`. Backlink-count
  // SQL in postgres-engine.ts + pglite-engine.ts excludes link_source =
  // 'mentions' so mention-derived edges don't pollute search ranking
  // (D12 from /plan-eng-review). Mentions still count toward
  // orphan-ratio and graph traversal — distinct semantics from
  // markdown / frontmatter / manual provenance.
  //
  // Postgres auto-names the inline CHECK as `links_link_source_check`.
  // PGLite mirrors that naming. Both branches DROP-IF-EXISTS for
  // re-runnability. No data backfill needed (existing rows have
  // link_source IN current allow-list ∪ NULL).
  sql: `
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
      ALTER TABLE links ADD CONSTRAINT links_link_source_check
        CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions'));
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
        ALTER TABLE links ADD CONSTRAINT links_link_source_check
          CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions'));
      `,
  },
};
