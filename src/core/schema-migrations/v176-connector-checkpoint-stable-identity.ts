import type { Migration } from './types.ts';
import { migrateConnectorCheckpoints } from '../persistence/connector-checkpoint-migration.ts';

export const v176: Migration = {
  // #5686: connector checkpoints were keyed on the raw sources.config, which
  // the cycle stamp rewrites after every run. Re-key each source's newest
  // committed checkpoint receipt to the stable parsed-config identity, seed
  // its connector state row (resumed or re-walking once), record the cutoff
  // that classifies retired-format connector intents, and remove orphan
  // checkpoint rows. Handler-only, statement-at-a-time, rerun-safe.
  version: 176, name: 'connector_checkpoint_stable_identity', idempotent: true, sql: '',
  handler: async engine => { await migrateConnectorCheckpoints(engine); },
};
