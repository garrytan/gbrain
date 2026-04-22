import type { BrainEngine } from '../engine.ts';
import type {
  ContextMapEntry,
  ContextMapQueryInput,
  ContextMapQueryMatch,
  ContextMapQueryRead,
  ContextMapQueryResult,
  ContextMapQueryResultPayload,
} from '../types.ts';
import type { StructuralGraphNode } from './note-structural-graph-service.ts';
import {
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
  WORKSPACE_CONTEXT_MAP_KIND,
  workspaceContextMapId,
} from './context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

const DEFAULT_QUERY_LIMIT = 5;

export async function queryStructuralContextMap(
  engine: BrainEngine,
  input: ContextMapQueryInput,
): Promise<ContextMapQueryResult> {
  const selection = await selectContextMapForQuery(engine, input);
  if (!selection.entry) {
    return {
      selection_reason: selection.reason,
      candidate_count: selection.candidate_count,
      result: null,
    };
  }

  return {
    selection_reason: selection.reason,
    candidate_count: selection.candidate_count,
    result: await buildQueryResult(engine, selection.entry, input),
  };
}

async function selectContextMapForQuery(
  engine: BrainEngine,
  input: ContextMapQueryInput,
): Promise<{ reason: string; candidate_count: number; entry: ContextMapEntry | null }> {
  if (input.map_id) {
    const entry = await getStructuralContextMapEntry(engine, input.map_id);
    return {
      reason: entry ? 'direct_map_id' : 'map_not_found',
      candidate_count: entry ? 1 : 0,
      entry,
    };
  }

  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const kind = input.kind ?? WORKSPACE_CONTEXT_MAP_KIND;
  const entries = await listStructuralContextMapEntries(engine, {
    scope_id: scopeId,
    kind,
    limit: 100,
  });

  if (entries.length === 0) {
    const workspaceId = kind === WORKSPACE_CONTEXT_MAP_KIND ? workspaceContextMapId(scopeId) : undefined;
    if (workspaceId) {
      const direct = await getStructuralContextMapEntry(engine, workspaceId);
      if (direct) {
        return {
          reason: direct.status === 'ready' ? 'selected_fresh_match' : 'selected_stale_match',
          candidate_count: 1,
          entry: direct,
        };
      }
    }

    return {
      reason: 'no_match',
      candidate_count: 0,
      entry: null,
    };
  }

  const [entry] = [...entries].sort(compareMapEntries);
  return {
    reason: entry.status === 'ready' ? 'selected_fresh_match' : 'selected_stale_match',
    candidate_count: entries.length,
    entry,
  };
}

async function buildQueryResult(
  engine: BrainEngine,
  entry: ContextMapEntry,
  input: ContextMapQueryInput,
): Promise<ContextMapQueryResultPayload> {
  const graph = entry.graph_json as { nodes?: StructuralGraphNode[] };
  const nodes = graph.nodes ?? [];
  const limit = input.limit ?? DEFAULT_QUERY_LIMIT;
  const matchedNodes = rankNodes(nodes, input.query).slice(0, limit);
  const recommendedReads = await resolveRecommendedReads(engine, entry.scope_id, matchedNodes);

  return {
    query_kind: 'structural',
    map_id: entry.id,
    query: input.query,
    status: entry.status,
    summary_lines: [
      `Context map status is ${entry.status}.`,
      `Matched nodes available: ${matchedNodes.length}.`,
      entry.status === 'stale'
        ? 'Rebuild the context map before trusting this query result for broad routing.'
        : 'Open canonical reads before treating this query result as truth.',
    ],
    matched_nodes: matchedNodes,
    recommended_reads: recommendedReads,
  };
}

function rankNodes(nodes: StructuralGraphNode[], query: string): ContextMapQueryMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  return nodes
    .map((node) => ({ node, score: scoreNode(node, normalizedQuery) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.node.node_kind.localeCompare(right.node.node_kind)
      || left.node.label.localeCompare(right.node.label)
      || left.node.node_id.localeCompare(right.node.node_id))
    .map(({ node, score }) => ({
      node_id: node.node_id,
      node_kind: node.node_kind,
      label: node.label,
      page_slug: node.page_slug,
      score,
    }));
}

function scoreNode(node: StructuralGraphNode, query: string): number {
  const label = node.label.toLowerCase();
  const pageSlug = node.page_slug.toLowerCase();

  if (label === query) return 3;
  if (label.includes(query)) return 2;
  if (pageSlug.includes(query)) return 1;
  return 0;
}

async function resolveRecommendedReads(
  engine: BrainEngine,
  scopeId: string,
  matches: ContextMapQueryMatch[],
): Promise<ContextMapQueryRead[]> {
  const reads: ContextMapQueryRead[] = [];
  const seenPageSlugs = new Set<string>();

  for (const match of matches) {
    const resolved = await resolveNodeRead(engine, scopeId, match.node_id);
    if (!resolved) continue;
    if (seenPageSlugs.has(resolved.page_slug)) continue;
    seenPageSlugs.add(resolved.page_slug);
    reads.push(resolved);
  }

  return reads;
}

async function resolveNodeRead(
  engine: BrainEngine,
  scopeId: string,
  nodeId: string,
): Promise<ContextMapQueryRead | null> {
  if (nodeId.startsWith('page:')) {
    const slug = nodeId.slice('page:'.length);
    const [manifest] = await engine.listNoteManifestEntries({
      scope_id: scopeId,
      slug,
      limit: 1,
    });
    if (!manifest) return null;
    return {
      node_id: nodeId,
      node_kind: 'page',
      label: manifest.title,
      page_slug: manifest.slug,
      path: manifest.path,
    };
  }

  if (nodeId.startsWith('section:')) {
    const sectionId = nodeId.slice('section:'.length);
    const [section] = await engine.listNoteSectionEntries({
      scope_id: scopeId,
      section_id: sectionId,
      limit: 1,
    });
    if (!section) return null;
    return {
      node_id: nodeId,
      node_kind: 'section',
      label: section.heading_text,
      page_slug: section.page_slug,
      path: section.page_path,
      section_id: section.section_id,
    };
  }

  return null;
}

function compareMapEntries(left: ContextMapEntry, right: ContextMapEntry): number {
  if (left.status !== right.status) {
    return left.status === 'ready' ? -1 : 1;
  }
  const generatedDelta = new Date(right.generated_at).getTime() - new Date(left.generated_at).getTime();
  if (generatedDelta !== 0) return generatedDelta;
  return left.id.localeCompare(right.id);
}
