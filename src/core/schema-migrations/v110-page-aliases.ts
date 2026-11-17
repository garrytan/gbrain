import type { Migration } from './types.ts';

export const v110: Migration = {
  version: 110,
  name: 'page_aliases',
  // T3 of the retrieval-cathedral wave (retrieval-maxpool incident).
  //
  // Free-text alias resolution: a query like "Hall of Light" or "明堂"
  // should surface the page titled "Mingtang". gbrain stored that mapping
  // in pages.frontmatter `aliases:` JSONB but it was invisible to search.
  //
  // DELIBERATELY SEPARATE from slug_aliases (v105). They answer different
  // questions and overloading one for both would muddy the semantics:
  //   - slug_aliases:  old-slug -> canonical-slug (wikilink/get_page redirect)
  //   - page_aliases:  normalized free-text name -> canonical slug (search hop)
  //
  // alias_norm is the output of normalizeAlias() (NFKC + lowercase + ws
  // collapse) so the WRITE side (ingest projection) and READ side (search)
  // match on the same key. Btree on (source_id, alias_norm) so the hop is an
  // indexed equality lookup, not ILIKE.
  //
  // NOT a UNIQUE(source_id, alias_norm) — real brains may legitimately have
  // two pages claiming the same alias; we report the collision and resolve
  // deterministically at query time rather than failing the ingest (Codex#8).
  // The (source_id, alias_norm, slug) triple is unique so re-ingest is
  // idempotent without blocking a second page's claim on the same alias.
  //
  // Mirror in src/core/pglite-schema.ts (fresh install); forward-reference
  // bootstrap probe on both engines so pre-v110 brains pick it up cleanly.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS page_aliases (
        id          BIGSERIAL PRIMARY KEY,
        source_id   TEXT NOT NULL,
        alias_norm  TEXT NOT NULL,
        slug        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT page_aliases_uniq UNIQUE (source_id, alias_norm, slug)
      );
      CREATE INDEX IF NOT EXISTS page_aliases_lookup_idx
        ON page_aliases (source_id, alias_norm);
      CREATE INDEX IF NOT EXISTS page_aliases_slug_idx
        ON page_aliases (source_id, slug);
    `,
};
