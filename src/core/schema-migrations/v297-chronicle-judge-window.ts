import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #8972: each chronicle ledger row records what its judge read, so a revision
// whose judge input did not change (a long conversation that grew past the
// judge's window) makes no paid call, and a re-judged generation that read all
// the text the live events came from replaces them instead of adding to them.
// judge_input_hash: the digest of the whole judge input (page fields and the
// body's first JUDGE_BODY_CHARS). judge_window_chars and judge_window_hash: the
// length and sha256 of that body window. All nullable, metadata-only, no
// backfill: a row recorded before this migration has no judged window, so the
// next revision of its page is judged once more and stays additive. The number
// is a placeholder restamped at the merge slot.
export const v297: Migration = {
  version: 297,
  name: 'chronicle_judge_window',
  idempotent: true,
  sql: `
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS judge_input_hash TEXT;
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS judge_window_chars INTEGER CHECK (judge_window_chars >= 0);
    ALTER TABLE chronicle_page_state ADD COLUMN IF NOT EXISTS judge_window_hash TEXT;
  `,
};
