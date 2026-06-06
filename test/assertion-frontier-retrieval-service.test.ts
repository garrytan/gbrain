import { describe, expect, test } from 'bun:test';
import {
  planAssertionGraphFrontier,
  type GraphFrontierEdge,
  type GraphFrontierNode,
} from '../src/core/services/assertion-frontier-retrieval-service.ts';

const scopeId = 'workspace:default';
const policyVersion = 'policy:v1';

function node(id: string, slug?: string, overrides: Partial<GraphFrontierNode> = {}): GraphFrontierNode {
  return {
    id,
    scope_id: scopeId,
    policy_version: policyVersion,
    selector: slug
      ? {
        kind: 'page',
        scope_id: scopeId,
        slug,
        freshness: 'current',
      }
      : undefined,
    ...overrides,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  type: GraphFrontierEdge['edge_type'] = 'supports',
  overrides: Partial<GraphFrontierEdge> = {},
): GraphFrontierEdge {
  return {
    id,
    edge_type: type,
    from_node_id: from,
    to_node_id: to,
    scope_id: scopeId,
    policy_version: policyVersion,
    ...overrides,
  };
}

describe('assertion graph frontier planner', () => {
  test('stays inert unless explicitly enabled', () => {
    const result = planAssertionGraphFrontier({
      enabled: false,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [node('a', 'systems/a'), node('b', 'systems/b')],
      edges: [edge('edge:a-b', 'a', 'b')],
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.paths_considered).toEqual([]);
    expect(result.omitted_paths).toEqual([]);
    expect(result.authority_violations).toEqual([]);
  });

  test('requires explicit scope for enabled frontier planning', () => {
    expect(() => planAssertionGraphFrontier({
      enabled: true,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [node('a', 'systems/a')],
      edges: [],
    })).toThrow('scope_id is required for graph frontier planning');
  });

  test('selects canonical read selectors without turning graph paths into evidence', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [node('a', 'systems/a'), node('b', 'systems/b')],
      edges: [edge('edge:a-b', 'a', 'b', 'supports')],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([{
      node_id: 'b',
      selector: {
        kind: 'page',
        scope_id: scopeId,
        slug: 'systems/b',
        freshness: 'current',
      },
      activation: 'canonical_read',
      reason_codes: ['edge:supports'],
    }]);
    expect(result.paths_considered).toHaveLength(1);
    expect(result.paths_considered[0]).toMatchObject({
      path_id: 'path:edge:a-b',
      edge_ids: ['edge:a-b'],
      edge_types: ['supports'],
      activation: 'canonical_read',
      authority: 'selector_planning_only',
    });
    expect(JSON.stringify(result.selected_selectors)).not.toContain('edge:a-b');
    expect(result.authority_violations).toEqual([]);
  });

  test('omits cross-scope, policy-mismatched, and unsupported edges before traversal', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [
        node('a', 'systems/a'),
        node('b', 'systems/b'),
        node('c', 'systems/c', { scope_id: 'personal:default' }),
        node('d', 'systems/d'),
      ],
      edges: [
        edge('edge:scope', 'a', 'c', 'supports', { scope_id: 'personal:default' }),
        edge('edge:policy', 'a', 'b', 'supports', { policy_version: 'policy:v2' }),
        edge('edge:unsupported', 'a', 'd', 'derived_from'),
      ],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.omitted_paths.map((path) => path.reason)).toEqual([
      'policy_mismatch',
      'scope_mismatch',
      'unsupported_edge_type',
    ]);
  });

  test('omits selectors whose own scope does not match the frontier scope', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [
        node('a', 'systems/a'),
        node('b', 'systems/b', {
          selector: {
            kind: 'page',
            scope_id: 'personal:default',
            slug: 'people/private',
            freshness: 'current',
          },
        }),
      ],
      edges: [edge('edge:a-b', 'a', 'b')],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'edge:a-b',
      from_node_id: 'a',
      to_node_id: 'b',
      reason: 'scope_mismatch',
      edge_type: 'supports',
    });
  });

  test('does not traverse from seed nodes outside the requested scope or policy', () => {
    const scopeMismatch = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['seed'],
      nodes: [
        node('seed', 'people/private', { scope_id: 'personal:default' }),
        node('target', 'systems/target'),
      ],
      edges: [edge('edge:seed-target', 'seed', 'target')],
      max_depth: 1,
      fanout_cap: 5,
    });
    const policyMismatch = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['seed'],
      nodes: [
        node('seed', 'systems/old-policy', { policy_version: 'policy:v2' }),
        node('target', 'systems/target'),
      ],
      edges: [edge('edge:seed-target', 'seed', 'target')],
      max_depth: 1,
      fanout_cap: 5,
    });
    const selectorScopeMismatch = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['seed'],
      nodes: [
        node('seed', 'systems/seed', {
          selector: {
            kind: 'page',
            scope_id: 'personal:default',
            slug: 'people/private',
            freshness: 'current',
          },
        }),
        node('target', 'systems/target'),
      ],
      edges: [edge('edge:seed-target', 'seed', 'target')],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(scopeMismatch.selected_selectors).toEqual([]);
    expect(scopeMismatch.omitted_paths).toContainEqual({
      node_id: 'seed',
      reason: 'scope_mismatch',
    });
    expect(policyMismatch.selected_selectors).toEqual([]);
    expect(policyMismatch.omitted_paths).toContainEqual({
      node_id: 'seed',
      reason: 'policy_mismatch',
    });
    expect(selectorScopeMismatch.selected_selectors).toEqual([]);
    expect(selectorScopeMismatch.omitted_paths).toContainEqual({
      node_id: 'seed',
      reason: 'scope_mismatch',
    });
  });

  test('enforces fanout and depth caps with traceable omissions', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [
        node('a', 'systems/a'),
        node('b', 'systems/b'),
        node('c', 'systems/c'),
        node('d', 'systems/d'),
      ],
      edges: [
        edge('edge:a-b', 'a', 'b'),
        edge('edge:a-c', 'a', 'c'),
        edge('edge:b-d', 'b', 'd'),
      ],
      max_depth: 1,
      fanout_cap: 1,
    });

    expect(result.selected_selectors.map((entry) => entry.node_id)).toEqual(['b']);
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'edge:a-c',
      from_node_id: 'a',
      to_node_id: 'c',
      reason: 'fanout_cap',
      edge_type: 'supports',
    });
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'edge:b-d',
      from_node_id: 'b',
      to_node_id: 'd',
      reason: 'depth_cap',
      edge_type: 'supports',
    });
  });

  test('keeps revalidation and contradiction paths out of answer grounding', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [node('a', 'systems/a'), node('b', 'systems/b'), node('c', 'systems/c')],
      edges: [
        edge('edge:verify', 'a', 'b', 'requires_reverification'),
        edge('edge:conflict', 'a', 'c', 'contradicts'),
      ],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors.map((entry) => ({
      node_id: entry.node_id,
      activation: entry.activation,
      reason_codes: entry.reason_codes,
    }))).toEqual([
      {
        node_id: 'c',
        activation: 'review_only',
        reason_codes: ['edge:contradicts', 'contradiction_requires_review'],
      },
      {
        node_id: 'b',
        activation: 'verify_first',
        reason_codes: ['edge:requires_reverification', 'fresh_canonical_read_required'],
      },
    ]);
    expect(result.selected_selectors.some((entry) =>
      entry.activation === 'canonical_read'
      && entry.reason_codes.includes('edge:contradicts')
    )).toBe(false);
    expect(result.selected_selectors.some((entry) =>
      entry.activation === 'canonical_read'
      && entry.reason_codes.includes('edge:requires_reverification')
    )).toBe(false);
    expect(result.authority_violations).toEqual([]);
  });

  test('lets stricter revalidation or contradiction paths override canonical support', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [
        node('a', 'systems/a'),
        node('b', 'systems/b'),
        node('c', 'systems/c'),
        node('y', 'systems/y'),
        node('downstream', 'systems/downstream'),
      ],
      edges: [
        edge('edge:1-supports-b', 'a', 'b', 'supports'),
        edge('edge:3-supports-c', 'a', 'c', 'supports'),
        edge('edge:4-contradicts-c', 'a', 'c', 'contradicts'),
        edge('edge:a-y', 'a', 'y', 'supports'),
        edge('edge:b-downstream', 'b', 'downstream', 'supports'),
        edge('edge:y-reverify-b', 'y', 'b', 'requires_reverification'),
      ],
      max_depth: 2,
      fanout_cap: 5,
    });

    expect(result.selected_selectors.map((entry) => ({
      node_id: entry.node_id,
      activation: entry.activation,
    }))).toEqual([
      { node_id: 'y', activation: 'canonical_read' },
      { node_id: 'c', activation: 'review_only' },
      { node_id: 'b', activation: 'verify_first' },
    ]);
    expect(result.selected_selectors.map((entry) => entry.node_id)).not.toContain('downstream');
  });

  test('treats supersedes targets as historical by default', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['current'],
      nodes: [node('current', 'systems/current-runtime'), node('old', 'systems/old-runtime')],
      edges: [edge('link:supersedes', 'current', 'old', 'supersedes')],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'link:supersedes',
      from_node_id: 'current',
      to_node_id: 'old',
      reason: 'historical_selector',
      edge_type: 'supersedes',
    });
    expect(result.paths_considered[0]).toMatchObject({
      edge_ids: ['link:supersedes'],
      activation: 'review_only',
      authority: 'selector_planning_only',
    });
    expect(JSON.stringify(result.selected_selectors)).not.toContain('link:supersedes');
    expect(result.authority_violations).toEqual([]);
  });

  test('omits graph-only targets that do not resolve to canonical selectors', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [node('a', 'systems/a'), node('b')],
      edges: [edge('edge:a-b', 'a', 'b')],
      max_depth: 1,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'edge:a-b',
      from_node_id: 'a',
      to_node_id: 'b',
      reason: 'missing_canonical_selector',
      edge_type: 'supports',
    });
  });

  test('omits source-ref selectors as non-canonical graph targets', () => {
    const result = planAssertionGraphFrontier({
      enabled: true,
      scope_id: scopeId,
      policy_version: policyVersion,
      seed_node_ids: ['a'],
      nodes: [
        node('a', 'systems/a'),
        node('b', undefined, {
          selector: {
            kind: 'source_ref',
            scope_id: scopeId,
            source_ref: 'source:item:private',
            freshness: 'current',
          },
        }),
        node('c', 'systems/downstream'),
      ],
      edges: [
        edge('edge:a-b', 'a', 'b'),
        edge('edge:b-c', 'b', 'c'),
      ],
      max_depth: 2,
      fanout_cap: 5,
    });

    expect(result.selected_selectors).toEqual([]);
    expect(result.omitted_paths).toContainEqual({
      edge_id: 'edge:a-b',
      from_node_id: 'a',
      to_node_id: 'b',
      reason: 'non_canonical_selector',
      edge_type: 'supports',
    });
    expect(result.selected_selectors.map((entry) => entry.node_id)).not.toContain('c');
    expect(result.authority_violations).toEqual([]);
  });
});
