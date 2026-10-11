/**
 * Temporal typed-edge storage DDL: one canonical copy used by the schema
 * migration and, through scripts/build-schema.ts FRAGMENTS, by fresh-install
 * DDL. Contract: docs/guides/temporal-edges.md and src/core/link-validity.ts.
 *
 * - link_transitions: dated start/end evidence for a relationship
 *   (from_page_id, to_page_id, link_type). Owned by the page that states it
 *   (origin_page_id; NULL for manual edges) and replaced with that page's
 *   derived links.
 * - link_relationships: the derived temporal state of each relationship, one
 *   row per read scope ('all' = every live origin, 'world' = evidence from
 *   private origins excluded). valid_ranges holds the stints; readers probe it
 *   by primary key. A relationship with no row reads as live.
 * - link_edge_proposals: contradiction proposals from the edge_contradictions
 *   dream phase, with their apply/undo state.
 * - graph_generation_seq: bumped whenever relationship state changes, so query
 *   caches can invalidate graph-dependent results.
 */

const rls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const LINK_TEMPORAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS link_transitions (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  from_page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('start','end')),
  occurred_on     DATE NOT NULL,
  date_precision  TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day','month','year')),
  producer        TEXT NOT NULL CHECK (producer IN ('timeline','explicit','frontmatter','manual','inline','dream')),
  origin_page_id  INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  line_hash       TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS link_transitions_identity_idx
  ON link_transitions (origin_page_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS link_transitions_relationship_idx ON link_transitions (from_page_id, to_page_id, link_type);
CREATE INDEX IF NOT EXISTS link_transitions_origin_idx ON link_transitions (origin_page_id);
${rls('link_transitions')}
CREATE TABLE IF NOT EXISTS link_relationships (
  from_page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('all','world')),
  source_id       TEXT NOT NULL,
  semantics       TEXT NOT NULL CHECK (semantics IN ('state','event')),
  valid_ranges    DATEMULTIRANGE NOT NULL,
  status_now      TEXT NOT NULL CHECK (status_now IN ('live','ended','ended_unknown_date','not_started','disputed','event')),
  first_start     DATE,
  last_start      DATE,
  last_end        DATE,
  undated_present INTEGER NOT NULL DEFAULT 0,
  undated_past    INTEGER NOT NULL DEFAULT 0,
  disputed        BOOLEAN NOT NULL DEFAULT false,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  evidence_hash   TEXT NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id, link_type, scope)
);
CREATE INDEX IF NOT EXISTS link_relationships_to_idx ON link_relationships (to_page_id, link_type, scope);
CREATE INDEX IF NOT EXISTS link_relationships_source_idx ON link_relationships (source_id, status_now);
${rls('link_relationships')}
CREATE TABLE IF NOT EXISTS link_edge_proposals (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL,
  from_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  a_to_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  b_to_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type          TEXT NOT NULL,
  evidence_hash      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected','undone','stale','reverted_by_user','undated_unresolved','ambiguous_same_date','compatible','error')),
  ending_to_page_id  INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  close_date         DATE,
  born_closed        BOOLEAN NOT NULL DEFAULT false,
  model              TEXT,
  confidence         REAL,
  cost_usd           REAL,
  generated_line     TEXT,
  detail             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash)
);
CREATE INDEX IF NOT EXISTS link_edge_proposals_status_idx ON link_edge_proposals (source_id, status, created_at);
${rls('link_edge_proposals')}
CREATE SEQUENCE IF NOT EXISTS graph_generation_seq;
`;

/** Assertion tense on links rows; applied by the migration and mirrored in schema.sql. */
export const LINK_ASSERTION_TENSE_SQL = `
ALTER TABLE links ADD COLUMN IF NOT EXISTS assertion_tense TEXT;
DO $tense$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'links_assertion_tense_check' AND conrelid = 'links'::regclass) THEN
    ALTER TABLE links ADD CONSTRAINT links_assertion_tense_check CHECK (assertion_tense IS NULL OR assertion_tense IN ('present','past'));
  END IF;
END $tense$;
`;
