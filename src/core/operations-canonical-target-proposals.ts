import type { Operation } from './operations.ts';
import {
  bindMemoryCandidateTargetGoverned,
  CanonicalTargetProposalReviewServiceError,
  approveCanonicalTargetProposal,
  completeCanonicalTargetProposalBinding,
  rejectCanonicalTargetProposal,
} from './services/canonical-target-proposal-review-service.ts';
import {
  CanonicalTargetProposalServiceError,
  createCanonicalTargetProposal,
} from './services/canonical-target-proposal-draft-service.ts';
import type {
  CanonicalTargetProposalKind,
  CanonicalTargetProposalStatus,
  MemoryCandidateTargetObjectType,
} from './types.ts';

type OperationErrorCtor = new (
  code: any,
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const CANONICAL_TARGET_PROPOSAL_STATUS_VALUES = [
  'proposed',
  'approved',
  'patch_staged',
  'bound',
  'rejected',
  'superseded',
  'blocked',
] as const satisfies readonly CanonicalTargetProposalStatus[];

const CANONICAL_TARGET_PROPOSAL_KIND_VALUES = [
  'project_root',
  'project_doc',
  'system_page',
  'concept_page',
  'idea_page',
  'original_page',
] as const satisfies readonly CanonicalTargetProposalKind[];

const EXPECTED_TARGET_OBJECT_TYPE_VALUES = [
  'curated_note',
  'procedure',
  'other',
] as const satisfies readonly Extract<MemoryCandidateTargetObjectType, 'curated_note' | 'procedure' | 'other'>[];

const MAX_CANONICAL_TARGET_PROPOSAL_LIMIT = 100;

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requireNonEmptyString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  return requireNonEmptyString(deps, field, value);
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidParams(deps, `${field} must be a boolean`);
  }
  return value;
}

function optionalEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function nullableExpectedTargetObjectType(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): Extract<MemoryCandidateTargetObjectType, 'curated_note' | 'procedure' | 'other'> | null {
  if (value === null) return null;
  const parsed = optionalEnumValue(
    deps,
    'expected_current_target_object_type',
    value,
    EXPECTED_TARGET_OBJECT_TYPE_VALUES,
  );
  if (parsed === undefined) {
    throw invalidParams(deps, 'expected_current_target_object_type must be one of: curated_note, procedure, other, or null');
  }
  return parsed;
}

function nullableExpectedTargetObjectId(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): null {
  if (value !== null) {
    throw invalidParams(deps, 'expected_current_target_object_id must be null');
  }
  return null;
}

function normalizeSourceRefs(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidParams(deps, 'source_refs must be a non-empty array of strings');
  }
  if (!value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    throw invalidParams(deps, 'source_refs must be a non-empty array of strings');
  }
  return value.map((entry) => entry.trim());
}

function normalizeLimit(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): number {
  if (value == null) return 20;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidParams(deps, 'limit must be a non-negative number');
  }
  return Math.min(Math.floor(value), MAX_CANONICAL_TARGET_PROPOSAL_LIMIT);
}

function normalizeOffset(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): number {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidParams(deps, 'offset must be a non-negative number');
  }
  return Math.floor(value);
}

function reviewContext(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
) {
  return {
    session_id: requireNonEmptyString(deps, 'session_id', p.session_id),
    realm_id: requireNonEmptyString(deps, 'realm_id', p.realm_id),
    actor: requireNonEmptyString(deps, 'actor', p.actor),
    source_refs: normalizeSourceRefs(deps, p.source_refs),
    reviewed_at: p.reviewed_at == null ? undefined : requireNonEmptyString(deps, 'reviewed_at', p.reviewed_at),
    review_reason: p.review_reason == null ? undefined : requireNonEmptyString(deps, 'review_reason', p.review_reason),
  };
}

function normalizeCanonicalTargetProposalError(
  deps: { OperationError: OperationErrorCtor },
  error: unknown,
): never {
  if (
    error instanceof CanonicalTargetProposalServiceError
    || error instanceof CanonicalTargetProposalReviewServiceError
  ) {
    if (error.code === 'memory_candidate_not_found') {
      throw new deps.OperationError('memory_candidate_not_found', error.message);
    }
    throw new deps.OperationError('invalid_params', error.message);
  }
  throw error;
}

export function createCanonicalTargetProposalOperations(
  deps: {
    defaultScopeId: string;
    OperationError: OperationErrorCtor;
  },
): Operation[] {
  const create_canonical_target_proposal: Operation = {
    name: 'create_canonical_target_proposal',
    description: 'Draft or write a canonical target proposal for a targetless candidate.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Candidate id' },
      scope_id: { type: 'string', description: `Scope guard; default ${deps.defaultScopeId}` },
      proposed_slug: { type: 'string', description: 'Slug override' },
      proposal_kind: {
        type: 'string',
        description: 'Proposal kind override',
        enum: [...CANONICAL_TARGET_PROPOSAL_KIND_VALUES],
        compactEnum: false,
      },
      proposed_title: { type: 'string', description: 'Title override' },
      review_reason: { type: 'string', description: 'Audit reason' },
      apply: { type: 'boolean', description: 'Write the proposal row when true. Defaults to false.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const candidateId = requireNonEmptyString(deps, 'candidate_id', p.candidate_id);
      const apply = optionalBoolean(deps, 'apply', p.apply) ?? false;
      const input = {
        candidate_id: candidateId,
        scope_id: optionalNonEmptyString(deps, 'scope_id', p.scope_id),
        proposed_slug: optionalNonEmptyString(deps, 'proposed_slug', p.proposed_slug),
        proposal_kind: optionalEnumValue(deps, 'proposal_kind', p.proposal_kind, CANONICAL_TARGET_PROPOSAL_KIND_VALUES),
        proposed_title: optionalNonEmptyString(deps, 'proposed_title', p.proposed_title),
        review_reason: optionalNonEmptyString(deps, 'review_reason', p.review_reason),
        apply,
      };
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'create_canonical_target_proposal',
          candidate_id: candidateId,
          apply,
          proposed_slug: input.proposed_slug ?? null,
        };
      }
      try {
        return await createCanonicalTargetProposal(ctx.engine, input);
      } catch (error) {
        normalizeCanonicalTargetProposalError(deps, error);
      }
    },
    cliHints: { name: 'create-canonical-target-proposal' },
  };

  const list_canonical_target_proposals: Operation = {
    name: 'list_canonical_target_proposals',
    description: 'List canonical target proposals.',
    params: {
      scope_id: { type: 'string', description: 'Scope filter' },
      status: {
        type: 'string',
        description: 'Status filter',
        enum: [...CANONICAL_TARGET_PROPOSAL_STATUS_VALUES],
        compactEnum: false,
      },
      source_candidate_id: { type: 'string', description: 'Source candidate filter' },
      proposed_slug: { type: 'string', description: 'Slug filter' },
      limit: { type: 'number', description: `Default 20, cap ${MAX_CANONICAL_TARGET_PROPOSAL_LIMIT}` },
      offset: { type: 'number', description: 'Pagination offset' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listCanonicalTargetProposalEntries({
        scope_id: optionalNonEmptyString(deps, 'scope_id', p.scope_id),
        status: optionalEnumValue(deps, 'status', p.status, CANONICAL_TARGET_PROPOSAL_STATUS_VALUES),
        source_candidate_id: optionalNonEmptyString(deps, 'source_candidate_id', p.source_candidate_id),
        proposed_slug: optionalNonEmptyString(deps, 'proposed_slug', p.proposed_slug),
        limit: normalizeLimit(deps, p.limit),
        offset: normalizeOffset(deps, p.offset),
      });
    },
    cliHints: { name: 'list-canonical-target-proposals', aliases: { n: 'limit' } },
  };

  const approve_canonical_target_proposal: Operation = {
    name: 'approve_canonical_target_proposal',
    description: 'Approve a proposal and bind or stage a missing-page stub.',
    params: {
      proposal_id: { type: 'string', required: true, description: 'Proposal id' },
      session_id: { type: 'string', required: true, description: 'Session id' },
      realm_id: { type: 'string', required: true, description: 'Realm id' },
      actor: { type: 'string', required: true, description: 'Reviewer' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance refs' },
      create_missing_page_stub: { type: 'boolean', description: 'Stage missing-page stub' },
      proposed_slug: { type: 'string', description: 'Slug override' },
      proposed_title: { type: 'string', description: 'Title override' },
      reviewed_at: { type: 'string', description: 'Review timestamp' },
      review_reason: { type: 'string', description: 'Review reason' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const proposalId = requireNonEmptyString(deps, 'proposal_id', p.proposal_id);
      const createMissingPageStub = optionalBoolean(deps, 'create_missing_page_stub', p.create_missing_page_stub) ?? false;
      const input = {
        proposal_id: proposalId,
        create_missing_page_stub: createMissingPageStub,
        proposed_slug: optionalNonEmptyString(deps, 'proposed_slug', p.proposed_slug),
        proposed_title: optionalNonEmptyString(deps, 'proposed_title', p.proposed_title),
        ...reviewContext(deps, p),
      };
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'approve_canonical_target_proposal',
          proposal_id: proposalId,
          create_missing_page_stub: createMissingPageStub,
          proposed_slug: input.proposed_slug ?? null,
        };
      }
      try {
        return await approveCanonicalTargetProposal(ctx.engine, input);
      } catch (error) {
        normalizeCanonicalTargetProposalError(deps, error);
      }
    },
    cliHints: { name: 'approve-canonical-target-proposal', positional: ['proposal_id'] },
  };

  const reject_canonical_target_proposal: Operation = {
    name: 'reject_canonical_target_proposal',
    description: 'Reject a canonical target proposal.',
    params: {
      proposal_id: { type: 'string', required: true, description: 'Proposal id' },
      session_id: { type: 'string', required: true, description: 'Session id' },
      realm_id: { type: 'string', required: true, description: 'Realm id' },
      actor: { type: 'string', required: true, description: 'Reviewer' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance refs' },
      reviewed_at: { type: 'string', description: 'Review timestamp' },
      review_reason: { type: 'string', description: 'Review reason' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const proposalId = requireNonEmptyString(deps, 'proposal_id', p.proposal_id);
      const input = {
        proposal_id: proposalId,
        ...reviewContext(deps, p),
      };
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'reject_canonical_target_proposal',
          proposal_id: proposalId,
        };
      }
      try {
        return await rejectCanonicalTargetProposal(ctx.engine, input);
      } catch (error) {
        normalizeCanonicalTargetProposalError(deps, error);
      }
    },
    cliHints: { name: 'reject-canonical-target-proposal', positional: ['proposal_id'] },
  };

  const complete_canonical_target_proposal_binding: Operation = {
    name: 'complete_canonical_target_proposal_binding',
    description: 'Complete binding for an approved or patch-staged proposal.',
    params: {
      proposal_id: { type: 'string', required: true, description: 'Proposal id' },
      session_id: { type: 'string', required: true, description: 'Session id' },
      realm_id: { type: 'string', required: true, description: 'Realm id' },
      actor: { type: 'string', required: true, description: 'Reviewer' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance refs' },
      require_stub_patch_applied: { type: 'boolean', description: 'Require applied stub' },
      reviewed_at: { type: 'string', description: 'Review timestamp' },
      review_reason: { type: 'string', description: 'Review reason' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const proposalId = requireNonEmptyString(deps, 'proposal_id', p.proposal_id);
      const requireStubPatchApplied = optionalBoolean(deps, 'require_stub_patch_applied', p.require_stub_patch_applied);
      const input = {
        proposal_id: proposalId,
        require_stub_patch_applied: requireStubPatchApplied,
        ...reviewContext(deps, p),
      };
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'complete_canonical_target_proposal_binding',
          proposal_id: proposalId,
          require_stub_patch_applied: requireStubPatchApplied ?? false,
        };
      }
      try {
        return await completeCanonicalTargetProposalBinding(ctx.engine, input);
      } catch (error) {
        normalizeCanonicalTargetProposalError(deps, error);
      }
    },
    cliHints: { name: 'complete-canonical-target-proposal-binding', positional: ['proposal_id'] },
  };

  const bind_memory_candidate_target: Operation = {
    name: 'bind_memory_candidate_target',
    description: 'Bind an unresolved candidate through an approved proposal.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Candidate id' },
      target_object_type: {
        type: 'string',
        required: true,
        description: 'Target type',
        enum: ['curated_note'],
        compactEnum: false,
      },
      target_object_id: { type: 'string', required: true, description: 'Target slug' },
      expected_current_target_object_type: {
        type: 'string',
        required: true,
        nullable: true,
        description: 'Expected current type',
        enum: [...EXPECTED_TARGET_OBJECT_TYPE_VALUES],
        compactEnum: false,
      },
      expected_current_target_object_id: {
        type: 'string',
        required: true,
        nullable: true,
        description: 'Expected current id',
      },
      proposal_id: { type: 'string', required: true, description: 'Proposal id' },
      session_id: { type: 'string', required: true, description: 'Session id' },
      realm_id: { type: 'string', required: true, description: 'Realm id' },
      actor: { type: 'string', required: true, description: 'Reviewer' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance refs' },
      reviewed_at: { type: 'string', description: 'Review timestamp' },
      review_reason: { type: 'string', description: 'Review reason' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const candidateId = requireNonEmptyString(deps, 'candidate_id', p.candidate_id);
      const targetObjectType = optionalEnumValue(deps, 'target_object_type', p.target_object_type, ['curated_note'] as const);
      if (targetObjectType !== 'curated_note') {
        throw invalidParams(deps, 'target_object_type must be curated_note');
      }
      const input = {
        candidate_id: candidateId,
        target_object_type: targetObjectType,
        target_object_id: requireNonEmptyString(deps, 'target_object_id', p.target_object_id),
        expected_current_target_object_type: nullableExpectedTargetObjectType(deps, p.expected_current_target_object_type),
        expected_current_target_object_id: nullableExpectedTargetObjectId(deps, p.expected_current_target_object_id),
        proposal_id: requireNonEmptyString(deps, 'proposal_id', p.proposal_id),
        ...reviewContext(deps, p),
      };
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'bind_memory_candidate_target',
          candidate_id: candidateId,
          target_object_type: input.target_object_type,
          target_object_id: input.target_object_id,
          proposal_id: input.proposal_id,
        };
      }
      try {
        return await bindMemoryCandidateTargetGoverned(ctx.engine, input);
      } catch (error) {
        normalizeCanonicalTargetProposalError(deps, error);
      }
    },
    cliHints: { name: 'bind-memory-candidate-target' },
  };

  return [
    create_canonical_target_proposal,
    list_canonical_target_proposals,
    approve_canonical_target_proposal,
    reject_canonical_target_proposal,
    complete_canonical_target_proposal_binding,
    bind_memory_candidate_target,
  ];
}
