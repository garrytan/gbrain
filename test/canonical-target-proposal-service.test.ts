import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  CanonicalTargetProposalServiceError,
  createCanonicalTargetProposal,
  createCanonicalTargetProposalDraft,
  type CanonicalTargetProposalCreateResult,
  type CanonicalTargetProposalDraftResult,
} from '../src/core/services/canonical-target-proposal-draft-service.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

type DraftResult = Extract<CanonicalTargetProposalDraftResult, { kind: 'draft' }>;
type NoProposalResult = Extract<CanonicalTargetProposalDraftResult, { kind: 'no_proposal' }>;
type CreatedResult = Extract<CanonicalTargetProposalCreateResult, { kind: 'created' }>;
type RefreshedResult = Extract<CanonicalTargetProposalCreateResult, { kind: 'refreshed' }>;

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
    proposed_content: 'MBrain canonical target proposal work belongs in the MBrain project notes.',
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

async function seedCandidate(
  engine: BrainEngine,
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
) {
  return engine.createMemoryCandidateEntry(candidateInput(id, overrides));
}

function expectDraftResult(
  result: CanonicalTargetProposalDraftResult | CanonicalTargetProposalCreateResult,
): DraftResult {
  expect(result.kind).toBe('draft');
  if (result.kind !== 'draft') {
    throw new Error(`Expected draft result, got ${result.kind}`);
  }
  return result;
}

function expectNoProposalResult(
  result: CanonicalTargetProposalDraftResult | CanonicalTargetProposalCreateResult,
): NoProposalResult {
  expect(result.kind).toBe('no_proposal');
  if (result.kind !== 'no_proposal') {
    throw new Error(`Expected no_proposal result, got ${result.kind}`);
  }
  return result;
}

function expectCreatedResult(result: CanonicalTargetProposalCreateResult): CreatedResult {
  expect(result.kind).toBe('created');
  if (result.kind !== 'created') {
    throw new Error(`Expected created result, got ${result.kind}`);
  }
  return result;
}

function expectRefreshedResult(result: CanonicalTargetProposalCreateResult): RefreshedResult {
  expect(result.kind).toBe('refreshed');
  if (result.kind !== 'refreshed') {
    throw new Error(`Expected refreshed result, got ${result.kind}`);
  }
  return result;
}

describe('canonical target proposal draft service', () => {
  test('classifies eligible unresolved target shapes into canonical page drafts', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'candidate-null-target', {
        target_object_type: null,
        proposed_content: 'The MBrain canonical proposal work should be tracked in the MBrain project docs.',
      });
      await seedCandidate(engine, 'candidate-curated-null-target', {
        target_object_type: 'curated_note',
        proposed_content: 'Redis cache invalidation runbook belongs in system memory for operators.',
      });
      await seedCandidate(engine, 'candidate-other-null-target', {
        target_object_type: 'other',
        proposed_content: 'Product packaging idea: sell a memory assistant for team research workflows.',
      });
      await seedCandidate(engine, 'candidate-procedure-null-target', {
        target_object_type: 'procedure',
        proposed_content: 'Deployment rollback runbook for the mbrain operator workflow should be retained.',
      });

      const projectDraft = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'candidate-null-target',
      }));
      const systemDraft = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'candidate-curated-null-target',
      }));
      const ideaDraft = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'candidate-other-null-target',
      }));
      const procedureDraft = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'candidate-procedure-null-target',
      }));

      expect(projectDraft.draft.status).toBe('proposed');
      expect(projectDraft.draft.proposed_slug).toBe('projects/mbrain/docs/canonical-proposal-work');
      expect(projectDraft.draft.proposal_kind).toBe('project_doc');
      expect(projectDraft.draft.proposed_page_type).toBe('project');

      expect(systemDraft.draft.proposed_slug).toBe('systems/redis-cache-invalidation-runbook');
      expect(systemDraft.draft.proposal_kind).toBe('system_page');
      expect(systemDraft.draft.proposed_page_type).toBe('system');

      expect(ideaDraft.draft.proposed_slug).toBe('ideas/product-packaging-memory-assistant');
      expect(ideaDraft.draft.proposal_kind).toBe('idea_page');
      expect(ideaDraft.draft.proposed_page_type).toBe('concept');

      expect(procedureDraft.draft.proposed_slug).toBe('systems/mbrain-deployment-rollback-runbook');
      expect(procedureDraft.draft.proposal_kind).toBe('system_page');
      expect(procedureDraft.draft.target_object_type).toBe('curated_note');
    } finally {
      await engine.disconnect();
    }
  });

  test('refuses ineligible candidates before drafting', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'terminal-candidate', { status: 'staged_for_review' });
      await engine.updateMemoryCandidateEntryStatus('terminal-candidate', {
        status: 'rejected',
        reviewed_at: new Date('2026-06-15T03:00:00.000Z'),
        review_reason: 'Terminal candidate fixture.',
      });
      await seedCandidate(engine, 'refuted-candidate');
      await engine.updateMemoryCandidateEntryVerification('refuted-candidate', {
        verification_status: 'refuted',
        verification_method: 'source_recheck',
        verification_evidence: 'Source no longer supports this candidate.',
      });
      await seedCandidate(engine, 'empty-source-candidate', { source_refs: [] });
      await seedCandidate(engine, 'personal-candidate', { sensitivity: 'personal' });
      await seedCandidate(engine, 'secret-candidate', { sensitivity: 'secret' });
      await seedCandidate(engine, 'unknown-sensitivity-candidate', { sensitivity: 'unknown' });
      await seedCandidate(engine, 'already-targeted-candidate', {
        target_object_type: 'curated_note',
        target_object_id: 'projects/mbrain/docs/existing',
      });
      await seedCandidate(engine, 'inconsistent-override-candidate');

      const cases = [
        ['terminal-candidate', 'invalid_status_transition'],
        ['refuted-candidate', 'candidate_not_eligible'],
        ['empty-source-candidate', 'candidate_not_eligible'],
        ['personal-candidate', 'candidate_not_eligible'],
        ['secret-candidate', 'candidate_not_eligible'],
        ['unknown-sensitivity-candidate', 'candidate_not_eligible'],
        ['already-targeted-candidate', 'candidate_not_eligible'],
      ] as const;

      for (const [candidateId, code] of cases) {
        await expect(createCanonicalTargetProposalDraft(engine, {
          candidate_id: candidateId,
        })).rejects.toMatchObject({ code });
      }

      await expect(createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'inconsistent-override-candidate',
        proposed_slug: 'projects/mbrain/docs/override',
        proposal_kind: 'concept_page',
      })).rejects.toMatchObject({ code: 'candidate_not_eligible' });
    } finally {
      await engine.disconnect();
    }
  });

  test('returns blocked drafts for unstable subjects, likely duplicates, and hard slug issues', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'unstable-subject-candidate', {
        proposed_content: 'This is important and should be remembered somewhere.',
        importance_score: 0.92,
      });
      await seedCandidate(engine, 'duplicate-candidate', {
        proposed_content: 'Atlas rollout plan keeps staged review notes with rollback evidence.',
      });
      await engine.putPage('projects/atlas-rollout/docs/plan', {
        type: 'project',
        title: 'Atlas Rollout Plan',
        compiled_truth: 'Atlas rollout plan keeps staged review notes with rollback evidence.',
      });
      await seedCandidate(engine, 'slug-quality-candidate', {
        proposed_content: 'MBrain docs should avoid degraded placeholder slugs.',
      });
      await seedCandidate(engine, 'advisory-slug-candidate', {
        proposed_content: 'MBrain short advisory slug handling belongs in the MBrain project docs.',
      });

      const unstable = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'unstable-subject-candidate',
      }));
      expect(unstable.draft.status).toBe('blocked');
      expect(unstable.draft.status_reason).toBe('unstable_subject_identity');

      const duplicate = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'duplicate-candidate',
      }));
      expect(duplicate.draft.status).toBe('blocked');
      expect(duplicate.draft.status_reason).toBe('likely_duplicate');
      expect(duplicate.draft.duplicate_review.decision).toBe('likely_duplicate');

      const slugQuality = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'slug-quality-candidate',
        proposed_slug: 'docs/reference/readme',
      }));
      expect(slugQuality.draft.status).toBe('blocked');
      expect(slugQuality.draft.status_reason).toBe('slug_quality_hard_error');
      expect(slugQuality.draft.slug_quality_warnings).toContain('global-docs-bucket');
      expect(slugQuality.draft.slug_quality_warnings).toContain('vague-slug');

      const advisorySlug = expectDraftResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'advisory-slug-candidate',
        proposed_slug: 'concepts/zz',
      }));
      expect(advisorySlug.draft.status).toBe('proposed');
      expect(advisorySlug.draft.status_reason).toBeNull();
      expect(advisorySlug.draft.slug_quality_warnings).toContain('short-slug');
    } finally {
      await engine.disconnect();
    }
  });

  test('returns no proposal for low-importance one-off task mechanics without writing rows', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'one-off-task-candidate', {
        proposed_content: 'Ran bun test once and checked the current branch status.',
        importance_score: 0.22,
        recurrence_score: 0,
      });

      const result = expectNoProposalResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'one-off-task-candidate',
        apply: true,
      }));

      expect(result.reason_code).toBe('one_off_task_mechanics');
      const proposals = await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'one-off-task-candidate',
      });
      expect(proposals).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('returns no proposal from the draft API for low-importance one-off task mechanics', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'one-off-task-draft-candidate', {
        proposed_content: 'Ran bun test once and checked the current branch status.',
        importance_score: 0.22,
        recurrence_score: 0,
      });

      const result = expectNoProposalResult(await createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'one-off-task-draft-candidate',
      }));

      expect(result.reason_code).toBe('one_off_task_mechanics');
      const proposals = await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'one-off-task-draft-candidate',
      });
      expect(proposals).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('defaults apply to false and returns a draft without writing rows', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'dry-run-candidate', {
        proposed_content: 'MBrain dry-run proposal creation belongs in the MBrain project docs.',
      });

      const result = expectDraftResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'dry-run-candidate',
      }));

      expect(result.draft.proposed_slug).toBe('projects/mbrain/docs/canonical-proposal-work');
      const proposals = await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'dry-run-candidate',
      });
      expect(proposals).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('writes only proposal review rows and leaves candidates and pages unchanged', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'governance-boundary-candidate', {
        proposed_content: 'MBrain governance boundary proposal belongs in the MBrain project docs.',
      });
      const candidateBefore = await engine.getMemoryCandidateEntry('governance-boundary-candidate');

      const created = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'governance-boundary-candidate',
        apply: true,
        proposed_slug: 'projects/mbrain/docs/governance-boundary',
      }));

      const candidateAfter = await engine.getMemoryCandidateEntry('governance-boundary-candidate');
      expect(candidateAfter).toMatchObject({
        status: candidateBefore?.status,
        target_object_type: candidateBefore?.target_object_type,
        target_object_id: candidateBefore?.target_object_id,
      });
      expect(created.proposal.proposed_slug).toBe('projects/mbrain/docs/governance-boundary');
      expect(await engine.getPage('projects/mbrain/docs/governance-boundary')).toBeNull();
    } finally {
      await engine.disconnect();
    }
  });

  test('creates, refreshes, and supersedes active proposals idempotently', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'idempotent-candidate', {
        proposed_content: 'MBrain proposal automation belongs in the MBrain project docs.',
      });

      const created = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'idempotent-candidate',
        apply: true,
      }));
      expect(created.proposal.status).toBe('proposed');

      const refreshed = expectRefreshedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'idempotent-candidate',
        apply: true,
      }));
      expect(refreshed.proposal.id).toBe(created.proposal.id);
      expect(await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'idempotent-candidate',
      })).toHaveLength(1);

      const changedSlug = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'idempotent-candidate',
        apply: true,
        proposed_slug: 'projects/mbrain/docs/proposal-automation-v2',
        proposed_title: 'Proposal Automation V2',
      }));
      expect(changedSlug.superseded_proposal?.id).toBe(created.proposal.id);

      const proposals = await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'idempotent-candidate',
        limit: 10,
      });
      expect(proposals.map((proposal) => proposal.status).sort()).toEqual(['proposed', 'superseded']);
      expect(proposals.map((proposal) => proposal.proposed_slug)).toEqual(expect.arrayContaining([
        'projects/mbrain/docs/canonical-proposal-work',
        'projects/mbrain/docs/proposal-automation-v2',
      ]));

      const events = await engine.listCanonicalTargetProposalStatusEvents({
        scope_id: 'workspace:default',
        limit: 10,
      });
      expect(events.map((event) => event.event_kind)).toEqual(expect.arrayContaining([
        'created',
        'superseded',
      ]));
    } finally {
      await engine.disconnect();
    }
  });

  test('refreshes same-slug proposal payload without adding a status event', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'payload-refresh-candidate', {
        proposed_content: 'MBrain proposal automation belongs in the MBrain project docs.',
      });

      const created = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'payload-refresh-candidate',
        apply: true,
        proposed_title: 'Initial Proposal Automation',
      }));
      const refreshed = expectRefreshedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'payload-refresh-candidate',
        apply: true,
        proposed_title: 'Updated Proposal Automation',
      }));

      expect(refreshed.proposal.id).toBe(created.proposal.id);
      expect(refreshed.proposal.proposed_title).toBe('Updated Proposal Automation');
      const events = await engine.listCanonicalTargetProposalStatusEvents({
        scope_id: 'workspace:default',
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.event_kind).toBe('created');
    } finally {
      await engine.disconnect();
    }
  });

  test('supersedes blocked same-slug proposals when the draft becomes proposed', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'duplicate-recovery-candidate', {
        proposed_content: 'Atlas rollout plan keeps staged review notes with rollback evidence.',
      });
      await engine.putPage('projects/atlas-rollout/docs/plan', {
        type: 'project',
        title: 'Atlas Rollout Plan',
        compiled_truth: 'Atlas rollout plan keeps staged review notes with rollback evidence.',
      });

      const blocked = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'duplicate-recovery-candidate',
        apply: true,
      }));
      expect(blocked.proposal.status).toBe('blocked');

      await engine.deletePage('projects/atlas-rollout/docs/plan');
      const recovered = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'duplicate-recovery-candidate',
        apply: true,
      }));

      expect(recovered.proposal.status).toBe('proposed');
      expect(recovered.proposal.proposed_slug).toBe(blocked.proposal.proposed_slug);
      expect(recovered.superseded_proposal?.id).toBe(blocked.proposal.id);
      const proposals = await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'duplicate-recovery-candidate',
        limit: 10,
      });
      expect(proposals.map((proposal) => proposal.status).sort()).toEqual(['proposed', 'superseded']);
    } finally {
      await engine.disconnect();
    }
  });

  test('refreshes blocked proposals without duplicating dream-generated rows', async () => {
    const engine = await createEngine();
    try {
      await seedCandidate(engine, 'blocked-idempotent-candidate', {
        proposed_content: 'This should be remembered because it is important.',
        importance_score: 0.9,
      });

      const first = expectCreatedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'blocked-idempotent-candidate',
        apply: true,
      }));
      const second = expectRefreshedResult(await createCanonicalTargetProposal(engine, {
        candidate_id: 'blocked-idempotent-candidate',
        apply: true,
      }));

      expect(first.proposal.status).toBe('blocked');
      expect(second.proposal.id).toBe(first.proposal.id);
      expect(await engine.listCanonicalTargetProposalEntries({
        source_candidate_id: 'blocked-idempotent-candidate',
      })).toHaveLength(1);
    } finally {
      await engine.disconnect();
    }
  });

  test('throws a typed not-found error for missing candidates', async () => {
    const engine = await createEngine();
    try {
      await expect(createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'missing-candidate',
      })).rejects.toBeInstanceOf(CanonicalTargetProposalServiceError);
      await expect(createCanonicalTargetProposalDraft(engine, {
        candidate_id: 'missing-candidate',
      })).rejects.toMatchObject({ code: 'memory_candidate_not_found' });
    } finally {
      await engine.disconnect();
    }
  });
});
