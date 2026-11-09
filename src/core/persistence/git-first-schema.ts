/**
 * Wave C 1H (large-pages spec §2.7, §3.1): the git-first strict write path's tables. Shared by the git-first migration
 * and both schema blobs (`bun run build:schema`).
 *
 * - `page_pending_heads`: one row per page of a strict source, the newest committed head not yet indexed (spec §3.1 step 7).
 *   Metadata only, derived from the committed file and rebuildable from Git: the commit, the blob, the revision the
 *   flip will install, the body's size and sha256, its tail digest, title, type, frontmatter and lead, and the access
 *   state the flip checks. `page_id` is NULL for a never-indexed create. It is written in the door transaction, after
 *   the ref compare-and-swap, and deleted by the index flip (git-first.ts, index-split-page.ts).
 * - `page_upload_spools` and `page_upload_spool_parts`: an upload session of a strict source keeps its bytes in a 0600
 *   file under the owner's persistence home; the database records which host holds the file and, per part, its index,
 *   offset, length and sha256, never its bytes (page-upload-spool.ts). `removed_at` is set once the file is gone; a
 *   session's quota is released only then.
 *
 * - `persistence_effects_index_barrier` (eng-r3-outside-4, INDEX_EFFECT_BARRIER_SQL, migration-only: the blobs create
 *   persistence_effects before effect-schema.ts adds next_attempt_at): an `index-split-page` effect always stores
 *   `next_attempt_at = 'infinity'` and keeps the time it is due in `data.due_at`. A released binary's claim selects only
 *   effects with `next_attempt_at <= now()` and sends a kind it does not know to its embedding step, so it never selects
 *   index work, even when it releases an abandoned claim, requeues the effect or starts after activation. Only a claim
 *   that knows the kind reads `due_at` (effect-journal.ts claimPersistenceEffect).
 *
 * RLS is enabled on each table as on every public table (doctor `rls`), only when the role bypasses it (the page-body pattern).
 */
export const GIT_FIRST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_pending_heads (
  source_id    TEXT        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug         TEXT        NOT NULL,
  page_id      INTEGER     REFERENCES pages(id) ON DELETE CASCADE,
  request_id   UUID        NOT NULL,
  commit_oid   TEXT        NOT NULL,
  head_oid     TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  revision     UUID        NOT NULL,
  body_bytes   BIGINT      NOT NULL CHECK (body_bytes >= 0),
  body_sha256  BYTEA       NOT NULL CHECK (octet_length(body_sha256) = 32),
  tail_sha256  BYTEA       CHECK (tail_sha256 IS NULL OR octet_length(tail_sha256) = 32),
  title        TEXT,
  type         TEXT,
  frontmatter  JSONB,
  lead_text    TEXT,
  access_state TEXT        NOT NULL DEFAULT 'world' CHECK (access_state IN ('world','private')),
  hold_code    TEXT,
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, slug)
);
CREATE INDEX IF NOT EXISTS page_pending_heads_request ON page_pending_heads (request_id);
CREATE TABLE IF NOT EXISTS page_upload_spools (
  staging_id UUID        PRIMARY KEY REFERENCES page_body_stagings(id) ON DELETE CASCADE,
  host_id    UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS page_upload_spools_present ON page_upload_spools (host_id) WHERE removed_at IS NULL;
CREATE TABLE IF NOT EXISTS page_upload_spool_parts (
  staging_id UUID    NOT NULL REFERENCES page_upload_spools(staging_id) ON DELETE CASCADE,
  part_no    INTEGER NOT NULL CHECK (part_no >= 0),
  byte_start BIGINT  NOT NULL CHECK (byte_start >= 0),
  byte_len   INTEGER NOT NULL CHECK (byte_len BETWEEN 1 AND 4194304),
  sha256     BYTEA   NOT NULL CHECK (octet_length(sha256) = 32),
  PRIMARY KEY (staging_id, part_no)
);
DO $rls$
DECLARE target text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    FOREACH target IN ARRAY ARRAY['page_pending_heads','page_upload_spools','page_upload_spool_parts'] LOOP
      IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema() AND c.relname = target AND c.relkind = 'r' AND NOT c.relrowsecurity) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
      END IF;
    END LOOP;
  END IF;
END $rls$;
`;

export const INDEX_EFFECT_BARRIER_SQL = `
CREATE OR REPLACE FUNCTION gbrain_index_effect_barrier() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
  BEGIN
    IF NEW.next_attempt_at IS DISTINCT FROM 'infinity'::timestamptz THEN
      NEW.data := jsonb_set(COALESCE(NEW.data, '{}'::jsonb), '{due_at}', to_jsonb(COALESCE(NEW.next_attempt_at, now())));
      NEW.next_attempt_at := 'infinity'::timestamptz;
    END IF;
    RETURN NEW;
  END $fn$;
DROP TRIGGER IF EXISTS persistence_effects_index_barrier ON persistence_effects;
CREATE TRIGGER persistence_effects_index_barrier BEFORE INSERT OR UPDATE OF next_attempt_at ON persistence_effects
  FOR EACH ROW WHEN (NEW.kind = 'index-split-page') EXECUTE FUNCTION gbrain_index_effect_barrier();
`;
