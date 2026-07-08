// Search and discovery operations: search, query, resolve_slugs, get_chunks.
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { expandQuery } from './search/expansion.ts';
import { hybridSearchWithMeta } from './search/hybrid.ts';
import { rankSearchResults, sourceRankCandidateLimit } from './search/source-ranking.ts';

function parseOptionalDateParam(value: unknown, key: string): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be an ISO datetime string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OperationError('invalid_params', `${key} must be a valid ISO datetime string.`);
  }
  return parsed;
}

// --- Search ---

const search: Operation = {
  name: 'search',
  description:
    'Keyword candidate discovery across MBrain. Use for exact names, slugs, dates, and terms; chunks are not answer evidence. For factual answers, call retrieve_context or read_context to load canonical evidence.',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    updated_after: { type: 'string', description: 'Only return pages updated at or after this ISO datetime' },
    updated_before: { type: 'string', description: 'Only return pages updated at or before this ISO datetime' },
  },
  handler: async (ctx, p) => {
    const limit = (p.limit as number) ?? 20;
    const updatedAfter = parseOptionalDateParam(p.updated_after, 'updated_after');
    const updatedBefore = parseOptionalDateParam(p.updated_before, 'updated_before');
    return rankSearchResults(
      await ctx.engine.searchKeyword(p.query as string, {
        limit: sourceRankCandidateLimit(limit),
        updated_after: updatedAfter,
        updated_before: updatedBefore,
      }),
      limit,
      ctx.config.retrieval_source_rank_rules,
    );
  },
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description:
    'Semantic candidate discovery across MBrain. Use when the question is conceptual, cross-cutting, or keyword search missed likely pages; chunks are not answer evidence. For factual answers, call retrieve_context or read_context to load canonical evidence.',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    updated_after: { type: 'string', description: 'Only return pages updated at or after this ISO datetime' },
    updated_before: { type: 'string', description: 'Only return pages updated at or before this ISO datetime' },
    expand: {
      type: 'boolean',
      description: 'Enable multi-query expansion (default: true)',
    },
  },
  handler: async (ctx, p) => {
    const expand = p.expand !== false;
    const updatedAfter = parseOptionalDateParam(p.updated_after, 'updated_after');
    const updatedBefore = parseOptionalDateParam(p.updated_before, 'updated_before');
    const {
      results,
      expansion_failed,
      vector_failed,
      vector_skipped,
      embedding_coverage_warning,
    } = await hybridSearchWithMeta(ctx.engine, p.query as string, {
      limit: (p.limit as number) ?? 20,
      updated_after: updatedAfter,
      updated_before: updatedBefore,
      expansion: expand,
      expandFn: expand ? (query) => expandQuery(query, { config: ctx.config }) : undefined,
      sourceRankRules: ctx.config.retrieval_source_rank_rules,
    });
    if (expansion_failed) {
      ctx.logger.warn('query expansion failed; results reflect the original query only');
    }
    if (vector_failed) {
      ctx.logger.warn('query vector leg failed; results reflect keyword and surviving vector results only');
    }
    if (vector_skipped) {
      ctx.logger.warn('query vector leg skipped; no embedding provider is available');
    }
    if (embedding_coverage_warning) {
      ctx.logger.warn(embedding_coverage_warning);
    }
    return results;
  },
  cliHints: { name: 'query', positional: ['query'] },
};

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.resolveSlugs(p.partial as string);
  },
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getChunks(p.slug as string);
  },
};

export function createSearchOperations(): Operation[] {
  return [search, query, resolve_slugs, get_chunks];
}
