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
 * Normalize a raw embedding value to Float32Array.
 * PGLite's pgvector returns embeddings as a string like "[0.1,0.2,...]",
 * while Postgres drivers may return Float32Array or number[].
 */
function parseEmbedding(raw: unknown): Float32Array {
  if (raw instanceof Float32Array) return raw;
  if (typeof raw === 'string') {
    const nums = raw.slice(1, -1).split(',').map(Number);
    return new Float32Array(nums);
  }
  if (Array.isArray(raw)) return new Float32Array(raw);
  throw new Error(`Unexpected embedding type: ${typeof raw}`);
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    embedding: includeEmbedding && row.embedding ? parseEmbedding(row.embedding) : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  return {
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
}
