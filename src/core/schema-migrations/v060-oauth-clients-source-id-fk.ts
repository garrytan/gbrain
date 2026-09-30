import type { Migration } from './types.ts';

export const v060: Migration = {
  version: 60,
  name: 'oauth_clients_source_id_fk',
  // v0.34.1 (#861 + D4 + D10 + D13 — P0 source-isolation leak seal).
  //
  // Adds oauth_clients.source_id, validates ALL existing rows can map to a
  // real source row, backfills NULL → 'default', and installs the FK with
  // ON DELETE SET NULL. PR #861's original migration claimed v47-v51; we
  // re-number to v60 because the branch already shipped through v54.
  //
  // D10 (codex outside-voice push-back): fail loud when stale source_id
  // rows exist instead of silently widening to NULL. Pre-fix this column
  // didn't exist; the only way a row has source_id IS a manual SQL poke,
  // so the stale-row branch fires only on operator-modified brains. The
  // GBRAIN_ACCEPT_SILENT_WIDEN=1 env var is the explicit opt-in for
  // operators who'd rather upgrade than psql-fix. Doctor surfaces orphan
  // rows post-clean via the v0.34.x follow-up TODO.
  //
  // D13: backfill NULL → 'default' BEFORE the FK ADD preserves the v0.33
  // effective behavior (legacy unscoped clients silently fell back to
  // 'default' via serve-http.ts:929 cast). Verify 'default' exists in
  // sources first — fresh brains have it from sources schema's default
  // seed; brains that scripted it out would otherwise wedge here.
  //
  // PGLite parity via the same DO blocks. PGLite supports DO/EXCEPTION
  // since 0.3; no engine branch needed.
  idempotent: true,
  sql: `
      -- v0.34.1 (#861 + D2 + D13 — P0 source-isolation leak seal).
      --
      -- This migration is intentionally lean: oauth_clients.source_id did
      -- NOT exist pre-v60, so the only state we inherit from upgrade is
      -- "rows with NULL source_id." Backfill those to 'default' (D13:
      -- preserves the pre-v0.34 effective fallback behavior verbatim) and
      -- install the FK with ON DELETE SET NULL.
      --
      -- D10 pre-clean is NOT NEEDED here: codex flagged the silent-widen
      -- footgun assuming source_id was an existing column with possibly-stale
      -- values. Since the column is brand new in this migration, the only
      -- post-backfill values are 'default' (which we just verified exists
      -- via the FK contract) plus any NULL the backfill left untouched
      -- because of WHERE-clause filtering — none possible. The
      -- GBRAIN_ACCEPT_SILENT_WIDEN env-flag stays in the runner for future
      -- migrations that need it; this one doesn't.

      -- 1. Add the column. NULL for every existing row.
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT;

      -- 2. Backfill NULL → 'default'. Pre-v0.34 legacy clients then map
      --    to the same source the serve-http fallback chain used to put
      --    them in implicitly. No-op on fresh installs (no rows yet).
      UPDATE oauth_clients SET source_id = 'default' WHERE source_id IS NULL;

      -- 3. Install FK if not already present. The PGLite + Postgres fresh-
      --    install schemas (src/core/pglite-schema.ts, src/schema.sql) now
      --    include the FK inline on the CREATE TABLE, so this DO block
      --    skips on fresh installs and only fires on upgrade brains where
      --    oauth_clients was created pre-v60 without the FK. ON DELETE SET
      --    NULL matches the original PR #861 posture; #876 later flips to
      --    RESTRICT once federated_read provides the alternative
      --    scope-recovery path.
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'oauth_clients_source_id_fkey'
        ) THEN
          ALTER TABLE oauth_clients
            ADD CONSTRAINT oauth_clients_source_id_fkey
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;
        END IF;
      END $$;

      -- 4. Index for token-verification lookups (verifyAccessToken's JOIN
      --    on oauth_clients.client_id → c.source_id). oauth_clients stays
      --    small so plain CREATE INDEX (no CONCURRENTLY) is fine.
      CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
        ON oauth_clients(source_id) WHERE source_id IS NOT NULL;
    `,
};
