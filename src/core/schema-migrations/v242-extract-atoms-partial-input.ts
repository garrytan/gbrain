import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copies of both tables in src/schema.sql carry the same column.
export const v242: Migration = {
  version: 242,
  name: 'extract_atoms_partial_input',
  // #6503: an item cut at `cycle.extract_atoms.max_input_chars` is no longer
  // stamped complete. Its row records the cap the model read it under
  // (`partial_input_chars`): discovery skips the item while the cap is at
  // or below that value and offers it again once the cap rises (the phase
  // clears rows under the new cap before discovery) or the content changes
  // (a new content_hash is a new row). NULL on complete and failed rows.
  // DDL only: a metadata-only ADD COLUMN under migrate.ts's lock timeout,
  // no row rewritten, nothing to backfill.
  idempotent: true,
  sql: `
    ALTER TABLE extract_atoms_page_state
      ADD COLUMN IF NOT EXISTS partial_input_chars INTEGER;
    ALTER TABLE extract_atoms_transcript_state
      ADD COLUMN IF NOT EXISTS partial_input_chars INTEGER;
  `,
};
