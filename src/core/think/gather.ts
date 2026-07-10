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
import type { Page, SearchResult } from '../types.ts';
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
  /**
   * Source scope for the anchor-page fetch + graph traversal. Mirrors
   * `sourceScopeOpts(ctx)`: `allowedSources` (federated array) wins over
   * the scalar `sourceId`. CLI callers omit both → engine default scope.
   */
  sourceId?: string;
  allowedSources?: string[];
}

export interface ThinkGatherResult {
  /** Page hits, ranked by RRF-fused score. */
  pages: SearchResult[];
  /** Take hits, ranked + dedup'd. */
  takes: TakeHit[];
  /** Graph nodes — slugs reachable from anchor within graphDepth. Empty when no anchor. */
  graphSlugs: string[];
  /**
   * The anchor entity's OWN page, fetched directly by slug (never via
   * search ranking). Null when no anchor was given or the slug did not
   * resolve to a page. This is the retrieval guarantee behind the
   * anchored-question contract: the canonical page is always in the
   * evidence set, regardless of what hybrid's top-K surfaced.
   */
  anchorPage: Page | null;
  /** Set when the anchor resolved to a different slug (basename → full slug). */
  anchorResolvedSlug?: string;
  /** Diagnostics for telemetry / `--explain` path (Lane D follow-up). */
  diagnostics: {
    pagesFromHybrid: number;
    takesFromKeyword: number;
    takesFromVector: number;
    graphHits: number;
    questionSanitizedFor: 'expansion' | 'none';
    /** True when an anchor was given AND its page was loaded into the evidence set. */
    anchorPageLoaded: boolean;
    /** Populated when the anchor was ambiguous (fuzzy resolution returned >1 candidate). */
    anchorAmbiguousCandidates?: string[];
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

  // Source scope shared by the anchor fetch + graph traversal. Federated
  // array wins over scalar (same precedence as sourceScopeOpts in operations.ts).
  const scope: { sourceId?: string; sourceIds?: string[] } =
    opts.allowedSources && opts.allowedSources.length > 0
      ? { sourceIds: opts.allowedSources }
      : opts.sourceId !== undefined
        ? { sourceId: opts.sourceId }
        : {};

  // Stream 0 (sequential pre-step): resolve the anchor slug and fetch its
  // page DIRECTLY — never rely on hybrid ranking to surface it. The
  // resolved slug also seeds the graph walk so a basename anchor still
  // traverses the right node.
  let anchorPage: Page | null = null;
  let anchorSlug: string | undefined = opts.anchor;
  let anchorAmbiguousCandidates: string[] | undefined;
  if (opts.anchor) {
    try {
      const resolved = await resolveAnchorPage(engine, opts.anchor, scope);
      anchorPage = resolved.page;
      if (resolved.page) anchorSlug = resolved.page.slug;
      if (resolved.ambiguous) anchorAmbiguousCandidates = resolved.ambiguous;
    } catch (e) {
      process.stderr.write(`[think.gather] anchor-page fetch failed: ${(e as Error).message}\n`);
    }
  }

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

  // Stream 4: graph walk (anchor only). Seeds on the RESOLVED slug so a
  // basename anchor traverses the real node, and inherits the source scope.
  const graphPromise: Promise<string[]> = anchorSlug
    ? engine.traversePaths(anchorSlug, { depth: graphDepth, direction: 'both', ...scope })
        .then(paths => {
          const slugs = new Set<string>([anchorSlug!]);
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

  // When the anchor page was loaded, drop its hybrid chunk hits: the full
  // page rides in its own <anchor_page> block, so 600-char excerpts of the
  // same page would only double-spend the gather budget.
  const dedupedPages = anchorPage
    ? pages.filter(p => p.slug !== anchorPage!.slug)
    : pages;

  return {
    pages: dedupedPages.slice(0, gatherLimit),
    takes: fusedTakes,
    graphSlugs,
    anchorPage,
    ...(anchorPage && anchorSlug !== opts.anchor ? { anchorResolvedSlug: anchorSlug } : {}),
    diagnostics: {
      pagesFromHybrid: pages.length,
      takesFromKeyword: takesKw.length,
      takesFromVector: takesVec.length,
      graphHits: graphSlugs.length,
      questionSanitizedFor: sanitizedQuestion === opts.question ? 'none' : 'expansion',
      anchorPageLoaded: anchorPage !== null,
      ...(anchorAmbiguousCandidates ? { anchorAmbiguousCandidates } : {}),
    },
  };
}

/**
 * Page types that record ARTIFACTS or derived content (digests, ledgers,
 * synthesis output, raw source captures) rather than a durable named entity.
 * Used ONLY to break basename collisions during anchor resolution: think's
 * `anchor` param is documented as an ENTITY slug, so when `foo` matches both
 * `projects/foo` (entity) and `documents/ledgers/foo` (artifact), the entity
 * page is the intended anchor. This is an exact structural filter on the
 * page's typed `type` field — when it does not isolate exactly one
 * candidate, resolution FAILS AMBIGUOUS (loud warning + retrieval-incomplete
 * posture downstream) rather than guessing.
 */
const ARTIFACT_PAGE_TYPES = new Set([
  'document', 'source', 'synthesis', 'meeting', 'email', 'slack',
  'calendar-event', 'conversation', 'atom', 'extract_receipt', 'media',
  'image', 'code', 'note', 'daily',
]);

/**
 * Resolve the anchor argument to its page. Ladder:
 *   1. exact slug (`getPage`)
 *   2. basename match — every page whose final `/`-segment equals the
 *      anchor (gbrain's `global_basename` wikilink convention). A unique
 *      match wins; a collision is broken by preferring the unique
 *      NON-artifact-typed candidate (see ARTIFACT_PAGE_TYPES).
 *   3. fuzzy `resolveSlugs`, accepted only when it returns exactly one
 *      candidate.
 * Anything still unresolved returns `{ page: null }`, with `ambiguous`
 * listing the colliding slugs when that was the reason.
 */
async function resolveAnchorPage(
  engine: BrainEngine,
  anchor: string,
  scope: { sourceId?: string; sourceIds?: string[] },
): Promise<{ page: Page | null; ambiguous?: string[] }> {
  // 1. Exact slug.
  const exact = await engine.getPage(anchor, scope);
  if (exact) return { page: exact };

  // 2. Basename matches, straight from pages (resolveSlugs ranks by title
  //    similarity with a low LIMIT and can drop the real basename match).
  const escaped = anchor.replace(/[\\%_]/g, m => '\\' + m);
  let sql = `SELECT slug, type FROM pages WHERE deleted_at IS NULL AND (slug = $1 OR slug LIKE $2 ESCAPE '\\')`;
  const params: unknown[] = [anchor, '%/' + escaped];
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    sql += ` AND source_id = ANY($3::text[])`;
    params.push(scope.sourceIds);
  } else if (scope.sourceId !== undefined) {
    sql += ` AND source_id = $3`;
    params.push(scope.sourceId);
  }
  sql += ` ORDER BY length(slug), slug LIMIT 16`;
  const rows = await engine.executeRaw<{ slug: string; type: string }>(sql, params);
  if (rows.length === 1) {
    return { page: await engine.getPage(rows[0].slug, scope) };
  }
  if (rows.length > 1) {
    const entities = rows.filter(r => !ARTIFACT_PAGE_TYPES.has(r.type));
    if (entities.length === 1) {
      return { page: await engine.getPage(entities[0].slug, scope) };
    }
    return { page: null, ambiguous: rows.map(r => r.slug).slice(0, 8) };
  }

  // 3. Fuzzy, unambiguous-only.
  const candidates = await engine.resolveSlugs(anchor, scope);
  if (candidates.length === 1) {
    return { page: await engine.getPage(candidates[0], scope) };
  }
  if (candidates.length > 1) {
    return { page: null, ambiguous: candidates.slice(0, 8) };
  }
  return { page: null };
}

/**
 * Anchor-page render caps. Generous by design: the anchor page is the
 * canonical record for an anchored question, and the D13 failure mode was
 * precisely a fresh fact living mid-page while search excerpts (600 chars)
 * carried stale fragments. ~30KB of anchor content ≈ 7-8K tokens — well
 * within the synthesis models' windows on top of the 40×600-char pages block.
 */
const ANCHOR_CONTENT_CAP = 24_000;
const ANCHOR_TIMELINE_CAP = 6_000;

/**
 * Render the anchor page as a dedicated `<anchor_page>` block. Unlike
 * `<pages>` excerpts this carries the page's full compiled_truth (up to the
 * cap) plus its timeline, so the synthesis model can actually check the
 * canonical record before claiming a fact is absent.
 */
export function renderAnchorPageBlock(page: Page): { rendered: string; truncated: boolean } {
  // Neutralize a literal close-tag inside page content so the block's
  // structural boundary survives (same posture as renderTakesBlock's
  // close-take escape).
  const guard = (s: string) => s.replace(/<\/(anchor_page)/gi, '<\\/$1');
  let truncated = false;
  let content = guard(page.compiled_truth ?? '');
  if (content.length > ANCHOR_CONTENT_CAP) {
    content = content.slice(0, ANCHOR_CONTENT_CAP) + '\n…[anchor page content truncated]';
    truncated = true;
  }
  let timeline = guard((page.timeline ?? '').trim());
  if (timeline.length > ANCHOR_TIMELINE_CAP) {
    timeline = timeline.slice(0, ANCHOR_TIMELINE_CAP) + '\n…[anchor timeline truncated]';
    truncated = true;
  }
  const escapeAttr = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const slugAttr = escapeAttr(page.slug);
  const titleAttr = escapeAttr(page.title);
  const updated = page.updated_at instanceof Date
    ? page.updated_at.toISOString().slice(0, 10)
    : String(page.updated_at ?? '').slice(0, 10);
  const updatedAttr = escapeAttr(updated);
  const parts = [
    `<anchor_page slug="${slugAttr}" title="${titleAttr}" updated="${updatedAttr}">`,
    content,
  ];
  if (timeline.length > 0) {
    parts.push('', '## Timeline', timeline);
  }
  parts.push('</anchor_page>');
  return { rendered: parts.join('\n'), truncated };
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
