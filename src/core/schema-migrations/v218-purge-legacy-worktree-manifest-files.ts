import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6099 (privacy): releases before v0.60.69 stored a writer manifest's full
// per-file map (`files`: relative path -> unsalted sha256 of the file bytes) in
// persistence_worktrees.manifest and in clone recovery records
// (persistence_topology_changes.recovery.manifest). Those maps can name and
// fingerprint files Git ignores, such as `.env.local`. Nothing reads them: only
// the digest and file count are compared (persistence/worktree-manifest.ts
// `compactStoredManifest` keeps exactly those). This drops every remaining map,
// keeping `file_count` (counted from the map when it was not stored). Data-only
// and idempotent: a second run matches no row.
export const v218: Migration = {
  version: 218,
  name: 'purge_legacy_worktree_manifest_files',
  idempotent: true,
  sql: `
    UPDATE persistence_worktrees
       SET manifest = (manifest - 'files') || jsonb_build_object('file_count',
             COALESCE(manifest->'file_count', to_jsonb((SELECT count(*) FROM jsonb_object_keys(manifest->'files')))))
     WHERE jsonb_typeof(manifest) = 'object' AND jsonb_typeof(manifest->'files') = 'object';
    UPDATE persistence_topology_changes
       SET recovery = jsonb_set(recovery, '{manifest}', ((recovery->'manifest') - 'files') || jsonb_build_object('file_count',
             COALESCE(recovery->'manifest'->'file_count', to_jsonb((SELECT count(*) FROM jsonb_object_keys(recovery->'manifest'->'files'))))))
     WHERE jsonb_typeof(recovery) = 'object' AND jsonb_typeof(recovery->'manifest') = 'object'
       AND jsonb_typeof(recovery->'manifest'->'files') = 'object';
  `,
};
