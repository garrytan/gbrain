import type { Migration } from './types.ts';

export const v026: Migration = {
  version: 26,
  name: 'content_chunks_code_metadata',
  // v0.19.0 Layer 3 — content_chunks gains code-specific metadata columns
  // so C6 (query --lang), C7 (code-def / code-refs), and the new
  // searchCodeChunks engine method can filter + surface symbol context
  // without parsing chunk_text.
  //
  // All new columns are nullable — existing markdown chunks carry NULL.
  // importCodeFile populates them from the tree-sitter AST.
  //
  // Partial indexes (WHERE <col> IS NOT NULL) keep the index small: a
  // brain with 20K markdown chunks + 20K code chunks indexes only the
  // code chunks for symbol lookups. Measured ~200ms → ~15ms on code-refs.
  sql: `
      ALTER TABLE content_chunks
        ADD COLUMN IF NOT EXISTS language TEXT,
        ADD COLUMN IF NOT EXISTS symbol_name TEXT,
        ADD COLUMN IF NOT EXISTS symbol_type TEXT,
        ADD COLUMN IF NOT EXISTS start_line INTEGER,
        ADD COLUMN IF NOT EXISTS end_line INTEGER;

      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name
        ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_chunks_language
        ON content_chunks(language) WHERE language IS NOT NULL;
    `,
};
