import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-218 (PR A2): per-folder read access. A source's applied rulebook
// (access_rules: id, literal slug prefix, normalized readers) is one table for
// both policy stores: on a git-backed source it is a derived copy of the
// approved `.gbrain/access.yml`, on a repo-less source it is the record. Every
// edit appends a row to access_policy_revisions (desired rules, how the change
// classified, who proposed and approved it). access_policy_state holds one
// row per source with a policy; rulebook installs lock it FOR UPDATE and every
// page write in that source takes it FOR SHARE before stamping, so a page
// written during an install is either stamped from the new rules or committed
// before the install's re-check pass, which restamps it.
//
// pages.folder_rule_ids is derived: the source-qualified ids
// (`<source>:<rule>`) of every applied rule whose prefix the slug starts with,
// NULL when none. A trigger stamps it on every insert and on every change of
// slug or source, reading the applied rulebook inside the write's own
// transaction, so put_page, sync, cycles, renames and derived writers all get
// it with no code path to miss. access_pending_coverage lists prefixes that
// read as nobody: a narrowing still being stamped ('pending') or a policy file
// that does not validate ('invalid'; prefix '' covers the whole source). The
// read-time lineage test treats an origin under a folder rule or a covered
// prefix as restricted. Nothing is rewritten on upgrade: with no rule, every
// page keeps folder_rule_ids NULL.
// No schema.sql mirror: like v281, these exist only through migrations.
// Provisional number: renumbered at the merge slot.
export const v282: Migration = {
  version: 282,
  name: 'folder_access_rules',
  idempotent: true,
  sql: `
ALTER TABLE pages ADD COLUMN IF NOT EXISTS folder_rule_ids TEXT[];
CREATE INDEX IF NOT EXISTS pages_folder_rule_ids_gin ON pages USING gin (folder_rule_ids) WHERE folder_rule_ids IS NOT NULL;
CREATE TABLE IF NOT EXISTS access_policy_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_rules (
  source_id TEXT NOT NULL REFERENCES access_policy_state(source_id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK (rule_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  prefix TEXT NOT NULL CHECK (length(prefix) <= 512 AND prefix ~ '^([a-z0-9][a-z0-9._-]*/)+$' AND position('..' in prefix) = 0),
  readable_by TEXT[] NOT NULL,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  PRIMARY KEY (source_id, rule_id)
);
CREATE TABLE IF NOT EXISTS access_policy_revisions (
  source_id TEXT NOT NULL REFERENCES access_policy_state(source_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision > 0),
  rules JSONB NOT NULL,
  digest TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('narrowing', 'widening', 'mixed', 'unchanged')),
  origin TEXT NOT NULL,
  operation_id TEXT,
  proposed_by TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  PRIMARY KEY (source_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS access_policy_revisions_operation_idx ON access_policy_revisions (operation_id) WHERE operation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS access_pending_coverage (
  source_id TEXT NOT NULL REFERENCES access_policy_state(source_id) ON DELETE CASCADE,
  prefix TEXT NOT NULL CHECK (prefix = '' OR (length(prefix) <= 512 AND prefix ~ '^([a-z0-9][a-z0-9._-]*/)+$' AND position('..' in prefix) = 0)),
  reason TEXT NOT NULL CHECK (reason IN ('pending', 'invalid')),
  revision BIGINT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, prefix, reason)
);
CREATE TABLE IF NOT EXISTS access_policy_migrations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES access_policy_state(source_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('to_git', 'to_database')),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'exported', 'committed', 'switched')),
  receipts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION gbrain_access_folder_rules(p_source TEXT, p_slug TEXT) RETURNS TEXT[]
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
  SELECT array_agg(p_source || ':' || r.rule_id ORDER BY r.rule_id COLLATE "C")
    FROM access_rules r WHERE r.source_id = p_source AND starts_with(p_slug, r.prefix)
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_pending_covers(p_source TEXT, p_slug TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id = p_source AND starts_with(p_slug, c.prefix))
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_stamp_folder_rules() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM access_policy_state s WHERE s.source_id = NEW.source_id) THEN
    PERFORM 1 FROM access_policy_state s WHERE s.source_id = NEW.source_id FOR SHARE;
    NEW.folder_rule_ids := gbrain_access_folder_rules(NEW.source_id, NEW.slug);
  ELSE
    NEW.folder_rule_ids := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS pages_access_stamp_folder_rules ON pages;
CREATE TRIGGER pages_access_stamp_folder_rules BEFORE INSERT OR UPDATE OF slug, source_id, folder_rule_ids ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_stamp_folder_rules();
CREATE OR REPLACE FUNCTION gbrain_access_origin_restricted(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug = fm->>'source_slug'
        AND (o.frontmatter ? 'readable_by' OR o.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(o.source_id, o.slug))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (i.frontmatter ? 'readable_by' OR i.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(i.source_id, i.slug)
            OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id AND io.slug = i.frontmatter->>'source_slug'
              AND (io.frontmatter ? 'readable_by' OR io.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(io.source_id, io.slug))))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug = fm->'event'->>'depth'
        AND (c.frontmatter ? 'readable_by' OR c.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(c.source_id, c.slug))) THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id
      AND (d.frontmatter ? 'readable_by' OR d.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(d.source_id, d.slug))
      AND d.slug = ANY(ARRAY(SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS declared(slug))));
  END IF;
  RETURN false;
END
$fn$;
DROP TRIGGER IF EXISTS access_rules_mark_restricted ON access_rules;
CREATE TRIGGER access_rules_mark_restricted AFTER INSERT ON access_rules
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_mark_restricted();
DROP TRIGGER IF EXISTS access_pending_coverage_mark_restricted ON access_pending_coverage;
CREATE TRIGGER access_pending_coverage_mark_restricted AFTER INSERT ON access_pending_coverage
  FOR EACH ROW EXECUTE FUNCTION gbrain_access_mark_restricted();
`,
};
