import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { NoteManifestEntry } from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { listAllNoteManifestEntries } from './structural-entry-pagination.ts';

export const CODE_LANE_CONTEXT_MAP_KIND = 'code_lane';
export const CODE_LANE_BUILD_MODE = 'code_lane_contract';
export const CODE_LANE_EXTRACTOR_VERSION = 'ga-p5-code-lane-v1';
export const CODE_LANE_STALE_REASON_SOURCE_SET_CHANGED = 'code_lane_source_set_changed';
export const DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS = {
  enabled_by_default: false,
  depth_limit: 1,
  fanout_cap: 50,
  max_nodes: 100,
  bounded_output: true,
  direction: 'both',
} as const;

export type CodeLaneAuthority = 'derived_orientation';
export type CodeLaneEdgeKind = 'declares' | 'calls' | 'references' | 'imports' | 'contains';
export type CodeLaneGraphDirection = 'out' | 'in' | 'both';

export interface CodeLaneNode {
  source_ref: string;
  repo_path: string;
  content_hash: string;
  extractor_version: string;
  symbol_id: string;
  path: string;
  symbol_name: string;
  qualified_name?: string;
  parent_symbol_path?: string;
  language?: string;
  chunk_id?: string;
  start_line?: number;
  end_line?: number;
  verification_hint: string;
  authority: CodeLaneAuthority;
}

export interface CodeLaneEdge {
  source_ref: string;
  repo_path: string;
  content_hash: string;
  extractor_version: string;
  edge_kind: CodeLaneEdgeKind;
  from_symbol_id: string;
  to_symbol_id: string;
  resolution: 'resolved' | 'unresolved' | 'ambiguous';
  verification_hint: string;
  authority: CodeLaneAuthority;
}

export interface CodeLaneGraphSnapshot {
  scope_id: string;
  kind: typeof CODE_LANE_CONTEXT_MAP_KIND;
  authority: CodeLaneAuthority;
  lane_grants_authority: false;
  graph_walk: typeof DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS;
  nodes: CodeLaneNode[];
  edges: CodeLaneEdge[];
}

export interface CodeLaneGraphExpansion {
  root_symbol_id: string;
  requested: boolean;
  direction: CodeLaneGraphDirection;
  depth_limit: number;
  fanout_cap: number;
  max_nodes: number;
  nodes: CodeLaneNode[];
  edges: CodeLaneEdge[];
  truncated: boolean;
  truncation_reason: 'fanout_cap' | 'depth_limit' | 'max_nodes' | null;
}

interface CodemapEntry {
  system?: unknown;
  repo_path?: unknown;
  pointers?: unknown;
}

interface CodemapPointer {
  path?: unknown;
  repo_path?: unknown;
  symbol?: unknown;
  symbol_name?: unknown;
  qualified_name?: unknown;
  parent_symbol_path?: unknown;
  language?: unknown;
  chunk_id?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  content_hash?: unknown;
  source_ref?: unknown;
  verification_hint?: unknown;
  edges?: unknown;
}

interface CodemapPointerEdge {
  kind?: unknown;
  edge_kind?: unknown;
  to_symbol?: unknown;
  to_symbol_id?: unknown;
}

export async function buildCodeLaneGraphSnapshot(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<CodeLaneGraphSnapshot> {
  const manifests = await listAllNoteManifestEntries(engine, scopeId);
  return buildCodeLaneGraphSnapshotFromManifests(manifests, scopeId);
}

export function buildCodeLaneGraphSnapshotFromManifests(
  manifests: NoteManifestEntry[],
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): CodeLaneGraphSnapshot {
  const pointers = collectCodemapPointers(manifests);
  const nodes = pointers
    .map(({ manifest, codemap, pointer }) => buildNode(manifest, codemap, pointer))
    .sort((left, right) => left.symbol_id.localeCompare(right.symbol_id));
  const symbolLookup = buildSymbolLookup(nodes);
  const edges = pointers
    .flatMap(({ manifest, codemap, pointer }) => buildEdges(manifest, codemap, pointer, symbolLookup))
    .sort(compareEdges);

  return {
    scope_id: scopeId,
    kind: CODE_LANE_CONTEXT_MAP_KIND,
    authority: 'derived_orientation',
    lane_grants_authority: false,
    graph_walk: DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS,
    nodes,
    edges,
  };
}

export function expandCodeLaneGraph(
  snapshot: CodeLaneGraphSnapshot,
  rootSymbolId: string,
  controls: {
    requested?: boolean;
    direction?: CodeLaneGraphDirection;
    depth_limit?: number;
    fanout_cap?: number;
    max_nodes?: number;
  } = {},
): CodeLaneGraphExpansion {
  const requested = controls.requested === true;
  const direction = normalizeGraphDirection(controls.direction);
  const depthLimit = boundedPositiveInteger(controls.depth_limit, DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS.depth_limit);
  const fanoutCap = boundedPositiveInteger(controls.fanout_cap, DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS.fanout_cap);
  const maxNodes = boundedPositiveInteger(controls.max_nodes, DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS.max_nodes);
  const rootNode = snapshot.nodes.find((node) => node.symbol_id === rootSymbolId);

  if (!requested || !rootNode) {
    return {
      root_symbol_id: rootSymbolId,
      requested,
      direction,
      depth_limit: depthLimit,
      fanout_cap: fanoutCap,
      max_nodes: maxNodes,
      nodes: rootNode ? [rootNode] : [],
      edges: [],
      truncated: false,
      truncation_reason: null,
    };
  }

  const nodeById = new Map(snapshot.nodes.map((node) => [node.symbol_id, node]));
  const adjacency = buildAdjacency(snapshot.edges, direction);
  const visitedNodes = new Set<string>([rootSymbolId]);
  const selectedEdges: CodeLaneEdge[] = [];
  const queue: Array<{ symbol_id: string; depth: number }> = [{ symbol_id: rootSymbolId, depth: 0 }];
  let truncated = false;
  let truncationReason: CodeLaneGraphExpansion['truncation_reason'] = null;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depthLimit) {
      if ((adjacency.get(current.symbol_id) ?? []).length > 0 && !truncated) {
        truncated = true;
        truncationReason = 'depth_limit';
      }
      continue;
    }

    const outgoing = adjacency.get(current.symbol_id) ?? [];
    const boundedEdges = outgoing.slice(0, fanoutCap);
    if (outgoing.length > fanoutCap && !truncated) {
      truncated = true;
      truncationReason = 'fanout_cap';
    }

    for (const edge of boundedEdges) {
      if (selectedEdges.length >= fanoutCap) {
        if (!truncated) {
          truncated = true;
          truncationReason = 'fanout_cap';
        }
        break;
      }
      selectedEdges.push(edge);

      const nextId = edge.from_symbol_id === current.symbol_id ? edge.to_symbol_id : edge.from_symbol_id;
      if (visitedNodes.has(nextId) || !nodeById.has(nextId)) continue;
      if (visitedNodes.size >= maxNodes) {
        if (!truncated) {
          truncated = true;
          truncationReason = 'max_nodes';
        }
        continue;
      }
      visitedNodes.add(nextId);
      queue.push({ symbol_id: nextId, depth: current.depth + 1 });
    }
  }

  return {
    root_symbol_id: rootSymbolId,
    requested,
    direction,
    depth_limit: depthLimit,
    fanout_cap: fanoutCap,
    max_nodes: maxNodes,
    nodes: [...visitedNodes].map((symbolId) => nodeById.get(symbolId)).filter((node): node is CodeLaneNode => Boolean(node)),
    edges: selectedEdges,
    truncated,
    truncation_reason: truncationReason,
  };
}

export async function computeCodeLaneSourceSetHash(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<string> {
  return hashCodeLaneSourceSet(await listAllNoteManifestEntries(engine, scopeId));
}

export function hashCodeLaneSourceSet(manifests: NoteManifestEntry[]): string {
  const payload = {
    extractor_version: CODE_LANE_EXTRACTOR_VERSION,
    manifests: manifests
      .filter((manifest) => getCodemapEntries(manifest).length > 0)
      .map((manifest) => ({
        slug: manifest.slug,
        path: manifest.path,
        content_hash: manifest.content_hash,
        extractor_version: manifest.extractor_version,
        codemap: getCodemapEntries(manifest),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function collectCodemapPointers(manifests: NoteManifestEntry[]): Array<{
  manifest: NoteManifestEntry;
  codemap: CodemapEntry;
  pointer: CodemapPointer;
}> {
  return manifests.flatMap((manifest) =>
    getCodemapEntries(manifest).flatMap((codemap) =>
      getPointerEntries(codemap).map((pointer) => ({ manifest, codemap, pointer }))));
}

function buildNode(
  manifest: NoteManifestEntry,
  codemap: CodemapEntry,
  pointer: CodemapPointer,
): CodeLaneNode {
  const path = requiredString(pointer.path, 'codemap pointer path');
  const symbolName = requiredString(pointer.symbol ?? pointer.symbol_name, 'codemap pointer symbol');
  const repoPath = stringValue(pointer.repo_path)
    ?? stringValue(codemap.repo_path)
    ?? stringValue(manifest.frontmatter.repo_path)
    ?? stringValue(manifest.frontmatter.repo)
    ?? 'unknown';
  const sourceRef = stringValue(pointer.source_ref) ?? sourceRefFor(manifest);
  const contentHash = stringValue(pointer.content_hash) ?? 'missing';
  const symbolIdentity = stringValue(pointer.qualified_name) ?? symbolName;

  return withoutUndefined({
    source_ref: sourceRef,
    repo_path: repoPath,
    content_hash: contentHash,
    extractor_version: CODE_LANE_EXTRACTOR_VERSION,
    symbol_id: codeLaneSymbolId(codemapSystem(codemap, manifest), repoPath, path, symbolIdentity),
    path,
    symbol_name: symbolName,
    qualified_name: stringValue(pointer.qualified_name),
    parent_symbol_path: stringValue(pointer.parent_symbol_path),
    language: stringValue(pointer.language),
    chunk_id: stringValue(pointer.chunk_id),
    start_line: numberValue(pointer.start_line),
    end_line: numberValue(pointer.end_line),
    verification_hint: verificationHintFor(path, symbolName, contentHash, pointer),
    authority: 'derived_orientation' as const,
  });
}

function buildEdges(
  manifest: NoteManifestEntry,
  codemap: CodemapEntry,
  pointer: CodemapPointer,
  symbolLookup: Map<string, string[]>,
): CodeLaneEdge[] {
  const node = buildNode(manifest, codemap, pointer);
  const edges: CodeLaneEdge[] = [
    buildEdge(node, 'declares', node.symbol_id, 'resolved'),
  ];

  for (const edge of getPointerEdgeEntries(pointer)) {
    const target = targetSymbolReference(codemap, manifest, edge, symbolLookup);
    edges.push(buildEdge(
      node,
      normalizeEdgeKind(edge.kind ?? edge.edge_kind),
      target.symbolId,
      target.resolution,
    ));
  }

  return edges;
}

function buildEdge(
  node: CodeLaneNode,
  edgeKind: CodeLaneEdgeKind,
  toSymbolId: string,
  resolution: CodeLaneEdge['resolution'],
): CodeLaneEdge {
  return {
    source_ref: node.source_ref,
    repo_path: node.repo_path,
    content_hash: node.content_hash,
    extractor_version: CODE_LANE_EXTRACTOR_VERSION,
    edge_kind: edgeKind,
    from_symbol_id: node.symbol_id,
    to_symbol_id: toSymbolId,
    resolution,
    verification_hint: node.verification_hint,
    authority: 'derived_orientation',
  };
}

function targetSymbolReference(
  codemap: CodemapEntry,
  manifest: NoteManifestEntry,
  edge: CodemapPointerEdge,
  symbolLookup: Map<string, string[]>,
): { symbolId: string; resolution: CodeLaneEdge['resolution'] } {
  const explicitId = stringValue(edge.to_symbol_id);
  if (explicitId) return { symbolId: explicitId, resolution: 'resolved' };

  const targetSymbol = stringValue(edge.to_symbol);
  const system = codemapSystem(codemap, manifest);
  if (!targetSymbol) {
    return {
      symbolId: unresolvedCodeLaneSymbolId(system, 'missing-target'),
      resolution: 'unresolved',
    };
  }

  const targets = symbolLookup.get(symbolLookupKey(system, targetSymbol)) ?? [];
  if (targets.length === 1) return { symbolId: targets[0]!, resolution: 'resolved' };
  if (targets.length > 1) {
    return {
      symbolId: unresolvedCodeLaneSymbolId(system, `ambiguous:${targetSymbol}`),
      resolution: 'ambiguous',
    };
  }
  return {
    symbolId: unresolvedCodeLaneSymbolId(system, targetSymbol),
    resolution: 'unresolved',
  };
}

export function codeLaneSymbolId(
  system: string,
  repoPath: string,
  path: string,
  symbolIdentity: string,
): string {
  return [
    'code:symbol',
    normalizeSymbolComponent(system),
    normalizeSymbolComponent(repoPath),
    normalizeSymbolComponent(path),
  ].join(':') + `#${normalizeSymbolComponent(symbolIdentity)}`;
}

function unresolvedCodeLaneSymbolId(system: string, symbolName: string): string {
  return `code:symbol:${normalizeSymbolComponent(system)}:unresolved#${normalizeSymbolComponent(symbolName)}`;
}

function buildSymbolLookup(nodes: CodeLaneNode[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const node of nodes) {
    const system = node.symbol_id.split(':')[2] ?? '';
    addSymbolLookup(lookup, symbolLookupKey(system, node.symbol_name), node.symbol_id);
    if (node.qualified_name) {
      addSymbolLookup(lookup, symbolLookupKey(system, node.qualified_name), node.symbol_id);
    }
  }
  return lookup;
}

function addSymbolLookup(lookup: Map<string, string[]>, key: string, symbolId: string): void {
  lookup.set(key, [...new Set([...(lookup.get(key) ?? []), symbolId])].sort());
}

function symbolLookupKey(system: string, symbolName: string): string {
  return `${system}\0${normalizeSymbolComponent(symbolName)}`;
}

function normalizeSymbolComponent(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeEdgeKind(value: unknown): CodeLaneEdgeKind {
  switch (stringValue(value)) {
    case 'declares':
    case 'calls':
    case 'references':
    case 'imports':
    case 'contains':
      return stringValue(value) as CodeLaneEdgeKind;
    default:
      return 'references';
  }
}

function getCodemapEntries(manifest: NoteManifestEntry): CodemapEntry[] {
  return arrayOfObjects(manifest.frontmatter.codemap);
}

function getPointerEntries(codemap: CodemapEntry): CodemapPointer[] {
  return arrayOfObjects(codemap.pointers);
}

function getPointerEdgeEntries(pointer: CodemapPointer): CodemapPointerEdge[] {
  return arrayOfObjects(pointer.edges);
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item));
}

function sourceRefFor(manifest: NoteManifestEntry): string {
  return `page:${manifest.slug}`;
}

function codemapSystem(codemap: CodemapEntry, manifest: NoteManifestEntry): string {
  return stringValue(codemap.system) ?? manifest.slug;
}

function verificationHintFor(path: string, symbolName: string, contentHash: string, pointer: CodemapPointer): string {
  return stringValue(pointer.verification_hint)
    ?? `reverify_code_claims path=${path} symbol=${symbolName} expected_content_hash=${contentHash}`;
}

function buildAdjacency(
  edges: CodeLaneEdge[],
  direction: CodeLaneGraphDirection,
): Map<string, CodeLaneEdge[]> {
  const adjacency = new Map<string, CodeLaneEdge[]>();
  for (const edge of edges) {
    if (direction === 'out' || direction === 'both') {
      const fromEdges = adjacency.get(edge.from_symbol_id) ?? [];
      fromEdges.push(edge);
      adjacency.set(edge.from_symbol_id, fromEdges);
    }

    if ((direction === 'in' || direction === 'both') && edge.from_symbol_id !== edge.to_symbol_id) {
      const toEdges = adjacency.get(edge.to_symbol_id) ?? [];
      toEdges.push(edge);
      adjacency.set(edge.to_symbol_id, toEdges);
    }
  }

  for (const entry of adjacency.values()) {
    entry.sort(compareEdges);
  }
  return adjacency;
}

function normalizeGraphDirection(value: CodeLaneGraphDirection | undefined): CodeLaneGraphDirection {
  return value === 'out' || value === 'in' || value === 'both'
    ? value
    : DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS.direction;
}

function boundedPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function compareEdges(left: CodeLaneEdge, right: CodeLaneEdge): number {
  return left.from_symbol_id.localeCompare(right.from_symbol_id)
    || left.edge_kind.localeCompare(right.edge_kind)
    || left.to_symbol_id.localeCompare(right.to_symbol_id);
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
