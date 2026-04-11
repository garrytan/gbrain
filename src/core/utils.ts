import { createHash } from 'crypto';
import type { Page, PageType, Chunk, SearchResult } from './types.ts';

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
 * SHA-256 hash of compiled_truth + timeline, used for import idempotency.
 */
export function contentHash(compiledTruth: string, timeline: string): string {
  return createHash('sha256').update(compiledTruth + '\n---\n' + timeline).digest('hex');
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

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    embedding: includeEmbedding && row.embedding ? row.embedding as Float32Array : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

/** Escape single quotes for safe SQL string interpolation. */
export function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

/** Build the canonical `provider:model` qualified name. */
export function qualifiedModel(provider: { name: string; model: string }): string {
  return `${provider.name}:${provider.model}`;
}

/** DDL to change the embedding column dimension + mark chunks stale. */
export function embeddingAlterSQL(newDims: number): string {
  return `
    DROP INDEX IF EXISTS idx_chunks_embedding;
    UPDATE content_chunks SET embedding = NULL, embedded_at = NULL WHERE embedded_at IS NOT NULL;
    ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${newDims});
    CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
  `;
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as PageType,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
}
