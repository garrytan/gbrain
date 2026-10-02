import type { Migration } from './types.ts';

export const v092: Migration = {
  version: 92,
  name: 'sources_github_repo_index',
  // v0.40.5.0 Federated Sync v2 (D13): partial expression index on
  // sources.config->>'github_repo' so the new POST /webhooks/github
  // handler's source-by-repo lookup uses an index instead of a sequential
  // scan. Sources is small today (<100 rows in practice) so the impact is
  // microseconds, but the lookup fires on every webhook event (including
  // ignored ones) and a team with hundreds of sources would feel it.
  //
  // Partial WHERE clause keeps the index small — only rows with a
  // configured webhook actually take up index entries. Both Postgres and
  // PGLite support partial expression indexes; no engine-specific shape.
  // Idempotent (IF NOT EXISTS).
  //
  // Plan called this v81 originally; renumbered through v87 → v89 → v90 → v92
  // across successive master merges (v0.40.2.0 claimed v89 for
  // facts_event_type_column; v0.40.3.0 claimed v90 + v91 for
  // contextual_retrieval_columns + pages_generation_trigger_and_bookmark).
  sql: `
      CREATE INDEX IF NOT EXISTS sources_github_repo_idx
        ON sources ((config->>'github_repo'))
        WHERE config ? 'github_repo';
    `,
};
