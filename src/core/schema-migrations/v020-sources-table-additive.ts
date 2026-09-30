import type { Migration } from './types.ts';

export const v020: Migration = {
  version: 20,
  name: 'sources_table_additive',
  // v0.18.0 Step 1 (Lane A) — **additive only** so Step 1 is a safe
  // standalone commit. This migration installs the sources primitive
  // WITHOUT breaking the engine's existing ON CONFLICT (slug) upserts.
  //
  // What this migration does now:
  //   - CREATE sources table
  //   - INSERT default source (federated=true, inherits sync.repo_path
  //     and sync.last_commit from config so post-upgrade identity is
  //     preserved)
  //
  // What this migration does NOT do yet (deferred to v17 which ships
  // with Step 2 engine rewrite, so they land atomically):
  //   - ALTER pages ADD source_id
  //   - DROP UNIQUE(slug) + ADD UNIQUE(source_id, slug)
  //   - files.page_slug → page_id rewrite
  //   - file_migration_ledger
  //   - links.resolution_type
  //
  // The v0.18.0 orchestrator's phaseCVerify allows this split: it
  // checks for sources('default'), but the "composite UNIQUE" +
  // "pages.source_id NOT NULL" assertions only run after v17 lands.
  //
  // Idempotent via IF NOT EXISTS. Safe to re-run.
  sql: `
      CREATE TABLE IF NOT EXISTS sources (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        local_path    TEXT,
        last_commit   TEXT,
        last_sync_at  TIMESTAMPTZ,
        config        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Seed 'default' source, inheriting the existing sync.repo_path /
      -- sync.last_commit config values. federated=true for backward compat.
      -- Pre-v0.17 brains behave exactly as before.
      INSERT INTO sources (id, name, local_path, last_commit, config)
      SELECT
        'default',
        'default',
        (SELECT value FROM config WHERE key = 'sync.repo_path'),
        (SELECT value FROM config WHERE key = 'sync.last_commit'),
        '{"federated": true}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = 'default');
    `,
};
