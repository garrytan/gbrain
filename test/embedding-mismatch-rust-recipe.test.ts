/**
 * The width-mismatch recipe (embedding-dim-check.ts embeddingMismatchMessage). A Rust brain gets its own text: its store
 * fixes the vector width when the brain is created and no command changes it yet (loss "no vector-width change on Rust",
 * docs/designs/RUST_ENGINE.md), so the recipe names no command. The PGLite and Postgres recipes are pinned byte for byte
 * as they were before the Rust branch existed (rust-engine/main b66e407760).
 */
import { describe, expect, test } from 'bun:test';
import { embeddingMismatchMessage } from '../src/core/embedding-dim-check.ts';

const OPTS = { currentDims: 1536, requestedDims: 768, requestedModel: 'openai:text-embedding-3-large', databasePath: '/brains/example.pglite' };

/** The SQL engines' recipes at rust-engine/main b66e407760, before the Rust branch. */
const SQL_RECIPES = [
  { engineKind: 'pglite', source: 'embed', text: "Refusing to silently re-template existing brain.\n\n  Existing column: vector(1536)\n  Requested:       vector(768)  (openai:text-embedding-3-large)\n\nNothing was changed. Switching dims re-embeds every chunk and fact;\nPGLite cannot ALTER vector column types in place (pgvector ships as WASM).\n\nKeep this brain's width (no rebuild; pages and facts kept):\n\n  gbrain init --force --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536 --path /brains/example.pglite\n\nChange the width (re-embeds; pages and DB-only facts kept; preview first):\n\n  gbrain migrate embeddings --to openai:text-embedding-3-large --dim 768 --dry-run\n\nLast resort (moves the datastore aside; DB-only pages and facts are NOT carried over):\n\n  gbrain reinit-pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 768\n\nFull guide: docs/embedding-migrations.md" },
  { engineKind: 'pglite', source: 'doctor', text: "Embedding dimension mismatch detected.\n\n  Existing column: vector(1536)\n  Requested:       vector(768)  (openai:text-embedding-3-large)\n\nSwitching dims re-embeds every chunk and fact;\nPGLite cannot ALTER vector column types in place (pgvector ships as WASM).\n\nKeep this brain's width (no rebuild; pages and facts kept):\n\n  gbrain init --force --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536 --path /brains/example.pglite\n\nChange the width (re-embeds; pages and DB-only facts kept; preview first):\n\n  gbrain migrate embeddings --to openai:text-embedding-3-large --dim 768 --dry-run\n\nLast resort (moves the datastore aside; DB-only pages and facts are NOT carried over):\n\n  gbrain reinit-pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 768\n\nFull guide: docs/embedding-migrations.md" },
  { engineKind: 'postgres', source: 'embed', text: "Refusing to silently re-template existing brain.\n\n  Existing column: vector(1536)\n  Requested:       vector(768)  (openai:text-embedding-3-large)\n\nSwitching dims is destructive: it drops every embedding in your brain and\nrequires a full re-embed (potentially hours and $1-100 in API calls).\n\nRecipe (run against your Postgres brain):\n\n  BEGIN;\n  DROP INDEX IF EXISTS idx_chunks_embedding;\n  -- NULL embeddings BEFORE the alter: pgvector refuses to cast existing\n  -- vectors across dimensions and aborts the transaction. NULLs cast fine.\n  UPDATE content_chunks SET embedding = NULL, embedded_at = NULL, embedding_pending_since = now();\n  ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(768);\n  CREATE INDEX IF NOT EXISTS idx_chunks_embedding\n    ON content_chunks USING hnsw (embedding vector_cosine_ops);\n  COMMIT;\n\nThen re-init config (file plane is canonical post-v0.37):\n  gbrain init --supabase --embedding-model openai:text-embedding-3-large --embedding-dimensions 768\n  gbrain embed --stale\n\nFull guide: docs/embedding-migrations.md" },
  { engineKind: 'postgres', source: 'doctor', text: "Embedding dimension mismatch detected.\n\n  Existing column: vector(1536)\n  Requested:       vector(768)  (openai:text-embedding-3-large)\n\nSwitching dims is destructive: it drops every embedding in your brain and\nrequires a full re-embed (potentially hours and $1-100 in API calls).\n\nRecipe (run against your Postgres brain):\n\n  BEGIN;\n  DROP INDEX IF EXISTS idx_chunks_embedding;\n  -- NULL embeddings BEFORE the alter: pgvector refuses to cast existing\n  -- vectors across dimensions and aborts the transaction. NULLs cast fine.\n  UPDATE content_chunks SET embedding = NULL, embedded_at = NULL, embedding_pending_since = now();\n  ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(768);\n  CREATE INDEX IF NOT EXISTS idx_chunks_embedding\n    ON content_chunks USING hnsw (embedding vector_cosine_ops);\n  COMMIT;\n\nThen re-init config (file plane is canonical post-v0.37):\n  gbrain init --supabase --embedding-model openai:text-embedding-3-large --embedding-dimensions 768\n  gbrain embed --stale\n\nFull guide: docs/embedding-migrations.md" },
] as const;

describe('embeddingMismatchMessage', () => {
  test('a Rust brain gets the header, the widths and a recipe that names no command', () => {
    expect(embeddingMismatchMessage({ ...OPTS, source: 'embed', engineKind: 'rust' })).toBe([
      'Refusing to silently re-template existing brain.',
      '',
      '  Existing column: vector(1536)',
      '  Requested:       vector(768)  (openai:text-embedding-3-large)',
      '',
      "Nothing was changed. A Rust brain's vector width is fixed when the brain is created, and no command changes it yet.",
      'To embed now, set embedding_model and embedding_dimensions in your config back to a model at vector(1536).',
    ].join('\n'));
  });

  test('the PGLite and Postgres recipes are unchanged', () => {
    for (const row of SQL_RECIPES) {
      expect({ engineKind: row.engineKind, source: row.source, text: embeddingMismatchMessage({ ...OPTS, source: row.source, engineKind: row.engineKind }) }).toEqual(row);
    }
  });
});
