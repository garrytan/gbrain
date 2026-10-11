export const MENTION_INDEX_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS page_aliases (
      id BIGSERIAL PRIMARY KEY, source_id TEXT NOT NULL, alias_norm TEXT NOT NULL, slug TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT page_aliases_uniq UNIQUE (source_id, alias_norm, slug)
    );
    CREATE INDEX IF NOT EXISTS page_aliases_lookup_idx ON page_aliases (source_id, alias_norm);
    CREATE INDEX IF NOT EXISTS page_aliases_slug_idx ON page_aliases (source_id, slug);
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'frontmatter'
      CHECK (origin IN ('frontmatter','declared','subject'));
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS case_sensitive BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS alias_text TEXT;
    DO $alias_origin$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_aliases_origin_uniq' AND conrelid = 'page_aliases'::regclass) THEN
        ALTER TABLE page_aliases ADD CONSTRAINT page_aliases_origin_uniq UNIQUE (source_id, alias_norm, slug, origin);
      END IF;
      ALTER TABLE page_aliases DROP CONSTRAINT IF EXISTS page_aliases_uniq;
    END $alias_origin$;
    CREATE TABLE IF NOT EXISTS page_mention_state (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      mention_revision UUID,
      mention_version INTEGER,
      mention_generation BIGINT,
      mentions_scanned_at TIMESTAMPTZ,
      alias_revision UUID,
      alias_version INTEGER,
      aliases_refreshed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS page_mention_state_source_idx ON page_mention_state (source_id, mention_version);
    CREATE TABLE IF NOT EXISTS mention_gazetteer_entries (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      name_norm TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      case_sensitive BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (source_id, name_norm, target_slug, case_sensitive)
    );
    CREATE TABLE IF NOT EXISTS mention_index_status (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      generation BIGINT NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('complete','pending','disabled','failed')),
      pending INTEGER NOT NULL DEFAULT 0,
      counted_at TIMESTAMPTZ,
      last_pass_at TIMESTAMPTZ,
      policy_fingerprint TEXT,
      error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
        ALTER TABLE page_mention_state ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mention_gazetteer_entries ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mention_index_status ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;`;
