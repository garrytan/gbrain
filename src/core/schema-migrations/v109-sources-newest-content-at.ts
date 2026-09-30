import type { Migration } from './types.ts';

export const v109: Migration = {
  version: 109,
  name: 'sources_newest_content_at',
  // v0.41.32.0 (supersedes #1623): durable newest-COMMIT timestamp per source,
  // written at sync time (HEAD committer time). The REMOTE staleness path
  // (federation_health, get_status_snapshot MCP op) reads this column instead
  // of shelling out to git on a DB-supplied local_path — preserving the
  // v0.41.27.0 trust boundary while still killing the quiet-repo false-SEVERE
  // alarm. ADD COLUMN with a NULL default is metadata-only on both engines
  // (instant, no table rewrite). Mirror lives in pglite-schema.ts +
  // schema.sql (fresh-install path) and the applyForwardReferenceBootstrap
  // probe set in both engines. Renumbered 108→109 on the master merge that
  // landed v0.41.31's pages_embedding_signature at v108.
  idempotent: true,
  sql: `ALTER TABLE sources ADD COLUMN IF NOT EXISTS newest_content_at TIMESTAMPTZ`,
};
