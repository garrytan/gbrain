/**
 * gbrain graph-map — the brain's pages and concepts as one graph.
 *
 *   gbrain graph-map [show] [--source <id>] [--json]
 *   gbrain graph-map clusters [--limit <n>] [--source <id>] [--json]
 *   gbrain graph-map export [--out <file.html>] [--max-nodes <n>] [--source <id>] [--json]
 *
 * Reads the source's live pages and links (core/graph/graph-map.ts builds the
 * two-level map, labels each edge stated / inferred / tool output and finds
 * clusters). Private pages (`visibility: private`) and deleted pages are never
 * read, so neither they nor their links reach any output. Read-only: the only
 * write is the export file, which `export` writes where --out says.
 */
import { renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  EVIDENCE_KINDS, buildGraphMap, clusterGraph, clusterName, graphMapExport, layoutGraph, renderGraphHtml,
  type GraphLinkRow, type GraphMap, type GraphPageRow,
} from '../core/graph/graph-map.ts';

const USAGE = `Usage: gbrain graph-map [show | clusters | export] [--source <id>] [--json]
  show                 nodes, links by evidence, the largest clusters, concept coverage (default)
  clusters             every cluster with its best-connected members (--limit <n>, default 20)
  export               one self-contained HTML map you can open or share
    --out <file>       where to write it (default graph-map-<source>.html in this folder)
    --max-nodes <n>    keep the n best-connected nodes (default 3000)
  --source <id>        the source (default: the current source)
  --json               machine-readable output`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; // the CLI entry splits --flag=value (cli/flag-equals.ts)
}

/** The source's live, non-private pages and the links between them. */
export async function loadGraphMap(engine: BrainEngine, sourceId: string): Promise<GraphMap> {
  const pages = await engine.executeRaw<GraphPageRow>(
    `SELECT p.id, p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND COALESCE(p.frontmatter->>'visibility', '') <> 'private'
      ORDER BY p.id`, [sourceId]);
  const links = await engine.executeRaw<GraphLinkRow>(
    `SELECT l.from_page_id, l.to_page_id, l.link_type, l.link_source, l.link_kind FROM links l
       JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.source_id = $1 AND t.source_id = $1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
        AND COALESCE(f.frontmatter->>'visibility', '') <> 'private' AND COALESCE(t.frontmatter->>'visibility', '') <> 'private'
      ORDER BY l.from_page_id, l.to_page_id`, [sourceId]);
  return buildGraphMap(pages.map(p => ({ ...p, id: Number(p.id) })),
    links.map(l => ({ ...l, from_page_id: Number(l.from_page_id), to_page_id: Number(l.to_page_id) })));
}

/** Keep the `max` best-connected nodes (concepts first among equals) and the edges between them. */
export function trimGraphMap(map: GraphMap, max: number): { map: GraphMap; dropped: number } {
  if (map.nodes.length <= max) return { map, dropped: 0 };
  const keep = new Set([...map.nodes].sort((x, y) => y.degree - x.degree || (x.kind === 'concept' ? -1 : 0) - (y.kind === 'concept' ? -1 : 0) || x.id - y.id)
    .slice(0, max).map(n => n.id));
  return {
    map: { ...map, nodes: map.nodes.filter(n => keep.has(n.id)), edges: map.edges.filter(e => keep.has(e.a) && keep.has(e.b)) },
    dropped: map.nodes.length - keep.size,
  };
}

function evidenceCounts(map: GraphMap): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(EVIDENCE_KINDS.map(k => [k, 0]));
  for (const e of map.edges) for (const k of e.evidence) out[k]! += 1;
  return out;
}

export async function runGraphMap(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'show';
  if (!['show', 'clusters', 'export'].includes(sub)) { console.error(USAGE); setCliExitVerdict(1); return; }
  const json = args.includes('--json');
  const { resolveSourceId } = await import('../core/source-resolver.ts');
  const sourceId = await resolveSourceId(engine, flagValue(args, '--source') ?? null);
  const full = await loadGraphMap(engine, sourceId);
  const clusters = clusterGraph(full);
  const named = clusters.members.map((ids, i) => ({ id: i, name: clusterName(full, ids), size: ids.length, ids }));

  if (sub === 'show') {
    const summary = {
      source: sourceId, nodes: full.nodes.length, concepts: full.coverage.concepts, links: full.edges.length,
      links_by_evidence: evidenceCounts(full), clusters: named.length, coverage: full.coverage,
      largest_clusters: named.slice(0, 5).map(({ ids: _ids, ...c }) => c),
    };
    if (json) { console.log(JSON.stringify(summary, null, 2)); return; }
    console.log(`Source ${sourceId}: ${summary.nodes} nodes (${summary.concepts} concepts), ${summary.links} links, ${summary.clusters} clusters.`);
    console.log(`Links by evidence: ${EVIDENCE_KINDS.map(k => `${summary.links_by_evidence[k]} ${k.replace('_', ' ')}`).join(', ')}.`);
    console.log(`Concepts reach ${full.coverage.pages_with_concepts} of ${full.coverage.pages} pages so far${full.coverage.concepts === 0 ? ' (none yet: the dream cycle builds them from each page, see foresights dream)' : ''}.`);
    if (named.length) console.log(`Largest clusters: ${named.slice(0, 5).map(c => `${c.name} (${c.size})`).join(', ')}.`);
    console.log('See every cluster: foresights graph-map clusters. Open the map: foresights graph-map export.');
    return;
  }

  if (sub === 'clusters') {
    const limit = Math.max(1, Number(flagValue(args, '--limit') ?? 20) || 20);
    const byId = new Map(full.nodes.map(n => [n.id, n]));
    const rows = named.slice(0, limit).map(c => ({ id: c.id, name: c.name, size: c.size,
      members: c.ids.map(id => byId.get(id)!).sort((x, y) => y.degree - x.degree || x.id - y.id).slice(0, 8).map(n => ({ slug: n.slug, title: n.title, kind: n.kind })) }));
    if (json) { console.log(JSON.stringify({ source: sourceId, clusters: rows, total: named.length }, null, 2)); return; }
    for (const c of rows) console.log(`${c.id + 1}. ${c.name} (${c.size}): ${c.members.map(m => m.title).join(', ')}${c.size > c.members.length ? ', ...' : ''}`);
    if (named.length > rows.length) console.log(`${named.length - rows.length} more; raise --limit to see them.`);
    return;
  }

  const max = Math.max(1, Number(flagValue(args, '--max-nodes') ?? 3000) || 3000);
  const { map, dropped } = trimGraphMap(full, max);
  const shown = clusterGraph(map);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the local operator's own --out path for their export (the command refuses thin clients and enforced members); nothing is read from it
  const out = resolve(flagValue(args, '--out') ?? `graph-map-${sourceId}.html`);
  const html = renderGraphHtml(graphMapExport(map, shown, layoutGraph(map, shown), { source: sourceId, generatedAt: new Date() }));
  writeFileSync(`${out}.tmp`, html);
  renameSync(`${out}.tmp`, out);
  const report = { source: sourceId, out, nodes: map.nodes.length, links: map.edges.length, clusters: shown.members.length, dropped_nodes: dropped, bytes: Buffer.byteLength(html) };
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Wrote ${out}: ${report.nodes} nodes, ${report.links} links, ${report.clusters} clusters${dropped ? ` (${dropped} less-connected nodes left out; raise --max-nodes)` : ''}. Open it in a browser; it needs no network.`);
}
