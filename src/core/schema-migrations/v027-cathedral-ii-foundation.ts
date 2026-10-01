import type { Migration } from './types.ts';

export const v027: Migration = {
  version: 27,
  name: 'cathedral_ii_foundation',
  // v0.20.0 Cathedral II Layer 1 — schema-only foundation.
  //
  // Lands BEFORE any consumer layer to eliminate forward references
  // (codex SP-4). All Cathedral II DDL arrives here as one atomic
  // transaction:
  //
  //   1. content_chunks gains 4 columns:
  //      - parent_symbol_path TEXT[]   — scope chain for nested symbols (A3)
  //      - doc_comment TEXT            — extracted JSDoc/docstring (A4)
  //      - symbol_name_qualified TEXT  — 'Admin::UsersController#render' (A1)
  //      - search_vector TSVECTOR      — chunk-grain FTS (Layer 1b)
  //
  //   2. sources.chunker_version TEXT — SP-1 gate. performSync forces
  //      full walk on mismatch with CURRENT_CHUNKER_VERSION, bypassing
  //      the up_to_date git-HEAD early-return that made the bare
  //      CHUNKER_VERSION bump a silent no-op.
  //
  //   3. code_edges_chunk — resolved call-graph / type-ref edges.
  //      FK CASCADE from content_chunks on both endpoints; deleting a
  //      chunk wipes its edges. UNIQUE (from, to, edge_type) holds
  //      idempotency. source_id TEXT matches sources.id actual type
  //      (codex F4). Source scoping is enforced in resolution logic,
  //      not in the key, because from_chunk_id → pages.source_id
  //      already determines it.
  //
  //   4. code_edges_symbol — unresolved refs. Target symbol is known
  //      by qualified name but the defining chunk hasn't been imported
  //      yet. Rows UNION with code_edges_chunk on read (codex 1.3b);
  //      no promotion step.
  //
  //   5. update_chunk_search_vector trigger — BEFORE INSERT/UPDATE
  //      OF (chunk_text, doc_comment, symbol_name_qualified). Builds
  //      search_vector with weight A on doc_comment + symbol_name_qualified,
  //      B on chunk_text. Natural-language queries rank doc-comment hits
  //      above body-text hits (A4 intent).
  //
  // Consumer layers (Layer 5 A1, Layer 6 A3, Layer 10 C CLI, Layer 12
  // CHUNKER_VERSION bump, Layer 13 E2 reindex-code) all depend on this
  // foundation. Absent it, every downstream layer would have forward
  // refs.
  sql: `
      -- content_chunks: new Cathedral II columns
      ALTER TABLE content_chunks
        ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT[],
        ADD COLUMN IF NOT EXISTS doc_comment TEXT,
        ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT,
        ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

      CREATE INDEX IF NOT EXISTS idx_chunks_search_vector
        ON content_chunks USING GIN(search_vector);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_qualified
        ON content_chunks(symbol_name_qualified) WHERE symbol_name_qualified IS NOT NULL;

      -- sources: SP-1 chunker_version gate
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS chunker_version TEXT;

      -- code_edges_chunk: resolved edges
      CREATE TABLE IF NOT EXISTS code_edges_chunk (
        id                    SERIAL PRIMARY KEY,
        from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        to_chunk_id           INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        from_symbol_qualified TEXT NOT NULL,
        to_symbol_qualified   TEXT NOT NULL,
        edge_type             TEXT NOT NULL,
        edge_metadata         JSONB NOT NULL DEFAULT '{}',
        source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT code_edges_chunk_unique UNIQUE (from_chunk_id, to_chunk_id, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from
        ON code_edges_chunk(from_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to
        ON code_edges_chunk(to_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to_symbol
        ON code_edges_chunk(to_symbol_qualified, edge_type);

      -- code_edges_symbol: unresolved refs
      CREATE TABLE IF NOT EXISTS code_edges_symbol (
        id                    SERIAL PRIMARY KEY,
        from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
        from_symbol_qualified TEXT NOT NULL,
        to_symbol_qualified   TEXT NOT NULL,
        edge_type             TEXT NOT NULL,
        edge_metadata         JSONB NOT NULL DEFAULT '{}',
        source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT code_edges_symbol_unique UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from
        ON code_edges_symbol(from_chunk_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_to
        ON code_edges_symbol(to_symbol_qualified, edge_type);

      -- Chunk-grain FTS trigger (Layer 1b consumer — column exists from this
      -- migration, trigger installed now so newly-written chunks get vectors
      -- from day one). NULL-safe: markdown chunks leave doc_comment and
      -- symbol_name_qualified NULL; COALESCE('') keeps the vector build
      -- from failing on missing weights.
      CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $fn$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B');
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
      CREATE TRIGGER chunk_search_vector_trigger
        BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
        ON content_chunks
        FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();
    `,
};
