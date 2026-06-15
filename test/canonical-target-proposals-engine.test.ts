import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type {
  CanonicalTargetProposalEntryInput,
  MemoryCandidateEntryInput,
  MemoryMutationOperationName,
  MemoryMutationTargetKind,
} from '../src/core/types.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const tempPaths: string[] = [];
const PGLITE_ENGINE_CONTRACT_TIMEOUT_MS = 90_000;

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

async function createSqliteEngine(): Promise<BrainEngine> {
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(tempDir('mbrain-proposal-engine-'), 'brain.db') });
  await engine.initSchema();
  return engine;
}

async function createPgliteEngine(): Promise<BrainEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: tempDir('mbrain-proposal-engine-pglite-') });
  await engine.initSchema();
  return engine;
}

const engineFactories = [
  {
    label: 'sqlite',
    create: createSqliteEngine,
  },
  {
    label: 'pglite',
    create: createPgliteEngine,
    timeoutMs: PGLITE_ENGINE_CONTRACT_TIMEOUT_MS,
  },
];

function candidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'The new targetless candidate needs a canonical home.',
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
  sourceCandidateId = 'candidate-for-proposal',
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

for (const engineFactory of engineFactories) {
  const timeoutMs = engineFactory.timeoutMs;

  describe(`canonical target proposal engine contract (${engineFactory.label})`, () => {
  test('creates, gets, lists, and updates proposal entries', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-proposal'));

      const created = await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-1'));
      expect(created.id).toBe('proposal-1');
      expect(created.linked_candidate_ids).toEqual(['candidate-for-proposal']);
      expect(created.status).toBe('proposed');

      const fetched = await engine.getCanonicalTargetProposalEntry('proposal-1');
      expect(fetched?.proposed_slug).toBe('projects/mbrain/docs/canonical-target-proposals');

      const listed = await engine.listCanonicalTargetProposalEntries({
        scope_id: 'workspace:default',
        status: 'proposed',
        proposed_slug: 'projects/mbrain/docs/canonical-target-proposals',
      });
      expect(listed.map((entry) => entry.id)).toEqual(['proposal-1']);

      const updated = await engine.updateCanonicalTargetProposalStatus('proposal-1', {
        status: 'approved',
        expected_current_status: 'proposed',
        actor: 'test',
        review_reason: 'Approved target home.',
      });
      expect(updated?.status).toBe('approved');
      expect(updated?.approval_actor).toBe('test');

      const stale = await engine.updateCanonicalTargetProposalStatus('proposal-1', {
        status: 'bound',
        expected_current_status: 'proposed',
        review_reason: 'Should not apply from stale state.',
      });
      expect(stale).toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('rejects invalid proposal status transitions', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-invalid-transitions'));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-invalid-transitions',
        'candidate-for-invalid-transitions',
      ));

      const skippedApproval = await engine.updateCanonicalTargetProposalStatus('proposal-invalid-transitions', {
        status: 'bound',
        expected_current_status: 'proposed',
        bound_candidate_ids: ['candidate-for-invalid-transitions'],
        review_reason: 'Cannot bind before approval.',
      });
      expect(skippedApproval).toBeNull();

      const rejected = await engine.updateCanonicalTargetProposalStatus('proposal-invalid-transitions', {
        status: 'rejected',
        expected_current_status: 'proposed',
        actor: 'reviewer',
        review_reason: 'Rejected canonical home.',
      });
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.rejection_reason).toBe('Rejected canonical home.');

      const resurrected = await engine.updateCanonicalTargetProposalStatus('proposal-invalid-transitions', {
        status: 'approved',
        expected_current_status: 'rejected',
        actor: 'reviewer',
        review_reason: 'Rejected proposals cannot be approved later.',
      });
      expect(resurrected).toBeNull();

      const current = await engine.getCanonicalTargetProposalEntry('proposal-invalid-transitions');
      expect(current?.status).toBe('rejected');
      expect(current?.approval_actor).toBeNull();
      expect(current?.approved_at).toBeNull();
      expect(current?.approval_reason).toBeNull();
      expect(current?.rejection_reason).toBe('Rejected canonical home.');
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('refreshes draft payload fields without changing lifecycle metadata', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-draft-refresh'));
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-superseded-refresh'));
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-replacement-proposal'));
      await engine.createMemoryCandidateEntry(candidateInput('stub-patch-for-draft-refresh', {
        candidate_type: 'note_update',
        patch_target_kind: 'page',
        patch_target_id: 'projects/mbrain/docs/canonical-target-proposals',
        patch_body: { compiled_truth: 'Canonical Target Proposals' },
        patch_format: 'merge_patch',
        patch_operation_state: 'proposed',
        patch_risk_class: 'medium',
      }));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-replacement-for-refresh',
        'candidate-for-replacement-proposal',
      ));

      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-draft-refresh',
        'candidate-for-draft-refresh',
        {
          status: 'approved',
          approval_actor: 'reviewer',
          approved_at: new Date('2026-06-15T02:00:00.000Z'),
          approval_reason: 'Approved before draft refresh.',
          bound_candidate_ids: ['candidate-for-draft-refresh'],
          stub_patch_candidate_id: 'stub-patch-for-draft-refresh',
          stub_patch_state: 'proposed',
        },
      ));

      const refreshed = await engine.updateCanonicalTargetProposalDraft('proposal-draft-refresh', {
        expected_current_status: 'approved',
        status_reason: 'refreshed-classifier-note',
        proposal_kind: 'system_page',
        proposed_slug: 'systems/refreshed-draft-payload',
        proposed_title: 'Refreshed Draft Payload',
        proposed_page_type: 'system',
        proposed_repo_path: 'brain/systems/refreshed-draft-payload.md',
        confidence_score: 0.91,
        importance_score: 0.93,
        rationale: 'Refreshed rationale.',
        filing_basis: { namespace: 'systems' },
        source_refs: ['User, direct message, 2026-06-15 12:30 KST'],
        candidate_snapshot: { id: 'candidate-for-draft-refresh', refreshed: true },
        duplicate_review: { decision: 'possible_duplicate' },
        slug_quality_warnings: ['short-slug'],
      });

      expect(refreshed).toMatchObject({
        id: 'proposal-draft-refresh',
        status: 'approved',
        status_reason: 'refreshed-classifier-note',
        proposal_kind: 'system_page',
        proposed_slug: 'systems/refreshed-draft-payload',
        proposed_title: 'Refreshed Draft Payload',
        proposed_page_type: 'system',
        proposed_repo_path: 'brain/systems/refreshed-draft-payload.md',
        confidence_score: 0.91,
        importance_score: 0.93,
        rationale: 'Refreshed rationale.',
        filing_basis: { namespace: 'systems' },
        source_refs: ['User, direct message, 2026-06-15 12:30 KST'],
        candidate_snapshot: { id: 'candidate-for-draft-refresh', refreshed: true },
        duplicate_review: { decision: 'possible_duplicate' },
        slug_quality_warnings: ['short-slug'],
        approval_actor: 'reviewer',
        approval_reason: 'Approved before draft refresh.',
        bound_candidate_ids: ['candidate-for-draft-refresh'],
        stub_patch_candidate_id: 'stub-patch-for-draft-refresh',
        stub_patch_state: 'proposed',
        superseded_by: null,
      });
      expect(refreshed?.approved_at?.toISOString()).toBe('2026-06-15T02:00:00.000Z');

      const staleRefresh = await engine.updateCanonicalTargetProposalDraft('proposal-draft-refresh', {
        expected_current_status: 'proposed',
        proposed_title: 'Should Not Apply',
      });
      expect(staleRefresh).toBeNull();
      expect((await engine.getCanonicalTargetProposalEntry('proposal-draft-refresh'))?.proposed_title)
        .toBe('Refreshed Draft Payload');

      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-superseded-draft-refresh',
        'candidate-for-superseded-refresh',
        {
          status: 'superseded',
          superseded_by: 'proposal-replacement-for-refresh',
        },
      ));
      const supersededRefresh = await engine.updateCanonicalTargetProposalDraft(
        'proposal-superseded-draft-refresh',
        {
          expected_current_status: 'superseded',
          proposed_title: 'Superseded Draft Payload Refresh',
          status_reason: 'historical-refresh',
        },
      );
      expect(supersededRefresh?.status).toBe('superseded');
      expect(supersededRefresh?.superseded_by).toBe('proposal-replacement-for-refresh');
      expect(supersededRefresh?.proposed_title).toBe('Superseded Draft Payload Refresh');
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('does not fabricate approval metadata during staging or binding transitions', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-approval-metadata'));
      await engine.createMemoryCandidateEntry(candidateInput('stub-patch-candidate', {
        candidate_type: 'note_update',
        patch_target_kind: 'page',
        patch_target_id: 'projects/mbrain/docs/canonical-target-proposals',
        patch_body: { compiled_truth: 'Canonical Target Proposals' },
        patch_format: 'merge_patch',
        patch_operation_state: 'proposed',
        patch_risk_class: 'medium',
      }));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-approval-metadata',
        'candidate-for-approval-metadata',
        {
          status: 'approved',
          approval_actor: null,
          approved_at: null,
          approval_reason: null,
        },
      ));

      const staged = await engine.updateCanonicalTargetProposalStatus('proposal-approval-metadata', {
        status: 'patch_staged',
        expected_current_status: 'approved',
        actor: 'stub-writer',
        review_reason: 'Staged missing-page patch.',
        stub_patch_candidate_id: 'stub-patch-candidate',
        stub_patch_state: 'proposed',
      });
      expect(staged?.status).toBe('patch_staged');
      expect(staged?.approval_actor).toBeNull();
      expect(staged?.approved_at).toBeNull();
      expect(staged?.approval_reason).toBeNull();

      const bound = await engine.updateCanonicalTargetProposalStatus('proposal-approval-metadata', {
        status: 'bound',
        expected_current_status: 'patch_staged',
        actor: 'binder',
        review_reason: 'Bound eligible candidates.',
        bound_candidate_ids: ['candidate-for-approval-metadata'],
      });
      expect(bound?.status).toBe('bound');
      expect(bound?.approval_actor).toBeNull();
      expect(bound?.approved_at).toBeNull();
      expect(bound?.approval_reason).toBeNull();

      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-existing-approval-metadata'));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-existing-approval-metadata',
        'candidate-for-existing-approval-metadata',
        {
          status: 'approved',
          approval_actor: 'reviewer',
          approved_at: new Date('2026-06-15T02:00:00.000Z'),
          approval_reason: 'Approved by reviewer.',
        },
      ));
      const stagedWithExistingApproval = await engine.updateCanonicalTargetProposalStatus(
        'proposal-existing-approval-metadata',
        {
          status: 'patch_staged',
          expected_current_status: 'approved',
          actor: 'stub-writer',
          review_reason: 'Staged missing-page patch.',
          stub_patch_candidate_id: 'stub-patch-candidate',
          stub_patch_state: 'proposed',
        },
      );
      expect(stagedWithExistingApproval?.approval_actor).toBe('reviewer');
      expect(stagedWithExistingApproval?.approved_at?.toISOString()).toBe('2026-06-15T02:00:00.000Z');
      expect(stagedWithExistingApproval?.approval_reason).toBe('Approved by reviewer.');

      const boundWithExistingApproval = await engine.updateCanonicalTargetProposalStatus(
        'proposal-existing-approval-metadata',
        {
          status: 'bound',
          expected_current_status: 'patch_staged',
          actor: 'binder',
          review_reason: 'Bound eligible candidates.',
          bound_candidate_ids: ['candidate-for-existing-approval-metadata'],
        },
      );
      expect(boundWithExistingApproval?.approval_actor).toBe('reviewer');
      expect(boundWithExistingApproval?.approved_at?.toISOString()).toBe('2026-06-15T02:00:00.000Z');
      expect(boundWithExistingApproval?.approval_reason).toBe('Approved by reviewer.');
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('does not reuse status reason as rejection provenance without review context', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-for-rejection-provenance'));
      await engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-rejection-provenance',
        'candidate-for-rejection-provenance',
        {
          status_reason: 'preexisting classifier note',
        },
      ));

      const rejected = await engine.updateCanonicalTargetProposalStatus('proposal-rejection-provenance', {
        status: 'rejected',
        expected_current_status: 'proposed',
      });
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.status_reason).toBe('preexisting classifier note');
      expect(rejected?.rejection_reason).toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('keeps omitted linked candidate ids as an empty list', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate-with-empty-linked-proposal'));
      const input = proposalInput('proposal-empty-linked', 'candidate-with-empty-linked-proposal');
      delete input.linked_candidate_ids;

      const created = await engine.createCanonicalTargetProposalEntry(input);
      expect(created.linked_candidate_ids).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('records and lists proposal status events', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('status-event-candidate'));
      await engine.createCanonicalTargetProposalEntry(proposalInput('proposal-status-events', 'status-event-candidate'));

      await engine.createCanonicalTargetProposalStatusEvent({
        id: 'proposal-status-event-1',
        proposal_id: 'proposal-status-events',
        scope_id: 'workspace:default',
        from_status: null,
        to_status: 'proposed',
        event_kind: 'created',
        actor: 'test',
        review_reason: 'Created for status-event test.',
      });

      const events = await engine.listCanonicalTargetProposalStatusEvents({
        proposal_id: 'proposal-status-events',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.event_kind).toBe('created');
      expect(events[0]?.actor).toBe('test');
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('binds candidate target with unresolved-shape preconditions', async () => {
    const engine = await engineFactory.create();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('bindable-candidate', {
        target_object_type: 'curated_note',
        target_object_id: null,
      }));

      const bound = await engine.bindMemoryCandidateTarget('bindable-candidate', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: 'curated_note',
        expected_current_target_object_id: null,
        reviewed_at: new Date('2026-06-15T03:00:00.000Z'),
        review_reason: 'Bound by canonical target proposal.',
      });
      expect(bound?.status).toBe('captured');
      expect(bound?.target_object_id).toBe('projects/mbrain/docs/canonical-target-proposals');
      expect(bound?.review_reason).toBe('Bound by canonical target proposal.');

      const stale = await engine.bindMemoryCandidateTarget('bindable-candidate', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/other',
        expected_current_target_object_type: 'curated_note',
        expected_current_target_object_id: null,
      });
      expect(stale).toBeNull();

      await engine.createMemoryCandidateEntry(candidateInput('terminal-candidate', {
        status: 'staged_for_review',
      }));

      const omittedExpectedShape = await engine.bindMemoryCandidateTarget('bindable-candidate', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/other',
      } as any);
      expect(omittedExpectedShape).toBeNull();

      await engine.updateMemoryCandidateEntryStatus('terminal-candidate', {
        status: 'rejected',
        reviewed_at: new Date('2026-06-15T03:05:00.000Z'),
        review_reason: 'Terminal candidates cannot bind targets.',
      });
      const terminal = await engine.bindMemoryCandidateTarget('terminal-candidate', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: null,
        expected_current_target_object_id: null,
      });
      expect(terminal).toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('records canonical target proposal mutation ledger operations', async () => {
    const engine = await engineFactory.create();
    try {
      const operations: Array<{
        operation: MemoryMutationOperationName;
        target_kind: MemoryMutationTargetKind;
        target_id: string;
      }> = [
        {
          operation: 'create_canonical_target_proposal',
          target_kind: 'canonical_target_proposal',
          target_id: 'proposal-ledger-create',
        },
        {
          operation: 'approve_canonical_target_proposal',
          target_kind: 'canonical_target_proposal',
          target_id: 'proposal-ledger-approve',
        },
        {
          operation: 'reject_canonical_target_proposal',
          target_kind: 'canonical_target_proposal',
          target_id: 'proposal-ledger-reject',
        },
        {
          operation: 'complete_canonical_target_proposal_binding',
          target_kind: 'canonical_target_proposal',
          target_id: 'proposal-ledger-complete',
        },
        {
          operation: 'bind_memory_candidate_target',
          target_kind: 'memory_candidate',
          target_id: 'candidate-ledger-bind',
        },
      ];

      for (const item of operations) {
        await engine.createMemoryMutationEvent({
          id: `ledger-${item.operation}`,
          session_id: 'session-ledger',
          realm_id: 'realm-ledger',
          actor: 'test',
          operation: item.operation,
          target_kind: item.target_kind,
          target_id: item.target_id,
          scope_id: 'workspace:default',
          source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
          result: 'approved',
        });
      }

      const events = await engine.listMemoryMutationEvents({
        scope_id: 'workspace:default',
        limit: 10,
      });
      expect(events.map((event) => event.operation)).toEqual(expect.arrayContaining(
        operations.map((item) => item.operation),
      ));
      expect(events.some((event) => event.target_kind === 'canonical_target_proposal')).toBe(true);
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);

  test('allows patch candidates to target canonical target proposals', async () => {
    const engine = await engineFactory.create();
    try {
      const created = await engine.createMemoryCandidateEntry(candidateInput('proposal-patch-candidate', {
        candidate_type: 'note_update',
        patch_target_kind: 'canonical_target_proposal',
        patch_target_id: 'proposal-for-stub',
        patch_base_target_snapshot_hash: null,
        patch_body: { proposed_slug: 'projects/mbrain/docs/canonical-target-proposals' },
        patch_format: 'operation',
        patch_operation_state: 'proposed',
        patch_risk_class: 'medium',
      }));

      expect(created.patch_target_kind).toBe('canonical_target_proposal');
      expect(created.patch_target_id).toBe('proposal-for-stub');
    } finally {
      await engine.disconnect();
    }
  }, timeoutMs);
  });
}
