import type { Migration } from './types.ts';

export const v099: Migration = {
  version: 99,
  name: 'conversation_parser_llm_cache_table',
  // v0.41.16.0 — content-hash-keyed cache for the conversation parser's
  // LLM polish + fallback calls. See src/schema.sql for design notes.
  sql: `
      CREATE TABLE IF NOT EXISTS conversation_parser_llm_cache (
        content_sha256 TEXT NOT NULL,
        model_id TEXT NOT NULL,
        call_shape TEXT NOT NULL CHECK (call_shape IN ('polish', 'fallback')),
        value_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (content_sha256, model_id, call_shape)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_parser_llm_cache_created
        ON conversation_parser_llm_cache (created_at);
    `,
  sqlFor: {
    pglite: `
        CREATE TABLE IF NOT EXISTS conversation_parser_llm_cache (
          content_sha256 TEXT NOT NULL,
          model_id TEXT NOT NULL,
          call_shape TEXT NOT NULL CHECK (call_shape IN ('polish', 'fallback')),
          value_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (content_sha256, model_id, call_shape)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_parser_llm_cache_created
          ON conversation_parser_llm_cache (created_at);
      `,
  },
};
