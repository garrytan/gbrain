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
import { TRAVERSE_PATH_ROW_CAP } from '../core/engine-constants.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { resolveSourceId, resolveSourceIdEngineFree, ALL_SOURCES } from '../core/source-resolver.ts';

interface Args {
  slug?: string;
  linkType?: string;
  depth: number;
  direction: 'in' | 'out' | 'both';
  showHelp: boolean;
  includeForeign: boolean;
  source?: string;
}

function parseArgs(args: string[]): Args {
  const out: Args = { depth: 5, direction: 'out', showHelp: false, includeForeign: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type' && i + 1 < args.length) out.linkType = args[++i];
    else if (a === '--depth' && i + 1 < args.length) out.depth = Number(args[++i]);
    else if (a === '--direction' && i + 1 < args.length) {
      const d = args[++i];
      if (d === 'in' || d === 'out' || d === 'both') out.direction = d;
    }
    else if (a === '--include-foreign') out.includeForeign = true;
    // A valueless `--source` (last arg) or `--source=` parses to '' so
    // runGraphQuery can refuse it on EVERY path — '' must never read as
    // "ambient scope".
    else if (a === '--source') out.source = i + 1 < args.length ? args[++i] : '';
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
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
  --type <link_type>     Filter to one link type (attended, works_at, invested_in,
                         founded, advises, mentions, source).
  --depth <N>            Max traversal depth (default 5).
  --direction <dir>      'out' (default), 'in', or 'both'.
  --source <id>          Scope the walk to this source. Defaults to the
                         resolved source (GBRAIN_SOURCE, .gbrain-source,
                         path match, brain default); __all__ spans every
                         source. An unknown source is a hard error. Local
                         installs only: a thin client rejects it (the server
                         scopes the walk to your grant).
  --include-foreign      Include edges to pages in other sources (v0.37.7.0).
                         Off by default; the walk stays inside the resolved
                         source, and a footer reports the count of
                         foreign-source edges hidden so users discover they exist.
                         Not forwarded on a thin client.
  -h, --help             Show this message.

Examples:
  gbrain graph-query people/alice --type attended --depth 2
    -> who attended meetings with Alice (multi-hop)
  gbrain graph-query companies/acme --type works_at --direction in
    -> who works at Acme
  gbrain graph-query people/bob --depth 1
    -> Bob's direct connections
  gbrain graph-query people/bob --include-foreign
    -> include edges to pages in other sources
`);
}

/**
 * v0.37.7.0 #1153: count edges from rootSlug whose target page lives in
 * a different source than the root. Used to render the footer
 * "(N edges to foreign-source pages hidden ...)" so users discover that
 * scoped traversal hides cross-source edges by default.
 *
 * Returns 0 (not an error) if the root page doesn't exist or has no
 * source_id set — both cases mean "no foreign edges to surface."
 */
async function countForeignEdges(
  engine: BrainEngine,
  rootSlug: string,
  direction: 'in' | 'out' | 'both',
  sourceId: string,
): Promise<number> {
  // The root is (sourceId, rootSlug) — slugs are unique per source, so an
  // unqualified slug match would count another source's same-slug page's
  // edges as "hidden" from a walk that never touched it.
  // For 'out': from_page is root, count where from.source_id != to.source_id.
  // For 'in': to_page is root, count where to.source_id != from.source_id.
  // For 'both': either endpoint can be the root; union the two cases.
  const sql = direction === 'in'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE tp.slug = $1 AND tp.source_id = $2
          AND fp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : direction === 'both'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE ((fp.slug = $1 AND fp.source_id = $2) OR (tp.slug = $1 AND tp.source_id = $2))
          AND fp.source_id IS NOT NULL
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE fp.slug = $1 AND fp.source_id = $2
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`;
  try {
    const rows = await engine.executeRaw<{ n: string }>(sql, [rootSlug, sourceId]);
    return Number(rows[0]?.n ?? 0);
  } catch {
    // Pre-v0.18 brains may not have source_id on pages. Fail-open: no
    // foreign edges to report.
    return 0;
  }
}

export async function runGraphQuery(engine: BrainEngine, argv: string[]) {
  const args = parseArgs(argv);
  if (args.showHelp || !args.slug) {
    printHelp();
    if (!args.slug) process.exit(1);
    return;
  }

  // v0.31.1 (Issue #734): on thin-client installs, route via MCP. The
  // traverse_graph op returns GraphPath[] when link_type or direction is
  // set (which the CLI always does); unpackToolResult parses the JSON.
  let paths: GraphPath[];
  // True only when the local walk was narrowed to one source — the footer
  // reports what that narrowing hid, so it must never print for an unscoped
  // walk (--include-foreign, --source __all__, or the thin-client path, where
  // the server scopes to the caller's grant).
  let scoped = false;
  // The source the local walk was narrowed to (set only when `scoped`).
  let sourceId = '';
  if (args.source === '') {
    console.error('`--source` requires a value');
    process.exit(1);
  }
  if (args.source !== undefined && args.includeForeign) {
    // Validating X and then walking every source would make --source a no-op.
    console.error('pass --source <id> OR --include-foreign, not both (--include-foreign spans every source; --source narrows the walk to one).');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    // The remote traverse_graph op has no source_id param: the server scopes
    // the walk to the caller's grant. --source used to be dropped silently
    // (a grant-wide walk with exit 0), contradicting the "unknown source is a
    // hard error" contract above; reject it the way applyThinClientSourceScope
    // does for op commands. --include-foreign is meaningless there (the grant
    // already bounds the walk) — say so instead of pretending it applied.
    const cannotForwardScope = 'the remote op has no source_id parameter; the server scopes the walk to your grant';
    if (args.source !== undefined) {
      console.error(`gbrain graph-query does not accept --source on a thin-client install (${cannotForwardScope}).`);
      process.exit(1);
    }
    // An ambient scope (GBRAIN_SOURCE / .gbrain-source) is just as
    // un-forwardable — say so instead of letting the user believe it applied.
    let ambient: string | null = null;
    try { ambient = resolveSourceIdEngineFree(null); } catch { /* malformed env: the serve's own resolver reports it */ }
    if (ambient !== null) {
      console.error(`[thin-client] ambient source scope '${ambient}' is not forwarded (${cannotForwardScope}).`);
    }
    if (args.includeForeign) {
      console.error(`[thin-client] --include-foreign is not forwarded (${cannotForwardScope}).`);
    }
    const raw = await callRemoteTool(cfg!, 'traverse_graph', {
      slug: args.slug,
      depth: args.depth,
      link_type: args.linkType,
      direction: args.direction,
    }, { timeoutMs: 30_000 });
    paths = unpackToolResult<GraphPath[]>(raw);
  } else {
    // #4765: the walk used to run unscoped (the traverse_graph op scopes via
    // sourceScopeOpts; this CLI twin never did), so --include-foreign was
    // inert and the footer described a filter that never applied. Resolve
    // the source the way every other local command does; an explicit
    // --source that fails to resolve throws loudly (#1712 policy).
    sourceId = await resolveSourceId(engine, args.source ?? null);
    scoped = !args.includeForeign && sourceId !== ALL_SOURCES;
    const walk = await engine.traversePathsDetailed(args.slug, {
      depth: args.depth,
      linkType: args.linkType,
      direction: args.direction,
      ...(scoped ? { sourceId } : {}),
    });
    paths = walk.paths;
    if (walk.truncated) {
      console.error(`(edge walk truncated at ${TRAVERSE_PATH_ROW_CAP} rows, shallowest first; lower --depth or narrow with --type/--direction)`);
    }
  }

  if (paths.length === 0) {
    console.log(`No edges found from ${args.slug}${args.linkType ? ` (--type ${args.linkType})` : ''}.`);
    // Still report foreign edges so the user knows they exist in other
    // sources even when the scoped traversal returned nothing.
    if (scoped) {
      const foreign = await countForeignEdges(engine, args.slug, args.direction, sourceId);
      if (foreign > 0) {
        console.error(
          `(${foreign} edge${foreign === 1 ? '' : 's'} to foreign-source pages hidden; pass --include-foreign to include them)`,
        );
      }
    }
    return;
  }

  console.log(`[depth 0] ${args.slug}`);
  printTree(args.slug, paths, args.direction);

  // v0.37.7.0 #1153: surface the count of foreign-source edges that the
  // scoped traversal silently dropped. Thin-client path skips this
  // (engine query not available); local path runs the count and prints
  // the footer when there are hidden edges AND the user didn't opt in.
  if (scoped) {
    const foreign = await countForeignEdges(engine, args.slug, args.direction, sourceId);
    if (foreign > 0) {
      console.error(
        `\n(${foreign} edge${foreign === 1 ? '' : 's'} to foreign-source pages hidden; pass --include-foreign to include them)`,
      );
    }
  }
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
