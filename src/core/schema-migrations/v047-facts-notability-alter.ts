import type { Migration } from './types.ts';

export const v047: Migration = {
  version: 47,
  name: 'facts_notability_alter',
  // v0.31.2 (B2 ship-blocker fix). Renumbered from v46 → v47 after the
  // merge from master picked up v0.31.3's mcp_request_log_params_jsonb_normalize
  // at v46. facts.notability column shipped via v45's inline CREATE TABLE
  // on fresh installs, but every brain that ran v45 BEFORE notability
  // landed in v45's blob is now missing the column. INSERT crashes with
  // "column does not exist" on first sync after upgrade.
  //
  // This migration is the ALTER counterpart for those existing brains.
  // Idempotent under all states:
  //   - Fresh install (v45 already added column): ADD COLUMN IF NOT EXISTS
  //     no-ops; named CHECK probe finds existing constraint → skip.
  //   - Old brain (no column): ADD COLUMN adds it with NOT NULL DEFAULT;
  //     named CHECK probe finds nothing → adds CHECK.
  //   - Partial state (column exists, no CHECK): ADD COLUMN no-ops;
  //     CHECK probe adds the named constraint.
  //
  // CHECK constraint is named `facts_notability_check` (named, not autogen)
  // so the idempotency probe can find it deterministically. If v45 inline
  // already created an autogen CHECK with identical semantics, the named
  // one is additive and non-conflicting (Postgres allows multiple CHECKs
  // covering the same predicate).
  //
  // Both engines run the same SQL — PGLite is real Postgres in WASM and
  // supports DO $$ blocks. PGLite users with older persistent brains hit
  // the same bug.
  sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS notability TEXT NOT NULL DEFAULT 'medium';

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'facts_notability_check'
            AND conrelid = 'facts'::regclass
        ) THEN
          ALTER TABLE facts ADD CONSTRAINT facts_notability_check
            CHECK (notability IN ('high','medium','low'));
        END IF;
      END $$;
    `,
};
