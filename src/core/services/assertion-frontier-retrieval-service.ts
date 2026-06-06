import type {
  GraphFrontierEdge,
  GraphFrontierEdgeType,
  GraphFrontierInput,
  GraphFrontierNode,
  GraphFrontierOmissionReason,
  GraphFrontierPathTrace,
  GraphFrontierResult,
  GraphFrontierSelectorActivation,
  GraphFrontierSelectedSelector,
} from '../types/graph-frontier.ts';
import type { RetrievalSelector } from '../types/retrieval-routing.ts';

export type {
  GraphFrontierEdge,
  GraphFrontierEdgeType,
  GraphFrontierInput,
  GraphFrontierNode,
  GraphFrontierOmittedPath,
  GraphFrontierPathTrace,
  GraphFrontierResult,
  GraphFrontierSelectorActivation,
  GraphFrontierSelectedSelector,
} from '../types/graph-frontier.ts';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_FANOUT_CAP = 8;
const DEFAULT_ALLOWED_EDGE_TYPES: GraphFrontierEdgeType[] = [
  'supports',
  'contradicts',
  'supersedes',
  'requires_reverification',
];

interface QueueEntry {
  node_id: string;
  depth: number;
  node_ids: string[];
  edge_ids: string[];
  edge_types: GraphFrontierEdgeType[];
}

interface IncomingConstraint {
  edge_type: GraphFrontierEdgeType;
  activation: GraphFrontierSelectorActivation;
  historical: boolean;
}

export function planAssertionGraphFrontier(input: GraphFrontierInput): GraphFrontierResult {
  if (!input.enabled) return emptyResult();
  if (!input.scope_id) throw new Error('scope_id is required for graph frontier planning');

  const maxDepth = nonnegativeInteger(input.max_depth ?? DEFAULT_MAX_DEPTH, 'max_depth');
  const fanoutCap = nonnegativeInteger(input.fanout_cap ?? DEFAULT_FANOUT_CAP, 'fanout_cap');
  const allowedEdgeTypes = new Set(input.allowed_edge_types ?? DEFAULT_ALLOWED_EDGE_TYPES);
  const nodesById = new Map(input.nodes.map((entry) => [entry.id, entry]));
  const edgesByFrom = groupEdgesByFrom(input.edges);
  const incomingConstraints = buildIncomingConstraints(input, nodesById, allowedEdgeTypes);
  const result = emptyResult();
  const selectedByNode = new Map<string, GraphFrontierSelectedSelector>();
  const blockedExpansionNodes = new Set<string>();
  const queued = new Set(input.seed_node_ids);
  const queue: QueueEntry[] = input.seed_node_ids.map((nodeId) => ({
    node_id: nodeId,
    depth: 0,
    node_ids: [nodeId],
    edge_ids: [],
    edge_types: [],
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = nodesById.get(current.node_id);
    if (!currentNode) {
      omitNode(result, current.node_id, 'missing_node');
      continue;
    }
    if (currentNode.scope_id !== input.scope_id) {
      omitNode(result, current.node_id, 'scope_mismatch');
      continue;
    }
    if (currentNode.policy_version !== input.policy_version) {
      omitNode(result, current.node_id, 'policy_mismatch');
      continue;
    }
    if (currentNode.stale) {
      omitNode(result, current.node_id, 'stale_graph');
      result.warnings.push(`stale_graph_node:${currentNode.id}`);
      continue;
    }
    if (!currentNode.selector) {
      omitNode(result, current.node_id, 'missing_canonical_selector');
      continue;
    }
    if (currentNode.selector.scope_id && currentNode.selector.scope_id !== input.scope_id) {
      omitNode(result, current.node_id, 'scope_mismatch');
      continue;
    }
    if (!isCanonicalReadSelector(currentNode.selector)) {
      omitNode(result, current.node_id, 'non_canonical_selector');
      continue;
    }
    if (blockedExpansionNodes.has(current.node_id)) {
      omitNode(result, current.node_id, 'expansion_blocked');
      continue;
    }

    const outgoing = edgesByFrom.get(current.node_id) ?? [];

    if (current.depth >= maxDepth) {
      for (const edge of outgoing) {
        const edgeType = allowedEdgeType(edge.edge_type, allowedEdgeTypes);
        if (!edgeVisibleAtBoundary(input, nodesById, edge)) continue;
        if (!edgeType) {
          omit(result, edge, 'unsupported_edge_type');
          continue;
        }
        omit(result, edge, 'depth_cap');
      }
      continue;
    }

    let traversedFromNode = 0;
    for (const edge of outgoing) {
      const edgeType = allowedEdgeType(edge.edge_type, allowedEdgeTypes);
      if (!edgeType) {
        omit(result, edge, 'unsupported_edge_type');
        continue;
      }
      if (edge.scope_id !== input.scope_id) {
        omit(result, edge, 'scope_mismatch');
        continue;
      }
      if (edge.policy_version !== input.policy_version) {
        omit(result, edge, 'policy_mismatch');
        continue;
      }
      if (edge.stale) {
        omit(result, edge, 'stale_graph');
        result.warnings.push(`stale_graph_edge:${edge.id}`);
        continue;
      }
      if (traversedFromNode >= fanoutCap) {
        omit(result, edge, 'fanout_cap');
        continue;
      }

      const targetNode = nodesById.get(edge.to_node_id);
      if (!targetNode) {
        omit(result, edge, 'missing_node');
        continue;
      }
      if (targetNode.scope_id !== input.scope_id) {
        omit(result, edge, 'scope_mismatch');
        continue;
      }
      if (targetNode.policy_version !== input.policy_version) {
        omit(result, edge, 'policy_mismatch');
        continue;
      }
      if (targetNode.stale) {
        omit(result, edge, 'stale_graph');
        result.warnings.push(`stale_graph_node:${targetNode.id}`);
        continue;
      }

      traversedFromNode += 1;
      const nextPath = {
        node_id: targetNode.id,
        depth: current.depth + 1,
        node_ids: [...current.node_ids, targetNode.id],
        edge_ids: [...current.edge_ids, edge.id],
        edge_types: [...current.edge_types, edgeType],
      };
      const activation = activationForEdge(edgeType);
      const incomingConstraint = incomingConstraints.get(targetNode.id);
      const effectiveActivation = incomingConstraint?.activation ?? activation;
      if (effectiveActivation !== 'canonical_read' || incomingConstraint?.historical) {
        blockedExpansionNodes.add(targetNode.id);
      }
      result.paths_considered.push(pathTrace(nextPath, activation));

      const selected = selectedSelector(
        targetNode,
        edge,
        effectiveActivation,
        input.scope_id,
        incomingConstraint,
      );
      if (selected.ok) {
        const existing = selectedByNode.get(targetNode.id);
        if (!existing || conservativeActivationRank(selected.value.activation) > conservativeActivationRank(existing.activation)) {
          selectedByNode.set(targetNode.id, selected.value);
        }
      } else {
        blockedExpansionNodes.add(targetNode.id);
        omit(result, edge, selected.reason);
      }

      if (selected.ok && selected.value.activation === 'canonical_read' && !queued.has(targetNode.id)) {
        queued.add(targetNode.id);
        queue.push(nextPath);
      }
    }
  }

  result.selected_selectors = [...selectedByNode.values()].sort(compareSelectedSelectors);
  result.paths_considered.sort((left, right) => left.path_id.localeCompare(right.path_id));
  return result;
}

function emptyResult(): GraphFrontierResult {
  return {
    selected_selectors: [],
    paths_considered: [],
    omitted_paths: [],
    authority_violations: [],
    warnings: [],
  };
}

function groupEdgesByFrom(edges: GraphFrontierEdge[]): Map<string, GraphFrontierEdge[]> {
  const result = new Map<string, GraphFrontierEdge[]>();
  for (const edge of edges) {
    const bucket = result.get(edge.from_node_id) ?? [];
    bucket.push(edge);
    result.set(edge.from_node_id, bucket);
  }
  for (const bucket of result.values()) {
    bucket.sort((left, right) => left.id.localeCompare(right.id));
  }
  return result;
}

function buildIncomingConstraints(
  input: GraphFrontierInput,
  nodesById: Map<string, GraphFrontierNode>,
  allowedEdgeTypes: Set<GraphFrontierEdgeType>,
): Map<string, IncomingConstraint> {
  const result = new Map<string, IncomingConstraint>();
  for (const edge of input.edges) {
    const edgeType = allowedEdgeType(edge.edge_type, allowedEdgeTypes);
    if (!edgeType || edgeType === 'supports') continue;
    if (edge.scope_id !== input.scope_id || edge.policy_version !== input.policy_version || edge.stale) continue;

    const fromNode = nodesById.get(edge.from_node_id);
    const targetNode = nodesById.get(edge.to_node_id);
    if (!fromNode || !targetNode) continue;
    if (fromNode.scope_id !== input.scope_id || targetNode.scope_id !== input.scope_id) continue;
    if (fromNode.policy_version !== input.policy_version || targetNode.policy_version !== input.policy_version) continue;
    if (fromNode.stale || targetNode.stale) continue;

    const next: IncomingConstraint = {
      edge_type: edgeType,
      activation: activationForEdge(edgeType),
      historical: edgeType === 'supersedes',
    };
    const existing = result.get(edge.to_node_id);
    if (!existing || constraintRank(next) > constraintRank(existing)) {
      result.set(edge.to_node_id, next);
    }
  }
  return result;
}

function edgeVisibleAtBoundary(
  input: GraphFrontierInput,
  nodesById: Map<string, GraphFrontierNode>,
  edge: GraphFrontierEdge,
): boolean {
  if (edge.scope_id !== input.scope_id || edge.policy_version !== input.policy_version) return false;
  if (edge.stale) return false;

  const targetNode = nodesById.get(edge.to_node_id);
  if (!targetNode) return true;
  return targetNode.scope_id === input.scope_id
    && targetNode.policy_version === input.policy_version
    && targetNode.stale !== true;
}

function allowedEdgeType(
  edgeType: string,
  allowedEdgeTypes: Set<GraphFrontierEdgeType>,
): GraphFrontierEdgeType | null {
  if (!isGraphFrontierEdgeType(edgeType)) return null;
  return allowedEdgeTypes.has(edgeType) ? edgeType : null;
}

function isGraphFrontierEdgeType(edgeType: string): edgeType is GraphFrontierEdgeType {
  return DEFAULT_ALLOWED_EDGE_TYPES.includes(edgeType as GraphFrontierEdgeType);
}

function activationForEdge(edgeType: GraphFrontierEdgeType): GraphFrontierSelectorActivation {
  if (edgeType === 'requires_reverification') return 'verify_first';
  if (edgeType === 'contradicts' || edgeType === 'supersedes') return 'review_only';
  return 'canonical_read';
}

function selectedSelector(
  node: GraphFrontierNode,
  edge: GraphFrontierEdge,
  activation: GraphFrontierSelectorActivation,
  scopeId: string,
  incomingConstraint?: IncomingConstraint,
): { ok: true; value: GraphFrontierSelectedSelector } | { ok: false; reason: GraphFrontierOmissionReason } {
  if (!node.selector) return { ok: false, reason: 'missing_canonical_selector' };
  if (node.selector.scope_id && node.selector.scope_id !== scopeId) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  if (incomingConstraint?.historical || edge.edge_type === 'supersedes') {
    return { ok: false, reason: 'historical_selector' };
  }
  if (!isCanonicalReadSelector(node.selector)) return { ok: false, reason: 'non_canonical_selector' };
  return {
    ok: true,
    value: {
      node_id: node.id,
      selector: node.selector,
      activation,
      reason_codes: reasonCodes(incomingConstraint?.edge_type ?? edge.edge_type, activation),
    },
  };
}

function isCanonicalReadSelector(selector: RetrievalSelector): boolean {
  return selector.kind === 'page'
    || selector.kind === 'compiled_truth'
    || selector.kind === 'section'
    || selector.kind === 'line_span'
    || selector.kind === 'timeline_range';
}

function reasonCodes(edgeType: string, activation: GraphFrontierSelectorActivation): string[] {
  const reasons = [`edge:${edgeType}`];
  if (activation === 'verify_first') reasons.push('fresh_canonical_read_required');
  if (activation === 'review_only') reasons.push('contradiction_requires_review');
  return reasons;
}

function pathTrace(entry: QueueEntry, activation: GraphFrontierSelectorActivation): GraphFrontierPathTrace {
  return {
    path_id: `path:${entry.edge_ids.join('>')}`,
    start_node_id: entry.node_ids[0]!,
    end_node_id: entry.node_id,
    node_ids: entry.node_ids,
    edge_ids: entry.edge_ids,
    edge_types: entry.edge_types,
    activation,
    authority: 'selector_planning_only',
  };
}

function omit(
  result: GraphFrontierResult,
  edge: GraphFrontierEdge,
  reason: GraphFrontierOmissionReason,
): void {
  result.omitted_paths.push({
    edge_id: edge.id,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    reason,
    edge_type: edge.edge_type,
  });
}

function omitNode(
  result: GraphFrontierResult,
  nodeId: string,
  reason: GraphFrontierOmissionReason,
): void {
  result.omitted_paths.push({
    node_id: nodeId,
    reason,
  });
}

function compareSelectedSelectors(
  left: GraphFrontierSelectedSelector,
  right: GraphFrontierSelectedSelector,
): number {
  const activationDelta = activationRank(left.activation) - activationRank(right.activation);
  if (activationDelta !== 0) return activationDelta;
  return left.node_id.localeCompare(right.node_id);
}

function activationRank(activation: GraphFrontierSelectorActivation): number {
  if (activation === 'canonical_read') return 0;
  if (activation === 'review_only') return 1;
  return 2;
}

function conservativeActivationRank(activation: GraphFrontierSelectorActivation): number {
  if (activation === 'canonical_read') return 0;
  if (activation === 'verify_first') return 1;
  return 2;
}

function constraintRank(constraint: IncomingConstraint): number {
  if (constraint.historical) return 3;
  return conservativeActivationRank(constraint.activation);
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}
