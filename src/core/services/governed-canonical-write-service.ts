import type { MemoryMutationResult } from '../types.ts';
import {
  buildCandidateFallback,
  buildQuarantine,
} from '../canonical-write/candidate-fallback.ts';
import {
  buildMutationPlan,
  type CanonicalMutationPlan,
} from '../canonical-write/mutation-planner.ts';
import {
  buildProjectionMutation,
  type ProjectionMutationInput,
  type ProjectionTarget,
} from '../canonical-write/projection-writer.ts';
import {
  decideCanonicalWritePolicy,
  explainCanonicalWritePolicy,
  type CanonicalWritePolicyInput,
  type CanonicalWritePolicyResult,
} from '../canonical-write/write-policy.ts';
import type {
  CanonicalWriteAuditInput,
  CanonicalWriteAuditStatus,
  CanonicalProjectionAuditStatus,
} from '../assertions/canonical-write-audit-store.ts';

export {
  explainCanonicalWritePolicy,
  type ProjectionMutationInput,
};

export type GovernedCanonicalWriteInput = CanonicalWritePolicyInput & {
  evidence: {
    id: string;
    source_id: string;
    source_item_id: string;
    source_chunk_id: string;
  };
  actor: {
    actor: string;
    session_id: string;
    job_id: string;
    runner_id: string;
  };
};

export interface ProjectionSnapshot {
  projection_id: string;
  markdown_hash: string;
}

export interface ProjectionWriteResult {
  projection_id: string;
  markdown_hash: string;
}

export interface DbMutationResult {
  before_db_hash: string;
  after_db_hash: string;
  assertions: Array<{ id: string; target_slug: string }>;
  assertion_evidence: Array<{ id: string; assertion_id: string; extracted_claim_id: string }>;
}

export interface GovernedCanonicalWriteServiceOptions {
  now: () => string;
  decidePolicy?: (input: GovernedCanonicalWriteInput) => Promise<CanonicalWritePolicyResult>;
  applyDbMutation: (input: GovernedCanonicalWriteInput) => Promise<DbMutationResult>;
  getProjectionSnapshot: (target: ProjectionTarget) => Promise<ProjectionSnapshot>;
  writeProjection: (mutation: ProjectionMutationInput) => Promise<ProjectionWriteResult>;
  markPendingReconcile: (input: {
    assertion_ids: string[];
    projection_ids: string[];
    projection_kind: ProjectionTarget['kind'];
    projection_slug: string;
    status: 'pending_reconcile';
    reason: 'failed_markdown' | 'failed_ledger';
    error: string;
  }) => Promise<void>;
  recordMutationLedger: (event: Record<string, unknown>) => Promise<void>;
  recordCanonicalAuditLedger?: (event: CanonicalWriteAuditInput) => Promise<void>;
}

export interface GovernedCanonicalWriteService {
  planCanonicalWrite(input: GovernedCanonicalWriteInput): Promise<GovernedCanonicalWritePlanResult>;
  applyCanonicalWrite(input: GovernedCanonicalWriteInput): Promise<GovernedCanonicalWriteApplyResult>;
}

export interface GovernedCanonicalWritePlanResult {
  policy: CanonicalWritePolicyResult;
  mutation_plan: CanonicalMutationPlan;
  candidate?: ReturnType<typeof buildCandidateFallback>;
  quarantine?: ReturnType<typeof buildQuarantine>;
  verification_request?: Record<string, unknown>;
  conflict_set?: Record<string, unknown>;
  ledger_preview?: Record<string, unknown>;
}

export interface GovernedCanonicalWriteApplyResult extends GovernedCanonicalWritePlanResult {
  status: 'not_applied' | 'applied' | 'pending_reconcile' | 'failed_db';
  projection_status: 'not_attempted' | 'applied' | 'failed_markdown';
  assertion_ids: string[];
  assertion_evidence_ids: string[];
  extracted_claim_ids: string[];
  error?: { code: 'failed_db' | 'failed_markdown' | 'failed_ledger'; message: string };
}

export function createGovernedCanonicalWriteService(
  options: GovernedCanonicalWriteServiceOptions,
): GovernedCanonicalWriteService {
  return {
    async planCanonicalWrite(input) {
      const policy = await policyFor(options, input);
      const mutationPlan = buildMutationPlan(input, policy);
      const base = { policy, mutation_plan: mutationPlan };
      if (policy.decision === 'candidate') {
        return { ...base, candidate: buildCandidateFallback(input) };
      }
      if (policy.decision === 'verify_first') {
        return { ...base, verification_request: verificationRequest(input) };
      }
      if (policy.decision === 'quarantine') {
        return { ...base, quarantine: buildQuarantine(input) };
      }
      if (policy.decision === 'conflict') {
        const conflict_set = conflictSet(input);
        return {
          ...base,
          conflict_set,
          ledger_preview: {
            result: 'conflict',
            metadata: {
              policy_decision: 'conflict',
              conflict_set_id: conflict_set.id,
            },
          },
        };
      }
      return base;
    },
    async applyCanonicalWrite(input) {
      const plan = await this.planCanonicalWrite(input);
      if (plan.policy.decision !== 'auto_canonical') {
        return {
          ...plan,
          status: 'not_applied',
          projection_status: 'not_attempted',
          assertion_ids: [],
          assertion_evidence_ids: [],
          extracted_claim_ids: [input.claim.id],
        };
      }

      let dbResult: DbMutationResult;
      try {
        dbResult = await options.applyDbMutation(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.recordMutationLedger(failedDbLedgerEvent(input, plan.policy, message));
        await recordCanonicalAuditLedger(options, canonicalAuditInput({
          input,
          now: options.now(),
          policy: plan.policy,
          status: 'failed_db',
          projection_status: 'not_attempted',
          assertionIds: [],
          assertionEvidenceIds: [],
          extractedClaimIds: [input.claim.id],
          before_db_hash: null,
          after_db_hash: null,
          error_code: 'failed_db',
          error_message: message,
        }));
        return {
          ...plan,
          status: 'failed_db',
          projection_status: 'not_attempted',
          assertion_ids: [],
          assertion_evidence_ids: [],
          extracted_claim_ids: [input.claim.id],
          error: { code: 'failed_db', message },
        };
      }
      const assertionIds = dbResult.assertions.map((assertion) => assertion.id);
      const assertionEvidenceIds = dbResult.assertion_evidence.map((evidence) => evidence.id);
      const extractedClaimIds = dbResult.assertion_evidence.map((evidence) => evidence.extracted_claim_id);
      const projectionMutation = buildProjectionMutation({
        claim: input.claim,
        assertion_ids: assertionIds,
        assertion_evidence_ids: assertionEvidenceIds,
        extracted_claim_ids: extractedClaimIds,
        source_refs: input.source_refs,
      });
      let beforeProjection: ProjectionSnapshot;
      try {
        beforeProjection = await options.getProjectionSnapshot(projectionMutation.projection_target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.markPendingReconcile({
          assertion_ids: assertionIds,
          projection_ids: [],
          projection_kind: projectionMutation.projection_target.kind,
          projection_slug: projectionMutation.projection_target.slug,
          status: 'pending_reconcile',
          reason: 'failed_markdown',
          error: message,
        });
        const metadata = projectionFailureMetadata({
          input,
          policy: plan.policy,
          dbResult,
          assertionIds,
          assertionEvidenceIds,
          extractedClaimIds,
          error_code: 'failed_markdown',
          error_message: message,
        });
        await recordLedgerBestEffort(options, ledgerEvent(input, dbResult, 'failed', metadata, projectionMutation.projection_target.slug), canonicalAuditInput({
          input,
          now: options.now(),
          policy: plan.policy,
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          assertionIds,
          assertionEvidenceIds,
          extractedClaimIds,
          before_db_hash: dbResult.before_db_hash,
          after_db_hash: dbResult.after_db_hash,
          target: {
            projection_target: projectionMutation.projection_target,
            mutation_kind: projectionMutation.mutation_kind,
            projection_id: undefined,
            before_markdown_hash: null,
            after_markdown_hash: null,
          },
          error_code: 'failed_markdown',
          error_message: message,
        }));
        return {
          ...plan,
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          assertion_ids: assertionIds,
          assertion_evidence_ids: assertionEvidenceIds,
          extracted_claim_ids: extractedClaimIds,
          error: { code: 'failed_markdown', message },
        };
      }

      let afterProjection: ProjectionWriteResult;
      try {
        afterProjection = await options.writeProjection(projectionMutation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.markPendingReconcile({
          assertion_ids: assertionIds,
          projection_ids: [beforeProjection.projection_id],
          projection_kind: projectionMutation.projection_target.kind,
          projection_slug: projectionMutation.projection_target.slug,
          status: 'pending_reconcile',
          reason: 'failed_markdown',
          error: message,
        });
        const metadata = ledgerMetadata({
          input,
          policy: plan.policy,
          dbResult,
          beforeProjection,
          after_markdown_hash: null,
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          projection_ids: [beforeProjection.projection_id],
          assertionIds,
          assertionEvidenceIds,
          extractedClaimIds,
          error_code: 'failed_markdown',
          error_message: message,
        });
        await recordLedgerBestEffort(options, ledgerEvent(input, dbResult, 'failed', metadata, projectionMutation.projection_target.slug), canonicalAuditInput({
          input,
          now: options.now(),
          policy: plan.policy,
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          assertionIds,
          assertionEvidenceIds,
          extractedClaimIds,
          before_db_hash: dbResult.before_db_hash,
          after_db_hash: dbResult.after_db_hash,
          target: {
            projection_target: projectionMutation.projection_target,
            mutation_kind: projectionMutation.mutation_kind,
            projection_id: beforeProjection.projection_id,
            before_markdown_hash: beforeProjection.markdown_hash,
            after_markdown_hash: null,
          },
          error_code: 'failed_markdown',
          error_message: message,
        }));
        return {
          ...plan,
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          assertion_ids: assertionIds,
          assertion_evidence_ids: assertionEvidenceIds,
          extracted_claim_ids: extractedClaimIds,
          error: { code: 'failed_markdown', message },
        };
      }

      const metadata = ledgerMetadata({
        input,
        policy: plan.policy,
        dbResult,
        beforeProjection,
        after_markdown_hash: afterProjection.markdown_hash,
        status: 'applied',
        projection_status: 'applied',
        projection_ids: [afterProjection.projection_id],
        assertionIds,
        assertionEvidenceIds,
        extractedClaimIds,
      });
      const appliedAuditEvent = canonicalAuditInput({
        input,
        now: options.now(),
        policy: plan.policy,
        status: 'applied',
        projection_status: 'applied',
        assertionIds,
        assertionEvidenceIds,
        extractedClaimIds,
        before_db_hash: dbResult.before_db_hash,
        after_db_hash: dbResult.after_db_hash,
        target: {
          projection_target: projectionMutation.projection_target,
          mutation_kind: projectionMutation.mutation_kind,
          projection_id: afterProjection.projection_id,
          before_markdown_hash: beforeProjection.markdown_hash,
          after_markdown_hash: afterProjection.markdown_hash,
        },
      });
      let mutationLedgerRecorded = false;
      try {
        await options.recordMutationLedger(ledgerEvent(input, dbResult, 'applied', metadata, projectionMutation.projection_target.slug));
        mutationLedgerRecorded = true;
        await recordCanonicalAuditLedger(options, appliedAuditEvent);
        return {
          ...plan,
          status: 'applied',
          projection_status: 'applied',
          assertion_ids: assertionIds,
          assertion_evidence_ids: assertionEvidenceIds,
          extracted_claim_ids: extractedClaimIds,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!mutationLedgerRecorded) {
          await recordCanonicalAuditLedgerBestEffort(options, {
            ...appliedAuditEvent,
            status: 'pending_reconcile',
            error: {
              code: 'failed_ledger',
              message,
            },
          });
        }
        await options.markPendingReconcile({
          assertion_ids: assertionIds,
          projection_ids: [afterProjection.projection_id],
          projection_kind: projectionMutation.projection_target.kind,
          projection_slug: projectionMutation.projection_target.slug,
          status: 'pending_reconcile',
          reason: 'failed_ledger',
          error: message,
        });
        return {
          ...plan,
          status: 'pending_reconcile',
          projection_status: 'applied',
          assertion_ids: assertionIds,
          assertion_evidence_ids: assertionEvidenceIds,
          extracted_claim_ids: extractedClaimIds,
          error: { code: 'failed_ledger', message },
        };
      }
    },
  };
}

async function policyFor(
  options: GovernedCanonicalWriteServiceOptions,
  input: GovernedCanonicalWriteInput,
): Promise<CanonicalWritePolicyResult> {
  const evaluatedInput = { ...input, evaluated_at: options.now(), session_id: input.actor.session_id };
  if (options.decidePolicy) return options.decidePolicy(evaluatedInput);
  return decideCanonicalWritePolicy(evaluatedInput);
}

function ledgerEvent(
  input: GovernedCanonicalWriteInput,
  dbResult: DbMutationResult,
  result: MemoryMutationResult,
  metadata: Record<string, unknown>,
  projectionSlug: string,
): Record<string, unknown> {
  return {
    operation: 'governed_canonical_write',
    session_id: input.actor.session_id,
    realm_id: input.realm,
    actor: input.actor.actor,
    target_kind: 'page',
    target_id: projectionSlug,
    scope_id: input.realm,
    source_refs: input.source_refs,
    result,
    expected_target_snapshot_hash: dbResult.before_db_hash,
    current_target_snapshot_hash: dbResult.after_db_hash,
    metadata,
  };
}

function failedDbLedgerEvent(
  input: GovernedCanonicalWriteInput,
  policy: CanonicalWritePolicyResult,
  message: string,
): Record<string, unknown> {
  return {
    operation: 'governed_canonical_write',
    session_id: input.actor.session_id,
    realm_id: input.realm,
    actor: input.actor.actor,
    target_kind: 'page',
    target_id: input.claim.target_slug,
    scope_id: input.realm,
    source_refs: input.source_refs,
    result: 'failed',
    expected_target_snapshot_hash: null,
    current_target_snapshot_hash: null,
    metadata: {
      status: 'failed_db',
      projection_status: 'not_attempted',
      assertion_ids: [],
      assertion_evidence_ids: [],
      extracted_claim_ids: [input.claim.id],
      projection_ids: [],
      target_projection_ids: [],
      policy_decision: policy.decision,
      policy_explanation: policy.explanation,
      before_db_hash: null,
      after_db_hash: null,
      before_markdown_hash: null,
      after_markdown_hash: null,
      source_refs: input.source_refs,
      actor: input.actor.actor,
      session_id: input.actor.session_id,
      job_id: input.actor.job_id,
      runner_id: input.actor.runner_id,
      error_code: 'failed_db',
      error_message: message,
    },
  };
}

async function recordLedgerBestEffort(
  options: GovernedCanonicalWriteServiceOptions,
  event: Record<string, unknown>,
  auditEvent?: CanonicalWriteAuditInput,
): Promise<void> {
  try {
    await options.recordMutationLedger(event);
  } catch {
    // Reconcile state has already been recorded for this failure path; keep the structured write result.
  }
  await recordCanonicalAuditLedgerBestEffort(options, auditEvent);
}

async function recordCanonicalAuditLedger(
  options: GovernedCanonicalWriteServiceOptions,
  event: CanonicalWriteAuditInput | undefined,
): Promise<void> {
  if (!event || !options.recordCanonicalAuditLedger) return;
  await options.recordCanonicalAuditLedger(event);
}

async function recordCanonicalAuditLedgerBestEffort(
  options: GovernedCanonicalWriteServiceOptions,
  event: CanonicalWriteAuditInput | undefined,
): Promise<void> {
  try {
    await recordCanonicalAuditLedger(options, event);
  } catch {
    // The caller already has a structured write/reconcile result; keep that result stable.
  }
}

function canonicalAuditInput(input: {
  input: GovernedCanonicalWriteInput;
  now: string;
  policy: CanonicalWritePolicyResult;
  status: CanonicalWriteAuditStatus;
  projection_status: CanonicalProjectionAuditStatus;
  assertionIds: string[];
  assertionEvidenceIds: string[];
  extractedClaimIds: string[];
  before_db_hash: string | null;
  after_db_hash: string | null;
  target?: {
    projection_target: ProjectionTarget;
    mutation_kind: string;
    projection_id: string | undefined;
    before_markdown_hash: string | null;
    after_markdown_hash: string | null;
  };
  error_code?: string;
  error_message?: string;
}): CanonicalWriteAuditInput {
  return {
    now: input.now,
    policy_decision: input.policy.decision,
    policy_explanation: input.policy.explanation,
    status: input.status,
    projection_status: input.projection_status,
    assertion_ids: input.assertionIds,
    assertion_evidence_ids: input.assertionEvidenceIds,
    extracted_claim_ids: input.extractedClaimIds,
    source_refs: input.input.source_refs,
    before_db_hash: input.before_db_hash,
    after_db_hash: input.after_db_hash,
    actor: input.input.actor,
    ...(input.target ? {
      target_projection: {
        id: input.target.projection_id,
        kind: input.target.projection_target.kind,
        slug: input.target.projection_target.slug,
        mutation_kind: input.target.mutation_kind,
        before_markdown_hash: input.target.before_markdown_hash,
        after_markdown_hash: input.target.after_markdown_hash,
      },
    } : {}),
    ...(input.error_code && input.error_message ? {
      error: {
        code: input.error_code,
        message: input.error_message,
      },
    } : {}),
    metadata_json: {
      policy_explanation: input.policy.explanation,
      realm: input.input.realm,
      target_slug: input.input.claim.target_slug,
    },
  };
}

function projectionFailureMetadata(input: {
  input: GovernedCanonicalWriteInput;
  policy: CanonicalWritePolicyResult;
  dbResult: DbMutationResult;
  assertionIds: string[];
  assertionEvidenceIds: string[];
  extractedClaimIds: string[];
  error_code: string;
  error_message: string;
}): Record<string, unknown> {
  return {
    status: 'pending_reconcile',
    projection_status: 'failed_markdown',
    assertion_ids: input.assertionIds,
    assertion_evidence_ids: input.assertionEvidenceIds,
    extracted_claim_ids: input.extractedClaimIds,
    projection_ids: [],
    target_projection_ids: [],
    policy_decision: input.policy.decision,
    policy_explanation: input.policy.explanation,
    before_db_hash: input.dbResult.before_db_hash,
    after_db_hash: input.dbResult.after_db_hash,
    before_markdown_hash: null,
    after_markdown_hash: null,
    source_refs: input.input.source_refs,
    actor: input.input.actor.actor,
    session_id: input.input.actor.session_id,
    job_id: input.input.actor.job_id,
    runner_id: input.input.actor.runner_id,
    error_code: input.error_code,
    error_message: input.error_message,
  };
}

function ledgerMetadata(input: {
  input: GovernedCanonicalWriteInput;
  policy: CanonicalWritePolicyResult;
  dbResult: DbMutationResult;
  beforeProjection: ProjectionSnapshot;
  after_markdown_hash: string | null;
  status: string;
  projection_status: string;
  projection_ids: string[];
  assertionIds: string[];
  assertionEvidenceIds: string[];
  extractedClaimIds: string[];
  error_code?: string;
  error_message?: string;
}): Record<string, unknown> {
  return {
    status: input.status,
    projection_status: input.projection_status,
    assertion_ids: input.assertionIds,
    assertion_evidence_ids: input.assertionEvidenceIds,
    extracted_claim_ids: input.extractedClaimIds,
    projection_ids: input.projection_ids,
    target_projection_ids: input.projection_ids,
    policy_decision: input.policy.decision,
    policy_explanation: input.policy.explanation,
    before_db_hash: input.dbResult.before_db_hash,
    after_db_hash: input.dbResult.after_db_hash,
    before_markdown_hash: input.beforeProjection.markdown_hash,
    after_markdown_hash: input.after_markdown_hash,
    source_refs: input.input.source_refs,
    actor: input.input.actor.actor,
    session_id: input.input.actor.session_id,
    job_id: input.input.actor.job_id,
    runner_id: input.input.actor.runner_id,
    ...(input.error_code ? { error_code: input.error_code } : {}),
    ...(input.error_message ? { error_message: input.error_message } : {}),
  };
}

function verificationRequest(input: GovernedCanonicalWriteInput): Record<string, unknown> {
  return {
    required: true,
    reason: 'code_claim_requires_live_verification',
    source_kind: input.claim.source_kind,
    claim_type: input.claim.claim_type,
    target_slug: input.claim.target_slug,
    property: input.claim.property,
  };
}

function conflictSet(input: GovernedCanonicalWriteInput): Record<string, unknown> {
  return {
    id: `conflict-set:${input.claim.target_type}:${input.claim.target_slug}:${input.claim.property}`,
    status: 'open',
    target_slug: input.claim.target_slug,
    property: input.claim.property,
    assertion_ids: [
      ...existingAssertionIds(input.conflict_state),
      input.claim.id.replace('extracted-claim', 'assertion'),
    ],
    source_refs: input.source_refs,
  };
}

function existingAssertionIds(conflictState: GovernedCanonicalWriteInput['conflict_state']): string[] {
  const value = conflictState.existing_assertion_ids;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
