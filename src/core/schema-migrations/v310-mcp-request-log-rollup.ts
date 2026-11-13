import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6770 rewrite: mcp_request_log_rollup is the per-token tally of request-log
// rows the opt-in retention prune (src/core/mcp-request-log-retention.ts,
// cycle.purge.mcp_request_log_retention_days) removed: how many, the newest
// one's time (lifetime last-used) and pruned_through, the newest pruned row,
// which tells a usage window whether it reaches back past pruned detail. A row
// with a NULL token_name counts under ''. The prune deletes and tallies in one
// statement. This migration only creates the table: it copies no rows and
// deletes nothing, so retention stays off until an operator sets the key.
// Operational state, not brain content: a repo-less brain gets it unchanged.
// RLS is enabled here (v275's list is frozen). No schema.sql mirror: like
// v282-v301, it exists only through migrations. Provisional number:
// renumbered at the merge slot.
export const v310: Migration = {
  version: 310,
  name: 'mcp_request_log_rollup',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS mcp_request_log_rollup (
  token_name TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  pruned_through TIMESTAMPTZ
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE mcp_request_log_rollup ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
