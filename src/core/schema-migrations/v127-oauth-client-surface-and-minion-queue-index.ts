import type { Migration } from './types.ts';

export const v127: Migration = {
  version: 127,
  name: 'oauth_client_surface_and_minion_queue_index',
  // WP4 (MCP consumer-feedback wave) — two additive pieces:
  //
  // 1. oauth_clients.surface + surface_set_by (amendments 17-19): the
  //    per-client MCP tool surface consumed by the D2 ceiling resolution in
  //    serve-http (`min(server --surface ceiling, row surface ?? config
  //    default)`) and written by `gbrain auth rescope-client --surface`
  //    (surface_set_by='operator', the lock the request_tools persist
  //    branch cannot override) and the `request_tools` meta-op
  //    (surface_set_by='self'). TEXT with an OPEN value space (amendment
  //    18): unrecognized values are ignored at resolution (warn-once per
  //    client), and future client tiers will write tier names into this
  //    same column — never a second column. NULL = no per-client surface
  //    (server/config resolution applies). verifyAccessToken's degrade
  //    ladder gained a rung above v85's so pre-v127 brains keep
  //    authenticating (ENG-9: both columns probed by missingOAuthColumn).
  //
  // 2. idx_minion_jobs_queue_status_updated (ENG-10, WP5 wedge index):
  //    btree (queue, status, updated_at) covering all four count FILTERs
  //    and both max(updated_at) FILTERs in queryWedgeSignals
  //    (supervisor.ts) — no non-partial queue index existed before this.
  //    Plain CREATE INDEX (small table; no CONCURRENTLY needed, which also
  //    keeps this runnable inside the migration transaction on both
  //    engines).
  //
  // Keep in sync with src/schema.sql, src/core/pglite-schema.ts,
  // src/core/schema-embedded.ts + the bootstrap probe sets in both engines
  // (test/schema-bootstrap-coverage.test.ts pins coverage).
  idempotent: true,
  sql: `
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT;
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT;
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_queue_status_updated
        ON minion_jobs (queue, status, updated_at);
    `,
};
