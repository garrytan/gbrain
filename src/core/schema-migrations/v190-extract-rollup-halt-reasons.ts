import type { Migration } from './types.ts';

export const v190: Migration = {
  // #5495: preserve a privacy-safe count of why extractor rounds halted.
  version: 190,
  name: 'extract_rollup_halt_reasons',
  idempotent: true,
  sql: `ALTER TABLE extract_rollup_7d
    ADD COLUMN IF NOT EXISTS halt_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;
    UPDATE extract_rollup_7d
      SET halt_reasons = jsonb_build_object('unknown', halt_count)
      WHERE halt_count > 0 AND halt_reasons = '{}'::jsonb;`,
};
