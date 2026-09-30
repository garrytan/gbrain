import type { Migration } from './types.ts';

export const v030: Migration = {
  version: 30,
  name: 'dream_verdicts_table',
  // v0.23 synthesize phase: cache for "is this transcript worth processing?"
  // verdict from the cheap Haiku judge. Distinct from raw_data (page-scoped);
  // transcripts aren't pages. Keyed by (file_path, content_hash) so edited
  // transcripts re-judge automatically. Backfill re-runs hit cache instead
  // of paying for Haiku 100x.
  sql: `
      CREATE TABLE IF NOT EXISTS dream_verdicts (
        file_path        TEXT        NOT NULL,
        content_hash     TEXT        NOT NULL,
        worth_processing BOOLEAN     NOT NULL,
        reasons          JSONB,
        judged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (file_path, content_hash)
      );
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF has_bypass THEN
          ALTER TABLE dream_verdicts ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
};
