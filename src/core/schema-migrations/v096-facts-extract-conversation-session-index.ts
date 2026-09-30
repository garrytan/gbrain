import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v096: Migration = {
  version: 96,
  name: 'facts_extract_conversation_session_index',
  // v0.41.11.0 — partial index supporting the doctor query for
  // conversation_facts_backlog (Codex round-1 T2 + round-2 C2).
  // The doctor check runs:
  //   SELECT COUNT(*) FROM pages p WHERE p.type = ANY($1::text[])
  //     AND p.deleted_at IS NULL
  //     AND NOT EXISTS (SELECT 1 FROM facts f
  //                     WHERE f.source = 'cli:extract-conversation-facts:terminal'
  //                       AND f.source_session = 'cli:extract-conversation-facts:terminal:' || p.slug
  //                       AND f.source_id = p.source_id)
  //
  // Without this index, the NOT EXISTS subquery seq-scans facts on
  // every doctor invocation including autopilot. The partial index
  // is tiny — only rows written by this command are indexed
  // (per-segment facts + the page-level terminal row).
  //
  // Engine-aware via handler (not SQL): Postgres uses CREATE INDEX
  // CONCURRENTLY (avoid SHARE lock on facts) + pre-drops any invalid
  // remnant from a prior failed run (mirrors migration v14 precedent).
  // PGLite has no concurrent writers, so plain CREATE is safe.
  //
  // Slot history: originally planned as v94 (master shipped v94
  // take_domain_assignments); bumped to v95 (master then shipped v95
  // links_link_source_check_includes_mentions); now at v96 after
  // post-merge resolution. The index shape itself is unchanged
  // across all renumbers.
  transaction: false,
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 96, 'idx_facts_extract_conversation_session');
      await engine.runMigration(
        96,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facts_extract_conversation_session
             ON facts (source_id, source_session)
             WHERE source LIKE 'cli:extract-conversation-facts%';`
      );
    } else {
      await engine.runMigration(
        96,
        `CREATE INDEX IF NOT EXISTS idx_facts_extract_conversation_session
             ON facts (source_id, source_session)
             WHERE source LIKE 'cli:extract-conversation-facts%';`
      );
    }
  },
};
