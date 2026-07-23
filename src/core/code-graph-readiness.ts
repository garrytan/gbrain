/**
 * Code-graph readiness signal (issue #1780 Gap 1).
 *
 * `code-def` / `code-refs` / `code-callers` / `code-callees` historically
 * returned `count: 0` in three indistinguishable situations:
 *   1. the symbol graph isn't built yet for the scope (code never synced /
 *      chunked, or edges not yet resolved),
 *   2. the source was never synced,
 *   3. the graph IS built and the symbol genuinely has no match.
 *
 * An agent that gets `count: 0` can't tell "wait and retry" from "trust this
 * empty result." This module adds a typed readiness signal so the envelope
 * carries `status` + `ready`, letting the caller distinguish those cases.
 *
 * Two grains, because the four commands read different data:
 *   - `code-def` / `code-refs` read `content_chunks.symbol_name` /
 *     `chunk_text`, which are populated at CHUNK time (during sync/import),
 *     independent of edge resolution. Their readiness is 2-state: code chunks
 *     exist → `ready`, else `not_built`. They never report `indexing` (edge
 *     resolution is irrelevant to them).
 *   - `code-callers` / `code-callees` read the call graph (`code_edges_*`).
 *     Their readiness is 3-state: no code chunks → `not_built`; code chunks
 *     but edges not yet resolved → `indexing`; all resolved → `ready`.
 *
 * The "pending edges" predicate MUST mirror the resolver
 * (`symbol-resolver.ts:resolveSymbolEdgesIncremental`): a chunk is pending
 * when `edges_backfilled_at IS NULL OR edges_backfilled_at <
 * EDGE_EXTRACTOR_VERSION_TS`. Counting only `IS NULL` would falsely report
 * `ready` after a resolver-version bump (the graph is stale, not done).
 *
 * Cost: callers run this ONLY when `count === 0` (see `resolveCodeReadiness`);
 * a non-empty result short-circuits to `ready: true` with no query. Probes use
 * `EXISTS` (short-circuits on first row) rather than `COUNT(*)` because the
 * bootstrap schema has no `page_kind` index; the pending probe rides the
 * partial `idx_content_chunks_edges_backfill` index. Fail-open: any DB error
 * yields `status: 'unknown'` so a supplementary signal never breaks the command.
 *
 * Scope must match the result query exactly: `code-def` / `code-refs` do NOT
 * filter `deleted_at`, so neither do these probes (else readiness could say
 * `not_built` while results came from soft-deleted code pages).
 */

import type { BrainEngine } from './engine.ts';
import { EDGE_EXTRACTOR_VERSION_TS } from './chunkers/symbol-resolver.ts';

export type CodeGraphStatus = 'not_built' | 'indexing' | 'ready' | 'unknown';

export interface CodeGraphReadiness {
  /** Coarse machine-readable state. */
  status: CodeGraphStatus;
  /** Convenience: `status === 'ready'`. */
  ready: boolean;
  /** Whether any code chunk exists in scope. */
  has_code: boolean;
  /** Whether unresolved/stale edge chunks remain in scope (edge kind only). */
  pending_edges: boolean;
}

/** Scope for a readiness probe. Omit `sourceId` (or set `allSources`) for brain-wide. */
export interface ReadinessScope {
  sourceId?: string;
  allSources?: boolean;
}

function effectiveSourceId(scope: ReadinessScope): string | undefined {
  return scope.allSources ? undefined : scope.sourceId;
}

/** EXISTS probe: does any code chunk exist in scope? Matches the def/refs result query. */
async function codeChunksExist(engine: BrainEngine, sourceId: string | undefined): Promise<boolean> {
  const params: unknown[] = [];
  let scopeClause = '';
  if (sourceId) {
    params.push(sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ e: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.page_kind = 'code' ${scopeClause}
     ) AS e`,
    params,
  );
  return Boolean(rows[0]?.e);
}

/** EXISTS probe: does any code chunk have unresolved/stale edges (resolver predicate)? */
async function pendingEdgeChunksExist(engine: BrainEngine, sourceId: string | undefined): Promise<boolean> {
  const params: unknown[] = [EDGE_EXTRACTOR_VERSION_TS];
  let scopeClause = '';
  if (sourceId) {
    params.push(sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ e: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.page_kind = 'code'
          AND (cc.edges_backfilled_at IS NULL
               OR cc.edges_backfilled_at < $1::timestamptz)
          ${scopeClause}
     ) AS e`,
    params,
  );
  return Boolean(rows[0]?.e);
}

/**
 * Resolve the readiness signal for a code-* command.
 *
 * `kind: 'symbol'` for code-def/code-refs (2-state); `kind: 'edge'` for
 * code-callers/code-callees (3-state). When `count > 0` the result is
 * trivially `ready` and no query runs. Fail-open: any DB error → `unknown`.
 */
export async function resolveCodeReadiness(
  engine: BrainEngine,
  opts: { kind: 'symbol' | 'edge'; count: number } & ReadinessScope,
): Promise<CodeGraphReadiness> {
  if (opts.count > 0) {
    return { status: 'ready', ready: true, has_code: true, pending_edges: false };
  }
  const sourceId = effectiveSourceId(opts);
  try {
    const hasCode = await codeChunksExist(engine, sourceId);
    if (!hasCode) {
      return { status: 'not_built', ready: false, has_code: false, pending_edges: false };
    }
    if (opts.kind === 'symbol') {
      // Symbol metadata is set at chunk time; code chunks exist ⇒ genuinely none.
      return { status: 'ready', ready: true, has_code: true, pending_edges: false };
    }
    const pending = await pendingEdgeChunksExist(engine, sourceId);
    return pending
      ? { status: 'indexing', ready: false, has_code: true, pending_edges: true }
      : { status: 'ready', ready: true, has_code: true, pending_edges: false };
  } catch {
    // Supplementary signal: never fail the command on a readiness DB error.
    return { status: 'unknown', ready: false, has_code: false, pending_edges: false };
  }
}

/** Human-facing one-liner for non-TTY-less output, or null when ready. */
export function readinessHint(r: CodeGraphReadiness): string | null {
  switch (r.status) {
    case 'not_built':
      return 'Symbol graph not built (no code indexed in scope). Run `gbrain sync` to index code.';
    case 'indexing':
      return 'Symbol graph still building (edges pending resolution). Re-run after the next `gbrain dream` cycle / autopilot tick.';
    case 'unknown':
      return 'Readiness check unavailable (DB error). Treat the empty result as best-effort.';
    case 'ready':
      return null;
  }
}
