import type { Migration } from './types.ts';

export const v078: Migration = {
  version: 78,
  name: 'embedding_multimodal_column',
  // D20 Phase 3: add the unified-multimodal vector column to content_chunks.
  //
  // Column-only migration — the HNSW partial index is built AFTER the first
  // bulk reindex completes (via `gbrain reindex --multimodal --build-index`
  // or auto-built at completion). pgvector docs explicitly note that HNSW
  // build is faster after data load, and per-row index maintenance during
  // bulk reindex would slow the operation 2-3x.
  //
  // Operator class will be vector_cosine_ops to match the existing
  // embedding_image index for ranking parity.
  //
  // The column ships at 1024 dims to match Voyage multimodal-3 output.
  // Operators wanting a different dim (Cohere multimodal at 1408d, etc.)
  // need a column rebuild — surfaced by the `multimodal_column_dim_match`
  // doctor check (D20 model+dim pin).
  idempotent: true,
  sql: `
      ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_multimodal vector(1024);
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_multimodal vector(1024);
      `,
  },
};
