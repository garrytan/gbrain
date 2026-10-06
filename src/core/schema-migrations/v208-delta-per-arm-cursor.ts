import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// delta per-arm cursor (contributor audit wave P0). Facts and pages used to
// share one time cursor, so a facts read that failed, overflowed its limit or
// lost a budget cut was skipped once the page cursor moved. The facts arm now
// keeps its own keyset `(facts_cursor_at, facts_cursor_id)`, and
// `degraded_wakes` counts consecutive incomplete wakes (the delta notice
// escalates to `report` on the third). Existing rows start their facts cursor
// at `last_wake_at` with id 0, which is what they effectively used before;
// gaps skipped before the upgrade are not recoverable from here. Keep in sync
// with src/schema.sql.
export const v208: Migration = {
  version: 208,
  name: 'delta_per_arm_cursor',
  idempotent: true,
  sql: `
    ALTER TABLE session_context_state ADD COLUMN IF NOT EXISTS facts_cursor_at TIMESTAMPTZ;
    ALTER TABLE session_context_state ADD COLUMN IF NOT EXISTS facts_cursor_id BIGINT;
    ALTER TABLE session_context_state ADD COLUMN IF NOT EXISTS degraded_wakes INTEGER NOT NULL DEFAULT 0;
    UPDATE session_context_state
       SET facts_cursor_at = last_wake_at, facts_cursor_id = 0
     WHERE facts_cursor_at IS NULL AND last_wake_at IS NOT NULL;
  `,
};
