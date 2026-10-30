/** The counter function alone: replacing it takes no table lock (#7636). */
export const GIT_CANONICAL_COUNT_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_count_git_canonical_sources() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  -- #7636: a count over the rows row-level security lets this role see would undercount and could switch G7a off.
  IF row_security_active('sources') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: writer state is unreadable to this database role',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:unreadable_state',
      DETAIL=jsonb_build_object('op',TG_OP,'relationship','unreadable_state','state','sources')::text;
  END IF;
  INSERT INTO git_canonical_brain(singleton, strict_sources)
    VALUES (1, (SELECT count(*) FROM sources WHERE config->>'canonical' = 'git'))
    ON CONFLICT (singleton) DO UPDATE SET strict_sources = EXCLUDED.strict_sources;
  RETURN NULL;
END $fn$;
`;
/**
 * Git-canonical memory, wave G7a: the fast path of the git-canonical database fence. `git_canonical_brain.strict_sources`
 * counts the sources whose row says `config.canonical = "git"`, kept by row triggers on `sources` that fire only when
 * that key changes (or a strict row is inserted or deleted), so routine source updates never touch it. The fence itself is
 * a branch of the managed writer guard (writer-guard-schema.ts): while the count is zero it costs one indexed probe and
 * refuses nothing. Shared by migration v272 and both schema blobs (`bun run build:schema`).
 *
 * Additive: no page or source row is read for anything but the count, and nothing is backfilled or rewritten. RLS is
 * enabled on the counter as on every public table (doctor `rls`), only when the role bypasses it (the page-body pattern).
 */
export const GIT_CANONICAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS git_canonical_brain (
  singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  strict_sources INTEGER NOT NULL DEFAULT 0 CHECK (strict_sources >= 0)
);
${GIT_CANONICAL_COUNT_FUNCTION_SQL}DROP TRIGGER IF EXISTS git_canonical_sources_count_insert ON sources;
CREATE TRIGGER git_canonical_sources_count_insert AFTER INSERT ON sources
  FOR EACH ROW WHEN (NEW.config->>'canonical' = 'git') EXECUTE FUNCTION gbrain_count_git_canonical_sources();
DROP TRIGGER IF EXISTS git_canonical_sources_count_update ON sources;
CREATE TRIGGER git_canonical_sources_count_update AFTER UPDATE ON sources
  FOR EACH ROW WHEN (OLD.config->>'canonical' IS DISTINCT FROM NEW.config->>'canonical') EXECUTE FUNCTION gbrain_count_git_canonical_sources();
DROP TRIGGER IF EXISTS git_canonical_sources_count_delete ON sources;
CREATE TRIGGER git_canonical_sources_count_delete AFTER DELETE ON sources
  FOR EACH ROW WHEN (OLD.config->>'canonical' = 'git') EXECUTE FUNCTION gbrain_count_git_canonical_sources();
INSERT INTO git_canonical_brain(singleton, strict_sources)
  VALUES (1, (SELECT count(*) FROM sources WHERE config->>'canonical' = 'git'))
  ON CONFLICT (singleton) DO UPDATE SET strict_sources = EXCLUDED.strict_sources;
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper))
    AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relname = 'git_canonical_brain' AND c.relkind = 'r' AND NOT c.relrowsecurity) THEN
    ALTER TABLE git_canonical_brain ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
