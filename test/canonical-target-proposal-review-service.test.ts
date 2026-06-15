import { describe, expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  approveCanonicalTargetProposal,
  completeCanonicalTargetProposalBinding,
  rejectCanonicalTargetProposal,
} from '../src/core/services/canonical-target-proposal-review-service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type {
  CanonicalTargetProposalEntryInput,
  MemoryCandidateEntryInput,
} from '../src/core/types.ts';

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

function proposalInput(
  id: string,
  sourceCandidateId: string,
  overrides: Partial<CanonicalTargetProposalEntryInput> = {},
): CanonicalTargetProposalEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    source_candidate_id: sourceCandidateId,
    linked_candidate_ids: [sourceCandidateId],
    status: 'proposed',
    status_reason: null,
    proposal_kind: 'project_doc',
    target_object_type: 'curated_note',
    proposed_slug: 'projects/mbrain/docs/canonical-target-proposals',
    proposed_title: 'Canonical Target Proposals',
    proposed_page_type: 'project',
    proposed_repo_path: null,
    confidence_score: 0.82,
    importance_score: 0.87,
    rationale: 'The candidate describes durable project knowledge without a canonical home.',
    filing_basis: { namespace: 'projects' },
    source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
    candidate_snapshot: { id: sourceCandidateId },
    duplicate_review: { decision: 'no_match' },
    slug_quality_warnings: [],
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

const reviewContext = {
  session_id: 'session-review',
  realm_id: 'realm-review',
  actor: 'reviewer',
  source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
  review_reason: 'Reviewed canonical target proposal.',
};

describe('canonical target proposal review service', () => {
  test('approves an existing page proposal and binds all candidates atomically', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-primary'));
      await engine.createMemoryCandidateEntry(candidateInput('candidate-linked', {
        target_object_type: 'curated_note',
      }));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-existing', 'candidate-primary', {
        linked_candidate_ids: ['candidate-primary', 'candidate-linked'],
      }));

      const result = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-existing',
        create_missing_page_stub: false,
        ...reviewContext,
      });

      expect(result.kind).toBe('bound');
      expect(result.proposal.status).toBe('bound');
      expect(result.proposal.bound_candidate_ids).toEqual(['candidate-primary', 'candidate-linked']);
      expect((await engine.getMemoryCandidateEntry('candidate-primary'))?.target_object_id)
        .toBe('projects/mbrain/docs/canonical-target-proposals');
      expect((await engine.getMemoryCandidateEntry('candidate-linked'))?.target_object_id)
        .toBe('projects/mbrain/docs/canonical-target-proposals');

      expect((await engine.listCanonicalTargetProposalStatusEvents({
        proposal_id: 'proposal-existing',
      })).map((event) => event.event_kind)).toEqual(expect.arrayContaining(['approved', 'bound']));
      expect((await engine.listMemoryMutationEvents({
        target_kind: 'canonical_target_proposal',
        target_id: 'proposal-existing',
      })).map((event) => event.operation)).toEqual(expect.arrayContaining([
        'approve_canonical_target_proposal',
        'complete_canonical_target_proposal_binding',
      ]));
    } finally {
      await engine.disconnect();
    }
  });

  test('blocks approval when linked candidate revalidation fails and binds none', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-safe'));
      await engine.createMemoryCandidateEntry(candidateInput('candidate-drifted', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/other',
      }));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-blocked', 'candidate-safe', {
        linked_candidate_ids: ['candidate-safe', 'candidate-drifted'],
      }));

      const result = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-blocked',
        create_missing_page_stub: false,
        ...reviewContext,
      });

      expect(result.kind).toBe('blocked');
      expect(result.proposal.status).toBe('blocked');
      expect(result.proposal.status_reason).toBe('target_shape_drift');
      expect((await engine.getMemoryCandidateEntry('candidate-safe'))?.target_object_id).toBeNull();
      expect((await engine.getMemoryCandidateEntry('candidate-drifted'))?.target_object_id)
        .toBe('projects/mbrain/docs/other');
      expect(await engine.listMemoryMutationEvents({
        operation: 'bind_memory_candidate_target',
      })).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('approval without stub creation leaves a missing-page proposal approved but unbound', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-missing-page'));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-missing-page', 'candidate-missing-page'));

      const approved = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-missing-page',
        create_missing_page_stub: false,
        ...reviewContext,
      });
      expect(approved.kind).toBe('approved_pending');
      expect(approved.proposal.status).toBe('approved');

      const completion = await completeCanonicalTargetProposalBinding(engine, {
        proposal_id: 'proposal-missing-page',
        require_stub_patch_applied: false,
        ...reviewContext,
      });
      expect(completion.kind).toBe('pending');
      expect(completion.proposal.status).toBe('approved');
      expect((await engine.getMemoryCandidateEntry('candidate-missing-page'))?.target_object_id).toBeNull();
    } finally {
      await engine.disconnect();
    }
  });

  test('approval with stub creation stages a structural patch without writing a page', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-stub'));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-stub', 'candidate-stub'));

      const result = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-stub',
        create_missing_page_stub: true,
        ...reviewContext,
      });

      expect(result.kind).toBe('patch_staged');
      if (result.kind !== 'patch_staged') {
        throw new Error(`Expected patch_staged result, got ${result.kind}`);
      }
      expect(result.proposal.status).toBe('patch_staged');
      expect(result.stub_patch_candidate.patch_target_kind).toBe('page');
      expect(result.stub_patch_candidate.patch_target_id).toBe('projects/mbrain/docs/canonical-target-proposals');
      expect(result.stub_patch_candidate.patch_base_target_snapshot_hash).toBeNull();
      expect(result.stub_patch_candidate.patch_ledger_event_ids).toHaveLength(1);
      expect(result.stub_patch_candidate.patch_body).toMatchObject({
        type: 'project',
        title: 'Canonical Target Proposals',
      });
      expect(String((result.stub_patch_candidate.patch_body as Record<string, unknown>).compiled_truth))
        .not.toContain('The targetless candidate needs a canonical home');
      expect(String((result.stub_patch_candidate.patch_body as Record<string, unknown>).timeline))
        .toContain('[Source: User, direct message, 2026-06-15 12:00 KST]');
      expect(await engine.getPage('projects/mbrain/docs/canonical-target-proposals')).toBeNull();
    } finally {
      await engine.disconnect();
    }
  });

  test('approval rejects invalid slug overrides before staging or binding', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-invalid-override'));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-invalid-override',
        'candidate-invalid-override',
      ));

      await expect(approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-invalid-override',
        create_missing_page_stub: true,
        proposed_slug: '///',
        ...reviewContext,
      })).rejects.toMatchObject({ code: 'invalid_params' });

      await expect(approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-invalid-override',
        create_missing_page_stub: true,
        proposed_slug: 'systems/not-a-project-doc',
        ...reviewContext,
      })).rejects.toMatchObject({ code: 'invalid_params' });

      expect((await engine.getCanonicalTargetProposalEntry('proposal-invalid-override'))?.status)
        .toBe('proposed');
    } finally {
      await engine.disconnect();
    }
  });

  test('approval with stub requested binds when the target page already exists', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.putPage('projects/mbrain/docs/page-race', {
        type: 'project',
        title: 'Page Race',
        compiled_truth: 'Page appeared before stub staging.',
      });
      await engine.createMemoryCandidateEntry(candidateInput('candidate-page-race'));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-page-race',
        'candidate-page-race',
        {
          proposed_slug: 'projects/mbrain/docs/page-race',
          proposed_title: 'Page Race',
        },
      ));

      const result = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-page-race',
        create_missing_page_stub: true,
        ...reviewContext,
      });

      expect(result.kind).toBe('bound');
      expect((await engine.getMemoryCandidateEntry('candidate-page-race'))?.target_object_id)
        .toBe('projects/mbrain/docs/page-race');
      expect(await engine.listMemoryCandidateEntries({
        patch_target_kind: 'page',
        patch_target_id: 'projects/mbrain/docs/page-race',
      })).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('approval slug overrides persist through patch-staged completion', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-stub-override'));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-stub-override', 'candidate-stub-override'));

      const staged = await approveCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-stub-override',
        create_missing_page_stub: true,
        proposed_slug: 'projects/mbrain/docs/stub-override',
        proposed_title: 'Stub Override',
        ...reviewContext,
      });
      expect(staged.kind).toBe('patch_staged');
      if (staged.kind !== 'patch_staged') {
        throw new Error(`Expected patch_staged result, got ${staged.kind}`);
      }
      expect(staged.proposal.proposed_slug).toBe('projects/mbrain/docs/stub-override');

      await engine.updateMemoryCandidatePatchOperationState(staged.stub_patch_candidate.id, {
        patch_operation_state: 'applied',
        expected_current_status: 'staged_for_review',
        expected_current_patch_operation_state: 'proposed',
      });
      await engine.putPage('projects/mbrain/docs/stub-override', {
        type: 'project',
        title: 'Stub Override',
        compiled_truth: 'Stub page applied.',
      });

      const completed = await completeCanonicalTargetProposalBinding(engine, {
        proposal_id: 'proposal-stub-override',
        require_stub_patch_applied: true,
        ...reviewContext,
      });

      expect(completed.kind).toBe('bound');
      expect(completed.proposal.proposed_slug).toBe('projects/mbrain/docs/stub-override');
      expect((await engine.getMemoryCandidateEntry('candidate-stub-override'))?.target_object_id)
        .toBe('projects/mbrain/docs/stub-override');
    } finally {
      await engine.disconnect();
    }
  });

  test('completion binds a patch-staged proposal after the stub patch is applied', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-patch-complete'));
      await engine.createMemoryCandidateEntry(candidateInput('stub-patch-applied', {
        status: 'staged_for_review',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        patch_target_kind: 'page',
        patch_target_id: 'projects/mbrain/docs/canonical-target-proposals',
        patch_base_target_snapshot_hash: null,
        patch_body: { compiled_truth: 'Stub.' },
        patch_format: 'merge_patch',
        patch_operation_state: 'applied',
      }));
      await engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Stub page applied.',
      });
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-patch-complete', 'candidate-patch-complete', {
        status: 'patch_staged',
        stub_patch_candidate_id: 'stub-patch-applied',
        stub_patch_state: 'proposed',
      }));

      const completed = await completeCanonicalTargetProposalBinding(engine, {
        proposal_id: 'proposal-patch-complete',
        require_stub_patch_applied: true,
        ...reviewContext,
      });

      expect(completed.kind).toBe('bound');
      expect(completed.proposal.status).toBe('bound');
      expect((await engine.getMemoryCandidateEntry('candidate-patch-complete'))?.target_object_id)
        .toBe('projects/mbrain/docs/canonical-target-proposals');
    } finally {
      await engine.disconnect();
    }
  });

  test('completion blocks failed staged patches and rejects proposals explicitly', async () => {
    const engine = await createEngine();
    try {
      await seedMutationContext(engine);
      await engine.createMemoryCandidateEntry(candidateInput('candidate-patch-failed'));
      await engine.createMemoryCandidateEntry(candidateInput('stub-patch-failed', {
        status: 'staged_for_review',
        patch_target_kind: 'page',
        patch_target_id: 'projects/mbrain/docs/canonical-target-proposals',
        patch_base_target_snapshot_hash: null,
        patch_body: { compiled_truth: 'Stub.' },
        patch_format: 'merge_patch',
        patch_operation_state: 'failed',
      }));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-patch-failed', 'candidate-patch-failed', {
        status: 'patch_staged',
        stub_patch_candidate_id: 'stub-patch-failed',
      }));

      const blocked = await completeCanonicalTargetProposalBinding(engine, {
        proposal_id: 'proposal-patch-failed',
        require_stub_patch_applied: true,
        ...reviewContext,
      });
      expect(blocked.kind).toBe('blocked');
      expect(blocked.proposal.status_reason).toBe('stub_patch_failed');
      expect((await engine.listMemoryMutationEvents({
        target_kind: 'canonical_target_proposal',
        target_id: 'proposal-patch-failed',
      })).map((event) => event.operation)).toContain('complete_canonical_target_proposal_binding');

      await engine.createMemoryCandidateEntry(candidateInput('candidate-reject'));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-reject', 'candidate-reject'));
      const rejected = await rejectCanonicalTargetProposal(engine, {
        proposal_id: 'proposal-reject',
        ...reviewContext,
      });
      expect(rejected.proposal.status).toBe('rejected');
      expect((await engine.listCanonicalTargetProposalStatusEvents({
        proposal_id: 'proposal-reject',
      }))[0]?.event_kind).toBe('rejected');
    } finally {
      await engine.disconnect();
    }
  });
});
