import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operationsByName } from '../../src/core/operations.ts';

type ContractCase = {
  case_id: string;
  fixture_id: string;
  query: string;
  requested_scope: 'work' | 'personal' | 'mixed';
  expected_intent: string;
  expected_canonical_refs: string[];
  candidate_authority: 'answer_ground' | 'candidate_only' | 'historical' | 'not_expected';
  lane_scope_decision: {
    scope_id: string;
    lane_id: string;
    lane_grants_authority: boolean;
  };
  code_verification: {
    required: boolean;
    repo_path: string;
    expected_mode: string;
  };
  maintenance_apply_result: {
    allowed_without_control_plane: boolean;
    requires_realm_session: boolean;
    requires_mutation_ledger: boolean;
    requires_target_snapshot: boolean;
  };
  existing_surfaces: string[];
  must_preserve: string[];
  verification_commands: string[];
  lane_grants_authority?: boolean;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p0-p1.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  upstream_baseline: { path: string; sha: string; tag: string };
  contract_cases: ContractCase[];
};

describe('S26 - gbrain absorption contracts stay executable', () => {
  test('pins the reviewed upstream baseline', () => {
    expect(fixture.stage_id).toBe('GA-P0/GA-P1');
    expect(fixture.upstream_baseline.path).toBe('reference/gbrain');
    expect(fixture.upstream_baseline.sha).toBe('03947665e4dbfeaf8a5542d160a0f4b89e4ae747');
    expect(fixture.upstream_baseline.tag).toBe('v0.36.0.0');
  });

  test('maps every contract family to registered executable surfaces', () => {
    const required = new Map([
      ['authority-routing', ['retrieve_context', 'read_context', 'route_memory_writeback']],
      ['corpus-lane-boundary', ['read_context', 'retrieval_traces']],
      ['code-lane-derived-artifact', ['reverify_code_claims']],
      ['maintenance-apply-boundary', ['route_memory_writeback', 'memory_mutation_ledger']],
    ]);
    const surfaceOperations = new Map([
      ['retrieve_context', 'retrieve_context'],
      ['read_context', 'read_context'],
      ['route_memory_writeback', 'route_memory_writeback'],
      ['reverify_code_claims', 'reverify_code_claims'],
      ['retrieval_traces', 'record_retrieval_trace'],
      ['memory_mutation_ledger', 'list_memory_mutation_events'],
    ]);

    for (const [caseId, surfaces] of required) {
      const contractCase = fixture.contract_cases.find((entry) => entry.case_id === caseId);
      expect(contractCase, `missing ${caseId}`).toBeDefined();
      for (const surface of surfaces) {
        expect(contractCase?.existing_surfaces).toContain(surface);
        const operationName = surfaceOperations.get(surface);
        expect(operationName, `missing operation mapping for ${surface}`).toBeDefined();
        expect(
          operationsByName[operationName as keyof typeof operationsByName],
          `missing registered operation for ${surface}`,
        ).toBeDefined();
      }
    }
  });

  test('uses replay-shaped contract cases for GA-P1 boundaries', () => {
    for (const contractCase of fixture.contract_cases) {
      expect(contractCase.fixture_id.startsWith('ga-p1-')).toBe(true);
      expect(contractCase.query.length).toBeGreaterThan(0);
      expect(['work', 'personal', 'mixed']).toContain(contractCase.requested_scope);
      expect(contractCase.expected_intent.length).toBeGreaterThan(0);
      expect(contractCase.expected_canonical_refs.length).toBeGreaterThan(0);
      expect(['answer_ground', 'candidate_only', 'historical', 'not_expected']).toContain(contractCase.candidate_authority);
      expect(contractCase.lane_scope_decision.scope_id.length).toBeGreaterThan(0);
      expect(contractCase.lane_scope_decision.lane_id.length).toBeGreaterThan(0);
      expect(contractCase.lane_scope_decision.lane_grants_authority).toBe(false);
      expect(contractCase.code_verification.expected_mode.length).toBeGreaterThan(0);
      expect(contractCase.maintenance_apply_result.allowed_without_control_plane).toBe(false);
      expect(contractCase.maintenance_apply_result.requires_realm_session).toBe(true);
      expect(contractCase.maintenance_apply_result.requires_mutation_ledger).toBe(true);
      expect(contractCase.maintenance_apply_result.requires_target_snapshot).toBe(true);
      expect(contractCase.verification_commands).toContain(
        'bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts',
      );
      expect(contractCase.verification_commands).toContain('bun run test:scenarios');
    }
  });

  test('keeps code lane claims behind live verification', () => {
    const codeCase = fixture.contract_cases.find((entry) => entry.case_id === 'code-lane-derived-artifact');

    expect(codeCase?.code_verification).toEqual({
      required: true,
      repo_path: '/path/to/repo',
      expected_mode: 'live_workspace_check',
    });
    expect(codeCase?.candidate_authority).toBe('historical');
    expect(codeCase?.lane_scope_decision.lane_grants_authority).toBe(false);
  });

  test('keeps maintenance apply behind the control plane', () => {
    const maintenanceCase = fixture.contract_cases.find((entry) => entry.case_id === 'maintenance-apply-boundary');

    expect(maintenanceCase?.maintenance_apply_result).toEqual({
      allowed_without_control_plane: false,
      requires_realm_session: true,
      requires_mutation_ledger: true,
      requires_target_snapshot: true,
    });
  });

  test('keeps corpus lanes non-authoritative', () => {
    const laneCase = fixture.contract_cases.find((entry) => entry.case_id === 'corpus-lane-boundary');

    expect(laneCase?.lane_grants_authority).toBe(false);
    expect(laneCase?.lane_scope_decision.lane_grants_authority).toBe(false);
    expect(laneCase?.must_preserve).toEqual(expect.arrayContaining([
      'scope_gate',
      'source_record',
      'import_origin',
    ]));
  });

  test('README registers S26 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

    expect(readme).toContain('| S26 | `s26-gbrain-absorption-contracts.test.ts` | GA-P0, GA-P1, I4, I5, L4, L6, G1 | ✅ green |');
  });
});
