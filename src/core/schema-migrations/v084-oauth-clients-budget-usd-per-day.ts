import type { Migration } from './types.ts';

export const v084: Migration = {
  version: 84,
  name: 'oauth_clients_budget_usd_per_day',
  // (master v0.38.1.0 — full body in merged region)
  idempotent: true,
  sql: `
      ALTER TABLE oauth_clients
        ADD COLUMN IF NOT EXISTS budget_usd_per_day NUMERIC(10, 2) NULL;
    `,
};
