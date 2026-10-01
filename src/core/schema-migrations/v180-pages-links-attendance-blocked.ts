import type { Migration } from './types.ts';

export const v180: Migration = {
  // #5761: link extraction's attendance marker. Managed stale extraction
  // stamps the page's knowledge revision here when every other link is ready
  // but an attendee does not resolve, and clears it when it publishes links
  // and advances the watermark. `links_extraction_lag` counts a page whose
  // marker equals its current revision as attendance-blocked instead of lag;
  // an edit changes the revision and the page counts as lag again. Derived
  // columns outside the managed writer guard's tracked set. Nullable, no
  // backfill, no index (bootstrap-coverage: column-only). Fresh installs get
  // them from this migration too (not src/schema.sql): pages columns added by
  // earlier migrations precede them, so fresh and upgraded brains share
  // their ordinals.
  version: 180,
  name: 'pages_links_attendance_blocked',
  idempotent: true,
  sql: `
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_attendance_blocked_revision UUID;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_attendance_blocked_at TIMESTAMPTZ;
  `,
};
