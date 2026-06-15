import type { BrainEngine } from '../engine.ts';
import type {
  CanonicalTargetProposalEntry,
  CanonicalTargetProposalPageType,
  CanonicalTargetProposalStatus,
  CanonicalTargetProposalStatusEventKind,
  MemoryCandidateEntry,
  MemoryCandidateTargetObjectType,
  MemoryMutationOperationName,
} from '../types.ts';
import { findSlugQualityIssues, type SlugQualityRule } from '../slug-quality.ts';
import { recordMemoryMutationEvent } from './memory-mutation-ledger-service.ts';

type ReviewServiceErrorCode =
  | 'canonical_target_proposal_not_found'
  | 'memory_candidate_not_found'
  | 'invalid_params'
  | 'invalid_status_transition'
  | 'candidate_not_eligible';

type BlockReason =
  | 'mixed_scope'
  | 'mixed_sensitivity'
  | 'missing_source_refs'
  | 'refuted_candidate'
  | 'terminal_candidate'
  | 'target_shape_drift'
  | 'stub_patch_failed'
  | 'stub_patch_rejected'
  | 'stub_patch_superseded'
  | 'stub_patch_applied_page_missing'
  | 'missing_stub_patch_candidate'
  | 'slug_quality_hard_error';

export class CanonicalTargetProposalReviewServiceError extends Error {
  constructor(
    public code: ReviewServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalTargetProposalReviewServiceError';
  }
}

export interface CanonicalTargetProposalReviewContext {
  session_id: string;
  realm_id: string;
  actor: string;
  source_refs: string[];
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
}

export interface BindMemoryCandidateTargetGovernedInput extends CanonicalTargetProposalReviewContext {
  candidate_id: string;
  target_object_type: 'curated_note';
  target_object_id: string;
  expected_current_target_object_type: Extract<MemoryCandidateTargetObjectType, 'curated_note' | 'procedure' | 'other'> | null;
  expected_current_target_object_id: null;
  proposal_id: string;
}

export interface ApproveCanonicalTargetProposalInput extends CanonicalTargetProposalReviewContext {
  proposal_id: string;
  create_missing_page_stub?: boolean;
  proposed_slug?: string;
  proposed_title?: string;
}

export interface RejectCanonicalTargetProposalInput extends CanonicalTargetProposalReviewContext {
  proposal_id: string;
}

export interface CompleteCanonicalTargetProposalBindingInput extends CanonicalTargetProposalReviewContext {
  proposal_id: string;
  require_stub_patch_applied?: boolean;
}

export type BindMemoryCandidateTargetGovernedResult = {
  candidate: MemoryCandidateEntry;
};

export type ApproveCanonicalTargetProposalResult =
  | { kind: 'bound'; proposal: CanonicalTargetProposalEntry; candidates: MemoryCandidateEntry[] }
  | { kind: 'approved_pending'; proposal: CanonicalTargetProposalEntry }
  | { kind: 'patch_staged'; proposal: CanonicalTargetProposalEntry; stub_patch_candidate: MemoryCandidateEntry }
  | { kind: 'blocked'; proposal: CanonicalTargetProposalEntry; reason_code: BlockReason };

export type RejectCanonicalTargetProposalResult = {
  proposal: CanonicalTargetProposalEntry;
};

export type CompleteCanonicalTargetProposalBindingResult =
  | { kind: 'bound'; proposal: CanonicalTargetProposalEntry; candidates: MemoryCandidateEntry[] }
  | { kind: 'pending'; proposal: CanonicalTargetProposalEntry }
  | { kind: 'blocked'; proposal: CanonicalTargetProposalEntry; reason_code: BlockReason }
  | { kind: 'superseded'; proposal: CanonicalTargetProposalEntry };

const TERMINAL_CANDIDATE_STATUSES = new Set(['rejected', 'promoted', 'superseded']);
const DISALLOWED_BINDING_SENSITIVITIES = new Set(['personal', 'secret', 'unknown']);
const HARD_SLUG_QUALITY_RULES = new Set<SlugQualityRule>([
  'vague-slug',
  'numeric-only-slug',
  'global-docs-bucket',
  'placeholder-like-slug',
]);

export async function bindMemoryCandidateTargetGoverned(
  engine: BrainEngine,
  input: BindMemoryCandidateTargetGovernedInput,
): Promise<BindMemoryCandidateTargetGovernedResult> {
  assertReviewContext(input);
  if (!input.proposal_id || input.proposal_id.trim().length === 0) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      'proposal_id is required for governed candidate target binding',
    );
  }
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    await assertActiveReadWriteMemorySession(tx, input);

    const before = await tx.getMemoryCandidateEntry(input.candidate_id);
    if (!before) {
      throw new CanonicalTargetProposalReviewServiceError(
        'memory_candidate_not_found',
        `Memory candidate not found: ${input.candidate_id}`,
      );
    }
    const proposal = await requireProposal(tx, input.proposal_id);
    if (proposal.status !== 'approved' && proposal.status !== 'patch_staged') {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Canonical target proposal must be approved or patch_staged before direct binding: ${proposal.id}`,
      );
    }
    if (!proposal.linked_candidate_ids.includes(before.id) && proposal.source_candidate_id !== before.id) {
      throw new CanonicalTargetProposalReviewServiceError(
        'candidate_not_eligible',
        `Memory candidate ${before.id} is not linked to canonical target proposal ${proposal.id}.`,
      );
    }
    if (input.target_object_type !== proposal.target_object_type || input.target_object_id !== proposal.proposed_slug) {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_params',
        `Direct binding target must match canonical target proposal ${proposal.id}.`,
      );
    }
    if (!await tx.getPageForUpdate(proposal.proposed_slug)) {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Cannot bind candidate ${before.id}; canonical target page is missing: ${proposal.proposed_slug}`,
      );
    }
    const eligibilityIssue = validateLinkedCandidateForProposal(proposal, before);
    if (eligibilityIssue) {
      throw new CanonicalTargetProposalReviewServiceError(
        'candidate_not_eligible',
        `Cannot bind candidate ${before.id}; ${eligibilityIssue}.`,
      );
    }

    const bound = await tx.bindMemoryCandidateTarget(input.candidate_id, {
      target_object_type: input.target_object_type,
      target_object_id: input.target_object_id,
      expected_current_target_object_type: input.expected_current_target_object_type,
      expected_current_target_object_id: input.expected_current_target_object_id,
      reviewed_at: input.reviewed_at ?? new Date(),
      review_reason: input.review_reason ?? 'Bound by canonical target proposal review.',
    });
    if (!bound) {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Cannot bind memory candidate target; candidate changed before binding completed: ${input.candidate_id}`,
      );
    }

    await recordCandidateStatusEvent(tx, before, bound, input);
    await recordMemoryMutationEvent(tx, {
      session_id: input.session_id,
      realm_id: input.realm_id,
      actor: input.actor,
      operation: 'bind_memory_candidate_target',
      target_kind: 'memory_candidate',
      target_id: bound.id,
      scope_id: bound.scope_id,
      source_refs: input.source_refs,
      result: 'applied',
      metadata: {
        proposal_id: proposal.id,
        target_object_type: bound.target_object_type,
        target_object_id: bound.target_object_id,
      },
    });

    return { candidate: bound };
  });
}

export async function approveCanonicalTargetProposal(
  engine: BrainEngine,
  input: ApproveCanonicalTargetProposalInput,
): Promise<ApproveCanonicalTargetProposalResult> {
  assertReviewContext(input);
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    await assertActiveReadWriteMemorySession(tx, input);

    let current = await requireProposal(tx, input.proposal_id);
    if (current.status !== 'proposed') {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Canonical target proposal must be proposed before approval: ${current.id}`,
      );
    }

    const proposedSlug = normalizeProposalSlugOverride(input.proposed_slug) ?? current.proposed_slug;
    const proposedTitle = normalizeOptionalString(input.proposed_title) ?? current.proposed_title;
    validateApprovalSlug(proposedSlug, current);
    if (proposedSlug !== current.proposed_slug || proposedTitle !== current.proposed_title) {
      const refreshed = await tx.updateCanonicalTargetProposalDraft(current.id, {
        expected_current_status: current.status,
        proposed_slug: proposedSlug,
        proposed_title: proposedTitle,
      });
      if (!refreshed) {
        throw new CanonicalTargetProposalReviewServiceError(
          'invalid_status_transition',
          `Cannot apply approval override to canonical target proposal ${current.id}.`,
        );
      }
      current = refreshed;
    }

    const candidates = await loadAndValidateLinkedCandidates(tx, current);
    if (!candidates.ok) {
      return {
        kind: 'blocked',
        reason_code: candidates.reason_code,
        proposal: await blockProposal(tx, current, candidates.reason_code, input),
      };
    }

    const page = await tx.getPageForUpdate(proposedSlug);
    const approved = await transitionProposal(tx, current, 'approved', 'approved', input);
    await recordMemoryMutationEvent(tx, {
      session_id: input.session_id,
      realm_id: input.realm_id,
      actor: input.actor,
      operation: 'approve_canonical_target_proposal',
      target_kind: 'canonical_target_proposal',
      target_id: approved.id,
      scope_id: approved.scope_id,
      source_refs: input.source_refs,
      result: 'approved',
      metadata: {
        proposed_slug: proposedSlug,
        create_missing_page_stub: input.create_missing_page_stub === true,
      },
    });

    if (page) {
      return bindAllCandidatesToProposal(tx, approved, candidates.candidates, {
        ...input,
        review_reason: input.review_reason ?? 'Approved canonical target proposal and bound candidates.',
      }, proposedSlug);
    }

    if (input.create_missing_page_stub !== true) {
      return { kind: 'approved_pending', proposal: approved };
    }

    const finalPageCheck = await tx.getPageForUpdate(proposedSlug);
    if (finalPageCheck) {
      return bindAllCandidatesToProposal(tx, approved, candidates.candidates, {
        ...input,
        review_reason: input.review_reason ?? 'Approved canonical target proposal and bound candidates.',
      }, proposedSlug);
    }

    const stubCandidate = await createMissingPageStubPatchCandidate(tx, approved, {
      ...input,
      proposed_slug: proposedSlug,
      proposed_title: proposedTitle,
    });
    const patchStaged = await transitionProposal(tx, approved, 'patch_staged', 'patch_staged', input, {
      stub_patch_candidate_id: stubCandidate.id,
      stub_patch_state: stubCandidate.patch_operation_state ?? 'proposed',
    });
    return {
      kind: 'patch_staged',
      proposal: patchStaged,
      stub_patch_candidate: stubCandidate,
    };
  });
}

export async function rejectCanonicalTargetProposal(
  engine: BrainEngine,
  input: RejectCanonicalTargetProposalInput,
): Promise<RejectCanonicalTargetProposalResult> {
  assertReviewContext(input);
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    await assertActiveReadWriteMemorySession(tx, input);
    const current = await requireProposal(tx, input.proposal_id);
    if (current.status !== 'proposed' && current.status !== 'approved') {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Canonical target proposal cannot be rejected from status ${current.status}: ${current.id}`,
      );
    }
    const rejected = await transitionProposal(tx, current, 'rejected', 'rejected', input);
    await recordMemoryMutationEvent(tx, {
      session_id: input.session_id,
      realm_id: input.realm_id,
      actor: input.actor,
      operation: 'reject_canonical_target_proposal',
      target_kind: 'canonical_target_proposal',
      target_id: rejected.id,
      scope_id: rejected.scope_id,
      source_refs: input.source_refs,
      result: 'denied',
      metadata: {
        previous_status: current.status,
      },
    });
    return { proposal: rejected };
  });
}

export async function completeCanonicalTargetProposalBinding(
  engine: BrainEngine,
  input: CompleteCanonicalTargetProposalBindingInput,
): Promise<CompleteCanonicalTargetProposalBindingResult> {
  assertReviewContext(input);
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    await assertActiveReadWriteMemorySession(tx, input);
    const current = await requireProposal(tx, input.proposal_id);
    if (current.status !== 'approved' && current.status !== 'patch_staged') {
      throw new CanonicalTargetProposalReviewServiceError(
        'invalid_status_transition',
        `Canonical target proposal cannot complete binding from status ${current.status}: ${current.id}`,
      );
    }

    if (current.status === 'patch_staged') {
      const staged = await resolvePatchStagedCompletion(tx, current, input);
      if (staged.kind !== 'continue') return staged;
    }

    const candidates = await loadAndValidateLinkedCandidates(tx, current);
    if (!candidates.ok) {
      return {
        kind: 'blocked',
        reason_code: candidates.reason_code,
        proposal: await blockProposal(tx, current, candidates.reason_code, input, 'complete_canonical_target_proposal_binding'),
      };
    }

    const page = await tx.getPageForUpdate(current.proposed_slug);
    if (!page) {
      if (input.require_stub_patch_applied === true && current.status === 'patch_staged') {
        return {
          kind: 'blocked',
          reason_code: 'stub_patch_applied_page_missing',
          proposal: await blockProposal(tx, current, 'stub_patch_applied_page_missing', input, 'complete_canonical_target_proposal_binding'),
        };
      }
      return { kind: 'pending', proposal: current };
    }

    return bindAllCandidatesToProposal(tx, current, candidates.candidates, input, current.proposed_slug);
  });
}

async function bindAllCandidatesToProposal(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  candidates: MemoryCandidateEntry[],
  input: CanonicalTargetProposalReviewContext,
  targetSlug: string,
): Promise<{ kind: 'bound'; proposal: CanonicalTargetProposalEntry; candidates: MemoryCandidateEntry[] }> {
  const boundCandidates: MemoryCandidateEntry[] = [];
  for (const candidate of candidates) {
    const result = await bindMemoryCandidateTargetGoverned(engine, {
      candidate_id: candidate.id,
      target_object_type: 'curated_note',
      target_object_id: targetSlug,
      expected_current_target_object_type: expectedTargetObjectTypeForBinding(candidate),
      expected_current_target_object_id: null,
      proposal_id: proposal.id,
      ...input,
      review_reason: input.review_reason ?? 'Bound by canonical target proposal.',
    });
    boundCandidates.push(result.candidate);
  }

  const boundProposal = await transitionProposal(engine, proposal, 'bound', 'bound', input, {
    bound_candidate_ids: boundCandidates.map((candidate) => candidate.id),
  });
  await recordMemoryMutationEvent(engine, {
    session_id: input.session_id,
    realm_id: input.realm_id,
    actor: input.actor,
    operation: 'complete_canonical_target_proposal_binding',
    target_kind: 'canonical_target_proposal',
    target_id: boundProposal.id,
    scope_id: boundProposal.scope_id,
    source_refs: input.source_refs,
    result: 'applied',
    metadata: {
      bound_candidate_ids: boundProposal.bound_candidate_ids,
      proposed_slug: boundProposal.proposed_slug,
    },
  });

  return {
    kind: 'bound',
    proposal: boundProposal,
    candidates: boundCandidates,
  };
}

async function resolvePatchStagedCompletion(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  input: CanonicalTargetProposalReviewContext,
): Promise<
  | { kind: 'continue' }
  | { kind: 'pending'; proposal: CanonicalTargetProposalEntry }
  | { kind: 'blocked'; proposal: CanonicalTargetProposalEntry; reason_code: BlockReason }
  | { kind: 'superseded'; proposal: CanonicalTargetProposalEntry }
> {
  if (!proposal.stub_patch_candidate_id) {
    return {
      kind: 'blocked',
      reason_code: 'missing_stub_patch_candidate',
      proposal: await blockProposal(engine, proposal, 'missing_stub_patch_candidate', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  const stub = await engine.getMemoryCandidateEntry(proposal.stub_patch_candidate_id);
  if (!stub) {
    return {
      kind: 'blocked',
      reason_code: 'missing_stub_patch_candidate',
      proposal: await blockProposal(engine, proposal, 'missing_stub_patch_candidate', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  if (stub.status === 'rejected') {
    return {
      kind: 'blocked',
      reason_code: 'stub_patch_rejected',
      proposal: await blockProposal(engine, proposal, 'stub_patch_rejected', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  if (stub.status === 'superseded') {
    if (proposal.superseded_by) {
      const superseded = await transitionProposal(engine, proposal, 'superseded', 'superseded', input, {
        superseded_by: proposal.superseded_by,
      });
      return { kind: 'superseded', proposal: superseded };
    }
    return {
      kind: 'blocked',
      reason_code: 'stub_patch_superseded',
      proposal: await blockProposal(engine, proposal, 'stub_patch_superseded', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  if (stub.patch_operation_state === 'failed' || stub.patch_operation_state === 'conflicted') {
    return {
      kind: 'blocked',
      reason_code: 'stub_patch_failed',
      proposal: await blockProposal(engine, proposal, 'stub_patch_failed', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  if (stub.patch_operation_state !== 'applied') {
    return { kind: 'pending', proposal };
  }
  const page = await engine.getPageForUpdate(proposal.proposed_slug);
  if (!page) {
    return {
      kind: 'blocked',
      reason_code: 'stub_patch_applied_page_missing',
      proposal: await blockProposal(engine, proposal, 'stub_patch_applied_page_missing', input, 'complete_canonical_target_proposal_binding'),
    };
  }
  return { kind: 'continue' };
}

async function loadAndValidateLinkedCandidates(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
): Promise<
  | { ok: true; candidates: MemoryCandidateEntry[] }
  | { ok: false; reason_code: BlockReason }
> {
  const ids = proposal.linked_candidate_ids.length > 0
    ? proposal.linked_candidate_ids
    : [proposal.source_candidate_id];
  const candidates: MemoryCandidateEntry[] = [];
  for (const id of ids) {
    const candidate = await engine.getMemoryCandidateEntry(id);
    if (!candidate) {
      throw new CanonicalTargetProposalReviewServiceError(
        'memory_candidate_not_found',
        `Linked memory candidate not found: ${id}`,
      );
    }
    candidates.push(candidate);
  }

  const firstSensitivity = candidates[0]?.sensitivity;
  for (const candidate of candidates) {
    const issue = validateLinkedCandidateForProposal(proposal, candidate, firstSensitivity);
    if (issue) return { ok: false, reason_code: issue };
  }

  return { ok: true, candidates };
}

async function blockProposal(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  reason: BlockReason,
  input: CanonicalTargetProposalReviewContext,
  operation: Extract<MemoryMutationOperationName, 'approve_canonical_target_proposal' | 'complete_canonical_target_proposal_binding'> = 'approve_canonical_target_proposal',
): Promise<CanonicalTargetProposalEntry> {
  const blocked = await transitionProposal(engine, proposal, 'blocked', 'blocked', {
    ...input,
    review_reason: input.review_reason ?? reason,
  }, {
    status_reason: reason,
  });
  await recordMemoryMutationEvent(engine, {
    session_id: input.session_id,
    realm_id: input.realm_id,
    actor: input.actor,
    operation,
    target_kind: 'canonical_target_proposal',
    target_id: blocked.id,
    scope_id: blocked.scope_id,
    source_refs: input.source_refs,
    result: 'denied',
    conflict_info: { reason },
    metadata: {
      previous_status: proposal.status,
    },
  });
  return blocked;
}

async function transitionProposal(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  status: CanonicalTargetProposalStatus,
  eventKind: CanonicalTargetProposalStatusEventKind,
  input: CanonicalTargetProposalReviewContext,
  patch: {
    status_reason?: string | null;
    bound_candidate_ids?: string[];
    stub_patch_candidate_id?: string | null;
    stub_patch_state?: string | null;
    superseded_by?: string | null;
  } = {},
): Promise<CanonicalTargetProposalEntry> {
  const updated = await engine.updateCanonicalTargetProposalStatus(proposal.id, {
    status,
    expected_current_status: proposal.status,
    status_reason: patch.status_reason,
    actor: input.actor,
    review_reason: input.review_reason ?? null,
    bound_candidate_ids: patch.bound_candidate_ids,
    stub_patch_candidate_id: patch.stub_patch_candidate_id,
    stub_patch_state: patch.stub_patch_state,
    superseded_by: patch.superseded_by,
  });
  if (!updated) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_status_transition',
      `Cannot transition canonical target proposal ${proposal.id} from ${proposal.status} to ${status}.`,
    );
  }
  await engine.createCanonicalTargetProposalStatusEvent({
    id: crypto.randomUUID(),
    proposal_id: updated.id,
    scope_id: updated.scope_id,
    from_status: proposal.status,
    to_status: updated.status,
    event_kind: eventKind,
    actor: input.actor,
    review_reason: input.review_reason ?? null,
  });
  return updated;
}

async function createMissingPageStubPatchCandidate(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  input: CanonicalTargetProposalReviewContext & { proposed_slug: string; proposed_title: string },
): Promise<MemoryCandidateEntry> {
  const id = crypto.randomUUID();
  const ledgerEvent = await recordMemoryMutationEvent(engine, {
    session_id: input.session_id,
    realm_id: input.realm_id,
    actor: input.actor,
    operation: 'create_memory_patch_candidate',
    target_kind: 'memory_candidate',
    target_id: id,
    scope_id: proposal.scope_id,
    source_refs: input.source_refs,
    result: 'staged_for_review',
    metadata: {
      proposal_id: proposal.id,
      patch_target_kind: 'page',
      patch_target_id: input.proposed_slug,
      patch_base_target_snapshot_hash: null,
      patch_format: 'merge_patch',
      patch_operation_state: 'proposed',
      patch_risk_class: 'medium',
    },
  });
  const patchBody = buildMissingPageStubPatchBody(proposal, input);
  const created = await engine.createMemoryCandidateEntry({
    id,
    scope_id: proposal.scope_id,
    candidate_type: 'note_update',
    proposed_content: `Review missing page stub for ${input.proposed_slug}.`,
    source_refs: proposal.source_refs,
    generated_by: 'agent',
    extraction_kind: 'manual',
    confidence_score: proposal.confidence_score,
    importance_score: proposal.importance_score,
    recurrence_score: 0,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: input.proposed_slug,
    reviewed_at: null,
    review_reason: input.review_reason ?? `Stub patch staged by canonical target proposal ${proposal.id}.`,
    patch_target_kind: 'page',
    patch_target_id: input.proposed_slug,
    patch_base_target_snapshot_hash: null,
    patch_body: patchBody,
    patch_format: 'merge_patch',
    patch_operation_state: 'proposed',
    patch_risk_class: 'medium',
    patch_provenance_summary: `Missing-page stub staged by canonical target proposal ${proposal.id}.`,
    patch_actor: input.actor,
    patch_originating_session_id: input.session_id,
    patch_ledger_event_ids: [ledgerEvent.id],
  });
  await engine.createMemoryCandidateStatusEvent({
    id: crypto.randomUUID(),
    candidate_id: created.id,
    scope_id: created.scope_id,
    from_status: null,
    to_status: created.status,
    event_kind: 'created',
    interaction_id: null,
    reviewed_at: created.reviewed_at,
    review_reason: created.review_reason,
    created_at: created.created_at,
  });
  return created;
}

function buildMissingPageStubPatchBody(
  proposal: CanonicalTargetProposalEntry,
  input: { proposed_title: string },
): Record<string, unknown> {
  const timeline = proposal.source_refs
    .map((sourceRef) => `- Canonical target proposal ${proposal.id} requested this review stub. [Source: ${sourceRef}]`)
    .join('\n');
  return {
    type: proposal.proposed_page_type,
    title: input.proposed_title,
    compiled_truth: `This page is a review stub; no candidate claim has been promoted into compiled truth yet. [Source: ${proposal.source_refs[0]}]`,
    timeline,
  };
}

async function requireProposal(
  engine: BrainEngine,
  id: string,
): Promise<CanonicalTargetProposalEntry> {
  const proposal = await engine.getCanonicalTargetProposalEntry(id);
  if (!proposal) {
    throw new CanonicalTargetProposalReviewServiceError(
      'canonical_target_proposal_not_found',
      `Canonical target proposal not found: ${id}`,
    );
  }
  return proposal;
}

async function recordCandidateStatusEvent(
  engine: BrainEngine,
  before: MemoryCandidateEntry,
  after: MemoryCandidateEntry,
  input: CanonicalTargetProposalReviewContext,
): Promise<void> {
  await engine.createMemoryCandidateStatusEvent({
    id: crypto.randomUUID(),
    candidate_id: after.id,
    scope_id: after.scope_id,
    from_status: before.status,
    to_status: after.status,
    event_kind: 'advanced',
    interaction_id: null,
    reviewed_at: after.reviewed_at,
    review_reason: after.review_reason ?? input.review_reason ?? null,
  });
}

async function assertActiveReadWriteMemorySession(
  engine: BrainEngine,
  input: Pick<CanonicalTargetProposalReviewContext, 'session_id' | 'realm_id'> & { scope_id?: string },
): Promise<void> {
  const session = await engine.getMemorySession(input.session_id);
  if (!session || session.status !== 'active') {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      `memory session is not active: ${input.session_id}`,
    );
  }
  const realm = await engine.getMemoryRealm(input.realm_id);
  if (!realm || realm.archived_at) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      `memory realm is not active: ${input.realm_id}`,
    );
  }
  const attachment = (await engine.listMemorySessionAttachments({
    session_id: input.session_id,
    realm_id: input.realm_id,
    limit: 1,
  }))[0] ?? null;
  if (!attachment || attachment.access !== 'read_write') {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      `memory realm is not attached read-write to session: ${input.realm_id}`,
    );
  }
}

function assertReviewContext(input: CanonicalTargetProposalReviewContext): void {
  if (!input.session_id || !input.realm_id || !input.actor) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      'session_id, realm_id, and actor are required',
    );
  }
  if (!Array.isArray(input.source_refs) || input.source_refs.length === 0) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      'source_refs must contain at least one provenance reference',
    );
  }
}

function expectedTargetObjectTypeForBinding(
  candidate: MemoryCandidateEntry,
): Extract<MemoryCandidateTargetObjectType, 'curated_note' | 'procedure' | 'other'> | null {
  if (candidate.target_object_type === null) return null;
  if (
    candidate.target_object_type === 'curated_note'
    || candidate.target_object_type === 'procedure'
    || candidate.target_object_type === 'other'
  ) {
    return candidate.target_object_type;
  }
  return null;
}

function isAllowedUnresolvedTargetType(value: MemoryCandidateEntry['target_object_type']): boolean {
  return value === null || value === 'curated_note' || value === 'procedure' || value === 'other';
}

function validateLinkedCandidateForProposal(
  proposal: CanonicalTargetProposalEntry,
  candidate: MemoryCandidateEntry,
  expectedSensitivity?: MemoryCandidateEntry['sensitivity'],
): BlockReason | null {
  if (candidate.scope_id !== proposal.scope_id) return 'mixed_scope';
  if (
    (expectedSensitivity !== undefined && candidate.sensitivity !== expectedSensitivity)
    || DISALLOWED_BINDING_SENSITIVITIES.has(candidate.sensitivity)
  ) {
    return 'mixed_sensitivity';
  }
  if (candidate.source_refs.length === 0) return 'missing_source_refs';
  if (candidate.verification_status === 'refuted') return 'refuted_candidate';
  if (TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) return 'terminal_candidate';
  if (candidate.target_object_id !== null) return 'target_shape_drift';
  if (!isAllowedUnresolvedTargetType(candidate.target_object_type)) return 'target_shape_drift';
  return null;
}

function validateApprovalSlug(
  slug: string,
  proposal: CanonicalTargetProposalEntry,
): void {
  const hardSlugIssue = findSlugQualityIssues(slug)
    .find((issue) => HARD_SLUG_QUALITY_RULES.has(issue.rule));
  if (hardSlugIssue) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      `Approval slug override failed slug-quality rule: ${hardSlugIssue.rule}`,
    );
  }
  const pageType = pageTypeForSlug(slug);
  if (pageType !== proposal.proposed_page_type) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      `Approval slug override page type ${pageType} does not match proposal page type ${proposal.proposed_page_type}.`,
    );
  }
}

function pageTypeForSlug(slug: string): CanonicalTargetProposalPageType {
  if (slug.startsWith('projects/')) return 'project';
  if (slug.startsWith('systems/')) return 'system';
  return 'concept';
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProposalSlugOverride(value: string | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const slug = normalized.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (slug.length === 0) {
    throw new CanonicalTargetProposalReviewServiceError(
      'invalid_params',
      'proposed_slug must contain a non-empty slug after normalization.',
    );
  }
  return slug;
}
