import type { Migration } from './types.ts';

export const v033: Migration = {
  version: 33,
  name: 'admin_dashboard_columns_v0_26_3',
  // v0.26.3 admin dashboard expansion. Adds 5 columns referenced by
  // src/commands/serve-http.ts and src/core/oauth-provider.ts that landed
  // in PR #586 without a corresponding schema migration. Without v33,
  // existing brains hit:
  //   - SELECT c.token_ttl, ... CASE WHEN c.deleted_at -> 503 on /admin/api/agents
  //   - INSERT INTO mcp_request_log (... agent_name, params, error_message)
  //     -> caught by best-effort try/catch, request log silently empties
  //   - UPDATE oauth_clients SET deleted_at = now() (revoke-client) -> 500
  //   - UPDATE oauth_clients SET token_ttl = ... (update-client-ttl) -> 500
  // All ALTERs use ADD COLUMN IF NOT EXISTS so re-running is a no-op.
  sql: `
      ALTER TABLE oauth_clients
        ADD COLUMN IF NOT EXISTS token_ttl INTEGER,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      ALTER TABLE mcp_request_log
        ADD COLUMN IF NOT EXISTS agent_name TEXT,
        ADD COLUMN IF NOT EXISTS params JSONB,
        ADD COLUMN IF NOT EXISTS error_message TEXT;

      -- Backfill agent_name on existing rows so the new "agent" column in
      -- the request log isn't blank for pre-v0.26.3 entries. LEFT JOIN
      -- pattern: prefer client_name from oauth_clients (current behavior),
      -- fall back to access_tokens.name (legacy bearer tokens), fall back
      -- to the raw client_id stored as token_name.
      UPDATE mcp_request_log m
      SET agent_name = COALESCE(
        (SELECT client_name FROM oauth_clients WHERE client_id = m.token_name LIMIT 1),
        (SELECT name FROM access_tokens WHERE name = m.token_name LIMIT 1),
        m.token_name
      )
      WHERE agent_name IS NULL;

      -- Index for the new agent filter on /admin/api/request-log. The
      -- existing idx_mcp_log_time_agent (created_at, token_name) doesn't
      -- help when filtering by the resolved agent_name. Use DESC on
      -- created_at to match the typical ORDER BY clause.
      CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time
        ON mcp_request_log(agent_name, created_at DESC);
    `,
};
