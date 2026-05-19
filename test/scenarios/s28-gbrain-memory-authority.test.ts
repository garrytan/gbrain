/**
 * Scenario S28 - GBrain absorption GA-P4 memory authority.
 *
 * GA-P4 is an authority-stage contract slice. It distinguishes compiled truth,
 * profile memory, personal episodes, historical evidence, candidates, derived
 * orientation, and writeback guards without adding a new memory subsystem.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type {
  MemoryActivationDecision,
  MemoryArtifactAuthority,
  MemoryArtifactKind,
  ScopeGatePolicy,
} from '../../src/core/types.ts';
import { allocateSqliteBrain } from './helpers.ts';

type AuthorityCase = {
  case_id: string;
  fixture_id: string;
  artifact_id: string;
  artifact_kind: MemoryArtifactKind;
  scope_policy?: ScopeGatePolicy;
  expected_decision: MemoryActivationDecision;
  expected_authority: MemoryArtifactAuthority;
  expected_reason_code: string;
};

type WritebackCase = {
  case_id: string;
  expected_decision: string;
  expected_intended_operation: string;
  expected_reason: string;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p4-memory-authority.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  authority_cases: AuthorityCase[];
  writeback_cases: WritebackCase[];
};

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

function writebackCase(caseId: string): WritebackCase {
  const found = fixture.writeback_cases.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`Missing GA-P4 writeback case ${caseId}`);
  return found;
}

describe('S28 - gbrain memory authority', () => {
  test('defines replay cases for every GA-P4 authority surface', () => {
    expect(fixture.stage_id).toBe('GA-P4');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toContain(
      'bun test test/memory-activation-policy-service.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s28-gbrain-memory-authority.test.ts',
    );

    expect(fixture.authority_cases.map((entry) => entry.case_id).sort()).toEqual([
      'codemap_derived_orientation',
      'compiled_truth_authority',
      'context_map_derived_orientation',
      'memory_candidate_candidate_only',
      'operational_memory_authority',
      'personal_episode_authority',
      'profile_memory_authority',
      'source_record_historical_evidence',
      'timeline_historical_evidence',
    ]);
    expect(fixture.writeback_cases.map((entry) => entry.case_id).sort()).toEqual([
      'canonical_snapshot_guard',
      'contradiction_candidate',
      'personal_target_scope_sensitivity_guard',
      'task_mechanics_no_write',
    ]);
  });

  test('replays activation authority through existing operation surfaces', async () => {
    const handle = await allocateSqliteBrain('s28-memory-authority');

    try {
      const ctx = opContext(handle.engine);
      await operationsByName.upsert_profile_memory_entry.handler(ctx, {
        id: 'profile:ga-p4-authority',
        profile_type: 'preference',
        subject: 'GA-P4 authority routing',
        content: 'Profile memory remains profile_memory authority after scope allow.',
        source_ref: 'Scenario S28 profile source',
      });
      await operationsByName.record_personal_episode.handler(ctx, {
        id: 'episode:ga-p4-authority',
        title: 'GA-P4 authority episode',
        start_time: '2026-05-19T00:00:00.000Z',
        source_kind: 'chat',
        summary: 'Personal episodes remain personal_episode authority after scope allow.',
        source_ref: 'Scenario S28 episode source',
      });

      const result = await operationsByName.select_activation_policy.handler(ctx, {
        scenario: 'personal_recall',
        artifacts: fixture.authority_cases.map((entry) => ({
          id: entry.artifact_id,
          artifact_kind: entry.artifact_kind,
          source_ref: entry.fixture_id,
          scope_policy: entry.scope_policy,
        })),
      }) as {
        decisions: Array<{
          artifact_id: string;
          decision: MemoryActivationDecision;
          authority: MemoryArtifactAuthority;
          reason_codes: string[];
        }>;
      };

      for (const entry of fixture.authority_cases) {
        const decision = result.decisions.find((candidate) => candidate.artifact_id === entry.artifact_id);
        expect(decision).toMatchObject({
          decision: entry.expected_decision,
          authority: entry.expected_authority,
        });
        expect(decision?.reason_codes).toContain(entry.expected_reason_code);
      }
    } finally {
      await handle.teardown();
    }
  });

  test('plans profile memory and personal episodes without compiled-truth authority', async () => {
    const handle = await allocateSqliteBrain('s28-personal-planner-authority');

    try {
      const plan = await operationsByName.plan_scenario_memory_request.handler(opContext(handle.engine), {
        query: 'Remember my private planning preference and the episode I described',
        requested_scope: 'personal',
      }) as {
        planned_activation_rules: Array<{
          artifact_kind: MemoryArtifactKind;
          authority: MemoryArtifactAuthority;
        }>;
      };

      expect(plan.planned_activation_rules).toContainEqual(expect.objectContaining({
        planned_read: 'profile_memory_or_personal_episode',
        artifact_kind: 'profile_memory',
        authority: 'profile_memory',
      }));
      expect(plan.planned_activation_rules).toContainEqual(expect.objectContaining({
        planned_read: 'profile_memory_or_personal_episode',
        artifact_kind: 'personal_episode',
        authority: 'personal_episode',
      }));
      expect(
        plan.planned_activation_rules
          .filter((rule) => rule.artifact_kind === 'profile_memory' || rule.artifact_kind === 'personal_episode')
          .map((rule) => rule.authority),
      ).not.toContain('canonical_compiled_truth');
    } finally {
      await handle.teardown();
    }
  });

  test('reads personal records with personal authority through read_context', async () => {
    const handle = await allocateSqliteBrain('s28-read-context-personal-authority');

    try {
      const ctx = opContext(handle.engine);
      await operationsByName.upsert_profile_memory_entry.handler(ctx, {
        id: 'profile:ga-p4-read-context',
        profile_type: 'preference',
        subject: 'GA-P4 read_context authority routing',
        content: 'Profile memory read_context remains profile_memory authority.',
        source_ref: 'Scenario S28 profile read source',
      });
      await operationsByName.record_personal_episode.handler(ctx, {
        id: 'episode:ga-p4-read-context',
        title: 'GA-P4 read_context authority episode',
        start_time: '2026-05-19T00:00:00.000Z',
        source_kind: 'chat',
        summary: 'Personal episode read_context remains personal_episode authority.',
        source_ref: 'Scenario S28 episode read source',
      });

      const result = await operationsByName.read_context.handler(ctx, {
        requested_scope: 'personal',
        selectors: [
          { kind: 'profile_memory', object_id: 'profile:ga-p4-read-context' },
          { kind: 'personal_episode', object_id: 'episode:ga-p4-read-context' },
        ],
      }) as {
        canonical_reads: Array<{
          selector: { kind: string; object_id?: string };
          authority: MemoryArtifactAuthority;
        }>;
      };

      expect(result.canonical_reads).toContainEqual(expect.objectContaining({
        selector: expect.objectContaining({ kind: 'profile_memory' }),
        authority: 'profile_memory',
      }));
      expect(result.canonical_reads).toContainEqual(expect.objectContaining({
        selector: expect.objectContaining({ kind: 'personal_episode' }),
        authority: 'personal_episode',
      }));
    } finally {
      await handle.teardown();
    }
  });

  test('replays writeback authority guards without new storage', async () => {
    const handle = await allocateSqliteBrain('s28-writeback-authority');

    try {
      const ctx = opContext(handle.engine);
      const sourceRefs = ['Scenario S28 direct source'];

      const snapshotGuard = await operationsByName.route_memory_writeback.handler(ctx, {
        content: 'The user stated GA-P4 canonical writes need snapshots.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        sensitivity: 'work',
      }) as { decision: string; intended_operation: string; reasons: string[] };
      const expectedSnapshot = writebackCase('canonical_snapshot_guard');
      expect(snapshotGuard.decision).toBe(expectedSnapshot.expected_decision);
      expect(snapshotGuard.intended_operation).toBe(expectedSnapshot.expected_intended_operation);
      expect(snapshotGuard.reasons).toContain(expectedSnapshot.expected_reason);

      const personalGuard = await operationsByName.route_memory_writeback.handler(ctx, {
        content: 'The user prefers private planning notes.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        target_object_type: 'profile_memory',
        target_object_id: 'profile:user-preferences',
      }) as { decision: string; intended_operation: string; reasons: string[] };
      const expectedPersonal = writebackCase('personal_target_scope_sensitivity_guard');
      expect(personalGuard.decision).toBe(expectedPersonal.expected_decision);
      expect(personalGuard.intended_operation).toBe(expectedPersonal.expected_intended_operation);
      expect(personalGuard.reasons).toContain(expectedPersonal.expected_reason);
      expect(personalGuard.reasons).toContain('personal_target_sensitivity_required');

      const contradiction = await operationsByName.route_memory_writeback.handler(ctx, {
        content: 'The user corrected an earlier GA-P4 authority claim.',
        evidence_kind: 'contradicts_existing',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
      }) as {
        decision: string;
        intended_operation: string;
        reasons: string[];
        candidate_input?: { candidate_type: string; status: string };
      };
      const expectedContradiction = writebackCase('contradiction_candidate');
      expect(contradiction.decision).toBe(expectedContradiction.expected_decision);
      expect(contradiction.intended_operation).toBe(expectedContradiction.expected_intended_operation);
      expect(contradiction.reasons).toContain(expectedContradiction.expected_reason);
      expect(contradiction.candidate_input).toMatchObject({
        candidate_type: 'note_update',
        status: 'captured',
      });

      const taskMechanics = await operationsByName.route_memory_writeback.handler(ctx, {
        content: 'Ran the focused GA-P4 test command.',
        evidence_kind: 'task_mechanics',
        source_refs: sourceRefs,
      }) as { decision: string; intended_operation: string; reasons: string[]; candidate_input?: unknown };
      const expectedTaskMechanics = writebackCase('task_mechanics_no_write');
      expect(taskMechanics.decision).toBe(expectedTaskMechanics.expected_decision);
      expect(taskMechanics.intended_operation).toBe(expectedTaskMechanics.expected_intended_operation);
      expect(taskMechanics.reasons).toContain(expectedTaskMechanics.expected_reason);
      expect(taskMechanics.candidate_input).toBeUndefined();
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S28 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

    expect(readme).toContain('| S28 | `s28-gbrain-memory-authority.test.ts` | GA-P4, L4, L5, L6, G1 | ✅ green |');
  });
});
