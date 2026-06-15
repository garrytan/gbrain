import type { BrainEngine } from '../engine.ts';
import {
  findSlugQualityIssues,
  type SlugQualityRule,
} from '../slug-quality.ts';
import type {
  CanonicalTargetProposalEntry,
  CanonicalTargetProposalEntryInput,
  CanonicalTargetProposalKind,
  CanonicalTargetProposalPageType,
  CanonicalTargetProposalStatus,
  CanonicalTargetProposalStatusEventKind,
  MemoryCandidateEntry,
  MemoryCandidateTargetObjectType,
} from '../types.ts';
import {
  reviewDuplicateMemory,
  type DuplicateMemoryReviewResult,
} from './duplicate-memory-review-service.ts';

type CanonicalTargetProposalServiceErrorCode =
  | 'memory_candidate_not_found'
  | 'invalid_status_transition'
  | 'candidate_not_eligible';

type CanonicalTargetProposalNoProposalReason = 'one_off_task_mechanics';

export class CanonicalTargetProposalServiceError extends Error {
  constructor(
    public code: CanonicalTargetProposalServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalTargetProposalServiceError';
  }
}

export interface CanonicalTargetProposalDraftInput {
  candidate_id: string;
  scope_id?: string;
  proposed_slug?: string;
  proposal_kind?: CanonicalTargetProposalKind;
  proposed_title?: string;
  review_reason?: string;
}

export interface CanonicalTargetProposalCreateInput extends CanonicalTargetProposalDraftInput {
  apply?: boolean;
}

export interface CanonicalTargetProposalDraft {
  status: Extract<CanonicalTargetProposalStatus, 'proposed' | 'blocked'>;
  status_reason: string | null;
  proposal_kind: CanonicalTargetProposalKind;
  target_object_type: 'curated_note';
  proposed_slug: string;
  proposed_title: string;
  proposed_page_type: CanonicalTargetProposalPageType;
  proposed_repo_path: string | null;
  confidence_score: number;
  importance_score: number;
  rationale: string;
  filing_basis: Record<string, unknown>;
  source_refs: string[];
  candidate_snapshot: Record<string, unknown>;
  duplicate_review: DuplicateMemoryReviewResult;
  slug_quality_warnings: string[];
}

export type CanonicalTargetProposalDraftResult =
  | { kind: 'draft'; candidate: MemoryCandidateEntry; draft: CanonicalTargetProposalDraft }
  | { kind: 'no_proposal'; candidate: MemoryCandidateEntry; reason_code: CanonicalTargetProposalNoProposalReason };

export type CanonicalTargetProposalCreateResult =
  | CanonicalTargetProposalDraftResult
  | { kind: 'created'; proposal: CanonicalTargetProposalEntry; superseded_proposal?: CanonicalTargetProposalEntry }
  | { kind: 'refreshed'; proposal: CanonicalTargetProposalEntry };

interface Classification {
  proposal_kind: CanonicalTargetProposalKind;
  proposed_slug: string;
  proposed_title: string;
  proposed_page_type: CanonicalTargetProposalPageType;
  confidence_score: number;
  rationale: string;
  filing_basis: Record<string, unknown>;
}

const ACTIVE_PROPOSAL_STATUSES = new Set<CanonicalTargetProposalStatus>([
  'proposed',
  'approved',
  'patch_staged',
  'blocked',
]);

const TERMINAL_CANDIDATE_STATUSES = new Set(['rejected', 'promoted', 'superseded']);

const ALLOWED_UNRESOLVED_TARGET_TYPES = new Set<MemoryCandidateTargetObjectType | null>([
  null,
  'curated_note',
  'other',
  'procedure',
]);

const HARD_SLUG_QUALITY_RULES = new Set<SlugQualityRule>([
  'vague-slug',
  'numeric-only-slug',
  'global-docs-bucket',
  'placeholder-like-slug',
]);

export async function createCanonicalTargetProposalDraft(
  engine: BrainEngine,
  input: CanonicalTargetProposalDraftInput,
): Promise<CanonicalTargetProposalDraftResult> {
  return buildCanonicalTargetProposalDraft(engine, input);
}

async function buildCanonicalTargetProposalDraft(
  engine: BrainEngine,
  input: CanonicalTargetProposalDraftInput,
): Promise<CanonicalTargetProposalDraftResult> {
  const candidate = await loadEligibleCandidate(engine, input);
  const classification = classifyCandidate(candidate, input);
  if (classification.kind === 'no_proposal') {
    return {
      kind: 'no_proposal',
      candidate,
      reason_code: classification.reason_code,
    };
  }

  const slugQualityWarnings = findSlugQualityIssues(classification.proposed_slug)
    .map((issue) => issue.rule);
  const duplicateReview = await reviewDuplicateMemory(engine, {
    scope_id: candidate.scope_id,
    subject_kind: 'memory_candidate',
    subject_id: candidate.id,
    title: classification.proposed_title,
    content: candidate.proposed_content,
    page_type: classification.proposed_page_type,
    source_refs: candidate.source_refs,
    candidate_type: candidate.candidate_type,
    include_pages: true,
    include_candidates: false,
    limit: 5,
  });

  const blockedReason = selectBlockedReason(
    classification.status_reason,
    slugQualityWarnings,
    duplicateReview,
  );
  const status = blockedReason ? 'blocked' : 'proposed';

  return {
    kind: 'draft',
    candidate,
    draft: {
      status,
      status_reason: blockedReason,
      proposal_kind: classification.proposal_kind,
      target_object_type: 'curated_note',
      proposed_slug: classification.proposed_slug,
      proposed_title: classification.proposed_title,
      proposed_page_type: classification.proposed_page_type,
      proposed_repo_path: null,
      confidence_score: classification.confidence_score,
      importance_score: candidate.importance_score,
      rationale: buildRationale(status, blockedReason, classification.rationale),
      filing_basis: classification.filing_basis,
      source_refs: [...candidate.source_refs],
      candidate_snapshot: snapshotCandidate(candidate),
      duplicate_review: duplicateReview,
      slug_quality_warnings: slugQualityWarnings,
    },
  };
}

export async function createCanonicalTargetProposal(
  engine: BrainEngine,
  input: CanonicalTargetProposalCreateInput,
): Promise<CanonicalTargetProposalCreateResult> {
  const draftResult = await buildCanonicalTargetProposalDraft(engine, input);
  if (draftResult.kind === 'no_proposal' || input.apply !== true) {
    return draftResult;
  }

  const { candidate, draft } = draftResult;
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    const activeProposals = await listActiveProposals(tx, candidate);
    const sameSlugProposal = activeProposals.find((proposal) => (
      proposal.proposed_slug === draft.proposed_slug
    ));

    if (sameSlugProposal) {
      if (sameSlugProposal.status === draft.status) {
        const refreshed = await refreshProposalDraftPayload(tx, sameSlugProposal, draft);
        return { kind: 'refreshed', proposal: refreshed };
      }

      if (sameSlugProposal.status === 'blocked' && draft.status === 'proposed') {
        const created = await createProposalWithStatusEvent(tx, candidate, draft, input.review_reason);
        const superseded = await supersedeProposal(
          tx,
          sameSlugProposal,
          created.id,
          input.review_reason,
        );
        return { kind: 'created', proposal: created, superseded_proposal: superseded };
      }

      if (sameSlugProposal.status !== draft.status && canRefreshStatus(sameSlugProposal.status, draft.status)) {
        const refreshedDraft = await refreshProposalDraftPayload(tx, sameSlugProposal, draft);
        const refreshedWithStatus = await tx.updateCanonicalTargetProposalStatus(refreshedDraft.id, {
          status: draft.status,
          expected_current_status: refreshedDraft.status,
          status_reason: draft.status_reason,
          review_reason: input.review_reason ?? 'Refreshed canonical target proposal draft.',
        });
        if (!refreshedWithStatus) {
          throw new CanonicalTargetProposalServiceError(
            'invalid_status_transition',
            `Cannot refresh canonical target proposal ${sameSlugProposal.id}; status changed before refresh.`,
          );
        }
        await recordProposalStatusEvent(tx, {
          proposal: refreshedWithStatus,
          from_status: refreshedDraft.status,
          event_kind: eventKindForStatus(refreshedWithStatus.status),
          review_reason: input.review_reason ?? 'Refreshed canonical target proposal draft.',
        });
        return { kind: 'refreshed', proposal: refreshedWithStatus };
      }

      return { kind: 'refreshed', proposal: sameSlugProposal };
    }

    const created = await createProposalWithStatusEvent(tx, candidate, draft, input.review_reason);

    const supersededProposal = activeProposals[0];
    if (!supersededProposal) {
      return { kind: 'created', proposal: created };
    }

    const superseded = await supersedeProposal(tx, supersededProposal, created.id, input.review_reason);

    return {
      kind: 'created',
      proposal: created,
      superseded_proposal: superseded,
    };
  });
}

async function loadEligibleCandidate(
  engine: BrainEngine,
  input: CanonicalTargetProposalDraftInput,
): Promise<MemoryCandidateEntry> {
  const candidate = await engine.getMemoryCandidateEntry(input.candidate_id);
  if (!candidate) {
    throw new CanonicalTargetProposalServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.candidate_id}`,
    );
  }
  if (input.scope_id !== undefined && candidate.scope_id !== input.scope_id) {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Memory candidate ${candidate.id} belongs to scope ${candidate.scope_id}, not ${input.scope_id}.`,
    );
  }
  if (TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) {
    throw new CanonicalTargetProposalServiceError(
      'invalid_status_transition',
      `Cannot draft canonical target proposal for terminal candidate ${candidate.id}.`,
    );
  }
  if (candidate.verification_status === 'refuted') {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Cannot draft canonical target proposal for refuted candidate ${candidate.id}.`,
    );
  }
  if (!hasSourceRefs(candidate)) {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Cannot draft canonical target proposal for candidate ${candidate.id} without source refs.`,
    );
  }
  if (candidate.sensitivity === 'personal' || candidate.sensitivity === 'secret' || candidate.sensitivity === 'unknown') {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Cannot draft canonical target proposal for ${candidate.sensitivity} candidate ${candidate.id}.`,
    );
  }
  if (candidate.target_object_id && candidate.target_object_id.trim().length > 0) {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Cannot draft canonical target proposal for already targeted candidate ${candidate.id}.`,
    );
  }
  if (!ALLOWED_UNRESOLVED_TARGET_TYPES.has(candidate.target_object_type)) {
    throw new CanonicalTargetProposalServiceError(
      'candidate_not_eligible',
      `Cannot draft canonical target proposal for target type ${candidate.target_object_type}.`,
    );
  }

  return candidate;
}

function classifyCandidate(
  candidate: MemoryCandidateEntry,
  input: CanonicalTargetProposalDraftInput,
): (
  | ({ kind: 'classified'; status_reason: string | null } & Classification)
  | { kind: 'no_proposal'; reason_code: CanonicalTargetProposalNoProposalReason }
) {
  const content = candidate.proposed_content;
  const normalizedContent = content.toLowerCase();

  if (input.proposed_slug) {
    const proposedSlug = normalizeSlug(input.proposed_slug);
    const inferredProposalKind = inferProposalKindFromSlug(proposedSlug);
    if (input.proposal_kind !== undefined && input.proposal_kind !== inferredProposalKind) {
      throw new CanonicalTargetProposalServiceError(
        'candidate_not_eligible',
        `Proposal kind ${input.proposal_kind} does not match proposed slug namespace ${proposedSlug}.`,
      );
    }
    const proposalKind = input.proposal_kind ?? inferredProposalKind;
    return {
      kind: 'classified',
      status_reason: null,
      proposal_kind: proposalKind,
      proposed_slug: proposedSlug,
      proposed_title: input.proposed_title ?? titleFromSlug(proposedSlug),
      proposed_page_type: pageTypeForProposalKind(proposalKind),
      confidence_score: confidenceFromCandidate(candidate, 0.74),
      rationale: 'A reviewer supplied a proposed canonical slug.',
      filing_basis: { rule: 'override', proposed_slug: proposedSlug },
    };
  }

  if (isLowValueOneOffTaskMechanic(candidate, normalizedContent)) {
    return { kind: 'no_proposal', reason_code: 'one_off_task_mechanics' };
  }

  if (mentionsAll(normalizedContent, ['mbrain', 'proposal'])
    && /project (docs|notes)|project docs|project notes/.test(normalizedContent)) {
    return projectDocClassification(
      'mbrain',
      'canonical-proposal-work',
      input.proposed_title ?? 'Canonical Proposal Work',
      candidate,
      'The candidate describes durable MBrain proposal work that belongs in project documentation.',
      { rule: 'mbrain_project_proposal_work', namespace: 'projects', project: 'mbrain' },
    );
  }

  if (mentionsAll(normalizedContent, ['redis', 'cache', 'invalidation', 'runbook'])) {
    return systemClassification(
      'redis-cache-invalidation-runbook',
      input.proposed_title ?? 'Redis Cache Invalidation Runbook',
      candidate,
      'The candidate describes a reusable system runbook.',
      { rule: 'system_runbook', namespace: 'systems', system: 'redis' },
    );
  }

  if (mentionsAll(normalizedContent, ['deployment', 'rollback', 'runbook', 'mbrain'])) {
    return systemClassification(
      'mbrain-deployment-rollback-runbook',
      input.proposed_title ?? 'MBrain Deployment Rollback Runbook',
      candidate,
      'The candidate describes a page-backed operator runbook.',
      { rule: 'procedure_as_system_runbook', namespace: 'systems', system: 'mbrain' },
    );
  }

  if (mentionsAll(normalizedContent, ['product', 'packaging', 'idea', 'memory', 'assistant'])) {
    return ideaClassification(
      'product-packaging-memory-assistant',
      input.proposed_title ?? 'Product Packaging Memory Assistant',
      candidate,
      'The candidate describes a product or business idea.',
      { rule: 'product_business_idea', namespace: 'ideas' },
    );
  }

  if (mentionsAll(normalizedContent, ['atlas', 'rollout', 'plan'])) {
    return projectDocClassification(
      'atlas-rollout',
      'plan',
      input.proposed_title ?? 'Atlas Rollout Plan',
      candidate,
      'The candidate describes durable Atlas rollout planning knowledge.',
      { rule: 'project_plan', namespace: 'projects', project: 'atlas-rollout' },
    );
  }

  if (normalizedContent.includes('runbook')) {
    const subject = extractRunbookSubject(normalizedContent);
    if (subject) {
      return systemClassification(
        subject,
        input.proposed_title ?? titleFromSlug(`systems/${subject}`),
        candidate,
        'The candidate describes a reusable operational runbook.',
        { rule: 'generic_runbook', namespace: 'systems' },
      );
    }
  }

  return {
    kind: 'classified',
    status_reason: 'unstable_subject_identity',
    proposal_kind: 'concept_page',
    proposed_slug: 'concepts/unstable-subject-identity',
    proposed_title: input.proposed_title ?? 'Unstable Subject Identity',
    proposed_page_type: 'concept',
    confidence_score: confidenceFromCandidate(candidate, 0.35),
    rationale: 'The candidate looks important but does not name a stable canonical subject.',
    filing_basis: { rule: 'unstable_subject_identity', namespace: 'concepts' },
  };
}

function projectDocClassification(
  projectSlug: string,
  topicSlug: string,
  title: string,
  candidate: MemoryCandidateEntry,
  rationale: string,
  filingBasis: Record<string, unknown>,
): { kind: 'classified'; status_reason: null } & Classification {
  return {
    kind: 'classified',
    status_reason: null,
    proposal_kind: 'project_doc',
    proposed_slug: `projects/${projectSlug}/docs/${topicSlug}`,
    proposed_title: title,
    proposed_page_type: 'project',
    confidence_score: confidenceFromCandidate(candidate, 0.82),
    rationale,
    filing_basis: filingBasis,
  };
}

function systemClassification(
  systemSlug: string,
  title: string,
  candidate: MemoryCandidateEntry,
  rationale: string,
  filingBasis: Record<string, unknown>,
): { kind: 'classified'; status_reason: null } & Classification {
  return {
    kind: 'classified',
    status_reason: null,
    proposal_kind: 'system_page',
    proposed_slug: `systems/${systemSlug}`,
    proposed_title: title,
    proposed_page_type: 'system',
    confidence_score: confidenceFromCandidate(candidate, 0.8),
    rationale,
    filing_basis: filingBasis,
  };
}

function ideaClassification(
  ideaSlug: string,
  title: string,
  candidate: MemoryCandidateEntry,
  rationale: string,
  filingBasis: Record<string, unknown>,
): { kind: 'classified'; status_reason: null } & Classification {
  return {
    kind: 'classified',
    status_reason: null,
    proposal_kind: 'idea_page',
    proposed_slug: `ideas/${ideaSlug}`,
    proposed_title: title,
    proposed_page_type: 'concept',
    confidence_score: confidenceFromCandidate(candidate, 0.78),
    rationale,
    filing_basis: filingBasis,
  };
}

function selectBlockedReason(
  classificationReason: string | null,
  slugQualityWarnings: string[],
  duplicateReview: DuplicateMemoryReviewResult,
): string | null {
  if (classificationReason) return classificationReason;
  if (slugQualityWarnings.some((rule) => HARD_SLUG_QUALITY_RULES.has(rule as SlugQualityRule))) {
    return 'slug_quality_hard_error';
  }
  if (duplicateReview.decision === 'likely_duplicate') return 'likely_duplicate';
  return null;
}

function buildRationale(
  status: CanonicalTargetProposalDraft['status'],
  blockedReason: string | null,
  baseRationale: string,
): string {
  if (status !== 'blocked') return baseRationale;
  return blockedReason
    ? `${baseRationale} Blocked reason: ${blockedReason}.`
    : baseRationale;
}

async function listActiveProposals(
  engine: BrainEngine,
  candidate: MemoryCandidateEntry,
): Promise<CanonicalTargetProposalEntry[]> {
  const proposals = await engine.listCanonicalTargetProposalEntries({
    scope_id: candidate.scope_id,
    source_candidate_id: candidate.id,
    limit: 100,
  });
  return proposals.filter((proposal) => ACTIVE_PROPOSAL_STATUSES.has(proposal.status));
}

function toProposalEntryInput(
  candidate: MemoryCandidateEntry,
  draft: CanonicalTargetProposalDraft,
): CanonicalTargetProposalEntryInput {
  return {
    id: crypto.randomUUID(),
    scope_id: candidate.scope_id,
    source_candidate_id: candidate.id,
    linked_candidate_ids: [candidate.id],
    status: draft.status,
    status_reason: draft.status_reason,
    proposal_kind: draft.proposal_kind,
    target_object_type: draft.target_object_type,
    proposed_slug: draft.proposed_slug,
    proposed_title: draft.proposed_title,
    proposed_page_type: draft.proposed_page_type,
    proposed_repo_path: draft.proposed_repo_path,
    confidence_score: draft.confidence_score,
    importance_score: draft.importance_score,
    rationale: draft.rationale,
    filing_basis: draft.filing_basis,
    source_refs: draft.source_refs,
    candidate_snapshot: draft.candidate_snapshot,
    duplicate_review: draft.duplicate_review as unknown as Record<string, unknown>,
    slug_quality_warnings: draft.slug_quality_warnings,
  };
}

async function createProposalWithStatusEvent(
  engine: BrainEngine,
  candidate: MemoryCandidateEntry,
  draft: CanonicalTargetProposalDraft,
  reviewReason: string | undefined,
): Promise<CanonicalTargetProposalEntry> {
  const created = await engine.createCanonicalTargetProposalEntry(toProposalEntryInput(candidate, draft));
  await recordProposalStatusEvent(engine, {
    proposal: created,
    from_status: null,
    event_kind: eventKindForStatus(created.status),
    review_reason: reviewReason ?? created.rationale,
  });
  return created;
}

async function refreshProposalDraftPayload(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  draft: CanonicalTargetProposalDraft,
): Promise<CanonicalTargetProposalEntry> {
  const refreshed = await engine.updateCanonicalTargetProposalDraft(proposal.id, {
    expected_current_status: proposal.status,
    status_reason: draft.status_reason,
    proposal_kind: draft.proposal_kind,
    proposed_title: draft.proposed_title,
    proposed_page_type: draft.proposed_page_type,
    proposed_repo_path: draft.proposed_repo_path,
    confidence_score: draft.confidence_score,
    importance_score: draft.importance_score,
    rationale: draft.rationale,
    filing_basis: draft.filing_basis,
    source_refs: draft.source_refs,
    candidate_snapshot: draft.candidate_snapshot,
    duplicate_review: draft.duplicate_review as unknown as Record<string, unknown>,
    slug_quality_warnings: draft.slug_quality_warnings,
  });
  if (!refreshed) {
    throw new CanonicalTargetProposalServiceError(
      'invalid_status_transition',
      `Cannot refresh canonical target proposal ${proposal.id}; status changed before refresh.`,
    );
  }
  return refreshed;
}

async function supersedeProposal(
  engine: BrainEngine,
  proposal: CanonicalTargetProposalEntry,
  replacementId: string,
  reviewReason: string | undefined,
): Promise<CanonicalTargetProposalEntry> {
  const superseded = await engine.updateCanonicalTargetProposalStatus(proposal.id, {
    status: 'superseded',
    expected_current_status: proposal.status,
    status_reason: 'replaced_by_new_proposed_slug',
    superseded_by: replacementId,
    review_reason: reviewReason ?? `Superseded by canonical target proposal ${replacementId}.`,
  });
  if (!superseded) {
    throw new CanonicalTargetProposalServiceError(
      'invalid_status_transition',
      `Cannot supersede canonical target proposal ${proposal.id}; status changed before supersession.`,
    );
  }
  await recordProposalStatusEvent(engine, {
    proposal: superseded,
    from_status: proposal.status,
    event_kind: 'superseded',
    review_reason: reviewReason ?? `Superseded by canonical target proposal ${replacementId}.`,
  });
  return superseded;
}

async function recordProposalStatusEvent(
  engine: BrainEngine,
  input: {
    proposal: CanonicalTargetProposalEntry;
    from_status: CanonicalTargetProposalStatus | null;
    event_kind: CanonicalTargetProposalStatusEventKind;
    review_reason: string;
  },
): Promise<void> {
  await engine.createCanonicalTargetProposalStatusEvent({
    id: crypto.randomUUID(),
    proposal_id: input.proposal.id,
    scope_id: input.proposal.scope_id,
    from_status: input.from_status,
    to_status: input.proposal.status,
    event_kind: input.event_kind,
    actor: null,
    review_reason: input.review_reason,
  });
}

function eventKindForStatus(status: CanonicalTargetProposalStatus): CanonicalTargetProposalStatusEventKind {
  if (status === 'blocked') return 'blocked';
  if (status === 'superseded') return 'superseded';
  if (status === 'approved') return 'approved';
  if (status === 'patch_staged') return 'patch_staged';
  if (status === 'bound') return 'bound';
  if (status === 'rejected') return 'rejected';
  return 'created';
}

function canRefreshStatus(
  fromStatus: CanonicalTargetProposalStatus,
  toStatus: CanonicalTargetProposalStatus,
): boolean {
  return fromStatus === 'proposed' && toStatus === 'blocked';
}

function hasSourceRefs(candidate: MemoryCandidateEntry): boolean {
  return candidate.source_refs.some((sourceRef) => sourceRef.trim().length > 0);
}

function snapshotCandidate(candidate: MemoryCandidateEntry): Record<string, unknown> {
  return {
    id: candidate.id,
    scope_id: candidate.scope_id,
    candidate_type: candidate.candidate_type,
    proposed_content: candidate.proposed_content,
    generated_by: candidate.generated_by,
    extraction_kind: candidate.extraction_kind,
    confidence_score: candidate.confidence_score,
    importance_score: candidate.importance_score,
    recurrence_score: candidate.recurrence_score,
    sensitivity: candidate.sensitivity,
    status: candidate.status,
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    verification_status: candidate.verification_status,
    source_refs: [...candidate.source_refs],
    created_at: candidate.created_at.toISOString(),
    updated_at: candidate.updated_at.toISOString(),
  };
}

function isLowValueOneOffTaskMechanic(candidate: MemoryCandidateEntry, normalizedContent: string): boolean {
  const taskMechanicSignals = [
    'bun test',
    'checked the current branch',
    'branch status',
    'ran ',
    'current branch',
  ];
  return candidate.importance_score < 0.5
    && candidate.recurrence_score < 0.2
    && taskMechanicSignals.some((signal) => normalizedContent.includes(signal));
}

function mentionsAll(value: string, terms: string[]): boolean {
  return terms.every((term) => value.includes(term));
}

function extractRunbookSubject(normalizedContent: string): string | null {
  const runbookIndex = normalizedContent.indexOf('runbook');
  if (runbookIndex < 0) return null;
  const prefix = normalizedContent.slice(0, runbookIndex + 'runbook'.length);
  const words = prefix
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !GENERIC_RUNBOOK_WORDS.has(word));
  const selected = words.slice(-5);
  if (selected.length < 2) return null;
  return slugify(selected.join(' '));
}

function inferProposalKindFromSlug(slug: string): CanonicalTargetProposalKind {
  if (slug.startsWith('projects/') && slug.includes('/docs/')) return 'project_doc';
  if (slug.startsWith('projects/')) return 'project_root';
  if (slug.startsWith('systems/')) return 'system_page';
  if (slug.startsWith('ideas/')) return 'idea_page';
  if (slug.startsWith('originals/')) return 'original_page';
  return 'concept_page';
}

function pageTypeForProposalKind(kind: CanonicalTargetProposalKind): CanonicalTargetProposalPageType {
  if (kind === 'project_doc' || kind === 'project_root') return 'project';
  if (kind === 'system_page') return 'system';
  return 'concept';
}

function confidenceFromCandidate(candidate: MemoryCandidateEntry, baseline: number): number {
  return Number(Math.min(0.98, Math.max(0.2, (candidate.confidence_score + baseline) / 2)).toFixed(2));
}

function normalizeSlug(slug: string): string {
  return slug
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\.mdx?$/i, '')
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .map(slugify)
    .join('/');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function titleFromSlug(slug: string): string {
  const leaf = slug.split('/').filter(Boolean).at(-1) ?? slug;
  return leaf
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const GENERIC_RUNBOOK_WORDS = new Set([
  'for',
  'the',
  'and',
  'belongs',
  'system',
  'memory',
  'operators',
  'operator',
  'workflow',
  'should',
  'retained',
]);
