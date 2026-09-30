import type { Migration } from './types.ts';

export const v015: Migration = {
  version: 15,
  name: 'minion_jobs_max_stalled_default_5',
  // v0.14.1 (fix wave): fixes https://github.com/garrytan/gbrain/issues/219
  // Shipped default was 1 — first stall = dead-letter, contradicting the
  // "SIGKILL rescued" claim. New default 5. UPDATE backfills existing non-
  // terminal rows so upgrading brains don't keep dead-lettering queued work.
  // Statuses come from MinionJobStatus in types.ts. Row locks serialize
  // against claim()'s FOR UPDATE SKIP LOCKED — race-safe. Idempotent.
  sql: `
      ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 5;
      UPDATE minion_jobs
         SET max_stalled = 5
       WHERE status IN ('waiting','active','delayed','waiting-children','paused')
         AND max_stalled < 5;
    `,
};
