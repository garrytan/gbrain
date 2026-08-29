/**
 * Code-intelligence operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): the v0.34 Cathedral III MCP wrappers (code_callers /
 * code_callees / code_def / code_refs), the W3 recursive code_blast +
 * code_flow, and the W3b code_traversal_cache_clear admin op. Op consts stay
 * module-private; `codeIntelOperations` below lists them in EXACTLY the
 * order they appear in the canonical `operations` array in ../operations.ts.
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { routeCodeIntelScope } from './context.ts';
import {
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
} from '../operations-descriptions.ts';

// ──────────────────────────────────────────────────────────────────────────────
// v0.34 Cathedral III — code-intelligence ops (MCP-exposed).
//
// Pre-v0.34 code-callers / code-callees / code-def / code-refs lived only in
// the CLI_ONLY set at cli.ts:30 — agents calling gbrain via MCP couldn't reach
// them and fell through to text search. These wrappers expose the existing
// engine + library functions to the MCP surface with resolver-grade
// descriptions (operations-descriptions.ts) so agents route to them
// automatically during plan-mode.
//
// All four are scope:'read'. Source-scoped via ctx.sourceId when set.
// Both `source_id` and `all_sources` are params so per-call overrides work.
// ──────────────────────────────────────────────────────────────────────────────

const code_callers: Operation = {
  name: 'code_callers',
  description: CODE_CALLERS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callers of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources (equivalent to source_id=__all__): every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver + federated code-source re-route (see
    // routeCodeIntelScope): remote callers can't span sources outside their
    // grant, and `__all__` collapses to their grant (not the whole brain).
    const { allSources, sourceId } = await routeCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCallersOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    // #4352: thread trust — the out_of_scope brain-wide rerun is local-only.
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources, remote: ctx.remote,
    });
    return {
      symbol, count: edges.length, status: readiness.status, ready: readiness.ready,
      // #3707: out_of_scope names the empty scope so a federated client can see
      // "grant problem", not "graph never built".
      ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
      callers: edges,
    };
  },
  cliHints: { name: 'code_callers', hidden: true },
};

const code_callees: Operation = {
  name: 'code_callees',
  description: CODE_CALLEES_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callees of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources: every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver + federated re-route (see code_callers).
    const { allSources, sourceId } = await routeCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCalleesOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    // #4352: thread trust — see code_callers.
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources, remote: ctx.remote,
    });
    return {
      symbol, count: edges.length, status: readiness.status, ready: readiness.ready,
      // #3707: see code_callers.
      ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
      callees: edges,
    };
  },
  cliHints: { name: 'code_callees', hidden: true },
};

const code_def: Operation = {
  name: 'code_def',
  description: CODE_DEF_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol name (bare token; e.g., parseMarkdown, BrainEngine).' },
    limit: { type: 'number', description: 'Max definition sites returned. Default 20.' },
    lang: { type: 'string', description: "Filter by content_chunks.language (e.g. 'typescript', 'python')." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeDef } = await import('../../commands/code-def.ts');
    const defs = await findCodeDef(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 20,
      language: (p.lang as string) || undefined,
    });
    // code_def is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: defs.length });
    return { symbol: p.symbol as string, count: defs.length, status: readiness.status, ready: readiness.ready, defs };
  },
  cliHints: { name: 'code_def', hidden: true },
};

const code_refs: Operation = {
  name: 'code_refs',
  description: CODE_REFS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find references to.' },
    limit: { type: 'number', description: 'Max references returned. Default 50.' },
    lang: { type: 'string', description: "Filter by content_chunks.language." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeRefs } = await import('../../commands/code-refs.ts');
    const refs = await findCodeRefs(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 50,
      language: (p.lang as string) || undefined,
    });
    // code_refs is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('../code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: refs.length });
    return { symbol: p.symbol as string, count: refs.length, status: readiness.status, ready: readiness.ready, refs };
  },
  cliHints: { name: 'code_refs', hidden: true },
};

// --- v0.34 W3: recursive code_blast + code_flow ---

const code_blast: Operation = {
  name: 'code_blast',
  description: 'BEFORE editing any function, run code_blast with the symbol name to surface every transitive caller grouped by depth (direct → 2-hop → 3-hop). Use this during plan-mode to size the change. Returns up to 200 nodes. Returns: {result, depth_groups?, truncation?, cycles_detected?, did_you_mean?, candidates?}. Example ok: {result:"ok", depth_groups:[{depth:1, nodes:[{symbol,chunk_id}], confidence:0.77}], truncation:"none"}.',
  params: {
    symbol: { type: 'string', required: true, description: 'Bare or qualified symbol name (e.g. "performSync" or "src/foo::performSync")' },
    depth: { type: 'number', description: 'Hop cap (default 5, max 8)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation; treat symbol as exact qualified name' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('../code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('../code-intel/traversal-cache.ts');
    const symbol = p.symbol as string;
    const depth = Math.min((p.depth as number) ?? 5, 8);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver: a remote federated client can't traverse a
    // source outside its grant (pre-fix this scoped by bare ctx.sourceId only).
    // Falls back to ctx.sourceId (a required string) for the trusted-local case,
    // exactly preserving pre-fix local behavior.
    const { sourceId: scopedSourceId } = await routeCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol, depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callers',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_blast', hidden: true },
};

const code_flow: Operation = {
  name: 'code_flow',
  description: 'When tracing how a request flows through the codebase from entry point to side effect (DB write, HTTP call, file I/O), run code_flow from the entry point. Returns ordered execution chain with terminal-node tags. Returns: same envelope as code_blast plus terminal_nodes: [{symbol, sink_kind}] where sink_kind ∈ "db_call"|"http_call"|"file_io"|"process_exec"|"unknown".',
  params: {
    entry_point: { type: 'string', required: true, description: 'Entry-point symbol name (bare or qualified)' },
    depth: { type: 'number', description: 'Hop cap (default 8, max 12)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('../code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('../code-intel/traversal-cache.ts');
    const symbol = p.entry_point as string;
    const depth = Math.min((p.depth as number) ?? 8, 12);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver (see code_blast).
    const { sourceId: scopedSourceId } = await routeCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol + ':flow', depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callees',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_flow', hidden: true },
};

// --- v0.34 W3b: code_traversal_cache admin op ---

const code_traversal_cache_clear: Operation = {
  name: 'code_traversal_cache_clear',
  description: 'Clear cached code_blast / code_flow traversal results. Source-scoped by default; pass all_sources=true to wipe everything (D8 destructive-guard).',
  params: {
    source_id: { type: 'string', description: 'Source to clear. Required unless all_sources=true.' },
    all_sources: { type: 'boolean', description: 'Wipe cache across every source. Explicit opt-out of source-scoping.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    // INTENTIONAL exemption from resolveRequestedScope: this is a localOnly
    // admin/destructive op with its own D8 all_sources guard. The read-side
    // trust+grant resolver does not apply here (no remote caller reaches it).
    const { clearTraversalCache } = await import('../code-intel/traversal-cache.ts');
    const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId;
    const allSources = (p.all_sources as boolean) ?? false;
    if (ctx.dryRun) {
      return { dry_run: true, action: 'code_traversal_cache_clear', source_id: sourceId, all_sources: allSources };
    }
    const deleted = await clearTraversalCache(ctx.engine, {
      sourceId: allSources ? undefined : sourceId,
      allSources,
    });
    return { deleted, source_id: allSources ? null : sourceId, all_sources: allSources };
  },
  cliHints: { name: 'code_traversal_cache_clear', hidden: true },
};

export const codeIntelOperations: Operation[] = [
  code_callers, code_callees, code_def, code_refs,
  code_blast, code_flow,
  code_traversal_cache_clear,
];
