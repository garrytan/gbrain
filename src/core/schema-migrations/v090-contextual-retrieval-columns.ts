import type { Migration } from './types.ts';

export const v090: Migration = {
  version: 90,
  name: 'contextual_retrieval_columns',
  // v0.40.3.0 contextual retrieval wave (renumbered from v81 on master
  // merge — v82-v88 claimed by master's v0.38/v0.39 cathedrals, v89
  // reserved by garrytan/v0.40.2.0-trajectory-routing for
  // facts_event_type_column).
  //
  // Five additive columns wiring the three-tier wrapper ladder
  // (none/title/per_chunk_synopsis) into the schema. All NULL-tolerant
  // or have safe defaults so existing rows continue to work unchanged
  // until the post-upgrade reindex sweep catches up.
  //
  // pages.contextual_retrieval_mode — what mode the page was last
  //   embedded under. NULL means pre-v90 (treat as 'none' for drift
  //   detection until reindex).
  // pages.corpus_generation — composite hash of (synopsis_prompt_version,
  //   haiku_model, title_wrapper_version, embedding_model). Used for
  //   document-side provenance in query_cache invalidation. NULL means
  //   pre-v90; the query_cache.page_generations check treats NULL and
  //   any current generation as freshness-mismatched, so cache rows
  //   tagged with a real generation correctly invalidate against pre-v90
  //   pages that get re-embedded.
  // sources.contextual_retrieval_mode — per-source override. NULL means
  //   fall through to global mode. CLI-write-only per D15 security.
  // sources.trust_frontmatter_overrides — per-source mount-frontmatter
  //   trust gate (D15). FALSE for mounted sources by default; flipped
  //   explicitly via `gbrain mounts trust-frontmatter <source>`. Host
  //   source (id='default') is always trusted regardless of this column.
  // query_cache.page_generations — JSONB map {page_id: corpus_generation}
  //   tagged at write time per D27 P1-5. Lookup query LEFT JOINs against
  //   current pages and excludes rows where any tagged generation
  //   differs from the page's current corpus_generation. Empty default
  //   so v55-era rows continue to work until they age out via TTL.
  //
  // No indexes needed: all five columns are read alongside their parent
  // row, never queried independently. corpus_generation participates in
  // query_cache's existing index (source_id, knobs_hash, created_at).
  //
  // ADD COLUMN with NULL or constant DEFAULT is metadata-only on
  // Postgres 11+ and PGLite 17.5, instant on tables of any size.
  idempotent: true,
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT NULL;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS corpus_generation TEXT NULL;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT NULL;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS page_generations JSONB NOT NULL DEFAULT '{}'::jsonb;
    `,
};
