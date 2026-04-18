/**
 * gbrain graph-query — relationship traversal with type and direction filters.
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
    const arg = args[i];
    if (arg === '--type' && i + 1 < args.length) out.linkType = args[++i];
    else if (arg === '--depth' && i + 1 < args.length) out.depth = Number(args[++i]);
    else if (arg === '--direction' && i + 1 < args.length) {
      const direction = args[++i];
      if (direction === 'in' || direction === 'out' || direction === 'both') out.direction = direction;
    }
    else if (arg === '--help' || arg === '-h') out.showHelp = true;
    else if (!arg.startsWith('-') && !out.slug) out.slug = arg;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: gbrain graph-query <slug> [options]

Traverse the link graph from a page. Returns an indented tree of edges.

Options:
  --type <link_type>   Filter to one link type.
  --depth <N>          Max traversal depth (default 5).
  --direction <dir>    'out' (default), 'in', or 'both'.
  -h, --help           Show this message.`);
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

function printTree(rootSlug: string, paths: GraphPath[], direction: 'in' | 'out' | 'both') {
  const byParent = new Map<string, GraphPath[]>();
  for (const path of paths) {
    const parent = direction === 'in' ? path.to_slug : path.from_slug;
    const list = byParent.get(parent) ?? [];
    list.push(path);
    byParent.set(parent, list);
  }

  function walk(parent: string, indent: number, seen: Set<string>) {
    if (seen.has(parent)) return;
    seen.add(parent);
    const children = byParent.get(parent) ?? [];
    children.sort((a, b) => a.depth - b.depth || a.to_slug.localeCompare(b.to_slug));
    for (const child of children) {
      const next = direction === 'in' ? child.from_slug : child.to_slug;
      const arrow = direction === 'in' ? '<-' : '--';
      const tail = direction === 'in' ? '--' : '->';
      console.log(`${'  '.repeat(indent + 1)}${arrow}${child.link_type}${tail} ${next} (depth ${child.depth})`);
      walk(next, indent + 1, seen);
    }
  }

  walk(rootSlug, 0, new Set());
}
