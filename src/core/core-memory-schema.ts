/**
 * Core memory storage DDL: one canonical copy used by the schema migration
 * and, through scripts/build-schema.ts FRAGMENTS, by fresh-install DDL.
 *
 * core_edit_notices records each remote edit to an always-loaded core page
 * (memory.core.remote_edit = notify). The rendered core block shows pending
 * rows until the owner acknowledges them up to a reviewed revision with
 * `gbrain core ack <slug> --revision <token>`. base_text keeps the rendered
 * page before the edit (bounded by the core budget) so `gbrain core diff`
 * can show what changed. No foreign key to pages: a
 * notice outlives a rename (page_id) and is closed when the page is
 * un-cored or deleted.
 */

export const CORE_EDIT_NOTICES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS core_edit_notices (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  slug            TEXT NOT NULL,
  page_id         BIGINT,
  revision        TEXT,
  base_revision   TEXT,
  base_text       TEXT,
  actor           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS core_edit_notices_pending_idx ON core_edit_notices (source_id, slug, id) WHERE acked_at IS NULL;
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE core_edit_notices ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
