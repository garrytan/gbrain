import { createHash } from 'crypto';
import type { Page, PageInput, PageType, Chunk, SearchResult } from './types.ts';

/**
 * Validate and normalize a slug. Slugs are lowercased repo-relative paths.
 * Rejects empty slugs, path traversal (..), and leading /.
 */
export function validateSlug(slug: string): string {
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

/**
 * SHA-256 hash of page content, used for import idempotency.
 * Hashes all PageInput fields to match importFromContent's hash algorithm.
 */
export function contentHash(page: PageInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline || '',
      frontmatter: page.frontmatter || {},
    }))
    .digest('hex');
}

export function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as number,
    slug: row.slug as string,
    type: row.type as PageType,
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    timeline: row.timeline as string,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
    content_hash: row.content_hash as string | undefined,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

/**
 * Normalize an embedding value into a Float32Array.
 *
 * pgvector returns embeddings in different shapes depending on driver/path:
 *   - postgres.js (Postgres): often a string like `"[0.1,0.2,...]"`
 *   - pglite: typically a numeric array or Float32Array
 *   - pgvector node binding: numeric array
 *   - Some queries that JSON-aggregate embeddings: JSON-string array
 *
 * Without normalization, downstream cosine math sees a string and produces
 * NaN scores silently. This helper guarantees a Float32Array or throws
 * loudly on malformed input — never returns NaN.
 */
export function parseEmbedding(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return new Float32Array(0);
    if (typeof value[0] !== 'number') {
      throw new Error(`parseEmbedding: array contains non-numeric element (${typeof value[0]})`);
    }
    return Float32Array.from(value as number[]);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Plain non-vector strings: treat as "no embedding here", return null.
    // Strings that LOOK like vector literals but contain garbage: throw,
    // because that's a real corruption signal worth surfacing loudly.
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return new Float32Array(0);
    const parts = inner.split(',');
    const out = new Float32Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i].trim());
      if (!Number.isFinite(n)) {
        throw new Error(`parseEmbedding: non-finite value at index ${i}: ${parts[i]}`);
      }
      out[i] = n;
    }
    return out;
  }
  return null;
}

let _tryParseEmbeddingWarned = false;

/**
 * Availability-path sibling of parseEmbedding(). Returns null + warns once
 * on any shape parseEmbedding would throw on. Use this on read/rescore paths
 * where one corrupt row should degrade ranking, not kill the whole query.
 * Use parseEmbedding() (throws) on ingest/migrate paths where silent skips
 * would be data loss.
 */
export function tryParseEmbedding(value: unknown): Float32Array | null {
  try {
    return parseEmbedding(value);
  } catch (err) {
    if (!_tryParseEmbeddingWarned) {
      _tryParseEmbeddingWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`tryParseEmbedding: skipping corrupt embedding row (${msg}). Further warnings suppressed this session.`);
    }
    return null;
  }
}

/**
 * The 6 ASCII whitespace chars POSIX `[[:space:]]` always matches under
 * the C / default locale: space, tab, newline, vertical tab, form feed,
 * carriage return. PostgreSQL `regexp_replace(s, '[[:space:]]', '', 'g')`
 * resolves the class via the prevailing `LC_CTYPE`; under the default
 * locale (C / C.UTF-8 / en_US.UTF-8 in practice on Supabase, Linux,
 * macOS) the match set is exactly these 6.
 *
 * Do NOT use JS `\s` here - it also matches Unicode whitespace
 * (no-break space U+00A0, en-space U+2002, ideographic space U+3000,
 * etc.) which Postgres `[[:space:]]` does NOT match under the default
 * locale, causing `has_chunkable_text` to disagree between code (this
 * helper) and SQL backfill / inline recompute paths. The unit test at
 * `test/utils.test.ts:computeHasChunkableText` pins this with a U+00A0
 * regression case.
 *
 * If gbrain ever ships under a Unicode-aware locale that resolves
 * `[[:space:]]` to include U+00A0, this helper plus migration v33 plus
 * revertToVersion's inline SQL all need to switch together.
 */
const POSIX_SPACE_RE = /[ \t\n\v\f\r]/g;

/**
 * Mirror of the SQL predicate used by `listSlugsPendingEmbedding` UNION
 * branch 2 in both engines:
 *
 *   LENGTH(regexp_replace(COALESCE(compiled_truth, ''), '[[:space:]]', '', 'g')) > 0
 *   OR LENGTH(regexp_replace(COALESCE(timeline, ''), '[[:space:]]', '', 'g')) > 0
 *
 * "Does this page have any non-whitespace text worth chunking?"
 *
 * Maintained on every page write (`putPage` in postgres-engine.ts and
 * pglite-engine.ts) so the embed-worker query can filter on a partial-
 * indexed boolean instead of running this regex over every row in a
 * Parallel Seq Scan. See `idx_pages_chunkable` partial index and
 * migration v29 (column + backfill).
 *
 * Drift risk: if this function or its SQL twin diverges, pages get
 * mis-classified as needing-or-not-needing chunking. Round-trip tests
 * in `test/postgres-engine.test.ts` and `test/pglite-engine.test.ts`
 * assert this matches what the database stores; any future SQL change
 * to the predicate must also update this helper, and vice versa.
 */
export function computeHasChunkableText(
  compiled_truth: string | null | undefined,
  timeline: string | null | undefined,
): boolean {
  const ct = (compiled_truth ?? '').replace(POSIX_SPACE_RE, '');
  if (ct.length > 0) return true;
  const tl = (timeline ?? '').replace(POSIX_SPACE_RE, '');
  return tl.length > 0;
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline' | 'fenced_code',
    embedding: includeEmbedding ? parseEmbedding(row.embedding) : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
    // v0.19.0 code-chunk metadata (nullable for markdown chunks).
    language: (row.language as string | null | undefined) ?? null,
    symbol_name: (row.symbol_name as string | null | undefined) ?? null,
    symbol_type: (row.symbol_type as string | null | undefined) ?? null,
    start_line: (row.start_line as number | null | undefined) ?? null,
    end_line: (row.end_line as number | null | undefined) ?? null,
    // v0.20.0 Cathedral II Layer 1 additions (nullable for markdown chunks).
    parent_symbol_path: (row.parent_symbol_path as string[] | null | undefined) ?? null,
    doc_comment: (row.doc_comment as string | null | undefined) ?? null,
    symbol_name_qualified: (row.symbol_name_qualified as string | null | undefined) ?? null,
  };
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  const result: SearchResult = {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as PageType,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    chunk_id: row.chunk_id as number,
    chunk_index: row.chunk_index as number,
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
  // v0.17.0: source_id comes from the p.source_id column in search
  // SELECTs. Keep the field optional so pre-v0.17 engines that didn't
  // join sources don't crash on the absent column — rowToSearchResult
  // is shared by both paths.
  if (typeof row.source_id === 'string') {
    result.source_id = row.source_id;
  }
  return result;
}
