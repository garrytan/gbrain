import type { Migration } from './types.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { ensureFactsFtsIndex } from '../facts/fts-index.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
export const v237: Migration = {
  version: 237,
  name: 'facts_question_recall_indexes',
  // recall `question` (src/core/search/fact-relevance.ts) on a large brain.
  //
  // idx_facts_fts: the keyword arm matches every active fact's text and
  // entity words; unindexed it is a to_tsvector scan of the whole source
  // (about 450 ms at 100k facts on Postgres). The text search configuration
  // must be a literal for the planner to match an expression index, so the
  // handler builds it under GBRAIN_FTS_LANGUAGE, as v123 does for the trigger
  // functions, and `gbrain reindex-search-vector` replaces it when the
  // language changes. An expression index, not a stored tsvector column: a
  // column backfill rewrites every fact row and its HNSW entry (about 7
  // minutes at 100k facts); the index build reads the rows once (about 2 s).
  //
  // idx_facts_unembedded + idx_facts_embedding_model: `facts_degraded.unembedded`
  // counts the active facts the cosine arm cannot compare (no vector or a
  // stale text hash; another embedding model) on every call; unindexed it is
  // an md5 scan of the whole source (about 130 ms at 100k facts).
  //
  // Postgres builds every index CONCURRENTLY, one at a time, outside the
  // migration transaction (a handler); idx_facts_fts is built under a
  // temporary name and swapped in (facts/fts-index.ts), so writes never wait
  // on a build and search always has an index. PGLite builds inline. A rerun
  // after an interruption drops invalid leftovers and finishes the swap.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    await ensureFactsFtsIndex(engine, { lang: getFtsLanguage(), version: 237, notice: migrationNotice });
    await buildIndexOnline(engine, 237, { name: 'idx_facts_unembedded', table: 'facts', sql: `CREATE INDEX IF NOT EXISTS idx_facts_unembedded ON facts (source_id)
      WHERE expired_at IS NULL AND (embedding IS NULL OR embedded_text_hash IS DISTINCT FROM md5(fact))` }, { notice: migrationNotice });
    await buildIndexOnline(engine, 237, { name: 'idx_facts_embedding_model', table: 'facts',
      sql: 'CREATE INDEX IF NOT EXISTS idx_facts_embedding_model ON facts (source_id, embedding_model) WHERE expired_at IS NULL' }, { notice: migrationNotice });
  },
};
