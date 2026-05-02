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

  // Sanitize the question for any path that includes it in an LLM prompt.
  // (Direct DB search is fine — those are parameterized queries.)
  const sanitizedQuestion = sanitizeQueryForPrompt(opts.question);

  // Stream 1: hybrid page search (existing primitive).
  const pagesPromise = hybridSearch(engine, opts.question, {
    limit: gatherLimit,
    expansion: false,  // think provides its own anchor + graph context; no need for re-expansion
  }).catch((e) => {
    process.stderr.write(`[think.gather] hybrid stream failed: ${(e as Error).message}\n`);
    return [] as SearchResult[];
  });

  // Stream 2: keyword search across takes.
  const takesKwPromise = engine.searchTakes(opts.question, {
    limit: takesLimit,
    takesHoldersAllowList: opts.takesHoldersAllowList,
  }).catch((e) => {
    process.stderr.write(`[think.gather] takes-keyword stream failed: ${(e as Error).message}\n`);
    return [] as TakeHit[];
  });

  // Stream 3: vector search across takes (only when an embedding is supplied).
  const takesVecPromise: Promise<TakeHit[]> = opts.questionEmbedding
    ? engine.searchTakesVector(opts.questionEmbedding, {
        limit: takesLimit,
        takesHoldersAllowList: opts.takesHoldersAllowList,
      }).catch((e) => {
        process.stderr.write(`[think.gather] takes-vector stream failed: ${(e as Error).message}\n`);
        return [] as TakeHit[];
      })
    : Promise.resolve([] as TakeHit[]);

  // Stream 4: graph walk (anchor only).
  const graphPromise: Promise<string[]> = opts.anchor
    ? engine.traversePaths(opts.anchor, { depth: graphDepth, direction: 'both' })
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

/**
 * Render gather results into the per-block strings the prompt builder uses.
 * Pages are rendered as `<page slug="..." score="...">excerpt</page>`;
 * takes are rendered via the renderTakesBlock helper from sanitize.ts.
 */
export function renderPagesBlock(pages: SearchResult[], excerptLen = 600): string {
  return pages.map((p, idx) => {
    const slug = String((p as unknown as { slug?: string }).slug ?? '');
    const excerpt = String(
      (p as unknown as { compiled_truth?: string; chunk_text?: string; snippet?: string }).chunk_text
      ?? (p as unknown as { compiled_truth?: string }).compiled_truth
      ?? (p as unknown as { snippet?: string }).snippet
      ?? '',
    ).slice(0, excerptLen);
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
