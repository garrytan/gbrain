// v0.38 alias graph closure (E8 refinement of D12).
//
// Pre-v0.38: search queries used a closed PageType union; types under the
// same primitive surfaced together implicitly. That model leaked
// adversary-profile rows into `whoknows expert` because adversary-profile
// shared the entity primitive with person.
//
// v0.38 E8: closure is driven by an EXPLICIT alias graph. Each pack type
// declares `aliases: [other-type, ...]`. The closure of type T is the
// BFS traversal starting at T, following both A→B edges (per A's
// declaration) and B→A edges (per B's declaration if present). This is
// "symmetric per declaration" — when A declares `aliases: [B]`, both
// directions land in the closure regardless of what B declares.
//
// Concrete on Garry's brain:
//   - `researcher` declares `aliases: [person]` → closure(researcher) =
//     {researcher, person} AND closure(person) = {person, researcher}.
//   - `adversary-profile` declares NO aliases → closure(adversary-profile)
//     = {adversary-profile}, closure(person) doesn't include it.
//
// Transitive cap = 4. A→B→C→D→E hits the limit; the algorithm refuses to
// expand past depth 4 and emits a stderr warn naming the cap. Pathological
// chains (cycles) are rejected at pack LOAD time, not here. Cycles inside
// the depth limit can't form because BFS deduplicates visits.

import type { SchemaPackManifest } from './manifest-v1.ts';

export const ALIAS_CLOSURE_MAX_DEPTH = 4 as const;

export class AliasCycleError extends Error {
  readonly path: string[];
  constructor(path: string[]) {
    super(`alias cycle detected: ${path.join(' → ')}`);
    this.name = 'AliasCycleError';
    this.path = path;
  }
}

export class AliasDepthExceededError extends Error {
  readonly type: string;
  readonly depth: number;
  constructor(type: string, depth: number) {
    super(`alias closure for "${type}" exceeded max depth ${ALIAS_CLOSURE_MAX_DEPTH} at depth ${depth}`);
    this.name = 'AliasDepthExceededError';
    this.type = type;
    this.depth = depth;
  }
}

/**
 * Resolved alias graph keyed by type name. Built once at pack load via
 * `buildAliasGraph`; consumed by `expandClosure` for per-query expansion.
 * Each entry is the set of types that share a symmetric alias edge with
 * the keyed type (one hop). Transitive closure is computed on-demand in
 * `expandClosure`.
 */
export type AliasGraph = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Build the symmetric per-declaration alias graph from the manifest.
 * Throws AliasCycleError on cycles (depth-first detection). Cycles can
 * form when extends/borrow_from reach back to a type that already
 * declares an alias upstream — that's load-time-only territory.
 */
export function buildAliasGraph(manifest: SchemaPackManifest): AliasGraph {
  const adj = new Map<string, Set<string>>();
  const ensure = (t: string): Set<string> => {
    let s = adj.get(t);
    if (!s) { s = new Set(); adj.set(t, s); }
    return s;
  };
  for (const pt of manifest.page_types) {
    ensure(pt.name);
    for (const alias of pt.aliases) {
      // Symmetric per declaration: A declares [B] → both A→B and B→A.
      ensure(pt.name).add(alias);
      ensure(alias).add(pt.name);
    }
  }
  // Cycle detection via DFS. A cycle here means a type's transitive
  // closure includes itself via a non-immediate path. We reject at load
  // to prevent ambiguous closure ordering.
  detectCycles(adj);
  return adj;
}

function detectCycles(adj: Map<string, Set<string>>): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adj.keys()) color.set(node, WHITE);

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    const neighbors = adj.get(node) ?? new Set<string>();
    for (const next of neighbors) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY && path.length >= 2 && path[path.length - 2] !== next) {
        // Found a back-edge that is NOT the immediate parent (which would
        // be the symmetric mirror, not a cycle). Real cycle.
        const cycleStart = path.indexOf(next);
        throw new AliasCycleError(path.slice(cycleStart).concat([next]));
      } else if (c === WHITE) {
        dfs(next, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node, []);
    }
  }
}

/**
 * BFS closure of a query type over the alias graph. Caps at
 * ALIAS_CLOSURE_MAX_DEPTH = 4. Returns the SET of types that should be
 * included in a query for the input type (always includes the input).
 *
 * Codex F4 (deterministic order): the returned array is sorted lex-stable
 * so test snapshots + cache keys are reproducible.
 */
export function expandClosure(
  queryType: string,
  graph: AliasGraph,
  opts: { onDepthExceeded?: (type: string) => void } = {},
): string[] {
  const visited = new Set<string>([queryType]);
  let frontier = [queryType];
  let depth = 0;
  while (frontier.length > 0 && depth < ALIAS_CLOSURE_MAX_DEPTH) {
    const next: string[] = [];
    for (const t of frontier) {
      const neighbors = graph.get(t);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
    depth++;
  }
  // Check whether we ran out of depth before exhausting the graph.
  if (depth === ALIAS_CLOSURE_MAX_DEPTH && frontier.length > 0) {
    const stillFrontier = frontier.flatMap(t => Array.from(graph.get(t) ?? []))
      .filter(n => !visited.has(n));
    if (stillFrontier.length > 0) {
      opts.onDepthExceeded?.(queryType);
    }
  }
  return Array.from(visited).sort();
}

/**
 * Compute the closure hash for a pack — the canonical SHA-256 prefix of
 * the resolved (closure_for_every_type) map, used as the eval_candidates
 * inline-snapshot key (E11). Deterministic: sorts both keys and values.
 */
export async function computeAliasClosureHash(
  manifest: SchemaPackManifest,
): Promise<string> {
  const graph = buildAliasGraph(manifest);
  const allTypes = manifest.page_types.map(pt => pt.name).sort();
  const resolved: Record<string, string[]> = {};
  for (const t of allTypes) {
    resolved[t] = expandClosure(t, graph);
  }
  const canonical = JSON.stringify(resolved);
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
