import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-218: per-member read access inside one source. Members and groups name
// people; a token or OAuth client may be bound to one member (member_id) and,
// for shared agents, list whom it may act for (may_act_for). A page names its
// readers in frontmatter `readable_by`; gbrain_access_readers() is the one SQL
// normalization of that value (src/core/access/principals.ts is its row twin,
// and test/access-principals.test.ts holds them equal). It reads the live
// frontmatter, so no writer, rename or backfill can leave a stale copy. Nothing
// is rewritten on upgrade. A trigger sets config access.restrictions_present
// once any page names readers or any member exists (sticky), so a brain with no
// restriction keeps every pre-GBRA-218 read path and escape hatch exactly.
// gbrain_access_origin_restricted() is the read-time lineage test (a derived
// page whose origin names readers); reads call it behind a cheap guard.
// No schema.sql mirror: like v273, these exist only
// through migrations. Provisional number: renumbered at the merge slot.
export const v281: Migration = {
  version: 281,
  name: 'member_read_access',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_members (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name TEXT,
  disabled_at TIMESTAMPTZ,
  tombstoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_groups (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_group_members (
  group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES access_members(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX IF NOT EXISTS access_group_members_member_idx ON access_group_members (member_id);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_readers TEXT[];
CREATE INDEX IF NOT EXISTS pages_page_readers_gin ON pages USING gin (page_readers) WHERE page_readers IS NOT NULL;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS member_id TEXT;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS may_act_for TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS member_id TEXT;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS may_act_for TEXT[];
CREATE OR REPLACE FUNCTION gbrain_access_norm_readers(vals TEXT[]) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN count(*) > 0 AND bool_and(n IS NOT NULL) THEN array_agg(DISTINCT n COLLATE "C" ORDER BY n COLLATE "C") ELSE ARRAY['!nobody'] END
  FROM (
    SELECT CASE
      WHEN v ~ '^(member:)?[a-z0-9][a-z0-9._-]{0,63}$' THEN 'member:' || regexp_replace(v, '^member:', '')
      WHEN v ~ '^group:[a-z0-9][a-z0-9._-]{0,63}$' THEN v
      ELSE NULL END AS n
    FROM (SELECT translate(btrim(x, ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS v FROM unnest(vals) AS x) AS raw
  ) AS normalized
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_readers(fm JSONB) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN fm IS NULL OR jsonb_typeof(fm) <> 'object' OR NOT (fm ? 'readable_by') THEN NULL
    WHEN jsonb_typeof(fm->'readable_by') = 'string' THEN gbrain_access_norm_readers(ARRAY[fm->>'readable_by'])
    WHEN jsonb_typeof(fm->'readable_by') = 'array'
      AND jsonb_array_length(fm->'readable_by') BETWEEN 1 AND 256
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(fm->'readable_by') AS e WHERE jsonb_typeof(e) <> 'string')
      THEN gbrain_access_norm_readers(ARRAY(SELECT jsonb_array_elements_text(fm->'readable_by')))
    ELSE ARRAY['!nobody'] END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_restricted(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug = fm->>'source_slug' AND o.frontmatter ? 'readable_by') THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (i.frontmatter ? 'readable_by' OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id
            AND io.slug = i.frontmatter->>'source_slug' AND io.frontmatter ? 'readable_by'))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug = fm->'event'->>'depth' AND c.frontmatter ? 'readable_by') THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id AND d.frontmatter ? 'readable_by'
      AND d.slug = ANY(ARRAY(SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS declared(slug))));
  END IF;
  RETURN false;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_mark_restricted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM config WHERE key = 'access.restrictions_present' AND value = '1') THEN
    INSERT INTO config (key, value) VALUES ('access.restrictions_present', '1')
      ON CONFLICT (key) DO UPDATE SET value = '1';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_derive_page_readers() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.page_readers := CASE WHEN NEW.frontmatter ? 'readable_by' THEN gbrain_access_readers(NEW.frontmatter) ELSE NULL END;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS pages_access_derive_readers ON pages;
CREATE TRIGGER pages_access_derive_readers BEFORE INSERT OR UPDATE OF frontmatter, page_readers ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_derive_page_readers();
DROP TRIGGER IF EXISTS pages_access_mark_restricted ON pages;
CREATE TRIGGER pages_access_mark_restricted AFTER INSERT OR UPDATE OF frontmatter ON pages
  FOR EACH ROW WHEN (NEW.frontmatter ? 'readable_by') EXECUTE FUNCTION gbrain_access_mark_restricted();
DROP TRIGGER IF EXISTS access_members_mark_restricted ON access_members;
CREATE TRIGGER access_members_mark_restricted AFTER INSERT ON access_members
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_mark_restricted();
INSERT INTO config (key, value)
  SELECT 'access.restrictions_present', '1'
  WHERE EXISTS (SELECT 1 FROM pages WHERE frontmatter ? 'readable_by') OR EXISTS (SELECT 1 FROM access_members)
  ON CONFLICT (key) DO UPDATE SET value = '1';
`,
};
