/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * Pipeline: keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Compiled truth boost: 2.0x for compiled_truth chunks after RRF normalization
 * Cosine re-score: blend 0.7*rrf + 0.3*cosine for query-specific ranking
 */

import type { BrainEngine } from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embed } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import { autoDetectDetail } from './intent.ts';

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
const STRUCTURED_ENTITY_TYPES = new Set([
  'people-profile',
  'person',
  'company',
  'agent-profile',
  'service-profile',
  'project-status',
  'project-summary',
  'company-summary',
  'infrastructure-summary',
  'infra-status',
]);
const TYPE_HINTS_BY_TYPE: Record<string, string[]> = {
  'agent-profile': ['agent', 'bot'],
  'service-profile': ['service', 'tool', 'system'],
  'company': ['company', 'business'],
  'company-summary': ['company', 'business'],
  'person': ['person', 'profile'],
  'people-profile': ['person', 'profile'],
  'project-status': ['project', 'status'],
  'project-summary': ['project', 'summary'],
  'infrastructure-summary': ['infrastructure', 'machine', 'server', 'host'],
  'infra-status': ['infrastructure', 'machine', 'server', 'host', 'status'],
};
const BRAND_ALIAS_SUFFIXES = new Set(['ai']);
const CANONICAL_PAGE_SUFFIXES = new Set(['summary', 'status', 'readme', 'index']);
const EXACT_CANONICAL_PATH_BOOST = 8.0;
const EXPLICIT_QUERY_PREFERENCE_BOOST = 12.0;
const EXPLICIT_QUERY_PREFERENCES: Array<{ preferredSlug: string; aliases: string[] }> = [
  {
    preferredSlug: 'knowledge/companies/rodaco/summary',
    aliases: ['rodaco', 'rodaco ai', 'rodaco company'],
  },
  {
    preferredSlug: 'knowledge/agents/rodaco',
    aliases: ['rodaco agent', 'rodaco bot', 'rodaco assistant'],
  },
  {
    preferredSlug: 'knowledge/agents/hermes',
    aliases: ['hermes', 'hermes agent', 'hermes bot', 'hermes assistant'],
  },
  {
    preferredSlug: 'knowledge/agents/atlas',
    aliases: ['atlas', 'atlas agent', 'atlas bot', 'atlas assistant'],
  },
  {
    preferredSlug: 'knowledge/agents/winston',
    aliases: ['winston', 'winston agent', 'winston bot', 'winston assistant'],
  },
  {
    preferredSlug: 'knowledge/agents/jeeves',
    aliases: ['jeeves', 'jeeves agent', 'jeeves bot', 'jeeves assistant'],
  },
  {
    preferredSlug: 'knowledge/agents/gbrain',
    aliases: ['gbrain', 'gbrain service', 'gbrain system', 'gbrain tool'],
  },
];
const EXPLICIT_QUERY_PREFERENCE_MAP = new Map(
  EXPLICIT_QUERY_PREFERENCES.flatMap(({ preferredSlug, aliases }) => aliases.map(alias => [alias, preferredSlug] as const)),
);
const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  /** Override default RRF K constant (default: 60). Lower values boost top-ranked results more. */
  rrfK?: number;
  /** Override dedup pipeline parameters. */
  dedupOpts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  };
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit || 20;
  const offset = opts?.offset || 0;
  const innerLimit = computeCandidateLimit(query, limit);

  // Auto-detect detail level from query intent when caller doesn't specify
  const detail = opts?.detail ?? autoDetectDetail(query);
  const searchOpts: SearchOpts = { limit: innerLimit, detail };

  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  // Run keyword search (always available, no API key needed)
  const keywordResults = await engine.searchKeyword(query, searchOpts);

  // Skip vector search entirely if no OpenAI key is configured
  if (!process.env.OPENAI_API_KEY) {
    return applyQueryAwareBoosts(dedupResults(keywordResults), query).slice(offset, offset + limit);
  }

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      queries = await opts.expandFn(query);
      if (queries.length === 0) queries = [query];
    } catch {
      // Expansion failure is non-fatal
    }
  }

  // Embed all query variants and run vector search
  let vectorLists: SearchResult[][] = [];
  let queryEmbedding: Float32Array | null = null;
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q)));
    queryEmbedding = embeddings[0];
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, searchOpts)),
    );
  } catch {
    // Embedding failure is non-fatal, fall back to keyword-only
  }

  if (vectorLists.length === 0) {
    return applyQueryAwareBoosts(dedupResults(keywordResults), query).slice(offset, offset + limit);
  }

  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  const allLists = [...vectorLists, keywordResults];
  let fused = rrfFusion(allLists, opts?.rrfK ?? RRF_K, detail !== 'high');

  // Cosine re-scoring before dedup so semantically better chunks survive
  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding);
  }

  // Dedup
  const deduped = dedupResults(fused, opts?.dedupOpts);

  // Auto-escalate: if detail=low returned 0, retry with high
  if (deduped.length === 0 && opts?.detail === 'low') {
    return hybridSearch(engine, query, { ...opts, detail: 'high' });
  }

  return applyQueryAwareBoosts(deduped, query).slice(offset, offset + limit);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  // Normalize to 0-1 by dividing by observed max
  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      const rawScore = e.score;
      e.score = e.score / maxScore;

      // Apply compiled truth boost after normalization (skip for detail=high)
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[\\/_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveSlugKeys(slug: string): string[] {
  const parts = slug.split('/').filter(Boolean);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1] || '';
  const parent = parts[parts.length - 2] || '';
  const keys = new Set<string>();
  keys.add(normalizeMatchText(last));
  if (['summary', 'readme', 'index', 'status'].includes(last) && parent) {
    keys.add(normalizeMatchText(parent));
  }
  keys.add(normalizeMatchText(slug));
  return Array.from(keys).filter(Boolean);
}

function isExactEntityLikeQuery(query: string): boolean {
  const normalized = normalizeMatchText(query);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (normalized.length < 2 || normalized.length > 80) return false;
  if (/[?*]/.test(query)) return false;
  return true;
}

function computeCandidateLimit(query: string, limit: number): number {
  const base = Math.min(limit * 2, MAX_SEARCH_LIMIT);
  if (!isExactEntityLikeQuery(query)) return base;
  return clampSearchLimit(Math.max(base, 100));
}

function matchesQueryTypeHint(result: SearchResult, normalizedQuery: string): boolean {
  const title = normalizeMatchText(result.title || '');
  if (!title || !normalizedQuery.startsWith(title)) return false;
  const remainder = normalizedQuery.slice(title.length).trim();
  if (!remainder) return false;
  const hints = TYPE_HINTS_BY_TYPE[String(result.type || '')] || [];
  if (hints.length === 0) return false;
  const tokens = remainder.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => hints.includes(token));
}

function primaryEntityKey(result: SearchResult): string {
  const slugParts = (result.slug || '').split('/').filter(Boolean);
  if (slugParts.length === 0) return '';
  const lastPart = slugParts[slugParts.length - 1] || '';
  const parentPart = slugParts[slugParts.length - 2] || '';
  if (CANONICAL_PAGE_SUFFIXES.has(lastPart) && parentPart) {
    return normalizeMatchText(parentPart);
  }
  return normalizeMatchText(lastPart);
}

function matchesBrandAliasSuffix(result: SearchResult, normalizedQuery: string): boolean {
  const type = String(result.type || '');
  if (type !== 'company' && type !== 'company-summary') return false;
  const entityKey = primaryEntityKey(result);
  if (!entityKey || !normalizedQuery.startsWith(`${entityKey} `)) return false;
  const remainder = normalizedQuery.slice(entityKey.length).trim();
  if (!remainder) return false;
  const tokens = remainder.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => BRAND_ALIAS_SUFFIXES.has(token));
}

function matchesExplicitQueryPreference(result: SearchResult, normalizedQuery: string): boolean {
  const preferredSlug = EXPLICIT_QUERY_PREFERENCE_MAP.get(normalizedQuery);
  if (!preferredSlug) return false;
  return result.slug === preferredSlug;
}

function queryAwareBoost(result: SearchResult, normalizedQuery: string): number {
  if (!normalizedQuery) return 1;

  const title = normalizeMatchText(result.title || '');
  const slugParts = (result.slug || '').split('/').filter(Boolean);
  const slugKeys = deriveSlugKeys(result.slug || '');
  const type = String(result.type || '');
  const exactTitle = title === normalizedQuery;
  const exactSlug = slugKeys.includes(normalizedQuery);
  const structured = STRUCTURED_ENTITY_TYPES.has(type);
  const queryTypeHint = matchesQueryTypeHint(result, normalizedQuery);
  const brandAliasSuffix = matchesBrandAliasSuffix(result, normalizedQuery);
  const explicitQueryPreference = matchesExplicitQueryPreference(result, normalizedQuery);
  const lastPart = slugParts[slugParts.length - 1] || '';
  const parentPart = slugParts[slugParts.length - 2] || '';
  const canonicalPathMatch = CANONICAL_PAGE_SUFFIXES.has(lastPart)
    && normalizeMatchText(parentPart) === normalizedQuery;

  let boost = 1;
  if (exactTitle) boost *= 2.5;
  if (exactSlug) boost *= 3.0;
  if ((exactTitle || exactSlug) && structured) boost *= 1.5;
  if (queryTypeHint) boost *= 3.5;
  if (queryTypeHint && structured) boost *= 1.5;
  if (brandAliasSuffix && structured) boost *= 2.5;
  if (explicitQueryPreference) boost *= EXPLICIT_QUERY_PREFERENCE_BOOST;
  if (canonicalPathMatch && structured) boost *= EXACT_CANONICAL_PATH_BOOST;
  return boost;
}

export function applyQueryAwareBoosts(results: SearchResult[], query: string): SearchResult[] {
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) return results;

  return results
    .map(result => ({ ...result, score: result.score * queryAwareBoost(result, normalizedQuery) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Cosine re-scoring: blend RRF score with query-chunk cosine similarity.
 * Runs before dedup so semantically better chunks survive.
 */
async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const chunkIds = results
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);

  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds);
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    const chunkEmb = r.chunk_id != null ? embeddingMap.get(r.chunk_id) : undefined;
    if (!chunkEmb) return r;

    const cosine = cosineSimilarity(queryEmbedding, chunkEmb);
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    return { ...r, score: blended };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
