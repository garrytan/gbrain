import type { BrainEngine } from '../engine.ts';
import type {
  ContextMapEntry,
  ContextMapExplanation,
  ContextMapExplanationInput,
  ContextMapExplanationNeighborEdge,
  ContextMapExplanationRead,
  ContextMapExplanationResult,
} from '../types.ts';
import type { StructuralGraphEdge, StructuralGraphNode } from './note-structural-graph-service.ts';
import {
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
  WORKSPACE_CONTEXT_MAP_KIND,
  workspaceContextMapId,
} from './context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

const NEIGHBOR_EDGE_LIMIT = 8;
const RECOMMENDED_READ_LIMIT = 4;

export async function getStructuralContextMapExplanation(
  engine: BrainEngine,
  input: ContextMapExplanationInput,
): Promise<ContextMapExplanationResult> {
  const selection = await selectContextMapForExplanation(engine, input);
  if (!selection.entry) {
    return {
      selection_reason: selection.reason,
      candidate_count: selection.candidate_count,
      explanation: null,
    };
  }

  const explanation = await buildExplanation(engine, selection.entry, input.node_id);
  if (!explanation) {
    return {
      selection_reason: 'node_not_found',
      candidate_count: selection.candidate_count,
      explanation: null,
    };
  }

  return {
    selection_reason: selection.reason,
    candidate_count: selection.candidate_count,
    explanation,
  };
}

async function selectContextMapForExplanation(
  engine: BrainEngine,
  input: ContextMapExplanationInput,
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

async function buildExplanation(
  engine: BrainEngine,
  entry: ContextMapEntry,
  nodeId: string,
): Promise<ContextMapExplanation | null> {
  const graph = entry.graph_json as {
    nodes?: StructuralGraphNode[];
    edges?: StructuralGraphEdge[];
  };
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const node = nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) return null;

  const neighborEdges = edges
    .filter((edge) => edge.from_node_id === node.node_id || edge.to_node_id === node.node_id)
    .slice(0, NEIGHBOR_EDGE_LIMIT)
    .map(toNeighborEdge);
  const recommendedReads = await resolveRecommendedReads(engine, entry.scope_id, node, edges);

  return {
    explanation_kind: 'structural',
    title: `${node.label} Explanation`,
    map_id: entry.id,
    node_id: node.node_id,
    node_kind: node.node_kind,
    label: node.label,
    status: entry.status,
    summary_lines: [
      `Context map status is ${entry.status}.`,
      `Explained node is ${node.node_kind} ${node.label} from ${node.page_slug}.`,
      `Neighbor edges available: ${neighborEdges.length}.`,
      entry.status === 'stale'
        ? 'Rebuild the context map before trusting this local explanation for broad routing.'
        : 'Open canonical reads before treating this orientation as truth.',
    ],
    neighbor_edges: neighborEdges,
    recommended_reads: recommendedReads,
  };
}

function toNeighborEdge(edge: StructuralGraphEdge): ContextMapExplanationNeighborEdge {
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
  node: StructuralGraphNode,
  edges: StructuralGraphEdge[],
): Promise<ContextMapExplanationRead[]> {
  const candidateNodeIds = [
    node.node_id,
    ...edges
      .filter((edge) => edge.from_node_id === node.node_id || edge.to_node_id === node.node_id)
      .map((edge) => (edge.from_node_id === node.node_id ? edge.to_node_id : edge.from_node_id)),
  ];
  const reads: ContextMapExplanationRead[] = [];
  const seenNodeIds = new Set<string>();
  const seenPageSlugs = new Set<string>();

  for (const candidateNodeId of candidateNodeIds) {
    if (seenNodeIds.has(candidateNodeId)) continue;
    seenNodeIds.add(candidateNodeId);
    const resolved = await resolveNodeRead(engine, scopeId, candidateNodeId);
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
): Promise<ContextMapExplanationRead | null> {
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
