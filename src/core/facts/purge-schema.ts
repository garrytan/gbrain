/**
 * Purge ledgers and the resurrection guards that read them. One canonical copy
 * used by the schema migration and, through scripts/build-schema.ts FRAGMENTS,
 * by fresh-install DDL.
 *
 * - `fact_purges`: a text-free tombstone per purged claim fingerprint
 *   (gbrain_fact_fingerprint), keyed like `fact_withdrawals`. The facts
 *   guard raises typed `purged_content` for a matching insert or claim
 *   update, whatever its expired_at, so `INSERT ... RETURNING` callers never
 *   see zero rows silently.
 * - `take_purges`: the same tombstone for verbatim take copies; canonical
 *   projections and the takes guard consult it, so a stale takes fence cannot
 *   re-project a purged claim.
 * - `page_purges`: `gbrain delete <slug> --purge` records the purged page's
 *   content hash. A page write whose content hash matches, under any slug,
 *   raises `purged_content`; `gbrain pages unpurge` clears it.
 * - `derivation_inputs`: complete row -> input edges written by every deriver
 *   (`recordDerivationInputs`). Purge walks them transitively to hide derived
 *   rows and mark them `needs_rederive` before cascades delete the evidence.
 * - `needs_rederive`: derived rows a purge hid; a deriver regenerates them from
 *   surviving inputs and deletes the marker.
 *
 * A fingerprint of a short claim is guessable; the ledger proves a claim was
 * purged to someone who already knows it, never what it said.
 */

const RLS = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const MEMORY_PURGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fact_purges (
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  visibility  TEXT NOT NULL CHECK (visibility IN ('private','world')),
  subject     TEXT NOT NULL DEFAULT '*',
  fact_hash   TEXT NOT NULL,
  request_id  UUID,
  actor       TEXT,
  reason      TEXT,
  purged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, visibility, subject, fact_hash)
);
${RLS('fact_purges')}
CREATE TABLE IF NOT EXISTS take_purges (
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL DEFAULT '*',
  claim_hash  TEXT NOT NULL,
  request_id  UUID,
  purged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, subject, claim_hash)
);
${RLS('take_purges')}
CREATE TABLE IF NOT EXISTS page_purges (
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  slug         TEXT NOT NULL,
  request_id   UUID,
  purged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, content_hash)
);
${RLS('page_purges')}
CREATE TABLE IF NOT EXISTS derivation_inputs (
  derived_table TEXT NOT NULL,
  derived_id    TEXT NOT NULL,
  input_table   TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (derived_table, derived_id, input_table, input_id)
);
CREATE INDEX IF NOT EXISTS idx_derivation_inputs_input ON derivation_inputs (input_table, input_id);
${RLS('derivation_inputs')}
CREATE TABLE IF NOT EXISTS needs_rederive (
  derived_table TEXT NOT NULL,
  derived_id    TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  request_id    UUID,
  reason        TEXT NOT NULL,
  marked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (derived_table, derived_id)
);
${RLS('needs_rederive')}
`;

/**
 * The guards. Installed by the migration only (facts and takes are created by
 * migrations, not schema.sql). Each serializes with a purge through a shared
 * lock on the source row, which the purge holds FOR UPDATE while it writes the
 * ledger and deletes the rows.
 */
export const MEMORY_PURGE_GUARD_SQL = `
CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
  BEGIN
    PERFORM id FROM sources WHERE id = NEW.source_id FOR SHARE;
    IF EXISTS (SELECT 1 FROM fact_purges
      WHERE source_id = NEW.source_id AND visibility = NEW.visibility
        AND (subject = '*' OR subject = NEW.entity_slug)
        AND fact_hash = gbrain_fact_fingerprint(NEW.fact)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'purged_content: this claim was purged from this source and cannot be saved again',
        DETAIL = json_build_object('table', 'facts', 'hash8', left(gbrain_fact_fingerprint(NEW.fact), 8))::text;
    END IF;
    RETURN NEW;
  END
  $fn$;
DROP TRIGGER IF EXISTS facts_refuse_purged ON facts;
CREATE TRIGGER facts_refuse_purged BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug ON facts
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_fact();
CREATE OR REPLACE FUNCTION gbrain_refuse_purged_take() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
  DECLARE src TEXT; subj TEXT;
  BEGIN
    SELECT p.source_id, p.slug INTO src, subj FROM pages p WHERE p.id = NEW.page_id;
    IF src IS NOT NULL AND EXISTS (SELECT 1 FROM take_purges
      WHERE source_id = src AND (subject = '*' OR subject = subj)
        AND claim_hash = gbrain_fact_fingerprint(NEW.claim)) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'purged_content: this take claim was purged from this source and cannot be saved again',
        DETAIL = json_build_object('table', 'takes', 'hash8', left(gbrain_fact_fingerprint(NEW.claim), 8))::text;
    END IF;
    RETURN NEW;
  END
  $fn$;
DROP TRIGGER IF EXISTS takes_refuse_purged ON takes;
CREATE TRIGGER takes_refuse_purged BEFORE INSERT OR UPDATE OF claim, page_id ON takes
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_take();
CREATE OR REPLACE FUNCTION gbrain_refuse_purged_page() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
  BEGIN
    -- No column list on the trigger: a column-scoped trigger would pin pages.source_id and content_hash.
    IF NEW.content_hash IS NOT NULL
      AND (TG_OP = 'INSERT' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.source_id IS DISTINCT FROM OLD.source_id)
      AND EXISTS (SELECT 1 FROM page_purges WHERE source_id = NEW.source_id AND content_hash = NEW.content_hash) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'purged_content: this page content was purged from this source and cannot be saved again',
        DETAIL = json_build_object('table', 'pages', 'hash8', left(NEW.content_hash, 8))::text;
    END IF;
    RETURN NEW;
  END
  $fn$;
DROP TRIGGER IF EXISTS pages_refuse_purged ON pages;
CREATE TRIGGER pages_refuse_purged BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_page();
`;
