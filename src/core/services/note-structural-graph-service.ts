import type { BrainEngine } from '../engine.ts';
import type { NoteManifestEntry, NoteSectionEntry } from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { listAllNoteManifestEntries, listAllNoteSectionEntries } from './structural-entry-pagination.ts';

export type StructuralNodeId = `page:${string}` | `section:${string}`;
export type StructuralEdgeKind = 'page_contains_section' | 'section_parent' | 'section_links_page';

export interface StructuralGraphNode {
  node_id: StructuralNodeId;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  section_id?: string;
}

export interface StructuralGraphEdge {
  edge_kind: StructuralEdgeKind;
  from_node_id: StructuralNodeId;
  to_node_id: StructuralNodeId;
  scope_id: string;
  source_page_slug: string;
  source_section_id?: string;
  source_path?: string;
  source_refs: string[];
}

export interface StructuralGraphSnapshot {
  scope_id: string;
  nodes: StructuralGraphNode[];
  edges: StructuralGraphEdge[];
}

export interface StructuralPathResult {
  scope_id: string;
  from_node_id: StructuralNodeId;
  to_node_id: StructuralNodeId;
  node_ids: StructuralNodeId[];
  edges: StructuralGraphEdge[];
  hop_count: number;
}

export async function buildStructuralGraphSnapshot(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<StructuralGraphSnapshot> {
  const manifests = await listAllNoteManifestEntries(engine, scopeId);
  const sections = await listAllNoteSectionEntries(engine, scopeId);

  const manifestBySlug = new Map<string, NoteManifestEntry>(
    manifests.map((manifest) => [manifest.slug, manifest]),
  );
  const nodes = new Map<StructuralNodeId, StructuralGraphNode>();
  const edges: StructuralGraphEdge[] = [];

  for (const manifest of manifests) {
    const nodeId = toPageNodeId(manifest.slug);
    nodes.set(nodeId, {
      node_id: nodeId,
      node_kind: 'page',
      label: manifest.title,
      page_slug: manifest.slug,
    });
  }

  for (const section of sections) {
    const sectionNodeId = toSectionNodeId(section.section_id);
    nodes.set(sectionNodeId, {
      node_id: sectionNodeId,
      node_kind: 'section',
      label: section.heading_text,
      page_slug: section.page_slug,
      section_id: section.section_id,
    });

    edges.push({
      edge_kind: 'page_contains_section',
      from_node_id: toPageNodeId(section.page_slug),
      to_node_id: sectionNodeId,
      scope_id: section.scope_id,
      source_page_slug: section.page_slug,
      source_section_id: section.section_id,
      source_path: section.page_path,
      source_refs: section.source_refs,
    });

    if (section.parent_section_id) {
      edges.push({
        edge_kind: 'section_parent',
        from_node_id: sectionNodeId,
        to_node_id: toSectionNodeId(section.parent_section_id),
        scope_id: section.scope_id,
        source_page_slug: section.page_slug,
        source_section_id: section.section_id,
        source_path: section.page_path,
        source_refs: section.source_refs,
      });
    }

    for (const targetSlug of section.outgoing_wikilinks) {
      if (!manifestBySlug.has(targetSlug)) continue;
      edges.push({
        edge_kind: 'section_links_page',
        from_node_id: sectionNodeId,
        to_node_id: toPageNodeId(targetSlug),
        scope_id: section.scope_id,
        source_page_slug: section.page_slug,
        source_section_id: section.section_id,
        source_path: section.page_path,
        source_refs: section.source_refs,
      });
    }
  }

  return {
    scope_id: scopeId,
    nodes: [...nodes.values()].sort((left, right) => left.node_id.localeCompare(right.node_id)),
    edges: edges.sort(compareEdges),
  };
}

export async function getStructuralNeighbors(
  engine: BrainEngine,
  nodeId: StructuralNodeId,
  input: { scope_id?: string; limit?: number } = {},
): Promise<StructuralGraphEdge[]> {
  assertNodeId(nodeId);
  const snapshot = await buildStructuralGraphSnapshot(engine, input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  ensureNodeExists(snapshot, nodeId);

  const edges = snapshot.edges.filter((edge) => edge.from_node_id === nodeId || edge.to_node_id === nodeId);
  return edges.slice(0, input.limit ?? 20);
}

export async function findStructuralPath(
  engine: BrainEngine,
  fromNodeId: StructuralNodeId,
  toNodeId: StructuralNodeId,
  input: { scope_id?: string; max_depth?: number } = {},
): Promise<StructuralPathResult | null> {
  assertNodeId(fromNodeId);
  assertNodeId(toNodeId);

  const snapshot = await buildStructuralGraphSnapshot(engine, input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  ensureNodeExists(snapshot, fromNodeId);
  ensureNodeExists(snapshot, toNodeId);

  if (fromNodeId === toNodeId) {
    return {
      scope_id: snapshot.scope_id,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      node_ids: [fromNodeId],
      edges: [],
      hop_count: 0,
    };
  }

  const maxDepth = input.max_depth ?? 6;
  const adjacency = buildAdjacency(snapshot.edges);
  const queue: Array<{ node_id: StructuralNodeId; depth: number }> = [{ node_id: fromNodeId, depth: 0 }];
  const visited = new Set<StructuralNodeId>([fromNodeId]);
  const previous = new Map<StructuralNodeId, { node_id: StructuralNodeId; edge: StructuralGraphEdge }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const edge of adjacency.get(current.node_id) ?? []) {
      const neighbor = edge.from_node_id === current.node_id ? edge.to_node_id : edge.from_node_id;
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);
      previous.set(neighbor, { node_id: current.node_id, edge });

      if (neighbor === toNodeId) {
        return materializePath(snapshot.scope_id, fromNodeId, toNodeId, previous);
      }

      queue.push({ node_id: neighbor, depth: current.depth + 1 });
    }
  }

  return null;
}

function materializePath(
  scopeId: string,
  fromNodeId: StructuralNodeId,
  toNodeId: StructuralNodeId,
  previous: Map<StructuralNodeId, { node_id: StructuralNodeId; edge: StructuralGraphEdge }>,
): StructuralPathResult {
  const nodeIds: StructuralNodeId[] = [toNodeId];
  const edges: StructuralGraphEdge[] = [];
  let cursor = toNodeId;

  while (cursor !== fromNodeId) {
    const step = previous.get(cursor);
    if (!step) {
      throw new Error(`Structural path materialization failed for ${fromNodeId} -> ${toNodeId}`);
    }
    edges.push(step.edge);
    nodeIds.push(step.node_id);
    cursor = step.node_id;
  }

  nodeIds.reverse();
  edges.reverse();

  return {
    scope_id: scopeId,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    node_ids: nodeIds,
    edges,
    hop_count: edges.length,
  };
}

function buildAdjacency(edges: StructuralGraphEdge[]): Map<StructuralNodeId, StructuralGraphEdge[]> {
  const adjacency = new Map<StructuralNodeId, StructuralGraphEdge[]>();

  for (const edge of edges) {
    const fromEdges = adjacency.get(edge.from_node_id) ?? [];
    fromEdges.push(edge);
    adjacency.set(edge.from_node_id, fromEdges);

    const toEdges = adjacency.get(edge.to_node_id) ?? [];
    toEdges.push(edge);
    adjacency.set(edge.to_node_id, toEdges);
  }

  for (const value of adjacency.values()) {
    value.sort(compareEdges);
  }

  return adjacency;
}

function ensureNodeExists(snapshot: StructuralGraphSnapshot, nodeId: StructuralNodeId): void {
  if (!snapshot.nodes.some((node) => node.node_id === nodeId)) {
    throw new Error(`Structural node not found: ${nodeId}`);
  }
}

function compareEdges(left: StructuralGraphEdge, right: StructuralGraphEdge): number {
  return (
    left.from_node_id.localeCompare(right.from_node_id)
    || left.edge_kind.localeCompare(right.edge_kind)
    || left.to_node_id.localeCompare(right.to_node_id)
  );
}

function assertNodeId(nodeId: string): asserts nodeId is StructuralNodeId {
  if (nodeId.startsWith('page:') || nodeId.startsWith('section:')) {
    return;
  }
  throw new Error(`Invalid structural node id: ${nodeId}`);
}

function toPageNodeId(slug: string): StructuralNodeId {
  return `page:${slug}`;
}

function toSectionNodeId(sectionId: string): StructuralNodeId {
  return `section:${sectionId}`;
}
