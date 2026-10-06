import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wanted pages: an authored link (wikilink, markdown link or frontmatter link
// field) whose target page does not exist is recorded here instead of being
// dropped. `checked_at` is when the origin's resolution was read; a live target
// page updated after it makes the origin stale for link extraction, so the edge
// appears once the target does (src/core/wanted-links.ts). Rows are derived
// state, replaced with the origin's links in the same transaction.
// The basename expression index serves `ref_kind = 'name'` targets and the
// put_page similar-pages advisory.
export const v214: Migration = {
  version: 214,
  name: 'wanted_links',
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS wanted_links (
        id               BIGSERIAL PRIMARY KEY,
        origin_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        producer         TEXT NOT NULL CHECK (producer IN ('body','frontmatter')),
        ref_kind         TEXT NOT NULL CHECK (ref_kind IN ('slug','name')),
        target_source_id TEXT NOT NULL,
        target_ref       TEXT NOT NULL,
        link_type        TEXT NOT NULL DEFAULT '',
        context          TEXT NOT NULL DEFAULT '',
        checked_at       TIMESTAMPTZ NOT NULL,
        first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT wanted_links_reference_unique
          UNIQUE (origin_page_id, producer, ref_kind, target_source_id, target_ref)
      );
      CREATE INDEX IF NOT EXISTS wanted_links_target_idx ON wanted_links (target_source_id, target_ref);
      CREATE INDEX IF NOT EXISTS wanted_links_source_idx ON wanted_links (source_id);
      CREATE INDEX IF NOT EXISTS idx_pages_slug_basename
        ON pages (source_id, (regexp_replace(slug, '^.*/', '')));
      DO $rls$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
          ALTER TABLE wanted_links ENABLE ROW LEVEL SECURITY;
        END IF;
      END $rls$;
    `,
};
