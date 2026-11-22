import type { Migration } from './types.ts';

// Preserve all existing dates. Future writers can represent an unknown event
// time separately from the creation time, which remains required.
export const v332: Migration = {
  version: 332,
  name: 'facts_unknown_event_time',
  idempotent: true,
  sql: `
    ALTER TABLE facts
      ALTER COLUMN valid_from DROP NOT NULL,
      ALTER COLUMN valid_from DROP DEFAULT;
  `,
};
