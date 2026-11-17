import type { Migration } from './types.ts';

export const v098: Migration = {
  version: 98,
  name: 'gbrain_cycle_locks_last_refreshed_at',
  // v0.41.15.0 (D-V3-4 + D-V4-1) — add last_refreshed_at column for
  // `gbrain sync --break-lock --max-age <s>` to correctly identify
  // wedged-but-alive lock holders without stealing healthy long-running
  // holders that are actively refreshing.
  //
  // BACKFILL POLICY: last_refreshed_at = NOW() (NOT acquired_at).
  //
  // Why NOW(): during the upgrade window there can be ACTIVE sync
  // processes still running the OLD binary. Their refresh() only bumps
  // ttl_expires_at (the old code didn't know about last_refreshed_at).
  // If we backfilled = acquired_at (e.g. 25 min ago), then `gbrain sync
  // --break-lock --all --max-age 1800` after the migration would
  // immediately delete the lock of a HEALTHY 25-min-old holder that's
  // still actively writing.
  sql: `
      ALTER TABLE gbrain_cycle_locks ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMPTZ;
      UPDATE gbrain_cycle_locks SET last_refreshed_at = NOW() WHERE last_refreshed_at IS NULL;
    `,
};
