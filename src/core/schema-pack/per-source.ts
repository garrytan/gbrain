// v0.38 per-source closure CTE builder (D13).
//
// When an OAuth client federates reads across sources [A, B, C], each
// source carries its own active pack. A single global closure WHERE
// clause would either miss rows (when the active pack doesn't know
// about a source's types) or surface rows the source's own pack would
// have excluded.
//
// Solution: build a SQL CTE that maps (source_id, type) pairs from each
// source's pack closure, then JOIN against pages. Each row is filtered
// by its own source's pack rules.
//
// Cache invalidation: the resulting query touches `query_cache.knobs_hash`,
// which v0.38 bumps to v=4 to fold per-source pack identity + closure_hash
// into the cache key (codex F11). Pack change in one source invalidates
// cache rows touching that source but not others.

import type { SchemaPackManifest } from './manifest-v1.ts';
import { buildAliasGraph, expandClosure } from './closure.ts';

/**
 * Per-source pack binding. Built by the resolver before SQL generation;
 * passed into SQL builder as the input shape.
 */
export interface SourceClosureBinding {
  /** Source ID this binding applies to. */
  source_id: string;
  /** Closure-expanded type set for the query type, scoped to this source's pack. */
  types: string[];
}

/**
 * Build per-source bindings from a query type + a map of source_id →
 * active pack. The resolver populates the input map (one pack per
 * source in the OAuth client's federated_read scope).
 */
export function buildPerSourceBindings(
  queryType: string,
  sourcePacks: ReadonlyMap<string, SchemaPackManifest>,
): SourceClosureBinding[] {
  const bindings: SourceClosureBinding[] = [];
  for (const [source_id, manifest] of sourcePacks) {
    const graph = buildAliasGraph(manifest);
    const types = expandClosure(queryType, graph);
    bindings.push({ source_id, types });
  }
  // Deterministic order — codex F4: cache key + test snapshots reproducible.
  return bindings.sort((a, b) => a.source_id.localeCompare(b.source_id));
}

/**
 * Build the SQL CTE for per-source closure filtering. Renders something
 * like:
 *
 *   WITH source_closure (source_id, type) AS (
 *     SELECT 'A', unnest(ARRAY['person','researcher']::text[])
 *     UNION ALL
 *     SELECT 'B', unnest(ARRAY['family-member','child']::text[])
 *     UNION ALL
 *     SELECT 'C', unnest(ARRAY['person']::text[])
 *   )
 *
 * Caller uses it as `WITH source_closure AS (...) SELECT ... FROM pages
 * p JOIN source_closure c ON c.source_id = p.source_id AND c.type = p.type`.
 *
 * Returns the CTE body string (without the `WITH ... AS (`/`)` wrapping)
 * plus the parameter list to bind. Callers wrap into their full query.
 *
 * Returns null when bindings is empty (caller falls back to unfiltered
 * query or hardcoded fallback).
 */
export function buildSourceClosureCte(bindings: SourceClosureBinding[]): {
  cte: string;
  params: string[];
} | null {
  if (bindings.length === 0) return null;
  // Defense-in-depth: sort by source_id even if caller already sorted via
  // buildPerSourceBindings. The CTE shape is part of the query cache key
  // (knobs_hash v=4); deterministic ordering keeps the hash stable.
  const sorted = [...bindings].sort((a, b) => a.source_id.localeCompare(b.source_id));
  const params: string[] = [];
  const branches: string[] = [];
  for (const b of sorted) {
    if (b.types.length === 0) continue;
    const sourceParamIdx = params.length + 1;
    params.push(b.source_id);
    // Quote each type into a literal array — safer than parameter binding
    // for SELECT-UNION because the array literal lives inside the SELECT.
    // Each type is escaped via standard PostgreSQL single-quote doubling.
    const typesLiteral = b.types.map(escapeSqlLiteral).join(',');
    branches.push(`SELECT $${sourceParamIdx}::text AS source_id, unnest(ARRAY[${typesLiteral}]::text[]) AS type`);
  }
  if (branches.length === 0) return null;
  return {
    cte: branches.join('\n  UNION ALL\n  '),
    params,
  };
}

function escapeSqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
