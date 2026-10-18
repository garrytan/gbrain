import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); extract_rollup_7d
// has no fresh-install copy in schema.sql (migration v106 creates it), so this
// column lives here only.
export const v239: Migration = {
  version: 239,
  name: 'extract_rollup_halt_reasons',
  // #5495: why a round halted, as a closed vocabulary (rollup-writer.ts
  // HALT_REASONS) counted per reason in one JSONB object next to halt_count.
  // DDL only: a metadata-only ADD COLUMN takes a brief ACCESS EXCLUSIVE lock
  // under migrate.ts's lock timeout and no row is rewritten. There is NO
  // backfill here (the runner applies one file in one transaction, so an
  // UPDATE would hold that lock for its whole duration): halts recorded
  // before this column, and halts the writer could not classify, read as
  // `unknown` = halt_count - sum(halt_reasons), computed by the doctor read.
  idempotent: true,
  sql: `
    ALTER TABLE extract_rollup_7d
      ADD COLUMN IF NOT EXISTS halt_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,
};
