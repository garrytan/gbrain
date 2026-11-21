import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Duplicate people PR 2 (plan autoplan-20261117192252, Decision B): the owner's "same person" and "different people"
// decisions about a group of person or company pages, kept by (source_id, slug) so a decision outlives a page that is
// re-imported under a new id or not imported yet. A "same" decision is materialized into entity_identities rows
// (established_by 'dedupe:confirm') only while its pages exist; a "different" decision keeps the pair out of
// `gbrain dedupe --preview`. On a brain with a repository the record is `.gbrain/identity/<decision_id>.md` in the
// brain's home source and these rows are its projection (origin 'git', with the blob they were read from); on a brain
// with no repository the rows are the record (origin 'database'). Slugs and verdicts only, no page text. No schema.sql
// mirror, like v137's entity_identities: the table exists only through migrations.
export const v325: Migration = {
  version: 325,
  name: 'entity_identity_reviews',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS entity_identity_reviews (
  decision_id         TEXT PRIMARY KEY,
  verdict             TEXT NOT NULL CHECK (verdict IN ('same', 'different')),
  members             JSONB NOT NULL,
  group_id            TEXT,
  entity_id           TEXT,
  canonical_source_id TEXT,
  canonical_slug      TEXT,
  decided_by          TEXT NOT NULL,
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin              TEXT NOT NULL CHECK (origin IN ('database', 'git')),
  home_source_id      TEXT,
  git_blob            TEXT
);
CREATE INDEX IF NOT EXISTS entity_identity_reviews_entity_idx ON entity_identity_reviews (entity_id) WHERE entity_id IS NOT NULL;
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE entity_identity_reviews ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
