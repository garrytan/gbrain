import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  dispatchOperation,
  OperationError,
  operations,
  type Operation,
  type OperationContext,
} from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type {
  CanonicalTargetProposalEntryInput,
  MemoryCandidateEntryInput,
} from '../src/core/types.ts';

const expectedCliNames = {
  create_canonical_target_proposal: 'create-canonical-target-proposal',
  list_canonical_target_proposals: 'list-canonical-target-proposals',
  approve_canonical_target_proposal: 'approve-canonical-target-proposal',
  reject_canonical_target_proposal: 'reject-canonical-target-proposal',
  complete_canonical_target_proposal_binding: 'complete-canonical-target-proposal-binding',
  bind_memory_candidate_target: 'bind-memory-candidate-target',
} as const;

function getOperation(name: keyof typeof expectedCliNames): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

async function createHarness(label: string): Promise<{
  engine: SQLiteEngine;
  ctx: OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-canonical-target-proposal-ops-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: {
      engine,
      config: {
        engine: 'sqlite',
        database_path: databasePath,
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      },
      logger: console,
      dryRun: false,
    },
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function candidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'The MBrain canonical proposal work should be tracked in the MBrain project docs.',
    source_refs: ['User, direct message, 2026-06-15 12:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.86,
    importance_score: 0.82,
    recurrence_score: 0.28,
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

const reviewParams = {
  session_id: 'session-review',
  realm_id: 'realm-review',
  actor: 'reviewer',
  source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
  review_reason: 'Reviewed canonical target proposal.',
};

describe('canonical target proposal operations', () => {
  test('registers operation names with kebab-case CLI hints', () => {
    for (const [operationName, cliName] of Object.entries(expectedCliNames)) {
      const operation = getOperation(operationName as keyof typeof expectedCliNames);
      expect(operation.name).toBe(operationName);
      expect(operation.cliHints?.name).toBe(cliName);
    }

    expect(getOperation('create_canonical_target_proposal').mutating).toBe(true);
    expect(getOperation('list_canonical_target_proposals').mutating).not.toBe(true);
    expect(getOperation('approve_canonical_target_proposal').mutating).toBe(true);
    expect(getOperation('reject_canonical_target_proposal').mutating).toBe(true);
    expect(getOperation('complete_canonical_target_proposal_binding').mutating).toBe(true);
    expect(getOperation('bind_memory_candidate_target').mutating).toBe(true);
  });

  test('lists proposals with status, source candidate, slug, limit, and offset filters', async () => {
    const harness = await createHarness('list-filters');
    try {
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-alpha'));
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-beta'));
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-gamma'));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput('proposal-alpha', 'candidate-alpha', {
        proposed_slug: 'projects/mbrain/docs/alpha',
        proposed_title: 'Alpha',
      }));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput('proposal-beta', 'candidate-beta', {
        status: 'blocked',
        status_reason: 'fixture',
        proposed_slug: 'projects/mbrain/docs/beta',
        proposed_title: 'Beta',
      }));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput('proposal-gamma', 'candidate-gamma', {
        proposed_slug: 'projects/mbrain/docs/gamma',
        proposed_title: 'Gamma',
      }));

      const list = getOperation('list_canonical_target_proposals');

      expect((await list.handler(harness.ctx, {
        status: 'blocked',
        limit: 10,
      }) as any[]).map((entry) => entry.id)).toEqual(['proposal-beta']);

      expect((await list.handler(harness.ctx, {
        source_candidate_id: 'candidate-alpha',
        limit: 10,
      }) as any[]).map((entry) => entry.id)).toEqual(['proposal-alpha']);

      expect((await list.handler(harness.ctx, {
        proposed_slug: 'projects/mbrain/docs/gamma',
        limit: 10,
      }) as any[]).map((entry) => entry.id)).toEqual(['proposal-gamma']);

      const firstProposedPage = (await list.handler(harness.ctx, {
        status: 'proposed',
        limit: 1,
        offset: 0,
      }) as any[]).map((entry) => entry.id);
      const secondProposedPage = (await list.handler(harness.ctx, {
        status: 'proposed',
        limit: 1,
        offset: 1,
      }) as any[]).map((entry) => entry.id);
      expect(firstProposedPage).toHaveLength(1);
      expect(secondProposedPage).toHaveLength(1);
      expect(firstProposedPage[0]).not.toBe(secondProposedPage[0]);
      expect(['proposal-alpha', 'proposal-gamma']).toContain(firstProposedPage[0]);
      expect(['proposal-alpha', 'proposal-gamma']).toContain(secondProposedPage[0]);
    } finally {
      await harness.cleanup();
    }
  });

  test('creates proposals with slug, kind, title, and review reason overrides', async () => {
    const harness = await createHarness('create-overrides');
    try {
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-create-override'));
      const create = getOperation('create_canonical_target_proposal');

      const result = await create.handler(harness.ctx, {
        candidate_id: 'candidate-create-override',
        proposed_slug: 'projects/mbrain/docs/operation-overrides',
        proposal_kind: 'project_doc',
        proposed_title: 'Operation Overrides',
        review_reason: 'Reviewer supplied the exact canonical home.',
        apply: true,
      }) as any;

      expect(result.kind).toBe('created');
      expect(result.proposal).toMatchObject({
        source_candidate_id: 'candidate-create-override',
        proposed_slug: 'projects/mbrain/docs/operation-overrides',
        proposal_kind: 'project_doc',
        proposed_title: 'Operation Overrides',
      });

      const events = await harness.engine.listCanonicalTargetProposalStatusEvents({
        proposal_id: result.proposal.id,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_kind: 'created',
        review_reason: 'Reviewer supplied the exact canonical home.',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('approval accepts optional slug and title overrides for missing-page stubs', async () => {
    const harness = await createHarness('approve-overrides');
    try {
      await seedMutationContext(harness.engine);
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-approve-override'));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-approve-override',
        'candidate-approve-override',
      ));
      const approve = getOperation('approve_canonical_target_proposal');

      const result = await approve.handler(harness.ctx, {
        proposal_id: 'proposal-approve-override',
        create_missing_page_stub: true,
        proposed_slug: 'projects/mbrain/docs/approved-override',
        proposed_title: 'Approved Override',
        ...reviewParams,
      }) as any;

      expect(result.kind).toBe('patch_staged');
      expect(result.stub_patch_candidate.patch_target_id).toBe('projects/mbrain/docs/approved-override');
      expect(result.stub_patch_candidate.patch_body.title).toBe('Approved Override');

      const events = await harness.engine.listMemoryMutationEvents({
        operation: 'approve_canonical_target_proposal',
        target_id: 'proposal-approve-override',
      });
      expect(events[0].metadata.proposed_slug).toBe('projects/mbrain/docs/approved-override');
      expect(events[0].metadata.create_missing_page_stub).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  test('complete binding exposes require_stub_patch_applied as a contract parameter', async () => {
    const complete = getOperation('complete_canonical_target_proposal_binding');
    expect(complete.params.require_stub_patch_applied).toMatchObject({
      type: 'boolean',
    });
  });

  test('binds a candidate target through the governed operation', async () => {
    const harness = await createHarness('bind-candidate-target');
    try {
      await seedMutationContext(harness.engine);
      await harness.engine.putPage('projects/mbrain/docs/canonical-target-proposals', {
        type: 'project',
        title: 'Canonical Target Proposals',
        compiled_truth: 'Existing project page.',
      });
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-bind-operation', {
        target_object_type: 'curated_note',
      }));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-bind-operation',
        'candidate-bind-operation',
        { status: 'approved' },
      ));
      const bind = getOperation('bind_memory_candidate_target');

      const result = await bind.handler(harness.ctx, {
        candidate_id: 'candidate-bind-operation',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: 'curated_note',
        expected_current_target_object_id: null,
        proposal_id: 'proposal-bind-operation',
        ...reviewParams,
      }) as any;

      expect(result.candidate.target_object_id).toBe('projects/mbrain/docs/canonical-target-proposals');
      expect((await harness.engine.listMemoryMutationEvents({
        operation: 'bind_memory_candidate_target',
        target_id: 'candidate-bind-operation',
      }))).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  test('normalizes service errors into operation error codes', async () => {
    const harness = await createHarness('error-normalization');
    try {
      const create = getOperation('create_canonical_target_proposal');
      await expect(create.handler(harness.ctx, {
        candidate_id: 'missing-candidate',
        apply: true,
      })).rejects.toMatchObject({
        code: 'memory_candidate_not_found',
      });

      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-reject-normalization'));
      await harness.engine.createCanonicalTargetProposalEntry(proposalInput(
        'proposal-reject-normalization',
        'candidate-reject-normalization',
        { status: 'bound', bound_candidate_ids: ['candidate-reject-normalization'] },
      ));
      const reject = getOperation('reject_canonical_target_proposal');

      await expect(reject.handler(harness.ctx, {
        proposal_id: 'proposal-reject-normalization',
        ...reviewParams,
      })).rejects.toMatchObject({
        code: 'invalid_params',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('create_missing_page_stub=true requires session_id and realm_id', async () => {
    const approve = getOperation('approve_canonical_target_proposal');

    await expect(dispatchOperation({} as OperationContext, approve, {
      proposal_id: 'proposal-missing-context',
      create_missing_page_stub: true,
      actor: 'reviewer',
      source_refs: ['User, direct message, 2026-06-15 12:05 KST'],
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('bind operation requires proposal_id before mutating a target', async () => {
    const harness = await createHarness('bind-requires-proposal');
    try {
      await seedMutationContext(harness.engine);
      await harness.engine.createMemoryCandidateEntry(candidateInput('candidate-bind-no-proposal'));
      const bind = getOperation('bind_memory_candidate_target');

      await expect(bind.handler(harness.ctx, {
        candidate_id: 'candidate-bind-no-proposal',
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/canonical-target-proposals',
        expected_current_target_object_type: null,
        expected_current_target_object_id: null,
        ...reviewParams,
      })).rejects.toMatchObject({ code: 'invalid_params' });

      expect((await harness.engine.getMemoryCandidateEntry('candidate-bind-no-proposal'))?.target_object_id)
        .toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
