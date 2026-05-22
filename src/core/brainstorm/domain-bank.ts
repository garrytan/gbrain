/**
 * v0.37.0 — domain-bank: prefix-stratified far-page retrieval for
 * `gbrain brainstorm` + `gbrain lsd` (D14).
 *
 * Orthogonal to hybridSearch (codex round 1 #1+#2+#3 fix). Does NOT touch
 * the search cache, SearchOpts, or post-fusion stages. Pulls "far" pages
 * directly from the corpus via two complementary strategies:
 *
 *   1. PRIMARY: prefix-stratified sampling. One page per distinct top-level
 *      slug prefix (`wiki/vc`, `wiki/biology`, `concepts/`, etc) — the
 *      user's own brain organization IS the domain bank. Tiebroken by
 *      `connection_count` (inbound link count via JOIN to page_links,
 *      D10). LSD mode adds stale-bias (D5 / D15) preferring forgotten pages.
 *
 *   2. FALLBACK: corpus-sampling. When primary returns < M (small brain,
 *      single-prefix corpus, or close-set ate all the prefixes), random-
 *      sample additional pages to fill the target. Distance-filtered against
 *      the question + close-set so we still get "far" pages, just not from
 *      distinct prefixes.
 *
 *   3. SPARSE WARNING: when even fallback can't fill M (D11), emit a
 *      data-driven stderr warning and proceed with what we have. Do NOT
 *      fall back to LLM-invented domains — that undercuts the brain-native
 *      thesis.
 *
 * Prefix enumeration cached in the `config` table with 1h TTL (D3 +
 * codex round 2 #7 — source-scoped). Cache miss does a full
 * `SELECT DISTINCT substring(slug from '^[^/]+/[^/]+') FROM pages` (~100-500ms
 * on 30K-page brains); 99%+ of brainstorm calls hit the cache.
 *
 * Far-page content sanitized via INJECTION_PATTERNS from `think/sanitize.ts`
 * — same trust boundary as takes content (v0.28.8).
 *
 * Distance score normalized per codex round 2 #9:
 *   `distance_score = 1 - clamp(cosine_distance, 0, 2) / 2`
 * Range [0, 1] where 1 = orthogonal/opposite, 0 = identical. Powers D6's
 * citation badges so users see how far each collision actually traveled.
 */

import type { BrainEngine } from '../engine.ts';
import type { DomainBankRow } from '../types.ts';
import { INJECTION_PATTERNS } from '../think/sanitize.ts';

/** Default 1-hour TTL for the prefix-enumeration cache (D3). */
export const PREFIX_CACHE_TTL_MS = 60 * 60 * 1000;

/** Per-far-page content cap before injection into the LLM prompt. */
const FAR_CONTENT_LENGTH_CAP = 4000;

/** Close-set ref the orchestrator passes for distance calc + prefix exclusion. */
export interface CloseRef {
  slug: string;
  /** Used to exclude this prefix from primary path so close + far don't overlap. */
  prefix?: string | null;
  /** Used as distance reference; null when the close-page has no embedded chunks. */
  representative_chunk_id?: number | null;
}

/** Caller-facing options for the domain-bank orchestrator entry point. */
export interface FetchFarOpts {
  /** Target far-page count. brainstorm=6, lsd=12 (per D14 / plan). */
  m: number;
  /** Close-set from hybridSearch (used for exclusion + distance ref). */
  closeSet: CloseRef[];
  /** Question embedding; used as the distance anchor when close-set is empty (LSD K=0). */
  questionEmbedding: Float32Array | null;
  /** When true (LSD), prefer never-retrieved or stale-by-N-days pages. */
  staleBias?: boolean;
  /** Stale-bias day threshold. Default 90. */
  staleThresholdDays?: number;
  /** Source scope (canonical scalar). */
  sourceId?: string;
  /** Federated read scope (array). */
  sourceIds?: string[];
  /** Override the prefix-cache TTL (tests only). */
  prefixCacheTtlMs?: number;
  /** Override the prefix list (tests — bypasses cache + enumeration). */
  prefixListOverride?: string[];
  /** Default embedding column for distance calc + getEmbeddingsByChunkIds lookup. */
  embeddingColumn?: string;
}

/** One far-page result enriched with distance + provenance. */
export interface FarPage {
  slug: string;
  source_id: string;
  prefix: string | null;
  page_id: number;
  title: string | null;
  /** INJECTION_PATTERNS-sanitized, length-capped. Safe to embed in an LLM prompt. */
  content: string;
  /** Cosine distance from this page to the closest of the close-set (or question if close-set empty). Normalized 0-1 per codex r2 #9. */
  distance_score: number;
  /** Inbound link count via page_links (tiebreaker, exposed for citation transparency). */
  connection_count: number;
  /** When this page was last surfaced by a user-facing op. Null = never retrieved (LSD's prized signal). */
  last_retrieved_at: Date | null;
  /** Which sampling strategy produced this page. */
  source: 'prefix-stratified' | 'corpus-sample';
}

/** Top-level orchestrator return. */
export interface FetchFarResult {
  pages: FarPage[];
  /** Distinct prefixes available in the brain's source scope (after close-set exclusion). */
  available_prefixes: number;
  /** Distinct prefixes total before close-set exclusion. */
  total_prefixes: number;
  /** True iff corpus-sampling fallback fired. */
  used_fallback: boolean;
  /** True iff result still short of `m` after fallback. Triggers D11 stderr warn. */
  short_of_target: boolean;
}

// ---------------------------------------------------------------------------
// Prefix cache (D3 + codex r2 #7 source-scoped)
// ---------------------------------------------------------------------------

interface PrefixCacheEntry {
  prefixes: string[];
  cached_at: number;
}

function prefixCacheKey(sourceId: string | undefined): string {
  // Source-scoped per codex round 2 #7. Federated/mounted brains MUST use
  // the per-source key to avoid serving prefixes from a foreign source.
  return `brainstorm.domain_bank.prefixes:${sourceId ?? 'default'}`;
}

/**
 * Read + validate the cached prefix list for `sourceId`. Returns null on
 * cache miss, expired entry, parse failure, or invalid shape.
 */
async function readPrefixCache(
  engine: BrainEngine,
  sourceId: string | undefined,
  ttlMs: number
): Promise<string[] | null> {
  let raw: string | null;
  try {
    raw = await engine.getConfig(prefixCacheKey(sourceId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as PrefixCacheEntry).prefixes)
    || typeof (parsed as PrefixCacheEntry).cached_at !== 'number'
  ) {
    return null;
  }
  const entry = parsed as PrefixCacheEntry;
  if (Date.now() - entry.cached_at > ttlMs) return null;
  // Type-narrow: every entry must be a string.
  for (const p of entry.prefixes) {
    if (typeof p !== 'string') return null;
  }
  return entry.prefixes;
}

async function writePrefixCache(
  engine: BrainEngine,
  sourceId: string | undefined,
  prefixes: string[]
): Promise<void> {
  const entry: PrefixCacheEntry = { prefixes, cached_at: Date.now() };
  try {
    await engine.setConfig(prefixCacheKey(sourceId), JSON.stringify(entry));
  } catch (err) {
    // Cache-write failures are non-fatal — next call re-enumerates.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[domain-bank] prefix-cache write failed (non-fatal): ${msg}`);
  }
}

/**
 * Enumerate distinct top-level prefixes from `pages.slug`. The regex
 * `^[^/]+/[^/]+` captures the first two segments. Single-segment slugs
 * (e.g. `alice`) match nothing and are excluded from the bank — they
 * can't be cross-referenced because they have no domain to compare.
 *
 * codex round 2 #7: source-scoped via `WHERE source_id = ANY($1::text[])`
 * when scope is set; cross-source view otherwise.
 */
export async function enumeratePrefixes(
  engine: BrainEngine,
  opts: { sourceId?: string; sourceIds?: string[] }
): Promise<string[]> {
  const sourceIds = opts.sourceIds ?? null;
  const sourceId = opts.sourceId ?? null;
  const rows = await engine.executeRaw<{ prefix: string | null }>(
    `SELECT DISTINCT substring(slug from '^[^/]+/[^/]+') AS prefix
       FROM pages
       WHERE deleted_at IS NULL
         AND substring(slug from '^[^/]+/[^/]+') IS NOT NULL
         AND (
           ($1::text[] IS NOT NULL AND source_id = ANY($1::text[]))
           OR ($1::text[] IS NULL AND $2::text IS NOT NULL AND source_id = $2)
           OR ($1::text[] IS NULL AND $2::text IS NULL)
         )
       ORDER BY prefix`,
    [sourceIds, sourceId]
  );
  return rows
    .map((r) => r.prefix)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

// ---------------------------------------------------------------------------
// Content sanitization + length cap
// ---------------------------------------------------------------------------

/**
 * Apply INJECTION_PATTERNS (same as takes content per v0.28.8) and cap at
 * FAR_CONTENT_LENGTH_CAP. Far-page content goes into the LLM prompt as
 * "you wrote ...", so the same trust boundary applies.
 */
function sanitizeFarContent(raw: string): string {
  let text = raw;
  for (const p of INJECTION_PATTERNS) {
    if (p.rx.test(text)) {
      text = text.replace(p.rx, p.replacement);
    }
  }
  if (text.length > FAR_CONTENT_LENGTH_CAP) {
    text = text.slice(0, FAR_CONTENT_LENGTH_CAP - 3) + '...';
  }
  return text;
}

// ---------------------------------------------------------------------------
// Cosine distance + normalization (codex round 2 #9)
// ---------------------------------------------------------------------------

/**
 * Cosine distance between two embeddings, normalized to [0, 1] where
 * 1 = orthogonal/opposite, 0 = identical.
 *
 * Test cases pinned per codex r2 #9:
 *   - same-vector → 0
 *   - orthogonal → 0.5
 *   - opposite → 1
 *   - missing-vector → caller skips (returns null at retrieval time)
 *
 * Internal cosine_distance = 1 - cos_sim, range [0, 2] for unit-norm
 * vectors. We clamp + halve so the final distance_score is well-bounded.
 */
export function normalizedCosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`normalizedCosineDistance: dim mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0.5; // zero-vector edge: neutral distance.
  const cosSim = dot / denom;
  const cosDist = 1 - cosSim; // [0, 2] for unit-norm; can drift slightly outside.
  // Clamp to [0, 2] then halve → [0, 1].
  const clamped = Math.max(0, Math.min(2, cosDist));
  return clamped / 2;
}

/**
 * Distance from `farEmbed` to the closest of `refEmbeds`. If `refEmbeds`
 * is empty, fall back to questionEmbedding. If both empty, return 0.5
 * (neutral — no reference available).
 */
function distanceFromClosest(
  farEmbed: Float32Array | null,
  refEmbeds: Float32Array[],
  questionEmbed: Float32Array | null
): number {
  if (!farEmbed) return 0.5; // no embedding on far page; can't compute.
  if (refEmbeds.length === 0) {
    if (!questionEmbed) return 0.5;
    return normalizedCosineDistance(farEmbed, questionEmbed);
  }
  let minDist = Infinity;
  for (const ref of refEmbeds) {
    const d = normalizedCosineDistance(farEmbed, ref);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

/**
 * Pull M far pages from the brain's source scope. Returns `pages.length <= m`;
 * caller emits the D11 sparse warning when `short_of_target === true`.
 *
 * Empty-brain handling (codex round 2 #6 — refuse cleanly): when the brain
 * has <K+M total pages OR zero usable prefixes AND the corpus is empty,
 * we still return an empty result with `short_of_target=true`. The CLI
 * surfaces the paste-ready hint ("Brain has <K+M pages; try gbrain import").
 */
export async function fetchFar(
  engine: BrainEngine,
  opts: FetchFarOpts
): Promise<FetchFarResult> {
  const m = opts.m;
  if (m <= 0) {
    return {
      pages: [],
      available_prefixes: 0,
      total_prefixes: 0,
      used_fallback: false,
      short_of_target: false,
    };
  }
  const ttlMs = opts.prefixCacheTtlMs ?? PREFIX_CACHE_TTL_MS;
  const embeddingColumn = opts.embeddingColumn;

  // ---- Step 1: prefix enumeration (cache → DB) ----
  let allPrefixes: string[];
  if (opts.prefixListOverride) {
    allPrefixes = opts.prefixListOverride;
  } else {
    const cached = await readPrefixCache(engine, opts.sourceId, ttlMs);
    if (cached) {
      allPrefixes = cached;
    } else {
      allPrefixes = await enumeratePrefixes(engine, {
        sourceId: opts.sourceId,
        sourceIds: opts.sourceIds,
      });
      void writePrefixCache(engine, opts.sourceId, allPrefixes);
    }
  }
  const totalPrefixes = allPrefixes.length;

  // ---- Step 2: filter prefixes that overlap with close-set ----
  const closePrefixSet = new Set<string>();
  for (const c of opts.closeSet) {
    if (c.prefix) closePrefixSet.add(c.prefix);
  }
  const candidatePrefixes = allPrefixes.filter((p) => !closePrefixSet.has(p));
  const availablePrefixes = candidatePrefixes.length;
  const closeSlugs = opts.closeSet.map((c) => c.slug);

  // ---- Step 3: primary path — listPrefixSampledPages ----
  let primaryRows: DomainBankRow[] = [];
  if (candidatePrefixes.length > 0) {
    primaryRows = await engine.listPrefixSampledPages({
      prefixes: candidatePrefixes,
      excludeSlugs: closeSlugs,
      staleBias: opts.staleBias,
      staleThresholdDays: opts.staleThresholdDays,
      sourceId: opts.sourceId,
      sourceIds: opts.sourceIds,
    });
  }

  // ---- Step 4: fallback if primary didn't fill M ----
  let fallbackRows: DomainBankRow[] = [];
  let usedFallback = false;
  if (primaryRows.length < m) {
    const need = m - primaryRows.length;
    const excludeForFallback = [
      ...closeSlugs,
      ...primaryRows.map((r) => r.slug),
    ];
    fallbackRows = await engine.listCorpusSample({
      n: need,
      excludeSlugs: excludeForFallback,
      sourceId: opts.sourceId,
      sourceIds: opts.sourceIds,
    });
    usedFallback = fallbackRows.length > 0;
  }

  // ---- Step 5: hydrate embeddings for distance calc ----
  const allRows: Array<{ row: DomainBankRow; src: 'prefix-stratified' | 'corpus-sample' }> = [
    ...primaryRows.map((row) => ({ row, src: 'prefix-stratified' as const })),
    ...fallbackRows.map((row) => ({ row, src: 'corpus-sample' as const })),
  ];

  // Build the chunk-id list for one batched embedding lookup. Skip rows
  // without a representative chunk (no embedded content).
  const closeChunkIds = opts.closeSet
    .map((c) => c.representative_chunk_id)
    .filter((id): id is number => typeof id === 'number');
  const farChunkIds = allRows
    .map((r) => r.row.representative_chunk_id)
    .filter((id): id is number => typeof id === 'number');
  const chunkIds = [...new Set([...closeChunkIds, ...farChunkIds])];
  let embeddings: Map<number, Float32Array> = new Map();
  if (chunkIds.length > 0) {
    embeddings = await engine.getEmbeddingsByChunkIds(chunkIds, embeddingColumn);
  }

  const refEmbeds: Float32Array[] = closeChunkIds
    .map((id) => embeddings.get(id))
    .filter((e): e is Float32Array => e !== undefined);

  // ---- Step 6: build FarPage results with normalized distance ----
  const pages: FarPage[] = allRows.map(({ row, src }) => {
    const farEmbed = row.representative_chunk_id != null
      ? embeddings.get(row.representative_chunk_id) ?? null
      : null;
    const distance_score = distanceFromClosest(farEmbed, refEmbeds, opts.questionEmbedding);
    return {
      slug: row.slug,
      source_id: row.source_id,
      prefix: row.prefix,
      page_id: row.page_id,
      title: row.title,
      content: sanitizeFarContent(row.compiled_truth),
      distance_score,
      connection_count: row.connection_count,
      last_retrieved_at: row.last_retrieved_at,
      source: src,
    };
  });

  return {
    pages,
    available_prefixes: availablePrefixes,
    total_prefixes: totalPrefixes,
    used_fallback: usedFallback,
    short_of_target: pages.length < m,
  };
}
