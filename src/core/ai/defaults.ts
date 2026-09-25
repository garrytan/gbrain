/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

export const DEFAULT_EMBEDDING_MODEL = 'voyage:voyage-4';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
export const NEW_INSTALL_DEFAULT_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;
export const NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS = DEFAULT_EMBEDDING_DIMENSIONS;
export const DEFAULT_RERANKER_MODEL = 'voyage:rerank-2.5';
export const NEW_INSTALL_DEFAULT_RERANKER_MODEL = DEFAULT_RERANKER_MODEL;

export function renderCanonicalMigrationCommands(opts: { colDims?: number | null } = {}): {
  /** Live run (agents append --yes themselves after consent). */
  recommended: string;
  /** Cost preview — what every warning surface should print first. */
  recommendedDryRun: string;
  /** Keep-width alternative (no schema rebuild), when the width allows it. */
  openaiAlternative: string | null;
  /** Rebuild explanation when the recommended target changes the width. */
  note: string | null;
} {
  const base = `gbrain migrate embeddings --to ${NEW_INSTALL_DEFAULT_EMBEDDING_MODEL} --dim ${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS}`;
  const colDims = opts.colDims ?? null;
  const openaiAlternative = colDims !== null && colDims <= 1536
    ? `gbrain migrate embeddings --to openai:text-embedding-3-small --dim ${colDims} --dry-run`
    : null;
  const note = colDims !== null && colDims !== NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS
    ? `(--dim ${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS} rebuilds the ${colDims}d index — Voyage's valid widths are 256/512/1024/2048${openaiAlternative ? `; the OpenAI alternative keeps this brain's ${colDims}d width` : ''}.)`
    : null;
  return {
    recommended: base,
    recommendedDryRun: `${base} --dry-run`,
    openaiAlternative,
    note,
  };
}
