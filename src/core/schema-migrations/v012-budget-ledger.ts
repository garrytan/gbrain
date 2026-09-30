import type { Migration } from './types.ts';

export const v012: Migration = {
  version: 12,
  name: 'budget_ledger',
  // Resolver spend tracker. Primary key {scope, resolver_id, local_date} so
  // midnight rollover in the user's TZ naturally creates a new row instead of
  // mutating yesterday's. reserved_usd and committed_usd track reservations
  // vs actuals so process death between reserve() and commit()/rollback()
  // can be cleaned up by TTL scan. Rollback: DROP TABLE (regenerable from
  // resolver call logs; no durable product data lives here).
  sql: `
      CREATE TABLE IF NOT EXISTS budget_ledger (
        scope          TEXT        NOT NULL,
        resolver_id    TEXT        NOT NULL,
        local_date     DATE        NOT NULL,
        reserved_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
        committed_usd  NUMERIC(12,4) NOT NULL DEFAULT 0,
        cap_usd        NUMERIC(12,4),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, resolver_id, local_date)
      );
      CREATE TABLE IF NOT EXISTS budget_reservations (
        reservation_id TEXT        PRIMARY KEY,
        scope          TEXT        NOT NULL,
        resolver_id    TEXT        NOT NULL,
        local_date     DATE        NOT NULL,
        estimate_usd   NUMERIC(12,4) NOT NULL,
        reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at     TIMESTAMPTZ NOT NULL,
        status         TEXT        NOT NULL DEFAULT 'held'
      );
      CREATE INDEX IF NOT EXISTS idx_budget_reservations_expires
        ON budget_reservations(expires_at) WHERE status = 'held';
    `,
};
