import type { Migration } from './types.ts';

export const v043: Migration = {
  version: 43,
  name: 'takes_resolved_quality_and_drift_decisions',
  // v0.30.0 (Slice A1, Universal Takes Epistemology wave). Bundles ALL schema
  // for the v0.30 release wave so A2/B1/C1 add no migrations (codex F6 fix:
  // schema-first ordering eliminates the cross-lane migrate.ts contention).
  // Originally landed as v40 in the v0.30.0 branch; renumbered to v43 on
  // merge with master after master claimed v40-v42 with the v0.29 +
  // v0.29.1 salience-and-recency wave. Migration runner sorts by version
  // number, so renumbering is a pure-rename — no semantic change.
  //
  // 1. takes.resolved_quality TEXT — 3-state outcome label (correct/incorrect/
  //    partial) sitting alongside existing resolved_outcome BOOLEAN. Boolean
  //    stays for back-compat reads; quality is the new source of truth for
  //    calibration math. Backfill maps legacy resolved_outcome → quality.
  //
  // 2. takes_resolution_consistency CHECK constraint — fails contradictory
  //    states like (quality='correct', outcome=false). 'partial' maps to
  //    outcome=NULL because partial isn't a binary outcome. Added AFTER the
  //    backfill so existing rows pass.
  //
  // 3. idx_takes_scorecard partial index on (holder, kind, resolved_quality)
  //    WHERE resolved_quality IS NOT NULL — scorecard hot path. ~5KB on a
  //    50K-row brain; makes scorecard O(log n) instead of full scan.
  //
  // 4. drift_decisions audit table — consumed by Slice C1 (v0.30.3) when
  //    drift LLM judge ships. Defined here so C1 carries no migration.
  //    Sized for one row per drift recommendation (insert-only, never
  //    updated except for applied_at/applied_by when --auto-update lands).
  sql: `
      -- Step 1: add resolved_quality column with kind-of-outcome CHECK.
      -- The (quality, outcome) consistency constraint comes AFTER the backfill
      -- (Step 3) so existing legacy rows don't fail the new constraint.
      ALTER TABLE takes
        ADD COLUMN IF NOT EXISTS resolved_quality TEXT
          CHECK (resolved_quality IS NULL OR resolved_quality IN ('correct','incorrect','partial'));

      -- Step 2: backfill from legacy boolean. Idempotent: only writes rows
      -- where quality is still NULL and outcome is set. Re-runs are no-ops.
      UPDATE takes
      SET resolved_quality = CASE resolved_outcome
        WHEN true  THEN 'correct'
        WHEN false THEN 'incorrect'
      END
      WHERE resolved_outcome IS NOT NULL AND resolved_quality IS NULL;

      -- Step 3: (quality, outcome) consistency constraint. Drop-then-recreate
      -- so re-runs converge. The named constraint lets us evolve it later.
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolution_consistency;
      ALTER TABLE takes ADD CONSTRAINT takes_resolution_consistency CHECK (
        (resolved_quality IS NULL     AND resolved_outcome IS NULL)
        OR (resolved_quality = 'correct'   AND resolved_outcome = true)
        OR (resolved_quality = 'incorrect' AND resolved_outcome = false)
        OR (resolved_quality = 'partial'   AND resolved_outcome IS NULL)
      );

      -- Step 4: scorecard hot path. Partial index keeps footprint proportional
      -- to resolved-take count, not table size.
      CREATE INDEX IF NOT EXISTS idx_takes_scorecard
        ON takes (holder, kind, resolved_quality)
        WHERE resolved_quality IS NOT NULL;

      -- Step 5: drift_decisions audit table (consumed by Slice C1 in v0.30.3).
      CREATE TABLE IF NOT EXISTS drift_decisions (
        id                  BIGSERIAL   PRIMARY KEY,
        take_id             BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
        page_id             INTEGER     NOT NULL,
        row_num             INTEGER     NOT NULL,
        recommended_weight  REAL        NOT NULL CHECK (recommended_weight >= 0 AND recommended_weight <= 1),
        reasoning           TEXT,
        decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at          TIMESTAMPTZ,
        applied_by          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drift_decisions_take       ON drift_decisions(take_id);
      CREATE INDEX IF NOT EXISTS idx_drift_decisions_decided_at ON drift_decisions(decided_at DESC);

      -- RLS for the new table (Postgres-only — PGLite has no RLS engine).
      -- Mirrors the v37 takes/synthesis_evidence pattern: only flip RLS on
      -- when running as a BYPASSRLS role so non-BYPASSRLS apps still read.
      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF has_bypass THEN
          ALTER TABLE drift_decisions ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
  sqlFor: {
    // PGLite: same DDL minus the RLS DO-block. Single-tenant by definition.
    pglite: `
        ALTER TABLE takes
          ADD COLUMN IF NOT EXISTS resolved_quality TEXT
            CHECK (resolved_quality IS NULL OR resolved_quality IN ('correct','incorrect','partial'));

        UPDATE takes
        SET resolved_quality = CASE resolved_outcome
          WHEN true  THEN 'correct'
          WHEN false THEN 'incorrect'
        END
        WHERE resolved_outcome IS NOT NULL AND resolved_quality IS NULL;

        ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolution_consistency;
        ALTER TABLE takes ADD CONSTRAINT takes_resolution_consistency CHECK (
          (resolved_quality IS NULL     AND resolved_outcome IS NULL)
          OR (resolved_quality = 'correct'   AND resolved_outcome = true)
          OR (resolved_quality = 'incorrect' AND resolved_outcome = false)
          OR (resolved_quality = 'partial'   AND resolved_outcome IS NULL)
        );

        CREATE INDEX IF NOT EXISTS idx_takes_scorecard
          ON takes (holder, kind, resolved_quality)
          WHERE resolved_quality IS NOT NULL;

        CREATE TABLE IF NOT EXISTS drift_decisions (
          id                  BIGSERIAL   PRIMARY KEY,
          take_id             BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
          page_id             INTEGER     NOT NULL,
          row_num             INTEGER     NOT NULL,
          recommended_weight  REAL        NOT NULL CHECK (recommended_weight >= 0 AND recommended_weight <= 1),
          reasoning           TEXT,
          decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          applied_at          TIMESTAMPTZ,
          applied_by          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_drift_decisions_take       ON drift_decisions(take_id);
        CREATE INDEX IF NOT EXISTS idx_drift_decisions_decided_at ON drift_decisions(decided_at DESC);
      `,
  },
};
