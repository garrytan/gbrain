import type { BrainEngine } from '../engine.ts';
import type {
  ContextMapEntry,
  ContextMapPathEdge,
  ContextMapPathInput,
  ContextMapPathRead,
  ContextMapPathResult,
  ContextMapPathResultPayload,
} from '../types.ts';
import type { StructuralGraphEdge, StructuralGraphNode } from './note-structural-graph-service.ts';
import {
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
  WORKSPACE_CONTEXT_MAP_KIND,
  workspaceContextMapId,
} from './context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

const RECOMMENDED_READ_LIMIT = 4;
const DEFAULT_MAX_DEPTH = 6;

export async function findStructuralContextMapPath(
  engine: BrainEngine,
  input: ContextMapPathInput,
): Promise<ContextMapPathResult> {
  const selection = await selectContextMapForPath(engine, input);
  if (!selection.entry) {
    return {
      selection_reason: selection.reason,
      candidate_count: selection.candidate_count,
      path: null,
    };
  }

  const path = await buildPath(engine, selection.entry, input);
  if (!path) {
    return {
      selection_reason: 'no_path',
      candidate_count: selection.candidate_count,
      path: null,
    };
  }

  return {
    selection_reason: selection.reason,
    candidate_count: selection.candidate_count,
    path,
  };
}

async function selectContextMapForPath(
  engine: BrainEngine,
  input: ContextMapPathInput,
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

async function buildPath(
  engine: BrainEngine,
  entry: ContextMapEntry,
  input: ContextMapPathInput,
): Promise<ContextMapPathResultPayload | null> {
  const graph = entry.graph_json as {
    nodes?: StructuralGraphNode[];
    edges?: StructuralGraphEdge[];
  };
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (!nodes.some((node) => node.node_id === input.from_node_id)) return null;
  if (!nodes.some((node) => node.node_id === input.to_node_id)) return null;

  const resolved = findPath(edges, input.from_node_id, input.to_node_id, input.max_depth ?? DEFAULT_MAX_DEPTH);
  if (!resolved) return null;

  const recommendedReads = await resolveRecommendedReads(engine, entry.scope_id, resolved.node_ids);

  return {
    path_kind: 'structural',
    map_id: entry.id,
    from_node_id: input.from_node_id,
    to_node_id: input.to_node_id,
    status: entry.status,
    hop_count: resolved.edges.length,
    node_ids: resolved.node_ids,
    edges: resolved.edges.map(toPathEdge),
    summary_lines: [
      `Context map status is ${entry.status}.`,
      `Resolved path hop count is ${resolved.edges.length}.`,
      entry.status === 'stale'
        ? 'Rebuild the context map before trusting this path for broad routing.'
        : 'Open canonical reads before treating this path as truth.',
    ],
    recommended_reads: recommendedReads,
  };
}

function findPath(
  edges: StructuralGraphEdge[],
  fromNodeId: string,
  toNodeId: string,
  maxDepth: number,
): { node_ids: string[]; edges: StructuralGraphEdge[] } | null {
  if (fromNodeId === toNodeId) {
    return { node_ids: [fromNodeId], edges: [] };
  }

  const adjacency = buildAdjacency(edges);
  const queue: Array<{ node_id: string; depth: number }> = [{ node_id: fromNodeId, depth: 0 }];
  const visited = new Set<string>([fromNodeId]);
  const previous = new Map<string, { node_id: string; edge: StructuralGraphEdge }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const edge of adjacency.get(current.node_id) ?? []) {
      const neighbor = edge.from_node_id === current.node_id ? edge.to_node_id : edge.from_node_id;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      previous.set(neighbor, { node_id: current.node_id, edge });

      if (neighbor === toNodeId) {
        return materializePath(fromNodeId, toNodeId, previous);
      }

      queue.push({ node_id: neighbor, depth: current.depth + 1 });
    }
  }

  return null;
}

function buildAdjacency(edges: StructuralGraphEdge[]): Map<string, StructuralGraphEdge[]> {
  const adjacency = new Map<string, StructuralGraphEdge[]>();

  for (const edge of edges) {
    const fromEdges = adjacency.get(edge.from_node_id) ?? [];
    fromEdges.push(edge);
    adjacency.set(edge.from_node_id, fromEdges);

    const toEdges = adjacency.get(edge.to_node_id) ?? [];
    toEdges.push(edge);
    adjacency.set(edge.to_node_id, toEdges);
  }

  for (const bucket of adjacency.values()) {
    bucket.sort(compareEdges);
  }

  return adjacency;
}

function materializePath(
  fromNodeId: string,
  toNodeId: string,
  previous: Map<string, { node_id: string; edge: StructuralGraphEdge }>,
): { node_ids: string[]; edges: StructuralGraphEdge[] } {
  const nodeIds: string[] = [toNodeId];
  const edges: StructuralGraphEdge[] = [];
  let cursor = toNodeId;

  while (cursor !== fromNodeId) {
    const step = previous.get(cursor);
    if (!step) {
      throw new Error(`Persisted context map path materialization failed for ${fromNodeId} -> ${toNodeId}`);
    }
    edges.push(step.edge);
    nodeIds.push(step.node_id);
    cursor = step.node_id;
  }

  nodeIds.reverse();
  edges.reverse();
  return { node_ids: nodeIds, edges };
}

function toPathEdge(edge: StructuralGraphEdge): ContextMapPathEdge {
  return {
    edge_kind: edge.edge_kind,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    source_page_slug: edge.source_page_slug,
    source_section_id: edge.source_section_id,
  };
}

async function resolveRecommendedReads(
  engine: BrainEngine,
  scopeId: string,
  nodeIds: string[],
): Promise<ContextMapPathRead[]> {
  const reads: ContextMapPathRead[] = [];
  const seenPageSlugs = new Set<string>();

  for (const nodeId of nodeIds) {
    const resolved = await resolveNodeRead(engine, scopeId, nodeId);
    if (!resolved) continue;
    if (seenPageSlugs.has(resolved.page_slug)) continue;
    seenPageSlugs.add(resolved.page_slug);
    reads.push(resolved);
    if (reads.length >= RECOMMENDED_READ_LIMIT) break;
  }

  return reads;
}

async function resolveNodeRead(
  engine: BrainEngine,
  scopeId: string,
  nodeId: string,
): Promise<ContextMapPathRead | null> {
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

function compareEdges(left: StructuralGraphEdge, right: StructuralGraphEdge): number {
  return (
    left.from_node_id.localeCompare(right.from_node_id)
    || left.edge_kind.localeCompare(right.edge_kind)
    || left.to_node_id.localeCompare(right.to_node_id)
  );
}

function compareMapEntries(left: ContextMapEntry, right: ContextMapEntry): number {
  if (left.status !== right.status) {
    return left.status === 'ready' ? -1 : 1;
  }
  const generatedDelta = new Date(right.generated_at).getTime() - new Date(left.generated_at).getTime();
  if (generatedDelta !== 0) return generatedDelta;
  return left.id.localeCompare(right.id);
}
