import type { Migration } from './types.ts';

export const v077: Migration = {
  version: 77,
  name: 'mcp_spend_log',
  // D23-#6: per-OAuth-client paid-API spend tracking. search_by_image
  // (Phase 2 of cross-modal wave) makes paid Voyage calls on behalf of
  // remote OAuth clients. The existing v0.22.7 limiter caps requests/min
  // but not spend. A 100-req/min attacker can burn ~$3/hour at Voyage
  // rates. This table aggregates spend so the daily-budget check can
  // refuse new calls when a client crosses
  // search.image_query.daily_budget_usd_per_client (default $5).
  //
  // Indexed for the hot read: (client_id, day) lookup, summed.
  // Row count is bounded by O(clients × days) — tiny.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS mcp_spend_log (
        id SERIAL PRIMARY KEY,
        client_id TEXT,
        token_name TEXT,
        operation TEXT NOT NULL,
        spend_cents NUMERIC(12, 4) NOT NULL DEFAULT 0,
        provider TEXT,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- BTREE on (client_id, created_at) covers the per-day rollup query
      -- (SELECT SUM ... WHERE client_id = $ AND created_at >= today_start) via
      -- range scan on created_at. date_trunc in an index expression would
      -- require IMMUTABLE — TIMESTAMPTZ truncation depends on session timezone.
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_client_time
        ON mcp_spend_log (client_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_token_time
        ON mcp_spend_log (token_name, created_at);
    `,
  sqlFor: {
    pglite: `
        CREATE TABLE IF NOT EXISTS mcp_spend_log (
          id SERIAL PRIMARY KEY,
          client_id TEXT,
          token_name TEXT,
          operation TEXT NOT NULL,
          spend_cents NUMERIC(12, 4) NOT NULL DEFAULT 0,
          provider TEXT,
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_client_time
          ON mcp_spend_log (client_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_token_time
          ON mcp_spend_log (token_name, created_at);
      `,
  },
};
