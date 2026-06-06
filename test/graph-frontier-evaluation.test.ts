import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import {
  runGraphFrontierEvaluationFixture,
  selectorKey,
  type GraphFrontierEvaluationCase,
  type GraphFrontierEvaluationFixture,
} from '../src/core/evaluation/graph-frontier-evaluation.ts';
import type { GraphFrontierResult } from '../src/core/services/assertion-frontier-retrieval-service.ts';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/authority-first/phase7-graph-frontier-eval.fixture.json', import.meta.url),
  'utf8',
)) as GraphFrontierEvaluationFixture;

describe('graph frontier evaluation fixture runner', () => {
  test('runs graph-off and graph-on against the deterministic fixture', () => {
    const result = runGraphFrontierEvaluationFixture(fixture);

    expect(result.fixture_id).toBe('phase7-graph-frontier-eval');
    expect(result.status).toBe('passed');
    expect(result.cases.map((entry) => entry.family)).toEqual([
      'recall_bridge',
      'false_bridge_distractor',
      'scope_boundary',
      'contradiction',
      'supersession',
      'requires_reverification',
      'stale_graph',
      'graph_only_no_canonical',
    ]);
    expect(result.aggregate).toMatchObject({
      recall_off: 0.75,
      recall_on: 0.875,
      precision_off: 1,
      precision_on: 1,
      false_bridge_rate: 0,
      p95_latency_delta_ms: 2,
      p95_token_delta: 15,
      graph_as_answer_evidence_count: 0,
      scope_leak_count: 0,
      stale_graph_leakage_count: 0,
      unsupported_edge_traversal_count: 0,
    });
    expect(result.aggregate.edge_type_contribution.supports).toEqual({
      added_gold: 1,
      false_bridges: 0,
    });
  });

  test('graph-on improves recall on the recall bridge without using graph paths as evidence', () => {
    const result = runGraphFrontierEvaluationFixture(fixture);
    const recallBridge = caseResult(result, 'recall_bridge');
    const goldKey = selectorKey({
      kind: 'page',
      scope_id: 'workspace:default',
      slug: 'concepts/recall-target',
      freshness: 'current',
    });

    expect(recallBridge.graph_off.recall).toBe(0);
    expect(recallBridge.graph_on.recall).toBe(1);
    expect(recallBridge.deltas.recall_delta).toBe(1);
    expect(recallBridge.graph_added_gold_selector_keys).toEqual([goldKey]);
    expect(recallBridge.graph_added_selector_keys).toEqual([goldKey]);
    expect(recallBridge.safety.graph_as_answer_evidence_count).toBe(0);
  });

  test('authority boundary cases are warning or review paths, not required reads', () => {
    const result = runGraphFrontierEvaluationFixture(fixture);

    expect(caseResult(result, 'false_bridge_distractor').omitted_reasons).toContain('unsupported_edge_type');
    expect(caseResult(result, 'scope_boundary').omitted_reasons).toContain('scope_mismatch');
    expect(caseResult(result, 'stale_graph').omitted_reasons).toContain('stale_graph');
    expect(caseResult(result, 'supersession').omitted_reasons).toContain('historical_selector');
    expect(caseResult(result, 'graph_only_no_canonical').omitted_reasons).toContain('missing_canonical_selector');

    const contradiction = caseResult(result, 'contradiction');
    expect(contradiction.graph_path_activations).toEqual(['review_only']);
    expect(contradiction.graph_added_selector_keys).toEqual([]);

    const reverify = caseResult(result, 'requires_reverification');
    expect(reverify.graph_path_activations).toEqual(['verify_first']);
    expect(reverify.graph_added_selector_keys).toEqual([]);
  });

  test('false bridge metric catches a tempting but forbidden support edge', () => {
    const badFixture = cloneFixture(fixture);
    const badCase = findCase(badFixture, 'false_bridge_distractor');
    badCase.frontier.edges[0]!.edge_type = 'supports';

    const result = runGraphFrontierEvaluationFixture(badFixture);
    const distractor = caseResult(result, 'false_bridge_distractor');

    expect(result.status).toBe('failed');
    expect(distractor.status).toBe('failed');
    expect(distractor.false_bridge_selector_keys).toEqual([
      selectorKey({
        kind: 'page',
        scope_id: 'workspace:default',
        slug: 'concepts/unrelated-distractor',
        freshness: 'current',
      }),
    ]);
    expect(result.aggregate.false_bridge_rate).toBe(0.5);
    expect(result.aggregate.edge_type_contribution.supports).toEqual({
      added_gold: 1,
      false_bridges: 1,
    });
  });

  test('graph path answer evidence is counted as an authority violation', () => {
    const badFixture = cloneFixture(fixture);
    const badCase = findCase(badFixture, 'recall_bridge');
    badCase.answer_evidence_refs = [
      'graph_frontier_path:1 activation=canonical_read authority=selector_planning_only',
    ];

    const result = runGraphFrontierEvaluationFixture(badFixture);
    const recallBridge = caseResult(result, 'recall_bridge');

    expect(result.status).toBe('failed');
    expect(recallBridge.status).toBe('failed');
    expect(result.aggregate.graph_as_answer_evidence_count).toBe(1);
    expect(recallBridge.safety.graph_as_answer_evidence_count).toBe(1);
  });

  test('leakage counters catch selected graph paths from unsafe planner output', () => {
    const scopeResult = runGraphFrontierEvaluationFixture(oneCaseFixture(fixture, 'scope_boundary'), {
      planner: () => badGraphResult({
        nodeId: 'assertion:personal-target',
        slug: 'people/private-target',
        scopeId: 'personal:default',
        edgeId: 'edge:scope-personal',
        startNodeId: 'assertion:scope-seed',
      }),
    });
    const staleResult = runGraphFrontierEvaluationFixture(oneCaseFixture(fixture, 'stale_graph'), {
      planner: () => badGraphResult({
        nodeId: 'assertion:stale-target',
        slug: 'concepts/stale-target',
        scopeId: 'workspace:default',
        edgeId: 'edge:stale-target',
        startNodeId: 'assertion:stale-seed',
      }),
    });
    const unsupportedResult = runGraphFrontierEvaluationFixture(oneCaseFixture(fixture, 'false_bridge_distractor'), {
      planner: () => badGraphResult({
        nodeId: 'assertion:unrelated-distractor',
        slug: 'concepts/unrelated-distractor',
        scopeId: 'workspace:default',
        edgeId: 'edge:distractor-unsupported',
        startNodeId: 'assertion:distractor-seed',
      }),
    });

    expect(scopeResult.status).toBe('failed');
    expect(scopeResult.aggregate.scope_leak_count).toBe(1);
    expect(staleResult.status).toBe('failed');
    expect(staleResult.aggregate.stale_graph_leakage_count).toBe(1);
    expect(unsupportedResult.status).toBe('failed');
    expect(unsupportedResult.aggregate.unsupported_edge_traversal_count).toBe(1);
  });
});

function cloneFixture(source: GraphFrontierEvaluationFixture): GraphFrontierEvaluationFixture {
  return JSON.parse(JSON.stringify(source)) as GraphFrontierEvaluationFixture;
}

function findCase(
  source: GraphFrontierEvaluationFixture,
  id: GraphFrontierEvaluationCase['id'],
): GraphFrontierEvaluationCase {
  const found = source.cases.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing fixture case: ${id}`);
  return found;
}

function oneCaseFixture(
  source: GraphFrontierEvaluationFixture,
  id: GraphFrontierEvaluationCase['id'],
): GraphFrontierEvaluationFixture {
  const cloned = cloneFixture(source);
  return {
    ...cloned,
    cases: [findCase(cloned, id)],
  };
}

function badGraphResult(input: {
  nodeId: string;
  slug: string;
  scopeId: string;
  edgeId: string;
  startNodeId: string;
}): GraphFrontierResult {
  return {
    selected_selectors: [{
      node_id: input.nodeId,
      selector: {
        kind: 'page',
        scope_id: input.scopeId,
        slug: input.slug,
        freshness: 'current',
      },
      activation: 'canonical_read',
      reason_codes: ['edge:supports'],
    }],
    paths_considered: [{
      path_id: `path:${input.edgeId}`,
      start_node_id: input.startNodeId,
      end_node_id: input.nodeId,
      node_ids: [input.startNodeId, input.nodeId],
      edge_ids: [input.edgeId],
      edge_types: ['supports'],
      activation: 'canonical_read',
      authority: 'selector_planning_only',
    }],
    omitted_paths: [],
    authority_violations: [],
    warnings: [],
  };
}

function caseResult(
  result: ReturnType<typeof runGraphFrontierEvaluationFixture>,
  id: GraphFrontierEvaluationCase['id'],
) {
  const found = result.cases.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing evaluation case: ${id}`);
  return found;
}
