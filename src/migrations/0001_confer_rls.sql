-- 0001_confer_rls.sql
-- Confer fork migration. Adds source-isolation RLS policies on top of
-- STATUS 2026-05-29: intentionally NOT wired into the migrate.ts runner. RLS here is
-- inert under the current superuser/BYPASSRLS role + the gbrain.allowed_sources GUC is
-- never set, so app-layer source scoping (operations.ts) is the real control. Activating
-- requires: non-BYPASSRLS role + SET LOCAL gbrain.allowed_sources per request + WITH CHECK.
-- Treat as a gated, deliberate prod op — see decision notes. 0002/0003/0004 ARE auto-run (v108-110).
-- upstream gbrain's existing FORCE ROW LEVEL SECURITY (upstream enables RLS
-- on all tables but ships zero policies, relying on app-layer filtering +
-- BYPASSRLS on the admin role).
--
-- Confer adds policies so that non-admin connections see only rows whose
-- source_id is in the session's allowed_sources set (set by gbrain serve-http
-- from the per-token authorization).
--
-- Per spec §6.3 Layer 3 (DB defense-in-depth keyed on source_id).
-- Maintained across upstream rebases.

CREATE POLICY confer_source_isolation_pages ON pages
  USING (
    source_id = ANY(
      COALESCE(
        string_to_array(current_setting('gbrain.allowed_sources', true), ','),
        ARRAY[]::text[]
      )
    )
  );

CREATE POLICY confer_source_isolation_content_chunks ON content_chunks
  USING (
    page_id IN (
      SELECT id FROM pages
      WHERE source_id = ANY(
        COALESCE(
          string_to_array(current_setting('gbrain.allowed_sources', true), ','),
          ARRAY[]::text[]
        )
      )
    )
  );

CREATE POLICY confer_source_isolation_links ON links
  USING (
    from_page_id IN (
      SELECT id FROM pages
      WHERE source_id = ANY(
        COALESCE(
          string_to_array(current_setting('gbrain.allowed_sources', true), ','),
          ARRAY[]::text[]
        )
      )
    )
    AND to_page_id IN (
      SELECT id FROM pages
      WHERE source_id = ANY(
        COALESCE(
          string_to_array(current_setting('gbrain.allowed_sources', true), ','),
          ARRAY[]::text[]
        )
      )
    )
  );

CREATE POLICY confer_source_isolation_take_proposals ON take_proposals
  USING (
    source_id = ANY(
      COALESCE(
        string_to_array(current_setting('gbrain.allowed_sources', true), ','),
        ARRAY[]::text[]
      )
    )
  );
