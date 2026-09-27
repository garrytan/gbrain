/**
 * v0.34 W0c — within-file two-pass symbol resolver.
 *
 * The edge-extractor (edge-extractor.ts) emits BARE callee tokens during
 * sync (`f`, `m`, `render`, etc.). Multi-class codebases have many same-
 * named methods; pre-v0.34 the call graph aliased every same-named symbol
 * across classes because there was no qualified-name resolution.
 *
 * This module is the second pass: for each unresolved edge in
 * code_edges_symbol whose owning chunk shares a file with one or more
 * candidate `symbol_name_qualified` matches, we either:
 *
 *   - Mark it resolved (edge_metadata.resolved_chunk_id = <id>) when
 *     exactly ONE chunk in the same page has a matching qualified name.
 *   - Mark it ambiguous (edge_metadata.ambiguous = true + candidates list)
 *     when 2+ chunks match — the caller still got information they didn't
 *     have before (we know it could be any of {X, Y, Z}, not "this is
 *     definitely `render`").
 *   - Leave it untouched if zero chunks match (call is to something
 *     defined in another file — caller's resolver expands via two-pass).
 *
 * Idempotency: every chunk we walk gets `content_chunks.edges_backfilled_at
 * = NOW()` after its edges are processed. Resume picks up rows where the
 * watermark is NULL or older than EDGE_EXTRACTOR_VERSION_TS — when the
 * extractor's shape changes, bump the constant and the next cycle re-runs.
 *
 * Batched: BATCH_SIZE chunks per transaction; one batch is the atomic unit.
 * Crashes lose at most one batch.
 *
 * Per D2 from eng review: a cycle phase (resolve_symbol_edges_incremental)
 * runs this on the autopilot's quick-cycle path so sync stays fast AND
 * agents see resolved edges within ~60s of writes.
 *
 *                       ┌─────────────────────────────┐
 *                       │ chunks where                │
 *  resolver enqueues ──►│  edges_backfilled_at IS NULL│
 *                       │  OR < EDGE_EXTRACTOR_TS     │
 *                       └─────────────────────────────┘
 *                                  │
 *                                  ▼
 *                       ┌─────────────────────────────┐
 *                       │ BATCH (200 chunks)          │
 *                       │ — for each: load edges,     │
 *                       │   resolve via same-page     │
 *                       │   symbol_name_qualified     │
 *                       │ — write edge_metadata       │
 *                       │ — set edges_backfilled_at   │
 *                       └─────────────────────────────┘
 *                                  │
 *                                  ▼
 *                            COMMIT batch
 *                                  │
 *                                  ▼
 *                          repeat or return
 */

import type { BrainEngine } from '../engine.ts';
import { currentTextProjectionFilter } from '../search/safe-chunks.ts';

/**
 * Bump this ISO timestamp whenever the extractor or resolver shape
 * changes. Rows resolved by an OLDER version are re-walked on the next
 * resolver pass.
 *
 * Format: ISO-8601 UTC. Comparable via `<` in SQL.
 *
 * 2026-05-14T00:00:00Z — v0.34 W1: receiver-type resolution emits
 * qualified names (Class::method, module::method) for the 3 MUST-resolve
 * patterns in JS/TS/TSX + Python.
 * 2026-05-14T01:00:00Z — v0.34 W2: edge-extractor now emits `imports`
 * and `references` edges alongside calls. JS/TS/TSX + Python get imports;
 * TS only gets references.
 */
export const EDGE_EXTRACTOR_VERSION_TS = '2026-05-14T01:00:00Z';

export const BATCH_SIZE = 200;

export interface ResolverStats {
  chunks_walked: number;
  edges_examined: number;
  edges_resolved: number;
  edges_ambiguous: number;
  edges_unmatched: number;
  batches: number;
  ms: number;
}

export interface ResolverOpts {
  /** Required: scope resolution to one source. v0.34 doesn't do cross-source. */
  sourceId: string;
  /** Cap on chunks walked per call. Default: BATCH_SIZE * 10 = 2000 per cycle tick. */
  maxChunks?: number;
  /** Optional progress callback for long backfills. */
  onProgress?: (stats: ResolverStats) => void;
}

interface UnresolvedEdgeRow {
  id: number;
  from_chunk_id: number;
  to_symbol_qualified: string;
  edge_type: string;
  edge_metadata: Record<string, unknown> | null;
}

interface ChunkCandidate {
  id: number;
  page_id: number;
}

/**
 * Resolve unresolved edges for chunks whose `edges_backfilled_at` is
 * stale or null. Returns stats; updates DB in BATCH_SIZE-chunk transactions.
 */
export async function resolveSymbolEdgesIncremental(
  engine: BrainEngine,
  opts: ResolverOpts,
): Promise<ResolverStats> {
  const start = Date.now();
  const maxChunks = opts.maxChunks ?? BATCH_SIZE * 10;
  const stats: ResolverStats = {
    chunks_walked: 0,
    edges_examined: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    edges_unmatched: 0,
    batches: 0,
    ms: 0,
  };

  let processed = 0;
  while (processed < maxChunks) {
    const remaining = maxChunks - processed;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    // Find chunks that need walking: edges_backfilled_at is NULL OR older
    // than the extractor version timestamp. Scoped to source.
    const walked = await engine.transaction(async tx => {
      const chunks = await tx.executeRaw<{ id: number; page_id: number; slug: string }>(
      `SELECT cc.id, cc.page_id, p.slug
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
        WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT s.archived
          AND ${currentTextProjectionFilter('p')}
          AND (cc.edges_backfilled_at IS NULL
               OR cc.edges_backfilled_at < $2::timestamptz)
        ORDER BY cc.id
        LIMIT $3`,
      [opts.sourceId, EDGE_EXTRACTOR_VERSION_TS, batchSize],
      );
      if (chunks.length === 0) return 0;
      await tx.lockPageKeys(chunks.map(chunk => ({ sourceId: opts.sourceId, slug: chunk.slug })));
      const selected = new Map(chunks.map(chunk => [chunk.id, chunk]));
      const current = await tx.executeRaw<{ id: number; page_id: number; slug: string }>(
        `SELECT cc.id, cc.page_id, p.slug FROM content_chunks cc
         JOIN pages p ON p.id=cc.page_id JOIN sources s ON s.id=p.source_id
         WHERE cc.id=ANY($1::int[]) AND p.source_id=$2 AND p.deleted_at IS NULL AND NOT s.archived
           AND ${currentTextProjectionFilter('p')}
           AND (cc.edges_backfilled_at IS NULL OR cc.edges_backfilled_at < $3::timestamptz)
         ORDER BY cc.id`, [chunks.map(chunk => chunk.id), opts.sourceId, EDGE_EXTRACTOR_VERSION_TS],
      );
      const valid = current.filter(chunk => selected.get(chunk.id)?.page_id === chunk.page_id
        && selected.get(chunk.id)?.slug === chunk.slug);
      if (valid.length > 0) await processChunkBatch(tx, opts.sourceId, valid, stats);
      return valid.length;
    });
    if (walked === 0) break;
    stats.batches += 1;
    processed += walked;

    if (opts.onProgress) {
      stats.ms = Date.now() - start;
      opts.onProgress(stats);
    }
  }

  stats.ms = Date.now() - start;
  return stats;
}

async function processChunkBatch(
  engine: BrainEngine,
  sourceId: string,
  chunks: { id: number; page_id: number }[],
  stats: ResolverStats,
): Promise<void> {
  // Load all unresolved edges for the batch in one query.
  const chunkIds = chunks.map((c) => c.id);
  const edges = await engine.executeRaw<UnresolvedEdgeRow>(
    `SELECT id, from_chunk_id, to_symbol_qualified, edge_type, edge_metadata
       FROM code_edges_symbol
      WHERE from_chunk_id = ANY($1::int[])
        AND source_id = $2`,
    [chunkIds, sourceId],
  );

  // Group edges by from_chunk_id so we know which chunks have which edges.
  const edgesByChunkId = new Map<number, UnresolvedEdgeRow[]>();
  for (const e of edges) {
    const arr = edgesByChunkId.get(e.from_chunk_id) ?? [];
    arr.push(e);
    edgesByChunkId.set(e.from_chunk_id, arr);
  }

  // Build the set of page_ids we need to look up symbol candidates in.
  const pageByChunkId = new Map(chunks.map((c) => [c.id, c.page_id]));
  const pagesToProbe = Array.from(new Set(chunks.map((c) => c.page_id)));

  // Distinct (page_id, to_symbol_qualified) lookups to do.
  const lookups = new Set<string>();
  for (const e of edges) {
    const pageId = pageByChunkId.get(e.from_chunk_id);
    if (pageId === undefined) continue;
    lookups.add(`${pageId}\0${e.to_symbol_qualified}`);
  }

  // One-shot per-page candidate map. We pre-load all qualified symbol names
  // for every page in the batch, then resolve in-memory.
  const candidatesByKey = new Map<string, ChunkCandidate[]>();
  if (pagesToProbe.length > 0) {
    const rows = await engine.executeRaw<{ id: number; page_id: number; symbol_name_qualified: string }>(
      `SELECT id, page_id, symbol_name_qualified
         FROM content_chunks
        WHERE page_id = ANY($1::int[])
          AND symbol_name_qualified IS NOT NULL`,
      [pagesToProbe],
    );
    for (const r of rows) {
      const key = `${r.page_id}\0${r.symbol_name_qualified}`;
      const list = candidatesByKey.get(key) ?? [];
      list.push({ id: r.id, page_id: r.page_id });
      candidatesByKey.set(key, list);
    }
  }

  // Resolve each edge.
  const toResolve: Array<{ edgeId: number; chunkId: number }> = [];
  const toAmbiguous: Array<{ edgeId: number; candidateIds: number[] }> = [];
  for (const e of edges) {
    stats.edges_examined += 1;
    const pageId = pageByChunkId.get(e.from_chunk_id);
    if (pageId === undefined) {
      stats.edges_unmatched += 1;
      continue;
    }
    const key = `${pageId}\0${e.to_symbol_qualified}`;
    const candidates = candidatesByKey.get(key) ?? [];
    if (candidates.length === 1) {
      toResolve.push({ edgeId: e.id, chunkId: candidates[0]!.id });
      stats.edges_resolved += 1;
    } else if (candidates.length > 1) {
      toAmbiguous.push({ edgeId: e.id, candidateIds: candidates.map((c) => c.id) });
      stats.edges_ambiguous += 1;
    } else {
      // No same-file candidate. Edge stays as-is — caller's two-pass
      // walk can still expand it via cross-file resolution later.
      stats.edges_unmatched += 1;
    }
  }

  // Persist edge metadata updates in batches.
  for (const r of toResolve) {
    await engine.executeRaw(
      `UPDATE code_edges_symbol
          SET edge_metadata = COALESCE(edge_metadata, '{}'::jsonb) || jsonb_build_object('resolved_chunk_id', $1::int)
        WHERE id = $2`,
      [r.chunkId, r.edgeId],
    );
  }
  for (const a of toAmbiguous) {
    await engine.executeRaw(
      `UPDATE code_edges_symbol
          SET edge_metadata = COALESCE(edge_metadata, '{}'::jsonb)
                           || jsonb_build_object('ambiguous', true,
                                                 'candidates', $1::text::jsonb)
        WHERE id = $2`,
      [JSON.stringify(a.candidateIds), a.edgeId],
    );
  }

  // Mark the whole batch as backfilled — regardless of whether any edges
  // resolved. A chunk with zero unresolved edges still needs the watermark
  // bumped or it'll get re-walked every cycle tick forever.
  await engine.executeRaw(
    `UPDATE content_chunks SET edges_backfilled_at = NOW() WHERE id = ANY($1::int[])`,
    [chunkIds],
  );

  stats.chunks_walked += chunks.length;
}

/**
 * Read the resolution outcome from a single edge's metadata, if any.
 * Returns null when the edge hasn't been processed by the resolver yet.
 *
 * Public helper for downstream code (two-pass.ts, code_blast op) that
 * wants to use the resolver's output without parsing edge_metadata JSON
 * directly.
 */
export type EdgeResolution =
  | { kind: 'resolved'; chunk_id: number }
  | { kind: 'ambiguous'; candidate_chunk_ids: number[] }
  | { kind: 'unresolved' };

export function readEdgeResolution(metadata: Record<string, unknown> | null | undefined): EdgeResolution {
  if (!metadata) return { kind: 'unresolved' };
  if (typeof metadata.resolved_chunk_id === 'number') {
    return { kind: 'resolved', chunk_id: metadata.resolved_chunk_id };
  }
  if (metadata.ambiguous === true && Array.isArray(metadata.candidates)) {
    const candidates = metadata.candidates.filter((c): c is number => typeof c === 'number');
    if (candidates.length > 0) {
      return { kind: 'ambiguous', candidate_chunk_ids: candidates };
    }
  }
  return { kind: 'unresolved' };
}
