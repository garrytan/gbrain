import {
  planAssertionGraphFrontier,
  type GraphFrontierEdge,
  type GraphFrontierEdgeType,
  type GraphFrontierInput,
  type GraphFrontierNode,
  type GraphFrontierResult,
  type GraphFrontierSelectedSelector,
} from '../services/assertion-frontier-retrieval-service.ts';
import type { GraphFrontierOmissionReason } from '../types/graph-frontier.ts';
import type { RetrievalSelector } from '../types/retrieval-routing.ts';

export type GraphFrontierEvaluationCaseFamily =
  | 'recall_bridge'
  | 'false_bridge_distractor'
  | 'scope_boundary'
  | 'contradiction'
  | 'supersession'
  | 'requires_reverification'
  | 'stale_graph'
  | 'graph_only_no_canonical';

export interface GraphFrontierEvaluationInstrumentation {
  latency_ms: number;
  estimated_tokens: number;
}

export interface GraphFrontierEvaluationCase {
  id: string;
  family: GraphFrontierEvaluationCaseFamily;
  query?: string;
  scope_id: string;
  policy_version: string;
  seed_node_ids: string[];
  graph_off_selectors: RetrievalSelector[];
  gold_selectors: RetrievalSelector[];
  allowed_selectors?: RetrievalSelector[];
  forbidden_selectors?: RetrievalSelector[];
  frontier: {
    nodes: GraphFrontierNode[];
    edges: GraphFrontierEdge[];
    max_depth?: number;
    fanout_cap?: number;
    allowed_edge_types?: GraphFrontierEdgeType[];
  };
  instrumentation: {
    graph_off: GraphFrontierEvaluationInstrumentation;
    graph_on: GraphFrontierEvaluationInstrumentation;
  };
  answer_evidence_refs?: string[];
}

export interface GraphFrontierEvaluationFixture {
  id: string;
  description?: string;
  cases: GraphFrontierEvaluationCase[];
}

export interface GraphFrontierEvaluationDependencies {
  planner?: (input: GraphFrontierInput) => GraphFrontierResult;
}

export interface GraphFrontierEvaluationRunSummary {
  selectors: RetrievalSelector[];
  selector_keys: string[];
  recall: number;
  precision: number;
  latency_ms: number;
  estimated_tokens: number;
  time_to_first_gold: number;
}

export interface GraphFrontierEvaluationSafetyCounts {
  graph_as_answer_evidence_count: number;
  scope_leak_count: number;
  stale_graph_leakage_count: number;
  unsupported_edge_traversal_count: number;
}

export interface GraphFrontierEvaluationCaseResult {
  id: string;
  family: GraphFrontierEvaluationCaseFamily;
  status: 'passed' | 'failed';
  graph_off: GraphFrontierEvaluationRunSummary;
  graph_on: GraphFrontierEvaluationRunSummary;
  graph_added_selector_keys: string[];
  graph_added_gold_selector_keys: string[];
  graph_added_edge_types: Record<string, string>;
  false_bridge_selector_keys: string[];
  omitted_reasons: GraphFrontierOmissionReason[];
  graph_path_activations: string[];
  safety: GraphFrontierEvaluationSafetyCounts;
  deltas: {
    recall_delta: number;
    precision_delta: number;
    latency_ms_delta: number;
    estimated_token_delta: number;
    time_to_first_gold_delta: number;
  };
}

export interface GraphFrontierEvaluationAggregate {
  recall_off: number;
  recall_on: number;
  precision_off: number;
  precision_on: number;
  false_bridge_rate: number;
  p95_latency_delta_ms: number;
  p95_token_delta: number;
  p95_time_to_first_gold_delta: number;
  graph_as_answer_evidence_count: number;
  scope_leak_count: number;
  stale_graph_leakage_count: number;
  unsupported_edge_traversal_count: number;
  edge_type_contribution: Record<string, {
    added_gold: number;
    false_bridges: number;
  }>;
}

export interface GraphFrontierEvaluationResult {
  fixture_id: string;
  status: 'passed' | 'failed';
  cases: GraphFrontierEvaluationCaseResult[];
  aggregate: GraphFrontierEvaluationAggregate;
}

const SUPPORTED_EDGE_TYPES: GraphFrontierEdgeType[] = [
  'supports',
  'contradicts',
  'supersedes',
  'requires_reverification',
];

export function runGraphFrontierEvaluationFixture(
  fixture: GraphFrontierEvaluationFixture,
  deps: GraphFrontierEvaluationDependencies = {},
): GraphFrontierEvaluationResult {
  const caseRuns = fixture.cases.map((testCase) => runEvaluationCase(testCase, deps));
  const aggregate = aggregateResults(caseRuns);
  return {
    fixture_id: fixture.id,
    status: caseRuns.every((result) => result.status === 'passed') && aggregatePassed(aggregate)
      ? 'passed'
      : 'failed',
    cases: caseRuns,
    aggregate,
  };
}

export function selectorKey(selector: RetrievalSelector): string {
  const scope = selector.scope_id ?? 'global';
  if (selector.selector_id) return `${selector.kind}:${scope}:${selector.selector_id}`;
  if (selector.slug) {
    const section = selector.section_id ? `#${selector.section_id}` : '';
    return `${selector.kind}:${scope}:${selector.slug}${section}`;
  }
  if (selector.path) return `${selector.kind}:${scope}:${selector.path}`;
  if (selector.object_id) return `${selector.kind}:${scope}:${selector.object_id}`;
  if (selector.source_ref) return `${selector.kind}:${scope}:${selector.source_ref}`;
  return `${selector.kind}:${scope}:${JSON.stringify(selector)}`;
}

function runEvaluationCase(
  testCase: GraphFrontierEvaluationCase,
  deps: GraphFrontierEvaluationDependencies,
): GraphFrontierEvaluationCaseResult {
  const graphResult = (deps.planner ?? planAssertionGraphFrontier)(frontierInput(testCase));
  const graphSelections = graphResult.selected_selectors.filter((entry) => entry.activation === 'canonical_read');
  const graphOnSelectors = dedupeSelectors([
    ...testCase.graph_off_selectors,
    ...graphSelections.map((entry) => entry.selector),
  ]);
  const offKeys = new Set(testCase.graph_off_selectors.map(selectorKey));
  const graphAdded = graphSelections
    .map((entry) => ({ entry, key: selectorKey(entry.selector) }))
    .filter(({ key }) => !offKeys.has(key));
  const goldKeys = new Set(testCase.gold_selectors.map(selectorKey));
  const allowedKeys = new Set([
    ...testCase.gold_selectors.map(selectorKey),
    ...(testCase.allowed_selectors ?? []).map(selectorKey),
  ]);
  const forbiddenKeys = new Set((testCase.forbidden_selectors ?? []).map(selectorKey));
  const falseBridges = graphAdded.filter(({ key }) => isFalseBridge(key, goldKeys, allowedKeys, forbiddenKeys));
  const graphAddedGold = graphAdded.filter(({ key }) => goldKeys.has(key));
  const safety = safetyCounts(testCase, graphResult, graphAdded);
  const graphOff = runSummary(
    testCase.graph_off_selectors,
    testCase.gold_selectors,
    testCase.allowed_selectors ?? [],
    testCase.instrumentation.graph_off,
  );
  const graphOn = runSummary(
    graphOnSelectors,
    testCase.gold_selectors,
    testCase.allowed_selectors ?? [],
    testCase.instrumentation.graph_on,
  );
  const result: GraphFrontierEvaluationCaseResult = {
    id: testCase.id,
    family: testCase.family,
    status: 'passed',
    graph_off: graphOff,
    graph_on: graphOn,
    graph_added_selector_keys: graphAdded.map(({ key }) => key),
    graph_added_gold_selector_keys: graphAddedGold.map(({ key }) => key),
    graph_added_edge_types: Object.fromEntries(
      graphAdded.map(({ entry, key }) => [key, edgeTypeForSelection(entry)]),
    ),
    false_bridge_selector_keys: falseBridges.map(({ key }) => key),
    omitted_reasons: graphResult.omitted_paths.map((path) => path.reason),
    graph_path_activations: graphResult.paths_considered.map((path) => path.activation),
    safety,
    deltas: {
      recall_delta: graphOn.recall - graphOff.recall,
      precision_delta: graphOn.precision - graphOff.precision,
      latency_ms_delta: testCase.instrumentation.graph_on.latency_ms - testCase.instrumentation.graph_off.latency_ms,
      estimated_token_delta: testCase.instrumentation.graph_on.estimated_tokens - testCase.instrumentation.graph_off.estimated_tokens,
      time_to_first_gold_delta: graphOn.time_to_first_gold - graphOff.time_to_first_gold,
    },
  };
  return {
    ...result,
    status: casePassed(testCase.family, result) ? 'passed' : 'failed',
  };
}

function frontierInput(testCase: GraphFrontierEvaluationCase): GraphFrontierInput {
  return {
    enabled: true,
    scope_id: testCase.scope_id,
    policy_version: testCase.policy_version,
    seed_node_ids: testCase.seed_node_ids,
    nodes: testCase.frontier.nodes,
    edges: testCase.frontier.edges,
    max_depth: testCase.frontier.max_depth,
    fanout_cap: testCase.frontier.fanout_cap,
    allowed_edge_types: testCase.frontier.allowed_edge_types,
  };
}

function runSummary(
  selectors: RetrievalSelector[],
  goldSelectors: RetrievalSelector[],
  allowedSelectors: RetrievalSelector[],
  instrumentation: GraphFrontierEvaluationInstrumentation,
): GraphFrontierEvaluationRunSummary {
  const deduped = dedupeSelectors(selectors);
  return {
    selectors: deduped,
    selector_keys: deduped.map(selectorKey),
    recall: recall(deduped, goldSelectors),
    precision: precision(deduped, goldSelectors, allowedSelectors),
    latency_ms: instrumentation.latency_ms,
    estimated_tokens: instrumentation.estimated_tokens,
    time_to_first_gold: timeToFirstGold(deduped, goldSelectors),
  };
}

function dedupeSelectors(selectors: RetrievalSelector[]): RetrievalSelector[] {
  const seen = new Set<string>();
  const result: RetrievalSelector[] = [];
  for (const selector of selectors) {
    const key = selectorKey(selector);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selector);
  }
  return result;
}

function recall(selectors: RetrievalSelector[], goldSelectors: RetrievalSelector[]): number {
  if (goldSelectors.length === 0) return 1;
  const selectedKeys = new Set(selectors.map(selectorKey));
  const found = goldSelectors.filter((selector) => selectedKeys.has(selectorKey(selector))).length;
  return found / goldSelectors.length;
}

function precision(
  selectors: RetrievalSelector[],
  goldSelectors: RetrievalSelector[],
  allowedSelectors: RetrievalSelector[],
): number {
  if (selectors.length === 0) return 1;
  const relevantKeys = new Set([
    ...goldSelectors.map(selectorKey),
    ...allowedSelectors.map(selectorKey),
  ]);
  const relevant = selectors.filter((selector) => relevantKeys.has(selectorKey(selector))).length;
  return relevant / selectors.length;
}

function timeToFirstGold(selectors: RetrievalSelector[], goldSelectors: RetrievalSelector[]): number {
  if (goldSelectors.length === 0) return 0;
  const goldKeys = new Set(goldSelectors.map(selectorKey));
  const foundIndex = selectors.findIndex((selector) => goldKeys.has(selectorKey(selector)));
  return foundIndex >= 0 ? foundIndex + 1 : selectors.length + 1;
}

function isFalseBridge(
  key: string,
  goldKeys: Set<string>,
  allowedKeys: Set<string>,
  forbiddenKeys: Set<string>,
): boolean {
  return forbiddenKeys.has(key) || (!goldKeys.has(key) && !allowedKeys.has(key));
}

function safetyCounts(
  testCase: GraphFrontierEvaluationCase,
  graphResult: GraphFrontierResult,
  graphAdded: Array<{ entry: GraphFrontierSelectedSelector; key: string }>,
): GraphFrontierEvaluationSafetyCounts {
  const nodesById = new Map(testCase.frontier.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(testCase.frontier.edges.map((edge) => [edge.id, edge]));
  const addedNodeIds = new Set(graphAdded.map(({ entry }) => entry.node_id));
  const scopeLeakNodeIds = new Set(
    graphAdded
      .filter(({ entry }) => selectorScopeMismatch(entry.selector, testCase.scope_id))
      .map(({ entry }) => entry.node_id),
  );
  const staleLeakPathIds = new Set<string>();
  const unsupportedTraversalPathIds = new Set<string>();
  for (const path of graphResult.paths_considered) {
    if (!addedNodeIds.has(path.end_node_id)) continue;
    if (
      path.node_ids.some((nodeId) => nodesById.get(nodeId)?.scope_id !== testCase.scope_id)
      || path.edge_ids.some((edgeId) => edgesById.get(edgeId)?.scope_id !== testCase.scope_id)
    ) {
      scopeLeakNodeIds.add(path.end_node_id);
    }
    if (
      path.node_ids.some((nodeId) => nodesById.get(nodeId)?.stale === true)
      || path.edge_ids.some((edgeId) => edgesById.get(edgeId)?.stale === true)
    ) {
      staleLeakPathIds.add(path.path_id);
    }
    if (
      path.edge_types.some((edgeType) => !SUPPORTED_EDGE_TYPES.includes(edgeType))
      || path.edge_ids.some((edgeId) => {
        const edgeType = edgesById.get(edgeId)?.edge_type;
        return typeof edgeType === 'string' && !SUPPORTED_EDGE_TYPES.includes(edgeType as GraphFrontierEdgeType);
      })
    ) {
      unsupportedTraversalPathIds.add(path.path_id);
    }
  }
  return {
    graph_as_answer_evidence_count: (testCase.answer_evidence_refs ?? []).filter(isGraphAnswerEvidenceRef).length,
    scope_leak_count: scopeLeakNodeIds.size,
    stale_graph_leakage_count: staleLeakPathIds.size,
    unsupported_edge_traversal_count: unsupportedTraversalPathIds.size,
  };
}

function selectorScopeMismatch(selector: RetrievalSelector, expectedScope: string): boolean {
  return Boolean(selector.scope_id && selector.scope_id !== expectedScope);
}

function isGraphAnswerEvidenceRef(ref: string): boolean {
  return ref.startsWith('graph_path:')
    || ref.startsWith('graph-path:')
    || ref.startsWith('graph_frontier_path:')
    || ref.includes('authority=selector_planning_only');
}

function casePassed(
  family: GraphFrontierEvaluationCaseFamily,
  result: GraphFrontierEvaluationCaseResult,
): boolean {
  const safetyPassed = result.false_bridge_selector_keys.length === 0
    && result.safety.graph_as_answer_evidence_count === 0
    && result.safety.scope_leak_count === 0
    && result.safety.stale_graph_leakage_count === 0
    && result.safety.unsupported_edge_traversal_count === 0;
  if (!safetyPassed) return false;
  if (family === 'recall_bridge') {
    return result.deltas.recall_delta > 0 || result.deltas.time_to_first_gold_delta < 0;
  }
  if (family === 'false_bridge_distractor') {
    return result.deltas.precision_delta >= 0;
  }
  return true;
}

function aggregateResults(results: GraphFrontierEvaluationCaseResult[]): GraphFrontierEvaluationAggregate {
  const graphAddedCount = results.reduce((sum, result) => sum + result.graph_added_selector_keys.length, 0);
  const falseBridgeCount = results.reduce((sum, result) => sum + result.false_bridge_selector_keys.length, 0);
  return {
    recall_off: average(results.map((result) => result.graph_off.recall)),
    recall_on: average(results.map((result) => result.graph_on.recall)),
    precision_off: average(results.map((result) => result.graph_off.precision)),
    precision_on: average(results.map((result) => result.graph_on.precision)),
    false_bridge_rate: falseBridgeCount / Math.max(graphAddedCount, 1),
    p95_latency_delta_ms: p95(results.map((result) => result.deltas.latency_ms_delta)),
    p95_token_delta: p95(results.map((result) => result.deltas.estimated_token_delta)),
    p95_time_to_first_gold_delta: p95(results.map((result) => result.deltas.time_to_first_gold_delta)),
    graph_as_answer_evidence_count: sumSafety(results, 'graph_as_answer_evidence_count'),
    scope_leak_count: sumSafety(results, 'scope_leak_count'),
    stale_graph_leakage_count: sumSafety(results, 'stale_graph_leakage_count'),
    unsupported_edge_traversal_count: sumSafety(results, 'unsupported_edge_traversal_count'),
    edge_type_contribution: edgeTypeContribution(results),
  };
}

function aggregatePassed(aggregate: GraphFrontierEvaluationAggregate): boolean {
  return aggregate.recall_on >= aggregate.recall_off
    && aggregate.precision_on >= aggregate.precision_off
    && aggregate.false_bridge_rate === 0
    && aggregate.graph_as_answer_evidence_count === 0
    && aggregate.scope_leak_count === 0
    && aggregate.stale_graph_leakage_count === 0
    && aggregate.unsupported_edge_traversal_count === 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function sumSafety(
  results: GraphFrontierEvaluationCaseResult[],
  key: keyof GraphFrontierEvaluationSafetyCounts,
): number {
  return results.reduce((sum, result) => sum + result.safety[key], 0);
}

function edgeTypeContribution(
  results: GraphFrontierEvaluationCaseResult[],
): GraphFrontierEvaluationAggregate['edge_type_contribution'] {
  const contribution: GraphFrontierEvaluationAggregate['edge_type_contribution'] = {};
  for (const result of results) {
    for (const key of result.graph_added_selector_keys) {
      const edgeType = result.graph_added_edge_types[key] ?? 'unknown';
      const bucket = contribution[edgeType] ?? { added_gold: 0, false_bridges: 0 };
      if (result.graph_added_gold_selector_keys.includes(key)) bucket.added_gold += 1;
      if (result.false_bridge_selector_keys.includes(key)) bucket.false_bridges += 1;
      contribution[edgeType] = bucket;
    }
  }
  return contribution;
}

function edgeTypeForSelection(selection: GraphFrontierSelectedSelector): string {
  return selection.reason_codes.find((reason) => reason.startsWith('edge:'))?.slice('edge:'.length) ?? 'unknown';
}
