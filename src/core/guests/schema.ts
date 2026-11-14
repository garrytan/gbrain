/**
 * Guest notes (GBRA-504): the database records behind a guest source. Applied by
 * migration v312 only (like the trust DDL it is not in the schema blob; a fresh
 * install replays every migration).
 *
 * - guest_sources: which sources are guest sources, who may write them
 *   (principal strings `<kind>:<id>`, the persistence attribution principal,
 *   e.g. `oauth_client:<client id>`) and the tier ceiling their pages keep. The
 *   trust trigger (trust/schema.ts GUEST_AWARE_STAMP_TIER_FUNCTION) reads it.
 * - guest_marks: who a guest page was saved for, from which group, when and by
 *   which writer. Immutable (UPDATE refused); a row leaves only with its page.
 * - guest_promotions: an owner kept a guest page as an owner page.
 *
 * A guest source is database-only: gbrain_guard_guest_records refuses a
 * local_path on it, and refuses listing a source that has one.
 */
import { TRUST_TIERS } from '../trust/tier.ts';

export const GUEST_RECORD_TABLES = ['guest_sources', 'guest_marks', 'guest_promotions'] as const;

const GUARD_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_guard_guest_records() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'guest_marks' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='guest_mark_immutable: a guest mark is never changed; it leaves only with its page',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='guest_source_guard';
  ELSIF TG_TABLE_NAME = 'sources' THEN
    IF NEW.local_path IS NOT NULL AND EXISTS (SELECT 1 FROM guest_sources g WHERE g.source_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='guest_source_database_only: a guest source is database-only and takes no local path or repository',
        TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='guest_source_guard', DETAIL=jsonb_build_object('source',NEW.id)::text;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM sources s WHERE s.id = NEW.source_id AND s.local_path IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='guest_source_database_only: a source with a local path or repository cannot become a guest source',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='guest_source_guard', DETAIL=jsonb_build_object('source',NEW.source_id)::text;
  END IF;
  RETURN NEW;
END $fn$`;

export const GUEST_NOTES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guest_sources (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  writers TEXT[] NOT NULL DEFAULT '{}',
  trust_ceiling TEXT NOT NULL DEFAULT 'external_untrusted' CHECK (trust_ceiling IN (${TRUST_TIERS.map(tier => `'${tier}'`).join(', ')})),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guest_marks (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  slug_at_write TEXT NOT NULL,
  audience_member TEXT NOT NULL,
  group_slug TEXT NOT NULL,
  sender_label TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL,
  writer_kind TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_marks_audience_saved_idx ON guest_marks (audience_member, saved_at);
CREATE TABLE IF NOT EXISTS guest_promotions (
  id BIGSERIAL PRIMARY KEY,
  guest_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_source_id TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  promoted_by_kind TEXT NOT NULL,
  promoted_by_id TEXT NOT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS guest_promotions_guest_page_idx ON guest_promotions (guest_page_id);
${GUARD_FUNCTION};
DROP TRIGGER IF EXISTS guest_marks_immutable ON guest_marks;
CREATE TRIGGER guest_marks_immutable BEFORE UPDATE ON guest_marks FOR EACH ROW EXECUTE FUNCTION gbrain_guard_guest_records();
DROP TRIGGER IF EXISTS guest_source_database_only ON sources;
CREATE TRIGGER guest_source_database_only BEFORE UPDATE OF local_path ON sources FOR EACH ROW EXECUTE FUNCTION gbrain_guard_guest_records();
DROP TRIGGER IF EXISTS guest_source_database_only ON guest_sources;
CREATE TRIGGER guest_source_database_only BEFORE INSERT OR UPDATE OF source_id ON guest_sources FOR EACH ROW EXECUTE FUNCTION gbrain_guard_guest_records();
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ${GUEST_RECORD_TABLES.map(table => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).join('\n    ')}
  END IF;
END $rls$;
`;
