export const WANTED_LINKS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS wanted_links (
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
      END $rls$;`;
