import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-156: search gates its supersession stage on an existence probe
// (`links WHERE link_type = 'supersedes' LIMIT 1`, search/hybrid.ts). No links
// index leads with link_type, so on a brain with no supersedes edges, the
// common case, the probe read every links row to return nothing. This partial
// index holds only supersedes edges, keyed by the stale page: the probe reads
// an empty index, and the downrank lookup (`to_page_id = ANY(...)`) reads
// only supersedes edges. Built online (CONCURRENTLY on Postgres); an
// interrupted build leaves an INVALID index that the next initSchema drops and
// rebuilds.
export const LINKS_SUPERSEDES_INDEX = {
  name: 'idx_links_supersedes_to',
  table: 'links',
  sql: "CREATE INDEX IF NOT EXISTS idx_links_supersedes_to ON links (to_page_id) WHERE link_type = 'supersedes'",
};

export const v269: Migration = {
  version: 269,
  name: 'links_supersedes_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 269, LINKS_SUPERSEDES_INDEX, { notice: migrationNotice });
  },
};
