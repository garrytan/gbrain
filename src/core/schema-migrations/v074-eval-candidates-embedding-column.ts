import type { Migration } from './types.ts';

export const v074: Migration = {
  version: 74,
  name: 'eval_candidates_embedding_column',
  // v0.36.3.0 (D16 / CDX-10): persist the resolved embedding column on
  // each eval_candidates row so replay against a captured query uses
  // the column that was active at capture time — not whichever column
  // is current local default. Without this, switching
  // `search_embedding_column` between capture and replay produces
  // false-positive "regressions" that are just column changes.
  //
  // Nullable for back-compat: pre-v0.36 rows have NULL; replay treats
  // NULL as "use current default" so existing captures keep working
  // exactly as before the migration.
  //
  // Renumbered v68→v74 during the second master merge: master's
  // v0.36.1.0 calibration wave claimed v68-v73 first. The ALTER
  // itself is unchanged; only the slot number moved. The column is
  // also in PGLITE_SCHEMA_SQL / src/schema.sql so fresh installs get
  // it natively without running this migration.
  idempotent: true,
  sql: `
      ALTER TABLE eval_candidates
        ADD COLUMN IF NOT EXISTS embedding_column TEXT;
    `,
  // PGLite parity: same ALTER, same IF NOT EXISTS guard makes this a
  // no-op on subsequent boots.
  sqlFor: {
    pglite: `
        ALTER TABLE eval_candidates
          ADD COLUMN IF NOT EXISTS embedding_column TEXT;
      `,
  },
};
