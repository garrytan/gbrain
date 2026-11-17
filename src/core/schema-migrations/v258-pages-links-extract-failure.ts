import type { Migration } from './types.ts';

export const v258: Migration = {
  // GBRA-130 A-1: managed link extraction's per-page failure record. A page
  // whose derivation fails with a content-class error is recorded here with
  // the knowledge revision and extractor generation it failed at and a run
  // count; after 3 consecutive runs at the same revision, generation and code
  // its state becomes 'held' and stale extraction skips it until the page or
  // the extractor changes, or `gbrain extract --stale --retry-held` clears it.
  // Publishing the page's links clears it with the watermark. Derived column
  // outside the managed writer guard's tracked set, like the v180 attendance
  // marker. Nullable, no backfill, no index (bootstrap-coverage: column-only).
  // Fresh installs get it from this migration too (not src/schema.sql), so
  // fresh and upgraded brains share pages column ordinals.
  version: 258,
  name: 'pages_links_extract_failure',
  idempotent: true,
  sql: `
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extract_failure JSONB;
  `,
};
