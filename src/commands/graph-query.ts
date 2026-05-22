/**
 * gbrain graph-query — relationship traversal with type and direction filters.
 *
 * Wraps engine.traversePaths(). Returns an indented tree of edges. Maps to the
 * `traverse_graph` MCP operation when called with link_type or direction params
 * (otherwise traverse_graph still returns the legacy GraphNode[] shape).
 *
 * Usage:
 *   gbrain graph-query <slug> [--type T] [--depth N] [--direction in|out|both]
 *
 * Examples:
 *   gbrain graph-query people/alice --type attended --depth 2
 *   gbrain graph-query companies/acme --type works_at --direction in
 *   gbrain graph-query people/bob --depth 1
 */

import type { BrainEngine } from '../core/engine.ts';
import type { GraphPath } from '../core/types.ts';

interface Args {
  slug?: string;
  linkType?: string;
  depth: number;
  direction: 'in' | 'out' | 'both';
  showHelp: boolean;
}

function parseArgs(args: string[]): Args {
  const out: Args = { depth: 5, direction: 'out', showHelp: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type' && i + 1 < args.length) out.linkType = args[++i];
    else if (a === '--depth' && i + 1 < args.length) out.depth = Number(args[++i]);
    else if (a === '--direction' && i + 1 < args.length) {
      const d = args[++i];
      if (d === 'in' || d === 'out' || d === 'both') out.direction = d;
    }
    else if (a === '--help' || a === '-h') out.showHelp = true;
    else if (!a.startsWith('-') && !out.slug) out.slug = a;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: gbrain graph-query <slug> [options]

Traverse the link graph from a page. Returns an indented tree of edges.
Per-edge type filter: traversal only follows matching links.

Options:
  --type <link_type>   Filter to one link type (attended, works_at, invested_in,
                       founded, advises, mentions, source).
  --depth <N>          Max traversal depth (default 5).
  --direction <dir>    'out' (default), 'in', or 'both'.
  -h, --help           Show this message.

Examples:
  gbrain graph-query people/alice --type attended --depth 2
    -> who attended meetings with Alice (multi-hop)
  gbrain graph-query companies/acme --type works_at --direction in
    -> who works at Acme
  gbrain graph-query people/bob --depth 1
    -> Bob's direct connections
`);
}

export async function runGraphQuery(engine: BrainEngine, argv: string[]) {
  const args = parseArgs(argv);
  if (args.showHelp || !args.slug) {
    printHelp();
    if (!args.slug) process.exit(1);
    return;
  }

  const paths = await engine.traversePaths(args.slug, {
    depth: args.depth,
    linkType: args.linkType,
    direction: args.direction,
  });

  if (paths.length === 0) {
    console.log(`No edges found from ${args.slug}${args.linkType ? ` (--type ${args.linkType})` : ''}.`);
    return;
  }

  console.log(`[depth 0] ${args.slug}`);
  printTree(args.slug, paths, args.direction);
}

/** Render the GraphPath[] as an indented tree rooted at the given slug. */
function printTree(rootSlug: string, paths: GraphPath[], direction: 'in' | 'out' | 'both') {
  // Build adjacency: for direction='out' the root is a from_slug; for 'in' the
  // root is a to_slug; for 'both' the root could be either.
  // Group by parent (from_slug for 'out', to_slug for 'in').
  const byParent = new Map<string, GraphPath[]>();
  for (const p of paths) {
    const parent = direction === 'in' ? p.to_slug : p.from_slug;
    const list = byParent.get(parent) ?? [];
    list.push(p);
    byParent.set(parent, list);
  }

  function walk(parent: string, indent: number, seen: Set<string>) {
    if (seen.has(parent)) return;
    seen.add(parent);
    const children = byParent.get(parent) ?? [];
    children.sort((a, b) => a.depth - b.depth || a.to_slug.localeCompare(b.to_slug));
    for (const c of children) {
      const next = direction === 'in' ? c.from_slug : c.to_slug;
      const arrow = direction === 'in' ? '<-' : '--';
      const tail = direction === 'in' ? '--' : '->';
      console.log(`${'  '.repeat(indent + 1)}${arrow}${c.link_type}${tail} ${next} (depth ${c.depth})`);
      walk(next, indent + 1, seen);
    }
  }

  walk(rootSlug, 0, new Set());
}
