/**
 * Admin knowledge workbench search — keyword vs semantic (hybrid).
 * Reuses engine searchKeyword / hybridSearch; no chat / think path.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { SearchResult } from '../core/types.ts';
import { dedupResults } from '../core/search/dedup.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { normalizeChineseQuery } from '../core/search/query-normalize-zh.ts';
import { embeddingRebuildPausesVectorSearch } from '../core/embedding-rebuild-state.ts';

export type AdminKnowledgeSearchMode = 'keyword' | 'semantic';

export interface AdminKnowledgeSearchHit {
  slug: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
  locator: string | null;
  source_id: string | null;
  page_id: number;
  chunk_id: number;
}

export interface AdminKnowledgeSearchResponse {
  mode: AdminKnowledgeSearchMode;
  query: string;
  limit: number;
  vector_enabled: boolean;
  index_rebuild_pending?: boolean;
  result_count: number;
  results: AdminKnowledgeSearchHit[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_LEN = 160;

export function isAdminKnowledgeSearchMode(value: unknown): value is AdminKnowledgeSearchMode {
  return value === 'keyword' || value === 'semantic';
}

function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function toHit(row: SearchResult): AdminKnowledgeSearchHit {
  const raw = row.chunk_text ?? '';
  const locator = raw.match(/^Locator:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const snippet = raw
    .replace(/^Parent document:.*\r?\nSection:.*\r?\nLocator:.*\r?\n*/m, '')
    .replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
  return {
    slug: row.slug,
    title: row.title || row.slug,
    type: String(row.type ?? ''),
    score: Number.isFinite(row.score) ? row.score : 0,
    snippet,
    locator,
    source_id: row.source_id ?? null,
    page_id: row.page_id,
    chunk_id: row.chunk_id,
  };
}

async function runKeywordSearch(
  engine: BrainEngine,
  query: string,
  limit: number,
  sourceIds?: string[],
): Promise<SearchResult[]> {
  const chineseQuery = normalizeChineseQuery(query);
  const lexicalQueries = chineseQuery.lexicalQueries.length > 0
    ? chineseQuery.lexicalQueries
    : [query];
  const batches = await Promise.all(
    lexicalQueries.map((lexicalQuery) => engine.searchKeyword(lexicalQuery, {
      limit,
      ...(sourceIds ? { sourceIds } : {}),
      ...(chineseQuery.since ? { afterDate: chineseQuery.since.toISOString() } : {}),
      ...(chineseQuery.until ? { beforeDate: chineseQuery.until.toISOString() } : {}),
    })),
  );
  return dedupResults(batches.flat()).slice(0, limit);
}

async function runSemanticSearch(
  engine: BrainEngine,
  query: string,
  limit: number,
  sourceIds?: string[],
): Promise<{ results: SearchResult[]; vectorEnabled: boolean }> {
  let vectorEnabled = false;
  // expansion:false — no chat model for multi-query rewrite
  const results = await hybridSearch(engine, query, {
    limit,
    ...(sourceIds ? { sourceIds } : {}),
    expansion: false,
    mode: 'balanced',
    onMeta: (meta) => {
      vectorEnabled = Boolean(meta.vector_enabled);
    },
  });
  return { results, vectorEnabled };
}

export async function runAdminKnowledgeSearch(
  engine: BrainEngine,
  input: { query: string; mode?: unknown; limit?: unknown; sourceIds?: string[] },
): Promise<AdminKnowledgeSearchResponse> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new Error('搜索词不能为空');
  const mode: AdminKnowledgeSearchMode = isAdminKnowledgeSearchMode(input.mode)
    ? input.mode
    : 'keyword';
  const limit = clampLimit(input.limit);
  const indexRebuildPending = embeddingRebuildPausesVectorSearch();

  if (mode === 'keyword' || indexRebuildPending) {
    const raw = await runKeywordSearch(engine, query, limit, input.sourceIds);
    return {
      mode,
      query,
      limit,
      vector_enabled: false,
      ...(indexRebuildPending ? { index_rebuild_pending: true } : {}),
      result_count: raw.length,
      results: raw.map(toHit),
    };
  }

  const { results, vectorEnabled } = await runSemanticSearch(engine, query, limit, input.sourceIds);
  return {
    mode,
    query,
    limit,
    vector_enabled: vectorEnabled,
    result_count: results.length,
    results: results.map(toHit),
  };
}
