import type { Migration } from './types.ts';

export const v083: Migration = {
  version: 83,
  name: 'mcp_spend_reservations',
  // (master v0.38.1.0 — full body in merged region)
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS mcp_spend_reservations (
        reservation_id UUID PRIMARY KEY,
        client_id TEXT NOT NULL,
        job_id BIGINT NULL REFERENCES minion_jobs(id) ON DELETE SET NULL,
        estimated_cents NUMERIC(12, 4) NOT NULL,
        actual_cents NUMERIC(12, 4) NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'expired')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        settled_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_reservations_client_time
        ON mcp_spend_reservations (client_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_reservations_pending_expires
        ON mcp_spend_reservations (status, expires_at)
        WHERE status = 'pending';
    `,
};
