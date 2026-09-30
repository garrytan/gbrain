import type { Migration } from './types.ts';

export const v108: Migration = {
  version: 108,
  name: 'pages_embedding_signature',
  // v0.41.31 — embedding provenance for real stale semantics.
  //
  // Adds `pages.embedding_signature TEXT NULL` = `<provider:model>:<dims>`
  // stamped when a page's chunks are embedded (setPageEmbeddingSignature).
  // A later model/dimension swap makes the stored signature differ from
  // the current one, so countStaleChunks/sumStaleChunkChars (with the
  // `signature` opt) and invalidateStaleSignatureEmbeddings can detect and
  // re-embed those pages.
  //
  // GRANDFATHER (critical): the stale predicate is
  //   `embedding_signature IS NOT NULL AND embedding_signature <> $current`
  // so a NULL signature is NEVER stale. After this migration every existing
  // page has NULL — none are flagged — so the next `embed --stale` does NOT
  // re-embed the whole corpus. Signatures only get stamped going forward.
  //
  // No index: the column is read only via a JOINed pages row in the
  // chunk-grain stale queries; no standalone lookup hot path. ADD COLUMN
  // with no DEFAULT (NULL) is metadata-only on Postgres 11+ / PGLite 17.5.
  idempotent: true,
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_signature TEXT NULL;
    `,
};
