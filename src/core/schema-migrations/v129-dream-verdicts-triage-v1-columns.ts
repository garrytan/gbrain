import type { Migration } from './types.ts';

export const v129: Migration = {
  version: 129,
  name: 'dream_verdicts_triage_v1_columns',
  // #4152 two-stage cascade: widens the boolean-era verdict cache into a
  // scored triage record — ordinal salience score in [0,1], content type,
  // candidate segments (verbatim quotes), entity candidates, plus the
  // judging model and triage prompt version that make a cached verdict
  // auditable and version-invalidatable. Legacy rows keep score NULL and
  // are treated as cache misses by runTriagePass (re-judged once, cheap).
  // No backfill by design; no index (the table is PK-probed only).
  //
  // dream_verdicts is migration-created on PGLite (v30, absent from
  // PGLITE_SCHEMA_SQL), so these columns take the COLUMN_EXEMPTIONS route
  // in test/schema-bootstrap-coverage.test.ts rather than bootstrap
  // probes — there is no schema-blob forward reference to trip on, and
  // every reader treats NULL as legacy-miss. Keep src/schema.sql (and the
  // regenerated schema-embedded.ts) in sync for fresh Postgres installs.
  //
  // Rollback note: the stored worth_processing boolean derives from the
  // FIXED 0.5 constant while the new runtime gate uses the configurable
  // dream.triage.threshold. A binary rollback to pre-#4152 code (which
  // trusts the boolean as permanent) after retuning the threshold gates
  // differently until content hashes change — sweep with
  // `gbrain dream retriage --force` (or clear scored rows) after such a
  // rollback.
  idempotent: true,
  sql: `
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS content_type TEXT;
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS segments JSONB;
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS entities JSONB;
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS model TEXT;
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS triage_version INT;
    `,
};
