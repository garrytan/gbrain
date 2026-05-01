import type { SearchResult } from '../types.ts';

type SourceRankRule = {
  prefix: string;
  factor: number;
};

const SOURCE_RANK_RULES: SourceRankRule[] = [
  { prefix: 'originals/', factor: 1.5 },
  { prefix: 'brain/originals/', factor: 1.5 },
  { prefix: 'concepts/', factor: 1.25 },
  { prefix: 'brain/concepts/', factor: 1.25 },
  { prefix: 'ideas/', factor: 1.2 },
  { prefix: 'brain/ideas/', factor: 1.2 },
  { prefix: 'systems/', factor: 1.15 },
  { prefix: 'brain/systems/', factor: 1.15 },
  { prefix: 'projects/', factor: 1.15 },
  { prefix: 'brain/projects/', factor: 1.15 },
  { prefix: 'people/', factor: 1.1 },
  { prefix: 'brain/people/', factor: 1.1 },
  { prefix: 'companies/', factor: 1.1 },
  { prefix: 'brain/companies/', factor: 1.1 },
  { prefix: 'deals/', factor: 1.1 },
  { prefix: 'brain/deals/', factor: 1.1 },
  { prefix: 'meetings/', factor: 1.05 },
  { prefix: 'brain/meetings/', factor: 1.05 },
  { prefix: 'daily/', factor: 0.85 },
  { prefix: 'brain/daily/', factor: 0.85 },
  { prefix: 'logs/', factor: 0.85 },
  { prefix: 'brain/logs/', factor: 0.85 },
  { prefix: 'scratch/', factor: 0.8 },
  { prefix: 'brain/scratch/', factor: 0.8 },
  { prefix: 'archive/', factor: 0.8 },
  { prefix: 'brain/archive/', factor: 0.8 },
  { prefix: 'attachments/', factor: 0.75 },
  { prefix: 'brain/attachments/', factor: 0.75 },
  { prefix: 'media/', factor: 0.75 },
  { prefix: 'brain/media/', factor: 0.75 },
  { prefix: 'media/x/', factor: 0.75 },
  { prefix: 'brain/media/x/', factor: 0.75 },
  { prefix: 'media/chat/', factor: 0.75 },
  { prefix: 'brain/media/chat/', factor: 0.75 },
].sort((a, b) => b.prefix.length - a.prefix.length);

const SOURCE_RANK_CANDIDATE_MULTIPLIER = 5;
const MIN_SOURCE_RANK_CANDIDATES = 50;
const MAX_SOURCE_RANK_CANDIDATES = 200;

function normalizeSlug(slug: string): string {
  return slug.replace(/^\/+/, '').toLowerCase();
}

export function sourceRankFactor(slug: string): number {
  const normalized = normalizeSlug(slug);
  const rule = SOURCE_RANK_RULES.find((candidate) => normalized.startsWith(candidate.prefix));
  return rule?.factor ?? 1;
}

function chunkSourceRankFactor(result: SearchResult): number {
  switch (result.chunk_source) {
    case 'compiled_truth':
      return 1.03;
    case 'frontmatter':
      return 1.02;
    case 'timeline':
      return 0.95;
  }
}

export function rankSearchResults(results: SearchResult[], limit?: number): SearchResult[] {
  const ranked = results
    .map((result, index) => {
      return {
        result,
        sourceFactor: sourceRankFactor(result.slug) * chunkSourceRankFactor(result),
        rankedScore: sourceRankedScore(result),
        originalScore: result.score,
        index,
      };
    })
    .sort((a, b) => {
      if (b.rankedScore !== a.rankedScore) return b.rankedScore - a.rankedScore;
      if (b.sourceFactor !== a.sourceFactor) return b.sourceFactor - a.sourceFactor;
      if (b.originalScore !== a.originalScore) return b.originalScore - a.originalScore;
      return a.index - b.index;
    })
    .map(({ result }) => result);

  return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
}

export function sourceRankedScore(result: SearchResult): number {
  return result.score * sourceRankFactor(result.slug) * chunkSourceRankFactor(result);
}

export function sourceRankCandidateLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(
    Math.max(limit * SOURCE_RANK_CANDIDATE_MULTIPLIER, MIN_SOURCE_RANK_CANDIDATES),
    MAX_SOURCE_RANK_CANDIDATES,
  );
}
