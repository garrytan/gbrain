/**
 * v0.34 W3 — recursive caller (blast) / callee (flow) walks.
 *
 * Wraps the single-hop engine methods (getCallersOf, getCalleesOf) in a
 * BFS that returns depth-grouped responses. Bounded by depth + max_nodes
 * caps + cycle detection via visited-set.
 *
 * Response envelope (shared by code_blast + code_flow):
 *   { result: 'ok' | 'not_found' | 'ambiguous' | 'unsupported_language',
 *     depth_groups?: [{ depth, nodes, confidence }, ...],
 *     cycles_detected?: bool,
 *     truncation?: 'none' | 'max_nodes' | 'depth_cap' | 'both',
 *     freshness?: 'fresh' | 'partial',
 *     did_you_mean?: [{ symbol_qualified, score }],
 *     candidates?: [{ symbol_qualified, lang, file, lines }] }
 */
import type { BrainEngine } from '../engine.ts';
import type { CodeEdgeResult } from '../types.ts';
import { classifySink, type SinkKind } from './sinks/index.ts';
import { codeReadFilter } from './read-scope.ts';

export type WalkDirection = 'callers' | 'callees';

export interface WalkOpts {
  /** Direction: callers (blast) or callees (flow). */
  direction: WalkDirection;
  /** Hard cap on hop count. Default 5 for blast, 8 for flow. */
  depth?: number;
  /** Hard cap on total nodes returned. Default 200. */
  maxNodes?: number;
  /** Source filter; v0.34 is source-scoped. */
  sourceId: string;
  /** Forces exact-string match (skips bare-name disambiguation). */
  exact?: boolean;
}

export interface WalkNode {
  symbol: string;
  /** Origin chunk for the edge, when known. */
  chunk_id?: number;
  /** Sink kind for terminal nodes in code_flow. */
  sink_kind?: SinkKind;
}

export interface DepthGroup {
  depth: number;
  nodes: WalkNode[];
  /** confidence = 1 / (1 + 0.3 * depth), clamped to [0.05, 1.0] */
  confidence: number;
}

export type WalkResult =
  | {
      result: 'ok';
      depth_groups: DepthGroup[];
      cycles_detected: boolean;
      truncation: 'none' | 'max_nodes' | 'depth_cap' | 'both';
      freshness: 'fresh' | 'partial';
      terminal_nodes?: { symbol: string; sink_kind: SinkKind }[];
    }
  | { result: 'not_found'; did_you_mean: { symbol_qualified: string; score: number }[] }
  | { result: 'ambiguous'; candidates: { symbol_qualified: string; lang?: string; file?: string; lines?: string }[] }
  | { result: 'unsupported_language'; supported: readonly string[] };

const SUPPORTED_LANGS = ['typescript', 'tsx', 'javascript', 'python'] as const;

function clampConfidence(depth: number): number {
  const c = 1.0 / (1 + 0.3 * depth);
  return Math.max(0.05, Math.min(1.0, c));
}

/**
 * Try to disambiguate a bare-name input to a qualified symbol. Returns:
 *   - a single match → returns that string (caller proceeds with walk)
 *   - 2+ matches → caller emits {result:'ambiguous', candidates}
 *   - 0 matches  → caller emits {result:'not_found', did_you_mean}
 */
async function disambiguateSymbol(
  engine: BrainEngine,
  bare: string,
  sourceId: string,
): Promise<{ matches: string[]; suggestions: { symbol_qualified: string; score: number }[] }> {
  try {
    // Exact-match candidates first: anything with symbol_name = bare
    const exact = await engine.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${codeReadFilter([], {})}
          AND symbol_name_qualified IS NOT NULL
          AND (symbol_name = $2 OR symbol_name_qualified = $2)
        LIMIT 25`,
      [sourceId, bare],
    );
    const matches = exact.map((r) => r.symbol_name_qualified);
    if (matches.length > 0) return { matches, suggestions: [] };

    // No exact match — try trigram similarity for did_you_mean. Many
    // engines don't have pg_trgm by default; fall back to LIKE-prefix.
    const fuzzy = await engine.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${codeReadFilter([], {})}
          AND symbol_name_qualified IS NOT NULL
          AND symbol_name_qualified ILIKE $2
        LIMIT 5`,
      [sourceId, `%${bare}%`],
    );
    return {
      matches: [],
      suggestions: fuzzy.map((r) => ({
        symbol_qualified: r.symbol_name_qualified,
        score: 0.5, // placeholder; v0.34.1 wires real trigram score
      })),
    };
  } catch {
    return { matches: [], suggestions: [] };
  }
}

/**
 * Languages of every chunk defining a qualified symbol. A bare name can be
 * defined in several files and languages at once (gbrain-evals N13-3: a Go
 * and a Python `shared_helper` share the qualified name), so the gate must
 * see all of them, not one arbitrary row.
 */
async function symbolLanguages(
  engine: BrainEngine,
  qualified: string,
  sourceId: string,
): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ language: string | null }>(
      `SELECT DISTINCT content_chunks.language
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${codeReadFilter([], {})}
          AND content_chunks.symbol_name_qualified = $2
          AND content_chunks.language IS NOT NULL`,
      [sourceId, qualified],
    );
    return rows.map((r) => r.language as string);
  } catch {
    return [];
  }
}

const isSupportedLang = (lang: string): boolean =>
  SUPPORTED_LANGS.includes(lang as (typeof SUPPORTED_LANGS)[number]);

/** Edge origin chunks written in a supported language (one batched read). */
async function supportedChunkIds(engine: BrainEngine, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM content_chunks WHERE id = ANY($1::int[]) AND language = ANY($2::text[])`,
    [ids, [...SUPPORTED_LANGS]],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * BFS recursive walk. Returns the depth-grouped result envelope.
 */
export async function runRecursiveWalk(
  engine: BrainEngine,
  symbol: string,
  opts: WalkOpts,
): Promise<WalkResult> {
  const depthCap = opts.depth ?? (opts.direction === 'callers' ? 5 : 8);
  const maxNodes = opts.maxNodes ?? 200;

  // Step 1: disambiguate bare name (skip when --exact).
  let qualifiedStart = symbol;
  if (!opts.exact && !symbol.includes('::')) {
    const { matches, suggestions } = await disambiguateSymbol(engine, symbol, opts.sourceId);
    if (matches.length === 0) return { result: 'not_found', did_you_mean: suggestions };
    if (matches.length > 1) {
      return {
        result: 'ambiguous',
        candidates: matches.map((m) => ({ symbol_qualified: m })),
      };
    }
    qualifiedStart = matches[0]!;
  }

  // Step 2: language gate (per D18 honest scope), scoped to the symbol's
  // own definitions: unsupported only when NO defining chunk is in a
  // supported language. When an unsupported-language namesake shares the
  // qualified name, the walk keeps only edges whose origin chunk is in a
  // supported language, so the namesake's call graph does not leak in.
  const langs = await symbolLanguages(engine, qualifiedStart, opts.sourceId);
  const lang = langs.find(isSupportedLang) ?? langs[0] ?? null;
  if (lang && !isSupportedLang(lang)) {
    return { result: 'unsupported_language', supported: SUPPORTED_LANGS };
  }
  const mixedLanguages = langs.some((l) => !isSupportedLang(l));

  // Step 3: BFS walk.
  const visited = new Set<string>([qualifiedStart]);
  const depthGroups: DepthGroup[] = [];
  let cyclesDetected = false;
  let truncation: 'none' | 'max_nodes' | 'depth_cap' | 'both' = 'none';
  let totalNodes = 0;
  let freshness: 'fresh' | 'partial' = 'fresh';
  const terminalNodes: { symbol: string; sink_kind: SinkKind }[] = [];

  let frontier = [qualifiedStart];
  for (let d = 1; d <= depthCap; d++) {
    const nextFrontier: string[] = [];
    const nodesThisDepth: WalkNode[] = [];

    for (const sym of frontier) {
      let edges: CodeEdgeResult[];
      try {
        edges =
          opts.direction === 'callers'
            ? await engine.getCallersOf(sym, { sourceId: opts.sourceId, limit: maxNodes })
            : await engine.getCalleesOf(sym, { sourceId: opts.sourceId, limit: maxNodes });
      } catch {
        edges = [];
      }
      if (mixedLanguages && edges.length > 0) {
        try {
          const keep = await supportedChunkIds(engine, edges.map((e) => e.from_chunk_id));
          edges = edges.filter((e) => keep.has(e.from_chunk_id));
        } catch {
          edges = [];
        }
      }

      // freshness check: any edge whose owning chunk has edges_backfilled_at IS NULL
      // → partial. v0.34 W3b's getCachedOrCompute will gate this further.

      for (const e of edges) {
        const next =
          opts.direction === 'callers' ? e.from_symbol_qualified : e.to_symbol_qualified;
        if (!next || next === sym) continue;
        if (visited.has(next)) {
          cyclesDetected = true;
          continue;
        }
        if (totalNodes >= maxNodes) {
          truncation = truncation === 'depth_cap' ? 'both' : 'max_nodes';
          break;
        }
        visited.add(next);
        totalNodes += 1;
        const node: WalkNode = { symbol: next, chunk_id: e.from_chunk_id };
        // Tag sinks for callees direction.
        if (opts.direction === 'callees' && lang) {
          const kind = classifySink(next, lang);
          if (kind !== 'unknown') {
            node.sink_kind = kind;
            terminalNodes.push({ symbol: next, sink_kind: kind });
          }
        }
        nodesThisDepth.push(node);
        nextFrontier.push(next);
      }
      if (truncation === 'max_nodes' || truncation === 'both') break;
    }

    if (nodesThisDepth.length > 0) {
      depthGroups.push({
        depth: d,
        nodes: nodesThisDepth,
        confidence: clampConfidence(d),
      });
    }
    if (nextFrontier.length === 0) break;
    if (d === depthCap && nextFrontier.length > 0) {
      truncation = truncation === 'max_nodes' ? 'both' : 'depth_cap';
    }
    if (truncation === 'max_nodes' || truncation === 'both') break;
    frontier = nextFrontier;
  }

  const result: WalkResult = {
    result: 'ok',
    depth_groups: depthGroups,
    cycles_detected: cyclesDetected,
    truncation,
    freshness,
  };
  if (opts.direction === 'callees' && terminalNodes.length > 0) {
    (result as Extract<WalkResult, { result: 'ok' }>).terminal_nodes = terminalNodes;
  }
  return result;
}
