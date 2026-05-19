/**
 * Scenario S31 - GBrain absorption GA-P6 personal maintenance cycle.
 *
 * GA-P6 accepts maintenance only as report/suggestion output by default. Any
 * apply-capable work must stay behind the existing memory operations control
 * plane instead of creating a parallel write path.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { recordCanonicalHandoff } from '../../src/core/services/canonical-handoff-service.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { runDreamCycleMaintenance } from '../../src/core/services/dream-cycle-maintenance-service.ts';
import { advanceMemoryCandidateStatus } from '../../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { allocateSqliteBrain } from './helpers.ts';

type MaintenanceReportCase = {
  case_id: string;
  expected_mutation: boolean;
  expected_authority: string;
};

type MaintenanceApplyControlCase = {
  case_id: string;
  expected_decision?: string;
  expected_ledger_outcome?: string;
  expected_validation_parity?: boolean;
  must_not_expose_raw_sensitive_text?: boolean;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p6-personal-maintenance-cycle.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  maintenance_report_cases: MaintenanceReportCase[];
  maintenance_apply_control_cases: MaintenanceApplyControlCase[];
};

function opContext(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

describe('S31 - gbrain personal maintenance cycle', () => {
  test('defines replay cases for every GA-P6 maintenance family', () => {
    expect(fixture.stage_id).toBe('GA-P6');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toContain(
      'bun test test/dream-cycle-maintenance-service.test.ts test/dream-cycle-maintenance-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s31-gbrain-personal-maintenance-cycle.test.ts',
    );

    expect(fixture.maintenance_report_cases.map((entry) => entry.case_id).sort()).toEqual([
      'derived_artifact_freshness',
      'duplicate_merge_suggestion',
      'report_only_default',
      'stale_candidate_review',
    ]);
    expect(fixture.maintenance_apply_control_cases.map((entry) => entry.case_id).sort()).toEqual([
      'apply_requires_realm_session',
      'apply_requires_target_snapshot',
      'candidate_write_governed_not_truth',
      'dry_run_apply_validation_parity',
      'redaction_fail_closed',
    ]);
    expect(
      fixture.maintenance_report_cases.every((entry) => entry.expected_mutation === false),
    ).toBe(true);
  });

  test('replays report and suggestion output without canonical mutation', async () => {
    const handle = await allocateSqliteBrain('s31-maintenance-report');

    try {
      await seedDuplicateCandidates(handle.engine);
      await seedStalePromotedCandidate(handle.engine);
      await seedStaleContextMap(handle.engine);

      const result = await runDreamCycleMaintenance(handle.engine, {
        scope_id: 'workspace:default',
        now: '2026-04-23T12:00:00.000Z',
        limit: 4,
        include_derived_freshness: true,
      });

      expect(result.authority).toBe('report_or_candidate_only');
      expect(result.canonical_write_allowed).toBe(false);
      expect(result.write_candidates).toBe(false);
      expect(result.suggestions.map((entry) => entry.suggestion_type).sort()).toEqual([
        'duplicate_merge',
        'recap',
        'stale_claim_challenge',
      ]);
      expect(result.suggestions.every((entry) => entry.status === 'dry_run')).toBe(true);
      expect(result.suggestions.every((entry) => entry.candidate_id === null)).toBe(true);
      expect(result.suggestions.every((entry) => entry.scope_id === 'workspace:default')).toBe(true);
      expect(result.suggestions.every((entry) => entry.source_refs.length > 0)).toBe(true);
      expect(result.suggestions.every((entry) => entry.sensitivity === 'work')).toBe(true);
      expect(result.suggestions.find((entry) => entry.suggestion_type === 'recap')?.expected_target_snapshot_hash)
        .toBeNull();
      expect(
        result.suggestions
          .filter((entry) => entry.target_object_id === 'concepts/ga-p6-maintenance')
          .every((entry) => typeof entry.expected_target_snapshot_hash === 'string'
            && entry.expected_target_snapshot_hash.length === 64),
      ).toBe(true);
      expect(result.suggestions.every((entry) => entry.policy_checks.canonical_write_allowed === false)).toBe(true);
      expect(result.suggestions.every((entry) => entry.policy_checks.source_refs_present === true)).toBe(true);
      expect(result.suggestions.every((entry) => entry.policy_checks.scope_present === true)).toBe(true);
      expect(result.suggestions.every((entry) => entry.redaction_checks.fail_closed === true)).toBe(true);
      expect(result.derived_freshness_report).toMatchObject({
        enabled: true,
        artifact_count: 1,
        stale_count: 1,
      });
      expect(result.derived_freshness_report.artifacts[0]).toMatchObject({
        artifact_kind: 'context_map',
        status: 'stale',
        stale_reason: 'source_set_changed',
      });
      expect(result.maintenance_phases).toContainEqual(expect.objectContaining({
        phase_id: 'apply_control_plane',
        output_kind: 'governed_apply_request',
        status: 'blocked',
      }));

      const candidates = await handle.engine.listMemoryCandidateEntries({
        scope_id: 'workspace:default',
        limit: 100,
        offset: 0,
      });
      expect(candidates.filter((entry) => entry.generated_by === 'dream_cycle')).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });

  test('candidate writes remain governed Memory Inbox state, not truth', async () => {
    const handle = await allocateSqliteBrain('s31-candidate-only');

    try {
      await seedDuplicateCandidates(handle.engine);
      const result = await runDreamCycleMaintenance(handle.engine, {
        scope_id: 'workspace:default',
        now: '2026-04-23T12:00:00.000Z',
        limit: 2,
        write_candidates: true,
      });

      expect(result.canonical_write_allowed).toBe(false);
      expect(result.suggestions.every((entry) => entry.status === 'created')).toBe(true);

      for (const suggestion of result.suggestions) {
        const candidate = await handle.engine.getMemoryCandidateEntry(suggestion.candidate_id ?? '');
        expect(candidate).toMatchObject({
          generated_by: 'dream_cycle',
          status: 'candidate',
          scope_id: 'workspace:default',
        });
        expect(candidate?.source_refs.every((sourceRef) => sourceRef.startsWith('memory_candidate:'))).toBe(true);
      }
    } finally {
      await handle.teardown();
    }
  });

  test('apply-capable maintenance reuses realm session snapshot and ledger guards', async () => {
    const handle = await allocateSqliteBrain('s31-control-plane');

    try {
      const dryRunMutation = operationsByName.dry_run_memory_mutation;
      const targetId = await seedRealmSessionTarget(handle.engine, {
        session_id: 'session-ga-p6-allowed',
        realm_id: 'realm:ga-p6-allowed',
        access: 'read_write',
        target_hash: '1'.repeat(64),
      });

      const allowed = await dryRunMutation.handler(opContext(handle.engine), {
        session_id: 'session-ga-p6-allowed',
        realm_id: 'realm:ga-p6-allowed',
        operation: 'put_page',
        target_kind: 'page',
        target_id: targetId,
        source_refs: ['Source: S31 dry-run parity check'],
      }) as any;
      expect(allowed).toMatchObject({
        allowed: true,
        result: 'dry_run',
        ledger_recorded: true,
        policy_checks: {
          session_active: true,
          realm_active: true,
          attachment_read_write: true,
          target_snapshot_hash_matched: true,
        },
      });

      const conflict = await dryRunMutation.handler(opContext(handle.engine), {
        session_id: 'session-ga-p6-allowed',
        realm_id: 'realm:ga-p6-allowed',
        operation: 'put_page',
        target_kind: 'page',
        target_id: targetId,
        expected_target_snapshot_hash: '2'.repeat(64),
        source_refs: ['Source: S31 target snapshot conflict check'],
      }) as any;
      expect(conflict).toMatchObject({
        allowed: false,
        result: 'conflict',
        ledger_recorded: true,
        conflict_info: {
          reason: 'target_snapshot_hash_mismatch',
        },
      });

      const readOnlyTargetId = await seedRealmSessionTarget(handle.engine, {
        session_id: 'session-ga-p6-read-only',
        realm_id: 'realm:ga-p6-read-only',
        access: 'read_only',
        target_hash: '3'.repeat(64),
      });
      const denied = await dryRunMutation.handler(opContext(handle.engine), {
        session_id: 'session-ga-p6-read-only',
        realm_id: 'realm:ga-p6-read-only',
        operation: 'put_page',
        target_kind: 'page',
        target_id: readOnlyTargetId,
        source_refs: ['Source: S31 realm session denial check'],
      }) as any;
      expect(denied).toMatchObject({
        allowed: false,
        result: 'denied',
        ledger_recorded: true,
        policy_checks: {
          attachment_read_write: false,
        },
      });

      const events = await handle.engine.listMemoryMutationEvents({
        operation: 'dry_run_memory_mutation',
        limit: 20,
      });
      expect(events.map((entry) => entry.result).sort()).toEqual(['conflict', 'denied', 'dry_run']);

      const maintenance = await runDreamCycleMaintenance(handle.engine, {
        scope_id: 'workspace:default',
        now: '2026-04-23T12:00:00.000Z',
        limit: 1,
        write_candidates: false,
      });
      expect(maintenance.apply_control_plane).toMatchObject({
        allowed_without_control_plane: false,
        requires_active_realm_session: true,
        requires_mutation_ledger: true,
        requires_target_snapshot: true,
        dry_run_apply_validation_parity: true,
        redaction_fail_closed: true,
      });
      expect(maintenance.apply_control_plane.supported_operations).not.toContain('apply_memory_redaction_plan');
      expect(maintenance.apply_control_plane.supported_operations).not.toContain('record_memory_mutation_event');
    } finally {
      await handle.teardown();
    }
  });
});

async function seedDuplicateCandidates(engine: BrainEngine): Promise<void> {
  await seedCandidate(engine, {
    id: 'candidate-ga-p6-dup-a',
    proposed_content: 'Duplicate GA-P6 maintenance claim.',
    source_refs: ['S31 duplicate source A'],
    recurrence_score: 0.3,
  });
  await seedCandidate(engine, {
    id: 'candidate-ga-p6-dup-b',
    proposed_content: ' duplicate   ga-p6 maintenance claim. ',
    source_refs: ['S31 duplicate source B'],
    recurrence_score: 0.2,
  });
}

async function seedStalePromotedCandidate(engine: BrainEngine): Promise<void> {
  await seedCandidate(engine, {
    id: 'candidate-ga-p6-stale',
    proposed_content: 'A stale promoted GA-P6 maintenance claim.',
    source_refs: ['S31 stale source'],
  });
  await advanceMemoryCandidateStatus(engine, {
    id: 'candidate-ga-p6-stale',
    next_status: 'staged_for_review',
    review_reason: 'Prepared for GA-P6 stale validation.',
  });
  await promoteMemoryCandidateEntry(engine, {
    id: 'candidate-ga-p6-stale',
    reviewed_at: '2026-02-01T10:00:00.000Z',
    review_reason: 'Promoted before the GA-P6 review window.',
  });
  await recordCanonicalHandoff(engine, {
    candidate_id: 'candidate-ga-p6-stale',
    reviewed_at: '2026-02-01T10:05:00.000Z',
  });
}

async function seedCandidate(
  engine: BrainEngine,
  input: {
    id: string;
    proposed_content: string;
    source_refs: string[];
    recurrence_score?: number;
  },
): Promise<void> {
  await engine.createMemoryCandidateEntry({
    id: input.id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: input.proposed_content,
    source_refs: input.source_refs,
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.75,
    importance_score: 0.7,
    recurrence_score: input.recurrence_score ?? 0.1,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/ga-p6-maintenance',
    reviewed_at: null,
    review_reason: null,
  });
}

async function seedStaleContextMap(engine: BrainEngine): Promise<void> {
  await importFromContent(engine, 'systems/ga-p6-maintenance', [
    '---',
    'type: system',
    'title: GA-P6 Maintenance',
    '---',
    '# Overview',
    'See [[concepts/ga-p6-maintenance]].',
  ].join('\n'), { path: 'systems/ga-p6-maintenance.md' });
  await importFromContent(engine, 'concepts/ga-p6-maintenance', [
    '---',
    'type: concept',
    'title: GA-P6 Maintenance',
    '---',
    '# Purpose',
    'Derived freshness reports orient maintenance.',
  ].join('\n'), { path: 'concepts/ga-p6-maintenance.md' });
  await buildStructuralContextMapEntry(engine);
  await importFromContent(engine, 'concepts/ga-p6-maintenance', [
    '---',
    'type: concept',
    'title: GA-P6 Maintenance',
    '---',
    '# Purpose',
    'Derived freshness reports orient maintenance after source changes.',
  ].join('\n'), { path: 'concepts/ga-p6-maintenance.md' });
}

async function seedRealmSessionTarget(
  engine: BrainEngine,
  input: {
    session_id: string;
    realm_id: string;
    access: 'read_only' | 'read_write';
    target_hash: string;
  },
): Promise<string> {
  const targetId = `concepts/${input.session_id}-target`;
  await engine.upsertMemoryRealm({
    id: input.realm_id,
    name: `Realm ${input.realm_id}`,
    scope: 'work',
    default_access: 'read_write',
  });
  await engine.createMemorySession({
    id: input.session_id,
    actor_ref: 'agent:s31-ga-p6',
    expires_at: new Date('2999-01-01T00:00:00.000Z'),
  });
  await engine.attachMemoryRealmToSession({
    session_id: input.session_id,
    realm_id: input.realm_id,
    access: input.access,
    instructions: `S31 ${input.access} maintenance control-plane validation.`,
  });
  await engine.putPage(targetId, {
    type: 'concept',
    title: `Target ${input.session_id}`,
    compiled_truth: 'GA-P6 maintenance apply must not mutate without the control plane.',
    timeline: '- 2026-05-19 | Seeded for S31.',
    content_hash: input.target_hash,
  });
  return targetId;
}
