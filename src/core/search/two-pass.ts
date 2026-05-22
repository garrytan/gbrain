/**
 * v0.20.0 Cathedral II Layer 7 (A2) — two-pass structural retrieval.
 *
 * Given an anchor set of chunks (either from a keyword/vector anchor
 * search OR from a --near-symbol qualified-name lookup), walk
 * code_edges_chunk + code_edges_symbol up to walkDepth hops and collect
 * structural neighbors. Score each neighbor as anchor_score * 1/(1+hop).
 *
 * Default OFF. Activation:
 *   - opts.walkDepth > 0 → walk N hops from the anchors.
 *   - opts.nearSymbol set → anchor set includes chunks whose
 *     symbol_name_qualified matches, in addition to the keyword/vector
 *     anchors.
 *
 * Caps (per codex F5 resolution):
 *   - depth capped at 2 (neighborhood blast radius)
 *   - neighbor cap 50 per hop (high-fan-out protection)
 *
 * Returns a flat merged list: anchors (score preserved) + neighbors
 * (scored by 1/(1+hop) * anchor_score). Caller feeds this back into
 * the RRF-deduped pipeline.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';

const MAX_WALK_DEPTH = 2;
const NEIGHBOR_CAP_PER_HOP = 50;

export interface TwoPassOpts {
  /** 1 or 2 — capped at 2. 0 or undefined → no-op (returns anchors as-is). */
  walkDepth?: number;
  /** When set, find chunks whose symbol_name_qualified matches; add to anchor set. */
  nearSymbol?: string;
  /** Filter expansion to one source. When unset, crosses sources. */
  sourceId?: string;
}

interface ChunkWithScore {
  chunk_id: number;
  score: number;
  hop: number;
  source: 'anchor' | 'neighbor';
}

/**
 * Expand an anchor set through structural edges. Returns every chunk
 * ID that lands in the walk window, keyed with a score that combines
 * the original anchor score with hop distance decay.
 */
export async function expandAnchors(
  engine: BrainEngine,
  anchors: SearchResult[],
  opts: TwoPassOpts = {},
): Promise<ChunkWithScore[]> {
  const depth = Math.min(Math.max(opts.walkDepth ?? 0, 0), MAX_WALK_DEPTH);
  if (depth === 0 && !opts.nearSymbol) {
    return anchors.map(a => ({
      chunk_id: a.chunk_id,
      score: a.score,
      hop: 0,
      source: 'anchor' as const,
    }));
  }

  const seen = new Map<number, ChunkWithScore>();
  for (const a of anchors) {
    seen.set(a.chunk_id, {
      chunk_id: a.chunk_id,
      score: a.score,
      hop: 0,
      source: 'anchor',
    });
  }

  // --near-symbol: add chunks whose symbol_name_qualified matches as
  // additional anchors. Best-effort — if none found, fall through.
  if (opts.nearSymbol) {
    try {
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM content_chunks WHERE symbol_name_qualified = $1 LIMIT 50`,
        [opts.nearSymbol],
      );
      const baseScore = anchors.length > 0 ? anchors[0]!.score : 1.0;
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, { chunk_id: r.id, score: baseScore, hop: 0, source: 'anchor' });
        }
      }
    } catch {
      // Ignore — execution continues without the near-symbol anchors.
    }
  }

  // Walk N hops. Frontier advances each iteration; each expansion adds
  // unseen chunks with decayed scores.
  let frontier = Array.from(seen.values()).filter(c => c.hop === 0).map(c => c.chunk_id);
  for (let hop = 1; hop <= depth; hop++) {
    if (frontier.length === 0) break;
    const nextFrontier = new Set<number>();
    const decay = 1 / (1 + hop);

    for (const chunkId of frontier) {
      const current = seen.get(chunkId);
      if (!current) continue;

      let edges: import('../types.ts').CodeEdgeResult[] = [];
      try {
        edges = await engine.getEdgesByChunk(chunkId, {
          direction: 'both',
          limit: NEIGHBOR_CAP_PER_HOP,
        });
      } catch {
        continue;
      }

      // Two kinds of neighbors to visit:
      //   1. Resolved edges with to_chunk_id: direct chunk follow.
      //   2. Unresolved edges (code_edges_symbol): resolve by
      //      symbol_name_qualified = to_symbol_qualified, then follow.
      const directChunkIds: number[] = [];
      const unresolvedTargets: string[] = [];
      for (const e of edges) {
        if (e.to_chunk_id != null) directChunkIds.push(e.to_chunk_id);
        else if (e.to_symbol_qualified) unresolvedTargets.push(e.to_symbol_qualified);
      }
      // Resolve unresolved edges by looking up chunks whose
      // symbol_name_qualified matches. One batch query per frontier node.
      if (unresolvedTargets.length > 0) {
        try {
          const resolved = await engine.executeRaw<{ id: number }>(
            `SELECT id FROM content_chunks WHERE symbol_name_qualified = ANY($1::text[]) LIMIT ${NEIGHBOR_CAP_PER_HOP}`,
            [unresolvedTargets],
          );
          for (const r of resolved) directChunkIds.push(r.id);
        } catch {
          // best-effort
        }
      }

      for (const tid of directChunkIds) {
        if (seen.has(tid)) continue;
        const nbScore = current.score * decay;
        seen.set(tid, { chunk_id: tid, score: nbScore, hop, source: 'neighbor' });
        nextFrontier.add(tid);
      }
    }

    frontier = Array.from(nextFrontier);
  }

  return Array.from(seen.values());
}

/**
 * Fetch SearchResult rows for a set of chunk IDs. Used to hydrate
 * two-pass neighbor IDs into full result rows the hybrid pipeline
 * expects. Missing chunk IDs (chunk deleted between the edge walk
 * and the fetch) are silently skipped.
 */
export async function hydrateChunks(
  engine: BrainEngine,
  chunkIds: number[],
): Promise<SearchResult[]> {
  if (chunkIds.length === 0) return [];
  const rows = await engine.executeRaw<{
    slug: string; page_id: number; title: string; type: string; source_id: string;
    chunk_id: number; chunk_index: number; chunk_text: string; chunk_source: string;
  }>(
    `SELECT p.slug, p.id as page_id, p.title, p.type, p.source_id,
            cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE cc.id = ANY($1::int[])`,
    [chunkIds],
  );
  return rows.map((r) => ({
    slug: r.slug,
    page_id: r.page_id,
    title: r.title,
    type: r.type as import('../types.ts').PageType,
    chunk_text: r.chunk_text,
    chunk_source: r.chunk_source as 'compiled_truth' | 'timeline',
    chunk_id: r.chunk_id,
    chunk_index: r.chunk_index,
    score: 0, // two-pass caller assigns scores.
    stale: false,
    source_id: r.source_id,
  } as SearchResult));
}
