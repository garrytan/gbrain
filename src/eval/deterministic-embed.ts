/**
 * Deterministic basis-vector embeddings for hermetic eval canaries/CI.
 *
 * NON-SEMANTIC embeddings: each query embeds as a unit basis vector at a
 * fixed dimension, so retrieval through the full hybrid pipeline (vector +
 * keyword/title/alias arms + RRF) is exactly reproducible with no API keys,
 * no network, and no provider drift. Used by the qrels correctness gate's
 * deterministic embedder path and the retrieval canary runner
 * (scripts/run-eval-canary.ts). Mirrors the basis-vector convention in
 * test/eval-replay-gate.test.ts and test/fixtures/eval-baselines/
 * qrels-search.json (each fixture query carries an `embedding_dim`).
 */

/** Unit basis vector with 1.0 at `idx % dim` and 0.0 elsewhere. */
export function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

/**
 * 32-bit FNV-1a hash. Deterministic, dependency-free; used only to derive a
 * stable fallback basis dimension for query texts not present in the qrels
 * fixture.
 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export interface LegacyQrelsQuery {
  query_id: string;
  query: string;
  embedding_dim: number;
  relevant_slugs: string[];
  first_relevant_slug: string;
}

/**
 * Parse the legacy qrels fixture shape
 * ({queries: [{query, embedding_dim, relevant_slugs, first_relevant_slug}]}).
 * THE single parser for this shape — the canary runner and the embedder
 * builder both consume it. Throws on malformed JSON or a missing `queries`
 * array (callers surface a usage error; the gate's own qrels parser reports
 * shape problems in detail).
 */
export function parseLegacyQrels(raw: string): LegacyQrelsQuery[] {
  const parsed = JSON.parse(raw) as { queries?: unknown };
  if (!Array.isArray(parsed.queries)) {
    throw new Error('qrels fixture missing "queries" array');
  }
  return parsed.queries as LegacyQrelsQuery[];
}

/**
 * Build a query-embed function from a raw qrels fixture (the legacy shape:
 * `{queries: [{query, embedding_dim, ...}]}`). Known query texts map to
 * `basisEmbedding(embedding_dim)`; unknown texts fall back to a
 * deterministic FNV-1a-derived basis dimension in [100, 1099] — outside the
 * fixture's low dims, so an unknown query can never accidentally vote for a
 * fixture page's basis direction (fixture dims are small integers).
 *
 * Throws on malformed JSON or a missing `queries` array (caller surfaces a
 * usage error; the gate's own qrels parser reports shape problems in detail).
 */
export function buildQrelsQueryEmbedFn(qrelsRaw: string): (text: string) => Float32Array {
  const queries = parseLegacyQrels(qrelsRaw);
  const dimByQuery = new Map<string, number>();
  for (const q of queries) {
    if (typeof (q as { query?: unknown })?.query === 'string' && typeof (q as { embedding_dim?: unknown })?.embedding_dim === 'number') {
      dimByQuery.set(q.query, q.embedding_dim);
    }
  }
  return (text: string): Float32Array => {
    const dim = dimByQuery.get(text);
    if (dim !== undefined) return basisEmbedding(dim);
    return basisEmbedding(100 + (Math.abs(fnv1a(text)) % 1000));
  };
}
