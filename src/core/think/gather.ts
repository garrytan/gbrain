/**
 * v0.28: GATHER phase for `gbrain think`.
 *
 * Runs four retrievers in parallel:
 *   1. hybrid    — page-grain hybrid search (vector + keyword + RRF)
 *   2. takes_kw  — keyword search across active takes
 *   3. takes_vec — vector search across active takes (skipped when no embedder)
 *   4. graph     — anchor-entity subgraph traversal (skipped when no --anchor)
 *
 * Each retriever returns a ranked list with normalized scores. We fuse them
 * via RRF (k=60, same constant as src/core/search/hybrid.ts). The final
 * merged set is capped at gather_limit and dedup'd by `(slug, row_num?)`.
 *
 * The page hits and take hits are returned as separate lists so the synth
 * step can render them into distinct <pages> / <takes> blocks for the prompt.
 */

import type { BrainEngine, TakeHit, Take } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { SearchResult } from '../types.ts';
import { sanitizeQueryForPrompt } from '../search/expansion.ts';
import { ensureWellFormed } from '../text-safe.ts';
import { CJK_SLUG_CHARS } from '../cjk.ts';

export interface ThinkGatherOpts {
  question: string;
  /** Anchor entity slug. When set, the graph stream activates. */
  anchor?: string;
  /** Soft cap on total results across all streams. Default 40. */
  gatherLimit?: number;
  /** Soft cap on take results. Default 30. */
  takesLimit?: number;
  /** Graph traversal depth when anchor is set. Default 2. */
  graphDepth?: number;
  /** Optional pre-computed embedding for the question. Lets the caller share embedding cost. */
  questionEmbedding?: Float32Array;
  /** When set, MCP-bound calls forward this allow-list to takes_search. Local CLI leaves unset. */
  takesHoldersAllowList?: string[];
  /** Source scope inherited from the caller. Federated array wins over scalar. */
  sourceId?: string;
  sourceIds?: string[];
}

export interface ThinkGatherResult {
  /** Page hits, ranked by RRF-fused score. */
  pages: SearchResult[];
  /** Take hits, ranked + dedup'd. */
  takes: TakeHit[];
  /** Graph nodes — slugs reachable from anchor within graphDepth. Empty when no anchor. */
  graphSlugs: string[];
  /** Diagnostics for telemetry / `--explain` path (Lane D follow-up). */
  diagnostics: {
    pagesFromHybrid: number;
    takesFromKeyword: number;
    takesFromVector: number;
    graphHits: number;
    questionSanitizedFor: 'expansion' | 'none';
  };
}

const RRF_K = 60;

/** Reciprocal-rank fusion: 1/(k+rank). Stable, parameter-light, matches search/hybrid.ts k. */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Fuse two ranked lists by `(slug, row_num?)` key. Returns merged list sorted
 * by fused score descending. Mirrors the RRF pattern in src/core/search/hybrid.ts
 * but generalized for take-vs-take and take-vs-page key shapes.
 */
function fuseRanked<T>(
  a: T[],
  b: T[],
  keyFn: (item: T) => string,
): T[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (let i = 0; i < a.length; i++) {
    const k = keyFn(a[i]);
    scores.set(k, { item: a[i], score: rrfScore(i + 1) });
  }
  for (let i = 0; i < b.length; i++) {
    const k = keyFn(b[i]);
    const prev = scores.get(k);
    if (prev) {
      prev.score += rrfScore(i + 1);
    } else {
      scores.set(k, { item: b[i], score: rrfScore(i + 1) });
    }
  }
  return Array.from(scores.values())
    .sort((x, y) => y.score - x.score)
    .map(s => s.item);
}

/**
 * Run the four-stream gather. Each stream is wrapped in a try/catch so a
 * single retriever failure doesn't crash the whole pipeline — synthesis
 * with partial gather results is more useful than no synthesis at all.
 */
export async function runGather(
  engine: BrainEngine,
  opts: ThinkGatherOpts,
): Promise<ThinkGatherResult> {
  const gatherLimit = opts.gatherLimit ?? 40;
  const takesLimit = opts.takesLimit ?? 30;
  const graphDepth = opts.graphDepth ?? 2;
  const sourceScope = opts.sourceIds && opts.sourceIds.length > 0
    ? { sourceIds: opts.sourceIds }
    : opts.sourceId
      ? { sourceId: opts.sourceId }
      : {};

  // Sanitize the question for any path that includes it in an LLM prompt.
  // (Direct DB search is fine — those are parameterized queries.)
  const sanitizedQuestion = sanitizeQueryForPrompt(opts.question);

  // Stream 1: hybrid page search (existing primitive).
  const pagesPromise = hybridSearch(engine, opts.question, {
    limit: gatherLimit,
    expansion: false,  // think provides its own anchor + graph context; no need for re-expansion
    ...sourceScope,
  }).catch((e) => {
    process.stderr.write(`[think.gather] hybrid stream failed: ${(e as Error).message}\n`);
    return [] as SearchResult[];
  });

  // Stream 2: keyword search across takes.
  const takesKwPromise = engine.searchTakes(opts.question, {
    limit: takesLimit,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    ...sourceScope,
  }).catch((e) => {
    process.stderr.write(`[think.gather] takes-keyword stream failed: ${(e as Error).message}\n`);
    return [] as TakeHit[];
  });

  // Stream 3: vector search across takes (only when an embedding is supplied).
  const takesVecPromise: Promise<TakeHit[]> = opts.questionEmbedding
    ? engine.searchTakesVector(opts.questionEmbedding, {
        limit: takesLimit,
        takesHoldersAllowList: opts.takesHoldersAllowList,
        ...sourceScope,
      }).catch((e) => {
        process.stderr.write(`[think.gather] takes-vector stream failed: ${(e as Error).message}\n`);
        return [] as TakeHit[];
      })
    : Promise.resolve([] as TakeHit[]);

  // Stream 4: graph walk (anchor only).
  const graphPromise: Promise<string[]> = opts.anchor
    ? engine.traversePaths(opts.anchor, { depth: graphDepth, direction: 'both', ...sourceScope })
        .then(paths => {
          const slugs = new Set<string>([opts.anchor!]);
          for (const p of paths) {
            slugs.add(p.from_slug);
            slugs.add(p.to_slug);
          }
          return Array.from(slugs);
        })
        .catch((e) => {
          process.stderr.write(`[think.gather] graph stream failed: ${(e as Error).message}\n`);
          return [] as string[];
        })
    : Promise.resolve([] as string[]);

  const [pages, takesKw, takesVec, graphSlugs] = await Promise.all([
    pagesPromise, takesKwPromise, takesVecPromise, graphPromise,
  ]);

  // Fuse takes streams (keyword + vector). Key by (page_slug, row_num).
  const fusedTakes = fuseRanked(
    takesKw, takesVec,
    (h: TakeHit) => `${h.page_slug}#${h.row_num}`,
  ).slice(0, takesLimit);

  return {
    pages: pages.slice(0, gatherLimit),
    takes: fusedTakes,
    graphSlugs,
    diagnostics: {
      pagesFromHybrid: pages.length,
      takesFromKeyword: takesKw.length,
      takesFromVector: takesVec.length,
      graphHits: graphSlugs.length,
      questionSanitizedFor: sanitizedQuestion === opts.question ? 'none' : 'expansion',
    },
  };
}

const EXCERPT_STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i',
  'if', 'in', 'including', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
  'or', 'our', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'these',
  'they', 'this', 'those', 'to', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

const MAX_EXCERPT_QUERY_TERMS = 24;
const EXCERPT_TOKEN_PATTERN =
  `[${CJK_SLUG_CHARS}]+|(?:(?![${CJK_SLUG_CHARS}])[\\p{L}\\p{N}])+`;
const CJK_TOKEN_PATTERN = new RegExp(`^[${CJK_SLUG_CHARS}]+$`, 'u');

function normalizeExcerptToken(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
}

interface ExcerptToken {
  normalized: string;
  start: number;
  end: number;
}

interface ExcerptQueryTerm {
  normalized: string;
  keys: string[];
  weight: number;
}

interface MatchedExcerptToken extends ExcerptToken {
  term: ExcerptQueryTerm;
}

/** Tokenize while preserving offsets in the original, un-normalized string. */
function excerptTokens(value: string): ExcerptToken[] {
  const tokens: ExcerptToken[] = [];
  for (const match of value.matchAll(new RegExp(EXCERPT_TOKEN_PATTERN, 'gu'))) {
    const raw = match[0];
    const start = match.index;
    if (CJK_TOKEN_PATTERN.test(raw)) {
      if (raw.length === 1) {
        tokens.push({ normalized: raw, start, end: start + 1 });
        continue;
      }
      for (let offset = 0; offset < raw.length - 1; offset++) {
        tokens.push({
          normalized: raw.slice(offset, offset + 2),
          start: start + offset,
          end: start + offset + 2,
        });
      }
      continue;
    }
    tokens.push({
      normalized: normalizeExcerptToken(raw),
      start,
      end: start + raw.length,
    });
  }
  return tokens;
}

/** Small, deterministic inflection set for lexical matches already accepted by search. */
function excerptMatchKeys(term: string): string[] {
  const keys = new Set([term]);
  const addRoot = (root: string): void => {
    if (root.length >= 4) keys.add(root);
  };
  if (term.length >= 6 && term.endsWith('ies')) addRoot(`${term.slice(0, -3)}y`);
  if (term.length >= 7 && term.endsWith('ing')) addRoot(term.slice(0, -3));
  if (term.length >= 6 && term.endsWith('ed')) addRoot(term.slice(0, -2));
  if (term.length >= 6 && term.endsWith('es')) addRoot(term.slice(0, -2));
  if (term.length >= 5 && term.endsWith('s') && !/(?:ss|us|is)$/.test(term)) {
    addRoot(term.slice(0, -1));
  }
  if (term.length >= 5 && term.endsWith('e')) addRoot(term.slice(0, -1));
  return Array.from(keys);
}

function boundedExcerptTerms(terms: ExcerptQueryTerm[]): ExcerptQueryTerm[] {
  if (terms.length <= MAX_EXCERPT_QUERY_TERMS) return terms;
  const edgeSize = MAX_EXCERPT_QUERY_TERMS / 2;
  return [...terms.slice(0, edgeSize), ...terms.slice(-edgeSize)];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function surrogateSafeWindowStart(content: string, requested: number): number {
  const start = Math.max(0, Math.min(requested, content.length));
  if (start <= 0 || start >= content.length) return start;
  const startsAtLow = isLowSurrogate(content.charCodeAt(start));
  const followsHigh = isHighSurrogate(content.charCodeAt(start - 1));
  return startsAtLow && followsHigh ? start + 1 : start;
}

function surrogateSafeWindowEnd(content: string, requested: number): number {
  const end = Math.max(0, Math.min(requested, content.length));
  if (end <= 0 || end >= content.length) return end;
  const endsAtHigh = isHighSurrogate(content.charCodeAt(end - 1));
  const followedByLow = isLowSurrogate(content.charCodeAt(end));
  return endsAtHigh && followedByLow ? end - 1 : end;
}

function excerptWindow(content: string, requestedStart: number, excerptLen: number): string {
  const boundedStart = Math.max(0, Math.min(requestedStart, content.length));
  const requestedEnd = Math.min(content.length, boundedStart + Math.max(0, excerptLen));
  const start = surrogateSafeWindowStart(content, boundedStart);
  const end = Math.max(start, surrogateSafeWindowEnd(content, requestedEnd));
  return ensureWellFormed(content.slice(start, end));
}

/** Select the fixed-budget window containing the strongest unique query-term coverage. */
function selectRelevantExcerpt(
  content: string,
  query: string,
  excerptLen: number,
  pageIdentity = '',
): string {
  if (excerptLen <= 0) return '';
  if (content.length <= excerptLen) return ensureWellFormed(content);

  const uniqueTerms = Array.from(new Set(
    excerptTokens(query)
      .map(token => token.normalized)
      .filter(term => term.length >= 2 && !EXCERPT_STOP_WORDS.has(term)),
  )).map(normalized => ({
    normalized,
    keys: excerptMatchKeys(normalized),
    weight: Math.min(normalized.length, 12),
  }));
  if (uniqueTerms.length === 0) return excerptWindow(content, 0, excerptLen);

  const identityKeys = new Set(
    excerptTokens(pageIdentity).flatMap(token => excerptMatchKeys(token.normalized)),
  );
  const attributeTerms = uniqueTerms.filter(
    term => !term.keys.some(key => identityKeys.has(key)),
  );
  const terms = boundedExcerptTerms(attributeTerms.length > 0 ? attributeTerms : uniqueTerms);
  const termByKey = new Map<string, ExcerptQueryTerm>();
  for (const term of terms) {
    for (const key of term.keys) {
      if (!termByKey.has(key)) termByKey.set(key, term);
    }
  }

  const matches: MatchedExcerptToken[] = [];
  for (const token of excerptTokens(content)) {
    let term: ExcerptQueryTerm | undefined;
    for (const key of excerptMatchKeys(token.normalized)) {
      term = termByKey.get(key);
      if (term) break;
    }
    if (term) matches.push({ ...token, term });
  }
  if (matches.length === 0) return excerptWindow(content, 0, excerptLen);

  const termCounts = new Map<string, number>();
  const maxStart = content.length - excerptLen;
  let left = 0;
  let currentScore = 0;
  let bestScore = 0;
  let bestStart = 0;

  for (let right = 0; right < matches.length; right++) {
    const added = matches[right].term;
    const addedCount = termCounts.get(added.normalized) ?? 0;
    termCounts.set(added.normalized, addedCount + 1);
    if (addedCount === 0) currentScore += added.weight;

    while (
      left <= right
      && matches[right].end - matches[left].start > excerptLen
    ) {
      const removed = matches[left].term;
      const remaining = (termCounts.get(removed.normalized) ?? 1) - 1;
      if (remaining === 0) {
        termCounts.delete(removed.normalized);
        currentScore -= removed.weight;
      } else {
        termCounts.set(removed.normalized, remaining);
      }
      left++;
    }

    while (left < right) {
      const redundant = matches[left].term;
      const count = termCounts.get(redundant.normalized) ?? 0;
      if (count <= 1) break;
      termCounts.set(redundant.normalized, count - 1);
      left++;
    }

    if (left > right) continue;
    const earliestStart = Math.max(0, matches[right].end - excerptLen);
    const contextualStart = Math.max(
      earliestStart,
      matches[left].start - Math.floor(excerptLen / 3),
    );
    const candidateStart = surrogateSafeWindowStart(
      content,
      Math.min(contextualStart, maxStart),
    );
    if (
      currentScore > bestScore
      || (currentScore === bestScore && candidateStart < bestStart)
    ) {
      bestScore = currentScore;
      bestStart = candidateStart;
    }
  }

  return excerptWindow(content, bestStart, excerptLen);
}

/**
 * Render gather results into the per-block strings the prompt builder uses.
 * Pages are rendered as `<page slug="..." score="...">excerpt</page>`;
 * takes are rendered via the renderTakesBlock helper from sanitize.ts.
 */
export function renderPagesBlock(
  pages: SearchResult[],
  excerptLen = 600,
  query = '',
): string {
  return pages.map((p, idx) => {
    const page = p as unknown as {
      slug?: string;
      title?: string;
      compiled_truth?: string;
      chunk_text?: string;
      snippet?: string;
    };
    const slug = String(page.slug ?? '');
    const title = String(page.title ?? '');
    const slugIdentity = slug.split('/').pop()?.replace(/[-_]/g, ' ') ?? '';
    const content = String(page.chunk_text ?? page.compiled_truth ?? page.snippet ?? '');
    const excerpt = selectRelevantExcerpt(
      content,
      query,
      excerptLen,
      `${title} ${slugIdentity}`,
    );
    return `<page slug="${slug}" rank="${idx + 1}">\n${excerpt}\n</page>`;
  }).join('\n\n');
}

export function takesHitToTakeForPrompt(h: TakeHit | Take): {
  page_slug: string; row_num: number; claim: string; kind: string;
  holder: string; weight: number; source?: string | null; since_date?: string | null;
} {
  // TakeHit + Take share the slug/claim/kind/holder/weight surface.
  const t = h as Take & TakeHit;
  return {
    page_slug: t.page_slug,
    row_num: t.row_num,
    claim: t.claim,
    kind: t.kind,
    holder: t.holder,
    weight: t.weight,
    source: 'source' in t ? (t as Take).source : null,
    since_date: 'since_date' in t ? (t as Take).since_date : null,
  };
}
