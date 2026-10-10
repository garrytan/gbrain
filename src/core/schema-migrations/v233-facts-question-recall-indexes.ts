import type { Migration } from './types.ts';
import { factsFtsIndexSql, getFtsLanguage } from '../fts-language.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
export const v233: Migration = {
  version: 233,
  name: 'facts_question_recall_indexes',
  // recall `question` (src/core/search/fact-relevance.ts) on a large brain.
  //
  // idx_facts_fts: the keyword arm matches every active fact's text and
  // entity words; unindexed it is a to_tsvector scan of the whole source
  // (about 450 ms at 100k facts on Postgres). The text search configuration
  // must be a literal for the planner to match an expression index, so the
  // handler builds it under GBRAIN_FTS_LANGUAGE, as v123 does for the trigger
  // functions, and `gbrain reindex-search-vector` rebuilds it when the
  // language changes. An expression index, not a stored tsvector column: a
  // column backfill rewrites every fact row and its HNSW entry (about 7
  // minutes at 100k facts); the index build reads the rows once (about 2 s).
  //
  // idx_facts_unembedded + idx_facts_embedding_model: `facts_degraded.unembedded`
  // counts the active facts the cosine arm cannot compare (no vector or a
  // stale text hash; another embedding model) on every call; unindexed it is
  // an md5 scan of the whole source (about 130 ms at 100k facts).
  //
  // Re-running drops and rebuilds idx_facts_fts and skips the others: safe.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    for (const sql of factsFtsIndexSql(getFtsLanguage())) await engine.executeRaw(sql);
    await engine.executeRaw(`CREATE INDEX IF NOT EXISTS idx_facts_unembedded ON facts (source_id)
      WHERE expired_at IS NULL AND (embedding IS NULL OR embedded_text_hash IS DISTINCT FROM md5(fact))`);
    await engine.executeRaw(`CREATE INDEX IF NOT EXISTS idx_facts_embedding_model ON facts (source_id, embedding_model) WHERE expired_at IS NULL`);
  },
};
