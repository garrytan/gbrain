/**
 * Scenario S30 - GBrain absorption GA-P5 code lane.
 *
 * GA-P5 accepts code graph data only as derived Context Map orientation. It
 * must not answer as current code truth without live workspace verification.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { allocateSqliteBrain } from './helpers.ts';

type CodeLaneCase = {
  case_id: string;
  lookup_kind: string;
  path: string;
  symbol: string;
  expected_neighbor_symbol?: string;
  expected_authority: 'derived_orientation';
  lane_grants_authority: boolean;
  graph_walk: string;
  expected_edge_kind?: string;
  expected_content_hash?: string;
  expected_reverify_reason?: string;
  verification_mode: string;
  verification_hint?: string;
};

type CodeLaneSnapshot = {
  authority?: string;
  lane_grants_authority?: boolean;
  graph_walk?: {
    enabled_by_default?: boolean;
    depth_limit?: number;
    fanout_cap?: number;
    bounded_output?: boolean;
  };
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
};

type CodeLaneApis = {
  buildCodeLaneContextMapEntry: (engine: OperationContext['engine'], scopeId?: string) => Promise<{
    graph_json: Record<string, unknown>;
  }>;
  expandCodeLaneGraph: (
    snapshot: CodeLaneSnapshot,
    symbolId: string,
    controls: { requested: boolean; depth_limit?: number; fanout_cap?: number },
  ) => Record<string, unknown>;
  source: string;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  code_lane_cases: CodeLaneCase[];
};

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

function codeLaneCase(caseId: string): CodeLaneCase {
  const found = fixture.code_lane_cases.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`Missing GA-P5 code-lane case ${caseId}`);
  return found;
}

async function loadCodeLaneApis(): Promise<CodeLaneApis> {
  const candidates = [
    '../../src/core/services/context-map-code-lane-service.ts',
    '../../src/core/services/context-map-service.ts',
  ];
  const errors: string[] = [];
  let buildCodeLaneContextMapEntry: CodeLaneApis['buildCodeLaneContextMapEntry'] | null = null;
  let expandCodeLaneGraph: CodeLaneApis['expandCodeLaneGraph'] | null = null;
  const sources: string[] = [];

  for (const candidate of candidates) {
    try {
      const moduleUrl = new URL(candidate, import.meta.url).href;
      const mod = await import(moduleUrl) as Record<string, unknown>;
      const build = mod.buildCodeLaneContextMapEntry;
      const expand = mod.expandCodeLaneGraph;
      if (!buildCodeLaneContextMapEntry && typeof build === 'function') {
        buildCodeLaneContextMapEntry = build as CodeLaneApis['buildCodeLaneContextMapEntry'];
        sources.push(`${candidate}:buildCodeLaneContextMapEntry`);
      }
      if (!expandCodeLaneGraph && typeof expand === 'function') {
        expandCodeLaneGraph = expand as CodeLaneApis['expandCodeLaneGraph'];
        sources.push(`${candidate}:expandCodeLaneGraph`);
      }
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  if (buildCodeLaneContextMapEntry && expandCodeLaneGraph) {
    return {
      buildCodeLaneContextMapEntry,
      expandCodeLaneGraph,
      source: sources.join(', '),
    };
  }

  throw new Error([
    'GA-P5 code-lane APIs unavailable',
    buildCodeLaneContextMapEntry ? '' : 'missing buildCodeLaneContextMapEntry',
    expandCodeLaneGraph ? '' : 'missing expandCodeLaneGraph',
    errors.join('; '),
  ].filter(Boolean).join(': '));
}

function findNode(snapshot: CodeLaneSnapshot, expected: CodeLaneCase): Record<string, unknown> {
  const node = (snapshot.nodes ?? []).find((candidate) =>
    candidate.symbol_name === expected.symbol
    || candidate.symbol === expected.symbol
    || String(candidate.symbol_id ?? '').includes(expected.symbol));
  if (!node) throw new Error(`Missing code-lane node for ${expected.symbol}`);
  return node;
}

function edgeKind(edge: Record<string, unknown>): string {
  return String(edge.edge_kind ?? edge.kind ?? '');
}

function seedRepo(repoPath: string): void {
  mkdirSync(join(repoPath, 'src/core/services'), { recursive: true });
  mkdirSync(join(repoPath, 'src/core'), { recursive: true });
  writeFileSync(join(repoPath, 'src/core/services/context-map-code-lane-service.ts'), [
    'export function buildCodeLaneContextMapEntry() {',
    '  return expandCodeLaneGraph();',
    '}',
    '',
    'export function expandCodeLaneGraph() {',
    '  return "derived orientation only";',
    '}',
  ].join('\n'));
  writeFileSync(join(repoPath, 'src/core/operations.ts'), [
    'export function parseCodeClaimParamItem() {',
    '  return "claim";',
    '}',
    '',
    'export function reverify_code_claims() {',
    '  return parseCodeClaimParamItem();',
    '}',
  ].join('\n'));
}

async function importCodemapPages(engine: OperationContext['engine'], repoPath: string): Promise<void> {
  await importFromContent(engine, 'systems/ga-p5-code-lane', [
    '---',
    'type: system',
    'title: GA-P5 Code Lane',
    `repo_path: ${repoPath}`,
    'codemap:',
    '  - system: systems/ga-p5-code-lane',
    `    repo_path: ${repoPath}`,
    '    pointers:',
    '      - path: src/core/services/context-map-code-lane-service.ts',
    '        symbol: buildCodeLaneContextMapEntry',
    '        qualified_name: buildCodeLaneContextMapEntry',
    '        role: Builds the derived code-lane Context Map entry',
    '        language: typescript',
    '        chunk_id: ga-p5-builder',
    '        start_line: 1',
    '        end_line: 3',
    '        content_hash: sha256:ga-p5-build-lane',
    '        source_ref: test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#definition_lookup',
    '        verification_hint: reverify_code_claims path+symbol+expected_content_hash',
    '        edges:',
    '          - kind: calls',
    '            to_symbol: expandCodeLaneGraph',
    '      - path: src/core/services/context-map-code-lane-service.ts',
    '        symbol: expandCodeLaneGraph',
    '        qualified_name: expandCodeLaneGraph',
    '        role: Expands a symbol neighborhood only when explicitly requested',
    '        language: typescript',
    '        chunk_id: ga-p5-expander',
    '        start_line: 5',
    '        end_line: 7',
    '        content_hash: sha256:ga-p5-expand-lane',
    '        source_ref: test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#references_lookup',
    '        verification_hint: reverify_code_claims verifies live file, symbol, branch, and content hash',
    '        edges:',
    '          - kind: references',
    '            to_symbol: buildCodeLaneContextMapEntry',
    '---',
    '# GA-P5 code lane',
    'Code lane data is derived orientation only.',
  ].join('\n'), { path: 'systems/ga-p5-code-lane.md' });

  await importFromContent(engine, 'concepts/ga-p5-code-claim-verification', [
    '---',
    'type: concept',
    'title: GA-P5 Code Claim Verification',
    `repo_path: ${repoPath}`,
    'codemap:',
    '  - system: systems/ga-p5-code-lane',
    `    repo_path: ${repoPath}`,
    '    pointers:',
    '      - path: src/core/operations.ts',
    '        symbol: reverify_code_claims',
    '        qualified_name: reverify_code_claims',
    '        role: Revalidates current code claims before answer use',
    '        language: typescript',
    '        chunk_id: ga-p5-reverify',
    '        start_line: 5',
    '        end_line: 7',
    '        content_hash: sha256:ga-p5-reverify',
    '        source_ref: test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#nearby_context',
    '        verification_hint: reverify_code_claims live workspace check',
    '        edges:',
    '          - kind: references',
    '            to_symbol: parseCodeClaimParamItem',
    '      - path: src/core/operations.ts',
    '        symbol: parseCodeClaimParamItem',
    '        qualified_name: parseCodeClaimParamItem',
    '        role: Parses direct code-claim verification params',
    '        language: typescript',
    '        chunk_id: ga-p5-claim-parser',
    '        start_line: 1',
    '        end_line: 3',
    '        content_hash: sha256:ga-p5-claim-parser',
    '        source_ref: test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#nearby_context',
    '        verification_hint: reverify_code_claims preserves expected_content_hash metadata',
    '---',
    '# GA-P5 code claim verification',
    'Current code claims require live file, symbol, branch, and content-hash verification.',
  ].join('\n'), { path: 'concepts/ga-p5-code-claim-verification.md' });
}

describe('S30 - gbrain code lane', () => {
  test('defines replay cases for every GA-P5 code-lane lookup family', () => {
    expect(fixture.stage_id).toBe('GA-P5');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toContain(
      'bun test test/context-map-code-lane-service.test.ts test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s30-gbrain-code-lane.test.ts',
    );
    expect(fixture.code_lane_cases.map((entry) => entry.case_id).sort()).toEqual([
      'callees_lookup',
      'callers_lookup',
      'definition_lookup',
      'nearby_context',
      'references_lookup',
      'stale_code_claim',
    ]);
    for (const entry of fixture.code_lane_cases) {
      expect(entry.expected_authority).toBe('derived_orientation');
      expect(entry.lane_grants_authority).toBe(false);
      expect(entry.verification_mode).toBe('live_workspace_check');
    }
  });

  test('replays derived code-lane orientation and stale content-hash verification', async () => {
    const handle = await allocateSqliteBrain('s30-code-lane');

    try {
      const repoPath = join(handle.rootDir, 'repo');
      seedRepo(repoPath);
      await importCodemapPages(handle.engine, repoPath);

      const apis = await loadCodeLaneApis();
      expect(apis.source).toMatch(/context-map/);

      const entry = await apis.buildCodeLaneContextMapEntry(handle.engine, 'workspace:default');
      const snapshot = entry.graph_json as CodeLaneSnapshot;
      const definition = codeLaneCase('definition_lookup');
      const references = codeLaneCase('references_lookup');
      const stale = codeLaneCase('stale_code_claim');

      expect(snapshot.authority).toBe('derived_orientation');
      expect(snapshot.lane_grants_authority ?? snapshot.authority !== 'derived_orientation').toBe(false);
      expect(snapshot.graph_walk).toEqual(expect.objectContaining({
        enabled_by_default: false,
        depth_limit: 1,
        fanout_cap: 50,
      }));

      const definitionNode = findNode(snapshot, definition);
      const referencesNode = findNode(snapshot, references);
      expect(definitionNode).toEqual(expect.objectContaining({
        authority: 'derived_orientation',
      }));
      expect(referencesNode).toEqual(expect.objectContaining({
        authority: 'derived_orientation',
      }));
      expect(String(definitionNode.verification_hint ?? '')).toContain('reverify_code_claims');
      expect((snapshot.edges ?? []).some((edge) => edgeKind(edge) === 'declares')).toBe(true);
      expect((snapshot.edges ?? []).some((edge) => edgeKind(edge) === 'calls')).toBe(true);
      expect((snapshot.edges ?? []).some((edge) => edgeKind(edge) === 'references')).toBe(true);

      const expanded = apis.expandCodeLaneGraph(
        snapshot,
        String(definitionNode.symbol_id),
        { requested: true, depth_limit: 1, fanout_cap: 3 },
      );
      const expandedEdges = Array.isArray(expanded.edges) ? expanded.edges : [];
      expect(expandedEdges.length).toBeGreaterThan(0);
      expect(expandedEdges.length).toBeLessThanOrEqual(3);

      for (const caseId of ['callers_lookup', 'callees_lookup', 'nearby_context']) {
        const replayCase = codeLaneCase(caseId);
        const rootNode = findNode(snapshot, replayCase);
        const neighborCase = {
          ...replayCase,
          symbol: replayCase.expected_neighbor_symbol ?? '',
        };
        const neighborNode = findNode(snapshot, neighborCase);
        const replayExpanded = apis.expandCodeLaneGraph(
          snapshot,
          String(rootNode.symbol_id),
          { requested: true, depth_limit: 1, fanout_cap: 3 },
        );
        const replayEdges = Array.isArray(replayExpanded.edges)
          ? replayExpanded.edges as Array<Record<string, unknown>>
          : [];
        const expectedFrom = caseId === 'callers_lookup'
          ? String(neighborNode.symbol_id)
          : String(rootNode.symbol_id);
        const expectedTo = caseId === 'callers_lookup'
          ? String(rootNode.symbol_id)
          : String(neighborNode.symbol_id);

        expect(replayEdges.some((edge) =>
          edgeKind(edge) === replayCase.expected_edge_kind
          && String(edge.from_symbol_id ?? '') === expectedFrom
          && String(edge.to_symbol_id ?? '') === expectedTo)).toBe(true);
      }

      const report = await operationsByName.reverify_code_claims.handler(opContext(handle.engine), {
        repo_path: repoPath,
        branch_name: 'main',
        claims: [{
          path: stale.path,
          symbol: stale.symbol,
          branch_name: 'main',
          expected_content_hash: stale.expected_content_hash,
          verification_hint: 'S30 stale code-lane fixture must not become current truth',
          verification_mode: stale.verification_mode,
          source_ref: 'test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json#stale_code_claim',
        }],
      }) as {
        results: Array<{
          claim: Record<string, unknown>;
          status: string;
          reason: string;
          actual_content_hash?: string;
        }>;
      };

      expect(report.results[0]).toEqual(expect.objectContaining({
        status: 'stale',
        reason: stale.expected_reverify_reason,
      }));
      expect(report.results[0]?.claim.expected_content_hash).toBe(stale.expected_content_hash);
      expect(report.results[0]?.actual_content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S30 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

    expect(readme).toContain('| S30 | `s30-gbrain-code-lane.test.ts` | GA-P5, L4, L6, E1 | ✅ green |');
  });
});
