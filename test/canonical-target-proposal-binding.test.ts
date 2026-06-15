import { describe, expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  bindMemoryCandidateTargetGoverned,
  CanonicalTargetProposalReviewServiceError,
} from '../src/core/services/canonical-target-proposal-review-service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

async function createEngine(): Promise<SQLiteEngine> {
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
  await engine.initSchema();
  return engine;
}

function candidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'The targetless candidate needs a canonical home.',
    source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: null,
    target_object_id: null,
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  };
}

async function seedMutationContext(engine: BrainEngine): Promise<void> {
  await engine.createMemorySession({
    id: 'session-review',
    task_id: 'task-review',
    actor_ref: 'agent:test',
  });
  await engine.upsertMemoryRealm({
    id: 'realm-review',
    name: 'Review Realm',
    scope: 'work',
    default_access: 'read_write',
  });
  await engine.attachMemoryRealmToSession({
    session_id: 'session-review',
    realm_id: 'realm-review',
    access: 'read_write',
  });
}

describe('canonical target proposal governed candidate binding', () => {
  test('binds a candidate target without changing candidate status and records audit events', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-bind', {
        status: 'candidate',
        target_object_type: 'curated_note',
      }));
      await engine.createCanonicalTargetProposalEntry({
        id: 'proposal-bind',
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate-bind',
        linked_candidate_ids: ['candidate-bind'],
        status: 'approved',
        proposal_kind: 'project_doc',
        target_object_type: 'curated_note',
        proposed_slug: 'projects/mbrain/docs/canonical-target-proposals',
        proposed_title: 'Canonical Target Proposals',
        proposed_page_type: 'project',
        confidence_score: 0.8,
        importance_score: 0.8,
        rationale: 'Fixture proposal.',
        source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
      });

      const result = await bindMemoryCandidateTargetGoverned(engine, {
        candidate_id: 'candidate-bind',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: 'curated_note',
        expected_current_target_object_id: null,
        session_id: 'session-review',
        realm_id: 'realm-review',
        actor: 'reviewer',
        source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
        review_reason: 'Bound through canonical target proposal review.',
        proposal_id: 'proposal-bind',
      });

      expect(result.candidate.status).toBe('candidate');
      expect(result.candidate.target_object_id).toBe('projects/mbrain/docs/canonical-target-proposals');

      const candidateEvents = await engine.listMemoryCandidateStatusEvents({
        candidate_id: 'candidate-bind',
      });
      expect(candidateEvents).toHaveLength(1);
      expect(candidateEvents[0]).toMatchObject({
        from_status: 'candidate',
        to_status: 'candidate',
        event_kind: 'advanced',
        review_reason: 'Bound through canonical target proposal review.',
      });

      const mutationEvents = await engine.listMemoryMutationEvents({
        operation: 'bind_memory_candidate_target',
        target_id: 'candidate-bind',
      });
      expect(mutationEvents).toHaveLength(1);
      expect(mutationEvents[0]).toMatchObject({
        result: 'applied',
        target_kind: 'memory_candidate',
        target_id: 'candidate-bind',
      });
    } finally {
      await engine.disconnect();
    }
  });

  test('rejects stale target shapes without recording misleading audit events', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-stale-bind', {
        target_object_type: 'other',
      }));
      await engine.createCanonicalTargetProposalEntry({
        id: 'proposal-stale-bind',
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate-stale-bind',
        linked_candidate_ids: ['candidate-stale-bind'],
        status: 'approved',
        proposal_kind: 'project_doc',
        target_object_type: 'curated_note',
        proposed_slug: 'projects/mbrain/docs/canonical-target-proposals',
        proposed_title: 'Canonical Target Proposals',
        proposed_page_type: 'project',
        confidence_score: 0.8,
        importance_score: 0.8,
        rationale: 'Fixture proposal.',
        source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
      });

      await expect(bindMemoryCandidateTargetGoverned(engine, {
        candidate_id: 'candidate-stale-bind',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: 'curated_note',
        expected_current_target_object_id: null,
        proposal_id: 'proposal-stale-bind',
        session_id: 'session-review',
        realm_id: 'realm-review',
        actor: 'reviewer',
        source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
      })).rejects.toMatchObject({
        code: 'invalid_status_transition',
      } satisfies Partial<CanonicalTargetProposalReviewServiceError>);

      expect(await engine.listMemoryCandidateStatusEvents({
        candidate_id: 'candidate-stale-bind',
      })).toHaveLength(0);
      expect(await engine.listMemoryMutationEvents({
        operation: 'bind_memory_candidate_target',
        target_id: 'candidate-stale-bind',
      })).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('requires an approved proposal and eligible linked candidate before direct binding', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-no-proposal'));
      await engine.createMemoryCandidateEntry(candidateInput('candidate-secret', {
        sensitivity: 'secret',
      }));
      await engine.createCanonicalTargetProposalEntry({
        id: 'proposal-secret',
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate-secret',
        linked_candidate_ids: ['candidate-secret'],
        status: 'approved',
        proposal_kind: 'project_doc',
        target_object_type: 'curated_note',
        proposed_slug: 'projects/mbrain/docs/canonical-target-proposals',
        proposed_title: 'Canonical Target Proposals',
        proposed_page_type: 'project',
        confidence_score: 0.8,
        importance_score: 0.8,
        rationale: 'Fixture proposal.',
        source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
      });

      await expect(bindMemoryCandidateTargetGoverned(engine, {
        candidate_id: 'candidate-no-proposal',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: null,
        expected_current_target_object_id: null,
        proposal_id: '',
        session_id: 'session-review',
        realm_id: 'realm-review',
        actor: 'reviewer',
        source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
      })).rejects.toMatchObject({ code: 'invalid_params' });

      await expect(bindMemoryCandidateTargetGoverned(engine, {
        candidate_id: 'candidate-secret',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: null,
        expected_current_target_object_id: null,
        proposal_id: 'proposal-secret',
        session_id: 'session-review',
        realm_id: 'realm-review',
        actor: 'reviewer',
        source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
      })).rejects.toMatchObject({ code: 'candidate_not_eligible' });

      expect((await engine.getMemoryCandidateEntry('candidate-no-proposal'))?.target_object_id).toBeNull();
      expect((await engine.getMemoryCandidateEntry('candidate-secret'))?.target_object_id).toBeNull();
      expect(await engine.listMemoryMutationEvents({
        operation: 'bind_memory_candidate_target',
      })).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });
});
