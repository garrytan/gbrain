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
 *     independent of edge resolution. Their readiness is 3-state: no code
 *     chunks → `not_built`; code chunks but none carry `symbol_name` →
 *     `no_symbols` (#3640 — chunks predate symbol extraction; hint at
 *     `reindex-code`); symbol-bearing chunks exist → `ready`. They never
 *     report `indexing` (edge resolution is irrelevant to them).
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
 * Both grains share one more state (#3707): when the SCOPED probe finds no
 * code but an unscoped rerun finds code brain-wide, the status is
 * `out_of_scope` — the graph is built, the caller's resolved scope (per-call
 * source_id / source pin / remote federated_read grant) just excludes it.
 * The hint names the scope instead of misdirecting to `gbrain sync`.
 * #4352 remediation: that unscoped rerun probes code existence OUTSIDE the
 * caller's resolved scope, so it runs ONLY for trusted local callers
 * (`remote === false`, the repo trust convention — anything else is
 * untrusted, fail-closed). A scoped remote caller sees `not_built`, never
 * a brain-wide code-existence disclosure.
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

export type CodeGraphStatus = 'not_built' | 'no_symbols' | 'indexing' | 'ready' | 'out_of_scope' | 'unknown';

export interface CodeGraphReadiness {
  /** Coarse machine-readable state. */
  status: CodeGraphStatus;
  /** Convenience: `status === 'ready'`. */
  ready: boolean;
  /** Whether any code chunk exists in scope. */
  has_code: boolean;
  /** Whether unresolved/stale edge chunks remain in scope (edge kind only). */
  pending_edges: boolean;
  /**
   * #3707: set ONLY for `out_of_scope` — the resolved source scope that was
   * probed and found to hold no code (while code exists brain-wide), so
   * hints/envelopes can name the scope instead of misdirecting to `gbrain sync`.
   */
  scoped_source_id?: string;
}

/** Scope for a readiness probe. Omit `sourceId` (or set `allSources`) for brain-wide. */
export interface ReadinessScope {
  sourceId?: string;
  allSources?: boolean;
}

function effectiveSourceId(scope: ReadinessScope): string | undefined {
  return scope.allSources ? undefined : scope.sourceId;
}

/**
 * EXISTS probe: does any code chunk exist in scope? Matches the def/refs result
 * query. Exported for the graph-four federated re-route (#4011,
 * ops/context.ts `routeCodeIntelScope`) so routing and readiness share ONE
 * "has code" predicate and can never disagree.
 */
export async function codeChunksExist(engine: BrainEngine, sourceId: string | undefined): Promise<boolean> {
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

/**
 * EXISTS probe: does any SYMBOL-BEARING code chunk exist in scope (#3640)?
 * Code chunks can exist without symbol metadata (chunks written before
 * symbol-aware chunking, or a chunker fallback that skipped extraction);
 * `code-def` / `code-refs` match on `symbol_name`, so bare code-chunk
 * existence would falsely report `ready` while every lookup returns 0.
 * Rides the partial `idx_chunks_symbol_name` index.
 */
async function symbolChunksExist(engine: BrainEngine, sourceId: string | undefined): Promise<boolean> {
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
        WHERE p.page_kind = 'code'
          AND cc.symbol_name IS NOT NULL
          ${scopeClause}
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
  opts: {
    kind: 'symbol' | 'edge';
    count: number;
    /**
     * #4352 remediation: trust gate for the #3707 out_of_scope brain-wide
     * rerun. Pass `ctx.remote` (ops) or `false` (local CLI commands).
     * Omitted/unset is treated as untrusted — the rerun is skipped and a
     * scoped miss stays `not_built` (fail-closed, per the repo trust
     * convention: only strict `false` is trusted).
     */
    remote?: boolean;
  } & ReadinessScope,
): Promise<CodeGraphReadiness> {
  if (opts.count > 0) {
    return { status: 'ready', ready: true, has_code: true, pending_edges: false };
  }
  const sourceId = effectiveSourceId(opts);
  try {
    const hasCode = await codeChunksExist(engine, sourceId);
    if (!hasCode) {
      // #3707: "no code in scope" conflated two very different situations —
      // the graph was never built, vs. the graph IS built but the caller's
      // resolved scope (per-call source_id, .gbrain-source pin, or a remote
      // client's federated_read grant) excludes every code-bearing source.
      // The old `not_built` hint then misdirected operators to `gbrain sync`
      // on a fully-indexed brain. When a scope was applied, rerun the probe
      // brain-wide: code elsewhere → out_of_scope, a scope/grant problem,
      // not an indexing one. #4352: trusted local callers only — the rerun
      // reads outside the resolved scope, so a remote caller never learns
      // whether code exists beyond its grant.
      if (sourceId !== undefined && opts.remote === false && (await codeChunksExist(engine, undefined))) {
        return {
          status: 'out_of_scope', ready: false, has_code: false,
          pending_edges: false, scoped_source_id: sourceId,
        };
      }
      return { status: 'not_built', ready: false, has_code: false, pending_edges: false };
    }
    if (opts.kind === 'symbol') {
      // Symbol metadata is set at chunk time — but only when the chunker
      // actually extracted symbols. Probe for symbol-bearing chunks (#3640):
      // code chunks without any symbol_name mean every def/refs lookup will
      // return 0 no matter the symbol, which is "not built", not "no match".
      const hasSymbols = await symbolChunksExist(engine, sourceId);
      return hasSymbols
        ? { status: 'ready', ready: true, has_code: true, pending_edges: false }
        : { status: 'no_symbols', ready: false, has_code: true, pending_edges: false };
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
    case 'out_of_scope':
      return `Code IS indexed in this brain, but none of it is inside your resolved source scope${
        r.scoped_source_id ? ` (source '${r.scoped_source_id}')` : ''
      }. This is a scope/grant problem, not an indexing one — do NOT re-run \`gbrain sync\`. ` +
        `Pass a source_id that holds code (or --all-sources locally); remote clients: check the client's federated_read grant.`;
    case 'no_symbols':
      return 'Code is indexed but carries no symbol metadata (chunks predate symbol-aware chunking). Run `gbrain reindex-code` to rebuild the symbol graph.';
    case 'indexing':
      return 'Symbol graph still building (edges pending resolution). Re-run after the next `gbrain dream` cycle / autopilot tick.';
    case 'unknown':
      return 'Readiness check unavailable (DB error). Treat the empty result as best-effort.';
    case 'ready':
      return null;
  }
}
