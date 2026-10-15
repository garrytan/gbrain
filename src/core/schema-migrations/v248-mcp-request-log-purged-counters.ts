import type { Migration } from './types.ts';

/** Preserve lifetime request metrics while pruning detailed usage logs. */
export const v248: Migration = {
  version: 248,
  name: 'mcp_request_log_purged_counters',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS mcp_request_log_purged (
  token_name TEXT PRIMARY KEY,
  purged_requests BIGINT NOT NULL DEFAULT 0,
  purged_last_used_at TIMESTAMPTZ
);
  `,
};
