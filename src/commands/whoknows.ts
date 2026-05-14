/**
 * gbrain whoknows — "Who should I talk to about X?"
 *
 * v0.33 wedge: expertise + relationship-proximity routing query.
 * Returns ranked person/company candidates from the brain that
 * know about the given topic.
 *
 * Ranking spec (locked by ENG-D1):
 *
 *   score(page) = expertise × max(0.1, recency_decay) × (0.5 + 0.5 × salience)
 *
 *   where:
 *     expertise     = log(1 + chunk_match_count)
 *                       // sub-linear; prevents one-big-page-dominates.
 *                       // v0.33 implementation uses hybrid search's raw
 *                       // score as a proxy for chunk_match_count (search
 *                       // score is already a non-linear relevance signal
 *                       // post-RRF + source-boost). The eval gate will
 *                       // tell us if we need the literal count.
 *     recency_decay = exp(-days_since_effective_date / 180)
 *                       // ~6 month half-life; floored at 0.1 so cold-start
 *                       // people stay visible (multiplicative-zero defense).
 *     salience      = pages.salience_score (already 0..1)
 *                       // linear; centered at 0.5 so missing-salience = neutral.
 *
 * The query path is hybrid search (keyword + vector + RRF + source-boost)
 * filtered at SQL level to person/company pages via the new SearchOpts.types
 * parameter (no post-filter waste). Salience and recency boosts in
 * hybridSearch are disabled (we apply our own formula on top of the
 * raw relevance score).
 *
 * Usage:
 *   gbrain whoknows "lab automation"
 *   gbrain whoknows "fintech compliance" --explain
 *   gbrain whoknows "ai agents" --limit 10 --json
 */

import type { BrainEngine } from '../core/engine.ts';
import type { PageType, SearchResult } from '../core/types.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';

export interface WhoknowsOpts {
  topic: string;
  limit?: number;
  explain?: boolean;
  /**
   * Override the default person/company filter. Most callers should leave
   * this undefined and accept the default; surface is here so future ops
   * (find_experts_in_companies, find_advisors, etc.) can reuse the
   * ranking function without redefining the type filter.
   */
  types?: PageType[];
  /**
   * v0.34.0 (#861, D3 — P0 leak seal): scope expert candidates to a
   * single source. The op-handler at operations.ts:find_experts threads
   * `ctx.sourceId` here so an authenticated MCP client scoped to src-A
   * cannot surface people pages from src-B in the rankings. Pre-fix, the
   * whoknows op was authored against v0.33 after PR #861 was drafted and
   * the source-scope thread was missing entirely.
   */
  sourceId?: string;
  /**
   * v0.34.0 (#876, D9): federated read — scope candidates to ANY of these
   * source ids. Threaded from `ctx.auth?.allowedSources` via
   * `sourceScopeOpts` in operations.ts. Array wins over scalar `sourceId`.
   */
  sourceIds?: string[];
}

export interface WhoknowsResult {
  slug: string;
  source_id: string;
  title: string;
  type: PageType;
  score: number;
  factors: {
    expertise: number;
    recency_decay: number;
    recency_factor: number;
    salience: number;
    salience_factor: number;
    days_since_effective: number | null;
    raw_match: number;
  };
}

const DEFAULT_TYPES: PageType[] = ['person', 'company'];
const DEFAULT_LIMIT = 5;
const RECENCY_HALF_LIFE_DAYS = 180; // 6 months
const RECENCY_FLOOR = 0.1;
const SALIENCE_CENTER = 0.5; // missing salience = neutral

/**
 * Pure ranking function. Exported for tests; the CLI/MCP path calls
 * findExperts() which adds the search step.
 *
 * Inputs are pre-fetched candidates with their raw_match + recency +
 * salience signals; output is the same set with computed final scores
 * and full factor breakdown for --explain.
 */
export function rankCandidates(
  candidates: Array<{
    slug: string;
    source_id: string;
    title: string;
    type: PageType;
    raw_match: number;
    days_since_effective: number | null;
    salience_raw: number | null;
  }>,
  limit: number = DEFAULT_LIMIT,
): WhoknowsResult[] {
  const ranked = candidates.map((c) => {
    // expertise: sub-linear via log(1 + raw_match). raw_match comes from
    // hybridSearch's score, which is already RRF + source-boost-adjusted.
    // Clamp to 0 to defend against negative-score producers; log(1+0)=0.
    const safeRaw = Math.max(0, Number.isFinite(c.raw_match) ? c.raw_match : 0);
    const expertise = Math.log1p(safeRaw);

    // recency_decay: exp(-days/180). Floor at 0.1 so cold-start (no
    // effective_date) people don't multiplicative-zero out.
    let recency_decay: number;
    if (c.days_since_effective == null || !Number.isFinite(c.days_since_effective)) {
      recency_decay = RECENCY_FLOOR;
    } else {
      const days = Math.max(0, c.days_since_effective);
      recency_decay = Math.exp(-days / RECENCY_HALF_LIFE_DAYS);
    }
    const recency_factor = Math.max(RECENCY_FLOOR, recency_decay);

    // salience: linear, centered at 0.5. NaN / out-of-range → 0.5 neutral.
    let salience = c.salience_raw == null ? SALIENCE_CENTER : c.salience_raw;
    if (!Number.isFinite(salience)) salience = SALIENCE_CENTER;
    salience = Math.min(1, Math.max(0, salience));
    const salience_factor = 0.5 + 0.5 * salience;

    const score = expertise * recency_factor * salience_factor;

    return {
      slug: c.slug,
      source_id: c.source_id,
      title: c.title,
      type: c.type,
      score: Number.isFinite(score) ? score : 0,
      factors: {
        expertise,
        recency_decay,
        recency_factor,
        salience,
        salience_factor,
        days_since_effective: c.days_since_effective,
        raw_match: c.raw_match,
      },
    };
  });

  // Sort by score DESC; tie-break by slug alphabetical for determinism.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slug.localeCompare(b.slug);
  });

  return ranked.slice(0, Math.max(1, limit));
}

/**
 * Public entrypoint. Searches, fetches per-candidate signals,
 * applies the locked ranking spec, returns top-K.
 */
export async function findExperts(
  engine: BrainEngine,
  opts: WhoknowsOpts,
): Promise<WhoknowsResult[]> {
  const types = opts.types ?? DEFAULT_TYPES;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const innerLimit = Math.max(limit * 10, 50);

  // 1. Hybrid search with SQL-level types filter (v0.33 typeFilter parameter).
  //    Disable salience + recency boosts in hybridSearch — we apply our own
  //    locked formula on top of the raw relevance score.
  //    v0.34.0 (#861, D3): thread source-scope so an authenticated MCP
  //    client only ranks experts within its accessible sources.
  const results: SearchResult[] = await hybridSearch(engine, opts.topic, {
    types,
    limit: innerLimit,
    salience: 'off',
    recency: 'off',
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
  });

  if (results.length === 0) return [];

  // 2. Dedup to one row per (slug, source_id) — hybridSearch already does
  //    chunk-grain dedup, but defend against duplicates from cross-source
  //    fan-out by taking max raw_match per composite key.
  const byKey = new Map<string, SearchResult>();
  for (const r of results) {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    const prev = byKey.get(key);
    if (!prev || r.score > prev.score) byKey.set(key, r);
  }
  const candidates = Array.from(byKey.values());

  // 3. Batch-fetch salience + effective_date per (slug, source_id) ref.
  const refs = candidates.map((c) => ({
    slug: c.slug,
    source_id: c.source_id ?? 'default',
  }));
  const [salienceMap, dateMap] = await Promise.all([
    engine.getSalienceScores(refs).catch(() => new Map<string, number>()),
    engine.getEffectiveDates(refs).catch(() => new Map<string, Date>()),
  ]);

  // 4. Build the ranking-function input shape.
  const now = Date.now();
  const inputs = candidates.map((c) => {
    const sourceId = c.source_id ?? 'default';
    const key = `${sourceId}::${c.slug}`;
    const salienceRaw = salienceMap.get(key);
    // Salience scores from getSalienceScores are emotional_weight × 5 +
    // ln(1+take_count); they're unbounded, not 0..1. Normalize by clamping
    // to [0, 1] via a tanh-ish squash: ratio = score / (1 + score).
    const salienceNormalized =
      salienceRaw == null || !Number.isFinite(salienceRaw) || salienceRaw < 0
        ? null
        : salienceRaw / (1 + salienceRaw);
    const dateObj = dateMap.get(key);
    let daysSinceEffective: number | null = null;
    if (dateObj instanceof Date && Number.isFinite(dateObj.getTime())) {
      daysSinceEffective = (now - dateObj.getTime()) / 86_400_000;
      if (daysSinceEffective < 0) daysSinceEffective = 0;
    }
    return {
      slug: c.slug,
      source_id: sourceId,
      title: c.title,
      type: c.type,
      raw_match: c.score,
      days_since_effective: daysSinceEffective,
      salience_raw: salienceNormalized,
    };
  });

  // 5. Rank.
  return rankCandidates(inputs, limit);
}

// ---------------- CLI dispatch ----------------

interface CliOpts {
  topic: string;
  limit?: number;
  explain?: boolean;
  json?: boolean;
}

function parseArgs(args: string[]): CliOpts | { help: true } | { error: string } {
  const opts: Partial<CliOpts> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--explain') { opts.explain = true; continue; }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
    if (a?.startsWith('--')) continue; // ignore unknown flags
    if (typeof a === 'string') positional.push(a);
  }
  if (positional.length === 0) return { error: 'topic argument required' };
  opts.topic = positional.join(' ');
  return opts as CliOpts;
}

const HELP = `Usage: gbrain whoknows <topic> [options]

Ask your brain who knows about a topic. Returns ranked person/company
pages by expertise depth, relationship recency, and salience.

Options:
  --limit N           Max results (default 5)
  --explain           Show the ranking factor breakdown per result
  --json              JSON output for agents
  --help, -h          Show this help

Examples:
  gbrain whoknows "lab automation"
  gbrain whoknows fintech compliance --explain
  gbrain whoknows "ai agents" --limit 10 --json
`;

export async function runWhoknows(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if ('error' in parsed) {
    console.error(`gbrain whoknows: ${parsed.error}`);
    console.error(HELP);
    process.exit(2);
    return;
  }

  // Thin-client routing (v0.31.1): route through the remote `find_experts`
  // MCP op when this install has no local brain.
  let results: WhoknowsResult[];
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const raw = await callRemoteTool(cfg!, 'find_experts', {
      topic: parsed.topic,
      limit: parsed.limit,
      explain: parsed.explain,
    }, { timeoutMs: 30_000 });
    results = unpackToolResult<WhoknowsResult[]>(raw);
  } else {
    results = await findExperts(engine, {
      topic: parsed.topic,
      limit: parsed.limit,
      explain: parsed.explain,
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`(no person or company pages match "${parsed.topic}")`);
    return;
  }

  // Human format: rank | score | type | slug — title
  const header = `${pad('#', 3)} ${pad('score', 7)} ${pad('type', 8)} slug — title`;
  console.log(header);
  console.log('-'.repeat(Math.min(80, header.length)));
  results.forEach((r, i) => {
    const score = r.score.toFixed(3);
    console.log(
      `${pad(String(i + 1), 3)} ${pad(score, 7)} ${pad(r.type, 8)} ${r.slug} — ${r.title}`,
    );
    if (parsed.explain) {
      const f = r.factors;
      const days = f.days_since_effective == null ? 'cold' : f.days_since_effective.toFixed(0);
      console.log(
        `      expertise=${f.expertise.toFixed(3)} (raw=${f.raw_match.toFixed(3)}) ` +
          `recency=${f.recency_factor.toFixed(3)} (${days}d) ` +
          `salience=${f.salience.toFixed(3)} → factor=${f.salience_factor.toFixed(3)}`,
      );
    }
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
